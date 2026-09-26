// ---------------- 待机 / 眨眼 ----------------
import { state, clock } from './state.js';

// 待机姿态骨骼 & 眨眼：只在本模块内部读写，外部需要触发/清空时走
// triggerBlink() / resetIdle()，不直接碰这几个变量。
const idleBones = {}; // name -> { bone, base }
const IDLE_BONE_NAMES = ['センター', '上半身', '首', '頭'];
let blinkMorphIndex = -1;
let nextBlinkAt = 2;
let blinkStart = -1;

export function setupIdle() {
  const mesh = state.mesh;
  for (const name of IDLE_BONE_NAMES) {
    const bone = mesh.skeleton ? mesh.skeleton.bones.find((b) => b.name === name) : mesh.getObjectByName(name);
    if (bone) idleBones[name] = { bone, base: bone.rotation.clone() };
  }
  const dict = mesh.morphTargetDictionary || {};
  for (const key of Object.keys(dict)) {
    if (key === 'まばたき') blinkMorphIndex = dict[key];
  }
  // 记录全身骨骼的初始（绑定）姿态；resetPose（dance.js）跳舞结束后要用它还原
  if (mesh.skeleton) {
    state.basePose = mesh.skeleton.bones.map((b) => ({
      b,
      p: b.position.clone(),
      q: b.quaternion.clone(),
      s: b.scale.clone(),
    }));
    // 用于摄像机跟随的根骨骼
    state.followBone =
      mesh.skeleton.bones.find((b) => b.name === '全ての親') ||
      mesh.skeleton.bones.find((b) => b.name === 'センター') ||
      null;
  }
}

export function idlePose(t) {
  for (const name of Object.keys(idleBones)) {
    const { bone, base } = idleBones[name];
    bone.rotation.set(base.x, base.y, base.z);
  }
  const center = idleBones['センター'];
  const upper = idleBones['上半身'];
  const head = idleBones['頭'];
  if (center) center.bone.rotation.y += Math.sin(t * 0.6) * 0.04;
  if (upper) {
    upper.bone.rotation.x += Math.sin(t * 1.1) * 0.018; // 呼吸
    upper.bone.rotation.z += Math.sin(t * 0.7) * 0.012;
  }
  if (head) head.bone.rotation.y += Math.sin(t * 0.33) * 0.07;
}

export function updateBlink(t) {
  const mesh = state.mesh;
  if (blinkMorphIndex < 0 || !mesh) return;
  if (blinkStart < 0 && t >= nextBlinkAt) {
    blinkStart = t;
  }
  if (blinkStart >= 0) {
    const p = (t - blinkStart) / 0.22; // 眨眼时长
    if (p >= 1) {
      mesh.morphTargetInfluences[blinkMorphIndex] = 0;
      blinkStart = -1;
      nextBlinkAt = t + 2 + Math.random() * 3.5;
    } else {
      mesh.morphTargetInfluences[blinkMorphIndex] = Math.sin(p * Math.PI);
    }
  }
}

// 互动（点击模型出气泡）时提前触发一次眨眼；供 ui.js 的点击处理调用
export function triggerBlink() {
  blinkStart = clock.elapsedTime;
}

// 切换角色前（model.js 的 disposeModel）清空待机骨骼与眨眼状态，避免残留数据串到新角色身上
export function resetIdle() {
  for (const key of Object.keys(idleBones)) delete idleBones[key];
  blinkMorphIndex = -1;
  nextBlinkAt = 2;
  blinkStart = -1;
}
