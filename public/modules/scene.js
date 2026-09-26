// ---------------- 场景 ----------------
// 场景 = 背景（CSS 层）+ 灯光覆盖 + 可选地面/雾 + 若干 3D 模型（pmx / glb）。
// 场景对象统一挂在 sceneGroup 下，与角色互不干扰：不参与点击命中检测，也不影响角色取景。
import * as THREE from 'three';
import { MMDLoader } from 'three/addons/loaders/MMDLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { state, scene, camera, manager } from './state.js';
import { showLoading, hideLoading, showBubble } from './ui.js';
import { disposeObject3D, fixEmptyMorphs, modelStats, frameModel } from './model.js';

// 默认灯光（无场景时的样子）；场景可以通过 scene.json 的 lights 字段覆盖，切回无场景时恢复
const DEFAULT_LIGHTS = {
  ambient: { color: '#ffffff', intensity: 0.9 },
  key: { color: '#ffffff', intensity: 1.6, position: [3, 10, 6] },
  back: { color: '#ffe0e8', intensity: 0.5, position: [-4, 8, -6] },
};
const ambientLight = new THREE.AmbientLight();
const dirLight = new THREE.DirectionalLight();
const backLight = new THREE.DirectionalLight();
scene.add(ambientLight, dirLight, backLight);

export function applyLights(override = {}) {
  const pairs = [
    ['ambient', ambientLight],
    ['key', dirLight],
    ['back', backLight],
  ];
  for (const [k, light] of pairs) {
    const cfg = { ...DEFAULT_LIGHTS[k], ...(override[k] || {}) };
    light.color.set(cfg.color);
    light.intensity = cfg.intensity;
    if (cfg.position) light.position.set(...cfg.position);
  }
}
applyLights(); // 启动时先套一遍默认灯光，之后场景切换按需覆盖

const sceneBgEl = document.getElementById('scene-bg');
const sceneLoader = new MMDLoader(manager); // 独立实例，避免和角色/动作加载互相干扰
const gltfLoader = new GLTFLoader(manager);

// ---------- 手动调整场景的大小 / 位置 / 朝向（叠加在 scene.json 之上，按场景分别记住）----------
//   Shift + 滚轮：缩放背景（以角色所在位置为中心）
//   Shift + 拖拽：移动背景
//   Ctrl  + 滚轮：背景前后移动
//   Ctrl  + 拖拽：绕角色旋转背景（背景本身自转，角色和镜头都不动）
export const ADJUST_DEFAULT = { zoom: 1, x: 0, y: 0, z: 0, rotY: 0 };
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 5;

export function applySceneAdjust() {
  if (!state.sceneGroup) return;
  state.sceneGroup.scale.setScalar(state.sceneAdjust.zoom);
  state.sceneGroup.position.set(state.sceneAdjust.x, state.sceneAdjust.y, state.sceneAdjust.z);
  state.sceneGroup.rotation.y = state.sceneAdjust.rotY;
}

// 稍等片刻再落盘，避免滚轮/拖拽过程中每一帧都写文件；名字和数值在调用时就固定下来，
// 这样即使 300ms 内切换了场景，也不会把旧场景的调整存到新场景头上
function persistSceneAdjust() {
  clearTimeout(state.adjustSaveTimer);
  const name = state.sceneName;
  const adj = { ...state.sceneAdjust };
  if (!name) return;
  state.adjustSaveTimer = setTimeout(() => window.petAPI.saveSceneAdjust(name, adj), 300);
}

// 屏幕上 1 像素对应角色所在深度处多少世界单位（用来让拖拽和鼠标"跟手"）
export function worldPerPixel() {
  const dist = state.camBase ? state.camBase.pos.distanceTo(state.camBase.target) : 54;
  return (2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / window.innerHeight;
}

// delta 为滚轮增量（向上滚为负）：向上滚放大，向下滚缩小，每格约 8%
export function zoomSceneBy(delta) {
  state.sceneAdjust.zoom = THREE.MathUtils.clamp(state.sceneAdjust.zoom * Math.exp(-delta * 0.0008), ZOOM_MIN, ZOOM_MAX);
  applySceneAdjust();
  persistSceneAdjust();
  showBubble(`背景大小 ×${state.sceneAdjust.zoom.toFixed(2)}`);
}

// 向上滚：背景靠近镜头；每格约 4 个单位
export function moveSceneDepth(delta) {
  state.sceneAdjust.z = THREE.MathUtils.clamp(state.sceneAdjust.z - delta * 0.04, -10000, 10000);
  applySceneAdjust();
  persistSceneAdjust();
  showBubble(`背景前后位置：${state.sceneAdjust.z.toFixed(1)}`);
}

export function panSceneBy(dxPx, dyPx) {
  const u = worldPerPixel();
  state.sceneAdjust.x = THREE.MathUtils.clamp(state.sceneAdjust.x + dxPx * u, -10000, 10000);
  state.sceneAdjust.y = THREE.MathUtils.clamp(state.sceneAdjust.y - dyPx * u, -10000, 10000);
  applySceneAdjust();
  persistSceneAdjust();
}

// 水平拖拽转成的每像素旋转弧度：绕角色所在的 Y 轴自转整个场景（角色和镜头都不动），
// 不像 panSceneBy 那样跟屏幕像素做严格的空间换算——旋转是角度量，跟手感受"差不多快"就行
const ORBIT_RADIANS_PER_PIXEL = 0.006;

// dxPx 为鼠标水平方向的位移（Ctrl+拖拽）：往右拖背景顺时针转（从上往下看）
export function orbitSceneBy(dxPx) {
  const twoPi = Math.PI * 2;
  state.sceneAdjust.rotY = ((state.sceneAdjust.rotY + dxPx * ORBIT_RADIANS_PER_PIXEL) % twoPi + twoPi) % twoPi;
  applySceneAdjust();
  persistSceneAdjust();
}

// 菜单里的"重置当前场景的位置和大小"：丢弃还没来得及保存的旧调整，避免重置后又被写回
export function resetSceneAdjust(adj) {
  clearTimeout(state.adjustSaveTimer);
  state.sceneAdjust = { ...ADJUST_DEFAULT, ...(adj || {}) };
  applySceneAdjust();
}

function loadSceneModel(m) {
  return new Promise((resolve, reject) => {
    if (m.type === 'gltf') gltfLoader.load(m.url, (gltf) => resolve(gltf.scene), undefined, reject);
    else sceneLoader.load(m.url, resolve, undefined, reject);
  });
}

// 移除当前场景并把背景/灯光/雾/镜头恢复为默认
export function disposeScene() {
  state.sceneToken++;
  if (state.sceneGroup) {
    scene.remove(state.sceneGroup);
    disposeObject3D(state.sceneGroup);
    state.sceneGroup = null;
  }
  scene.fog = null;
  state.sceneName = null;
  state.sceneAdjust = { ...ADJUST_DEFAULT };
  document.getElementById('hint-scene').style.display = 'none';
  sceneBgEl.style.background = '';
  sceneBgEl.style.backgroundImage = '';
  document.getElementById('hint').style.color = '';
  applyLights();
  state.sceneCam = { distance: 1, height: 0 };
}

// payload 为 null 表示"无场景"
export function applyScene(payload) {
  disposeScene();
  if (payload) {
    const token = state.sceneToken;
    state.sceneGroup = new THREE.Group();
    scene.add(state.sceneGroup);
    state.sceneName = payload.name;
    state.sceneAdjust = { ...ADJUST_DEFAULT, ...(payload.adjust || {}) };
    applySceneAdjust();
    document.getElementById('hint-scene').style.display = 'inline';

    // 背景：background 可以是任意 CSS 背景值（纯色 / 渐变），backgroundImage 是图片
    if (payload.background) sceneBgEl.style.background = payload.background;
    if (payload.backgroundImage) sceneBgEl.style.backgroundImage = `url("${payload.backgroundImage}")`;
    if (payload.hintColor) document.getElementById('hint').style.color = payload.hintColor;

    applyLights(payload.lights);
    state.sceneCam = { ...state.sceneCam, ...(payload.camera || {}) };

    if (payload.fog) scene.fog = new THREE.Fog(payload.fog.color, payload.fog.near, payload.fog.far);

    if (payload.ground) {
      const g = payload.ground;
      const ground = new THREE.Mesh(
        new THREE.CircleGeometry(g.radius, 64),
        new (g.lit ? THREE.MeshLambertMaterial : THREE.MeshBasicMaterial)({
          color: g.color,
          transparent: g.opacity < 1,
          opacity: g.opacity,
          polygonOffset: true, // 略微后推，避免和脚底 / 场景地板 z-fighting
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
        })
      );
      ground.rotation.x = -Math.PI / 2;
      ground.position.y = g.y;
      state.sceneGroup.add(ground);
    }

    // 3D 模型：并行加载，单个失败不影响其他部分
    if (payload.models && payload.models.length) {
      showLoading('正在布置场景：' + payload.label + ' …');
      const group = state.sceneGroup;
      Promise.all(
        payload.models.map((m) =>
          loadSceneModel(m)
            .then((obj) => {
              if (token !== state.sceneToken) {
                disposeObject3D(obj); // 加载期间已经切走了
                return;
              }
              fixEmptyMorphs(obj);
              obj.scale.multiplyScalar(m.scale);
              obj.position.set(...m.position);
              obj.rotation.y = THREE.MathUtils.degToRad(m.rotationY);
              group.add(obj);
              // 调参辅助：在开发者工具里查看场景尺寸，用来定 scale / position
              const box = new THREE.Box3().setFromObject(obj);
              const f = (v) => v.toArray().map((n) => +n.toFixed(2));
              console.log(
                `[scene] "${payload.label}" / ${m.file}  size=${f(box.getSize(new THREE.Vector3()))}  min=${f(box.min)}  max=${f(box.max)}  ${modelStats(obj)}`
              );
            })
            .catch((err) => {
              console.error('[scene] 模型加载失败:', m.file, err);
              if (token === state.sceneToken) showBubble('场景模型加载失败：' + m.file);
            })
        )
      ).then(() => {
        // 角色还在加载时保留遮罩，由 loadModel 完成后统一关闭
        if (token === state.sceneToken && state.mesh && !state.loadingDance) {
          hideLoading();
        }
      });
    }
  }
  if (state.mesh) frameModel(); // 镜头参数可能变了，按新参数重新取景
}
