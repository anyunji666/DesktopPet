// ---------- 后台压缩：回复落档后，未压缩部分超过字数线就压成小总结，再视情况合并进大总结 ----------
// 触发时机：每一轮回复成功落档、聊天锁放开之后（main.js 的 chat-send）调用 startBackgroundCompaction。
// 不阻塞用户：回复已经显示，压缩在后台跑；用户在压缩期间发下一条消息时，chat-turn.js 会先等这个任务跑完再发
// （界面显示"正在整理…"阶段）。
// 失败不影响对话：只记一笔日志，那段内容继续按原样发送，下一轮回复后再试（没有冷却，后台跑不耽误用户）。
// 压缩期间聊天锁是放开的，用户可能编辑 / 删除了正在被压缩的消息、切换了聊天模式、清空或导入了记录：
// 写盘前核对，对不上就丢弃这次结果（见 history-flatten.js 的 runStillValid）。
const { loadChatHistory, appendSmallSummary, appendMemoryLines } = require('./chat-store');
const { planCompaction, runStillValid, parseSummaryAndMemory } = require('./history-flatten');
const { buildSmallSummaryPrompt } = require('./llm');
const { callLLM } = require('./llm-client');
const { getChatMode } = require('./chat-mode');
const { needsOverviewMerge, tryMergeStoryOverview } = require('./story-overview');
const { getChatPending, setChatPhase } = require('./chat-lock');
const { SMALL_SUMMARY_CUT_CHARS, MAX_COMPACT_PER_RUN } = require('./summary-config');

const running = new Map(); // 角色名 -> { stage: 'summary' | 'merge', promise }

// 这个角色正在后台整理吗；返回 null 或 { stage, promise }。chat-turn.js 发送前据此决定要不要先等
function getCompactionJob(characterName) {
  return running.get(characterName) || null;
}

// 正在等这个角色的回复时，把锁的阶段同步成当前整理阶段，界面提示随之切换
function announce(characterName, stage) {
  const p = getChatPending();
  if (p && p.character === characterName) setChatPhase(stage === 'merge' ? 'merging' : 'summarizing');
}

async function runCompaction(characterName, job) {
  const mode = getChatMode(characterName);
  for (let n = 0; n < MAX_COMPACT_PER_RUN; n++) {
    const history = loadChatHistory(characterName);
    const plan = planCompaction(characterName, history, mode);
    if (!plan) break;

    job.stage = 'summary';
    announce(characterName, 'summary');
    const raw = await callLLM(
      [{ role: 'user', content: buildSmallSummaryPrompt(plan.lines, mode) }],
      `小总结生成 - ${characterName}`
    );
    const { summary, memoryLines } = parseSummaryAndMemory(raw);
    let text = (summary || String(raw || '')).trim();
    if (!text) throw new Error('小总结生成失败：模型输出为空');
    if (text.length > SMALL_SUMMARY_CUT_CHARS) text = text.slice(0, SMALL_SUMMARY_CUT_CHARS).trim() + '…'; // 略超目标不算失败，超出很多才截断

    // 写盘前核对（下面到写盘之间没有 await）：模式没切、这段消息没被改动
    if (getChatMode(characterName) !== mode) return;
    if (!runStillValid(loadChatHistory(characterName), plan)) {
      console.warn(`[pet] 角色 "${characterName}" 压缩期间这段聊天记录被改动，丢弃本次小总结，下一轮再试`);
      return;
    }
    appendSmallSummary(characterName, { fromTs: plan.fromTs, toTs: plan.toTs, text, label: plan.label, endLabel: plan.endLabel });
    if (memoryLines.length) appendMemoryLines(memoryLines, mode); // 提炼出的要求记进当前模式自己的那份
  }

  if (getChatMode(characterName) === mode && needsOverviewMerge(characterName)) {
    job.stage = 'merge';
    announce(characterName, 'merge');
    await tryMergeStoryOverview(characterName, mode);
  }
}

// 启动后台整理（不 await，永不抛错）；已经有一个在跑就直接返回它
function startBackgroundCompaction(characterName) {
  const existing = running.get(characterName);
  if (existing) return existing.promise;
  const job = { stage: 'summary', promise: null };
  running.set(characterName, job);
  job.promise = (async () => {
    try {
      await runCompaction(characterName, job);
    } catch (err) {
      console.warn(`[pet] 角色 "${characterName}" 的小总结生成失败（内容照常发送，下一轮回复后再试）: ${err.message}`);
    } finally {
      running.delete(characterName);
    }
  })();
  return job.promise;
}

module.exports = { startBackgroundCompaction, getCompactionJob };
