// ---------- 中国节日表 ----------
// 三类：
//   1. 农历固定月日（春节/元宵/端午/七夕/中秋/重阳/腊八），运行时用 lunar/lunar-convert.js 现算成当年公历日期
//   2. 除夕（春节前一天）、清明（节气，用近似公式算）
//   3. 公历固定月日的中国节日（植树节/青年节/建党节/建军节/教师节/国庆节）
// 法定/非法定都收录，区别只是给人看的注释，行为上一视同仁。

const { lunarToSolar, qingmingDate } = require('./lunar/lunar-convert');

const CHINESE_LUNAR_HOLIDAYS_FIXED = [
  { lunarMonth: 1, lunarDay: 1, name: '春节' },
  { lunarMonth: 1, lunarDay: 15, name: '元宵节' },
  { lunarMonth: 5, lunarDay: 5, name: '端午节' },
  { lunarMonth: 7, lunarDay: 7, name: '七夕' },
  { lunarMonth: 8, lunarDay: 15, name: '中秋节' },
  { lunarMonth: 9, lunarDay: 9, name: '重阳节' },
  { lunarMonth: 12, lunarDay: 8, name: '腊八节' },
];

const CHINESE_SOLAR_HOLIDAYS_FIXED = [
  { month: 3, day: 12, name: '植树节' },
  { month: 5, day: 4, name: '青年节' },
  { month: 7, day: 1, name: '建党节' },
  { month: 8, day: 1, name: '建军节' },
  { month: 9, day: 10, name: '教师节' },
  { month: 10, day: 1, name: '国庆节' },
];

// 除夕 = 春节前一天。腊月是大月还是小月不固定（廿九/三十），所以不写死，直接由春节减一天得到。
// 用 UTC 记账做"减一天"，避免时区/夏令时干扰，只取年月日。
function subtractOneDay(solar) {
  const result = new Date(Date.UTC(solar.year, solar.month - 1, solar.day) - 86400000);
  return { year: result.getUTCFullYear(), month: result.getUTCMonth() + 1, day: result.getUTCDate() };
}

// 农历新年常在公历 1~2 月、腊八常落在公历 12 月或次年 1 月初，"农历 Y 年"和"公历 Y 年"并不对齐。
// 所以对每个节日分别试农历 targetYear 和 targetYear-1，取换算后公历年等于目标年的那个。
function resolveToTargetSolarYear(lunarMonth, lunarDay, targetSolarYear) {
  for (const lunarYear of [targetSolarYear, targetSolarYear - 1]) {
    const solar = lunarToSolar(lunarYear, lunarMonth, lunarDay);
    if (solar && solar.year === targetSolarYear) return solar;
  }
  return null;
}

// 按公历年份返回当年全部中国节日 [{ month, day, name }]
function getChineseHolidays(solarYear) {
  const result = [];
  let springFestival = null;

  for (const def of CHINESE_LUNAR_HOLIDAYS_FIXED) {
    const solar = resolveToTargetSolarYear(def.lunarMonth, def.lunarDay, solarYear);
    if (!solar) continue;
    result.push({ month: solar.month, day: solar.day, name: def.name });
    if (def.name === '春节') springFestival = solar;
  }

  if (springFestival) {
    const chuxi = subtractOneDay(springFestival);
    if (chuxi.year === solarYear) result.push({ month: chuxi.month, day: chuxi.day, name: '除夕' });
  }

  const qingming = qingmingDate(solarYear);
  if (qingming) result.push({ month: qingming.month, day: qingming.day, name: '清明节' });

  return result.concat(CHINESE_SOLAR_HOLIDAYS_FIXED);
}

module.exports = { getChineseHolidays };
