// ---------------- 加载 / 卸载模型 ----------------
import * as THREE from 'three';
import { state, scene, camera, loader, tmpV, curTgt } from './state.js';
import { showLoading, hideLoading } from './ui.js';
import { setupIdle, resetIdle } from './idle-animation.js';
import { stopDance, playDance, playIdle, ENTRANCE_DANCE_NAME } from './dance.js';

// 释放一个对象树占用的 GPU 资源（geometry / material / 贴图）；角色和场景共用
export function disposeObject3D(root) {
  root.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of materials) {
        for (const key of Object.keys(mat)) {
          const value = mat[key];
          if (value && value.isTexture) value.dispose();
        }
        mat.dispose();
      }
    }
  });
}

// three r170 + MMDLoader 的边界问题：pmx 里没有任何表情时，MMDLoader 仍会把 morphAttributes.position
// 设成空数组。three 看到"属性存在"就打开着色器里的 USE_MORPHTARGETS，可表情数为 0 时又不定义
// MORPHTARGETS_COUNT，着色器因此编译失败（模型整体不显示，还会画出放射状的乱三角形）。
// 把空的形变数组删掉即可；对角色和场景模型都要调用。
export function fixEmptyMorphs(root) {
  root.traverse((obj) => {
    const attrs = obj.geometry && obj.geometry.morphAttributes;
    if (!attrs) return;
    for (const key of Object.keys(attrs)) {
      if (Array.isArray(attrs[key]) && attrs[key].length === 0) delete attrs[key];
    }
  });
}

// 统计模型规模，加载场景时打印出来，方便排查性能/兼容问题
export function modelStats(root) {
  let vertices = 0;
  let bones = 0;
  let morphs = 0;
  let materials = 0;
  root.traverse((o) => {
    if (!o.isMesh) return;
    vertices += o.geometry.attributes.position ? o.geometry.attributes.position.count : 0;
    if (o.skeleton) bones += o.skeleton.bones.length;
    morphs += o.morphTargetInfluences ? o.morphTargetInfluences.length : 0;
    materials += Array.isArray(o.material) ? o.material.length : 1;
  });
  return `verts=${vertices} bones=${bones} morphs=${morphs} materials=${materials}`;
}

// 按角色的 fixes.json 修正材质（PMX 的 mesh.material 是材质数组，按 name 匹配）
// 目前支持 whiteDiffuse：把这些材质的漫反射色设为纯白，
// 解决模型作者压低脸部 diffuse（如 0.753 灰）导致 three.js 里脸发灰的问题
function applyMaterialFixes(m) {
  if (!state.materialFixes || !Array.isArray(m.material)) return;
  const white = new Set(state.materialFixes.whiteDiffuse || []);
  if (!white.size) return;
  for (const mat of m.material) {
    if (white.has(mat.name) && mat.color) mat.color.setRGB(1, 1, 1);
  }
}

// CCDIKSolver 每帧解算 IK 时直接用 PMX 里存的迭代次数（不会自己加大）。
// 部分模型作者给"つま先ＩＫ"（脚尖）留的迭代次数很低（比如 3），大幅动作（下蹲/踮脚/
// 转身）时来不及收敛到目标朝向，会停在没转到位的中间状态——表现为脚掌扭曲、
// 看起来像插进地里。这里把过低的脚部 IK（足ＩＫ/つま先ＩＫ）迭代次数兜底提到安全值，
// 已经给够迭代次数的模型不受影响。
const MIN_FOOT_IK_ITERATIONS = 20;
function fixLowFootIkIterations(root) {
  root.traverse((obj) => {
    const iks = obj.geometry && obj.geometry.userData && obj.geometry.userData.MMD && obj.geometry.userData.MMD.iks;
    if (!iks || !obj.skeleton) return;
    for (const ik of iks) {
      const targetBone = obj.skeleton.bones[ik.target];
      if (!targetBone || !/(足|つま先)ＩＫ$/.test(targetBone.name)) continue;
      if (typeof ik.iteration === 'number' && ik.iteration < MIN_FOOT_IK_ITERATIONS) {
        ik.iteration = MIN_FOOT_IK_ITERATIONS;
      }
    }
  });
}

export function loadModel(url, opts = {}) {
  const { playEntrance = true } = opts; // 程序初次打开传 false：直接待机，不跳开场舞；切换角色时保持 true
  loader.load(
    url,
    (loaded) => {
      fixEmptyMorphs(loaded);
      applyMaterialFixes(loaded);
      fixLowFootIkIterations(loaded);
      state.mesh = loaded;
      state.modelYaw = 0;
      state.modelYawTarget = 0;
      normalizeModelScale();
      scene.add(state.mesh);
      setupIdle();
      frameModel();
      hideLoading();
      if (playEntrance) {
        // 模型就绪后跳一次开场舞，播完自动回待机（app.js 的 animate() 里已有这个逻辑），不循环
        const entranceIdx = state.dances.findIndex((d) => d.name === ENTRANCE_DANCE_NAME);
        if (entranceIdx >= 0) playDance(entranceIdx);
        else playIdle();
      } else {
        // 程序刚打开：跳过开场舞，直接进入待机状态
        playIdle();
      }
    },
    undefined,
    (err) => {
      document.getElementById('loading-text').textContent =
        '模型加载失败：' + (err && err.message ? err.message : err);
      console.error(err);
    }
  );
}

// 切换角色前调用：彻底移除旧模型并释放 three.js 资源（geometry / material / 贴图），
// 同时重置所有与旧模型骨骼绑定的状态，避免残留数据串到新角色身上
export function disposeModel() {
  clearTimeout(state.pendingDanceTimer);
  state.loadingDance = false;
  if (!state.mesh) return;
  stopDance(); // 停止动画/音频，重建 helper
  scene.remove(state.mesh);
  disposeObject3D(state.mesh);
  state.mesh = null;
  resetIdle();
  state.basePose = [];
  state.followBone = null;
  state.camBase = null;
  state.gazeAtCenter = false; // 新角色从待机的脸高基准重新取景
  state.modelYaw = 0;
  state.modelYawTarget = 0;
}

// 把模型缩放到标准 MMD 身高（约 20 单位 ≈ 160cm），避免舞蹈 IK 目标不匹配
export function normalizeModelScale() {
  const mesh = state.mesh;
  const box = new THREE.Box3().setFromObject(mesh);
  const size = box.getSize(new THREE.Vector3());
  const STANDARD_H = 20;
  if (Math.abs(size.y - STANDARD_H) / STANDARD_H > 0.05) {
    const s = STANDARD_H / size.y;
    mesh.scale.multiplyScalar(s);
  }
  // 落地校正：保证脚底贴地（Y=0）
  const box2 = new THREE.Box3().setFromObject(mesh);
  if (Math.abs(box2.min.y) > 0.1) {
    mesh.position.y -= box2.min.y;
  }
}

export function frameModel() {
  const mesh = state.mesh;
  const box = new THREE.Box3().setFromObject(mesh);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  // 给舞蹈位移和头脚留足余量
  const targetH = size.y * 1.45;
  const fov = (camera.fov * Math.PI) / 180;
  const dist = (targetH / 2 / Math.tan(fov / 2)) * state.sceneCam.distance;
  // 视线基准高度：待机在头/脸部（约身高 90% 处），跳舞等非待机动作在模型几何中心；
  // 两者都不额外留余量，具体用哪个由 gazeAtCenter 决定（见 state.js 的 setGazeCenter）
  state.gazeFaceY = box.min.y + size.y * 0.9;
  state.gazeCenterY = center.y;
  camera.position.set(center.x, (state.gazeAtCenter ? state.gazeCenterY : state.gazeFaceY) + state.sceneCam.height, center.z + dist);
  camera.lookAt(center.x, center.y, center.z);
  camera.updateProjectionMatrix();
  // 保存摄像机基准位（跟随偏移在此基础上叠加）
  state.camBase = { pos: camera.position.clone(), target: center.clone() };
  curTgt.copy(center);
  if (state.followBone) {
    state.followBone.getWorldPosition(tmpV);
    state.followBase.x = tmpV.x;
    state.followBase.z = tmpV.z;
    state.followSmooth.x = tmpV.x;
    state.followSmooth.z = tmpV.z;
  }
}
