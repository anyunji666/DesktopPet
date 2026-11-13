// ---------- 聊天历史处理：文本清洗 / 摊平成 prompt 文本 / 判断要不要压缩 ----------
// 只管"历史怎么变成一段文本"：<story_overview> 摘要块拆分、大总结 + 小总结 + 未压缩部分的分层、
// 字数统计与压缩范围的选取、小总结输出的解析。不碰 API 配置、不碰 prompt 模板、不发请求。
// 依赖方向：本文件只依赖 chat-store 和 summary-config，被 llm.js（拼 prompt）、chat-turn.js（一轮对话流程）、
// summarizer.js（后台压缩）和 story-overview.js（合并大总结）引用，不能反过来 require llm.js，否则会循环依赖。
const crypto = require('crypto');
const { loadSmallSummaries, loadStoryOverview } = require('./chat-store');
const { COMPACT_TRIGGER_CHARS, SMALL_SUMMARY_TARGET_CHARS, RECENT_RAW_ROUNDS } = require('./summary-config');

// SUMMARY_FOOTER 要求模型在回复末尾输出的摘要块标签（<story_overview>故事时间/概述</story_overview>）。
// 用带闭合标签的正则匹配，而不是简单地"从某个标记切到字符串末尾"——这样即使标签前后顺序有变化
// （比如摘要块前后夹了别的内容）也能准确截出摘要块本身，不会把别的内容也一起吞进去。
const STORY_OVERVIEW_RE = /<story_overview>[\s\S]*?<\/story_overview>/;

// 把 LLM 原始回复拆成 { body, summaryBlock }：summaryBlock 是摘要块原文（含标签，未找到则为空串），
// body 是去掉摘要块之后剩下的部分（可能还带着每个「」里的逐句语气【…】，由 chat-turn.js 用 stripTones 摘掉）。
// chat-turn.js 生成回复时用这个把"摘要块"和"正文"分开处理：正文（摘掉语气后）才进气泡和聊天记录展示，
// 摘要块只重新拼回持久化历史（喂给下一轮 LLM 用），三者互不干扰。
function splitTurnSummary(rawReply) {
  const raw = typeof rawReply === 'string' ? rawReply : '';
  const m = STORY_OVERVIEW_RE.exec(raw);
  if (!m) return { body: raw.trim(), summaryBlock: '' };
  return { body: raw.slice(0, m.index).trim(), summaryBlock: m[0].trim() };
}

// 从 assistant 内容的摘要块里取"故事时间"那一行的内容："故事时间: 2026年9月27日 21:40" → "2026年9月27日 21:40"（冒号中英文都认）。
// 没有摘要块 / 摘要块里没写故事时间 / 内容为空，都返回空串——调用方据此决定显示不显示。
// 聊天记录窗口给 AI 气泡打时间标签、故事时间的星期/节日播报（holiday/index.js）共用这一份。
const STORY_TIME_LINE_RE = /故事时间\s*[:：]\s*(.+)/;
function extractStoryTime(content) {
  const { summaryBlock } = splitTurnSummary(content);
  if (!summaryBlock) return '';
  const m = STORY_TIME_LINE_RE.exec(summaryBlock);
  return m ? m[1].trim() : '';
}

// 从"已经存进聊天记录"的 assistant 内容里提取摘要块，供 flattenChatHistory 做轮次压缩用。
// 找不到（老数据/模型没遵守格式）返回 null，调用方据此决定要不要退回发原文兜底。
// 返回值剥掉了首尾的 <story_overview>/</story_overview> 标签，只留"故事时间/概述"正文——
// 发给 LLM 的历史里不需要带这层标签，标签只是本地解析摘要块用的边界标记。
function extractTurnSummary(content) {
  const { summaryBlock } = splitTurnSummary(content);
  if (!summaryBlock) return null;
  return summaryBlock
    .replace(/^<story_overview>\s*/, '')
    .replace(/\s*<\/story_overview>$/, '')
    .trim();
}

// 从 assistant 内容的摘要块里取"概述"（"概述:"之后的全部内容，可多行）。没有摘要块 / 没写概述返回空串。
// 聊天记录窗口编辑 AI 消息时，摘要拆成"故事时间 / 概述"两个输入框，各自从这里和 extractStoryTime 取值。
const OVERVIEW_RE = /概述\s*[:：]\s*([\s\S]*)/;
function extractOverview(content) {
  const inner = extractTurnSummary(content);
  if (!inner) return '';
  const m = OVERVIEW_RE.exec(inner);
  return m ? m[1].trim() : '';
}

// 用"故事时间 / 概述"重新拼出摘要块（格式和 SUMMARY_FOOTER 要求模型输出的一致）。两项都为空返回空串（= 这条消息没有摘要）。
// 空的那一项整行省略，不写"故事时间: "这种空行。
function buildSummaryBlock(storyTime, overview) {
  const t = (storyTime || '').trim();
  const o = (overview || '').trim();
  if (!t && !o) return '';
  const lines = [];
  if (t) lines.push(`故事时间: ${t}`);
  if (o) lines.push(`概述: ${o}`);
  return `<story_overview>\n${lines.join('\n')}\n</story_overview>`;
}

// 把 epoch 毫秒格式化成 "YYYY年M月D日 HH:mm"（精确到分钟，本地时区；月/日不补零，时分补零）
function formatMinuteTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 总结标题里的时间："2026年9月27日 10:05"（月不补零、日补零、时分补零；区间两端各自带年份）
function formatShortTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}年${d.getMonth() + 1}月${pad(d.getDate())}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 故事时间统一成 "2026年9月27日 21:40" 这种带年份的写法（月不补零、日补零）；不认识的格式原样返回。
// 区间两端的年份都要写出来，所以这里不再按"是否同年"决定要不要省年份
const STORY_TIME_RE = /^(\d{4})年(\d{1,2})月(\d{1,2})日\s*(.*)$/;
function shortStoryTime(str) {
  const m = STORY_TIME_RE.exec((str || '').trim());
  if (!m) return (str || '').trim();
  const rest = m[4] ? ` ${m[4]}` : '';
  return `${m[1]}年${Number(m[2])}月${String(Number(m[3])).padStart(2, '0')}日${rest}`;
}

// 故事模式小总结的时间区间：首尾两个故事时间（只有一个或相同就只写一个，一个都没有返回空串）
function storyRangeLabel(first, last) {
  const a = (first || '').trim();
  const b = (last || '').trim();
  if (!a && !b) return { label: '', endLabel: '' };
  const sa = shortStoryTime(a || b);
  const sb = shortStoryTime(b || a);
  return { label: sa === sb ? sa : `${sa}～${sb}`, endLabel: sb };
}

// 网聊模式小总结的时间区间：用消息的现实时间
function realRangeLabel(fromTs, toTs) {
  const a = formatShortTime(fromTs);
  const b = formatShortTime(toTs);
  return { label: a === b ? a : `${a}～${b}`, endLabel: b };
}

// 大总结的标题行："2026年10月01日 20:10 及之前的旧剧情总览："（coveredLabel 为空 = 用户手写、还没合并过的总览，不带时间）。
// 摊平历史（发给模型）和合并大总结的提示词（llm.js 的 buildOverviewPrompt）共用；网聊模式叫"对话总览"
function overviewHeading(coveredLabel, mode = 'story') {
  const name = mode === 'chat' ? '对话总览' : '剧情总览';
  return coveredLabel ? `${coveredLabel} 及之前的旧${name}：` : `旧${name}：`;
}

// 小总结的标题前缀："2026年9月27日 10:00～2026年10月01日 20:10 的历史故事："（没有时间就省掉时间部分）。
// 区间是程序按首尾故事时间（网聊模式按消息时间）算出来的，不依赖模型输出
function smallSummaryHeading(label, mode = 'story') {
  const name = mode === 'chat' ? '聊天总结' : '历史故事';
  return label ? `${label} 的${name}：` : `${name}：`;
}

// 解析 buildSmallSummaryPrompt 要求的 "[总结]...[记忆]..." 两段式输出（同时兼容旧标记 [摘要]，两个标记都是 4 个字符，切片偏移一致）。
// 两个标记只要有一个缺失就把全文当总结，不强依赖格式一定标准，LLM 偶尔不听话也不至于直接崩。
function parseSummaryAndMemory(rawText) {
  const text = (rawText || '').trim();
  const sumMatch = /\[(?:总结|摘要)\]/.exec(text);
  const sumIdx = sumMatch ? sumMatch.index : -1;
  const memIdx = text.indexOf('[记忆]');
  let summaryPart = text;
  let memPart = '';
  if (sumIdx !== -1 && memIdx !== -1 && memIdx > sumIdx) {
    summaryPart = text.slice(sumIdx + 4, memIdx).trim();
    memPart = text.slice(memIdx + 4).trim();
  } else if (memIdx !== -1) {
    summaryPart = text.slice(0, memIdx).trim();
    memPart = text.slice(memIdx + 4).trim();
  } else if (sumIdx !== -1) {
    summaryPart = text.slice(sumIdx + 4).trim();
  }
  // "没有可记的"有各种写法：无 / 无。/ （无）/ - 无 / 暂无 / 没有 …… 这些都不是记忆，不能写进附加要求
  const NO_MEMORY_RE = /^[（(【\[]?\s*(?:暂?无|没有|无内容|无新增|none|n\/a)\s*[）)】\]]?[。.!！]?$/i;
  const memoryLines = memPart
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*·•]|\d+[.、)）])\s*/, '').trim())
    .filter((l) => l && !NO_MEMORY_RE.test(l));
  return { summary: summaryPart, memoryLines };
}

// ---------- 历史分析：哪些消息已并入大总结 / 已压成小总结 / 还没压缩，以及未压缩部分有多少字 ----------
// 发给模型的历史分三层，越早越概括，都在同一条时间线里依次输出：
//   1. 大总结：水位线 coveredUntil（消息时间戳）以前的所有消息已经并进它，作为开头：标题行 + 总览正文
//   2. 小总结：水位线之后、已经压成小总结的消息，每条小总结在它覆盖的第一条消息的位置输出一行 "时间区间 的历史故事：…"
//   3. 未压缩部分：按 user→assistant 配对切成"轮"。最近 RECENT_RAW_ROUNDS 轮永远发原文（不计入字数）；
//      更早的轮——故事模式用该轮 assistant 回复自带的摘要块（没有摘要块的轮退回发原文），网聊模式发原文——
//      这部分的总字数就是压缩的判断依据：超过 COMPACT_TRIGGER_CHARS 就由 summarizer.js 在回复后压成一条小总结
// 时间前缀：网聊模式的用户消息带真实发送时间 [YYYY年M月D日 HH:mm]，但只在这条和上一条用户消息不在同一分钟时才标
// （同一分钟连发的几条共用一个前缀，不然满屏重复）；模型据此判断这段聊天的时间跨度。
// 故事模式不发任何现实时间，只发故事时间。
function analyzeHistory(characterName, history, mode = 'story') {
  // === 读水位线与仍然生效的小总结 ===
  const chat = mode === 'chat';
  const overview = loadStoryOverview(characterName);
  const watermark = overview.coveredUntil;
  const summaries = loadSmallSummaries(characterName).filter((s) => s.toTs > watermark); // 已并进大总结的小总结不再发送

  // === 第一遍：给每条消息标状态和时间前缀 ===
  // 状态：merged 已并进大总结 / summarized 已压成小总结 / pending 还没压缩
  let prevUserMinute = null; // 上一条用户消息落在哪一分钟（epoch 分钟），null = 还没有过用户消息
  const items = history.map((h, index) => {
    const hasTs = typeof h.ts === 'number';
    let prefix = '';
    if (chat && h.role === 'user' && hasTs) {
      const minute = Math.floor(h.ts / 60000);
      if (minute !== prevUserMinute) prefix = `[${formatMinuteTime(h.ts)}] `;
      prevUserMinute = minute;
    }
    let state = 'pending';
    let summary = null;
    if (hasTs) {
      if (h.ts <= watermark) {
        state = 'merged';
      } else {
        summary = summaries.find((s) => h.ts >= s.fromTs && h.ts <= s.toTs) || null;
        if (summary) state = 'summarized';
      }
    }
    return { h, index, prefix, state, summary };
  });

  // === 第二遍：把 pending 的消息按"轮"配对 ===
  // 被小总结 / 大总结隔开的消息不配对（seg 是连续段编号）
  const seq = [];
  let seg = 0;
  let prevPending = false;
  for (const it of items) {
    if (it.state !== 'pending') {
      if (prevPending) seg++;
      prevPending = false;
      continue;
    }
    prevPending = true;
    it.seg = seg;
    seq.push(it);
  }
  const rounds = [];
  for (let i = 0; i < seq.length; i++) {
    const it = seq[i];
    const next = seq[i + 1];
    if (it.h.role === 'user' && next && next.h.role === 'assistant' && next.seg === it.seg) {
      rounds.push({ items: [it, next], seg: it.seg });
      i++;
    } else {
      rounds.push({ items: [it], seg: it.seg });
    }
  }
  const recentStart = Math.max(0, rounds.length - RECENT_RAW_ROUNDS);

  // === 每一轮怎么发：原文 / 摘要 / 压缩素材 ===
  // 原文怎么发：用户说的话标"用户"，AI 说的话标"你"（不用角色名——发给 LLM 的历史里，AI 自己的发言统一用"你"指代，
  // 因为 AI 实际扮演的身份可能被角色资料/世界背景改写，不一定等于角色名本身）。
  // 图片消息在文字侧降级成 "[图片:文件名]" 标记；图片本身只在 vision 开启时对"本轮"消息以视觉格式直发，历史图片不重发（省 token）。
  // assistant 存档内容末尾拼着 <story_overview> 摘要块，发原文时只要正文；故事模式把这一轮的故事时间单独成行放在轮首
  // （见下面 rounds.forEach：摘要块不发，模型就看不到"故事走到什么时间"，估算本轮故事时间没有锚点）
  const rawLinesOf = (it) => {
    const { h, prefix } = it;
    const body = h.role === 'assistant' ? splitTurnSummary(h.content).body : h.content;
    const imageTag = h.image ? `[图片:${h.image}]` : '';
    const content = imageTag ? (body ? `${imageTag} ${body}` : imageTag) : body;
    return [`${prefix}${h.role === 'user' ? '用户' : '你'}: ${content}`];
  };

  rounds.forEach((round, r) => {
    round.recent = r >= recentStart;
    round.compressible = round.items.every((it) => typeof it.h.ts === 'number');
    round.mode = 'raw';
    // 整轮原文：故事模式把这一轮 AI 回复的故事时间提到最前面（"故事时间 · …" 一行在用户这句之前），
    // 让"时间 → 这轮说了什么"的顺序和摘要行（故事时间 / 概述）一致；AI 回复的摘要块照旧剔掉
    const assistantItem = round.items.find((it) => it.h.role === 'assistant');
    const storyTime = !chat && assistantItem ? extractStoryTime(assistantItem.h.content) : '';
    round.rawLines = (storyTime ? [`故事时间 · ${storyTime}`] : []).concat(round.items.flatMap(rawLinesOf));
    round.lines = round.rawLines;
    if (!round.recent && !chat) {
      const sum = assistantItem ? extractTurnSummary(assistantItem.h.content) : null;
      if (sum) {
        round.mode = 'compact';
        round.lines = [sum];
      }
    }
    // 压缩素材用哪几行：故事模式下用户这轮写了括号元交流（设定 / 要求）的，整轮发原文，
    // 不再发摘要，也不另外补一行"用户元交流"——模型直接在原文的括号里读到，摘要块照旧剔除。
    // 这类原文比摘要长得多，字数按实际发的原文算（compressCost），压缩阈值和一批的大小都按它判断
    round.compressLines = round.lines;
    if (!chat && round.mode === 'compact') {
      const userItem = round.items.find((it) => it.h.role === 'user');
      const metas = userItem && typeof userItem.h.content === 'string' ? userItem.h.content.match(META_RE) : null;
      if (metas && metas.length) round.compressLines = round.rawLines;
    }
    round.cost = round.compressLines.join('\n').length;
  });
  const roundOf = new Map();
  for (const round of rounds) for (const it of round.items) roundOf.set(it, round);
  const pendingCost = rounds.reduce((n, r) => (r.recent ? n : n + r.cost), 0);

  // === 第三遍：按时间顺序拼最终文本 ===
  // 摘要行 和 保留原文的轮次 之间插一条 "——" 分隔线，只插一次——让模型一眼分清"这段是概述，这段是原话"
  const lines = [];
  if (overview.text) lines.push(overviewHeading(overview.coveredLabel, mode), overview.text);
  const emittedSummaries = new Set();
  let sawCompact = false;
  let sepInserted = false;
  for (const it of items) {
    if (it.state === 'merged') continue;
    if (it.state === 'summarized') {
      if (!emittedSummaries.has(it.summary)) {
        emittedSummaries.add(it.summary);
        lines.push(`${smallSummaryHeading(it.summary.label, mode)}${it.summary.text}`);
      }
      continue;
    }
    const round = roundOf.get(it);
    if (round.items[round.items.length - 1] !== it) continue; // 一轮的内容挂在最后一条消息的位置输出，保持时间顺序
    if (round.mode === 'compact') {
      lines.push(...round.lines);
      sawCompact = true;
    } else {
      if (sawCompact && !sepInserted) {
        lines.push('——');
        sepInserted = true;
      }
      lines.push(...round.lines);
    }
  }
  return { overview, items, rounds, pendingCost, text: lines.join('\n') };
}

// 把聊天记录摊平成发给模型的文本（分层规则见 analyzeHistory）
function flattenChatHistory(characterName, history, mode = 'story') {
  return analyzeHistory(characterName, history, mode).text;
}

// ---------- 压缩计划：要不要压、压哪一段 ----------
const sigOf = (h) => crypto.createHash('sha1').update(`${h.role}\n${h.content || ''}\n${h.image || ''}`).digest('hex').slice(0, 16);

// 故事模式下，用户写在括号里的元交流（设定 / 要求）。发给主模型的历史里这些用户原话被换成了摘要，
// 但压缩时要让 AI 还能从里面提炼长期要求：含括号的那一轮在"压缩素材"里整轮发原文（见 analyzeHistory 的 compressLines）
const META_RE = /[（(][^（）()]*[）)]/g;

// 返回 null = 不用压；否则 { fromTs, toTs, label, endLabel, lines, fingerprint, cost }：
//   · 未压缩部分（不含最近 RECENT_RAW_ROUNDS 轮）字数超过 COMPACT_TRIGGER_CHARS 才压
//   · 压最老的一段连续内容，累计字数够 COMPACT_TRIGGER_CHARS 就停（正常情况下基本是全部，攒了很多时分几次压）；
//     被小总结隔开的零碎段（用户编辑 / 删除历史后留下的缺口）不够一条小总结的长度就留着继续发原文，不单独为它调一次 LLM
//   · lines 是给总结提示词的素材（和实际发给模型的文本同一套格式；含元交流的轮次整轮发原文，见 analyzeHistory 的 compressLines）；
//     fingerprint 用来在写盘前核对这段消息有没有被用户改动过
function planCompaction(characterName, history, mode = 'story') {
  const chat = mode === 'chat';
  const a = analyzeHistory(characterName, history, mode);
  if (a.pendingCost <= COMPACT_TRIGGER_CHARS) return null;

  const older = a.rounds.filter((r) => !r.recent);
  let run = null;
  for (let i = 0; i < older.length && !run; ) {
    const seg = older[i].seg;
    const group = [];
    let cost = 0;
    for (; i < older.length && older[i].seg === seg; i++) {
      if (!older[i].compressible) break; // 没有时间戳的消息没法用时间范围标记，停在它前面
      group.push(older[i]);
      cost += older[i].cost;
      if (cost >= COMPACT_TRIGGER_CHARS) break;
    }
    if (group.length && cost >= SMALL_SUMMARY_TARGET_CHARS) run = { group, cost };
    else while (i < older.length && older[i].seg === seg) i++; // 这一段太短 / 不可压缩：跳到下一段
  }
  if (!run) return null;

  const runItems = run.group.flatMap((r) => r.items);
  const fromTs = runItems[0].h.ts;
  const toTs = runItems[runItems.length - 1].h.ts;
  let range;
  if (chat) {
    range = realRangeLabel(fromTs, toTs);
  } else {
    const times = runItems.filter((it) => it.h.role === 'assistant').map((it) => extractStoryTime(it.h.content)).filter(Boolean);
    range = storyRangeLabel(times[0], times[times.length - 1]);
  }
  const lines = [];
  for (const round of run.group) lines.push(...round.compressLines);
  return {
    fromTs,
    toTs,
    label: range.label,
    endLabel: range.endLabel,
    lines,
    cost: run.cost,
    fingerprint: runItems.map((it) => ({ ts: it.h.ts, sig: sigOf(it.h) })),
  };
}

// 压缩期间用户可能改了 / 删了这段消息（压缩在后台跑，聊天锁已经放开）：写盘前用这个核对，对不上就丢弃这次结果。
// 要求：时间范围内的消息条数没变，且每条都还是当初那份内容
function runStillValid(history, plan) {
  const inRange = history.filter((h) => typeof h.ts === 'number' && h.ts >= plan.fromTs && h.ts <= plan.toTs);
  if (inRange.length !== plan.fingerprint.length) return false;
  for (let i = 0; i < inRange.length; i++) {
    if (inRange[i].ts !== plan.fingerprint[i].ts || sigOf(inRange[i]) !== plan.fingerprint[i].sig) return false;
  }
  return true;
}

module.exports = {
  splitTurnSummary,
  extractStoryTime,
  extractTurnSummary,
  extractOverview,
  buildSummaryBlock,
  formatMinuteTime,
  overviewHeading,
  smallSummaryHeading,
  parseSummaryAndMemory,
  analyzeHistory,
  flattenChatHistory,
  planCompaction,
  runStillValid,
};
