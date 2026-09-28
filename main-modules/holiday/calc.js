// ---------- 故事时间的星期 / 节日计算（纯函数，无副作用） ----------
// 输入是摘要块里"故事时间"那一行的文本，输出是拼好的 <the_festivals_in_the_story> 标签内容。
// 解析不出合法公历日期（虚构纪年、农历写法、格式不规整、日期不存在）一律返回 null，调用方据此完全不注入。

const { getWorldHolidays } = require('./world-holidays');
const { getChineseHolidays } = require('./chinese-holidays');

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六']; // 对应 Date.getDay()：0=周日
const TAG_NAME = 'the_festivals_in_the_story';

// 日历意义上的"加 N 天"（正确处理跨月/跨年进位）
function addDays(date, n) {
  const r = new Date(date.getTime());
  r.setDate(r.getDate() + n);
  return r;
}

// 某年某月有多少天（`new Date(year, month, 0)` 自动处理闰年）
function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

// 只认严格锚定在开头的三种写法：YYYY年M月D日 / YYYY-M-D / YYYY/M/D（后面可跟具体时刻等文字）。
// 命中后做 Date 往返校验，排除 2026年2月30日 这类不存在的日期。
function parseStoryDate(timeText) {
  if (!timeText || typeof timeText !== 'string') return null;
  const patterns = [
    /^(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/,
    /^(\d{4})-(\d{1,2})-(\d{1,2})/,
    /^(\d{4})\/(\d{1,2})\/(\d{1,2})/,
  ];
  for (const pattern of patterns) {
    const m = timeText.trim().match(pattern);
    if (!m) continue;
    const year = parseInt(m[1], 10);
    const month = parseInt(m[2], 10);
    const day = parseInt(m[3], 10);
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day) {
      return { year, month, day };
    }
  }
  return null;
}

// 某一天命中的全部节日提示句。国际节日和中国节日是并列关系，都查、命中的都列出（不是谁覆盖谁）。
function checkHolidays(date) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const segments = [];

  for (const h of getWorldHolidays(year)) {
    if (h.month === month && h.day === day) segments.push(`${month}月${day}日是${h.name}`);
  }
  for (const h of getChineseHolidays(year)) {
    if (h.month === month && h.day === day) segments.push(`${month}月${day}日是中国的 ${h.name}`);
  }
  return segments.length > 0 ? segments.join(' ') : null;
}

// 当天 + 提前 1 天 + 提前 2 天 的节日提示，拼成"（...）"括注；三天都没有节日返回空串。
// 不同天之间按 当天→1天后→2天后 的顺序、用顿号连接；每句都带具体月日，AI 能自己分辨是当天还是预告。
function buildHolidaySuffix(date0) {
  const groups = [];
  for (let offset = 0; offset <= 2; offset++) {
    const seg = checkHolidays(addDays(date0, offset));
    if (seg) groups.push(seg);
  }
  return groups.length > 0 ? `（${groups.join('、')}）` : '';
}

// 拼出完整标签；timeText 解析不出合法公历日期时返回 null。
// "本月共N天"单独一个括注，给 LLM 兜底——LLM 容易凭感觉编错这个月有几天（编出 2月30日、算错闰年）。
function buildFestivalTag(timeText) {
  const parsed = parseStoryDate(timeText);
  if (!parsed) return null;

  const date0 = new Date(parsed.year, parsed.month - 1, parsed.day);
  const weekday = WEEKDAY_LABELS[date0.getDay()];
  const monthDays = daysInMonth(parsed.year, parsed.month);
  const suffix = buildHolidaySuffix(date0);

  return `<${TAG_NAME}>\n<!-- 上述最近的故事时间的星期，以及节日播报，仅供剧情参考 -->\n${parsed.year}年${parsed.month}月${parsed.day}日 是 星期${weekday}（本月共${monthDays}天）${suffix}\n</${TAG_NAME}>`;
}

module.exports = { buildFestivalTag, parseStoryDate, buildHolidaySuffix, TAG_NAME };
