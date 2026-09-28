// ---------------- UI：加载提示 / 气泡 / 台词语音 / 点击命中 ----------------
import * as THREE from 'three';
import { state, camera, renderer, audio, voiceAudio } from './state.js';

export function showLoading(text) {
  document.getElementById('loading-text').textContent = text;
  document.getElementById('loading').style.display = 'flex';
}

export function hideLoading() {
  document.getElementById('loading').style.display = 'none';
}

// 舞蹈音乐压低 / 恢复。原始音量记在模块级变量里：语音被下一条语音打断时（pause 不会触发 ended），
// 新语音看到的仍是"已压低的音量"，如果拿它当原始值，音乐会一直停在低音量
let duckOrigVolume = null;
function duckMusic() {
  if (duckOrigVolume === null) duckOrigVolume = audio.volume;
  audio.volume = Math.min(duckOrigVolume, 0.12);
}
function unduckMusic() {
  if (duckOrigVolume === null) return;
  audio.volume = duckOrigVolume;
  duckOrigVolume = null;
}

// 播台词 / AI 回复语音；舞蹈音乐正在放时先压低音量，语音播完恢复。
// （角色语音现在只在待机时播，待机动画本身没有音乐，所以压低音乐的分支基本不会再触发，保留作兜底）
// opts.onMetadata(duration)：拿到时长时回调（AI 回复用它把气泡延长到语音结束）；opts.onEnd：播完或出错时回调
// 角色语音只在待机时播（待机姿态 / 待机动画）：普通舞蹈、退场舞（含加载动作的间隙）期间一律不播
export function canPlayVoice() {
  return !state.exitInProgress && !(state.danceMode && !state.idleAnim);
}

export function playVoice(url, opts = {}) {
  if (!url || !canPlayVoice()) return;
  voiceAudio.pause();
  voiceAudio.onended = voiceAudio.onerror = voiceAudio.onloadedmetadata = null;
  voiceAudio.src = url;
  const ducking = !audio.paused;
  if (ducking) duckMusic();
  else unduckMusic(); // 上一条语音被打断时留下的压低状态，在这里一并恢复
  if (ducking || opts.onEnd) {
    voiceAudio.onended = voiceAudio.onerror = () => {
      unduckMusic();
      if (opts.onEnd) opts.onEnd();
    };
  }
  if (opts.onMetadata) voiceAudio.onloadedmetadata = () => opts.onMetadata(voiceAudio.duration);
  voiceAudio.play().catch(() => {});
}

// 立刻停掉当前语音（切角色 / 退场 / 开始跳舞时用），同时恢复被压低的舞蹈音乐
export function stopVoice() {
  voiceAudio.pause();
  voiceAudio.onended = voiceAudio.onerror = voiceAudio.onloadedmetadata = null;
  unduckMusic();
}

// ---------------- 气泡 ----------------
let bubbleTimer = null;
// #rrggbb -> rgba()，用于气泡阴影
function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
export function showBubble(text, ms = 3000) {
  const el = document.getElementById('bubble');
  const shadow = state.bubbleColor && hexToRgba(state.bubbleColor, 0.25);
  if (state.bubbleColor && shadow) {
    el.style.setProperty('--bubble-accent', state.bubbleColor);
    el.style.setProperty('--bubble-color', state.bubbleColor);
    el.style.setProperty('--bubble-shadow', shadow);
  } else {
    el.style.removeProperty('--bubble-accent');
    el.style.removeProperty('--bubble-color');
    el.style.removeProperty('--bubble-shadow');
  }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// ---------------- 点击命中检测 ----------------
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

// 桌面模式下 hitModel 每次 mousemove 都要跑一遍，直接对整个骨骼网格做 raycaster.intersectObject
// 全量相交测试开销很大（几万顶点的网格 + 每次移动鼠标就测一次），和跳舞动画抢主线程，
// 是桌面模式跳舞卡顿的主因。这里加一层廉价的包围球预判：射线连模型的包围球都没碰到，
// 肯定碰不到模型本体，直接短路返回，不用再做精确的网格相交测试。
// 只有鼠标已经落在包围球范围内（此时才有可能真的碰到模型），才继续做原来的精确测试，
// 命中结果和优化前完全一致，只是把"明显没碰到"的高频情况提前拦掉。
let boundsMesh = null; // 缓存的包围球所属的 mesh，用来判断是否需要重算（换角色后自动失效）
const localCenter = new THREE.Vector3(); // 包围球中心，存在模型局部坐标系里（这样模型被拖拽旋转时中心点能跟着转对，不用重算）
let localRadius = 0;
const worldCenter = new THREE.Vector3();
const sphere = new THREE.Sphere();
const sphereHit = new THREE.Vector3();

// 包围球半径按跳舞甩动的幅度留余量：frameModel() 取景时给模型高度留了 45% 余量应付舞蹈位移，
// 这里用同量级的 1.6 倍半径兜底，避免动作把手脚甩出包围球之外导致漏判（漏判的后果也只是
// 桌面模式下鼠标划过甩出去的手脚尖端时没触发穿透判断，不影响正常点击/悬停）
const BOUNDS_PADDING = 1.6;

function ensureBounds(mesh) {
  if (boundsMesh === mesh) return;
  boundsMesh = mesh;
  const box = new THREE.Box3().setFromObject(mesh);
  const worldSphere = box.getBoundingSphere(new THREE.Sphere());
  // 转成局部坐标缓存：换算一次之后，后续旋转模型不用重新扫描整个网格
  const inv = mesh.matrixWorld.clone().invert();
  localCenter.copy(worldSphere.center).applyMatrix4(inv);
  localRadius = worldSphere.radius * BOUNDS_PADDING;
}

export function hitModel(e) {
  const mesh = state.mesh;
  if (!mesh) return false;
  // 用 canvas 自身的包围盒而不是 window.innerWidth/innerHeight：
  // 普通模式下 canvas 铺满整个窗口，两者等价；桌面模式下 canvas 只占虚拟视口那一块，
  // 用窗口尺寸算出来的 NDC 会偏，模型点不中。
  const rect = renderer.domElement.getBoundingClientRect();
  ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);

  ensureBounds(mesh);
  worldCenter.copy(localCenter).applyMatrix4(mesh.matrixWorld);
  sphere.set(worldCenter, localRadius);
  if (raycaster.ray.intersectSphere(sphere, sphereHit) === null) return false; // 连包围球都没碰到，跳过精确测试

  return raycaster.intersectObject(mesh, true).length > 0;
}
