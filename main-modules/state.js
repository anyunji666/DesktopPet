// ---------- 主进程运行时共享状态 ----------
// 主窗口 / 设置窗口 / 聊天记录窗口，以及当前角色/场景的选择，都是跨模块（window.js 的窗口管理
// 和 main.js 的 IPC 处理）共用的可变状态，收拢在这一个对象里，避免散落成一堆模块级全局变量。
const state = {
  win: null, // 主宠物窗口
  menu: null, // 右键菜单（buildMenu 生成，随角色/场景切换重建）
  characters: [], // scanCharacters() 结果
  currentIndex: 0, // 当前角色在 characters 里的下标
  scenes: [], // scanScenes() 结果
  currentSceneName: null, // null = 无场景（保持透明背景）
  serverPort: null, // 本地静态服务器端口，设置窗口/历史记录窗口也用它加载页面
  settingsWin: null, // API 设置窗口
  historyWin: null, // 聊天记录窗口
  historyWinCharacter: null, // 聊天记录窗口当前打开的角色名
  voiceWin: null, // 音色设置（语音功能）窗口
  llmLogWin: null, // LLM 调用记录窗口（审查用，替代原来 cmd 窗口里打印的方式）
  aboutWin: null, // 关于窗口（连续点版本号 6 次可切换下面的 showDevEntries）
  showDevEntries: false, // 右键菜单里是否显示"LLM记录"/"开发者工具"；默认隐藏，启动时从 config.json 恢复
  resizeStartW: 0, // 缩放手柄按下时的窗口宽度（window-resize-begin/by 之间传递）

  // ---- 背景鼠标互动开关（桌面模式）----
  bgMouseInteraction: true, // true=现状（背景可拖拽/手势）；false=桌面模式（点击穿透，只有模型和展开的对话框可交互）
  normalWinBounds: null, // 进入桌面模式前，真实窗口的位置/大小，退出时原样恢复
};

module.exports = { state };
