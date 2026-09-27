import { state, clock, scene, camera, renderer, audio, voiceAudio, tmpV, desiredPos, desiredTgt, curTgt } from './modules/state.js';
import { showLoading, showBubble, playVoice, stopVoice, hitModel } from './modules/ui.js';
import { triggerBlink, idlePose, updateBlink } from './modules/idle-animation.js';
import { resettlePhysics } from './modules/physics.js';
import { loadModel, disposeModel } from './modules/model.js';
import { stopDance, playIdle, playDance, playExitThen } from './modules/dance.js';
import { applyScene, zoomSceneBy, moveSceneDepth, panSceneBy, orbitSceneBy, resetSceneAdjust } from './modules/scene.js';
import { showChatBox, hideChatBox } from './modules/chat.js';
import { initTtsPlayback } from './modules/tts.js';

// ---------------- 挂载渲染器 ----------------
const app = document.getElementById('app');
app.appendChild(renderer.domElement);

// ---------------- 虚拟视口 ----------------
// 背景鼠标互动"开"（现状）：#viewport 铺满真实窗口，跟以前完全等价。
// "关"（桌面模式）：真实窗口铺满整个屏幕、对鼠标穿透，#viewport 变成一个本地模拟的
// 小窗口，camera/renderer 的尺寸、气泡/聊天框的相对缩放都以它为准，不用区分模式。
const viewportEl = document.getElementById('viewport');
const anchorEl = document.getElementById('desktop-anchor');
const anchorMoveEl = document.getElementById('desktop-anchor-move');
const anchorResizeEl = document.getElementById('desktop-anchor-resize');
const chatBoxEl = document.getElementById('chat-box');
const hintMainEl = document.getElementById('hint-main');
// 对话气泡不再放在 #viewport 里面：桌面模式下 #viewport 是被人为缩小的模型小窗口，
// 气泡放在里面就只能按小窗口的尺寸换算，装不下多少字。挪到 body 下直接按真实窗口
// （桌面模式=铺满的整个屏幕，普通模式=当前窗口，二者一致）定位/换算，位置再用
// updateBubbleAnchor() 手动贴到模型视口的正上方，视觉效果不变，只是可用空间变大了。
const bubbleEl = document.getElementById('bubble');

const HINT_NORMAL = '点击模型互动 双击对话 长按滑动旋转 · 背景处拖拽移动 · 右键打开菜单 · 右下角缩放界面';
const HINT_DESKTOP = '点击模型互动 双击对话 长按滑动旋转 · 椭圆按钮：左移动 / 右缩放 · 右键菜单';

// 跟 main-modules/window.js 里的同名常量保持一致——虚拟视口的缩放需要同一套宽高比
// 和上下限，但渲染进程拿不到主进程的模块，只能各自维护一份，改的时候记得两边一起改
const WIN_W = 720;
const WIN_H = 540;
const WIN_MIN_W = 320;
const WIN_MAX_W = 1800;

let desktopMode = false; // 背景鼠标互动是否关闭（桌面模式）
let viewportRect = null; // 当前虚拟视口；null 只在第一次 applyViewportRect 调用前短暂存在
let deskWorkArea = { width: window.innerWidth, height: window.innerHeight }; // 桌面模式下真实窗口（=屏幕工作区）大小，拖拽视口时用来夹住范围
let lastIgnoreMouse = null; // 上一次发给主进程的"是否穿透"状态，只在变化时才发 IPC

function fullWindowRect() {
  return { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
}

// 气泡贴到模型视口正上方、水平居中——效果跟以前"气泡在 #viewport 里 left:50%"一样，
// 只是气泡现在挂在 body 下面，视口挪动/缩放时改用坐标手动算，而不是靠 CSS 百分比。
// 普通模式：只设 top，钉住顶边、内容多了往下长——窗口本身就是角色的显示区域，头顶上方
// 没有多余空间，只能这么长（长文本会盖到角色身上，但没有更好的选择）。
// 桌面模式：真实窗口远大于角色可视区域，头顶上方有一大块空白没用上，所以反过来只设
// bottom，钉住底边（跟气泡下面指向角色的小三角箭头对齐），内容多了往上长，长文本往
// 桌面空白区域扩，不会压到角色。两种模式互斥设置 top/bottom，用完清空另一个，避免
// 残留上一次模式的定位属性把气泡钉在两头都动不了。
function updateBubbleAnchor() {
  if (!viewportRect) return;
  bubbleEl.style.left = viewportRect.x + viewportRect.width / 2 + 'px';
  if (desktopMode) {
    // 清空用 'auto' 而不是 ''：CSS 里 #bubble 默认写了 top: 8px，清成空字符串只是去掉内联样式，
    // 会退回样式表的默认值，导致 top/bottom 同时生效，把气泡从顶边硬拉伸到这里，
    // 内容再少也会被撑成一个大空盒子（而不是按内容自适应高度）——必须显式设成 auto 才能真正清空
    bubbleEl.style.top = 'auto';
    bubbleEl.style.bottom = window.innerHeight - viewportRect.y - 8 + 'px';
  } else {
    bubbleEl.style.bottom = 'auto';
    bubbleEl.style.top = viewportRect.y + 8 + 'px';
  }
}

// 应用一份视口几何：更新 #viewport 的实际像素位置/大小，并让 camera/renderer/气泡缩放
// 变量跟着走。普通模式和桌面模式共用这一个函数，不用各写一套
function applyViewportRect(rect) {
  const sizeChanged = !viewportRect || rect.width !== viewportRect.width || rect.height !== viewportRect.height;
  viewportRect = rect;
  viewportEl.style.left = rect.x + 'px';
  viewportEl.style.top = rect.y + 'px';
  updateBubbleAnchor(); // 纯移动视口（拖拽椭圆按钮左半）也要跟着贴过去，不等宽高变化
  if (!sizeChanged) return; // 纯移动位置：宽高没变，不用重设 camera/renderer（省一次 canvas 重建）
  viewportEl.style.width = rect.width + 'px';
  viewportEl.style.height = rect.height + 'px';
  camera.aspect = rect.width / rect.height;
  camera.updateProjectionMatrix();
  renderer.setSize(rect.width, rect.height);
  // --vp-w：供 CSS 把气泡等 UI 的字号/内边距按视口宽度换算，而不是写死像素
  // （气泡的 max-width/max-height 不用这个变量，已经改成按真实窗口尺寸的百分比算，
  // 详见 index.html 里 #bubble 的注释）
  document.documentElement.style.setProperty('--vp-w', rect.width);
}
applyViewportRect(fullWindowRect());

function enterDesktopModeUI(viewport, workArea) {
  desktopMode = true;
  deskWorkArea = workArea || { width: window.innerWidth, height: window.innerHeight };
  document.body.classList.add('desktop-mode');
  hintMainEl.textContent = HINT_DESKTOP;
  applyViewportRect(viewport);
  lastIgnoreMouse = true; // 主进程那边进入桌面模式时已经开了穿透，这里对齐一下缓存，避免重复发送
}

function exitDesktopModeUI() {
  desktopMode = false;
  document.body.classList.remove('desktop-mode');
  hintMainEl.textContent = HINT_NORMAL;
  applyViewportRect(fullWindowRect());
  lastIgnoreMouse = false;
}

window.petAPI.onEnterDesktopMode((data) => enterDesktopModeUI(data.viewport, data.workArea));
window.petAPI.onExitDesktopMode(() => exitDesktopModeUI());

// 桌面模式下新开子窗口（聊天记录/设置等）时，主进程会通知这边暂停渲染循环，
// 让出 GPU/合成资源给新窗口的首次绘制，加载完/超时兜底后主进程会再通知恢复
let animPaused = false;
window.petAPI.onPauseRender(() => { animPaused = true; });
window.petAPI.onResumeRender(() => { animPaused = false; });

// 悬停检测结果变化时才通知主进程切换点击穿透，不用每帧都发 IPC
function setClickThrough(ignore) {
  if (lastIgnoreMouse === ignore) return;
  lastIgnoreMouse = ignore;
  window.petAPI.setClickThrough(ignore);
}

function isOverAnchorButton(e) {
  if (anchorEl.style.display === 'none' || getComputedStyle(anchorEl).display === 'none') return false;
  const r = anchorEl.getBoundingClientRect();
  return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
}

function isOverChatBox(e) {
  if (!chatBoxEl.classList.contains('show')) return false;
  const r = chatBoxEl.getBoundingClientRect();
  return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
}

// 桌面模式下每次 mousemove 都判断一次"鼠标是否在可交互区域"（模型 / 椭圆按钮 /
// 对话框，只有鼠标真的落在对话框范围内才算），决定窗口这一刻要不要对鼠标穿透。
// 拖拽/旋转/调整视口进行中不重新判断，强制保持"不穿透"，避免鼠标划得快时中途漏判、手势被打断
// mousemove 在鼠标划得快时一帧内可能触发好几次；"强制不穿透"这条分支很便宜（不带射线检测），
// 同步执行不节流，保证拖拽/旋转过程中穿透状态切换没有延迟。真正开销大的是命中模型那条分支
// （hitModel 里的射线检测），这部分节流成每帧最多算一次，同一帧内的多次调用只更新坐标、
// 复用下一帧的一次计算结果——桌面模式跳舞卡顿主要就是这里每次 mousemove 都全量算一遍导致的。
let pendingHoverEvent = null;
let hoverRafId = null;
function scheduleHoverHitCheck(e) {
  pendingHoverEvent = e;
  if (hoverRafId !== null) return; // 已经排了一次，本帧内的后续调用不用重复排
  hoverRafId = requestAnimationFrame(() => {
    hoverRafId = null;
    const ev = pendingHoverEvent;
    // rAF 触发前状态可能已经变了（比如开始拖拽），这种情况交回同步分支处理，这里跳过即可
    if (!desktopMode || rotating || movingViewport || resizingViewport) return;
    const over = isOverChatBox(ev) || isOverAnchorButton(ev) || hitModel(ev);
    setClickThrough(!over);
  });
}

function updateClickThroughByHover(e) {
  if (!desktopMode) return;
  if (rotating || movingViewport || resizingViewport) {
    setClickThrough(false); // 便宜分支，同步执行
    return;
  }
  scheduleHoverHitCheck(e); // 命中检测分支，节流到每帧一次
}

// ---------------- 交互：拖拽 / 点击 / 右键 ----------------
let dragging = false; // 拖拽空白处：移动窗口（仅普通模式）
let rotating = false; // 拖拽模型：左右滑动旋转
let resizing = false; // 拖拽右下角手柄：等比缩放窗口（仅普通模式）
let panning = false; // Shift + 拖拽：移动场景背景（仅普通模式）
let orbiting = false; // Ctrl + 拖拽：绕角色旋转场景背景（仅普通模式）
let movingViewport = false; // 桌面模式：拖拽椭圆按钮左半，移动虚拟视口
let resizingViewport = false; // 桌面模式：拖拽椭圆按钮右半，缩放虚拟视口
let moved = 0;
let lastX = 0;
let lastY = 0;
let downOnModel = false;
let resizeStartX = 0;
let viewportDragStart = { clientX: 0, clientY: 0, x: 0, y: 0, width: 0 }; // movingViewport/resizingViewport 共用的起始快照

// 模型左右旋转每帧最多转动的弧度（约 3°）。拖拽和程序化重置（右键菜单/回待机）共用同一限速，
// 避免瞬间跳变把头发/裙摆的物理甩飞、错位——原理见 physics.js 里骨骼姿态瞬间跳变的那段注释，
// 这里是同一个问题的另一个诱因：整体旋转瞬间跳变。
const YAW_MAX_STEP = 0.05;

// 右下角缩放手柄
document.getElementById('resize-handle').addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  e.stopPropagation();
  resizing = true;
  resizeStartX = e.screenX;
  window.petAPI.resizeBegin();
});
// 手柄上禁用右键菜单，避免误触
document.getElementById('resize-handle').addEventListener('contextmenu', (e) => e.stopPropagation());

// 椭圆按钮（仅桌面模式）：左半拖拽移动虚拟视口，右半拖拽缩放。
// stopPropagation 避免这次按下又被 document 上的通用 mousedown 监听器当成模型旋转/背景拖拽处理。
// 右键不拦截（不 stopPropagation），冒泡上去正常弹出右键菜单
anchorMoveEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  e.stopPropagation();
  movingViewport = true;
  viewportDragStart = { clientX: e.clientX, clientY: e.clientY, x: viewportRect.x, y: viewportRect.y, width: viewportRect.width };
});
anchorResizeEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  e.stopPropagation();
  resizingViewport = true;
  viewportDragStart = { clientX: e.clientX, clientY: e.clientY, x: viewportRect.x, y: viewportRect.y, width: viewportRect.width };
});

document.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  moved = 0;
  lastX = e.screenX;
  lastY = e.screenY;
  if (desktopMode) {
    // 桌面模式下背景本身对鼠标穿透，正常情况下这里只会收到模型上的按下事件
    // （椭圆按钮有自己独立的监听器并 stopPropagation，走不到这里）；
    // 空白拖窗口、Shift/Ctrl 背景手势在桌面模式下整体失效
    downOnModel = hitModel(e);
    if (downOnModel) rotating = true;
    return;
  }
  if (e.shiftKey && state.sceneGroup) {
    // 按住 Shift：不管点在哪里都是拖背景，不会移动窗口或旋转模型
    panning = true;
    downOnModel = false;
    return;
  }
  if (e.ctrlKey && state.sceneGroup) {
    // 按住 Ctrl：绕角色旋转背景，同样不管点在哪里，不会移动窗口或旋转角色模型
    orbiting = true;
    downOnModel = false;
    return;
  }
  downOnModel = hitModel(e);
  if (downOnModel) {
    rotating = true;
  } else {
    dragging = true;
  }
});

document.addEventListener('mousemove', (e) => {
  // 悬停检测独立于下面这堆拖拽状态机，任何时候都要跑一遍（非桌面模式下直接空转返回）
  updateClickThroughByHover(e);

  // 窗口很小且透明无边框，拖得快时鼠标很容易滑出窗口边界，
  // 这种情况下 document 收不到后续的 mousemove/mouseup，下面几个状态位会一直卡在 true。
  // 用 e.buttons 兜底：左键其实已经松开了，就当成漏掉的 mouseup 处理掉，
  // 不然等鼠标再挪回窗口（哪怕只是悬停，没按键）还会拿旧坐标继续转/拖，
  // 表现为服饰头发突然被甩飞、或者"重置模型朝向"刚点完又被莫名转歪。
  if ((dragging || rotating || panning || orbiting || resizing || movingViewport || resizingViewport) && !(e.buttons & 1)) {
    dragging = false;
    rotating = false;
    panning = false;
    orbiting = false;
    resizing = false;
    movingViewport = false;
    resizingViewport = false;
    return;
  }
  if (movingViewport) {
    // 拖拽椭圆按钮左半：移动虚拟视口，本地直接改 #viewport 的位置，不走 IPC；
    // 夹在屏幕工作区范围内，避免被拖到看不见的地方找不回来
    const dx = e.clientX - viewportDragStart.clientX;
    const dy = e.clientY - viewportDragStart.clientY;
    const maxX = Math.max(0, deskWorkArea.width - viewportRect.width);
    const maxY = Math.max(0, deskWorkArea.height - viewportRect.height);
    const x = Math.max(0, Math.min(maxX, viewportDragStart.x + dx));
    const y = Math.max(0, Math.min(maxY, viewportDragStart.y + dy));
    applyViewportRect({ x, y, width: viewportRect.width, height: viewportRect.height });
    return;
  }
  if (resizingViewport) {
    // 拖拽椭圆按钮右半：缩放虚拟视口，左上角不动，宽高比固定，跟右下角手柄的算法一致
    const dx = e.clientX - viewportDragStart.clientX;
    const w = Math.max(WIN_MIN_W, Math.min(WIN_MAX_W, viewportDragStart.width + dx));
    const h = Math.round((w * WIN_H) / WIN_W);
    applyViewportRect({ x: viewportRect.x, y: viewportRect.y, width: w, height: h });
    return;
  }
  if (resizing) {
    // 等比缩放：只上报水平位移，尺寸和宽高比由主进程计算
    window.petAPI.resizeBy(e.screenX - resizeStartX);
    return;
  }
  if (panning) {
    const px = e.screenX - lastX;
    const py = e.screenY - lastY;
    lastX = e.screenX;
    lastY = e.screenY;
    panSceneBy(px, py);
    return;
  }
  if (orbiting) {
    const px = e.screenX - lastX;
    lastX = e.screenX;
    lastY = e.screenY;
    orbitSceneBy(px);
    return;
  }
  if (!dragging && !rotating) return;
  const dx = e.screenX - lastX;
  const dy = e.screenY - lastY;
  moved += Math.abs(dx) + Math.abs(dy);
  lastX = e.screenX;
  lastY = e.screenY;
  if (rotating) {
    // 左右滑动：转动模型。单帧转动角度限速，避免鼠标猛地一划导致模型瞬间
    // 转过一大截角度，把头发/裙摆的物理甩飞、错位
    const dyaw = Math.max(-YAW_MAX_STEP, Math.min(YAW_MAX_STEP, dx * 0.01));
    state.modelYaw += dyaw;
    state.modelYawTarget = state.modelYaw; // 手动拖拽时目标值跟手，不触发/干扰下面动画回正的插值
    if (state.mesh) state.mesh.rotation.y = state.modelYaw;
  } else {
    window.petAPI.move(dx, dy);
  }
});

document.addEventListener('mouseup', (e) => {
  if (movingViewport) {
    movingViewport = false;
    window.petAPI.saveDesktopViewport(viewportRect);
    return;
  }
  if (resizingViewport) {
    resizingViewport = false;
    window.petAPI.saveDesktopViewport(viewportRect);
    return;
  }
  if (resizing) {
    resizing = false;
    return;
  }
  if (panning) {
    panning = false;
    return;
  }
  if (orbiting) {
    orbiting = false;
    return;
  }
  if (!dragging && !rotating) return;
  dragging = false;
  rotating = false;
  // 开场舞循环期间也允许点击出对话气泡，其他舞蹈中不响应。
  // e.detail === 1 才是"单独一次点击"；双击时这里会先后收到 detail 1、2 两次 mouseup，
  // detail 2（双击的第二下）交给下面的 dblclick 处理，这里跳过，避免连续弹两条随机台词
  if (moved < 6 && downOnModel && (!state.danceMode || state.entranceMode) && e.detail === 1) {
    if (state.quotes.length) {
      const i = Math.floor(Math.random() * state.quotes.length);
      showBubble(state.quotes[i]);
      playVoice(state.voices[i]);
    }
    triggerBlink(); // 互动时眨个眼
  }
});

document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.petAPI.showMenu();
});

document.addEventListener('dblclick', (e) => {
  if (!hitModel(e)) return;
  // 与单击气泡的保护逻辑保持一致：跳舞时不响应双击，开场舞循环期间除外
  if (state.danceMode && !state.entranceMode) return;
  e.preventDefault();
  showChatBox();
});

// 聊天记录窗口发起的对话回复，也在这边头顶显示一下
window.petAPI.onShowBubble((text) => showBubble(text, 5000));
window.petAPI.onBootTimerBubble((text) => showBubble(text, 16000));
// AI 回复的语音合成好了：播放，并把气泡延长到语音结束
initTtsPlayback();

// ---------------- 滚轮：Shift 缩放背景 / Ctrl 前后移动背景 ----------------
// 只有按住修饰键才响应，单独滚轮不做任何事，避免误操作
document.addEventListener(
  'wheel',
  (e) => {
    if (e.ctrlKey) e.preventDefault(); // 阻止 Chromium 自带的 Ctrl+滚轮页面缩放
    if (desktopMode) return; // 桌面模式下背景手势整体失效
    if (!state.sceneGroup || !(e.shiftKey || e.ctrlKey)) return;
    e.preventDefault();
    // Shift+滚轮在 Windows / Linux 上会被换算成水平滚动，增量落在 deltaX 里
    let raw = e.deltaY || e.deltaX;
    if (e.deltaMode === 1) raw *= 33; // 按"行"计的增量换算成像素
    const delta = Math.max(-300, Math.min(300, raw));
    if (!delta) return;
    if (e.shiftKey) zoomSceneBy(delta);
    else moveSceneDepth(delta);
  },
  { passive: false }
);

// ---------------- 菜单动作 ----------------
window.petAPI.onAction((action) => {
  // 退场舞播放中忽略待机/切舞指令，避免打断角色切换流程
  if (action.type === 'idle') {
    if (!state.exitInProgress) {
      playIdle();
      // 待机顺带重置朝向，不用再多点一次"重置模型朝向"；
      // 只改目标值，animate() 里限速插值转正，避免瞬间跳变甩飞裙摆/头发
      state.modelYawTarget = 0;
    }
  }
  else if (action.type === 'dance') { if (!state.exitInProgress) playDance(action.index); }
  else if (action.type === 'mute') {
    audio.muted = !audio.muted;
    voiceAudio.muted = audio.muted;
  }
  else if (action.type === 'resetYaw') {
    // 防御性清一下拖拽状态：万一是在旋转过程中点的菜单，避免残留的
    // rotating 状态被下一次杂散 mousemove 用旧坐标又转回去，导致刚重置就又被转歪
    rotating = false;
    dragging = false;
    // 只改目标值，animate() 里限速插值转正，避免瞬间跳变甩飞裙摆/头发
    state.modelYawTarget = 0;
  }
});

// ---------------- 初始化数据 ----------------
window.petAPI.onInit((data) => {
  state.dances = data.dances || [];
  state.quotes = data.quotes || [];
  state.voices = data.voices || [];
  state.bubbleColor = data.bubbleColor || null;
  state.characterName = data.characterName || null;
  state.ignoreBones = new Set(data.ignoreBones || []);
  state.materialFixes = data.materialFixes || null;
  applyScene(data.scene || null);
  if (data.bgMouseInteraction === false) {
    enterDesktopModeUI(data.desktopViewport || fullWindowRect());
  }
  loadModel(data.model, { playEntrance: false, onReady: () => window.petAPI.notifyModelReady() });
});

// ---------------- 切换角色 ----------------
window.petAPI.onSwitchCharacter((data) => {
  // 先播退场舞（用切换前的旧 dances 查找），播完再换成新角色
  playExitThen(() => {
    state.dances = data.dances || [];
    state.quotes = data.quotes || [];
    state.voices = data.voices || [];
    state.bubbleColor = data.bubbleColor || null;
    state.characterName = data.characterName || null;
    state.ignoreBones = new Set(data.ignoreBones || []);
    state.materialFixes = data.materialFixes || null;
    hideChatBox(); // 切角色时把可能开着的对话输入框收起来
    stopVoice(); // 停掉旧角色还没播完的语音（同时恢复被压低的舞蹈音乐）
    disposeModel();
    showLoading('正在切换角色：' + (data.characterName || '') + ' …');
    loadModel(data.model);
  });
});

// ---------------- 切换场景 ----------------
window.petAPI.onSwitchScene((payload) => applyScene(payload));

// 菜单里的"重置当前场景的位置和大小"
window.petAPI.onSceneAdjust((adj) => {
  resetSceneAdjust(adj);
  showBubble('背景的位置和大小已重置');
});

// ---------------- 渲染循环 ----------------
window.addEventListener('resize', () => {
  // 桌面模式下真实窗口铺满屏幕、之后基本不会再变，虚拟视口的尺寸变化都是拖拽椭圆按钮
  // 触发的本地 applyViewportRect，不需要也不应该跟着真实窗口的 resize 事件走
  if (desktopMode) return;
  applyViewportRect(fullWindowRect());
});

function animate() {
  if (animPaused) {
    // 暂停期间不再 requestAnimationFrame（那样 GPU 渲染工作并没有真的让出去），
    // 改用低频轮询等恢复信号，占用可以忽略不计
    setTimeout(animate, 200);
    return;
  }
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  const t = clock.elapsedTime;
  // 舞蹈时长已到：在渲染最顶层回待机，重置姿态后再走待机流程
  if (state.danceMode && t >= state.danceEndAt) {
    const cb = state.danceEndCallback;
    stopDance();
    if (cb) cb(); // 退场舞播完 → 执行真正的角色切换
    else playIdle(); // 普通舞播完 → 回待机动画
  }
  if (state.danceMode && state.helper) {
    // 开场那一小段（见 dance.js 的 PHYSICS_ENGAGE_DELAY）播完了，物理该接管裙摆了：
    // 先按"这段时间里骨骼已经转到的姿态"重新 resettle 一次物理（清零虚假速度），
    // 再重新打开物理模拟，让它顺势接上，而不是从转向一开始就被拽着硬转
    if (state.physicsEnableAt !== null && t >= state.physicsEnableAt) {
      state.physicsEnableAt = null;
      const physicsObj = state.mesh ? state.helper.objects.get(state.mesh).physics : null;
      resettlePhysics(physicsObj);
      state.helper.enable('physics', true);
    }
    // 循环动作（开场舞/待机）在这一帧会不会跨过循环点，先记一下当前时间
    const la = state.loopingAction;
    const prevT = la ? la.time : null;
    state.helper.update(dt);
    // MMDAnimationHelper 内部在跨循环点时已经默认对 physics 做了一次 reset，
    // 这里检测到跨点后再补几步 warmup，让头发/裙摆更快落位，减少循环衔接处的残留甩动
    if (la && prevT !== null && la.time < prevT) {
      const physicsObj = state.mesh ? state.helper.objects.get(state.mesh).physics : null;
      resettlePhysics(physicsObj, 4);
    }
  } else if (state.mesh) {
    idlePose(t);
  }
  updateBlink(t);
  // 朝向限速回正：程序化重置（右键菜单/回待机）只改 modelYawTarget，这里每帧最多转 YAW_MAX_STEP
  // 靠近目标值，和拖拽用同一套限速，避免瞬间跳变把裙摆/头发的物理甩飞、错位
  if (state.mesh && state.modelYaw !== state.modelYawTarget) {
    const diff = state.modelYawTarget - state.modelYaw;
    const step = Math.max(-YAW_MAX_STEP, Math.min(YAW_MAX_STEP, diff));
    state.modelYaw += step;
    state.mesh.rotation.y = state.modelYaw;
  }
  // 摄像机：跳舞时跟随舞台位移；待机时以模型为中心环绕
  if (state.camBase) {
    let targetOffX = 0;
    let targetOffZ = 0;
    const follow = state.danceMode
      ? state.danceFollow || (state.followBone ? { bone: state.followBone, x: state.followBase.x, z: state.followBase.z } : null)
      : null;
    if (follow) {
      follow.bone.getWorldPosition(tmpV);
      // 慢速滑动平均（约 4 秒时间常数）：舞蹈的原地晃动被滤掉，镜头只跟整体漂移，
      // 像 シンデレラ 这种在有界区域内来回跳的舞，背景就不会看起来像地面在滑
      const sk = Math.min(1, dt * 0.25);
      state.followSmooth.x += (tmpV.x - state.followSmooth.x) * sk;
      state.followSmooth.z += (tmpV.z - state.followSmooth.z) * sk;
      targetOffX = state.followSmooth.x - follow.x;
      targetOffZ = state.followSmooth.z - follow.z;
    }
    // 跟随目标已经过 followSmooth 低通滤波（原地晃动不会传到这里），直接平滑趋近即可；
    // 待机时 targetOff 为 0，同一公式自然归位，不留残留偏移
    const k = Math.min(1, dt * 3);
    state.followCur.x += (targetOffX - state.followCur.x) * k;
    state.followCur.z += (targetOffZ - state.followCur.z) * k;
    state.danceZoomCur += ((state.danceMode ? state.danceZoom : 0) - state.danceZoomCur) * Math.min(1, dt * 1.5);

    desiredPos.set(state.camBase.pos.x + state.followCur.x, state.camBase.pos.y, state.camBase.pos.z + state.followCur.z + state.danceZoomCur);
    desiredTgt.set(state.camBase.target.x + state.followCur.x, state.camBase.target.y, state.camBase.target.z + state.followCur.z);
    camera.position.lerp(desiredPos, k);
    curTgt.lerp(desiredTgt, k);
    camera.lookAt(curTgt);
  }
  renderer.render(scene, camera);
}
animate();
