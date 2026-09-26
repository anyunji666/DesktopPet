// ---------- 窗口管理：主窗口消息下发 / 设置窗口 & 聊天记录窗口 / 右键菜单 / 角色与场景切换 ----------
const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const path = require('path');
const { state } = require('./state');
const { loadConfig, updateConfig } = require('./config');
const { loadQuotes, loadVoices, loadIgnoreBones, loadMaterialFixes } = require('./character');
const { scanDances } = require('./dance');
const { scanScenes, getAdjust, setAdjust, ADJUST_DEFAULT } = require('./scene');
const { cancelSpeaking } = require('./tts');
const pkg = require('../package.json');

const ROOT = path.join(__dirname, '..');

// ---------- 关于：作者 / 版本 / GitHub 地址，读 package.json 里的 author / homepage，只在这里维护一份 ----------
const APP_VERSION_LABEL = `${pkg.version} 测试版`;
const APP_REPO_URL = pkg.homepage || '';

function showAboutDialog() {
  dialog
    .showMessageBox(state.win, {
      type: 'info',
      title: '关于',
      message: pkg.description || pkg.name,
      detail: [`作者：${pkg.author || '未知'}`, `版本：${APP_VERSION_LABEL}`, APP_REPO_URL ? `GitHub：${APP_REPO_URL}` : null]
        .filter(Boolean)
        .join('\n'),
      buttons: APP_REPO_URL ? ['打开 GitHub', '确定'] : ['确定'],
      defaultId: APP_REPO_URL ? 1 : 0,
      cancelId: APP_REPO_URL ? 1 : 0,
      noLink: true,
    })
    .then(({ response }) => {
      if (APP_REPO_URL && response === 0) shell.openExternal(APP_REPO_URL);
    });
}

// 窗口初始尺寸；右下角缩放手柄始终按这个宽高比缩放（由主进程计算，
// 不依赖页面自己的 innerWidth/innerHeight，避免 DevTools 停靠等情况把比例带偏）
const WIN_W = 720;
const WIN_H = 540;
const WIN_MIN_W = 320;
const WIN_MAX_W = 1800;

// ---------- API 设置窗口 / 聊天记录窗口（独立普通窗口，跟"开发者工具"一样 detach） ----------
function openSettingsWindow() {
  if (state.settingsWin && !state.settingsWin.isDestroyed()) {
    state.settingsWin.show();
    state.settingsWin.focus();
    return;
  }
  state.settingsWin = new BrowserWindow({
    width: 420,
    height: 540,
    resizable: false,
    title: 'API 设置',
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true },
  });
  state.settingsWin.setMenu(null);
  state.settingsWin.loadURL(`http://127.0.0.1:${state.serverPort}/public/settings.html`);
}

function openHistoryWindow(characterName) {
  if (state.historyWin && !state.historyWin.isDestroyed()) state.historyWin.close();
  state.historyWinCharacter = characterName;
  state.historyWin = new BrowserWindow({
    width: 420,
    height: 560,
    title: '聊天记录 - ' + characterName,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true },
  });
  state.historyWin.setMenu(null);
  state.historyWin.loadURL(`http://127.0.0.1:${state.serverPort}/public/history.html?character=${encodeURIComponent(characterName)}`);
}

// 音色设置窗口：每次只开一个，点另一个角色就换成那个角色的
function openVoiceWindow(characterName) {
  if (state.voiceWin && !state.voiceWin.isDestroyed()) state.voiceWin.close();
  state.voiceWin = new BrowserWindow({
    width: 440,
    height: 700,
    title: '音色设置 - ' + characterName,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true },
  });
  state.voiceWin.setMenu(null);
  state.voiceWin.loadURL(`http://127.0.0.1:${state.serverPort}/public/voice-settings.html?character=${encodeURIComponent(characterName)}`);
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
  state.llmLogWin = new BrowserWindow({
    width: (saved && saved.width) || LLM_LOG_WIN_DEFAULT.width,
    height: (saved && saved.height) || LLM_LOG_WIN_DEFAULT.height,
    x: saved && Number.isFinite(saved.x) ? saved.x : undefined,
    y: saved && Number.isFinite(saved.y) ? saved.y : undefined,
    title: 'LLM调用记录',
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true },
  });
  state.llmLogWin.setMenu(null);
  state.llmLogWin.loadURL(`http://127.0.0.1:${state.serverPort}/public/llm-log.html`);

  // 拖动 / 缩放之后各自都会触发一次保存，不用等关闭窗口那一下（万一异常退出没保存上）
  const persistBounds = () => {
    if (!state.llmLogWin || state.llmLogWin.isDestroyed()) return;
    updateConfig({ llmLogWinBounds: state.llmLogWin.getBounds() });
  };
  state.llmLogWin.on('moved', persistBounds);
  state.llmLogWin.on('resized', persistBounds);
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
    bubbleColor: q.color,
    ignoreBones: loadIgnoreBones(c.name),
    materialFixes: loadMaterialFixes(c.name),
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
const AUTOLAUNCH_CONFIGS = {
  pet: () => ({ path: winSystemExe('wscript.exe'), args: [path.join(ROOT, '启动宠物.vbs')] }),
};

// 依次用每种配置各自的 path/args 去查，因为 getLoginItemSettings() 不传参数时只会拿"默认可执行文件"
// （即 electron.exe 本身）去比对，查不到我们自己注册的 wscript/cmd 组合，必须传完全一致的 path/args 才准确
function getAutoLaunchMode() {
  for (const mode of Object.keys(AUTOLAUNCH_CONFIGS)) {
    if (app.getLoginItemSettings(AUTOLAUNCH_CONFIGS[mode]()).openAtLogin) return mode;
  }
  return 'off';
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
    { label: '🔄 重置模型朝向', click: () => send('menu-action', { type: 'resetYaw' }) },
    { label: '⏸ 待机（停止跳舞）', click: () => send('menu-action', { type: 'idle' }) },
    { type: 'separator' },
    ...dances
      .map((d, i) => ({ d, i }))
      .filter(({ d }) => !SPECIAL_DANCE_NAMES.has(d.name))
      .map(({ d, i }) => ({
        label: '💃 ' + d.name,
        click: () => send('menu-action', { type: 'dance', index: i }),
      })),
    { type: 'separator' },
    { label: '🔊 静音 / 取消静音', click: () => send('menu-action', { type: 'mute' }) },
    { type: 'separator' },
    { label: '⚙ API 设置（对话功能）', click: () => openSettingsWindow() },
    {
      // 一级：角色列表；点某个角色 -> 弹出该角色的语音配置窗口（先选服务商，再配音色）
      label: '🎙 音色设置（语音功能）',
      submenu: state.characters.map((c) => ({ label: c.name, click: () => openVoiceWindow(c.name) })),
    },
    { type: 'separator' },
    // 开机自启动依赖 setLoginItemSettings 的 path/args 参数精确指定启动方式，该参数仅 Windows 支持，
    // mac/linux 上这个 API 要么不生效要么只能注册裸的 electron 本身，索性不在这两个平台显示这个入口
    ...(process.platform === 'win32'
      ? [
          {
            label: '🚀 开机自启动' + (getAutoLaunchMode() !== 'off' ? '  ✅' : ''),
            submenu: [
              {
                label: (getAutoLaunchMode() === 'pet' ? '✓ ' : '') + '宠物自启动',
                click: () => applyAutoLaunchMode('pet'),
              },
              { type: 'separator' },
              {
                label: (getAutoLaunchMode() === 'off' ? '✓ ' : '') + '关闭开机自启动',
                click: () => applyAutoLaunchMode('off'),
              },
            ],
          },
          { type: 'separator' },
        ]
      : []),
    { label: 'ℹ️ 关于', click: () => showAboutDialog() },
    { type: 'separator' },
    { label: '❌ 退出', click: () => app.quit() },
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
  ];
  return Menu.buildFromTemplate(template);
}

function switchCharacter(index) {
  if (index === state.currentIndex || !state.characters[index]) return;
  state.currentIndex = index;
  updateConfig({ lastCharacter: state.characters[state.currentIndex].name });
  state.menu = buildMenu();
  cancelSpeaking(); // 旧角色还在合成的语音作废，不然会用旧角色的声音说话
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

module.exports = {
  WIN_W,
  WIN_H,
  WIN_MIN_W,
  WIN_MAX_W,
  openSettingsWindow,
  openHistoryWindow,
  openVoiceWindow,
  openLlmLogWindow,
  send,
  currentCharacterPayload,
  currentScene,
  buildMenu,
  switchCharacter,
  switchScene,
  resetSceneAdjust,
  reloadScenes,
};
