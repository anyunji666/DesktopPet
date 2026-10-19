// ---------- 角色：扫描 Character/ 目录 + 读取各角色的台词/语音/骨骼屏蔽/材质修正配置 ----------
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CHARACTER_ROOT = path.join(ROOT, 'Character');

// ---------- 扫描角色（Character/<角色名>/ 下最大的 .pmx 作为本体模型） ----------
function pickModelFile(dir) {
  const files = fs.readdirSync(dir).filter((f) => /\.pmx$/i.test(f));
  if (!files.length) return null;
  files.sort((a, b) => fs.statSync(path.join(dir, b)).size - fs.statSync(path.join(dir, a)).size);
  return files[0];
}

function scanCharacters() {
  if (!fs.existsSync(CHARACTER_ROOT)) {
    throw new Error('找不到角色目录: ' + CHARACTER_ROOT);
  }
  const characters = [];
  for (const name of fs.readdirSync(CHARACTER_ROOT)) {
    const dir = path.join(CHARACTER_ROOT, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const modelFile = pickModelFile(dir);
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

module.exports = {
  CHARACTER_ROOT,
  pickModelFile,
  scanCharacters,
  loadQuotes,
  loadVoices,
  loadDrinkReminders,
  loadMaterialFixes,
};
