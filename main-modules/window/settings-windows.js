// ---------- 各页面窗口：API 与全局设置 / 角色与音色 / 角色服饰 / 角色资产 / 聊天记录 / 关于 / LLM 调用记录 ----------
// 全部是独立普通窗口（跟"开发者工具"一样 detach）。这里只管"怎么开、开了之后怎么原地换角色、关掉前的未保存确认"，
// 页面内容与落盘逻辑都不在这个文件里。
const { BrowserWindow, shell, ipcMain } = require('electron');
const { state } = require('../state');
const { loadConfig, updateConfig } = require('../config');
const { attachDragGuard } = require('../drag-guard');
const { securePrefs } = require('./secure-prefs');
const { send } = require('./main-window');
const { rebuildMenu } = require('./menu-actions');
const pkg = require('../../package.json');

// ---------- 关于：作者 / 版本 / GitHub 地址，读 package.json 里的 author / homepage，只在这里维护一份 ----------
const APP_VERSION_LABEL = pkg.version;
const APP_REPO_URL = pkg.homepage || '';

function getAboutInfo() {
  return {
    description: pkg.description || pkg.name,
    author: pkg.author || '未知',
    version: APP_VERSION_LABEL,
    repoUrl: APP_REPO_URL,
  };
}

// 只打开 package.json 里配置的那个地址，不接受渲染进程传来的任意 URL
function openRepoUrl() {
  if (APP_REPO_URL) shell.openExternal(APP_REPO_URL);
}

// ---------- 开子窗口的公共流程 ----------
// 桌面模式下宠物窗口纵向展开（通常接近整个屏幕高度）、又是持续渲染的透明覆盖层，新开一个子窗口时
// 会跟它的首次绘制抢 GPU/合成资源，表现为"窗口本身出来了，但里面内容半天不出来"。
// 开子窗口前先通知宠物暂停渲染，子窗口内容加载完（或超时兜底，防止事件没触发导致渲染永久暂停）
// 之后再恢复；普通模式下宠物窗口本来就很小，没有这个问题，直接跳过不影响
//
// resumeOn 控制"内容加载完"具体怎么判断：
// - 'load'（默认）：页面 did-finish-load 就算完，适合设置/音色/LLM记录这类内容同步渲染的页面。
// - 'content-ready'：等渲染进程自己在真正画完内容后，通过 signalChannel 上报，
//   再恢复宠物渲染。聊天记录窗口是先加载页面骨架、再异步取历史消息渲染气泡的，
//   如果按 did-finish-load 恢复，宠物那个纵向展开的覆盖层会在气泡真正显示到屏幕前
//   就抢回合成资源，导致气泡内容要等用户点击窗口或最小化还原才被"逼"出来。
function withRenderPause(createFn, { resumeOn = 'load', signalChannel } = {}) {
  if (state.bgMouseInteraction !== false) {
    // 普通模式：不需要暂停渲染；但之后可能切到桌面模式，拖动保护照样挂上
    const w = createFn();
    if (w) attachDragGuard(w);
    return w;
  }
  send('pause-render');
  let resumed = false;
  let offSignal = null;
  const resume = () => {
    if (resumed) return;
    resumed = true;
    clearTimeout(fallbackTimer);
    if (offSignal) offSignal();
    // 双保险：即使时机刚好没掐准、内容其实已经画完但还没被系统真正呈现出来，
    // 也主动强制系统重绘一帧，等效于用户手动点一下 / 最小化还原触发的效果，
    // 不用非得靠用户自己动手才能看到内容。
    // 必须先判 isDestroyed 再碰 webContents：窗口已销毁时访问 win.webContents 本身就会抛异常，
    // 抛在 send('resume-render') 之前的话，宠物的渲染就会永远停在暂停状态
    try {
      if (win && !win.isDestroyed()) win.webContents.invalidate();
    } catch {}
    send('resume-render');
  };
  // 兜底定时器要在创建窗口之前就挂上：createFn 万一抛错，pause-render 已经发出去了，不能没人负责恢复
  const fallbackTimer = setTimeout(resume, 5000);
  let win = null;
  try {
    win = createFn();
  } catch (err) {
    clearTimeout(fallbackTimer);
    resume();
    throw err;
  }
  if (win) attachDragGuard(win); // 拖动/缩放这个子窗口期间，临时关掉宠物窗口的鼠标转发（见 drag-guard.js）
  if (win && !win.isDestroyed() && win.webContents) {
    if (resumeOn === 'content-ready' && signalChannel) {
      const wcId = win.webContents.id;
      const onSignal = (event) => {
        if (event.sender.id === wcId) resume();
      };
      ipcMain.on(signalChannel, onSignal);
      offSignal = () => ipcMain.removeListener(signalChannel, onSignal);
    } else {
      win.webContents.once('did-finish-load', resume);
    }
    win.once('closed', resume);
  }
  return win;
}

// ---------- API 与全局设置窗口 ----------
// API 与全局设置窗口：全局唯一，不区分角色——API / Prompt 前置文本 / 附加要求都是全局共用的。
// 已经打开就直接聚焦（保住没保存的编辑）。
function openSettingsWindow() {
  if (state.settingsWin && !state.settingsWin.isDestroyed()) {
    state.settingsWin.show();
    state.settingsWin.focus();
    return;
  }
  withRenderPause(() => {
    state.settingsWin = new BrowserWindow({
      width: 500,
      height: 700,
      resizable: false,
      title: 'API 与全局设置',
      webPreferences: securePrefs(),
    });
    // 桌面模式下宠物主窗口纵向展开且常驻置顶，会让新开的子窗口被 Chromium 判定为遮挡/后台，
    // 首帧渲染被节流，导致内容要等用户点一下（真正的输入事件）才画出来；关掉节流从根源避免
    state.settingsWin.webContents.setBackgroundThrottling(false);
    state.settingsWin.setMenu(null);
    state.settingsWin.loadURL(`http://127.0.0.1:${state.serverPort}/public/settings.html`);
    return state.settingsWin;
  });
}

function characterVoicePageUrl(characterName) {
  return `http://127.0.0.1:${state.serverPort}/public/character-voice-settings.html?character=${encodeURIComponent(characterName)}`;
}

// 不关窗口就地换角色：位置 / 大小保持不变，只按新角色重载页面（跟聊天记录窗口同一套做法）。
// 页面状态全部按 URL 里的角色名初始化，重载等于一次干净的重建，不会残留上一个角色的编辑。
function retargetCharacterVoiceWindow(characterName) {
  const win = state.characterVoiceWin;
  if (!win || win.isDestroyed()) return;
  state.characterVoiceWinCharacter = characterName;
  win.setTitle('角色与音色设置 - ' + characterName);
  win.loadURL(characterVoicePageUrl(characterName));
}

// 页面在浮层里确认"放弃修改并切换"之后回调：这时页面已经放行 beforeunload，直接重载成目标角色
function confirmCharacterVoiceSwitch(characterName) {
  if (typeof characterName !== 'string') return;
  if (!state.characters.some((c) => c.name === characterName)) return;
  retargetCharacterVoiceWindow(characterName);
}

// 角色与音色设置窗口：每次只开一个，按角色打开——同一页上下两段分别是
// 角色设定（世界背景 / 角色资料 / 别名 / 你的资料）和音色设置（先选服务商，再配音色）。
// 编辑的是 characterName 这个角色，不用先切换桌宠当前角色。
// 点的还是已经打开的那个角色就直接聚焦（保住没保存的编辑）；点另一个角色时不再关窗重开，
// 而是交给页面判断：没有未保存的修改就立刻原地换成新角色，有的话页面弹自己的确认浮层
//（用户选"放弃修改并切换"后再回调 confirmCharacterVoiceSwitch）。
function openCharacterVoiceWindow(characterName) {
  const win = state.characterVoiceWin;
  if (win && !win.isDestroyed()) {
    if (state.characterVoiceWinCharacter === characterName) {
      win.show();
      win.focus();
      return;
    }
    win.show();
    win.focus();
    win.webContents.send('character-voice-switch-ask', characterName);
    return;
  }
  state.characterVoiceWinCharacter = characterName;
  withRenderPause(() => {
    state.characterVoiceWin = new BrowserWindow({
      width: 500,
      height: 700,
      resizable: false,
      title: '角色与音色设置 - ' + characterName,
      webPreferences: securePrefs(),
    });
    // 见 openSettingsWindow 里的同名调用注释
    state.characterVoiceWin.webContents.setBackgroundThrottling(false);
    state.characterVoiceWin.setMenu(null);
    const created = state.characterVoiceWin;
    // 页面有未保存修改时会拦住关闭（beforeunload），这里只把窗口提到前面，让页面自己的确认浮层能被看到；
    // 确认框一律不用系统对话框（见页面里的 #confirm-overlay）。不调 preventDefault = 关闭保持被取消。
    // 注意：这个事件的 Event 对象上没有 sender（拿 e.sender 会抛 TypeError），窗口引用直接从闭包拿
    created.webContents.on('will-prevent-unload', () => {
      if (created.isDestroyed()) return;
      created.show();
      created.focus();
    });
    created.loadURL(characterVoicePageUrl(characterName));
    return created;
  });
}

// ---------- 角色服饰配置窗口 ----------
// 和「角色资产配置」同一套打开 / 换角色逻辑：每次只开一个，点已打开的角色直接聚焦，点另一个角色交给页面判断有没有未保存的修改。
function outfitsPageUrl(characterName) {
  return `http://127.0.0.1:${state.serverPort}/public/character-outfits.html?character=${encodeURIComponent(characterName)}`;
}

function confirmOutfitsSwitch(characterName) {
  if (typeof characterName !== 'string') return;
  if (!state.characters.some((c) => c.name === characterName)) return;
  const win = state.outfitsWin;
  if (!win || win.isDestroyed()) return;
  state.outfitsWinCharacter = characterName;
  win.setTitle('角色服饰配置 - ' + characterName);
  win.loadURL(outfitsPageUrl(characterName));
}

function openOutfitsWindow(characterName) {
  const win = state.outfitsWin;
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    if (state.outfitsWinCharacter !== characterName) win.webContents.send('outfits-switch-ask', characterName);
    return;
  }
  state.outfitsWinCharacter = characterName;
  withRenderPause(() => {
    state.outfitsWin = new BrowserWindow({
      width: 560,
      height: 760,
      minWidth: 500,
      minHeight: 560,
      title: '角色服饰配置 - ' + characterName,
      webPreferences: securePrefs(),
    });
    // 见 openSettingsWindow 里的同名调用注释
    state.outfitsWin.webContents.setBackgroundThrottling(false);
    state.outfitsWin.setMenu(null);
    const created = state.outfitsWin;
    // 有未保存修改时页面会拦住关闭（beforeunload），这里只把窗口提到前面让页面自己的确认浮层被看到
    created.webContents.on('will-prevent-unload', () => {
      if (created.isDestroyed()) return;
      created.show();
      created.focus();
    });
    created.loadURL(outfitsPageUrl(characterName));
    return created;
  });
}

// ---------- 角色资产配置窗口 ----------
// 和「角色与音色设置」同一套打开 / 换角色逻辑：每次只开一个，按角色打开，不用先切换桌宠当前角色；
// 点的是已打开的那个角色就直接聚焦，点另一个角色交给页面判断有没有未保存的修改（见 character-assets.html）。
function assetsPageUrl(characterName) {
  return `http://127.0.0.1:${state.serverPort}/public/character-assets.html?character=${encodeURIComponent(characterName)}`;
}

// 页面确认"放弃修改并切换"之后回调：页面已放行 beforeunload，直接重载成目标角色
function confirmAssetsSwitch(characterName) {
  if (typeof characterName !== 'string') return;
  if (!state.characters.some((c) => c.name === characterName)) return;
  const win = state.assetsWin;
  if (!win || win.isDestroyed()) return;
  state.assetsWinCharacter = characterName;
  win.setTitle('角色资产配置 - ' + characterName);
  win.loadURL(assetsPageUrl(characterName));
}

function openAssetsWindow(characterName) {
  const win = state.assetsWin;
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    if (state.assetsWinCharacter !== characterName) win.webContents.send('assets-switch-ask', characterName);
    return;
  }
  state.assetsWinCharacter = characterName;
  withRenderPause(() => {
    state.assetsWin = new BrowserWindow({
      width: 560,
      height: 760,
      minWidth: 500,
      minHeight: 560,
      title: '角色资产配置 - ' + characterName,
      webPreferences: securePrefs(),
    });
    // 见 openSettingsWindow 里的同名调用注释
    state.assetsWin.webContents.setBackgroundThrottling(false);
    state.assetsWin.setMenu(null);
    const created = state.assetsWin;
    // 有未保存修改时页面会拦住关闭（beforeunload），这里只把窗口提到前面让页面自己的确认浮层被看到
    created.webContents.on('will-prevent-unload', () => {
      if (created.isDestroyed()) return;
      created.show();
      created.focus();
    });
    created.loadURL(assetsPageUrl(characterName));
    return created;
  });
}

// ---------- 聊天记录窗口 ----------
function historyWindowUrl(characterName) {
  return `http://127.0.0.1:${state.serverPort}/public/history.html?character=${encodeURIComponent(characterName)}`;
}

// 切换角色时让已打开的聊天记录窗口原地换成新角色：窗口位置/大小保持不变，只重新加载页面内容。
// 没有打开的聊天记录窗口就什么都不做。页面（history/*.js）所有状态都按 URL 里的角色名初始化，
// 整页重新加载等于一次干净的重建，不会残留旧角色的消息、临时气泡或输入框草稿。
function retargetHistoryWindow(characterName) {
  const w = state.historyWin;
  if (!w || w.isDestroyed() || state.historyWinCharacter === characterName) return;
  state.historyWinCharacter = characterName;
  w.setTitle('聊天记录 - ' + characterName);
  w.loadURL(historyWindowUrl(characterName));
}

function openHistoryWindow(characterName) {
  if (state.historyWin && !state.historyWin.isDestroyed()) state.historyWin.close();
  state.historyWinCharacter = characterName;
  withRenderPause(() => {
    state.historyWin = new BrowserWindow({
      width: 560, // 默认大小和"角色资产配置"窗口一致
      height: 760,
      minWidth: 500, // 和"角色资产配置"窗口一致
      minHeight: 560,
      title: '聊天记录 - ' + characterName,
      webPreferences: securePrefs(),
    });
    // 见 openSettingsWindow 里的同名调用注释
    state.historyWin.webContents.setBackgroundThrottling(false);
    state.historyWin.setMenu(null);
    state.historyWin.loadURL(historyWindowUrl(characterName));
    return state.historyWin;
  }, { resumeOn: 'content-ready', signalChannel: 'history-content-ready' });
}

// ---------- 关于窗口 ----------
// 用自己的窗口而不是系统原生弹窗，因为要监听版本号的连续点击（隐藏入口：切换 LLM记录/开发者工具 菜单项）
function openAboutWindow() {
  if (state.aboutWin && !state.aboutWin.isDestroyed()) {
    state.aboutWin.show();
    state.aboutWin.focus();
    return;
  }
  withRenderPause(() => {
    state.aboutWin = new BrowserWindow({
      width: 440,
      height: 260,
      useContentSize: true, // 宽高指内容区，不含标题栏/边框，避免不同系统边框粗细不同把内容挤出滚动条
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: '关于',
      webPreferences: securePrefs(),
    });
    // 见 openSettingsWindow 里的同名调用注释
    state.aboutWin.webContents.setBackgroundThrottling(false);
    state.aboutWin.setMenu(null);
    state.aboutWin.loadURL(`http://127.0.0.1:${state.serverPort}/public/about.html`);
    return state.aboutWin;
  });
}

// 切换右键菜单里"LLM记录"/"开发者工具"的显示，状态写进 config.json（默认隐藏）。
// 隐藏时顺手把已经开着的 LLM 记录窗口和开发者工具关掉，这样"隐藏"就是真的隐藏。
// 返回切换后的状态（true = 显示）。
function toggleDevEntries() {
  state.showDevEntries = !state.showDevEntries;
  updateConfig({ showDevEntries: state.showDevEntries });
  if (!state.showDevEntries) {
    if (state.llmLogWin && !state.llmLogWin.isDestroyed()) state.llmLogWin.close();
    if (state.win && !state.win.isDestroyed() && state.win.webContents.isDevToolsOpened()) {
      state.win.webContents.closeDevTools();
    }
  }
  rebuildMenu();
  return state.showDevEntries;
}

// ---------- LLM 调用记录窗口（审查用，替代原来在 cmd 窗口里打印的方式） ----------
// 普通带边框窗口，靠系统标题栏拖动，不用像宠物主窗口那样自己实现拖拽；
// 位置/大小存进 config.json 的 llmLogWinBounds 字段，下次打开时原样恢复，跨次启动也认得。
const LLM_LOG_WIN_DEFAULT = { width: 480, height: 420 };

function openLlmLogWindow() {
  if (state.llmLogWin && !state.llmLogWin.isDestroyed()) {
    state.llmLogWin.show();
    state.llmLogWin.focus();
    return;
  }
  const saved = loadConfig().llmLogWinBounds;
  withRenderPause(() => {
    state.llmLogWin = new BrowserWindow({
      width: (saved && saved.width) || LLM_LOG_WIN_DEFAULT.width,
      height: (saved && saved.height) || LLM_LOG_WIN_DEFAULT.height,
      x: saved && Number.isFinite(saved.x) ? saved.x : undefined,
      y: saved && Number.isFinite(saved.y) ? saved.y : undefined,
      title: 'LLM调用记录',
      webPreferences: securePrefs(),
    });
    // 见 openSettingsWindow 里的同名调用注释
    state.llmLogWin.webContents.setBackgroundThrottling(false);
    state.llmLogWin.setMenu(null);
    state.llmLogWin.loadURL(`http://127.0.0.1:${state.serverPort}/public/llm-log.html`);

    // 拖动 / 缩放之后各自都会触发一次保存，不用等关闭窗口那一下（万一异常退出没保存上）
    const persistBounds = () => {
      if (!state.llmLogWin || state.llmLogWin.isDestroyed()) return;
      updateConfig({ llmLogWinBounds: state.llmLogWin.getBounds() });
    };
    state.llmLogWin.on('moved', persistBounds);
    state.llmLogWin.on('resized', persistBounds);
    return state.llmLogWin;
  });
}

module.exports = {
  openSettingsWindow,
  openCharacterVoiceWindow,
  confirmCharacterVoiceSwitch,
  openOutfitsWindow,
  confirmOutfitsSwitch,
  openAssetsWindow,
  confirmAssetsSwitch,
  openHistoryWindow,
  retargetHistoryWindow,
  openAboutWindow,
  openLlmLogWindow,
  getAboutInfo,
  openRepoUrl,
  toggleDevEntries,
};
