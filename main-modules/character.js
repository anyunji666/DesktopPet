// ---------- 角色：扫描 Character/ 目录 + 读取各角色的台词/语音/骨骼屏蔽/材质修正配置 ----------
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CHARACTER_ROOT = path.join(ROOT, 'Character');

// ---------- 扫描角色（Character/<角色名>/ 下最大的 .pmx 作为本体模型） ----------
function pickModelFile(dir) {
  // 先把每个 .pmx 的大小一次量好（单个文件读不了就当 0，不让它拖垮整个扫描）
  const sizeOf = (f) => {
    try {
      return fs.statSync(path.join(dir, f)).size;
    } catch {
      return 0;
    }
  };
  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.pmx$/i.test(f))
    .map((f) => ({ f, size: sizeOf(f) }));
  if (!files.length) return null;
  files.sort((a, b) => b.size - a.size);
  return files[0].f;
}

function scanCharacters() {
  if (!fs.existsSync(CHARACTER_ROOT)) {
    throw new Error('找不到角色目录: ' + CHARACTER_ROOT);
  }
  const characters = [];
  for (const name of fs.readdirSync(CHARACTER_ROOT)) {
    const dir = path.join(CHARACTER_ROOT, name);
    // 单个目录项读不了（损坏的快捷方式 / 权限问题 / 没有读取权限的目录）只跳过它，不能让整个程序起不来
    let modelFile;
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      modelFile = pickModelFile(dir);
    } catch (err) {
      console.warn(`[pet] 角色目录 "${name}" 读取失败，已跳过: ${err.message}`);
      continue;
    }
    if (!modelFile) {
      console.warn(`[pet] 角色目录 "${name}" 中没有 .pmx 文件，已跳过`);
      continue;
    }
    characters.push({
      name,
      model: `/Character/${encodeURIComponent(name)}/${encodeURIComponent(modelFile)}`,
    });
  }
  if (!characters.length) throw new Error('Character 目录下没有找到任何可用角色: ' + CHARACTER_ROOT);
  return characters;
}

// ---------- 读取角色的对话气泡语料（Character/<角色名>/quotes.json） ----------
// 每个角色一份台词，点击模型时随机挑一句用气泡显示。
// 支持两种格式：纯字符串数组（默认红色气泡），
// 或对象 { "color": "# rrggbb", "lines": [...] } 指定角色专属气泡颜色
function loadQuotes(characterName) {
  const p = path.join(CHARACTER_ROOT, characterName, 'quotes.json');
  const empty = { lines: [], color: null };
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const strs = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x.trim()) : null);
    if (Array.isArray(data)) return { lines: strs(data), color: null };
    if (data && typeof data === 'object') {
      const lines = strs(data.lines);
      if (lines) return { lines, color: typeof data.color === 'string' ? data.color : null };
    }
    console.warn(`[pet] 角色 "${characterName}" 的 quotes.json 格式不对（应为字符串数组或 { color, lines }），已忽略`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[pet] 角色 "${characterName}" 的 quotes.json 解析失败: ${err.message}`);
    }
  }
  return empty;
}

// ---------- 扫描角色语音包（Character/<角色名>/voice/ 下的音频文件） ----------
// 语音文件名对应台词开头（如「你就是我的御主吗.wav」对应台词「你就是我的御主吗？……」），
// 匹配时忽略标点符号（「」！？等）；没匹配上的按文件名自然顺序补进空位（兼容 1.wav ~ 9.wav 编号命名）
const VOICE_RE = /\.(wav|mp3|ogg|m4a|flac|aac)$/i;

function loadVoices(characterName, lines) {
  const dir = path.join(CHARACTER_ROOT, characterName, 'voice');
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => VOICE_RE.test(f));
  } catch {
    return [];
  }
  if (!files.length || !lines.length) return [];
  const base = `/Character/${encodeURIComponent(characterName)}/voice/`;
  const stems = files.map((f) => ({
    file: f,
    stem: f.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}]+/gu, ''),
  }));
  const used = new Set();
  const voices = new Array(lines.length).fill(null);
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].replace(/[^\p{L}\p{N}]+/gu, '');
    for (const { file, stem } of stems) {
      if (used.has(file) || !stem) continue;
      if (text.startsWith(stem)) {
        voices[i] = base + encodeURIComponent(file);
        used.add(file);
        break;
      }
    }
  }
  const rest = files.filter((f) => !used.has(f)).sort((a, b) => a.localeCompare(b, 'zh', { numeric: true }));
  for (let i = 0; i < voices.length && rest.length; i++) {
    if (!voices[i]) voices[i] = base + encodeURIComponent(rest.shift());
  }
  return voices;
}

// ---------- 喝水提醒语音（Character/<角色名>/Time report/ 下的音频文件） ----------
// 文件名就是提醒台词（标点可省略，如「上午八点了，记得多喝水.wav」），
// 按下面的提醒表匹配到对应的小时，随角色 payload 下发给渲染进程到点播放。
// 只在有语音的时间点提醒（不是每个整点都有），所以叫"喝水提醒"而不是"整点报时"
const TIME_REPORT_DIR_RE = /^time\s*report$/i;
const DRINK_REMINDER_LINES = [
  { hour: 8, text: '上午八点了，记得多喝水。' },
  { hour: 9, text: '上午九点了，你要喝点水吗？' },
  { hour: 10, text: '上午十点了，去喝点水吧~' },
  { hour: 11, text: '上午十一点了，你要喝点水吗？' },
  { hour: 14, text: '下午二点了，去喝点水吧~' },
  { hour: 15, text: '下午三点了，你要喝点水吗？' },
  { hour: 16, text: '下午四点了，去喝点水吧~' },
  { hour: 17, text: '下午五点了，你要喝点水吗？' },
  { hour: 20, text: '晚八点了，去喝点水吧~' },
  { hour: 21, text: '晚九点了，你要喝点水吗？' },
  { hour: 22, text: '晚十点了，要早点休息哦~' },
];

function loadDrinkReminders(characterName) {
  const charDir = path.join(CHARACTER_ROOT, characterName);
  let dirName = null;
  try {
    dirName = fs
      .readdirSync(charDir)
      .find((f) => TIME_REPORT_DIR_RE.test(f) && fs.statSync(path.join(charDir, f)).isDirectory());
  } catch {
    return [];
  }
  if (!dirName) return [];
  let files;
  try {
    files = fs.readdirSync(path.join(charDir, dirName)).filter((f) => VOICE_RE.test(f));
  } catch {
    return [];
  }
  if (!files.length) return [];
  const base = `/Character/${encodeURIComponent(characterName)}/${encodeURIComponent(dirName)}/`;
  const stems = files.map((f) => ({
    file: f,
    stem: f.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}]+/gu, ''),
  }));
  const used = new Set();
  const reminders = [];
  for (const { hour, text } of DRINK_REMINDER_LINES) {
    const key = text.replace(/[^\p{L}\p{N}]+/gu, '');
    const hit = stems.find(({ file, stem }) => !used.has(file) && stem && key.startsWith(stem));
    if (hit) {
      used.add(hit.file);
      reminders.push({ hour, text, url: base + encodeURIComponent(hit.file) });
    }
  }
  return reminders;
}

// ---------- 读取角色材质修正（Character/<角色名>/fixes.json） ----------
// 个别模型的材质参数在 three.js 里显示不佳，按角色配置修正（字段都可选，写了才生效）：
//   whiteDiffuse: 材质名数组 —— 把这些材质的漫反射色恢复为纯白
//     （如银狼脸部 diffuse 被作者压成 0.753 灰色，脸会比身体暗一圈显得发灰）
//   brightness: { 材质名: 倍数 } —— 提亮/压暗命中的材质，1.0 不变、>1 变亮、<1 变暗
//     （如庄方宜的 tex/衣.png、tex/发.png 本身就偏暗：平均亮度 101 / 83，
//      而 three 渲染里 toon 图是纯白、漫反射也是 1，靠材质参数无处可调，只能在这里乘系数）
//     上限 8，防止写成离谱的值把画面糊成一片白
//   emissive: 倍数 —— 统一缩放自发光。MMDLoader 会把 PMX 的「環境色」当成 emissive 加进来
//     （ambient × 0.2，MMDLoader.js 里写死的），这一层是均匀加在画面上、不受光照影响的灰，
//     模型的暗部被抬到 0.3~0.4，看起来就是"蒙了一层灰"。设 0 去掉，对比度和饱和度都会回来
//   specular / shininess: { 材质名: 数值 } —— 覆盖高光颜色（0~1 灰度）和光泽度（1~200）。
//     MMD 里大量模型 specular 全是 0、shininess 1，three 就是完全没高光，看着"没有光泽"
//   材质名字典都支持 "*" 作为默认值，具体材质名优先（{ "*": 0.2, "颜": 0.05 }）
//   整体饱和度不在这里做，那是全应用级调色（index.html 的 canvas filter）
const MAX_BRIGHTNESS = 8;
const MAX_SHININESS = 200;
const NUM_DICT_KEYS = ['brightness', 'specular', 'shininess'];
function loadMaterialFixes(characterName) {
  const p = path.join(CHARACTER_ROOT, characterName, 'fixes.json');
  const warn = (msg) => console.warn(`[pet] 角色 "${characterName}" 的 fixes.json ${msg}`);
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const out = {};
    if (Array.isArray(data.whiteDiffuse)) out.whiteDiffuse = data.whiteDiffuse.filter((x) => typeof x === 'string');
    for (const key of NUM_DICT_KEYS) {
      const src = data[key];
      if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
      const dict = {};
      for (const [name, v] of Object.entries(src)) {
        if (!isNum(v) || v < 0) {
          warn(`${key}."${name}" 不是非负数，已跳过`);
          continue;
        }
        if (key === 'brightness') dict[name] = v > 0 ? Math.min(v, MAX_BRIGHTNESS) : 1;
        else if (key === 'specular') dict[name] = Math.min(v, 1);
        else dict[name] = Math.min(v, MAX_SHININESS);
      }
      if (Object.keys(dict).length) out[key] = dict;
    }
    if (isNum(data.emissive) && data.emissive >= 0) out.emissive = Math.min(data.emissive, 5);
    else if (data.emissive !== undefined) warn('emissive 不是非负数，已跳过');
    if (!Object.keys(out).length) {
      warn('里没有可用的 whiteDiffuse / brightness / emissive / specular / shininess，已忽略');
      return null;
    }
    return out;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      warn(`解析失败: ${err.message}`);
    }
  }
  return null;
}

// ---------- 读取角色灯光覆盖（Character/<角色名>/lights.json，可选） ----------
// 默认灯光对所有模型不一定合适（贴图偏暗的模型需要更强的光），按角色覆盖就不会连带影响别的角色。
// 字段与 Scene/<场景>/scene.json 的 lights 相同，且会被场景自己的 lights 覆盖（场景是刻意的氛围，优先级更高）：
//   ambient / key / back: { color, intensity, position }  —— 都可选，没写的沿用默认灯光
function loadLights(characterName) {
  const p = path.join(CHARACTER_ROOT, characterName, 'lights.json');
  const warn = (msg) => console.warn(`[pet] 角色 "${characterName}" 的 lights.json ${msg}`);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (err) {
    if (err.code !== 'ENOENT') warn(`解析失败: ${err.message}`);
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    warn('格式不对（应为对象），已忽略');
    return null;
  }
  const normLight = (l) => {
    if (!l || typeof l !== 'object' || Array.isArray(l)) return null;
    const out = {};
    if (typeof l.color === 'string') out.color = l.color;
    if (Number.isFinite(l.intensity)) out.intensity = l.intensity;
    if (Array.isArray(l.position) && l.position.length === 3 && l.position.every(Number.isFinite)) {
      out.position = l.position;
    }
    return Object.keys(out).length ? out : null;
  };
  const out = {};
  for (const key of ['ambient', 'key', 'back']) {
    const light = normLight(data[key]);
    if (light) out[key] = light;
  }
  if (!Object.keys(out).length) {
    warn('里没有可用的 ambient / key / back，已忽略');
    return null;
  }
  return out;
}

// ---------- 读取角色物理微调（Character/<角色名>/physics.json，可选） ----------
// 个别模型的头发/裙摆/袖口物理配置不稳（刚体没有回复力、和手臂大腿反复接触等），会一直抖。
// 这里按角色配置修正，所有字段都可选，不写就完全不影响该角色。名字一律是 PMX 里的「刚体名」，
// 写成正则字符串（如 "^裙_"、"袖"）；不确定名字叫什么，开发者工具控制台里用 __phys.find('裙') 查。
//   noCollide         [{ bodies, with, when }]  bodies 命中的刚体不再和 with 命中的刚体碰撞；when 默认 "idle"（仅待机）
//   freeze            [{ bodies, when }]  bodies 命中的刚体改成跟随骨骼不再模拟；when 默认 "idle"（仅待机）
//   damping           [{ bodies, linear, angular, when }]  覆盖命中刚体的线性 / 角阻尼（0~1）；when 默认 "always"
//   when 只有 "idle"（仅待机动画期间）和 "always"（任何动作）两种取值
function loadPhysicsTweaks(characterName) {
  const p = path.join(CHARACTER_ROOT, characterName, 'physics.json');
  const warn = (msg) => console.warn(`[pet] 角色 "${characterName}" 的 physics.json ${msg}`);
  const isRe = (v) => {
    if (typeof v !== 'string' || !v) return false;
    try {
      new RegExp(v);
      return true;
    } catch {
      return false;
    }
  };
  const num01 = (v) => typeof v === 'number' && v >= 0 && v <= 1;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (err) {
    if (err.code !== 'ENOENT') warn(`解析失败: ${err.message}`);
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    warn('格式不对（应为对象），已忽略');
    return null;
  }
  const out = { noCollide: [], freeze: [], damping: [] };
  for (const it of Array.isArray(data.noCollide) ? data.noCollide : []) {
    if (it && isRe(it.bodies) && isRe(it.with)) {
      out.noCollide.push({ bodies: it.bodies, with: it.with, when: it.when === 'always' ? 'always' : 'idle' });
    }
    else warn('里有一条 noCollide 缺少合法的 bodies / with 正则，已跳过');
  }
  for (const it of Array.isArray(data.freeze) ? data.freeze : []) {
    if (it && isRe(it.bodies)) out.freeze.push({ bodies: it.bodies, when: it.when === 'always' ? 'always' : 'idle' });
    else warn('里有一条 freeze 缺少合法的 bodies 正则，已跳过');
  }
  for (const it of Array.isArray(data.damping) ? data.damping : []) {
    if (it && isRe(it.bodies) && (num01(it.linear) || num01(it.angular))) {
      out.damping.push({
        bodies: it.bodies,
        linear: num01(it.linear) ? it.linear : null,
        angular: num01(it.angular) ? it.angular : null,
        when: it.when === 'idle' ? 'idle' : 'always',
      });
    } else warn('里有一条 damping 缺少合法的 bodies 正则或 0~1 的 linear / angular，已跳过');
  }
  return out;
}

module.exports = {
  CHARACTER_ROOT,
  pickModelFile,
  scanCharacters,
  loadQuotes,
  loadVoices,
  loadDrinkReminders,
  loadMaterialFixes,
  loadLights,
  loadPhysicsTweaks,
};
