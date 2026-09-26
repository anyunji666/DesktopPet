// ---------------- 共享状态载体 ----------------
// three.js 核心单例（渲染器/场景/相机/公用 loader/音频）+ 物理、待机、跳舞、场景、
// 镜头取景这几个领域模块之间密集互相读写的可变状态，全部收拢在这里，避免各模块
// 拆开后各自持有一份闭包变量、互相看不到最新值。
// 各模块只从这里 import `state` 读写字段，不要在别处再声明同名的模块级变量。
import * as THREE from 'three';
import { MMDLoader } from 'three/addons/loaders/MMDLoader.js';
import { TGALoader } from 'three/addons/loaders/TGALoader.js';

export const clock = new THREE.Clock();

export const audio = new Audio(); // 舞蹈音乐
audio.volume = 0.5;
export const voiceAudio = new Audio(); // 台词语音，与舞蹈音乐相互独立
voiceAudio.volume = 0.9;

// ---------------- three.js 场景 ----------------
export const scene = new THREE.Scene();
export const camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.1, 2000);

export const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0);

// 着色器编译失败时只打印显卡给出的 ERROR 行（three 默认会连带上千行着色器源码，很难读，也复制不出来）
const shaderErrorSeen = new Set();
renderer.debug.onShaderError = (gl, program, glVertexShader, glFragmentShader) => {
  const pick = (label, shader) =>
    (gl.getShaderInfoLog(shader) || '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('ERROR'))
      .map((l) => `[${label}] ${l}`);
  const lines = [...pick('vertex', glVertexShader), ...pick('fragment', glFragmentShader)];
  const text = lines.length
    ? lines.slice(0, 8).join('\n') + (lines.length > 8 ? `\n…另有 ${lines.length - 8} 行` : '')
    : (gl.getProgramInfoLog(program) || '').trim() || '（显卡没有返回具体原因）';
  if (shaderErrorSeen.has(text)) return; // 同一个错误只报一次
  shaderErrorSeen.add(text);
  console.error('[shader] 着色器编译失败：\n' + text);
};

export const manager = new THREE.LoadingManager();
manager.addHandler(/\.tga$/i, new TGALoader());
export const loader = new MMDLoader(manager); // 角色模型 + 动作，共用一个 loader 实例

// 渲染循环 / 镜头跟随复用的临时向量，避免每帧 new
export const tmpV = new THREE.Vector3();
export const desiredPos = new THREE.Vector3();
export const desiredTgt = new THREE.Vector3();
export const curTgt = new THREE.Vector3();

// ---------------- 跨模块共享的可变运行时状态 ----------------
export const state = {
  // 当前角色数据，由主进程随 onInit / onSwitchCharacter 下发
  dances: [],
  quotes: [], // 对话气泡语料
  voices: [], // 台词对应语音 URL，与 quotes 索引一一对应
  bubbleColor: null,
  characterName: null,
  ignoreBones: new Set(), // 要在动作里屏蔽的骨骼
  materialFixes: null,

  // 模型
  mesh: null,
  modelYaw: 0, // 当前左右旋转角度（应用到 mesh.rotation.y 的实际值）
  modelYawTarget: 0, // 目标旋转角度；animate() 里限速向它靠近，避免瞬间跳变甩飞裙摆/头发

  // 待机姿态在 setupIdle 里写入，跳舞时 resetPose 要用来复原，故不放在 idle-animation.js 私有闭包里
  basePose: [],

  // 摄像机跟随（防止大幅位移的舞蹈移出屏幕）；根骨骼由 setupIdle 选出，跳舞时 playDance 会按需覆盖
  followBone: null,
  followBase: { x: 0, z: 0 },
  followCur: { x: 0, z: 0 },
  followSmooth: { x: 0, z: 0 }, // 跟随目标的慢速滑动平均，滤掉舞蹈原地晃动
  camBase: null, // frameModel 里算好的摄像机基准位 { pos, target }

  // 视线基准：待机在脸部，跳舞等非待机动作在模型几何中心，见 setGazeCenter
  gazeFaceY: 0,
  gazeCenterY: 0,
  gazeAtCenter: false,

  // 动画/跳舞状态
  helper: null, // MMDAnimationHelper，由 dance.js 在 stopDance 里重建
  helperHasMesh: false,
  danceMode: false,
  loadingDance: false, // 动作加载中（防重复点击）
  pendingDanceTimer: null,
  danceFollow: null, // { bone, x, z } 舞蹈期间的跟随目标及基准位
  danceZoom: 0,
  danceZoomCur: 0,
  danceEndAt: Infinity,
  danceEndCallback: null,
  entranceMode: false, // 开场舞循环播放中
  exitInProgress: false, // 退场舞播放中
  loopingAction: null, // 当前循环播放（开场舞/待机）的 AnimationAction，供 animate() 检测循环衔接点

  // 场景
  sceneGroup: null,
  sceneToken: 0, // 每次切换自增，丢弃过期的异步加载结果
  sceneCam: { distance: 1, height: 0 },
  sceneName: null,
  sceneAdjust: { zoom: 1, x: 0, y: 0, z: 0 },
  adjustSaveTimer: null,
};

// 视线基准（摄像机高度）随动作类型切换：
//   待机姿态 / 待机动画 → 头脸部（gazeFaceY）
//   跳舞等非待机动作   → 模型几何中心（gazeCenterY）
// 只改 camBase.pos.y，渲染循环本来就会向 desiredPos 平滑插值，镜头缓缓移过去而不是硬跳。
// 放在 state.js 而不是 model.js / dance.js：两边都要调用它，放任一方会造出循环 import。
export function setGazeCenter(on) {
  state.gazeAtCenter = !!on;
  if (!state.camBase) return; // 模型还没就绪，等 frameModel 按当前标志位取景
  state.camBase.pos.y = (state.gazeAtCenter ? state.gazeCenterY : state.gazeFaceY) + state.sceneCam.height;
}
