// ---------- 角色资产：数据整理 + 资金计算（主进程和资产配置页面共用同一份，口径只在这里维护） ----------
//   资产只填「可变现金额」（现在卖掉实际能拿到手的钱）和「预计多久到账」（天）
//   月支出 = 各项支出 + 所有未还完负债的月供；每月结余 = 月收入 − 月支出（可以是负数）
//   「账户资金」= 所有「现金类」资产的金额之和（现金类金额可以为负 = 透支，到账天数固定 0）
//   今天 = 账户资金；一周以内 = 今天 + 到账天数 ≤ 7 的其他资产；
//   一月以内 = 今天 + 到账天数 ≤ 31 的其他资产 − 全部剩余欠款（其他类别的到账天数是 1 到 31 天）
//   随故事时间推算（advanceAssets）：只读故事时间，由代码自己算，不让 LLM 记账
//     · 收入在到账日加进列表里的第一条现金类资产，支出和月供在每月 1 日从它里面扣（可以扣成负数）；
//       一条现金类资产都没有时，sanitizeParty 会自动建一条叫「账户资金」的现金类资产来接
//     · 负债：每月 1 日先扣月度支出，再按顺序还一期：剩余期数 −1，本金按「本金 ÷ 剩余期数」减少，期数到 0 记下还完日期；
//       账户资金不够这一期月供就延期（期数、本金都不动，下个月 1 日再试），所以还完日期会跟着往后顺延
//     · 没填剩余期数的负债：只算欠款，不算进月度支出，也不自动还款（代表欠着但短期内不想还）
//     · 资产的「预计多久到账」是资产自己的属性，不随时间变
// 既给 Node（require）用，也给页面（<script src>）用。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AssetsCalc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const ASSET_CATEGORIES = ['现金类', '现金等价物', '金融资产', '不动产', '动产', '经营资产'];
  const CASH_CATEGORY = '现金类'; // 现金类资产：金额可为负，到账天数固定 0，合计 = 账户资金
  const DEFAULT_CASH_NAME = '账户资金'; // 一条现金类资产都没有时自动建的那条的名字（之后和普通资产一样可改名、改金额、删除）

  // 各类资产的参考到账天数（换类别时页面自动带出，用户可再改）
  const CATEGORY_DEFAULTS = {
    现金类: { days: 0 },
    现金等价物: { days: 1 },
    金融资产: { days: 1 },
    不动产: { days: 31 },
    动产: { days: 31 },
    经营资产: { days: 31 },
  };

  // 叫「账户资金」的现金类资产（自动建的那条）：类别锁死不能切换；改了名字就和普通资产一样
  const isLockedCash = (a) => !!a && a.category === CASH_CATEGORY && a.name === DEFAULT_CASH_NAME;

  const MAX_DAYS = 31; // 预计到账天数上限（一月以内）
  const MIN_DAYS = 1; // 非现金类资产的预计到账天数下限（0 天只属于现金类）
  const MAX_ROWS = 40; // 每张表最多行数
  const MAX_NAME = 40;
  const MAX_ITEM_NAME = 10; // 随身携带物的物品名称
  const MAX_UNIT = 3; // 随身携带物的单位
  const MAX_NOTE = 20; // 随身携带物的备注
  const MAX_QTY = 1e6; // 随身携带物的数量上限
  const MAX_NUM = 1e15;
  const MAX_ADVANCE_MONTHS = 1200; // 一次最多往后推算 100 年，防止故事时间写成离谱的日期时卡死

  function str(v, max) {
    return typeof v === 'string' ? v.trim().slice(0, max) : '';
  }
  // 数字清洗：非数字 / 负数 → 0，超大数封顶，保留两位小数
  function num(v, max = MAX_NUM) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.round(Math.min(n, max) * 100) / 100;
  }
  // 允许负数的版本（只给现金类资产的金额用：被扣成负数 = 透支）
  function signed(v) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    if (!Number.isFinite(n)) return 0;
    return Math.round(Math.max(-MAX_NUM, Math.min(n, MAX_NUM)) * 100) / 100;
  }
  function oneOf(v, list, fallback) {
    return list.includes(v) ? v : fallback;
  }
  function rows(list, mapper, isBlank) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const row = mapper(item);
      if (isBlank(row)) continue; // 名称和数字全空的行直接丢掉
      out.push(row);
      if (out.length >= MAX_ROWS) break;
    }
    return out;
  }

  // ---------- 日期小工具：统一用 'YYYY-MM-DD' 字符串，直接比较字符串就是比较先后 ----------
  const pad = (n) => String(n).padStart(2, '0');
  const daysIn = (y, m) => new Date(y, m, 0).getDate(); // m 是 1~12
  const isoOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
  // 合法的 'YYYY-MM-DD' 原样返回，其余一律返回空串
  function validDate(v) {
    if (typeof v !== 'string') return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
    if (!m) return '';
    const y = +m[1];
    const mo = +m[2];
    const d = +m[3];
    return mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo) ? isoOf(y, mo, d) : '';
  }
  // 摘要里的故事时间 "2026年9月27日 21:40" → '2026-09-27'；解析不出日期返回空串
  function parseStoryDate(text) {
    const m = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(typeof text === 'string' ? text : '');
    return m ? validDate(isoOf(+m[1], +m[2], +m[3])) : '';
  }
  // '2026-09-27' → '2026 年 9 月 27 日'
  function dateCN(iso) {
    const d = validDate(iso);
    if (!d) return '';
    const [y, m, day] = d.split('-').map(Number);
    return `${y} 年 ${m} 月 ${day} 日`;
  }

  // 整理一方（角色 / 用户）的数据，缺的字段补默认值，脏数据修正成合法值。保存和读取都走这里
  function sanitizeParty(p) {
    const src = p && typeof p === 'object' ? p : {};
    const assets = rows(
      src.assets,
      (r) => {
        const name = str(r.name, MAX_NAME);
        const category = oneOf(r.category, ASSET_CATEGORIES, CASH_CATEGORY);
        const isCash = category === CASH_CATEGORY;
        // 现金类：金额可为负，到账天数固定 0；其他类别：天数没填取该类别默认值，填了就压进 1 到 31
        const blankDays = r.days === undefined || r.days === null || r.days === '';
        return {
          name,
          category,
          amount: isCash ? signed(r.amount) : num(r.amount),
          days: isCash ? 0 : blankDays ? CATEGORY_DEFAULTS[category].days : Math.max(MIN_DAYS, Math.round(num(r.days, MAX_DAYS))),
        };
      },
      (r) => !r.name && !r.amount
    );
    // 一条现金类资产都没有：自动建一条叫「账户资金」的放在最前面来接收收支（之后它和普通资产一样，可改名、改金额、删除）
    if (!assets.some((a) => a.category === CASH_CATEGORY)) {
      assets.unshift({ name: DEFAULT_CASH_NAME, category: CASH_CATEGORY, amount: 0, days: 0 });
    }

    return {
      assets,
      liabilities: rows(
        src.liabilities,
        (r) => {
          const principal = num(r.principal);
          const periods = Math.round(num(r.periods, 12000));
          return {
            name: str(r.name, MAX_NAME),
            principal,
            monthly: num(r.monthly),
            periods,
            // 还完的日期：只有本金和期数都是 0 才有意义，改回有欠款就清掉
            paidOff: principal === 0 && periods === 0 ? validDate(r.paidOff) : '',
          };
        },
        (r) => !r.name && !r.principal && !r.monthly
      ),
      incomes: rows(
        src.incomes,
        // payDay：每月几号到账（1~31），0 = 没填，不参与自动推算
        (r) => ({ name: str(r.name, MAX_NAME), monthly: num(r.monthly), payDay: Math.min(31, Math.round(num(r.payDay))) }),
        (r) => !r.name && !r.monthly
      ),
      expenses: rows(
        src.expenses,
        (r) => ({ name: str(r.name, MAX_NAME), monthly: num(r.monthly) }),
        (r) => !r.name && !r.monthly
      ),
      // 随身携带物：数量 0 = 没填（提示词里不写数量）；不参与任何资金计算，也不随故事时间变
      belongings: rows(
        src.belongings,
        (r) => ({ name: str(r.name, MAX_ITEM_NAME), quantity: Math.round(num(r.quantity, MAX_QTY)), unit: str(r.unit, MAX_UNIT), note: str(r.note, MAX_NOTE) }),
        (r) => !r.name && !r.quantity && !r.unit && !r.note
      ),
    };
  }

  // 整份文件：{ currency, storyStart, asOf, character: party, user: party, userKnown }
  //   storyStart：故事开始日期（用户可改；留空时第一次读到故事时间会自动填上），也是首次推算的起点
  //   asOf：存档里的数字是截至哪一天的（保存时记成当时的故事时间），推算从这一天往后算
  function sanitizeAssets(data) {
    const src = data && typeof data === 'object' ? data : {};
    return {
      currency: str(src.currency, 8) || '元',
      storyStart: validDate(src.storyStart),
      asOf: validDate(src.asOf),
      character: sanitizeParty(src.character),
      user: sanitizeParty(src.user),
      // 角色是否清楚用户的财产状况（影响提示词里对「角色知不知道」的说明）
      userKnown: !!src.userKnown,
    };
  }

  // 资产全是金额为 0 的现金类、没有别的内容 = 这一方没填
  function isPartyEmpty(p) {
    const onlyEmptyCash = p.assets.every((a) => a.category === CASH_CATEGORY && !a.amount);
    return onlyEmptyCash && !p.liabilities.length && !p.incomes.length && !p.expenses.length && !p.belongings.length;
  }

  const r2 = (n) => Math.round(n * 100) / 100;
  const sum = (list, f) => list.reduce((s, x) => s + f(x), 0);

  // 算一方的全部汇总数字（入参是 sanitizeParty 之后的对象）。已还完的负债不再计入
  function computeParty(p) {
    const assets = p.assets;
    const debts = p.liabilities.filter((l) => !l.paidOff);
    const totalDebt = r2(sum(debts, (l) => l.principal));
    const monthlyDebt = r2(sum(debts.filter((l) => l.periods > 0), (l) => l.monthly)); // 没填期数的不还，月供不算
    const monthlyIncome = r2(sum(p.incomes, (i) => i.monthly));
    const monthlyExpense = r2(sum(p.expenses, (e) => e.monthly) + monthlyDebt);
    // 账户资金 = 所有现金类资产之和；其他类别按到账天数（1 到 31）累加到「今天」上
    const within = (days) => r2(sum(assets.filter((a) => a.category === CASH_CATEGORY || a.days <= days), (a) => a.amount));
    const within31 = within(31);
    return {
      totalDebt,
      monthlyDebt,
      monthlyIncome,
      monthlyExpense,
      monthlySurplus: r2(monthlyIncome - monthlyExpense), // 可以是负数（入不敷出）
      today: within(0), // 账户资金：现金类金额之和，被扣成负数时这里也是负数（透支）
      within7: within(7),
      within31,
      net31: r2(within31 - totalDebt), // 一月以内：能到账的资产（最多 31 天，等于全部资产）减去全部欠款，可以是负数
    };
  }

  // ---------- 随故事时间推算 ----------
  // 把一方的数字从 from 推算到 to（都是 'YYYY-MM-DD'，from 当天已经算过，to 当天算进去），返回新对象，不改入参
  function advanceParty(p, from, to) {
    const out = JSON.parse(JSON.stringify(p));
    const cash = out.assets.find((a) => a.category === CASH_CATEGORY); // 列表里的第一条现金类资产
    if (!cash) return out;
    let [y, m] = from.split('-').map(Number);
    const [ty, tm] = to.split('-').map(Number);
    for (let guard = 0; (y < ty || (y === ty && m <= tm)) && guard < MAX_ADVANCE_MONTHS; guard++) {
      // 每月 1 日：扣月度支出，还一期负债
      const first = isoOf(y, m, 1);
      if (first > from && first <= to) {
        cash.amount = r2(cash.amount - sum(out.expenses, (e) => e.monthly)); // 月度支出照扣，可以扣成负数
        for (const l of out.liabilities) {
          if (l.paidOff || l.periods <= 0) continue; // 没填期数的不还
          if (cash.amount < l.monthly) continue; // 钱不够这一期月供：延期，下个月 1 日再试
          cash.amount = r2(cash.amount - l.monthly);
          l.principal = r2(l.principal - l.principal / l.periods);
          l.periods -= 1;
          if (l.periods === 0) {
            l.principal = 0;
            l.paidOff = first;
          }
        }
      }
      // 到账日：收入加进账户资金（第一条现金类资产，31 号遇到小月取当月最后一天）
      for (const i of out.incomes) {
        if (!i.payDay) continue;
        const day = isoOf(y, m, Math.min(i.payDay, daysIn(y, m)));
        if (day > from && day <= to) cash.amount = r2(cash.amount + i.monthly);
      }
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
    cash.amount = r2(cash.amount);
    return out;
  }

  // 整份推算到 now（当前故事日期）。起点 = asOf，没有就用故事开始日期；
  // 没有当前日期 / 没有起点 / 当前日期不晚于起点（比如历史被删回去了），就原样返回，不倒推
  function advanceAssets(data, now) {
    const base = data.asOf || data.storyStart;
    if (!now || !base || now <= base) return data;
    return { ...data, character: advanceParty(data.character, base, now), user: advanceParty(data.user, base, now) };
  }

  return {
    ASSET_CATEGORIES,
    CATEGORY_DEFAULTS,
    CASH_CATEGORY,
    DEFAULT_CASH_NAME,
    isLockedCash,
    MIN_DAYS,
    MAX_ROWS,
    MAX_DAYS,
    MAX_ITEM_NAME,
    MAX_UNIT,
    MAX_NOTE,
    sanitizeParty,
    sanitizeAssets,
    isPartyEmpty,
    computeParty,
    advanceAssets,
    parseStoryDate,
    validDate,
    dateCN,
  };
});
