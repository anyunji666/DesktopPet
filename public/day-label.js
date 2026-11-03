// 跨天总结 / 合并剧情总览阶段的提示文案。主界面气泡/输入框（modules/chat.js）和聊天记录窗口（history/pending.js）共用，
// 两边显示同一句话。dayKey 是主进程下发的"这次被总结的那一天"（YYYY-MM-DD）：
// 它不一定是昨天——昨天是"上一天"、继续发原文，被总结的通常是更早的一天，所以提示里要写具体日期。

// 'YYYY-MM-DD' -> 'M月D日'（不补零）；不是今年的日子带上年份；格式不对返回 null
export function dayLabelCN(dayKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey || '');
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const md = `${mo}月${d}日`;
  return y === new Date().getFullYear() ? md : `${y}年${md}`;
}

// waitingSend=true：气泡/临时消息用，带"等待发送中"；false：输入框 placeholder 用
export function summarizingHint(dayKey, waitingSend) {
  const label = dayLabelCN(dayKey);
  const target = label ? `${label}的对话` : '往日对话'; // 没带日期（不该发生）时兜底，不留空
  return `正在为${target}生成总结${waitingSend ? '，等待发送中' : ''}…`;
}

// 日总结攒够字数、正在并进剧情总览的阶段提示（不针对某一天，不需要日期）
export function mergingHint(waitingSend) {
  return `正在整理剧情总览${waitingSend ? '，等待发送中' : ''}…`;
}

// 各阶段统一取提示：phase = 'summarizing' | 'merging' | 其它（waiting）
export function phaseHint(phase, summaryDay, waitingSend) {
  if (phase === 'summarizing') return summarizingHint(summaryDay, waitingSend);
  if (phase === 'merging') return mergingHint(waitingSend);
  return '等待回复中…';
}
