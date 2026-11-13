// ---------- AI 对话：角色人设 / 聊天记录持久化 / 聊天图片持久化 ----------
// 聊天记录持久化路径：用户数据目录下单独一个 chat-history/ 文件夹，和角色资源目录分开，
// 方便以后单独清档/备份，不会和角色的模型/语音等资源混在一起。
// 懒加载（用到时才取 app.getPath），跟 config.js 的 getConfigPath 保持一致的写法。
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { CHARACTER_ROOT } = require('./character');
const { assertSafeName } = require('./security');
const { getChatMode } = require('./chat-mode');

let chatDirCache = null;
function getChatDir() {
  if (!chatDirCache) chatDirCache = path.join(app.getPath('userData'), 'chat-history');
  return chatDirCache;
}

// 角色别名（多角色语音用）：用户在设置窗口里填的"这个角色的其他称呼"，比如角色文件夹叫 TohsakaRin，
// 别名可以写 远坂凛、凛。接受数组或用 , ， 、 ; ； 换行 分隔的字符串，去空/去重/限长/限个数。
function parseAliases(input) {
  const list = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[,，、;；\n]+/) : [];
  const out = [];
  for (const a of list) {
    if (typeof a !== 'string') continue;
    const t = a.trim();
    if (t && t.length <= 20 && !/[「」：:\n]/.test(t) && !out.includes(t)) out.push(t);
    if (out.length >= 8) break;
  }
  return out;
}

// 读取角色人设文件（Character/<角色名>/persona.json，可选，格式为 { "system": "……", "storyBackground": "……", "aliases": ["……"], "readerInfo": "……" }）
// system = 角色的个人资料，storyBackground = 角色所处的世界背景，aliases = 别名，readerInfo = 用户在这个角色面前扮演的身份（你的资料），都跟随角色存档、非全局。
// 返回 { system, storyBackground, aliases, readerInfo }，缺失/解析失败时文本字段是空字符串、aliases 是空数组。
function readPersonaFile(characterName) {
  const p = path.join(CHARACTER_ROOT, assertSafeName(characterName), 'persona.json');
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const system = data && typeof data.system === 'string' ? data.system.trim() : '';
    const storyBackground = data && typeof data.storyBackground === 'string' ? data.storyBackground.trim() : '';
    const readerInfo = data && typeof data.readerInfo === 'string' ? data.readerInfo.trim() : '';
    return { system, storyBackground, aliases: parseAliases(data && data.aliases), readerInfo };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[pet] 角色 "${characterName}" 的 persona.json 解析失败: ${err.message}`);
    }
    return { system: '', storyBackground: '', aliases: [], readerInfo: '' };
  }
}

// 读取拼进 prompt 的角色资料（<character_card>）：没填就返回空字符串，调用方据此不发送
function loadPersona(characterName) {
  return readPersonaFile(characterName).system;
}

// 读取拼进 prompt 的世界背景（<story_background>）：没填就返回空字符串，调用方据此不发送
function loadStoryBackground(characterName) {
  return readPersonaFile(characterName).storyBackground;
}

// 读取拼进 prompt 的"你的资料"（<user_persona>）：跟随角色，没填就返回空字符串，调用方据此不发送
function loadReaderInfo(characterName) {
  return readPersonaFile(characterName).readerInfo;
}

// 保存角色人设 / 世界背景 / 别名 / 你的资料：四者都空时删除 persona.json（之后不再发送这些内容）
function savePersonaFile(characterName, { system, storyBackground, aliases, readerInfo } = {}) {
  const p = path.join(CHARACTER_ROOT, assertSafeName(characterName), 'persona.json');
  const sys = typeof system === 'string' ? system.trim() : '';
  const bg = typeof storyBackground === 'string' ? storyBackground.trim() : '';
  const al = parseAliases(aliases);
  const reader = typeof readerInfo === 'string' ? readerInfo.trim() : '';
  if (!sys && !bg && !al.length && !reader) {
    try {
      fs.unlinkSync(p);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    return;
  }
  fs.writeFileSync(p, JSON.stringify({ system: sys, storyBackground: bg, aliases: al, readerInfo: reader }, null, 2), 'utf-8');
}

// 故事模式和网聊模式的聊天数据（聊天记录 / 小总结 / 大总结 / 图片 / 语音）分开存、互不打扰：
// 故事模式沿用原来的文件名（<角色名>…，老用户的数据不用迁移），网聊模式在角色名后面加 @chat（<角色名>@chat…）。
// 下面所有按角色存取的路径都经过 storeName，按"当前模式"自动选；mode 参数可选，显式指定时不看当前模式
// （资产配置这类只属于故事模式的功能固定传 'story'）。附加要求（__global-memory.md）本来就是全局的，两个模式共用。
const CHAT_MODE_SUFFIX = '@chat';
function storeName(characterName, mode) {
  const base = assertSafeName(characterName);
  return (mode || getChatMode(characterName)) === 'chat' ? base + CHAT_MODE_SUFFIX : base;
}

function chatHistoryPath(characterName, mode) {
  const dir = getChatDir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, storeName(characterName, mode) + '.json');
}

// 全量聊天记录（不做截断/压缩，发给 LLM 的也是全量历史）
function loadChatHistory(characterName, mode) {
  try {
    const data = JSON.parse(fs.readFileSync(chatHistoryPath(characterName, mode), 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[pet] 角色 "${characterName}" 的聊天记录读取失败: ${err.message}`);
      // 文件存在但解析失败（损坏）：先留一份备份，否则下一次保存会把它覆盖成空记录，数据就彻底丢了
      if (err instanceof SyntaxError) backupCorruptFile(chatHistoryPath(characterName, mode));
    }
    return [];
  }
}

// 聊天记录写盘后的监听（main.js 注册，用来通知已打开的资产配置窗口：故事时间可能变了）
let historySavedListener = null;
function onChatHistorySaved(cb) {
  historySavedListener = typeof cb === 'function' ? cb : null;
}

// 把损坏的文件改名留底（<原名>.corrupt-<时间戳>），同一个损坏文件只备份一次（改名后原路径就不在了）
function backupCorruptFile(filePath) {
  try {
    fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
  } catch (e) {
    console.warn(`[pet] 备份损坏文件失败: ${e.message}`);
  }
}

// 原子写入：先写临时文件再改名，写到一半断电 / 崩溃 / 磁盘满时不会留下半截文件
function writeFileAtomic(filePath, data) {
  const tmp = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

// 写盘失败要抛出去：调用方（编辑 / 删除 / 对话落盘）据此报错，而不是误以为已经保存
function saveChatHistory(characterName, history) {
  try {
    writeFileAtomic(chatHistoryPath(characterName), JSON.stringify(history, null, 2));
  } catch (err) {
    console.error(`[pet] 保存聊天记录失败: ${err.message}`);
    throw new Error('保存聊天记录失败：' + err.message);
  }
  // 只有写盘成功才通知监听（失败已经抛出，不会走到这里）。监听方（资产配置窗口）只关心故事时间，网聊模式的记录不通知
  if (historySavedListener && getChatMode(characterName) === 'story') {
    try {
      historySavedListener(characterName, history);
    } catch (err) {
      console.warn(`[pet] 聊天记录保存监听出错: ${err.message}`);
    }
  }
}

// ---------- 小总结：chat-history/<角色名>-summaries.json，{ "version": 2, "items": [ { fromTs, toTs, text, label, endLabel } ] } ----------
// 未压缩部分（见 summary-config.js）超过字数线时，summarizer.js 把最老的一批消息压成一条小总结存在这里。
// fromTs / toTs 是这条小总结覆盖的第一条 / 最后一条消息的时间戳（ts），范围内的消息不再单独发送；
// label 是标题里的时间区间（"9月27日 10:00～9月28日 9:00"，故事模式取故事时间），endLabel 是区间终点，合并进大总结时拿来当标题。
// 小总结并进大总结之后仍留在磁盘上（toTs <= 大总结水位线的不再发送），大总结出问题时随时有素材可以重做。
function summaryPath(characterName) {
  const dir = getChatDir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, storeName(characterName) + '-summaries.json');
}

function cleanSmallSummary(it) {
  if (!it || typeof it !== 'object') return null;
  const text = typeof it.text === 'string' ? it.text.trim() : '';
  if (!text || !Number.isFinite(it.fromTs) || !Number.isFinite(it.toTs) || it.toTs < it.fromTs) return null;
  return {
    fromTs: it.fromTs,
    toTs: it.toTs,
    text,
    label: typeof it.label === 'string' ? it.label : '',
    endLabel: typeof it.endLabel === 'string' ? it.endLabel : '',
  };
}

// 读取全部小总结（含已并入大总结的），按起始时间从早到晚；没有 / 格式不对返回空数组
function loadSmallSummaries(characterName) {
  try {
    const data = JSON.parse(fs.readFileSync(summaryPath(characterName), 'utf-8'));
    const raw = data && Array.isArray(data.items) ? data.items : [];
    return raw.map(cleanSmallSummary).filter(Boolean).sort((x, y) => x.fromTs - y.fromTs);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[pet] 角色 "${characterName}" 的小总结读取失败: ${err.message}`);
      if (err instanceof SyntaxError) backupCorruptFile(summaryPath(characterName));
    }
    return [];
  }
}

// 整份覆盖保存；写盘失败要抛出去（后台整理据此知道这次没存上）
function saveSmallSummaries(characterName, items) {
  const clean = (Array.isArray(items) ? items : []).map(cleanSmallSummary).filter(Boolean).sort((x, y) => x.fromTs - y.fromTs);
  try {
    writeFileAtomic(summaryPath(characterName), JSON.stringify({ version: 2, items: clean }, null, 2));
  } catch (err) {
    console.error(`[pet] 保存小总结失败: ${err.message}`);
    throw new Error('保存小总结失败：' + err.message);
  }
}

function appendSmallSummary(characterName, item) {
  const all = loadSmallSummaries(characterName);
  all.push(item);
  saveSmallSummaries(characterName, all);
}

// 用户编辑 / 删除了某些消息：覆盖过这些消息的小总结已经和原文对不上，直接作废，这段消息重新参与字数统计。
// 已经并进大总结的（toTs <= 水位线）不回溯——那份内容已经融进大总结里了，作废它没有意义。
// tsList 是被改动消息的时间戳；返回作废了几条
function invalidateSmallSummaries(characterName, tsList) {
  const stamps = (Array.isArray(tsList) ? tsList : []).filter((t) => Number.isFinite(t));
  if (!stamps.length) return 0;
  const all = loadSmallSummaries(characterName);
  if (!all.length) return 0;
  const { coveredUntil } = loadStoryOverview(characterName);
  const keep = all.filter((s) => s.toTs <= coveredUntil || !stamps.some((t) => t >= s.fromTs && t <= s.toTs));
  const removed = all.length - keep.length;
  if (removed > 0) saveSmallSummaries(characterName, keep);
  return removed;
}

// 清空角色全部聊天记录时，小总结也一起清掉
function clearSmallSummaries(characterName) {
  try {
    fs.unlinkSync(summaryPath(characterName));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[pet] 清空小总结失败: ${err.message}`);
  }
}

// ---------- 大总结（剧情总览 / 对话总览）：chat-history/<角色名>-story-overview.json ----------
// 小总结攒到一定字数后，由 story-overview.js 把"上一版大总结 + 这批小总结"再压缩成一份不超过 1200 字的总览，存在这里：
//   { "text": "总览正文", "coveredUntil": 时间戳, "coveredLabel": "标题里显示的时间点" }
// coveredUntil 是水位线（消息时间戳）：这个时间点（含）以前的消息和小总结都已经并进 text，之后不再单独发给模型；
// 只有合并成功才会前移水位线，合并失败时那几条小总结照常发送，不会丢内容。
// 用户也可以在聊天记录窗口的"⋯ → 剧情总览 / 对话总览"里手动改 text，水位线不受影响。
const STORY_OVERVIEW_MAX_CHARS = 1600; // 总览正文上限（提示词要求 AI 控制在 1200 字内，留一点余量；手动保存同样按这个上限）

function storyOverviewPath(characterName) {
  const dir = getChatDir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, storeName(characterName) + '-story-overview.json');
}

// 读取总览；没有/格式不对返回 { text: '', coveredUntil: 0, coveredLabel: '' }（调用方据此不发送这一段）
function loadStoryOverview(characterName) {
  try {
    const data = JSON.parse(fs.readFileSync(storyOverviewPath(characterName), 'utf-8'));
    const text = data && typeof data.text === 'string' ? data.text.trim() : '';
    const coveredUntil = data && Number.isFinite(data.coveredUntil) && data.coveredUntil > 0 ? data.coveredUntil : 0;
    const coveredLabel = data && typeof data.coveredLabel === 'string' ? data.coveredLabel : '';
    return { text, coveredUntil, coveredLabel: coveredUntil ? coveredLabel : '' };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[pet] 角色 "${characterName}" 的大总结读取失败: ${err.message}`);
      if (err instanceof SyntaxError) backupCorruptFile(storyOverviewPath(characterName)); // 损坏的留底，免得下一次保存把它盖掉
    }
    return { text: '', coveredUntil: 0, coveredLabel: '' };
  }
}

// 写盘失败要抛出去：合并 / 手动保存据此报错，而不是误以为已经保存（用原子写入，写到一半不会留下半截文件）
function saveStoryOverview(characterName, { text, coveredUntil, coveredLabel }) {
  const t = typeof text === 'string' ? text.trim() : '';
  const c = Number.isFinite(coveredUntil) && coveredUntil > 0 ? coveredUntil : 0;
  const l = c && typeof coveredLabel === 'string' ? coveredLabel : '';
  try {
    writeFileAtomic(storyOverviewPath(characterName), JSON.stringify({ text: t, coveredUntil: c, coveredLabel: l }, null, 2));
  } catch (err) {
    console.error(`[pet] 保存大总结失败: ${err.message}`);
    throw new Error('保存大总结失败：' + err.message);
  }
}

// 清空角色全部聊天记录 / 导入覆盖时，大总结一起清掉
function clearStoryOverview(characterName) {
  try {
    fs.unlinkSync(storyOverviewPath(characterName));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[pet] 清空大总结失败: ${err.message}`);
  }
}

// ---------- Hot 记忆索引（附加要求）：chat-history/__global-memory.md，全局共用、不区分角色 ----------
// 文件名带双下划线开头，避免和某个叫 global 的角色的 <角色名>-xxx.md 文件撞名。
// 常驻塞进每轮固定前缀区发给 LLM 的一份"指针型"记忆，只存"用户偏好/重要设定"这类没有时效性、需要长期
// 记住的结论性信息，不存对话细节本身（细节走小总结 / 大总结那条链路）。
// 标签风格：一行一条，每条不超过 20 字，不是完整句子。总量上限 200 字——足够放约 10 条标签，
// 常驻发送也不会占太多 token。超限时从最旧的一整行开始丢，绝不切在行中间。
const MEMORY_MAX_CHARS = 200;
const MEMORY_TAG_MAX_CHARS = 20;

// 附加要求也按聊天模式分成两份（跨角色共用，但故事模式和网聊模式各读各的）：
// 故事模式 __global-memory.md（原文件，不用迁移），网聊模式 __global-memory@chat.md。mode 省略 = 'story'。
function memoryPath(mode) {
  const dir = getChatDir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, mode === 'chat' ? '__global-memory@chat.md' : '__global-memory.md');
}

// 从头部整行丢弃直到不超过 maxChars，保留最新内容
function trimToCharLimit(text, maxChars) {
  if (text.length <= maxChars) return text;
  const lines = text.split('\n');
  while (lines.length > 1 && lines.join('\n').length > maxChars) lines.shift();
  return lines.join('\n');
}

function loadMemoryIndex(mode) {
  try {
    return fs.readFileSync(memoryPath(mode), 'utf-8');
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[pet] 附加要求（记忆索引）读取失败: ${err.message}`);
    return '';
  }
}

// 整份覆盖保存（预留给"设置"里手动编辑用），同样做字符上限截断
function saveMemoryIndex(text, mode) {
  const trimmed = trimToCharLimit(typeof text === 'string' ? text : '', MEMORY_MAX_CHARS);
  try {
    fs.writeFileSync(memoryPath(mode), trimmed, 'utf-8');
  } catch (err) {
    console.error(`[pet] 保存记忆索引失败: ${err.message}`);
  }
}

// 规整用户手动编辑的附加要求：每行去首尾空白、丢掉空行，行与行之间用单个换行连接。
// 设置页的字数计数和这里的上限校验都以这份规整后的文本为准，两边口径一致。
function normalizeMemoryText(text) {
  return (typeof text === 'string' ? text : '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

// 用户在设置页手动保存附加要求：跟自动追加不同，超过上限时不静默丢行，而是直接抛错让界面提示，
// 免得用户改完发现少了几行。规整后为空 = 删除文件（之后不再发送 <memory_index>）。
function saveMemoryIndexManual(text, mode) {
  const normalized = normalizeMemoryText(text);
  if (normalized.length > MEMORY_MAX_CHARS) {
    throw new Error(`附加要求超过 ${MEMORY_MAX_CHARS} 字上限（当前 ${normalized.length} 字），请删减后再保存`);
  }
  if (!normalized) {
    clearMemoryIndex(mode);
    return;
  }
  try {
    fs.writeFileSync(memoryPath(mode), normalized, 'utf-8');
  } catch (err) {
    console.error(`[pet] 保存附加要求失败: ${err.message}`);
    throw new Error('保存附加要求失败：' + err.message);
  }
}

// 追加若干条新记忆（去重：整行已经出现在现有内容里的直接跳过），单条超过 20 字就截断成标签长度，
// 总量超限时自动从头部丢旧行。由生成小总结那次 LLM 调用顺带产出，不单独发起请求。
function appendMemoryLines(newLines, mode) {
  if (!Array.isArray(newLines) || !newLines.length) return;
  const cur = loadMemoryIndex(mode);
  const toAdd = newLines
    .map((l) => (typeof l === 'string' ? l.trim().slice(0, MEMORY_TAG_MAX_CHARS) : ''))
    .filter((l) => l && !cur.includes(l));
  if (!toAdd.length) return;
  const merged = (cur ? cur.replace(/\n+$/, '') + '\n' : '') + toAdd.join('\n') + '\n';
  saveMemoryIndex(merged, mode);
}

function clearMemoryIndex(mode) {
  try {
    fs.unlinkSync(memoryPath(mode));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[pet] 清空记忆索引失败: ${err.message}`);
  }
}

// ---------- 聊天图片：存 chat-history/images/<角色名>/ 下，消息里只记文件名 ----------
// 图片是 dataURL 传进来的（渲染进程选文件/粘贴后本地读出），存成独立文件避免聊天记录 JSON 被撑爆。
function chatImageDir(characterName) {
  const dir = path.join(getChatDir(), 'images', storeName(characterName));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const IMAGE_MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

// 校验并保存 dataURL 图片，返回生成的文件名；格式不对/超过 10MB 抛错
function saveChatImage(characterName, dataURL) {
  const m = /^data:((?:image)\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(typeof dataURL === 'string' ? dataURL : '');
  if (!m) throw new Error('图片格式不正确');
  const mime = m[1].toLowerCase();
  const ext = IMAGE_MIME_EXT[mime];
  if (!ext) throw new Error('不支持的图片格式：' + mime);
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 10 * 1024 * 1024) throw new Error('图片超过 10MB');
  const name = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  fs.writeFileSync(path.join(chatImageDir(characterName), name), buf);
  return name;
}

// 读回 dataURL（get-chat-history 时给记录窗口渲染缩略图用）；文件丢了返回 null
function readChatImageDataURL(characterName, filename) {
  if (typeof filename !== 'string' || /[\\/]|\.\./.test(filename)) return null; // 文件名只允许是单段名字，防路径逃逸
  const ext = path.extname(filename).slice(1).toLowerCase();
  const mime = Object.keys(IMAGE_MIME_EXT).find((k) => IMAGE_MIME_EXT[k] === ext);
  if (!mime) return null;
  try {
    const p = path.join(chatImageDir(characterName), filename);
    if (!fs.existsSync(p)) return null;
    return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
  } catch (err) {
    console.warn(`[pet] 读取聊天图片失败: ${err.message}`);
    return null;
  }
}

function deleteChatImage(characterName, filename) {
  if (typeof filename !== 'string' || /[\\/]|\.\./.test(filename)) return;
  try {
    fs.unlinkSync(path.join(chatImageDir(characterName), filename));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[pet] 删除聊天图片失败: ${err.message}`);
  }
}

// 清空角色全部聊天记录时，把图片文件夹一起清掉
function clearChatImages(characterName) {
  const dir = path.join(getChatDir(), 'images', storeName(characterName));
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[pet] 清空角色图片失败: ${err.message}`);
  }
}

// ---------- 回复语音：存 chat-history/voices/<角色名>/<消息ts>/ 下 ----------
// 跟聊天图片一样存成独立文件，不写进聊天记录 JSON：TTS 是对话落盘之后才异步合成完的，如果这时下一轮对话已经
// 在跑，它落盘时会用旧的历史数组整份覆盖，挂在消息上的语音字段就丢了；按 AI 消息的 ts 单独存就不受影响。
// 编辑消息只改 content、不改 ts，所以编辑后的气泡仍然对应原来的语音。
// 目录里每个「」一个音频文件（0.mp3、1.mp3 ……），meta.json 记各段顺序、格式、阅读时间线位置和旧版相对停顿：
//   { "clips": [ { "file": "0.mp3", "mime": "audio/mpeg", "gapBeforeMs": 0, "readOffsetMs": 0 }, ... ] }
// readOffsetMs 是后加的字段，老缓存没有，播放端检测到缺失就退回用 gapBeforeMs。
// 没调用过 TTS（或全部合成失败）的消息没有这个目录。
function voiceCharDir(characterName) {
  return path.join(getChatDir(), 'voices', storeName(characterName));
}

// ts 只允许是有限数字，转成目录名（防路径逃逸）；不合法返回 null
function voiceDirName(ts) {
  return Number.isFinite(ts) ? String(Math.trunc(ts)) : null;
}

// 保存一条消息的语音；clips = [{ buffer|bytes, mime, gapBeforeMs, readOffsetMs }]（按播放顺序）。已存在的同 ts 语音整个覆盖
function saveChatVoice(characterName, ts, clips) {
  const name = voiceDirName(ts);
  if (!name || !Array.isArray(clips) || !clips.length) return false;
  const dir = path.join(voiceCharDir(characterName), name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const meta = { clips: [] };
  clips.forEach((c, i) => {
    const file = `${i}.mp3`; // 三家服务商目前统一返回 mp3
    fs.writeFileSync(path.join(dir, file), c.buffer || c.bytes);
    const entry = { file, mime: c.mime || 'audio/mpeg', gapBeforeMs: Math.max(0, Number(c.gapBeforeMs) || 0) };
    if (Number.isFinite(c.readOffsetMs)) entry.readOffsetMs = Math.max(0, c.readOffsetMs);
    meta.clips.push(entry);
  });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta)); // meta 最后写：读取时有 meta 才算存好了
  return true;
}

// 读回一条消息的语音，返回 { clips: [{ bytes, mime, gapBeforeMs, readOffsetMs? }] }（老缓存没有 readOffsetMs）；没有 / 读不出来返回 null
function readChatVoice(characterName, ts) {
  const name = voiceDirName(ts);
  if (!name) return null;
  const dir = path.join(voiceCharDir(characterName), name);
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf-8'));
    const clips = [];
    for (const c of meta.clips || []) {
      if (typeof c.file !== 'string' || /[\\/]|\.\./.test(c.file)) continue;
      const clip = { bytes: fs.readFileSync(path.join(dir, c.file)), mime: c.mime || 'audio/mpeg', gapBeforeMs: c.gapBeforeMs || 0 };
      if (Number.isFinite(c.readOffsetMs)) clip.readOffsetMs = c.readOffsetMs;
      clips.push(clip);
    }
    return clips.length ? { clips } : null;
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[pet] 读取回复语音失败: ${err.message}`);
    return null;
  }
}

// 消息被删除时调用：把它的语音一起删掉（没有语音也没关系）
function deleteChatVoice(characterName, ts) {
  const name = voiceDirName(ts);
  if (!name) return;
  try {
    fs.rmSync(path.join(voiceCharDir(characterName), name), { recursive: true, force: true });
  } catch (err) {
    console.warn(`[pet] 删除回复语音失败: ${err.message}`);
  }
}

// 清空角色全部聊天记录 / 导入记录覆盖时，把语音文件夹一起清掉
function clearChatVoices(characterName) {
  try {
    fs.rmSync(voiceCharDir(characterName), { recursive: true, force: true });
  } catch (err) {
    console.warn(`[pet] 清空角色语音失败: ${err.message}`);
  }
}

module.exports = {
  getChatDir,
  readPersonaFile,
  parseAliases,
  loadPersona,
  loadStoryBackground,
  loadReaderInfo,
  savePersonaFile,
  chatHistoryPath,
  loadChatHistory,
  saveChatHistory,
  onChatHistorySaved,
  loadSmallSummaries,
  saveSmallSummaries,
  appendSmallSummary,
  invalidateSmallSummaries,
  clearSmallSummaries,
  STORY_OVERVIEW_MAX_CHARS,
  loadStoryOverview,
  saveStoryOverview,
  clearStoryOverview,
  loadMemoryIndex,
  saveMemoryIndex,
  saveMemoryIndexManual,
  MEMORY_MAX_CHARS,
  appendMemoryLines,
  clearMemoryIndex,
  chatImageDir,
  saveChatImage,
  readChatImageDataURL,
  deleteChatImage,
  clearChatImages,
  saveChatVoice,
  readChatVoice,
  deleteChatVoice,
  clearChatVoices,
};
