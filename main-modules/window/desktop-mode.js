// ---------- 桌面模式（背景鼠标互动开关）----------
// 桌面模式 = 普通模式的界面 + 纵向多出的一圈空白（供气泡显示）+ 背景点击穿透。
// 模型显示区域（渲染进程里的 #viewport，下称"视口"）的位置/大小永远等于普通模式下
// 真实窗口的位置/大小，不单独保存、不单独调整；想改位置/大小就先退出桌面模式，
// 在普通模式里拖动/缩放，再进入桌面模式即自动同步。
//
// 真实窗口只在纵向展开：宽度和水平位置与普通窗口完全一致（气泡的换行宽度因此跟普通模式
// 一样），纵向范围取"屏幕工作区"与"普通窗口"的并集——并集保证普通窗口哪怕有一部分
// 拖到了工作区外面（或比工作区还高），视口也不会被桌面窗口裁掉。
// 视口 = 普通窗口相对桌面窗口左上角的坐标。
const { ipcMain, screen } = require('electron');
const { state } = require('../state');
const { updateConfig } = require('../config');
const { WIN_W, WIN_H, send } = require('./main-window');
const { rebuildMenu } = require('./menu-actions');

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
    rebuildMenu();
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
    rebuildMenu();
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

module.exports = { computeDesktopLayout, enterDesktopMode, exitDesktopMode, toggleBgMouseInteraction };
