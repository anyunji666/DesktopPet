// ---------- AI 对话：角色人设 / 聊天记录持久化 / 聊天图片持久化 ----------
// 聊天记录持久化路径：用户数据目录下单独一个 chat-history/ 文件夹，和角色资源目录分开，
// 方便以后单独清档/备份，不会和角色的模型/语音等资源混在一起。
// 懒加载（用到时才取 app.getPath），跟 config.js 的 getConfigPath 保持一致的写法。
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { CHARACTER_ROOT } = require('./character');

let chatDirCache = null;
function getChatDir() {
  if (!chatDirCache) chatDirCache = path.join(app.getPath('userData'), 'chat-history');
  return chatDirCache;
}

// 读取角色人设文件（Character/<角色名>/persona.json，可选，格式为 { "system": "……" }）
// 返回 string（有人设）或 null（没配置/格式不对）
function readPersonaFile(characterName) {
  const p = path.join(CHARACTER_ROOT, characterName, 'persona.json');
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (data && typeof data.system === 'string' && data.system.trim()) return data.system.trim();
    console.warn(`[pet] 角色 "${characterName}" 的 persona.json 格式不对（应为 { "system": "..." }），已忽略`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[pet] 角色 "${characterName}" 的 persona.json 解析失败: ${err.message}`);
    }
  }
  return null;
}

// 读取拼进 prompt 的角色资料：没填（没有 persona.json）就返回空字符串，调用方据此不发送角色资料
function loadPersona(characterName) {
  return readPersonaFile(characterName) || '';
}

// 保存角色人设：空文本时删除 persona.json（之后不再发送角色资料）
function savePersonaFile(characterName, system) {
  const p = path.join(CHARACTER_ROOT, characterName, 'persona.json');
  if (!system) {
    try {
      fs.unlinkSync(p);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    return;
  }
  fs.writeFileSync(p, JSON.stringify({ system }, null, 2), 'utf-8');
}

function chatHistoryPath(characterName) {
  const dir = getChatDir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, characterName + '.json');
}

// 全量聊天记录（不做截断/压缩，发给 LLM 的也是全量历史）
function loadChatHistory(characterName) {
  try {
    const data = JSON.parse(fs.readFileSync(chatHistoryPath(characterName), 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[pet] 角色 "${characterName}" 的聊天记录读取失败: ${err.message}`);
    }
    return [];
  }
}

function saveChatHistory(characterName, history) {
  try {
    fs.writeFileSync(chatHistoryPath(characterName), JSON.stringify(history, null, 2));
  } catch (err) {
    console.error(`[pet] 保存聊天记录失败: ${err.message}`);
  }
}

// ---------- 历史摘要缓存：chat-history/<角色名>-summaries.json，{ "YYYY-MM-DD": "摘要文本" } ----------
// 跨天时把"刚结束那天"的原文摘要一次并缓存在这里，之后 flattenChatHistory 摊平历史时，
// 不在展开范围内的天直接读这里的摘要，不用每次都重新让 LLM 总结。
function summaryPath(characterName) {
  const dir = getChatDir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, characterName + '-summaries.json');
}

function loadDaySummaries(characterName) {
  try {
    const data = JSON.parse(fs.readFileSync(summaryPath(characterName), 'utf-8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[pet] 角色 "${characterName}" 的历史摘要读取失败: ${err.message}`);
    }
    return {};
  }
}

// 取某一天的摘要；没生成过返回 null（调用方据此决定是否显示占位文案）
function loadDaySummary(characterName, dayKey) {
  const all = loadDaySummaries(characterName);
  return typeof all[dayKey] === 'string' && all[dayKey] ? all[dayKey] : null;
}

function saveDaySummary(characterName, dayKey, text) {
  const all = loadDaySummaries(characterName);
  all[dayKey] = text;
  try {
    fs.writeFileSync(summaryPath(characterName), JSON.stringify(all, null, 2));
  } catch (err) {
    console.error(`[pet] 保存历史摘要失败: ${err.message}`);
  }
}

// 清空角色全部聊天记录时，摘要缓存也一起清掉
function clearDaySummaries(characterName) {
  try {
    fs.unlinkSync(summaryPath(characterName));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[pet] 清空历史摘要失败: ${err.message}`);
  }
}

// ---------- 打开的封印包槽位：chat-history/<角色名>-opened-day.json ----------
// 用户提到某个已封印的日期时，把那天记在这里、标成"当前打开"，直到过了自然日自动失效——
// 让"展开"这件事跨轮持久，而不是像 date-detect.js 那样只在提到日期的当轮临时生效。
// 全局只有一个槽位（同一时间只能展开一个非今天/非上一个封印包的日子），格式：
// { "dayKey": "被展开的那天", "markedOnDay": "标记发生在哪个自然日，用于判断是否已过期" }
function openedDayPath(characterName) {
  const dir = getChatDir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, characterName + '-opened-day.json');
}

// 读取当前槽位；没有/格式不对返回 null，是否过期由调用方拿 markedOnDay 跟当前 todayKey 比较判断
function loadOpenedDay(characterName) {
  try {
    const data = JSON.parse(fs.readFileSync(openedDayPath(characterName), 'utf-8'));
    if (data && typeof data.dayKey === 'string' && typeof data.markedOnDay === 'string') return data;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[pet] 角色 "${characterName}" 的打开槽读取失败: ${err.message}`);
    }
  }
  return null;
}

function saveOpenedDay(characterName, dayKey, markedOnDay) {
  try {
    fs.writeFileSync(openedDayPath(characterName), JSON.stringify({ dayKey, markedOnDay }, null, 2));
  } catch (err) {
    console.error(`[pet] 保存打开槽失败: ${err.message}`);
  }
}

function clearOpenedDay(characterName) {
  try {
    fs.unlinkSync(openedDayPath(characterName));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[pet] 清空打开槽失败: ${err.message}`);
  }
}

// ---------- Hot 记忆索引：chat-history/<角色名>-memory.md ----------
// 常驻塞进每轮固定前缀区发给 LLM 的一份"指针型"记忆，只存"用户偏好/重要设定"这类没有时效性、需要长期
// 记住的结论性信息，不存对话细节本身（细节走按天摘要那条链路）。
// 标签风格：一行一条，每条不超过 20 字，不是完整句子。总量上限 200 字——足够放约 10 条标签，
// 常驻发送也不会占太多 token。超限时从最旧的一整行开始丢，绝不切在行中间。
const MEMORY_MAX_CHARS = 200;
const MEMORY_TAG_MAX_CHARS = 20;

function memoryPath(characterName) {
  const dir = getChatDir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, characterName + '-memory.md');
}

// 从头部整行丢弃直到不超过 maxChars，保留最新内容
function trimToCharLimit(text, maxChars) {
  if (text.length <= maxChars) return text;
  const lines = text.split('\n');
  while (lines.length > 1 && lines.join('\n').length > maxChars) lines.shift();
  return lines.join('\n');
}

function loadMemoryIndex(characterName) {
  try {
    return fs.readFileSync(memoryPath(characterName), 'utf-8');
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[pet] 角色 "${characterName}" 的记忆索引读取失败: ${err.message}`);
    return '';
  }
}

// 整份覆盖保存（预留给"设置"里手动编辑用），同样做字符上限截断
function saveMemoryIndex(characterName, text) {
  const trimmed = trimToCharLimit(typeof text === 'string' ? text : '', MEMORY_MAX_CHARS);
  try {
    fs.writeFileSync(memoryPath(characterName), trimmed, 'utf-8');
  } catch (err) {
    console.error(`[pet] 保存记忆索引失败: ${err.message}`);
  }
}

// 追加若干条新记忆（去重：整行已经出现在现有内容里的直接跳过），单条超过 20 字就截断成标签长度，
// 总量超限时自动从头部丢旧行。由跨天摘要那次 LLM 调用顺带产出，不单独发起请求。
function appendMemoryLines(characterName, newLines) {
  if (!Array.isArray(newLines) || !newLines.length) return;
  const cur = loadMemoryIndex(characterName);
  const toAdd = newLines
    .map((l) => (typeof l === 'string' ? l.trim().slice(0, MEMORY_TAG_MAX_CHARS) : ''))
    .filter((l) => l && !cur.includes(l));
  if (!toAdd.length) return;
  const merged = (cur ? cur.replace(/\n+$/, '') + '\n' : '') + toAdd.join('\n') + '\n';
  saveMemoryIndex(characterName, merged);
}

function clearMemoryIndex(characterName) {
  try {
    fs.unlinkSync(memoryPath(characterName));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[pet] 清空记忆索引失败: ${err.message}`);
  }
}

// ---------- 聊天图片：存 chat-history/images/<角色名>/ 下，消息里只记文件名 ----------
// 图片是 dataURL 传进来的（渲染进程选文件/粘贴后本地读出），存成独立文件避免聊天记录 JSON 被撑爆。
function chatImageDir(characterName) {
  const dir = path.join(getChatDir(), 'images', characterName);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const IMAGE_MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

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
  const dir = path.join(getChatDir(), 'images', characterName);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[pet] 清空角色图片失败: ${err.message}`);
  }
}

module.exports = {
  getChatDir,
  readPersonaFile,
  loadPersona,
  savePersonaFile,
  chatHistoryPath,
  loadChatHistory,
  saveChatHistory,
  loadDaySummary,
  saveDaySummary,
  clearDaySummaries,
  loadOpenedDay,
  saveOpenedDay,
  clearOpenedDay,
  loadMemoryIndex,
  saveMemoryIndex,
  appendMemoryLines,
  clearMemoryIndex,
  chatImageDir,
  saveChatImage,
  readChatImageDataURL,
  deleteChatImage,
  clearChatImages,
};
