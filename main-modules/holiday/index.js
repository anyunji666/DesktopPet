// ---------- 故事时间的星期 / 节日播报 ----------
// 从聊天记录里最后一条 assistant 消息的 <story_overview> 摘要块取出"故事时间"，
// 算出星期和国际/中国节日，拼成 <the_festivals_in_the_story> 标签，供 llm.js 的 buildPromptText 注入。
// 每轮都用最新历史现算，不落盘、不缓存。取不到或解析不出日期就返回空串（完全不注入）。

const { extractStoryTime } = require('../history-flatten');
const { buildFestivalTag } = require('./calc');

// 只看最后一条 assistant 消息：故事时间要反映"故事现在走到哪了"，回退去找更早的会拿到过期日期
function findLatestStoryTimeText(history) {
  if (!Array.isArray(history)) return '';
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (!h || h.role !== 'assistant') continue;
    return extractStoryTime(h.content);
  }
  return '';
}

function buildFestivalBlock(history) {
  const timeText = findLatestStoryTimeText(history);
  if (!timeText) return '';
  return buildFestivalTag(timeText) || '';
}

module.exports = { buildFestivalBlock, findLatestStoryTimeText };
