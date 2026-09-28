

const { LUNAR_INFO, LUNAR_MIN_YEAR, LUNAR_MAX_YEAR } = require("./lunar-data");

// =====================================================================================
// 农历 → 公历 转换算法（业界通用做法，基于 lunar-data.js 的 1900-2100 年数据表）。
// 只实现"农历→公历"这一个方向——插件只需要把固定的农历月日（正月初一、五月初五……）
// 现算成某一年对应的公历日期，不需要反过来把任意公历日期转成农历，所以不做 solarToLunar。
// 另外单独提供清明的节气近似公式，清明不是固定农历月日、要按公历节气单独计算。
// =====================================================================================

// === Helper: 某农历年闰几月，0 表示当年没有闰月 ===
function leapMonthOf(lunarYear) {
  return LUNAR_INFO[lunarYear - LUNAR_MIN_YEAR] & 0xf;
}

// === Helper: 某农历年闰月的天数（该年没有闰月时返回 0）===
function leapMonthDays(lunarYear) {
  if (!leapMonthOf(lunarYear)) return 0;
  return LUNAR_INFO[lunarYear - LUNAR_MIN_YEAR] & 0x10000 ? 30 : 29;
}

// === Helper: 某农历年、某个非闰月的月份（1-12）有多少天（29 或 30）===
function normalMonthDays(lunarYear, lunarMonth) {
  return LUNAR_INFO[lunarYear - LUNAR_MIN_YEAR] & (0x10000 >> lunarMonth) ? 30 : 29;
}

// === Helper: 某农历年全年一共多少天（12/13 个月大小月天数之和 + 闰月天数）===
function lunarYearDays(lunarYear) {
  let sum = 0;
  for (let m = 1; m <= 12; m++) sum += normalMonthDays(lunarYear, m);
  return sum + leapMonthDays(lunarYear);
}

// 农历基准点：农历 1900 年正月初一 = 公历 1900 年 1 月 31 日（数据表的起始锚点）。
// 用 UTC 记账纯粹是为了避免本地时区在做"整数天数偏移"时被夏令时之类的东西干扰，
// 跟"这天到底几点"无关，最后只取年/月/日。
const LUNAR_EPOCH_UTC_MS = Date.UTC(1900, 0, 31);
const MS_PER_DAY = 86400000;

/**
 * 把农历日期换算成公历日期。
 * @param {number} lunarYear 农历年，如 2026
 * @param {number} lunarMonth 农历月，1-12（不含闰月标记，闰月请另传 isLeapMonth=true）
 * @param {number} lunarDay 农历日，1-30
 * @param {boolean} [isLeapMonth=false] 是否指定成"该年的闰月"（本插件目前用不到，预留）
 * @returns {{year:number, month:number, day:number}|null} 对应公历日期；超出 1900-2100 覆盖范围
 *          或该年根本没有这个闰月/日期不存在时返回 null。
 */
function lunarToSolar(lunarYear, lunarMonth, lunarDay, isLeapMonth = false) {
  if (lunarYear < LUNAR_MIN_YEAR || lunarYear > LUNAR_MAX_YEAR) return null;
  if (lunarMonth < 1 || lunarMonth > 12) return null;

  const leap = leapMonthOf(lunarYear);
  if (isLeapMonth && leap !== lunarMonth) return null; // 该年没有这个闰月

  const monthDayCount = isLeapMonth ? leapMonthDays(lunarYear) : normalMonthDays(lunarYear, lunarMonth);
  if (lunarDay < 1 || lunarDay > monthDayCount) return null;

  // 从农历基准点开始，累加"到目标农历日期之前一共过了多少天"：
  // 1) 先加上基准年到目标年之间，每整年各自的农历总天数；
  let offsetDays = 0;
  for (let y = LUNAR_MIN_YEAR; y < lunarYear; y++) offsetDays += lunarYearDays(y);

  // 2) 再加上目标年里、目标月之前每个月的天数（闰月出现在对应月份之后，也要计入）；
  for (let m = 1; m < lunarMonth; m++) {
    offsetDays += normalMonthDays(lunarYear, m);
    if (leap === m) offsetDays += leapMonthDays(lunarYear); // 闰 m 月紧跟在 m 月后面
  }
  // 3) 如果目标本身就是"该年的闰月"，还要再加上正常同序数月的天数（闰月排在它后面）；
  if (isLeapMonth) offsetDays += normalMonthDays(lunarYear, lunarMonth);

  // 4) 最后加上月内天数（减 1，因为初一那天 offsetDays 不需要再往前挪）。
  offsetDays += lunarDay - 1;

  const resultMs = LUNAR_EPOCH_UTC_MS + offsetDays * MS_PER_DAY;
  const result = new Date(resultMs);
  return {
    year: result.getUTCFullYear(),
    month: result.getUTCMonth() + 1,
    day: result.getUTCDate(),
  };
}

// === 清明：按太阳黄经算的"节气"，不是固定农历月日，用通用近似公式直接算，不用逐年查表。
// 公式（俗称"寿星公式"）：day = floor(Y × D + C) − L
//   Y：年份后两位；D：每年清明日期平均漂移的常数 0.2422；
//   C：世纪基准常数，20 世纪（1900-1999）和 21 世纪（2000-2099）取值不同；
//   L：闰年修正项，按"当年之前经过了多少个闰年"每 4 个减 1（同时排除世纪年不是闰年的情况）。
// 这套公式在 1900-2100 年区间内，跟真实清明日期的误差通常在 0～1 天，
// 个别年份（如 2010 年前后极少数）有已知的历史性偏差，这里未逐一硬编码修正，
// 用户如发现具体某年清明提示日期偏差 1 天，属于该近似公式的已知误差范围。===
// 注：2100 年是"世纪闰年例外"（能被100整除但不能被400整除，公历上不是闰年），跟公式里
// 每4年一次的闰年修正节奏正好在这年断开，公式在这个边界年份的误差没有实测数据支撑；
// 这里仍按 21 世纪常数把 2100 年一起算出来（保证跟农历数据表 1900-2100 的覆盖范围对齐、
// 不会在最后一年突然失效），只是这一年的精度不像其它年份那样有把握。
function qingmingDate(solarYear) {
  const y = solarYear % 100;
  const isYearInFirstCentury = solarYear >= 1900 && solarYear <= 1999;
  const isYearInSecondCentury = solarYear >= 2000 && solarYear <= 2100;
  if (!isYearInFirstCentury && !isYearInSecondCentury) return null;

  const C = isYearInFirstCentury ? 5.59 : 4.81;
  const leapCorrection = Math.floor(y / 4);
  const day = Math.floor(y * 0.2422 + C) - leapCorrection;

  return { month: 4, day };
}

module.exports = { lunarToSolar, qingmingDate };
