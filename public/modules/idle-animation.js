// ---------------- 待机 / 眨眼 ----------------
import * as THREE from 'three';
import { state, clock } from './state.js';

// 待机姿态骨骼 & 眨眼：只在本模块内部读写，外部需要触发/清空时走
// triggerBlink() / resetIdle()，不直接碰这几个变量。
const idleBones = {}; // name -> { bone, base }
const IDLE_BONE_NAMES = ['センター', '上半身', '首', '頭'];
// 待机时把两条上臂略微向外展开，避免手臂贴着身体、手直接穿进裙摆/外套下摆。
// ARM_ABDUCT 单位是弧度（0.26 ≈ 15°），穿模还在就调大、手臂显得僵硬就调小，0 = 关闭。
// 两种待机都生效：程序化待机（idlePose）直接改骨骼；待机动画（VMD）在动画算完之后叠加
// 一个额外旋转（applyIdleArms / restoreIdleArms），只在待机动画期间生效，其他舞蹈不受影响。
const ARM_ABDUCT = 0.26;
const ARM_PAIRS = [
  { arm: '左腕', elbow: '左ひじ', outward: 1 }, // 左臂在模型 +X 侧
  { arm: '右腕', elbow: '右ひじ', outward: -1 },
];
const armAbduct = []; // { bone, base, sign }
const armApplied = []; // 待机动画期间已叠加外展的骨骼：{ bone, saved }，saved = 叠加前的动画姿态
// 尾巴抬高（可选，默认关闭）：把「尾巴起始点」那根骨骼绕 X 轴转一点，整条尾巴绕屁股根抬起来。
// 尾巴穿地的正解是 physics.json 的 ground（尾巴与 y=0 的地面碰撞，垂到地面就停住，动作也自然），
// 这里只在"想让尾巴整体离开地面、不接触地面"时用。
// 单位弧度（0.12 ≈ 7°），0 = 关闭；尾巴尖还擦地就调大，翘得太高就调小。
const TAIL_LIFT = 0;
let tailLift = null; // { bone, base, sign }：尾巴根骨骼、它的原始旋转、抬升方向
const tailApplied = []; // 待机动画期间已叠加抬升的骨骼：{ bone, saved }
// 切入待机动画时外展角度从 0 平滑渐入到 ARM_ABDUCT，避免手臂突然"弹"开。
// applyIdleArms 每帧调用；距上次调用超过 ARM_FADE_GAP 秒，说明是新一轮切入（或暂停后恢复），重新渐入。
const ARM_FADE_IN = 0.5; // 渐入时长（秒）
const ARM_FADE_GAP = 0.25;
let armFade = 0; // 0~1 的线性进度
let armLastAt = -1;
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const armOffsetQ = new THREE.Quaternion();
let blinkMorphIndex = -1;
let nextBlinkAt = 2;
let blinkStart = -1;

// 试着给上臂加一点 Z 旋转，看手肘有没有离身体更远，据此确定"向外"该是正号还是负号
// （不同模型的骨骼朝向可能不一样，不写死符号）。试完立刻还原。
function pickAbductSign(mesh, arm, elbow, outward) {
  const a = new THREE.Vector3();
  const e = new THREE.Vector3();
  const reach = () => {
    mesh.updateMatrixWorld(true);
    arm.getWorldPosition(a);
    elbow.getWorldPosition(e);
    mesh.worldToLocal(a);
    mesh.worldToLocal(e);
    return (e.x - a.x) * outward;
  };
  const baseZ = arm.rotation.z;
  const before = reach();
  arm.rotation.z = baseZ + 0.1;
  const after = reach();
  arm.rotation.z = baseZ;
  mesh.updateMatrixWorld(true);
  return after >= before ? 1 : -1;
}

// 找出尾巴骨骼链的起始点（父骨骼不再是尾巴的那一根，也就是长在屁股上的那一根）和末梢，
// 先试着绕 X 轴转一点，看哪个方向能把尾巴尖抬起来——不同模型的骨骼朝向不一致，
// 写死符号会在某些模型上把尾巴扎进地里。试完立刻还原，只记下方向，不留下姿态改动。
// 骨骼名不是 tail / 尾 开头的模型直接跳过。
function setupTailLift(mesh) {
  tailLift = null;
  if (!TAIL_LIFT || !mesh.skeleton) return;
  const bones = mesh.skeleton.bones;
  const isTail = (b) => /^(tail|尾)/i.test(b.name);
  const tails = bones.filter(isTail);
  if (!tails.length) return;
  const root = tails.find((b) => !(b.parent && isTail(b.parent)));
  const tip = tails.find((b) => !(b.children || []).some(isTail));
  if (!root || !tip) return;
  const v = new THREE.Vector3();
  const tipY = () => {
    mesh.updateMatrixWorld(true);
    return tip.getWorldPosition(v).y;
  };
  const base = root.rotation.clone();
  const before = tipY();
  root.rotation.x = base.x + 0.1;
  const after = tipY();
  root.rotation.copy(base);
  mesh.updateMatrixWorld(true);
  tailLift = { bone: root, base, sign: after >= before ? 1 : -1 };
  console.log(`[pet] 尾巴抬升：${root.name} ${tailLift.sign > 0 ? '+' : '-'}${TAIL_LIFT} rad（绕尾巴起始点抬整条尾巴）`);
}

export function setupIdle() {
  const mesh = state.mesh;
  for (const name of IDLE_BONE_NAMES) {
    const bone = mesh.skeleton ? mesh.skeleton.bones.find((b) => b.name === name) : mesh.getObjectByName(name);
    if (bone) idleBones[name] = { bone, base: bone.rotation.clone() };
  }
  if (ARM_ABDUCT && mesh.skeleton) {
    for (const { arm, elbow, outward } of ARM_PAIRS) {
      const armBone = mesh.skeleton.bones.find((b) => b.name === arm);
      const elbowBone = mesh.skeleton.bones.find((b) => b.name === elbow);
      if (!armBone || !elbowBone) continue; // 骨骼名不是日文标准名的模型直接跳过
      armAbduct.push({
        bone: armBone,
        base: armBone.rotation.clone(),
        sign: pickAbductSign(mesh, armBone, elbowBone, outward),
      });
    }
  }
  const dict = mesh.morphTargetDictionary || {};
  for (const key of Object.keys(dict)) {
    if (key === 'まばたき') blinkMorphIndex = dict[key];
  }
  setupTailLift(mesh); // 只探测抬升方向，不改绑定姿态（物理按绑定姿态算 boneOffset，改了会打架）
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
  for (const { bone, base, sign } of armAbduct) {
    bone.rotation.set(base.x, base.y, base.z + sign * ARM_ABDUCT);
  }
  applyTailLift();
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

// 待机动画：helper.update() 算完动画后调用，在上臂当前姿态上再叠加一个向外的旋转
// （绕父骨骼的 Z 轴，所以不管动画把手臂摆成什么样，都是"整条手臂往外推开"）
export function applyIdleArms() {
  armApplied.length = 0; // 上一次的记录作废（可能是上一个动作遗留的）
  if (!ARM_ABDUCT) return;
  const now = clock.elapsedTime;
  if (armLastAt < 0 || now - armLastAt > ARM_FADE_GAP) armFade = 0; // 新一轮切入：从 0 开始渐入
  else armFade = Math.min(1, armFade + (now - armLastAt) / ARM_FADE_IN);
  armLastAt = now;
  const ease = armFade * armFade * (3 - 2 * armFade); // smoothstep，起止都柔和
  for (const { bone, sign } of armAbduct) {
    armApplied.push({ bone, saved: bone.quaternion.clone() });
    armOffsetQ.setFromAxisAngle(Z_AXIS, sign * ARM_ABDUCT * ease);
    bone.quaternion.premultiply(armOffsetQ);
  }
}

// helper.update() 之前调用：把上一帧叠加的外展撤销，动画没覆盖到的骨骼才不会越叠越歪
export function restoreIdleArms() {
  for (const { bone, saved } of armApplied) bone.quaternion.copy(saved);
  armApplied.length = 0;
}

// 尾巴抬升：把尾巴起始点骨骼从它的原始旋转再绕 X 轴转 TAIL_LIFT。
// 用绝对角度而不是累加，程序化待机每帧调用也不会越叠越高。
function applyTailLift() {
  if (!tailLift) return;
  const { bone, base, sign } = tailLift;
  bone.rotation.set(base.x + sign * TAIL_LIFT, base.y, base.z);
}

// 待机动画：helper.update() 算完动画后调用，在动画给出的尾巴姿态上再叠加抬升
export function applyIdleTail() {
  tailApplied.length = 0;
  if (!tailLift) return;
  const { bone, sign } = tailLift;
  tailApplied.push({ bone, saved: bone.quaternion.clone() });
  bone.rotation.x += sign * TAIL_LIFT;
}

// helper.update() 之前调用：撤销上一帧的尾巴抬升，让动画/物理从原始姿态重新算
export function restoreIdleTail() {
  for (const { bone, saved } of tailApplied) bone.quaternion.copy(saved);
  tailApplied.length = 0;
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
  armAbduct.length = 0;
  armApplied.length = 0;
  tailLift = null;
  tailApplied.length = 0;
  armFade = 0;
  armLastAt = -1;
  blinkMorphIndex = -1;
  nextBlinkAt = 2;
  blinkStart = -1;
}
