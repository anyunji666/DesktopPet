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

// ---------------- 交互：拖拽 / 点击 / 右键 ----------------
let dragging = false; // 拖拽空白处：移动窗口
let rotating = false; // 拖拽模型：左右滑动旋转
let resizing = false; // 拖拽右下角手柄：等比缩放窗口
let panning = false; // Shift + 拖拽：移动场景背景
let orbiting = false; // Ctrl + 拖拽：绕角色旋转场景背景
let moved = 0;
let lastX = 0;
let lastY = 0;
let downOnModel = false;
let resizeStartX = 0;

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

document.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  moved = 0;
  lastX = e.screenX;
  lastY = e.screenY;
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
  // 窗口很小且透明无边框，拖得快时鼠标很容易滑出窗口边界，
  // 这种情况下 document 收不到后续的 mousemove/mouseup，下面几个状态位会一直卡在 true。
  // 用 e.buttons 兜底：左键其实已经松开了，就当成漏掉的 mouseup 处理掉，
  // 不然等鼠标再挪回窗口（哪怕只是悬停，没按键）还会拿旧坐标继续转/拖，
  // 表现为服饰头发突然被甩飞、或者"重置模型朝向"刚点完又被莫名转歪。
  if ((dragging || rotating || panning || orbiting || resizing) && !(e.buttons & 1)) {
    dragging = false;
    rotating = false;
    panning = false;
    orbiting = false;
    resizing = false;
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
// AI 回复的语音合成好了：播放，并把气泡延长到语音结束
initTtsPlayback();

// ---------------- 滚轮：Shift 缩放背景 / Ctrl 前后移动背景 ----------------
// 只有按住修饰键才响应，单独滚轮不做任何事，避免误操作
document.addEventListener(
  'wheel',
  (e) => {
    if (e.ctrlKey) e.preventDefault(); // 阻止 Chromium 自带的 Ctrl+滚轮页面缩放
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
  loadModel(data.model, { playEntrance: false });
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
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function animate() {
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
