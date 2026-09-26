// ---------------- UI：加载提示 / 气泡 / 台词语音 / 点击命中 ----------------
import * as THREE from 'three';
import { state, camera, audio, voiceAudio } from './state.js';

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

// 播台词 / AI 回复语音；舞蹈音乐正在放时先压低音量，语音播完恢复（开场舞循环期间点角色说话也能听清）。
// opts.onMetadata(duration)：拿到时长时回调（AI 回复用它把气泡延长到语音结束）；opts.onEnd：播完或出错时回调
export function playVoice(url, opts = {}) {
  if (!url) return;
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

// 立刻停掉当前语音（切角色时用），同时恢复被压低的舞蹈音乐
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

export function hitModel(e) {
  ndc.x = (e.clientX / window.innerWidth) * 2 - 1;
  ndc.y = -(e.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  return state.mesh ? raycaster.intersectObject(state.mesh, true).length > 0 : false;
}
