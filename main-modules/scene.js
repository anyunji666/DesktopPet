// ---------- 扫描场景（Scene/<场景名>/） ----------
// 每个场景文件夹里：
//   - 自动选用最大的 .pmx / .pmd / .glb / .gltf 作为场景本体（可在 scene.json 的 model 字段里指定）
//   - 可选的 scene.json 用来描述缩放/位置/背景/灯光/镜头等，详见 Scene/README.md
//   - 没有模型但有 scene.json 也可以，那就是纯"背景 + 灯光"场景
const fs = require('fs');
const path = require('path');
const { loadConfig, updateConfig } = require('./config');

const ROOT = path.join(__dirname, '..');
const SCENE_ROOT = path.join(ROOT, 'Scene');
const SCENE_MODEL_RE = /\.(pmx|pmd|glb|gltf)$/i;

function toNum(v, def) {
  return Number.isFinite(v) ? v : def;
}

function toVec3(v, def) {
  return Array.isArray(v) && v.length === 3 && v.every(Number.isFinite) ? v : def;
}

// 按路径段编码：保留 "/"，这样 PMX 才能基于模型 URL 正确解析相对路径的贴图
function encodeRelPath(rel) {
  return rel.split(/[\\/]/).filter(Boolean).map(encodeURIComponent).join('/');
}

function readSceneJson(dir, name) {
  const p = path.join(dir, 'scene.json');
  try {
    // 去掉 BOM（Windows 记事本保存的 UTF-8 文件常带 BOM，会导致 JSON.parse 失败）
    const data = JSON.parse(fs.readFileSync(p, 'utf-8').replace(/^\uFEFF/, ''));
    if (data && typeof data === 'object' && !Array.isArray(data)) return { cfg: data, hasJson: true };
    console.warn(`[pet] 场景 "${name}" 的 scene.json 格式不对（应为对象），已忽略`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[pet] 场景 "${name}" 的 scene.json 解析失败: ${err.message}`);
    }
  }
  return { cfg: {}, hasJson: false };
}

// 生成单个场景模型条目；文件不存在或越出场景目录则返回 null
function buildSceneModel(name, dir, file, opts) {
  if (typeof file !== 'string' || !SCENE_MODEL_RE.test(file)) {
    console.warn(`[pet] 场景 "${name}" 的模型 "${file}" 不是支持的格式（pmx / pmd / glb / gltf），已跳过`);
    return null;
  }
  const abs = path.resolve(dir, file);
  if (!abs.startsWith(dir + path.sep) || !fs.existsSync(abs)) {
    console.warn(`[pet] 场景 "${name}" 找不到模型文件 "${file}"，已跳过`);
    return null;
  }
  const rel = path.relative(dir, abs);
  return {
    file: rel,
    type: /\.(glb|gltf)$/i.test(rel) ? 'gltf' : 'pmx',
    url: `/Scene/${encodeURIComponent(name)}/${encodeRelPath(rel)}`,
    scale: toNum(opts.scale, 1),
    position: toVec3(opts.position, [0, 0, 0]),
    rotationY: toNum(opts.rotationY, 0), // 角度制
  };
}

function normLight(l) {
  if (!l || typeof l !== 'object') return undefined;
  const out = {};
  if (typeof l.color === 'string') out.color = l.color;
  if (Number.isFinite(l.intensity)) out.intensity = l.intensity;
  if (Array.isArray(l.position) && l.position.length === 3 && l.position.every(Number.isFinite)) {
    out.position = l.position;
  }
  return out;
}

function loadScene(name, dir) {
  const { cfg, hasJson } = readSceneJson(dir, name);
  const files = fs.readdirSync(dir);

  const extras = Array.isArray(cfg.extras) ? cfg.extras : [];
  const extraFiles = new Set(
    extras.map((e) => e && typeof e.file === 'string' && path.normalize(e.file)).filter(Boolean)
  );

  // 本体：scene.json 指定 > 自动选最大的模型文件（排除已被列为附加模型的）
  let mainFile = typeof cfg.model === 'string' ? cfg.model : null;
  if (!mainFile) {
    const candidates = files
      .filter((f) => SCENE_MODEL_RE.test(f) && !extraFiles.has(path.normalize(f)))
      .map((f) => ({ f, size: fs.statSync(path.join(dir, f)).size }))
      .sort((a, b) => b.size - a.size);
    if (candidates.length) mainFile = candidates[0].f;
  }

  const models = [];
  if (mainFile) {
    const m = buildSceneModel(name, dir, mainFile, cfg);
    if (m) models.push(m);
  }
  for (const e of extras) {
    if (!e || typeof e !== 'object') continue;
    const m = buildSceneModel(name, dir, e.file, e);
    if (m) models.push(m);
  }

  if (!models.length && !hasJson) {
    const hint = files.some((f) => /\.blend$/i.test(f))
      ? '（.blend 需要先在 Blender 里导出为 .glb）'
      : '';
    console.warn(`[pet] 场景目录 "${name}" 中没有可用的模型文件，也没有 scene.json，已跳过${hint}`);
    return null;
  }

  // 背景图：相对场景目录
  let backgroundImage = null;
  if (typeof cfg.backgroundImage === 'string') {
    const abs = path.resolve(dir, cfg.backgroundImage);
    if (abs.startsWith(dir + path.sep) && fs.existsSync(abs)) {
      backgroundImage = `/Scene/${encodeURIComponent(name)}/${encodeRelPath(path.relative(dir, abs))}`;
    } else {
      console.warn(`[pet] 场景 "${name}" 找不到背景图 "${cfg.backgroundImage}"，已忽略`);
    }
  }

  const g = cfg.ground && typeof cfg.ground === 'object' ? cfg.ground : null;
  const f = cfg.fog && typeof cfg.fog === 'object' ? cfg.fog : null;
  const cam = cfg.camera && typeof cfg.camera === 'object' ? cfg.camera : {};
  const lights = cfg.lights && typeof cfg.lights === 'object' ? cfg.lights : {};

  return {
    name,
    label: typeof cfg.displayName === 'string' && cfg.displayName ? cfg.displayName : name,
    models,
    background: typeof cfg.background === 'string' ? cfg.background : null,
    backgroundImage,
    hintColor: typeof cfg.hintColor === 'string' ? cfg.hintColor : null,
    ground: g
      ? {
          color: typeof g.color === 'string' ? g.color : '#333333',
          radius: toNum(g.radius, 60),
          opacity: toNum(g.opacity, 1),
          y: toNum(g.y, 0),
          lit: g.lit === true, // 默认不受灯光影响，颜色所见即所得
        }
      : null,
    fog: f
      ? {
          color: typeof f.color === 'string' ? f.color : '#000000',
          near: toNum(f.near, 40),
          far: toNum(f.far, 200),
        }
      : null,
    lights: {
      ambient: normLight(lights.ambient),
      key: normLight(lights.key),
      back: normLight(lights.back),
    },
    camera: {
      distance: toNum(cam.distance, 1), // 相对默认取景距离的倍数
      height: toNum(cam.height, 0), // 镜头高度偏移
    },
  };
}

function scanScenes() {
  if (!fs.existsSync(SCENE_ROOT)) {
    console.warn('[pet] 没有找到 Scene 目录，场景功能仅保留"无场景"：' + SCENE_ROOT);
    return [];
  }
  const result = [];
  for (const name of fs.readdirSync(SCENE_ROOT)) {
    const dir = path.join(SCENE_ROOT, name);
    let stat;
    try {
      stat = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    try {
      const scene = loadScene(name, dir);
      if (scene) result.push(scene);
    } catch (err) {
      console.warn(`[pet] 场景 "${name}" 读取失败，已跳过: ${err.message}`);
    }
  }
  return result;
}

// ---------- 场景的手动调整（Shift+滚轮 / Shift+拖拽 / Ctrl+滚轮 / Ctrl+拖拽），按场景名存进 config.json ----------
const ADJUST_DEFAULT = { zoom: 1, x: 0, y: 0, z: 0, rotY: 0 };

// 角度统一归一化到 [0, 2π)，避免拖拽转圈越转越大导致存进配置的数字无限增长
function normAngle(v) {
  const twoPi = Math.PI * 2;
  return ((v % twoPi) + twoPi) % twoPi;
}

function normAdjust(a) {
  const o = a && typeof a === 'object' ? a : {};
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  return {
    zoom: clamp(toNum(o.zoom, 1), 0.2, 5),
    x: clamp(toNum(o.x, 0), -10000, 10000),
    y: clamp(toNum(o.y, 0), -10000, 10000),
    z: clamp(toNum(o.z, 0), -10000, 10000),
    rotY: normAngle(toNum(o.rotY, 0)),
  };
}

function isDefaultAdjust(a) {
  return a.zoom === 1 && a.x === 0 && a.y === 0 && a.z === 0 && a.rotY === 0;
}

function getAdjust(name) {
  const all = loadConfig().sceneAdjust;
  return normAdjust(all && typeof all === 'object' ? all[name] : null);
}

function setAdjust(name, adj) {
  const stored = loadConfig().sceneAdjust;
  const all = { ...(stored && typeof stored === 'object' ? stored : {}) };
  if (isDefaultAdjust(adj)) delete all[name]; // 回到默认就不占配置
  else all[name] = adj;
  updateConfig({ sceneAdjust: all });
}

module.exports = {
  SCENE_ROOT,
  scanScenes,
  ADJUST_DEFAULT,
  normAdjust,
  isDefaultAdjust,
  getAdjust,
  setAdjust,
};
