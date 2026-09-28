// ---------- 国际节日表 ----------
// 全世界（或至少中文语境里）通用的节日，分两类：
//   - 固定月日：WORLD_HOLIDAYS_FIXED
//   - 浮动日期（"某月第 n 个周几"）：WORLD_HOLIDAYS_FLOATING，按年份现算
// 只放"国际通用"的节日；中国特有的节日（农历节日 + 国庆等）在 chinese-holidays.js。

const WORLD_HOLIDAYS_FIXED = [
  { month: 1, day: 1, name: '元旦' },
  { month: 2, day: 14, name: '情人节' },
  { month: 3, day: 8, name: '国际妇女节' },
  { month: 4, day: 1, name: '愚人节' },
  { month: 5, day: 1, name: '国际劳动节' },
  { month: 6, day: 1, name: '国际儿童节' },
  { month: 10, day: 31, name: '万圣节' },
  { month: 12, day: 24, name: '平安夜' },
  { month: 12, day: 25, name: '圣诞节' },
  { month: 12, day: 31, name: '跨年夜' },
];

// weekday 跟 Date.getDay() 一致：0=周日，1=周一 … 6=周六
const WORLD_HOLIDAYS_FLOATING = [
  { month: 5, weekday: 0, nth: 2, name: '母亲节' }, // 5 月第 2 个周日
  { month: 6, weekday: 0, nth: 3, name: '父亲节' }, // 6 月第 3 个周日
  { month: 11, weekday: 4, nth: 4, name: '感恩节' }, // 11 月第 4 个周四
];

// 某年某月的"第 n 个周 weekday"是几号
function nthWeekdayOfMonth(year, month, weekday, nth) {
  const firstWeekday = new Date(year, month - 1, 1).getDay();
  const dayOfFirstOccurrence = 1 + ((weekday - firstWeekday + 7) % 7);
  return dayOfFirstOccurrence + (nth - 1) * 7;
}

// 按公历年份返回当年全部国际节日 [{ month, day, name }]
function getWorldHolidays(year) {
  const floating = WORLD_HOLIDAYS_FLOATING.map((def) => ({
    month: def.month,
    day: nthWeekdayOfMonth(year, def.month, def.weekday, def.nth),
    name: def.name,
  }));
  return WORLD_HOLIDAYS_FIXED.concat(floating);
}

module.exports = { getWorldHolidays, nthWeekdayOfMonth };
