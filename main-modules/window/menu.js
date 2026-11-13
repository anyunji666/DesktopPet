// ---------- 右键菜单 ----------
// 只负责"菜单长什么样、点哪项调哪个动作"。菜单项要调的函数从 menu-actions.js 的动作表里取
// （由 index.js 装配时注入），所以这里不用 require 切角色 / 桌面模式 / 设置窗口这些领域模块。
const { app, Menu } = require('electron');
const { state } = require('../state');
const { scanDances } = require('../dance');
const { send } = require('./main-window');
const { menuActions } = require('./menu-actions');

// 特殊动作：不出现在右键菜单里。开场舞在模型加载后自动循环，退场舞在切换角色时自动播放，待机动画在点"待机"时循环
const SPECIAL_DANCE_NAMES = new Set(['Stay Tonight', '张元英转圈', '生气了亲一下就哄好了']);

function buildMenu() {
  const A = menuActions();
  // === 取数据：当前角色 + 动作池（过滤掉不进菜单的特殊动作） ===
  const current = state.characters[state.currentIndex];
  const dances = scanDances();
  // 保留在 scanDances() 结果里的原始下标 i：渲染进程按这个下标取动作，过滤特殊动作后不能重新编号
  const menuDances = dances.map((d, i) => ({ d, i })).filter(({ d }) => !SPECIAL_DANCE_NAMES.has(d.name));
  const template = [
    // === 切换场景 ===
    {
      label: '🌄 切换场景',
      submenu: [
        // 当前项用 ✓ 前缀标出（跟"声音"开关一致），不置灰；点当前项时 switchScene 内部会直接返回，不会重复切换
        {
          label: (state.currentSceneName === null ? '✓ ' : '') + '无场景（透明）',
          click: () => A.switchScene(null),
        },
        ...(state.scenes.length ? [{ type: 'separator' }] : []),
        ...state.scenes.map((s) => ({
          label: (s.name === state.currentSceneName ? '✓ ' : '') + s.label,
          click: () => A.switchScene(s.name),
        })),
        { type: 'separator' },
        {
          label: '↺ 重置位置和大小',
          enabled: state.currentSceneName !== null,
          click: () => A.resetSceneAdjust(),
        },
        { label: '🔁 读取配置文件', click: () => A.reloadScenes() },
      ],
    },
    // === 切换角色 ===
    {
      label: '🎭 切换角色',
      submenu: state.characters.map((c, i) => ({
        label: (i === state.currentIndex ? '✓ ' : '') + c.name,
        click: () => A.switchCharacter(i),
      })),
    },
    { type: 'separator' },
    // === 舞蹈展示 / 模型朝向 / 待机 ===
    {
      // 一级"舞蹈展示"，二级是全部可选动作（悬停展开，跟"切换角色"一致）；没有可选动作时置灰，避免弹出空子菜单
      label: '💃 舞蹈展示',
      enabled: menuDances.length > 0,
      submenu: menuDances.map(({ d, i }) => ({
        label: d.name,
        click: () => send('menu-action', { type: 'dance', index: i }),
      })),
    },
    { type: 'separator' },
    { label: '🔄 重置模型朝向', click: () => send('menu-action', { type: 'resetYaw' }) },
    { label: '⏸ 待机（停止跳舞）', click: () => send('menu-action', { type: 'idle' }) },
    { type: 'separator' },
    // === 设置窗口入口（全局设置 / 角色与音色 / 服饰 / 资产） ===
    {
      // 直接点开，没有二级：API / 前置文本 / 附加要求都是全局共用的
      label: '⚙ API 与全局设置',
      click: () => A.openSettingsWindow(),
    },
    {
      // 一级：角色列表；点某个角色 -> 弹出该角色的"角色与音色设置"窗口
      //（角色设定：世界背景 / 角色资料 / 别名 / 你的资料；音色设置：先选服务商，再配音色）
      label: '📝 角色与音色设置',
      submenu: state.characters.map((c) => ({ label: c.name, click: () => A.openCharacterVoiceWindow(c.name) })),
    },
    {
      // 一级：角色列表；点某个角色 -> 弹出该角色的"角色服饰配置"窗口（服饰图片 + 描述，当前穿着的那套会写进 LLM 提示词）
      label: '👗 角色服饰配置',
      submenu: state.characters.map((c) => ({ label: c.name, click: () => A.openOutfitsWindow(c.name) })),
    },
    {
      // 一级：角色列表；点某个角色 -> 弹出该角色的"角色资产配置"窗口（角色和用户两方的资产 / 负债 / 收支）
      // 资产设定会写进 LLM 提示词，影响角色的底气和行动
      label: '🧰 角色资产配置',
      submenu: state.characters.map((c) => ({ label: c.name, click: () => A.openAssetsWindow(c.name) })),
    },
    { type: 'separator' },
    // === 声音开关 ===
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
    // === 喝水提醒 ===
    {
      // 喝水提醒读 Character/<角色>/Time report/ 下的语音（没有该目录的角色不提醒），
      // 只在有语音的时间点提醒（不是每个整点都有）；开关状态记在 config.json，重启后保持
      label: '💧 喝水提醒' + (A.drinkReminderOn() ? '  ✅' : ''),
      submenu: [
        {
          label: (A.drinkReminderOn() ? '✓ ' : '') + '开启喝水提醒',
          click: () => A.setDrinkReminderEnabled(true),
        },
        { type: 'separator' },
        {
          label: (!A.drinkReminderOn() ? '✓ ' : '') + '关闭喝水提醒',
          click: () => A.setDrinkReminderEnabled(false),
        },
      ],
    },
    // === 开机自启动（仅 Windows） ===
    // 开机自启动依赖 setLoginItemSettings 的 path/args 参数精确指定启动方式，该参数仅 Windows 支持，
    // mac/linux 上这个 API 要么不生效要么只能注册裸的 electron 本身，索性不在这两个平台显示这个入口
    ...(process.platform === 'win32'
      ? [
          { type: 'separator' },
          {
            label: '🚀 开机自启动' + (A.getAutoLaunchMode() !== 'off' ? '  ✅' : ''),
            submenu: [
              {
                label: (A.getAutoLaunchMode() === 'pet' ? '✓ ' : '') + '开启程序自启动',
                click: () => A.applyAutoLaunchMode('pet'),
              },
              { type: 'separator' },
              {
                label: (A.getAutoLaunchMode() === 'off' ? '✓ ' : '') + '关闭程序自启动',
                click: () => A.applyAutoLaunchMode('off'),
              },
            ],
          },
        ]
      : []),
    { type: 'separator' },
    // === 桌面模式 / 关于 / 退出 ===
    {
      // 勾选样式跟"开机自启动"保持一致：不用原生 checkbox，靠 label 后缀 ✅ 表示当前状态。
      // 勾选＝桌面模式已开启：窗口在纵向上展开（给气泡留空间），场景/背景对鼠标点击穿透，
      // 只有角色模型本体和展开的对话框能截获点击；再点一下即退出桌面模式、恢复原样
      label: '🖥️ 桌面模式' + (!state.bgMouseInteraction ? '  ✅' : ''),
      click: () => A.toggleBgMouseInteraction(),
    },
    { type: 'separator' },
    { label: 'ℹ️ 关于', click: () => A.openAboutWindow() },
    { type: 'separator' },
    { label: '❌ 退出', click: () => app.quit() },
    // === 开发者菜单项（默认隐藏） ===
    // "LLM记录"/"开发者工具"默认隐藏，在关于窗口里连续点版本号 6 次切换显示
    ...(state.showDevEntries
      ? [
          { type: 'separator' },
          { label: '🗂 LLM记录', click: () => A.openLlmLogWindow() },
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
  // === 构建菜单 ===
  return Menu.buildFromTemplate(template);
}

module.exports = { buildMenu };
