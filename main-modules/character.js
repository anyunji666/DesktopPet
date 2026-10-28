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
// 个别模型的材质参数在 three.js 里显示不佳（如银狼脸部 diffuse 被作者压成 0.753 灰色，
// 脸会比身体暗一圈显得发灰），按角色配置修正：
//   whiteDiffuse: 材质名数组 —— 把这些材质的漫反射色恢复为纯白
function loadMaterialFixes(characterName) {
  const p = path.join(CHARACTER_ROOT, characterName, 'fixes.json');
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (Array.isArray(data.whiteDiffuse)) return { whiteDiffuse: data.whiteDiffuse.filter((x) => typeof x === 'string') };
    console.warn(`[pet] 角色 "${characterName}" 的 fixes.json 格式不对（缺少 whiteDiffuse 数组），已忽略`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[pet] 角色 "${characterName}" 的 fixes.json 解析失败: ${err.message}`);
    }
  }
  return null;
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
  loadPhysicsTweaks,
};
