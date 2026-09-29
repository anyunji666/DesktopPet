// ---------- 桌面模式：拖动/缩放子窗口期间，临时关掉宠物窗口的"穿透 + 鼠标转发" ----------
// 现象：桌面模式下宠物主窗口纵向铺开（供气泡显示）且常驻开着 setIgnoreMouseEvents(true, { forward: true })，
// 此时拖动聊天记录/设置等子窗口经过宠物窗口的范围，整块区域会来回闪烁（普通模式没有这个开关，不闪）。
// 推断原因：开着 forward 时系统一直在监听并转发整个窗口范围内的鼠标消息，跟 Windows 拖动窗口的
// 模态循环抢同一个线程。所以子窗口拖动期间把 forward 关掉，拖完再恢复。
//
// 时序：子窗口 will-move / will-resize（手动拖动/缩放时持续触发）-> beginChildDrag；
// moved / resized（拖完触发一次）-> endChildDrag。再加一个超时兜底，万一结束事件没来，
// 宠物窗口也不会一直保持"关转发"。
// 拖动期间渲染进程上报的"是否穿透"不直接生效，只记下最新值，拖完按最新值恢复，
// 所以拖完鼠标正好停在模型上时，模型能立刻点，不用先移出去再移进来。
const { state } = require('./state');

// 兜底：最后一次 will-move/will-resize 之后这么久没有新事件，就当拖动结束。
// 取 1.5 秒而不是更短，是因为按住鼠标不动的那一会儿也不会有新事件，太短会在拖动中途恢复转发
const END_FALLBACK_MS = 1500;
let endTimer = null;

const petAlive = () => !!state.win && !state.win.isDestroyed();

function beginChildDrag() {
  if (state.bgMouseInteraction !== false || !petAlive()) return; // 只有桌面模式才有这个问题
  if (!state.childDragging) {
    state.childDragging = true;
    state.win.setIgnoreMouseEvents(true); // 仍然穿透，但不带 forward：停掉鼠标转发
  }
  clearTimeout(endTimer);
  endTimer = setTimeout(endChildDrag, END_FALLBACK_MS);
}

function endChildDrag() {
  clearTimeout(endTimer);
  endTimer = null;
  if (!state.childDragging) return;
  state.childDragging = false;
  // 拖动期间可能已经退出了桌面模式 / 宠物窗口被关，这时不能再去动穿透状态
  if (state.bgMouseInteraction !== false || !petAlive()) return;
  state.win.setIgnoreMouseEvents(!!state.clickThroughIgnore, { forward: true });
}

// 渲染进程上报"是否穿透"（hover 命中检测结果变化时）。拖动期间只记录，不生效
function requestClickThrough(ignore) {
  if (!petAlive() || state.bgMouseInteraction) return;
  state.clickThroughIgnore = !!ignore;
  if (state.childDragging) return;
  state.win.setIgnoreMouseEvents(!!ignore, { forward: true });
}

// 给一个子窗口挂上拖动/缩放的开始、结束监听
function attachDragGuard(win) {
  win.on('will-move', beginChildDrag);
  win.on('will-resize', beginChildDrag);
  win.on('moved', endChildDrag);
  win.on('resized', endChildDrag);
  win.once('closed', endChildDrag);
}

module.exports = { attachDragGuard, requestClickThrough, beginChildDrag, endChildDrag };
