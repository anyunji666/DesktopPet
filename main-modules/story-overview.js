// ---------- 剧情总览：日总结攒够字数后，再压缩成一份总览 ----------
// 发给模型的历史分三层（见 history-flatten.js 的 flattenChatHistory）：剧情总览 → 日总结 → 最近的对话原文。
// 日总结每天一段（约 200 字），天数多了会越攒越长；这里负责"再压缩一层"：
// 还没并进总览的日总结加起来超过 MERGE_THRESHOLD_CHARS 字，就把"上一版总览 + 这批日总结"交给 LLM，
// 提炼成一份不超过 1200 字的新总览，并把水位线 coveredUntil 前移到这批里最晚的一天——
// 之后这些天的日总结不再单独发送。日总结本身仍留在磁盘上，总览出问题时随时可以重做。
// 合并在跨天总结之后、生成回复之前串行执行（chat-turn.js），仍在聊天锁内，不会和别的写入冲突。
// 合并失败（接口报错 / 输出太长 / 空输出）不会让这一轮对话失败：水位线不动，那几天的日总结照常发送，
// 下一次发消息时再试（失败后 30 分钟内不重试，免得接口一直不稳时每条消息都多等一次）。
const { loadStoryOverview, saveStoryOverview, STORY_OVERVIEW_MAX_CHARS } = require('./chat-store');
const { collectUnmergedSummaries } = require('./history-flatten');
const { buildOverviewPrompt } = require('./llm');
const { callLLM } = require('./llm-client');
const { getChatMode } = require('./chat-mode');

const MERGE_THRESHOLD_CHARS = 2000; // 未并入总览的日总结总字数超过这个数就触发合并
const RETRY_COOLDOWN_MS = 30 * 60 * 1000;
const failedAt = new Map(); // 角色名 -> 上次合并失败的时间（只在内存里，重启后清零）

// 要不要合并：没并入总览的日总结（早于"上一天"、晚于水位线）总字数超过阈值
function needsOverviewMerge(characterName, history) {
  const items = collectUnmergedSummaries(characterName, history);
  return items.reduce((n, it) => n + it.text.length, 0) > MERGE_THRESHOLD_CHARS;
}

// 上次合并刚失败不久：只用于"上次欠下的合并"要不要在新消息里重试；跨天刚生成新日总结时总会尝试一次
function mergeCoolingDown(characterName) {
  const t = failedAt.get(characterName);
  return t !== undefined && Date.now() - t < RETRY_COOLDOWN_MS;
}

// 去掉模型可能多带的"新剧情总览："之类的前缀 / 回显的 <story_history> 标签 / 首尾空白
function cleanOverviewText(raw) {
  return String(raw || '')
    .replace(/<\/?(?:story_history|chat_summaries)>/g, '')
    .trim()
    .replace(/^(?:新?剧情总览|新?对话总览|总览)\s*[:：]\s*/, '')
    .trim();
}

// 执行一次合并；成功写盘并返回新总览，没有可合并的内容返回 null，失败抛错（调用方负责兜住）
async function mergeStoryOverview(characterName, history) {
  const items = collectUnmergedSummaries(characterName, history);
  if (!items.length) return null;
  const prev = loadStoryOverview(characterName);
  const coveredUntil = items[items.length - 1].dayKey;
  const mode = getChatMode(characterName); // 网聊模式下总览按"聊天总结"的口径写

  let text = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await callLLM(
      [{ role: 'user', content: buildOverviewPrompt(prev.text, prev.coveredUntil, items, attempt > 0, mode) }],
      `剧情总览 - ${characterName}`
    );
    text = cleanOverviewText(raw);
    if (text && text.length <= STORY_OVERVIEW_MAX_CHARS) break; // 偶尔略超 1200 字可以接受，超过上限才重试
    text = '';
  }
  if (!text) throw new Error('剧情总览生成失败：模型输出为空或超出字数上限');

  saveStoryOverview(characterName, { text, coveredUntil });
  failedAt.delete(characterName);
  return { text, coveredUntil };
}

// 兜住合并的任何错误：失败只记一笔，不影响本轮对话
async function tryMergeStoryOverview(characterName, history) {
  try {
    return await mergeStoryOverview(characterName, history);
  } catch (err) {
    failedAt.set(characterName, Date.now());
    console.warn(`[pet] 角色 "${characterName}" 的剧情总览合并失败（日总结照常发送，稍后重试）: ${err.message}`);
    return null;
  }
}

module.exports = { MERGE_THRESHOLD_CHARS, needsOverviewMerge, mergeCoolingDown, tryMergeStoryOverview };
