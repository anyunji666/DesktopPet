const { app, BrowserWindow, ipcMain, dialog, powerMonitor, screen } = require('electron');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFile } = require('child_process');

// 进程真正起跑的时间点，尽量贴近文件顶部，用来算"程序启动用时"（跟开机、登录、
// 隔了多久才手动打开都没关系，纯粹是这个 Electron 进程自己跑起来花了多久）
const APP_PROCESS_START_MS = Date.now();

const ROOT = __dirname;

const { startServer } = require('./main-modules/server');
const { state } = require('./main-modules/state');
const { loadConfig, updateConfig } = require('./main-modules/config');
const { scanCharacters } = require('./main-modules/character');
const { scanScenes, setAdjust, normAdjust } = require('./main-modules/scene');
const {
  readPersonaFile,
  savePersonaFile,
  loadChatHistory,
  saveChatHistory,
  saveChatImage,
  readChatImageDataURL,
  deleteChatImage,
  clearChatImages,
  loadDaySummary,
  saveDaySummary,
  clearDaySummaries,
  appendMemoryLines,
  clearMemoryIndex,
  clearOpenedDay,
} = require('./main-modules/chat-store');
const { getTtsConfig, saveTtsConfig, getPresets, speakReply, testVoice } = require('./main-modules/tts');
const { getAsrConfig, saveAsrConfig } = require('./main-modules/asr/config');
const { createAsrSession } = require('./main-modules/asr/doubao');
const { splitTone } = require('./main-modules/tts/tone');
const { importCloneAudio, AUDIO_EXTENSIONS } = require('./main-modules/tts/clone-store');
const doubaoVoicesStore = require('./main-modules/tts/doubao-voices-store');
const {
  getApiConfig,
  saveApiConfig,
  getPromptConfig,
  savePromptConfig,
  buildPromptText,
  callLLM,
  fetchModelList,
  dayKeyOf,
  computeLastPastDayKey,
  flattenDayLines,
  buildSummaryPrompt,
  parseSummaryAndMemory,
  setLlmLogListener,
  getLatestLlmCall,
} = require('./main-modules/llm');
const {
  WIN_W,
  WIN_H,
  WIN_MIN_W,
  WIN_MAX_W,
  openSettingsWindow,
  openHistoryWindow,
  send,
  currentCharacterPayload,
  currentScene,
  buildMenu,
} = require('./main-modules/window');

// ---------- 单实例锁：防止重复启动多个宠物互相抢资源（重复启动会明显变卡） ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (state.win && !state.win.isDestroyed()) {
      state.win.show();
      state.win.focus();
    }
  });
}

// ---------- 启动计时气泡 ----------
// 不管是不是开机自启动触发的，每次模型出现都报一次用时；但同一场开机内只在"第一次启动"
// 报完整的「开机用时 + 程序启动用时」，之后同一场开机里再打开（手动关了又重开等）只报
// 真实的「程序启动用时」，不再重复报开机用时（开机用时跟这是第几次打开程序无关）。
let bootTimerReported = false; // 防止 model-ready 被重复触发时重复计算 / 重复弹气泡

// 同一场开机内多次启动，各自算出来的"开机时间点"理论上只差几秒（时钟精度/计算时机导致的误差），
// 超过这个容差就认为是不同的一场开机（比如重启过、休眠又开机）
const SAME_BOOT_TOLERANCE_MS = 15000;

function formatBootDuration(seconds) {
  if (seconds < 60) return `${seconds.toFixed(1)}秒`;
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}分${s.toFixed(1)}秒`;
}

// 查当前这次交互登录（本地账号 / 微软账号，含指纹或 PIN 登录）的登录时间点，返回毫秒时间戳；查不到返回 null。
// 用 PowerShell 走 CIM（Win32_LogonSession）而不是解析 `query user` 的文字输出——后者的表头和日期格式
// 会跟着系统语言/区域走，中文/英文/其它语言下格式都不一样，解析很容易出错；CIM 的 StartTime 转成
// DateTimeOffset 再转 Unix 毫秒，是纯数字，不受语言/区域影响。
// LogonType：2=交互登录（本机键盘密码/PIN/指纹），10/12=远程交互（RDP），11=缓存的域凭据交互登录——
// 覆盖常见的本地开机登录场景；同一用户可能有多条记录，取时间最新的一条。
function getInteractiveLogonTimeMs() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    const script =
      '$s = Get-CimInstance Win32_LogonSession | ' +
      'Where-Object { $_.LogonType -in 2,10,11,12 } | ' +
      'Sort-Object StartTime -Descending | Select-Object -First 1; ' +
      'if ($s -and $s.StartTime) { [DateTimeOffset]$s.StartTime | ForEach-Object { $_.ToUnixTimeMilliseconds() } }';
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const ms = parseInt(String(stdout).trim(), 10);
        resolve(Number.isFinite(ms) && ms > 0 ? ms : null);
      }
    );
  });
}


// 上次关闭时记的位置是否还能用：显示器插拔/分辨率变化后，坐标可能落在当前所有屏幕范围之外，
// 那种情况下用它会导致窗口开到看不见的地方，宁可放弃、退回默认居中
function isPositionOnScreen(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return screen.getAllDisplays().some(({ bounds }) => {
    return x >= bounds.x && x < bounds.x + bounds.width && y >= bounds.y && y < bounds.y + bounds.height;
  });
}

// 上次关闭时记的宽度是否还能用：落在 [WIN_MIN_W, WIN_MAX_W] 区间内才算合法，
// 高度始终按固定比例（WIN_H/WIN_W）跟着宽度换算，不单独存/单独校验
function isWidthValid(width) {
  return Number.isFinite(width) && width >= WIN_MIN_W && width <= WIN_MAX_W;
}

async function createWindow() {
  const server = await startServer();
  const port = server.address().port;
  state.serverPort = port;

  state.characters = scanCharacters();
  const cfg = loadConfig();
  const savedIndex = state.characters.findIndex((c) => c.name === cfg.lastCharacter);
  state.currentIndex = savedIndex >= 0 ? savedIndex : 0;

  state.scenes = scanScenes();
  state.currentSceneName = state.scenes.some((s) => s.name === cfg.lastScene) ? cfg.lastScene : null;

  // 记住主窗口关闭前的位置：只在坐标仍落在当前屏幕范围内时采用，否则走默认居中
  const savedPos = cfg.winPosition;
  const useSavedPos = savedPos && isPositionOnScreen(savedPos.x, savedPos.y);

  // 记住关闭前的大小：宽度合法就用，高度按固定比例跟着换算（跟拖拽缩放手柄时的算法保持一致）
  const savedSize = cfg.winSize;
  const useSavedSize = savedSize && isWidthValid(savedSize.width);
  const initW = useSavedSize ? Math.round(savedSize.width) : WIN_W;
  const initH = useSavedSize ? Math.round((initW * WIN_H) / WIN_W) : WIN_H;

  state.win = new BrowserWindow({
    width: initW,
    height: initH,
    ...(useSavedPos ? { x: Math.round(savedPos.x), y: Math.round(savedPos.y) } : {}),
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
    },
  });
  // 用 'screen-saver' 层级而不是构造参数里的普通 alwaysOnTop:true——层级越高，
  // 越不容易在系统状态切换时被压到后面（见下面 reassertAlwaysOnTop 的注释）
  state.win.setAlwaysOnTop(true, 'screen-saver');

  state.menu = buildMenu();

  // 禁用 Chromium 自带的 Ctrl+滚轮 / 捏合页面缩放（Ctrl+滚轮留给"背景前后移动"）
  try {
    Promise.resolve(state.win.webContents.setVisualZoomLevelLimits(1, 1)).catch(() => {});
  } catch {}

  state.win.loadURL(`http://127.0.0.1:${port}/public/index.html`);
  state.win.webContents.on('did-finish-load', () => {
    send('init', { ...currentCharacterPayload(), scene: currentScene() });
  });
}

// 屏保退出 / 系统睡眠唤醒之后，Windows 会重新洗一遍所有窗口的层级(Z-order)，
// 无边框+透明+不进任务栏的窗口很容易在这次重排里被桌面/资源管理器盖到下面，
// 且不会自动恢复——所以这两个时机各重新置顶一次
function reassertAlwaysOnTop() {
  if (state.win && !state.win.isDestroyed()) state.win.setAlwaysOnTop(true, 'screen-saver');
}
powerMonitor.on('unlock-screen', reassertAlwaysOnTop); // 屏保退出 / 锁屏解锁
powerMonitor.on('resume', reassertAlwaysOnTop); // 系统从睡眠中唤醒

// 每次 LLM 调用完（对话回复 / 归档摘要都算），把最新这一条实时推给"LLM调用记录"窗口；
// 窗口没开着时 llmLogWin 是 null/已销毁，这里直接跳过，等窗口下次打开时用 get-llm-log 兜底拿一次
setLlmLogListener((call) => {
  if (state.llmLogWin && !state.llmLogWin.isDestroyed()) {
    state.llmLogWin.webContents.send('llm-log-updated', call);
  }
});

// ---------- IPC ----------
// 模型刚出现在屏幕上（渲染进程通知）：算一次启动用时气泡。
// 「程序启动用时」= 从这个进程真正起跑（APP_PROCESS_START_MS）到模型出现，跟开机/登录/
// 手动打开的时机都无关，是真实的程序启动耗时，每次都算。
// 「开机用时」= 登录完成时间 − 开机时间，纯粹是 Windows 系统本身加载到能登录的耗时，
// 只在"这场开机第一次启动本程序"时才报一次，之后同一场开机内重开就不重复报了。
ipcMain.on('model-ready', async () => {
  if (bootTimerReported) return;
  bootTimerReported = true;

  const now = Date.now();
  const programStartSec = (now - APP_PROCESS_START_MS) / 1000;
  const uptimeSec = os.uptime();
  const bootAtMs = now - uptimeSec * 1000;

  const cfg = loadConfig();
  const sameBoot = Number.isFinite(cfg.lastBootAtMs) && Math.abs(bootAtMs - cfg.lastBootAtMs) <= SAME_BOOT_TOLERANCE_MS;
  const alreadyShownThisBoot = sameBoot && cfg.bootIntroShown;

  if (alreadyShownThisBoot) {
    send('boot-timer-bubble', `你好啊~本次程序启动用时${formatBootDuration(programStartSec)}。`);
    return;
  }

  // 这场开机第一次启动：查登录完成时间，算出纯 Windows 加载耗时
  const loginAtMs = await getInteractiveLogonTimeMs();
  // 登录时间要落在"开机之后、现在之前"才算有效，否则（查不到 / 系统时钟被调过导致的异常值）
  // 开机用时那部分就报不精确，但程序启动用时依然是精确值
  const valid = loginAtMs != null && loginAtMs >= bootAtMs && loginAtMs <= now;
  const text = valid
    ? `你好啊~本次开机用时${formatBootDuration((loginAtMs - bootAtMs) / 1000)}，程序启动用时${formatBootDuration(programStartSec)}。`
    : `你好啊~本次开机用时未能精确获取，程序启动用时${formatBootDuration(programStartSec)}。`;
  send('boot-timer-bubble', text);
  updateConfig({ lastBootAtMs: bootAtMs, bootIntroShown: true });
});

ipcMain.on('window-move', (_e, dx, dy) => {
  if (!state.win) return;
  const [x, y] = state.win.getPosition();
  state.win.setPosition(x + Math.round(dx), y + Math.round(dy));
});

// 缩放：渲染进程只上报"鼠标相对按下时的水平位移"，尺寸和宽高比全部在这里算
ipcMain.on('window-resize-begin', () => {
  if (!state.win) return;
  state.resizeStartW = state.win.getBounds().width;
});

ipcMain.on('window-resize-by', (_e, dx) => {
  if (!state.win || !Number.isFinite(dx)) return;
  const w = Math.max(WIN_MIN_W, Math.min(WIN_MAX_W, Math.round(state.resizeStartW + dx)));
  const h = Math.round((w * WIN_H) / WIN_W);
  state.win.setBounds({ width: w, height: h });
});

ipcMain.on('scene-adjust-save', (_e, name, adj) => {
  if (typeof name !== 'string' || !state.scenes.some((s) => s.name === name)) return;
  setAdjust(name, normAdjust(adj));
});

ipcMain.on('show-menu', () => {
  if (state.menu && state.win) state.menu.popup({ window: state.win });
});

// ---------- IPC：AI 对话 ----------
// imageDataURL 可选：用户随这条消息发的图片（选文件/粘贴/截图）。图片会：
// 1) 存进 chat-history/images/<角色>/，消息里记文件名（记录窗口里能回看）
// 2) vision 开启时按 OpenAI 视觉格式随本轮消息直发给模型；关闭时只以 "[图片]" / 用户附言的文字形式进 prompt
ipcMain.handle('chat-send', async (e, characterName, message, imageDataURL) => {
  if (typeof characterName !== 'string' || !state.characters.some((c) => c.name === characterName)) {
    throw new Error('未知角色');
  }
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text && !imageDataURL) throw new Error('消息不能为空');

  const history = loadChatHistory(characterName);

  // 跨天了：本轮消息和历史最后一条不是同一天，说明"旧的上一个封存包"要从"上一个封存包"退到"更早"了，
  // 退之前先把那天摘要好、缓存起来（没缓存过才需要摘）。这次摘要调用和下面生成回复的调用串行执行，
  // 不并发；摘要这次要是失败了（网络/接口报错），直接抛出去，本轮不生成回复、不落历史，跟 callLLM
  // 本身失败的表现一致。
  if (history.length) {
    const lastMsgDayKey = dayKeyOf(history[history.length - 1].ts || Date.now());
    const nowDayKey = dayKeyOf(Date.now());
    if (nowDayKey !== lastMsgDayKey) {
      const dayToSummarize = computeLastPastDayKey(history, lastMsgDayKey);
      if (dayToSummarize && !loadDaySummary(characterName, dayToSummarize)) {
        const dayLines = flattenDayLines(characterName, history, dayToSummarize);
        if (dayLines.length) {
          const summaryPrompt = buildSummaryPrompt(characterName, dayToSummarize, dayLines);
          const rawSummary = await callLLM(
            [{ role: 'user', content: summaryPrompt }],
            `摘要生成 - ${characterName}`
          );
          const { summary, memoryLines } = parseSummaryAndMemory(rawSummary);
          saveDaySummary(characterName, dayToSummarize, summary || rawSummary.trim());
          if (memoryLines.length) appendMemoryLines(characterName, memoryLines);
        }
      }
    }
  }

  // 先落图片文件，再拼 prompt（vision 模式需要 dataURL，拼完就能丢掉）
  let imageFile = null;
  if (imageDataURL) imageFile = saveChatImage(characterName, imageDataURL);

  // 摊平历史时本轮图片还没进 history，这里给 user_input 的文字部分兜底：
  // 和 flattenChatHistory 里历史消息的处理方式一致，带图就标 [图片:文件名]，有配文字再拼在后面
  const imageTag = imageFile ? `[图片:${imageFile}]` : '';
  const inputText = imageTag ? (text ? `${imageTag} ${text}` : imageTag) : text;
  const promptText = buildPromptText(characterName, history, inputText);

  // vision 开启且带了图：文字 + 图片按 OpenAI 视觉 content 数组发送
  const messages = [{ role: 'user', content: promptText }];
  if (imageFile && getApiConfig().vision) {
    messages[0].content = [
      { type: 'text', text: promptText },
      { type: 'image_url', image_url: { url: imageDataURL } },
    ];
  }

  // 回复末尾可能带一句【配音语气】：拆出来只给 TTS 用，气泡 / 聊天记录 / 返回值里都是不含它的正文
  const { text: reply, tone } = splitTone(characterName, await callLLM(messages, `对话回复 - ${characterName}`));

  history.push({ role: 'user', content: text, image: imageFile, ts: Date.now() });
  history.push({ role: 'assistant', content: reply, ts: Date.now() });
  saveChatHistory(characterName, history);

  // 朗读 AI 回复：不 await——文字气泡照常立即显示，语音合成好了再通过 'play-tts' 推给宠物窗口。
  // 放在这里，主窗口和聊天记录窗口发起的对话都会走到，不用两处各接一遍
  speakReply(characterName, reply, tone);

  // 主窗口自己发起的对话，气泡由渲染进程本地展示（app.js 里 chatSend 之后直接 showBubble）。
  // 这里只处理"别的窗口（比如聊天记录窗口）发起的对话"：额外把回复推给主宠物窗口头顶显示一下。
  const fromMainWindow = state.win && !state.win.isDestroyed() && e.sender === state.win.webContents;
  if (!fromMainWindow) send('show-bubble', reply);

  // 双向同步：主窗口发起的对话，推给聊天记录窗口实时追加显示。
  // 记录窗口自己发起的对话本地已 appendMsg，推回去会重复，所以只在 fromMainWindow 时推。
  if (
    fromMainWindow &&
    state.historyWin && !state.historyWin.isDestroyed() &&
    state.historyWinCharacter === characterName
  ) {
    state.historyWin.webContents.send('chat-updated', {
      character: characterName,
      user: text,
      reply,
      image: imageFile ? readChatImageDataURL(characterName, imageFile) : null,
    });
  }

  return reply;
});

ipcMain.handle('get-api-config', () => getApiConfig());
ipcMain.handle('save-api-config', (_e, patch) => saveApiConfig(patch && typeof patch === 'object' ? patch : {}));
ipcMain.handle('get-prompt-config', () => getPromptConfig());
ipcMain.handle('save-prompt-config', (_e, patch) => savePromptConfig(patch && typeof patch === 'object' ? patch : {}));

// ---------- IPC：当前角色的资料（persona）编辑（设置窗口用） ----------
// 返回当前角色已填写的人设文本（没填就是空字符串）
ipcMain.handle('get-persona', () => {
  const c = state.characters[state.currentIndex];
  if (!c) return null;
  return {
    characterName: c.name,
    system: readPersonaFile(c.name) || '',
  };
});
ipcMain.handle('save-persona', (_e, characterName, system) => {
  if (!validCharacter(characterName)) throw new Error('未知角色');
  savePersonaFile(characterName, typeof system === 'string' ? system.trim() : '');
  return true;
});
ipcMain.handle('fetch-model-list', (_e, apiUrl, apiKey) => fetchModelList(apiUrl, apiKey));
ipcMain.handle('get-chat-history', (_e, characterName) => {
  if (typeof characterName !== 'string') return [];
  return loadChatHistory(characterName).map((m) => ({
    ...m,
    // 图片消息附带 dataURL 供记录窗口直接渲染缩略图；文件丢了就当纯文字消息
    imageDataURL: m.image ? readChatImageDataURL(characterName, m.image) : undefined,
  }));
});
ipcMain.on('open-history-window', (_e, characterName) => {
  if (typeof characterName === 'string') openHistoryWindow(characterName);
});
// LLM 调用记录窗口打开时，用这个拿一次"当前已有的最新一条"（窗口开着之后的新记录走上面的实时推送）
ipcMain.handle('get-llm-log', () => getLatestLlmCall());

// ---------- IPC：语音合成（音色设置窗口用） ----------
// 密钥是各角色共用的，音色参数按角色分开存；试听用表单当前值，不要求先保存
ipcMain.handle('tts-get-config', (_e, characterName) => {
  if (!validCharacter(characterName)) throw new Error('未知角色');
  return { characterName, ...getTtsConfig(characterName), presets: getPresets() };
});
ipcMain.handle('tts-save-config', (_e, characterName, payload) => {
  if (!validCharacter(characterName)) throw new Error('未知角色');
  return saveTtsConfig(characterName, payload && typeof payload === 'object' ? payload : {});
});
ipcMain.handle('tts-test', (_e, characterName, payload, text) => {
  if (!validCharacter(characterName)) throw new Error('未知角色');
  return testVoice(payload && typeof payload === 'object' ? payload : {}, typeof text === 'string' ? text : '');
});
// MiMo 音色复刻：弹系统文件选择框，选中的参考音频复制进用户数据目录，返回元信息给设置窗口
ipcMain.handle('tts-pick-clone-audio', async (e, characterName) => {
  if (!validCharacter(characterName)) throw new Error('未知角色');
  const parent = BrowserWindow.fromWebContents(e.sender);
  const opts = {
    title: '选择音色复刻的参考音频',
    properties: ['openFile'],
    filters: [{ name: '音频文件', extensions: AUDIO_EXTENSIONS }],
  };
  const r = await (parent ? dialog.showOpenDialog(parent, opts) : dialog.showOpenDialog(opts));
  if (r.canceled || !r.filePaths.length) return null;
  return importCloneAudio(characterName, r.filePaths[0]);
});

// 豆包预置音色：导入（整体覆盖替换生效列表）/ 导出（当前生效列表存成 json）/ 恢复默认（回落到内置列表）
ipcMain.handle('tts-doubao-voices-import', async (e) => {
  const parent = BrowserWindow.fromWebContents(e.sender);
  const opts = {
    title: '导入豆包预置音色',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  };
  const r = await (parent ? dialog.showOpenDialog(parent, opts) : dialog.showOpenDialog(opts));
  if (r.canceled || !r.filePaths.length) return null;
  return doubaoVoicesStore.importVoices(r.filePaths[0]);
});
ipcMain.handle('tts-doubao-voices-export', async (e) => {
  const parent = BrowserWindow.fromWebContents(e.sender);
  const opts = {
    title: '导出豆包预置音色',
    defaultPath: 'doubao-voices.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  };
  const r = await (parent ? dialog.showSaveDialog(parent, opts) : dialog.showSaveDialog(opts));
  if (r.canceled || !r.filePath) return null;
  doubaoVoicesStore.exportVoices(r.filePath);
  return r.filePath;
});
ipcMain.handle('tts-doubao-voices-reset', () => doubaoVoicesStore.resetVoices());

// ---------- IPC：语音识别（ASR，点击🎙说话用）----------
// sessionId -> 会话句柄；按 sender 隔离，主窗口和聊天记录窗口各自独立调用互不干扰
const asrSessions = new Map();

ipcMain.handle('asr-start', (e) => {
  const cfg = getAsrConfig();
  if (!cfg.appId || !cfg.accessKey) {
    throw new Error('尚未配置豆包的 App ID / Access Key，请先在"音色设置"里填好（语音识别复用这套凭据）');
  }
  const sessionId = crypto.randomUUID();
  const sender = e.sender;
  const session = createAsrSession({
    appId: cfg.appId,
    accessKey: cfg.accessKey,
    resourceId: cfg.resourceId,
    onPartial: (text) => {
      if (!sender.isDestroyed()) sender.send('asr-partial', sessionId, text);
    },
    onFinal: (text) => {
      asrSessions.delete(sessionId);
      if (!sender.isDestroyed()) sender.send('asr-final', sessionId, text);
    },
    onError: (err) => {
      asrSessions.delete(sessionId);
      if (!sender.isDestroyed()) sender.send('asr-error', sessionId, err.message || String(err));
    },
  });
  asrSessions.set(sessionId, session);
  return sessionId;
});

// 高频小包，走 send 不走 invoke（不需要每帧等一次往返）
ipcMain.on('asr-audio-chunk', (_e, sessionId, chunk) => {
  const session = asrSessions.get(sessionId);
  if (!session || !chunk) return;
  session.sendAudio(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
});

ipcMain.handle('asr-stop', (_e, sessionId) => {
  const session = asrSessions.get(sessionId);
  if (session) session.finish();
  return true;
});

ipcMain.handle('asr-get-config', () => ({ resourceId: getAsrConfig().resourceId }));
ipcMain.handle('asr-save-config', (_e, patch) => saveAsrConfig(patch && typeof patch === 'object' ? patch : {}));

// ---------- IPC：聊天记录的编辑 / 添加 / 删除 / 清空（聊天记录窗口用） ----------
// 和 chat-send 一样校验角色名（防路径注入），内容按索引定位——history.html 渲染顺序就是数组顺序。
function validCharacter(characterName) {
  return typeof characterName === 'string' && state.characters.some((c) => c.name === characterName);
}

ipcMain.handle('edit-chat-message', (_e, characterName, index, content) => {
  if (!validCharacter(characterName)) throw new Error('未知角色');
  if (!Number.isInteger(index) || index < 0) throw new Error('无效的消息索引');
  const text = typeof content === 'string' ? content.trim() : '';
  if (!text) throw new Error('消息不能为空');

  const history = loadChatHistory(characterName);
  if (index >= history.length) throw new Error('无效的消息索引');
  history[index].content = text;
  saveChatHistory(characterName, history);
  return true;
});

ipcMain.handle('add-chat-message', (_e, characterName, role, content) => {
  if (!validCharacter(characterName)) throw new Error('未知角色');
  if (role !== 'user' && role !== 'assistant') throw new Error('无效的消息身份');
  const text = typeof content === 'string' ? content.trim() : '';
  if (!text) throw new Error('消息不能为空');

  const history = loadChatHistory(characterName);
  const msg = { role, content: text, ts: Date.now() };
  history.push(msg);
  saveChatHistory(characterName, history);
  return msg;
});

ipcMain.handle('delete-chat-message', (_e, characterName, index) => {
  if (!validCharacter(characterName)) throw new Error('未知角色');
  if (!Number.isInteger(index) || index < 0) throw new Error('无效的消息索引');

  const history = loadChatHistory(characterName);
  if (index >= history.length) throw new Error('无效的消息索引');
  const removed = history.splice(index, 1)[0];
  if (removed && removed.image) deleteChatImage(characterName, removed.image); // 图片文件跟着删
  saveChatHistory(characterName, history);
  return true;
});

ipcMain.handle('clear-chat-history', (_e, characterName) => {
  if (!validCharacter(characterName)) throw new Error('未知角色');
  saveChatHistory(characterName, []);
  clearChatImages(characterName); // 图片文件夹整个清掉
  clearDaySummaries(characterName); // 按天摘要缓存也一起清掉
  clearMemoryIndex(characterName); // hot 记忆索引是从这些对话里提炼出来的，聊天记录都没了就一起清空
  clearOpenedDay(characterName); // 当前打开的封印包也跟着清掉，避免指向已经不存在的历史
  return true;
});

app.whenReady().then(() => {
  if (gotLock) createWindow();
});
app.on('window-all-closed', () => app.quit());

// 退出前记住主窗口位置，下次启动原样恢复；随后强制销毁窗口，防止渲染进程卡住
// （WebGL 资源释放慢）拖着整个进程退不干净。注意：任务管理器强杀/断电这类非正常退出不会走到这里，
// 那种情况下位置就不会更新，这是可以接受的取舍。
app.on('before-quit', () => {
  if (state.win && !state.win.isDestroyed()) {
    const [x, y] = state.win.getPosition();
    const { width, height } = state.win.getBounds();
    updateConfig({ winPosition: { x, y }, winSize: { width, height } });
    state.win.destroy();
  }
});
