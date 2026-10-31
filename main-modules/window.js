// ---------- 窗口管理：主窗口消息下发 / 设置窗口 & 聊天记录窗口 / 右键菜单 / 角色与场景切换 ----------
const { app, BrowserWindow, Menu, shell, screen, ipcMain } = require('electron');
const path = require('path');
const { state } = require('./state');
const { loadConfig, updateConfig } = require('./config');
const { loadQuotes, loadVoices, loadDrinkReminders, loadMaterialFixes, loadLights, loadPhysicsTweaks } = require('./character');
const { scanDances } = require('./dance');
const { scanScenes, getAdjust, setAdjust, ADJUST_DEFAULT } = require('./scene');
const { cancelSpeaking } = require('./tts');
const { attachDragGuard } = require('./drag-guard');
const pkg = require('../package.json');

const ROOT = path.join(__dirname, '..');

// 所有窗口共用的 webPreferences：
//   sandbox        —— 渲染进程沙箱化（preload 只用了 contextBridge / ipcRenderer，沙箱下可用）
//   nodeIntegration—— 页面里绝不能直接用 Node
//   webviewTag     —— 用不到 <webview>，关掉
function securePrefs() {
  return {
    preload: path.join(ROOT, 'preload.js'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
  };
}

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

// 窗口初始尺寸；右下角缩放手柄始终按这个宽高比缩放（由主进程计算，
// 不依赖页面自己的 innerWidth/innerHeight，避免 DevTools 停靠等情况把比例带偏）
const WIN_W = 720;
const WIN_H = 540;
const WIN_MIN_W = 320;
const WIN_MAX_W = 1800;

// ---------- API 与全局设置窗口 / 角色与音色设置窗口 / 聊天记录窗口（独立普通窗口，跟"开发者工具"一样 detach） ----------
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
      width: 420,
      height: 540,
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
      width: 440,
      height: 720,
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
      minWidth: 480,
      minHeight: 520,
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
      width: 420,
      height: 560,
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
  state.menu = buildMenu();
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

function send(channel, payload) {
  if (state.win && !state.win.isDestroyed()) state.win.webContents.send(channel, payload);
}

function currentCharacterPayload() {
  const c = state.characters[state.currentIndex];
  const q = loadQuotes(c.name);
  return {
    model: c.model,
    dances: scanDances(),
    characterName: c.name,
    quotes: q.lines,
    voices: loadVoices(c.name, q.lines),
    drinkReminders: loadDrinkReminders(c.name),
    drinkReminderEnabled: loadConfig().drinkReminderEnabled !== false,
    bubbleColor: q.color,
    materialFixes: loadMaterialFixes(c.name),
    lights: loadLights(c.name),
    physicsTweaks: loadPhysicsTweaks(c.name),
  };
}

// 发给渲染进程的场景数据 = 扫描结果 + 用户手动调整
function currentScene() {
  const s = state.scenes.find((x) => x.name === state.currentSceneName);
  return s ? { ...s, adjust: getAdjust(s.name) } : null;
}

// 特殊动作：不出现在右键菜单里。开场舞在模型加载后自动循环，退场舞在切换角色时自动播放，待机动画在点"待机"时循环
const SPECIAL_DANCE_NAMES = new Set(['Stay Tonight', '张元英转圈', '生气了亲一下就哄好了']);

// ---------- 开机自启动（仅 Windows）----------
// 坑点：开发模式下（没打包成 exe，靠 electron . 跑）如果直接 setLoginItemSettings({ openAtLogin: true })
// 不指定 path/args，Windows 实际注册的是 node_modules\electron\dist\electron.exe 本身、且不带任何参数，
// 开机后 Electron 找不到要加载的项目，只会弹出它自带的默认欢迎页（而不是宠物）。
// 这里改成用子菜单（跟"切换角色"一样悬停即可选）让用户明确选择走哪个入口文件，并显式传入 path + args，
// 从根源上避免这个问题。path 用 System32 下的绝对路径，避免极少数环境 PATH 异常导致注册的命令找不到程序。
function winSystemExe(exeName) {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', exeName);
}

// 登录项配置，'off' 不对应具体 path/args，只用于表示"未设置"。
// 原来还有个 'console' 模式（用 cmd.exe 包一层 .bat 静默启动，能看到控制台里打印的来往记录），
// 现在来往记录已经改走独立的"LLM调用记录"窗口，不用再靠控制台看了，去掉这个入口。
// 'autostart' 参数让 启动宠物.vbs 先等几秒再启动：开机刚进桌面时磁盘 / CPU / 显卡都在抢资源，
// 太早启动偶尔会卡在加载界面；手动双击 vbs 不带参数，不会延迟
const AUTOLAUNCH_CONFIGS = {
  pet: () => ({ path: winSystemExe('wscript.exe'), args: [path.join(ROOT, '启动宠物.vbs'), 'autostart'] }),
};
// 旧版本注册的登录项（不带 autostart 参数）：仍认作"已开启"，并在启动时迁移成新写法
const LEGACY_AUTOLAUNCH_PET = () => ({ path: winSystemExe('wscript.exe'), args: [path.join(ROOT, '启动宠物.vbs')] });

// 依次用每种配置各自的 path/args 去查，因为 getLoginItemSettings() 不传参数时只会拿"默认可执行文件"
// （即 electron.exe 本身）去比对，查不到我们自己注册的 wscript/cmd 组合，必须传完全一致的 path/args 才准确
function getAutoLaunchMode() {
  for (const mode of Object.keys(AUTOLAUNCH_CONFIGS)) {
    if (app.getLoginItemSettings(AUTOLAUNCH_CONFIGS[mode]()).openAtLogin) return mode;
  }
  if (process.platform === 'win32' && app.getLoginItemSettings(LEGACY_AUTOLAUNCH_PET()).openAtLogin) return 'pet';
  return 'off';
}

// 程序启动时调用：把旧写法的登录项升级成带延迟参数的新写法（同一个注册表项，直接覆盖）；已经是新写法 / 没开自启动则什么也不做
function migrateAutoLaunch() {
  if (process.platform !== 'win32') return;
  try {
    const isNew = app.getLoginItemSettings(AUTOLAUNCH_CONFIGS.pet()).openAtLogin;
    if (!isNew && app.getLoginItemSettings(LEGACY_AUTOLAUNCH_PET()).openAtLogin) {
      app.setLoginItemSettings({ openAtLogin: true, ...AUTOLAUNCH_CONFIGS.pet() });
    }
  } catch (err) {
    console.warn('[pet] 自启动项迁移失败:', err.message);
  }
}

function applyAutoLaunchMode(mode) {
  if (getAutoLaunchMode() === mode) return; // 已经是这个模式，重复点一下不用重新写注册表
  if (mode === 'off') {
    app.setLoginItemSettings({ openAtLogin: false });
  } else if (AUTOLAUNCH_CONFIGS[mode]) {
    app.setLoginItemSettings({ openAtLogin: true, ...AUTOLAUNCH_CONFIGS[mode]() });
  }
  state.menu = buildMenu(); // 重建菜单，让 ✓ 标记跟着切换到刚选的这一项
}

function buildMenu() {
  const current = state.characters[state.currentIndex];
  const dances = scanDances();
  const template = [
    {
      label: '🌄 切换场景',
      submenu: [
        {
          label: (state.currentSceneName === null ? '✓ ' : '') + '无场景（透明）',
          enabled: state.currentSceneName !== null,
          click: () => switchScene(null),
        },
        ...(state.scenes.length ? [{ type: 'separator' }] : []),
        ...state.scenes.map((s) => ({
          label: (s.name === state.currentSceneName ? '✓ ' : '') + s.label,
          enabled: s.name !== state.currentSceneName,
          click: () => switchScene(s.name),
        })),
        { type: 'separator' },
        {
          label: '↺ 重置当前场景的位置和大小',
          enabled: state.currentSceneName !== null,
          click: () => resetSceneAdjust(),
        },
        { label: '🔁 重新扫描场景（改完 scene.json 后用）', click: () => reloadScenes() },
      ],
    },
    {
      label: '🎭 切换角色',
      submenu: state.characters.map((c, i) => ({
        label: (i === state.currentIndex ? '✓ ' : '') + c.name,
        enabled: i !== state.currentIndex,
        click: () => switchCharacter(i),
      })),
    },
    { type: 'separator' },
    ...dances
      .map((d, i) => ({ d, i }))
      .filter(({ d }) => !SPECIAL_DANCE_NAMES.has(d.name))
      .map(({ d, i }) => ({
        label: '💃 ' + d.name,
        click: () => send('menu-action', { type: 'dance', index: i }),
      })),
    { type: 'separator' },
    { label: '🔄 重置模型朝向', click: () => send('menu-action', { type: 'resetYaw' }) },
    { label: '⏸ 待机（停止跳舞）', click: () => send('menu-action', { type: 'idle' }) },
    { type: 'separator' },
    {
      // 直接点开，没有二级：API / 前置文本 / 附加要求都是全局共用的
      label: '⚙ API 与全局设置',
      click: () => openSettingsWindow(),
    },
    {
      // 一级：角色列表；点某个角色 -> 弹出该角色的"角色与音色设置"窗口
      //（角色设定：世界背景 / 角色资料 / 别名 / 你的资料；音色设置：先选服务商，再配音色）
      label: '📝 角色与音色设置',
      submenu: state.characters.map((c) => ({ label: c.name, click: () => openCharacterVoiceWindow(c.name) })),
    },
    {
      // 一级：角色列表；点某个角色 -> 弹出该角色的"角色资产配置"窗口（角色和用户两方的资产 / 负债 / 收支）
      // 资产设定会写进 LLM 提示词，影响角色的底气和行动
      label: '🧰 角色资产配置',
      submenu: state.characters.map((c) => ({ label: c.name, click: () => openAssetsWindow(c.name) })),
    },
    { type: 'separator' },
    // 父菜单按当前状态后缀 ✅，两个子选项用 ✓ 前缀标出当前选择；声音 / 喝水提醒 / 开机自启动各自独立一格
    {
      // 声音开关（舞蹈音乐 + 角色语音一起静音/恢复）。实际开关在渲染进程，这里发 setMute 让它应用，
      // 它应用完再通过 mute-changed 上报回来更新 state.muted（菜单据此显示勾选）
      label: '🔊 声音' + (!state.muted ? '  ✅' : ''),
      submenu: [
        {
          label: (!state.muted ? '✓ ' : '') + '开启声音',
          click: () => send('menu-action', { type: 'setMute', muted: false }),
        },
        { type: 'separator' },
        {
          label: (state.muted ? '✓ ' : '') + '关闭声音',
          click: () => send('menu-action', { type: 'setMute', muted: true }),
        },
      ],
    },
    { type: 'separator' },
    {
      // 喝水提醒读 Character/<角色>/Time report/ 下的语音（没有该目录的角色不提醒），
      // 只在有语音的时间点提醒（不是每个整点都有）；开关状态记在 config.json，重启后保持
      label: '💧 喝水提醒' + (drinkReminderOn() ? '  ✅' : ''),
      submenu: [
        {
          label: (drinkReminderOn() ? '✓ ' : '') + '开启喝水提醒',
          click: () => setDrinkReminderEnabled(true),
        },
        { type: 'separator' },
        {
          label: (!drinkReminderOn() ? '✓ ' : '') + '关闭喝水提醒',
          click: () => setDrinkReminderEnabled(false),
        },
      ],
    },
    // 开机自启动依赖 setLoginItemSettings 的 path/args 参数精确指定启动方式，该参数仅 Windows 支持，
    // mac/linux 上这个 API 要么不生效要么只能注册裸的 electron 本身，索性不在这两个平台显示这个入口
    ...(process.platform === 'win32'
      ? [
          { type: 'separator' },
          {
            label: '🚀 开机自启动' + (getAutoLaunchMode() !== 'off' ? '  ✅' : ''),
            submenu: [
              {
                label: (getAutoLaunchMode() === 'pet' ? '✓ ' : '') + '开启程序自启动',
                click: () => applyAutoLaunchMode('pet'),
              },
              { type: 'separator' },
              {
                label: (getAutoLaunchMode() === 'off' ? '✓ ' : '') + '关闭程序自启动',
                click: () => applyAutoLaunchMode('off'),
              },
            ],
          },
        ]
      : []),
    { type: 'separator' },
    {
      // 勾选样式跟"开机自启动"保持一致：不用原生 checkbox，靠 label 后缀 ✅ 表示当前状态。
      // 勾选＝桌面模式已开启：窗口在纵向上展开（给气泡留空间），场景/背景对鼠标点击穿透，
      // 只有角色模型本体和展开的对话框能截获点击；再点一下即退出桌面模式、恢复原样
      label: '🖥️ 桌面模式' + (!state.bgMouseInteraction ? '  ✅' : ''),
      click: () => toggleBgMouseInteraction(),
    },
    { type: 'separator' },
    { label: 'ℹ️ 关于', click: () => openAboutWindow() },
    { type: 'separator' },
    { label: '❌ 退出', click: () => app.quit() },
    // "LLM记录"/"开发者工具"默认隐藏，在关于窗口里连续点版本号 6 次切换显示
    ...(state.showDevEntries
      ? [
          { type: 'separator' },
          { label: '🗂 LLM记录', click: () => openLlmLogWindow() },
          {
            label: '🔧 开发者工具',
            click: () => {
              // 必须独立成单独窗口：停靠在宠物窗口里会把页面区域挤成一条窄带，导致缩放/取景全部错乱
              const wc = state.win.webContents;
              if (wc.isDevToolsOpened()) wc.closeDevTools();
              else wc.openDevTools({ mode: 'detach' });
            },
          },
        ]
      : []),
  ];
  return Menu.buildFromTemplate(template);
}

function switchCharacter(index) {
  if (index === state.currentIndex || !state.characters[index]) return;
  state.currentIndex = index;
  updateConfig({ lastCharacter: state.characters[state.currentIndex].name });
  state.menu = buildMenu();
  cancelSpeaking(); // 旧角色还在合成的语音作废，不然会用旧角色的声音说话
  retargetHistoryWindow(state.characters[index].name); // 已打开的聊天记录窗口跟着换成新角色
  send('switch-character', currentCharacterPayload());
}

// name 为 null 表示切回"无场景"
function switchScene(name) {
  const target = name === null ? null : state.scenes.find((s) => s.name === name);
  if (name !== null && !target) return;
  if ((target ? target.name : null) === state.currentSceneName) return;
  state.currentSceneName = target ? target.name : null;
  updateConfig({ lastScene: state.currentSceneName });
  state.menu = buildMenu();
  send('switch-scene', target);
}

function resetSceneAdjust() {
  if (state.currentSceneName === null) return;
  setAdjust(state.currentSceneName, { ...ADJUST_DEFAULT });
  send('scene-adjust', { ...ADJUST_DEFAULT });
}

// 重新扫描 Scene 目录并重新载入当前场景：调 scene.json 参数时不用重启程序
function reloadScenes() {
  const before = state.currentSceneName;
  state.scenes = scanScenes();
  if (state.currentSceneName && !state.scenes.some((s) => s.name === state.currentSceneName)) {
    state.currentSceneName = null;
    updateConfig({ lastScene: null });
  }
  state.menu = buildMenu();
  if (before || state.currentSceneName) send('switch-scene', currentScene());
}

// ---------- 背景鼠标互动开关（桌面模式）----------
// 桌面模式 = 普通模式的界面 + 纵向多出的一圈空白（供气泡显示）+ 背景点击穿透。
// 模型显示区域（渲染进程里的 #viewport，下称"视口"）的位置/大小永远等于普通模式下
// 真实窗口的位置/大小，不单独保存、不单独调整；想改位置/大小就先退出桌面模式，
// 在普通模式里拖动/缩放，再进入桌面模式即自动同步。
//
// 真实窗口只在纵向展开：宽度和水平位置与普通窗口完全一致（气泡的换行宽度因此跟普通模式
// 一样），纵向范围取"屏幕工作区"与"普通窗口"的并集——并集保证普通窗口哪怕有一部分
// 拖到了工作区外面（或比工作区还高），视口也不会被桌面窗口裁掉。
// 视口 = 普通窗口相对桌面窗口左上角的坐标。
//
// 主窗口创建（启动即桌面模式）和运行中切换进入共用这一个函数，保证两条路径算出的布局一致。
// normalBounds 必须带 x/y/width/height。
function computeDesktopLayout(normalBounds) {
  const wa = screen.getDisplayMatching(normalBounds).workArea;
  const top = Math.min(wa.y, normalBounds.y);
  const bottom = Math.max(wa.y + wa.height, normalBounds.y + normalBounds.height);
  return {
    bounds: { x: normalBounds.x, y: top, width: normalBounds.width, height: bottom - top },
    viewport: { x: 0, y: normalBounds.y - top, width: normalBounds.width, height: normalBounds.height },
  };
}

// 进出桌面模式时，窗口几何（setBounds）和渲染进程里的视口（IPC 下发）是两个进程、两步操作，
// 中间总有一小段"窗口已变、视口还是旧的"的空档，模型会被画在错误的位置上（闪一下）。
// 所以改窗口前先让渲染进程把画面盖住（隐藏视口和气泡）并回一个确认，再改窗口几何、
// 下发新视口，渲染进程应用完新视口后才重新显示。确认迟迟不来（渲染进程卡住 / 页面未加载）时
// 超时兜底，直接往下走，不会让切换卡死。
const DESKTOP_COVER_TIMEOUT_MS = 250;

function withRendererCovered(apply) {
  const wc = state.win.webContents;
  let done = false;
  let timer = null;
  const go = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    ipcMain.removeListener('desktop-transition-ready', onReady);
    try {
      if (state.win && !state.win.isDestroyed()) apply();
    } finally {
      state.desktopTransitioning = false;
    }
  };
  const onReady = (e) => {
    if (e.sender === wc) go();
  };
  state.desktopTransitioning = true;
  ipcMain.on('desktop-transition-ready', onReady);
  timer = setTimeout(go, DESKTOP_COVER_TIMEOUT_MS);
  send('desktop-transition-begin');
}

function enterDesktopMode() {
  if (!state.win || state.win.isDestroyed() || !state.bgMouseInteraction || state.desktopTransitioning) return;
  withRendererCovered(() => {
    const bounds = state.win.getBounds();
    state.normalWinBounds = bounds; // 记住切换前的真实窗口位置/大小，供退出时恢复
    const layout = computeDesktopLayout(bounds);

    state.bgMouseInteraction = false;
    updateConfig({ bgMouseInteraction: false });
    state.win.setBounds(layout.bounds);
    state.clickThroughIgnore = true; // 进入时整窗穿透，渲染进程那边的缓存也是这个值
    state.win.setIgnoreMouseEvents(true, { forward: true });
    state.menu = buildMenu();
    send('enter-desktop-mode', { viewport: layout.viewport });
  });
}

function exitDesktopMode() {
  if (!state.win || state.win.isDestroyed() || state.bgMouseInteraction || state.desktopTransitioning) return;
  withRendererCovered(() => {
    state.bgMouseInteraction = true;
    updateConfig({ bgMouseInteraction: true });
    state.win.setIgnoreMouseEvents(false);
    const target = state.normalWinBounds || { width: WIN_W, height: WIN_H };
    state.win.setBounds(target);
    state.menu = buildMenu();
    // 视口直接用目标窗口的宽高下发，不让渲染进程去读 window.innerHeight：
    // 窗口刚缩小时那个值可能还是桌面模式下的旧高度
    send('exit-desktop-mode', { viewport: { x: 0, y: 0, width: target.width, height: target.height } });
  });
}

function toggleBgMouseInteraction() {
  if (state.desktopTransitioning) return;
  if (state.bgMouseInteraction) enterDesktopMode();
  else exitDesktopMode();
}

// ---------- 喝水提醒开关 ----------
function drinkReminderOn() {
  return loadConfig().drinkReminderEnabled !== false;
}

function setDrinkReminderEnabled(enabled) {
  updateConfig({ drinkReminderEnabled: !!enabled });
  state.menu = buildMenu();
  send('drink-reminder-enabled', !!enabled);
}

// ---------- 声音开关状态 ----------
// 静音/恢复的实际开关在渲染进程（audio.muted / voiceAudio.muted），它应用后通过 mute-changed 上报回来，
// 主进程记在 state.muted，右键菜单"声音"据此显示 ✅ / ✓。
// 这条 IPC 的监听在 main.js 里注册，不能在本文件顶层注册：本文件加载时 guardIpc（IPC 来源校验）还没装上，
// 在这里注册会绕过"只接受本地页面调用"的检查

module.exports = {
  securePrefs,
  WIN_W,
  WIN_H,
  WIN_MIN_W,
  WIN_MAX_W,
  computeDesktopLayout,
  enterDesktopMode,
  exitDesktopMode,
  toggleBgMouseInteraction,
  openSettingsWindow,
  openCharacterVoiceWindow,
  confirmCharacterVoiceSwitch,
  openAssetsWindow,
  confirmAssetsSwitch,
  openHistoryWindow,
  openLlmLogWindow,
  openAboutWindow,
  getAboutInfo,
  openRepoUrl,
  toggleDevEntries,
  send,
  currentCharacterPayload,
  currentScene,
  buildMenu,
  switchCharacter,
  switchScene,
  resetSceneAdjust,
  reloadScenes,
  getAutoLaunchMode,
  migrateAutoLaunch,
};
