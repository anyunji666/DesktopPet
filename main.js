const { app, BrowserWindow, ipcMain, dialog, powerMonitor } = require('electron');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;

const { startServer } = require('./main-modules/server');
const { state } = require('./main-modules/state');
const { loadConfig } = require('./main-modules/config');
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

  state.win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
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

// 退出时强制销毁窗口，防止渲染进程卡住（WebGL 资源释放慢）拖着整个进程退不干净
app.on('before-quit', () => {
  if (state.win && !state.win.isDestroyed()) state.win.destroy();
});
