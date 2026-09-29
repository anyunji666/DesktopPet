// ---------- 聊天记录导入 / 导出 ----------
// 导出成一个 JSON 文件：消息（图片以 dataURL 内嵌）+ 按天总结 + 长期记忆索引，方便备份 / 换电脑迁移。
// 导入是"整份覆盖"：先把文件完整校验一遍，确认没问题才动现有数据，坏文件不会把原来的记录弄丢。
// 不导出"打开的封印包槽位"：它只是当天有效的临时状态，导入时反而要清掉，避免指向被覆盖掉的历史。
const fs = require('fs');
const {
  loadChatHistory,
  saveChatHistory,
  loadDaySummaries,
  saveDaySummary,
  clearDaySummaries,
  loadMemoryIndex,
  saveMemoryIndex,
  clearMemoryIndex,
  clearOpenedDay,
  saveChatImage,
  readChatImageDataURL,
  clearChatImages,
} = require('./chat-store');

const FORMAT = 'desktop-pet-chat';
const VERSION = 1;
const MAX_IMPORT_BYTES = 300 * 1024 * 1024; // 图片是 base64 内嵌的，文件可能不小；再大就当异常文件
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------- 导出 ----------
function buildExport(characterName) {
  const messages = loadChatHistory(characterName).map((m) => {
    const { image, ...rest } = m;
    // 磁盘上的消息只记图片文件名，导出时读回来内嵌成 dataURL；文件丢了就当纯文字消息
    if (image) {
      const url = readChatImageDataURL(characterName, image);
      if (url) rest.imageDataURL = url;
    }
    return rest;
  });
  return {
    format: FORMAT,
    version: VERSION,
    character: characterName,
    exportedAt: new Date().toISOString(),
    messages,
    daySummaries: loadDaySummaries(characterName),
    memoryIndex: loadMemoryIndex(characterName),
  };
}

function exportToFile(characterName, filePath) {
  const payload = buildExport(characterName);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
  return payload.messages.length;
}

// ---------- 导入：校验 ----------
// 返回清洗后的 { messages, daySummaries, memoryIndex }；格式不对直接抛错（此时还没动任何数据）
function parseImport(data) {
  let rawMessages;
  let rawSummaries = {};
  let rawMemory = '';
  if (Array.isArray(data)) {
    rawMessages = data; // 兼容只有消息数组的简化文件
  } else if (data && typeof data === 'object') {
    if (data.format !== undefined && data.format !== FORMAT) throw new Error('不是桌宠导出的聊天记录文件');
    if (typeof data.version === 'number' && data.version > VERSION) {
      throw new Error('文件版本比当前程序新，请先更新程序再导入');
    }
    rawMessages = data.messages;
    if (data.daySummaries && typeof data.daySummaries === 'object' && !Array.isArray(data.daySummaries)) {
      rawSummaries = data.daySummaries;
    }
    if (typeof data.memoryIndex === 'string') rawMemory = data.memoryIndex;
  } else {
    throw new Error('不是桌宠导出的聊天记录文件');
  }
  if (!Array.isArray(rawMessages)) throw new Error('文件里没有找到聊天消息');

  const messages = [];
  let skipped = 0;
  for (const m of rawMessages) {
    const role = m && m.role;
    const content = m && typeof m.content === 'string' ? m.content : null;
    const imageDataURL = m && typeof m.imageDataURL === 'string' ? m.imageDataURL : '';
    // 只认 user / assistant；文字和图片都没有的空消息没有意义
    if ((role !== 'user' && role !== 'assistant') || content === null || (!content.trim() && !imageDataURL)) {
      skipped++;
      continue;
    }
    messages.push({
      role,
      content,
      ts: Number.isFinite(m.ts) ? m.ts : Date.now(),
      imageDataURL: role === 'user' ? imageDataURL : '', // 目前只有用户消息能带图
    });
  }
  if (!messages.length) throw new Error('文件里没有可导入的有效消息');

  const daySummaries = {};
  for (const [k, v] of Object.entries(rawSummaries)) {
    if (DAY_KEY_RE.test(k) && typeof v === 'string' && v) daySummaries[k] = v;
  }
  return { messages, daySummaries, memoryIndex: rawMemory, skipped };
}

// ---------- 导入：落盘 ----------
function applyImport(characterName, data) {
  const { messages, daySummaries, memoryIndex, skipped } = parseImport(data);

  // 校验通过，才开始动现有数据：整份覆盖，跟"清空对话"清掉的东西保持一致
  clearChatImages(characterName);
  clearDaySummaries(characterName);
  clearMemoryIndex(characterName);
  clearOpenedDay(characterName);

  const history = [];
  let imageFailed = 0;
  for (const m of messages) {
    const entry = { role: m.role, content: m.content, ts: m.ts };
    if (m.imageDataURL) {
      try {
        entry.image = saveChatImage(characterName, m.imageDataURL);
      } catch (err) {
        imageFailed++;
        if (!entry.content.trim()) continue; // 图片存不下来、又没有文字，这条就没内容了
      }
    }
    history.push(entry);
  }
  saveChatHistory(characterName, history);
  for (const [k, v] of Object.entries(daySummaries)) saveDaySummary(characterName, k, v);
  if (memoryIndex.trim()) saveMemoryIndex(characterName, memoryIndex);

  return { count: history.length, skipped, imageFailed };
}

function importFromFile(characterName, filePath) {
  const size = fs.statSync(filePath).size;
  if (size > MAX_IMPORT_BYTES) throw new Error('文件太大，不像是聊天记录导出文件');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    throw new Error('文件不是有效的 JSON');
  }
  return applyImport(characterName, data);
}

module.exports = { exportToFile, importFromFile };
