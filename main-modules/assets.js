// ---------- 角色资产：两份存档 + 随故事时间推算 + 拼进 prompt 的 <financial_status> 文本 ----------
// 每个角色两份存档（每份都同时存「这个角色」和「用户扮演的角色」两方的资产）：
//   Character/<角色名>/assets.json   初始资产设定：不带日期，属于角色设定，跟着角色文件夹走。没有故事资产时给 AI 发这份；清空聊天记录后回到的就是它，故事进行中不会改动它。
//   userData/chat-history/<角色名>-story-assets.json  故事资产结算：带故事开始日期（storyStart）和资产截至日期（asOf），
//     属于这一段故事，和聊天记录、日总结、剧情总览放在一起。故事进行中以它为准，随故事时间自动推算；
//     故事第一次写出时间时由程序按初始资产生成（也可以用户填了开始日期后手动建立）；清空聊天记录时删除，导出 / 导入聊天记录时跟着走。
// 估值口径和推算规则在 public/assets-calc.js（页面也用它实时算），这里只管存取、取当前故事日期，和把结果写成给 LLM 看的文字。
// 记账由用户在资产配置页手动改；程序只读最新一轮摘要里的「故事时间」，按时间自己推算，不让 LLM 记账。
const fs = require('fs');
const path = require('path');
const { CHARACTER_ROOT } = require('./character');
const { assertSafeName } = require('./security');
const { getChatDir } = require('./chat-store');
const { findLatestStoryTimeText } = require('./holiday');
const calc = require('../public/assets-calc');

function assetsPath(characterName) {
  return path.join(CHARACTER_ROOT, assertSafeName(characterName), 'assets.json');
}
function storyAssetsPath(characterName) {
  const dir = getChatDir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, assertSafeName(characterName) + '-story-assets.json');
}

// 原子写入：先写临时文件再改名，写到一半断电 / 崩溃 / 磁盘满时不会把原来的文件写成半截
function writeAssetsAtomic(p, obj) {
  const tmp = p + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
    fs.renameSync(tmp, p);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

// 删文件：不存在不算错。返回是否真的删了
function removeFile(p) {
  try {
    fs.unlinkSync(p);
    return true;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return false;
  }
}

// 读取并整理；文件不存在 / 解析失败返回 null
function readAssetsJson(p) {
  try {
    return calc.sanitizeAssets(JSON.parse(fs.readFileSync(p, 'utf-8')));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[pet] ${path.basename(path.dirname(p))}/${path.basename(p)} 解析失败: ${err.message}`);
    return null;
  }
}

// 初始资产设定：永远不带日期（就算文件里有也丢掉）；没有文件就是全空的默认数据
function readInitialAssets(characterName) {
  const d = readAssetsJson(assetsPath(characterName)) || calc.sanitizeAssets(null);
  return { ...d, storyStart: '', asOf: '' };
}

// 故事资产结算：没有这份存档返回 null
function readStoryAssets(characterName) {
  return readAssetsJson(storyAssetsPath(characterName));
}

const isEmptyDoc = (d) => calc.isPartyEmpty(d.character) && calc.isPartyEmpty(d.user);

// 当前故事日期 'YYYY-MM-DD'：取最后一条 assistant 消息摘要里的故事时间；没有 / 解析不出返回空串
function currentStoryDate(history) {
  return calc.parseStoryDate(findLatestStoryTimeText(history));
}

// 页面用：两份存档一起读出来，多带一个 now（当前故事日期，没有为空串）。
//  - 故事资产已经推算到当前故事日期（推算结果不写回存档）；还没有故事资产时 story 为 null。
//  - 没有故事资产、故事已经写出时间、初始资产不是空的：按初始资产生成故事资产，故事开始日期和资产截至都记成当前故事日期并落盘。
//  - 故事资产在、但还没有故事开始日期（用户没填）：第一次读到故事时间时补上。
//  写盘失败（只读目录 / 磁盘满）不能让整轮对话跟着失败：起点没落盘下次还会再试，本次照样用内存里的推算
function loadAssetSet(characterName, history) {
  const now = currentStoryDate(history);
  const initial = readInitialAssets(characterName);
  let story = readStoryAssets(characterName);
  let created = false;
  if (!story && now && !isEmptyDoc(initial)) {
    story = { ...initial, storyStart: now, asOf: now };
    created = true;
  } else if (story && !story.storyStart && now) {
    story = { ...story, storyStart: now, asOf: now };
    created = true;
  }
  if (created) {
    try {
      writeAssetsAtomic(storyAssetsPath(characterName), story);
    } catch (err) {
      console.warn(`[pet] 角色 "${characterName}" 的故事资产写入失败: ${err.message}`);
    }
  }
  return {
    initial: { ...initial, now },
    story: story ? { ...calc.advanceAssets(story, now), now } : null,
    now,
  };
}

// 给 AI 发的是哪份：有故事资产用故事资产（已推算到当前故事日期），否则用初始资产
function currentAssets(characterName, history) {
  const set = loadAssetSet(characterName, history);
  return set.story || set.initial;
}

// 保存初始资产设定：不带日期；两方都是空的就删文件；故事资产存在时拒绝保存
function saveInitialAssets(characterName, data) {
  // 故事进行中（故事资产结算存在）初始资产锁定：页面是灰的不让改，这里再拦一道，防止页面状态没刷新时误写
  if (fs.existsSync(storyAssetsPath(characterName))) {
    throw new Error('故事进行中，初始资产已锁定；清空聊天记录后可以修改');
  }
  const clean = { ...calc.sanitizeAssets(data), storyStart: '', asOf: '' };
  const p = assetsPath(characterName);
  if (isEmptyDoc(clean)) removeFile(p);
  else writeAssetsAtomic(p, clean);
}

// 保存故事资产结算：两方都是空的（也没填故事开始日期）就删文件，之后回到用初始资产。
// 页面上看到的数字已经推算到页面加载时的故事日期（data.now），保存后就以那一天为新的起点（asOf）；
// 这样页面开着的时候故事又往前走了，那一段也不会丢。故事日期比旧起点还早（历史被删过）时不倒退。
function saveStoryAssets(characterName, data) {
  const clean = calc.sanitizeAssets(data);
  const projectedTo = calc.validDate(data && data.now);
  const p = storyAssetsPath(characterName);
  if (isEmptyDoc(clean) && !clean.storyStart) {
    removeFile(p);
    return;
  }
  const prev = readStoryAssets(characterName) || { storyStart: '', asOf: '' };
  const oldBase = prev.asOf || prev.storyStart;
  const userStart = clean.storyStart; // 用户在页面上填的故事开始日期（可能为空）
  if (!clean.storyStart && projectedTo) clean.storyStart = projectedTo;
  if (!oldBase && userStart) {
    // 第一次建立、而且手填了故事开始日期：用户填的数字就是"截至开始日期"的，要从开始日期推算到现在，
    // 不能直接记成"截至今天"，否则开始日期到今天之间的到账、扣款、还款全被漏掉
    clean.asOf = userStart;
  } else {
    clean.asOf = projectedTo && (!oldBase || projectedTo >= oldBase) ? projectedTo : prev.asOf;
  }
  writeAssetsAtomic(p, clean);
}

// 聊天记录导出用：当前存档里的故事资产结算原始数据（带 storyStart / asOf，不是推算后的）；没有返回 null
function exportStoryAssets(characterName) {
  return readStoryAssets(characterName);
}

// 聊天记录导入覆盖用：文件里带了故事资产就还原成存档，没带（旧版导出文件 / 当时没建立）或内容无效就删掉当前的，之后按初始资产重新生成。
// 出错只打日志，不影响聊天记录本身的导入。返回是否成功
function restoreStoryAssets(characterName, raw) {
  try {
    const clean = raw && typeof raw === 'object' && !Array.isArray(raw) ? calc.sanitizeAssets(raw) : null;
    if (clean && !(isEmptyDoc(clean) && !clean.storyStart)) writeAssetsAtomic(storyAssetsPath(characterName), clean);
    else removeFile(storyAssetsPath(characterName));
    return true;
  } catch (err) {
    console.warn(`[pet] 角色 "${characterName}" 的故事资产还原失败: ${err.message}`);
    return false;
  }
}

// 聊天记录被整份清空 / 导入覆盖后，旧故事的资产结算作废：删掉故事资产，之后回到初始资产设定。返回是否真的删了
function deleteStoryAssets(characterName) {
  try {
    return removeFile(storyAssetsPath(characterName));
  } catch (err) {
    console.warn(`[pet] 角色 "${characterName}" 的故事资产删除失败: ${err.message}`);
    return false;
  }
}

// ---------- 给 LLM 看的文字 ----------
// 千分位 + 最多两位小数：1850000 → 1,850,000
function fmt(n) {
  const neg = n < 0;
  const [int, dec] = String(Math.abs(n)).split('.');
  return (neg ? '-' : '') + int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (dec ? '.' + dec : '');
}

// 提示词里不放括号（括号在提示词里表示场外说明）：用户填的名称、到账时间里的括号换成空格
const noParen = (s) => String(s).replace(/[()（）]/g, ' ').replace(/\s+/g, ' ').trim();

// 一方的完整描述
function describeParty(party, cur) {
  const s = calc.computeParty(party);
  const m = (n) => `${fmt(n)} ${cur}`;
  const lines = [];
  if (party.incomes.length || party.expenses.length || s.monthlyDebt) {
    lines.push(`每月收入 ${m(s.monthlyIncome)}，每月支出 ${m(s.monthlyExpense)}，每月${s.monthlySurplus >= 0 ? '结余' : '亏空'} ${m(Math.abs(s.monthlySurplus))}`);
  }
  lines.push('不同时间内能拿出的钱：');
  // 三档写法：不为负写「共 N」；为负：第一档写「无，已透支 N」，第二、三档写「无，倒欠 N」
  const tier = (label, v, owe) => `  - ${label}：${v < 0 ? `无，${owe} ${m(-v)}` : `共 ${m(v)}`}`;
  lines.push(tier('直接可用账户资金', s.today, '已透支'));
  lines.push(tier('卖掉 7 天内能到账的资产后的账户可用资金', s.within7, '倒欠'));
  lines.push(tier('卖掉所有资产并还清所有欠款后的账户可用资金', s.net31, '倒欠'));

  // 现金类资产已经算在「直接可用账户资金」里，这里只列还要卖才能变现的
  const sellable = party.assets.filter((a) => a.category !== calc.CASH_CATEGORY);
  if (sellable.length) {
    lines.push('名下可变现资产：');
    for (const a of sellable) lines.push(`  - ${noParen(a.name) || '未命名资产'}：可变现 ${m(a.amount)}；约 ${a.days} 天到账`);
  }
  // 已还完的负债不再发给 LLM
  const debts = party.liabilities.filter((l) => !l.paidOff);
  if (debts.length) {
    lines.push('负债：');
    for (const l of debts) {
      // 没填月供的负债不算进月度支出（欠着但短期内不想还），不写月供，免得和上面的每月支出对不上
      const pay = l.periods > 0 ? `，月供 ${m(l.monthly)}，还剩 ${l.periods} 期` : '，暂未安排还款';
      lines.push(`  - ${noParen(l.name) || '未命名负债'}：欠 ${m(l.principal)}${pay}`);
    }
  }
  if (party.incomes.length) {
    lines.push('月度收入：');
    for (const i of party.incomes) lines.push(`  - ${noParen(i.name) || '未命名'}：每月 ${m(i.monthly)}${i.payDay ? '，到账时间：每月 ' + i.payDay + ' 日' : ''}`);
  }
  if (party.expenses.length) {
    lines.push('除还债外的其它月度支出：');
    for (const e of party.expenses) lines.push(`  - ${noParen(e.name) || '未命名'}：每月 ${m(e.monthly)}`);
  }
  // 随身携带物：名称：数量单位；注：备注；数量没填（0）就不写数量，备注里的括号换成空格（提示词里括号是场外说明）
  if (party.belongings.length) {
    lines.push('随身携带物：');
    for (const b of party.belongings) {
      const qty = b.quantity > 0 ? `${fmt(b.quantity)}${noParen(b.unit)}` : ''; // 没填数量就连单位也不写
      const noteText = noParen(b.note);
      const note = noteText ? `注：${noteText}` : ''; // 备注加「注：」前缀，和数量区分开；备注为空就不写
      // 名称后：有数量写「：数量单位」，有备注写「；注：备注」，所以没数量时是「名称；注：备注」
      lines.push(`  - ${noParen(b.name) || '未命名物品'}${qty ? '：' + qty : ''}${note ? '；' + note : ''}`);
    }
  }
  return lines.join('\n');
}

// 拼进 prompt 的 <financial_status> 块；两方都没填就返回空字符串，调用方据此不发送。
// 块里的内容在两种情况下会变：用户改了资产设定，或故事日期跨过了「每月 1 日 / 收入到账日」（现金数字、负债期数随之推算）。
// 日期没跨过这些点时内容不变，所以仍放在固定前缀区；跨过时那一轮的前缀缓存会失效一次，之后又恢复命中。
function buildFinancialBlock(characterName, history) {
  const data = currentAssets(characterName, history); // 有故事资产用故事资产（已推算到当前故事日期），否则用初始资产
  const cur = data.currency;
  const hasChar = !calc.isPartyEmpty(data.character);
  const hasUser = !calc.isPartyEmpty(data.user);
  if (!hasChar && !hasUser) return '';

  const guide = [
    '财产状况影响角色的行为：',
    '- 角色日常消费要根据“直接可用账户资金”来，不能凭空变出超出额度的钱；',
    '- 有钱的不必为小钱计较，缺钱的一方会被价格、债务影响，可能因此示弱、将就或冒险；',
  ].join('\n');

  const parts = [];
  if (hasChar) parts.push(`<character_finance character="${characterName}">\n${describeParty(data.character, cur)}\n</character_finance>`);
  if (hasUser) {
    const known = data.userKnown
      ? `"${characterName}"清楚用户扮演的角色的财产状况。`
      : `"${characterName}"并不清楚用户扮演的角色的真实财力，只能从衣着、住处、出手大方与否等表现去推测。`;
    parts.push(`<user_finance>\n<!-- 用户所扮演的角色的财产。${known} -->\n${describeParty(data.user, cur)}\n</user_finance>`);
  }
  return `<financial_status>\n<!-- ${guide}\n-->\n${parts.join('\n\n')}\n</financial_status>`;
}

module.exports = { loadAssetSet, saveInitialAssets, saveStoryAssets, deleteStoryAssets, exportStoryAssets, restoreStoryAssets, buildFinancialBlock, currentStoryDate };
