const { app, BrowserWindow, ipcMain, dialog, powerMonitor, screen, session } = require('electron');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFile } = require('child_process');

// 进程真正起跑的时间点，尽量贴近文件顶部，用来算"程序启动用时"（跟开机、登录、
// 隔了多久才手动打开都没关系，纯粹是这个 Electron 进程自己跑起来花了多久）
const APP_PROCESS_START_MS = Date.now();

const ROOT = __dirname;

const { startServer } = require('./main-modules/server');
const geminiRelay = require('./main-modules/gemini-relay');
const { hardenWebContents, hardenSession, guardIpc, isSafeName, maskSecret } = require('./main-modules/security');
const { state } = require('./main-modules/state');
const { constrainMove, constrainResize } = require('./main-modules/win-limit');
const { requestClickThrough } = require('./main-modules/drag-guard');
const { beginChat, endChat, getChatPending, assertHistoryEditable } = require('./main-modules/chat-lock');
const { planCrossDaySummary, runChatTurn } = require('./main-modules/chat-turn');
const { exportToFile, importFromFile } = require('./main-modules/chat-transfer');
const { loadConfig, updateConfig, migrateSecrets } = require('./main-modules/config');
const { scanCharacters } = require('./main-modules/character');
const { scanScenes, setAdjust, normAdjust } = require('./main-modules/scene');
const {
  readPersonaFile,
  savePersonaFile,
  loadChatHistory,
  saveChatHistory,
  readChatImageDataURL,
  deleteChatImage,
  clearChatImages,
  readChatVoice,
  deleteChatVoice,
  clearChatVoices,
  clearDaySummaries,
  clearMemoryIndex,
  loadMemoryIndex,
  saveMemoryIndexManual,
  MEMORY_MAX_CHARS,
  clearOpenedDay,
} = require('./main-modules/chat-store');
const { getTtsConfig, saveTtsConfig, getPresets, testVoice } = require('./main-modules/tts');
const { maskProviders, resolveProvidersInput } = require('./main-modules/tts/config');
const { getAsrConfig, saveAsrConfig } = require('./main-modules/asr/config');
const { createAsrSession } = require('./main-modules/asr/doubao');
const { importCloneAudio, AUDIO_EXTENSIONS } = require('./main-modules/tts/clone-store');
const doubaoVoicesStore = require('./main-modules/tts/doubao-voices-store');
const {
  getApiConfig,
  getApiConfigForRenderer,
  resolveApiPatch,
  resolveApiKeyForUrl,
  ensureRelayToken,
  saveApiConfig,
  deleteApiProfile,
  getPromptConfig,
  savePromptConfig,
} = require('./main-modules/llm');
const { splitTurnSummary, extractStoryTime } = require('./main-modules/history-flatten');
const { fetchModelList, setLlmLogListener, getLatestLlmCall } = require('./main-modules/llm-client');
const {
  securePrefs,
  WIN_W,
  WIN_H,
  WIN_MIN_W,
  WIN_MAX_W,
  computeDesktopLayout,
  getAboutInfo,
  openRepoUrl,
  toggleDevEntries,
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

// ---------- 安全加固：窗口 / 权限 / IPC ----------
// 本地页面的来源（端口在静态服务启动后才确定，所以用函数延迟取值）
const pageOrigin = () => `http://127.0.0.1:${state.serverPort}`;

// 所有 IPC 只接受来自本地静态服务页面的调用（必须在注册任何 handler 之前包好）
guardIpc(ipcMain, pageOrigin);

// 每个窗口都：不许跳转到外部页面、不许 window.open、不许挂 webview
app.on('browser-window-created', (_e, win) => hardenWebContents(win.webContents, pageOrigin));

// 权限请求默认全拒，只放行本地页面的麦克风（语音输入）
app.whenReady().then(() => hardenSession(session.defaultSession, pageOrigin));

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
  // 旧版本留下的明文密钥升级成加密存储（系统不支持加密时什么也不做）
  migrateSecrets();
  const server = await startServer();
  const port = server.address().port;
  state.serverPort = port;

  // 如果之前保存过 Gemini 轮询代理的 Key，启动时自动把本地中转服务起起来（只监听 127.0.0.1）
  // 优先复用上次记住的端口，避免每次开机 Base URL 都要重新填
  (() => {
    const cfgApi = getApiConfig();
    geminiRelay
      .setKeys(cfgApi.llmRelayKeys, cfgApi.llmRelayPort, ensureRelayToken())
      .then((status) => {
        if (status.port && status.port !== cfgApi.llmRelayPort) saveApiConfig({ llmRelayPort: status.port });
      })
      .catch((err) => {
        console.error('[pet] Gemini 轮询中转启动失败:', err);
      });
  })();

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

  // "正常模式"下窗口该在的位置/大小——不管这次是不是以桌面模式启动，都先算出来存好，
  // 退出桌面模式时要用它恢复
  const normalBounds = {
    ...(useSavedPos ? { x: Math.round(savedPos.x), y: Math.round(savedPos.y) } : {}),
    width: initW,
    height: initH,
  };

  // 背景鼠标互动：上次关闭时是什么状态，这次就从什么状态开始
  state.bgMouseInteraction = cfg.bgMouseInteraction !== false;

  // "LLM记录"/"开发者工具"菜单项：默认隐藏，上次在关于窗口里打开过才显示
  state.showDevEntries = cfg.showDevEntries === true;

  // 桌面模式下直接按桌面布局创建窗口（而不是先建正常小窗口再跳变），避免启动瞬间闪一下。
  // 布局算法跟运行中切换进入桌面模式共用 computeDesktopLayout：模型视口 = 普通窗口的位置/大小，
  // 窗口只在纵向展开。没有保存过位置时，普通窗口原本是交给系统居中的，但桌面布局需要确切坐标，
  // 这里按主屏工作区手动居中，效果一致，退出桌面模式时也恢复到这个位置
  if (!state.bgMouseInteraction && normalBounds.x === undefined) {
    const wa = screen.getPrimaryDisplay().workArea;
    normalBounds.x = Math.round(wa.x + (wa.width - normalBounds.width) / 2);
    normalBounds.y = Math.round(wa.y + (wa.height - normalBounds.height) / 2);
  }
  state.normalWinBounds = normalBounds;

  let createBounds = normalBounds;
  let initialDesktopViewport = null;
  if (!state.bgMouseInteraction) {
    const layout = computeDesktopLayout(normalBounds);
    createBounds = layout.bounds;
    initialDesktopViewport = layout.viewport;
  }

  state.win = new BrowserWindow({
    ...createBounds,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    webPreferences: securePrefs(),
  });
  // 用 'screen-saver' 层级而不是构造参数里的普通 alwaysOnTop:true——层级越高，
  // 越不容易在系统状态切换时被压到后面（见下面 reassertAlwaysOnTop 的注释）
  state.win.setAlwaysOnTop(true, 'screen-saver');
  if (!state.bgMouseInteraction) state.win.setIgnoreMouseEvents(true, { forward: true });

  state.menu = buildMenu();

  // 禁用 Chromium 自带的 Ctrl+滚轮 / 捏合页面缩放（Ctrl+滚轮留给"背景前后移动"）
  try {
    Promise.resolve(state.win.webContents.setVisualZoomLevelLimits(1, 1)).catch(() => {});
  } catch {}

  state.win.loadURL(`http://127.0.0.1:${port}/public/index.html`);
  state.win.webContents.on('did-finish-load', () => {
    send('init', {
      ...currentCharacterPayload(),
      scene: currentScene(),
      bgMouseInteraction: state.bgMouseInteraction,
      desktopViewport: initialDesktopViewport,
    });
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

// 每次 LLM 调用完（对话回复 / 归档总结都算），把最新这一条实时推给"LLM调用记录"窗口；
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

// 所有显示器的工作区（已排除任务栏），供窗口位置限制使用
function getWorkAreas() {
  return screen.getAllDisplays().map((d) => d.workArea);
}

// ---- 关于窗口：读取信息 / 打开 GitHub / 连续点版本号切换开发者菜单项 ----
// 只响应关于窗口自己发来的请求（别的子窗口共用同一个 preload，不该能调用这些）
const fromAboutWin = (e) => state.aboutWin && !state.aboutWin.isDestroyed() && e.sender === state.aboutWin.webContents;
ipcMain.handle('get-about-info', (e) => (fromAboutWin(e) ? getAboutInfo() : null));
ipcMain.on('about-open-repo', (e) => {
  if (fromAboutWin(e)) openRepoUrl();
});
ipcMain.handle('about-toggle-dev-entries', (e) => (fromAboutWin(e) ? toggleDevEntries() : state.showDevEntries));

ipcMain.on('window-move', (_e, dx, dy) => {
  if (!state.win || state.bgMouseInteraction === false) return;
  // 位置限制：窗口中间一半的区域不能移出屏幕工作区（多显示器合并计算，详见 win-limit.js）；
  // 被限制住的那部分位移直接丢弃
  const cur = state.win.getBounds();
  const pos = constrainMove(cur, Math.round(dx), Math.round(dy), getWorkAreas());
  state.win.setPosition(pos.x, pos.y);
});

// 缩放：渲染进程只上报"鼠标相对按下时的水平位移"，尺寸和宽高比全部在这里算
ipcMain.on('window-resize-begin', () => {
  if (!state.win || state.bgMouseInteraction === false) return;
  state.resizeStartW = state.win.getBounds().width;
});

ipcMain.on('window-resize-by', (_e, dx) => {
  if (!state.win || state.bgMouseInteraction === false || !Number.isFinite(dx)) return;
  const w = Math.max(WIN_MIN_W, Math.min(WIN_MAX_W, Math.round(state.resizeStartW + dx)));
  const h = Math.round((w * WIN_H) / WIN_W);
  // 缩放时左上角不动、向右下放大，窗口变大后中间区域可能被推出工作区，这里一并限制
  const cur = state.win.getBounds();
  const pos = constrainResize({ x: cur.x, y: cur.y, width: w, height: h }, getWorkAreas());
  state.win.setBounds({ x: pos.x, y: pos.y, width: w, height: h });
});

// 桌面模式下，渲染进程每次"是否悬停在模型/展开的对话框上"这个判定结果变化时上报一次
// （不是每帧都发，见 app.js 里的防抖），据此切换窗口是否穿透鼠标事件。
// 非桌面模式下这个开关本来就没打开，忽略即可，不需要额外判断。
// 子窗口正在被拖动/缩放时不立刻生效，只记下最新值、拖完再恢复（见 main-modules/drag-guard.js）。
ipcMain.on('set-click-through', (_e, ignore) => requestClickThrough(ignore));

ipcMain.on('scene-adjust-save', (_e, name, adj) => {
  if (typeof name !== 'string' || !state.scenes.some((s) => s.name === name)) return;
  setAdjust(name, normAdjust(adj));
});

ipcMain.on('show-menu', () => {
  if (state.menu && state.win) state.menu.popup({ window: state.win });
});

// ---------- IPC：AI 对话 ----------
// 一次只能发一条：chat-send 开头上锁（chat-lock.js），LLM 回复且落盘/报错之后才解锁，
// 期间主界面和聊天记录窗口的发送都被禁用，同一角色的聊天记录也不允许编辑/插入/删除/清空。
// 这里只做 IPC 层（校验 / 上锁 / 解锁 / 推送）；一轮对话本身怎么跑（跨天总结 -> 存图 -> 拼 prompt ->
// 调 LLM -> 落盘 -> TTS）在 main-modules/chat-turn.js。

ipcMain.handle('chat-send', async (e, characterName, message, imageDataURL) => {
  if (typeof characterName !== 'string' || !state.characters.some((c) => c.name === characterName)) {
    throw new Error('未知角色');
  }
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text && !imageDataURL) throw new Error('消息不能为空');

  // === 上锁 ===
  // 已经有一条在等回复时 beginChat 会直接抛错，本次发送被拒绝（不影响正在进行的那一条）
  // 先判断要不要做跨天总结，锁一开始就带上对应阶段（同步、无 await，判断到上锁之间不会有别的改动插进来）
  const summaryPlan = planCrossDaySummary(characterName);
  const fromMainWindow = state.win && !state.win.isDestroyed() && e.sender === state.win.webContents;
  beginChat({
    character: characterName,
    source: fromMainWindow ? 'main' : 'history',
    user: text,
    imageDataURL,
    phase: summaryPlan ? 'summarizing' : 'waiting',
    summaryDay: summaryPlan ? summaryPlan.dayToSummarize : null, // 界面提示里要写具体是哪一天
  });

  // === 跑一轮对话，成功/失败都要解锁 ===
  let turn;
  try {
    turn = await runChatTurn(characterName, text, imageDataURL, summaryPlan);
  } catch (err) {
    endChat({ ok: false });
    throw err;
  }
  endChat({ ok: true, committed: turn.committed, startIndex: turn.startIndex });

  // 主窗口自己发起的对话，气泡由渲染进程本地展示（chat.js 里 chatSend 之后直接 showBubble）；
  // 聊天记录窗口发起的对话，额外把回复推给主宠物窗口头顶显示一下。
  // （聊天记录窗口里的消息不再靠这里推送：发出时的临时气泡、落盘后的正式消息，
  //  都由 chat-lock.js 的 chat-pending-changed / chat-settled 事件统一处理，两个窗口发起的对话走同一条路径）
  if (!fromMainWindow) send('show-bubble', turn.reply);

  return turn.reply;
});

// 渲染进程拿到的密钥一律是遮罩（••••abcd），真实密钥不离开主进程；
// 保存时原样传回遮罩 = 沿用原密钥（见 llm.js 的 resolveApiPatch）
ipcMain.handle('get-api-config', () => getApiConfigForRenderer());
ipcMain.handle('save-api-config', async (_e, patch) => {
  saveApiConfig(resolveApiPatch(patch && typeof patch === 'object' ? patch : {}));
  const next = getApiConfig();
  const relayStatus = await geminiRelay.setKeys(next.llmRelayKeys, next.llmRelayPort, ensureRelayToken()).catch((err) => {
    console.error('[pet] Gemini 轮询中转启动失败:', err);
    return geminiRelay.getStatus();
  });
  // 实际分配到的端口和记的不一样时（第一次生成 / 原端口被占用被迫换新的），更新记录，下次继续沿用
  if (relayStatus.port && relayStatus.port !== next.llmRelayPort) {
    saveApiConfig({ llmRelayPort: relayStatus.port });
  }
  return { ...getApiConfigForRenderer(), relayStatus };
});
// 删除设置窗口里"已保存的 API 地址"下拉中的一条，返回删除后的列表
ipcMain.handle('delete-api-profile', (_e, url) =>
  deleteApiProfile(typeof url === 'string' ? url : '').map((p) => ({ api_url: p.api_url, api_key: maskSecret(p.api_key) }))
);
ipcMain.handle('get-relay-status', () => geminiRelay.getStatus());
ipcMain.handle('get-prompt-config', () => getPromptConfig());
ipcMain.handle('save-prompt-config', (_e, patch) => savePromptConfig(patch && typeof patch === 'object' ? patch : {}));

// ---------- IPC：当前角色的资料（persona）编辑（设置窗口用） ----------
// 返回当前角色已填写的人设文本（没填就是空字符串）
ipcMain.handle('get-persona', () => {
  const c = state.characters[state.currentIndex];
  if (!c) return null;
  const { system, storyBackground } = readPersonaFile(c.name);
  return {
    characterName: c.name,
    system,
    storyBackground,
  };
});
ipcMain.handle('save-persona', (_e, characterName, system, storyBackground) => {
  if (!validCharacter(characterName)) throw new Error('未知角色');
  savePersonaFile(characterName, {
    system: typeof system === 'string' ? system.trim() : '',
    storyBackground: typeof storyBackground === 'string' ? storyBackground.trim() : '',
  });
  return true;
});
// ---------- IPC：当前角色的印象标签（memory index）编辑（设置窗口用） ----------
// 印象标签 = 跨天总结时 AI 自动提炼的"关于用户的长期记忆"，这里允许用户手动增删改。每个角色各一份。
ipcMain.handle('get-memory-index', () => {
  const c = state.characters[state.currentIndex];
  if (!c) return null;
  return { characterName: c.name, text: loadMemoryIndex(c.name), maxChars: MEMORY_MAX_CHARS };
});
ipcMain.handle('save-memory-index', (_e, characterName, text) => {
  if (!validCharacter(characterName)) throw new Error('未知角色');
  // 这个角色正在等回复 / 做跨天总结时，总结那次调用可能马上要往这份标签里追加，此时手动保存会互相覆盖，直接拦下
  assertHistoryEditable(characterName);
  saveMemoryIndexManual(characterName, text);
  return true;
});
ipcMain.handle('fetch-model-list', (_e, apiUrl, apiKey) => {
  const url = typeof apiUrl === 'string' ? apiUrl : '';
  return fetchModelList(url, resolveApiKeyForUrl(url, typeof apiKey === 'string' ? apiKey : ''));
});
// 窗口刚打开时查一下当前有没有在等回复的对话（之后的变化走 chat-pending-changed 推送）
ipcMain.handle('get-chat-pending', () => getChatPending());
ipcMain.handle('get-chat-history', (_e, characterName) => {
  if (typeof characterName !== 'string') return [];
  return loadChatHistory(characterName).map((m) => ({
    ...m,
    // assistant 消息存盘时末尾拼了 <story_overview> 摘要块（给轮次压缩用），聊天记录窗口只是给人看的，
    // 这个标签用户不需要看到——只处理这个接口的返回值，磁盘上的历史文件本身不受影响
    content: m.role === 'assistant' ? splitTurnSummary(m.content).body : m.content,
    // AI 消息的故事时间（取自被剥掉的那个摘要块），记录窗口拿去在气泡末尾打标签；摘要里没有就是空串，不显示
    storyTime: m.role === 'assistant' ? extractStoryTime(m.content) : '',
    // 图片消息附带 dataURL 供记录窗口直接渲染缩略图；文件丢了就当纯文字消息
    imageDataURL: m.image ? readChatImageDataURL(characterName, m.image) : undefined,
  }));
});
// 聊天记录窗口双击 AI 气泡重听：按消息的 ts 取缓存的回复语音，没有（没调用过 TTS / 老消息）返回 null
ipcMain.handle('get-chat-voice', (_e, characterName, ts) => {
  if (!validCharacter(characterName)) return null;
  return readChatVoice(characterName, ts);
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
  const cfg = getTtsConfig(characterName);
  return { characterName, ...cfg, providers: maskProviders(cfg.providers), presets: getPresets() };
});
ipcMain.handle('tts-save-config', (_e, characterName, payload) => {
  if (!validCharacter(characterName)) throw new Error('未知角色');
  const p = payload && typeof payload === 'object' ? payload : {};
  // 表单里原样传回的遮罩密钥要还原成已存的真实密钥
  const saved = saveTtsConfig(characterName, { ...p, providers: p.providers ? resolveProvidersInput(p.providers) : undefined });
  return { ...saved, providers: maskProviders(saved.providers) };
});
ipcMain.handle('tts-test', (_e, characterName, payload, text) => {
  if (!validCharacter(characterName)) throw new Error('未知角色');
  const p = payload && typeof payload === 'object' ? payload : {};
  return testVoice({ ...p, providers: resolveProvidersInput(p.providers) }, typeof text === 'string' ? text : '');
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
  return typeof characterName === 'string' && isSafeName(characterName) && state.characters.some((c) => c.name === characterName);
}

ipcMain.handle('edit-chat-message', (_e, characterName, index, content) => {
  if (!validCharacter(characterName)) throw new Error('未知角色');
  assertHistoryEditable(characterName); // 正在等这个角色的回复时不允许改记录
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
  assertHistoryEditable(characterName); // 正在等这个角色的回复时不允许改记录
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
  assertHistoryEditable(characterName); // 正在等这个角色的回复时不允许改记录
  if (!Number.isInteger(index) || index < 0) throw new Error('无效的消息索引');

  const history = loadChatHistory(characterName);
  if (index >= history.length) throw new Error('无效的消息索引');
  const removed = history.splice(index, 1)[0];
  if (removed && removed.image) deleteChatImage(characterName, removed.image); // 图片文件跟着删
  if (removed) deleteChatVoice(characterName, removed.ts); // 回复语音也跟着删
  saveChatHistory(characterName, history);
  return true;
});

// 批量删除：删掉 fromIndex 起（含）到末尾的所有消息，一次读盘、一次落盘（"重新生成"用）。
// 图片文件跟着删；校验放在删除之前，出错不会删一半。
ipcMain.handle('truncate-chat-history', (_e, characterName, fromIndex) => {
  if (!validCharacter(characterName)) throw new Error('未知角色');
  assertHistoryEditable(characterName); // 正在等这个角色的回复时不允许改记录
  if (!Number.isInteger(fromIndex) || fromIndex < 0) throw new Error('无效的消息索引');

  const history = loadChatHistory(characterName);
  if (fromIndex >= history.length) throw new Error('无效的消息索引');
  const removed = history.splice(fromIndex);
  saveChatHistory(characterName, history); // 先落盘，成功后再删图片文件，避免记录还在图片却没了
  for (const m of removed) {
    if (!m) continue;
    if (m.image) deleteChatImage(characterName, m.image);
    deleteChatVoice(characterName, m.ts); // 回复语音跟着删
  }
  return removed.length;
});

// 聊天记录导出 / 导入（文件格式和校验见 chat-transfer.js）。取消选择文件返回 null
ipcMain.handle('export-chat-history', async (e, characterName) => {
  if (!validCharacter(characterName)) throw new Error('未知角色');
  const parent = BrowserWindow.fromWebContents(e.sender);
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const opts = {
    title: '记录导出',
    defaultPath: `${characterName}-聊天记录-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  };
  const r = await (parent ? dialog.showSaveDialog(parent, opts) : dialog.showSaveDialog(opts));
  if (r.canceled || !r.filePath) return null;
  return { filePath: r.filePath, count: exportToFile(characterName, r.filePath) };
});

ipcMain.handle('import-chat-history', async (e, characterName) => {
  if (!validCharacter(characterName)) throw new Error('未知角色');
  assertHistoryEditable(characterName); // 正在等这个角色的回复时不允许改记录
  const parent = BrowserWindow.fromWebContents(e.sender);
  const opts = {
    title: '记录导入（会覆盖当前记录）',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  };
  const r = await (parent ? dialog.showOpenDialog(parent, opts) : dialog.showOpenDialog(opts));
  if (r.canceled || !r.filePaths.length) return null;
  assertHistoryEditable(characterName); // 选文件期间可能刚好发出了新消息，落盘前再查一次
  return importFromFile(characterName, r.filePaths[0]);
});

ipcMain.handle('clear-chat-history', (_e, characterName) => {
  if (!validCharacter(characterName)) throw new Error('未知角色');
  assertHistoryEditable(characterName); // 正在等这个角色的回复时不允许改记录
  saveChatHistory(characterName, []);
  clearChatImages(characterName); // 图片文件夹整个清掉
  clearChatVoices(characterName); // 回复语音文件夹也整个清掉
  clearDaySummaries(characterName); // 按天总结缓存也一起清掉
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
// 桌面模式下真实窗口的位置/大小是被临时纵向展开的那一份，不是用户认知里
// "普通模式窗口"该在的地方——这时候不能存窗口当前的实际 bounds，要存 state.normalWinBounds
// （切换进桌面模式前记下的那份快照），不然下次启动或者切回普通模式时就会用错位置。
app.on('before-quit', () => {
  geminiRelay.stopRelay();
  if (state.win && !state.win.isDestroyed()) {
    const bounds = state.bgMouseInteraction ? state.win.getBounds() : state.normalWinBounds || state.win.getBounds();
    updateConfig({ winPosition: { x: bounds.x, y: bounds.y }, winSize: { width: bounds.width, height: bounds.height } });
    state.win.destroy();
  }
});
