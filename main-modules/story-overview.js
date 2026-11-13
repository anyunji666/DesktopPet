// ---------- 大总结（剧情总览 / 对话总览）：小总结攒够字数后，再压缩成一份总览 ----------
// 发给模型的历史分三层（见 history-flatten.js 的 analyzeHistory）：大总结 → 小总结 → 还没压缩的内容 + 最近几轮原文。
// 小总结每条约 500 字，条数多了会越攒越长；这里负责"再压缩一层"：
// 还没并进大总结的小总结加起来超过 MERGE_THRESHOLD_CHARS 字，就把"上一版大总结 + 这批小总结"交给 LLM，
// 提炼成一份不超过 1200 字的新总览，并把水位线 coveredUntil 前移到这批里最晚一条小总结覆盖的最后一条消息——
// 之后这些小总结不再单独发送。小总结本身仍留在磁盘上，大总结出问题时随时可以重做。
// 合并由 summarizer.js 在回复落档之后的后台任务里执行，不阻塞发送。
// 合并失败（接口报错 / 输出太长 / 空输出）不会影响对话：水位线不动，那几条小总结照常发送，下一轮回复后再试。
// 后台合并期间用户可能改了小总结（编辑 / 删除历史会作废对应小总结）或手动改了大总结：写盘前核对，对不上就丢弃这次结果。
const { loadStoryOverview, saveStoryOverview, loadSmallSummaries, STORY_OVERVIEW_MAX_CHARS } = require('./chat-store');
const { buildOverviewPrompt } = require('./llm');
const { callLLM } = require('./llm-client');
const { getChatMode } = require('./chat-mode');
const { MERGE_THRESHOLD_CHARS } = require('./summary-config');

// 还没并进大总结的小总结（水位线之后的），按时间从早到晚
function unmergedSmallSummaries(characterName) {
  const { coveredUntil } = loadStoryOverview(characterName);
  return loadSmallSummaries(characterName).filter((s) => s.toTs > coveredUntil);
}

// 要不要合并：没并入大总结的小总结总字数超过阈值
function needsOverviewMerge(characterName) {
  return unmergedSmallSummaries(characterName).reduce((n, it) => n + it.text.length, 0) > MERGE_THRESHOLD_CHARS;
}

// 去掉模型可能多带的"新剧情总览："之类的前缀 / 回显的 <story_history> 标签 / 首尾空白
function cleanOverviewText(raw) {
  return String(raw || '')
    .replace(/<\/?(?:story_history|chat_summaries)>/g, '')
    .trim()
    .replace(/^(?:新?剧情总览|新?对话总览|总览)\s*[:：]\s*/, '')
    .trim();
}

// 执行一次合并；成功写盘并返回新总览，没有可合并的内容 / 结果已过期被丢弃返回 null，失败抛错（调用方负责兜住）
async function mergeStoryOverview(characterName, mode = getChatMode(characterName)) {
  const items = unmergedSmallSummaries(characterName);
  if (!items.length) return null;
  const prev = loadStoryOverview(characterName);
  const last = items[items.length - 1];
  const coveredUntil = last.toTs;
  const coveredLabel = last.endLabel;

  let text = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await callLLM(
      [{ role: 'user', content: buildOverviewPrompt(prev.text, prev.coveredLabel, items, attempt > 0, mode) }],
      `${mode === 'chat' ? '对话总览' : '剧情总览'} - ${characterName}`
    );
    text = cleanOverviewText(raw);
    if (text && text.length <= STORY_OVERVIEW_MAX_CHARS) break; // 偶尔略超 1200 字可以接受，超过上限才重试
    text = '';
  }
  if (!text) throw new Error('大总结生成失败：模型输出为空或超出字数上限');

  // 写盘前核对（下面到写盘之间没有 await）：模式没切、大总结没被手动改过、这批小总结都还在
  if (getChatMode(characterName) !== mode) return null;
  const now = loadStoryOverview(characterName);
  if (now.text !== prev.text || now.coveredUntil !== prev.coveredUntil) return null;
  const present = unmergedSmallSummaries(characterName);
  const same = items.every((it) => present.some((p) => p.fromTs === it.fromTs && p.toTs === it.toTs && p.text === it.text));
  if (!same) return null;

  saveStoryOverview(characterName, { text, coveredUntil, coveredLabel });
  return { text, coveredUntil, coveredLabel };
}

// 兜住合并的任何错误：失败只记一笔，不影响对话
async function tryMergeStoryOverview(characterName, mode) {
  try {
    return await mergeStoryOverview(characterName, mode);
  } catch (err) {
    console.warn(`[pet] 角色 "${characterName}" 的大总结合并失败（小总结照常发送，下一轮再试）: ${err.message}`);
    return null;
  }
}

module.exports = { needsOverviewMerge, tryMergeStoryOverview };
