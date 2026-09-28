// ---------- 故事时间的星期 / 节日播报 ----------
// 从聊天记录里最后一条 assistant 消息的 <story_overview> 摘要块取出"故事时间"，
// 算出星期和国际/中国节日，拼成 <the_festivals_in_the_story> 标签，供 llm.js 的 buildPromptText 注入。
// 每轮都用最新历史现算，不落盘、不缓存。取不到或解析不出日期就返回空串（完全不注入）。

const { splitTurnSummary } = require('../history-flatten');
const { buildFestivalTag } = require('./calc');

// "故事时间: 2026年9月27日 21:40" → "2026年9月27日 21:40"；冒号中英文都认
const STORY_TIME_LINE_RE = /故事时间\s*[:：]\s*(.+)/;

// 只看最后一条 assistant 消息：故事时间要反映"故事现在走到哪了"，回退去找更早的会拿到过期日期
function findLatestStoryTimeText(history) {
  if (!Array.isArray(history)) return '';
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (!h || h.role !== 'assistant') continue;
    const { summaryBlock } = splitTurnSummary(h.content);
    const m = STORY_TIME_LINE_RE.exec(summaryBlock);
    return m ? m[1].trim() : '';
  }
  return '';
}

function buildFestivalBlock(history) {
  const timeText = findLatestStoryTimeText(history);
  if (!timeText) return '';
  return buildFestivalTag(timeText) || '';
}

module.exports = { buildFestivalBlock, findLatestStoryTimeText };
