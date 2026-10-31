// ---------------- 加载 / 卸载模型 ----------------
import * as THREE from 'three';
import { state, scene, camera, loader, tmpV, curTgt, renderer } from './state.js';
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
        // applyToon 替换掉的原始 toon 图不再挂在 material 上，单独释放
        const orig = mat.userData && mat.userData.origGradientMap;
        if (orig && orig.isTexture) orig.dispose();
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

// ---------- toon 明暗渐变（fixes.json 的 toon 字段 / 控制台 __toon） ----------
// three 的 MMD 着色器按 dotNL（法线和光的夹角余弦，-1~1）去采样 toon 图的红色通道当作"受光系数"。
// 多数 PMX 的 toon 图接近纯白，所以明暗几乎没有层次。这里用程序生成一条一维渐变图替换掉它：
//   shade     暗部的受光系数（0~1）。1 = 不加阴影（保持原样，不替换）；0.8 = 暗部降到 80%
//   threshold 明暗分界位置，对应 dotNL（-1~1）。0 = 光线正好擦过的位置；往正数移，阴影区更大
//   soft      过渡宽度（0~1）。接近 0 是赛璐璐硬边，0.3 以上是柔和过渡
// 只能是灰度阴影（three 只读 toon 图的红色通道）。生成的贴图按线性值写入，shade 就是直接乘在光照上的倍数。
export const TOON_DEFAULTS = { shade: 1, threshold: 0, soft: 0.15 };
const TOON_WIDTH = 256;

export function makeToonTexture({ shade, threshold, soft }) {
  const data = new Uint8Array(TOON_WIDTH * 4);
  const w = Math.max(soft, 1e-3);
  for (let i = 0; i < TOON_WIDTH; i++) {
    const dotNL = (i / (TOON_WIDTH - 1)) * 2 - 1;
    const t = THREE.MathUtils.clamp((dotNL - (threshold - w)) / (2 * w), 0, 1);
    const k = t * t * (3 - 2 * t); // smoothstep
    const v = Math.round((shade + (1 - shade) * k) * 255);
    data.set([v, v, v, 255], i * 4);
  }
  const tex = new THREE.DataTexture(data, TOON_WIDTH, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

// cfg: { 材质名 | "*": { shade, threshold, soft } }；具体材质名优先于 "*"。
// 可重复调用（控制台实时调参用）：cfg 里没命中、或 shade >= 1 的材质会恢复成模型自带的 toon 图
export function applyToon(root, cfg) {
  if (!root) return;
  if (root.userData.toonTextures) for (const t of root.userData.toonTextures) t.dispose();
  const made = new Map();
  root.userData.toonTextures = [];
  const has = (name) => cfg && Object.prototype.hasOwnProperty.call(cfg, name);
  root.traverse((obj) => {
    if (!obj.isMesh || !Array.isArray(obj.material)) return;
    for (const mat of obj.material) {
      if (!('gradientMap' in mat)) continue;
      if (mat.userData.origGradientMap === undefined) mat.userData.origGradientMap = mat.gradientMap;
      const src = has(mat.name) ? cfg[mat.name] : has('*') ? cfg['*'] : null;
      const p = src ? { ...TOON_DEFAULTS, ...src } : null;
      let next = mat.userData.origGradientMap;
      if (p && p.shade < 1) {
        const key = `${p.shade}|${p.threshold}|${p.soft}`;
        if (!made.has(key)) {
          const t = makeToonTexture(p);
          made.set(key, t);
          root.userData.toonTextures.push(t);
        }
        next = made.get(key);
      }
      if (mat.gradientMap !== next) {
        mat.gradientMap = next;
        mat.needsUpdate = true;
      }
    }
  });
}

// 各向异性过滤：斜视角（侧身、低头）时贴图不发糊。设成显卡支持的最大值，几乎没有性能代价。
// gradientMap（toon 渐变图）是一维渐变，不需要；其余贴图（map / 球面 / 法线等）统一处理。
// 贴图可能还在异步加载，anisotropy 在首次上传 GPU 时才读取；已上传过的才需要 needsUpdate
export function applyAnisotropy(root) {
  const max = renderer.capabilities.getMaxAnisotropy();
  root.traverse((obj) => {
    if (!obj.material) return;
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of materials) {
      for (const key of Object.keys(mat)) {
        const tex = mat[key];
        if (!tex || !tex.isTexture || key === 'gradientMap' || tex.anisotropy === max) continue;
        tex.anisotropy = max;
        if (tex.image) tex.needsUpdate = true;
      }
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
//   whiteDiffuse：漫反射色设为纯白（模型作者压低 diffuse 导致脸发灰时用）
//   brightness：乘到漫反射色上（贴图本身偏暗时用，1 以上变亮）
//   emissive：整体缩放自发光（MMDLoader 把 PMX 環境色 ×0.2 当 emissive 加进去，
//     那层是不受光照的均匀灰，会把暗部抬起来、"蒙一层灰"，设 0 就能恢复对比度与饱和度）
//   specular / shininess：覆盖高光强度与光泽度（很多模型 specular 全 0 → 完全没有光泽）
// 三个字典都支持 "*" 作为默认值，具体材质名优先。
// 画面对比度 / 饱和度不在材质里做，见下面的 applyColorGrade（按角色写到 canvas 的 CSS filter）。
// MMDToonMaterial 的 color / specular / emissive 都是对应 uniform 的别名（见 MMDLoader.js
// 的 exposePropertyNames），直接改这些 Color 即可；着色器不会把 diffuse 截到 1，
// 所以乘大于 1 的系数能真正提亮。
function applyMaterialFixes(m) {
  const fixes = state.materialFixes;
  if (!fixes || !Array.isArray(m.material)) return;
  const white = new Set(fixes.whiteDiffuse || []);
  const pick = (dict, name, fallback) => {
    if (!dict) return fallback;
    if (Object.prototype.hasOwnProperty.call(dict, name)) return dict[name];
    return Object.prototype.hasOwnProperty.call(dict, '*') ? dict['*'] : fallback;
  };
  const emissiveScale = typeof fixes.emissive === 'number' ? fixes.emissive : 1;
  // 名字写错（和 PMX 里的材质名对不上）时 fixes.json 会静默不生效，这里提示出来，和 physics.json 的行为一致。
  // 同名的多个材质会一起被调整（pick 按名字匹配）
  const names = new Set(m.material.map((mat) => mat.name));
  const unmatched = new Set();
  for (const w of white) if (!names.has(w)) unmatched.add(`whiteDiffuse."${w}"`);
  for (const key of ['brightness', 'specular', 'shininess']) {
    for (const name of Object.keys(fixes[key] || {})) {
      if (name !== '*' && !names.has(name)) unmatched.add(`${key}."${name}"`);
    }
  }
  if (unmatched.size) console.warn(`[pet][fixes.json] 这些材质名没有命中模型里的任何材质（检查是否写错）：${[...unmatched].join('、')}`);
  for (const mat of m.material) {
    if (!mat.color) continue;
    if (white.has(mat.name)) mat.color.setRGB(1, 1, 1);
    const brightness = pick(fixes.brightness, mat.name, 1);
    if (brightness !== 1) mat.color.multiplyScalar(brightness);
    if (emissiveScale !== 1 && mat.emissive) mat.emissive.multiplyScalar(emissiveScale);
    const specular = pick(fixes.specular, mat.name, null);
    if (specular !== null && mat.specular) mat.specular.setScalar(specular);
    const shininess = pick(fixes.shininess, mat.name, null);
    if (shininess !== null) mat.shininess = shininess;
  }
}

// 按角色的 fixes.json 里的 contrast / saturate 给整张画布调色（CSS filter，1 = 不变）。
// 没配置（或没有 fixes.json）时清掉滤镜，避免上一个角色的调色残留到新角色上
function applyColorGrade(fixes) {
  const parts = [];
  if (fixes && typeof fixes.contrast === 'number' && fixes.contrast !== 1) parts.push(`contrast(${fixes.contrast})`);
  if (fixes && typeof fixes.saturate === 'number' && fixes.saturate !== 1) parts.push(`saturate(${fixes.saturate})`);
  renderer.domElement.style.filter = parts.join(' ');
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
  const { playEntrance = true, onReady } = opts; // 程序初次打开传 false：直接待机，不跳开场舞；切换角色时保持 true
  loader.load(
    url,
    (loaded) => {
      fixEmptyMorphs(loaded);
      applyMaterialFixes(loaded);
      applyColorGrade(state.materialFixes);
      fixLowFootIkIterations(loaded);
      applyAnisotropy(loaded);
      if (state.materialFixes && state.materialFixes.toon) applyToon(loaded, state.materialFixes.toon);
      state.mesh = loaded;
      state.modelYaw = 0;
      state.modelYawTarget = 0;
      normalizeModelScale();
      scene.add(state.mesh);
      setupIdle();
      frameModel();
      hideLoading();
      try { window.petAPI.startupLog('模型已加载并上屏'); } catch {}
      if (typeof onReady === 'function') onReady(); // 模型此刻已经出现在屏幕上，仅初次启动计时用
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
      try { window.petAPI.startupLog('模型加载失败: ' + (err && err.message ? err.message : err)); } catch {}
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
