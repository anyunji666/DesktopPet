// ---------- 从用户当前输入里识别提到的日期 ----------
// 只服务于"历史记录按天封印/解封"这一个用途：只做字面抽取，不做语义理解，
// 模糊表达（"上周三""最近几天""国庆那天"）不识别，保证解封行为可预测、不会误判展开一大段。
// 支持：
//   - 相对：前天/大前天/N天前（今天、昨天由 llm.js 的封印包规则处理，不在此识别）
//   - 绝对（带年）：YYYY年M月D日、YYYY-MM-DD、YYYY/MM/DD
//   - 绝对（不带年，按当前年份推算；算出来比今天晚就退一年）：M月D日、M月D号、MM-DD、MM/DD

// 注意顺序：必须从长到短处理，否则"大前天"里的"前天"子串会被"前天"规则先吃掉，导致"大前天"匹配不到
// 今天 / 昨天不再在这里识别：今天与上一个封印包（最新的早于今天的那天）由 llm.js 恒定解封
const REL_WORDS = { 大前天: -3, 前天: -2 };

function pad2(n) {
  return String(n).padStart(2, '0');
}

// 归到本地自然日 key："YYYY-MM-DD"（补零，仅用于分组/比较，不对外显示）
function dayKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

// 提取文本里提到的所有日期，返回去重后的 dayKey 数组
function extractMentionedDayKeys(text, now = new Date()) {
  if (typeof text !== 'string' || !text) return [];
  const today = startOfDay(now);
  const keys = new Set();
  let working = text;

  // 按不带年份的 M/D 推算年份：优先今年，算出来比今天晚（还没到）就退一年
  function addNoYear(mo, da) {
    if (mo < 1 || mo > 12 || da < 1 || da > 31) return;
    let d = new Date(today.getFullYear(), mo - 1, da);
    if (d.getMonth() !== mo - 1 || d.getDate() !== da) return; // 非法日期（比如 2月30）
    if (d > today) d = new Date(today.getFullYear() - 1, mo - 1, da);
    keys.add(dayKey(d));
  }

  // 命中后把原文对应片段替换成等长空格，避免被后面范围更宽的规则重复识别（比如年份里的月日）
  function consume(re, handler) {
    working = working.replace(re, (full, ...groups) => {
      handler(groups);
      return ' '.repeat(full.length);
    });
  }

  // 相对词：前天/大前天
  for (const [word, offset] of Object.entries(REL_WORDS)) {
    if (working.includes(word)) {
      keys.add(dayKey(addDays(today, offset)));
      working = working.split(word).join(' '.repeat(word.length));
    }
  }

  // N天前
  consume(/(\d+)\s*天前/g, ([n]) => {
    const num = parseInt(n, 10);
    if (Number.isFinite(num) && num >= 0) keys.add(dayKey(addDays(today, -num)));
  });

  // 带年份：YYYY年M月D日 / YYYY-MM-DD / YYYY/MM/DD
  consume(/(\d{4})\s*[年\-/]\s*(\d{1,2})\s*[月\-/]\s*(\d{1,2})\s*[日号]?/g, ([y, mo, da]) => {
    const yy = parseInt(y, 10), mm = parseInt(mo, 10), dd = parseInt(da, 10);
    const d = new Date(yy, mm - 1, dd);
    if (d.getMonth() === mm - 1 && d.getDate() === dd) keys.add(dayKey(d));
  });

  // 不带年份：M月D日 / M月D号
  consume(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g, ([mo, da]) => addNoYear(parseInt(mo, 10), parseInt(da, 10)));

  // 不带年份：MM-DD / MM/DD
  consume(/\b(\d{1,2})[\-/](\d{1,2})\b/g, ([mo, da]) => addNoYear(parseInt(mo, 10), parseInt(da, 10)));

  return [...keys];
}

module.exports = { extractMentionedDayKeys, dayKey, startOfDay, addDays };
