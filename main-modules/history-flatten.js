// ---------- 聊天历史处理：文本清洗 / 按天分层 / 摊平成 prompt 文本 ----------
// 只管"历史怎么变成一段文本"：<story_overview> 摘要块拆分、自然日分组、未并入总览的日总结、
// 轮次压缩、跨天总结的解析。不碰 API 配置、不碰 prompt 模板、不发请求。
// 依赖方向：本文件只依赖 chat-store，被 llm.js（拼 prompt）、chat-turn.js（一轮对话流程）和
// story-overview.js（合并剧情总览）引用，不能反过来 require llm.js，否则会循环依赖。
const { loadDaySummaries, loadStoryOverview } = require('./chat-store');

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

// 把 epoch 毫秒格式化成 "YYYY年M月D日 HH:mm"（精确到分钟，本地时区；月/日不补零，与 formatDayCN 一致，时分补零）
function formatMinuteTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 把 ts 归到本地自然日 key："YYYY-MM-DD"（补零，仅用于分组/比较）
function dayKeyOf(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 日期展示格式："YYYY年M月D日"（不补零）
function formatDayCN(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  return `${y}年${m}月${d}日`;
}

// "上一天"：history 里所有早于 refDayKey 的日子中最新的那一天（不管隔了几天），没有则返回 null。
// 摊平历史（今天 + 上一天发原文）、以及主进程判断"跨天了要不要先补总结"都靠这个算，抽出来两边共用。
function computeLastPastDayKey(history, refDayKey) {
  let lastPastDayKey = null;
  for (const h of history) {
    if (typeof h.ts !== 'number') continue;
    const dk = dayKeyOf(h.ts);
    if (dk < refDayKey && (lastPastDayKey === null || dk > lastPastDayKey)) lastPastDayKey = dk;
  }
  return lastPastDayKey;
}

// 摊平某一天的原始对话为 "speaker: content" 文本行，不带时间戳/日期分组——只给"生成这天的总结"这个场景用，
// 和 flattenChatHistory 里发给正式回复 prompt 的格式（带时间戳、按天分组）是两回事。
// AI 回复只取正文，去掉存档末尾拼着的 <story_overview> 摘要块，只在行尾留一个 [故事时间:…]
// （跟聊天记录窗口气泡末尾的时间标签一致；用方括号而不是圆括号，圆括号在这套约定里是元指令）。
// 对话模式（mode === 'chat'）没有故事时间这个概念，行尾不加 [故事时间:…]（切换前留下的老消息也不加）。
function flattenDayLines(characterName, history, dayKey, mode = 'story') {
  const lines = [];
  for (const h of history) {
    if (typeof h.ts !== 'number' || dayKeyOf(h.ts) !== dayKey) continue;
    const imageTag = h.image ? `[图片:${h.image}]` : '';
    let text = h.content;
    if (h.role === 'assistant') {
      text = splitTurnSummary(h.content).body;
      const storyTime = mode === 'chat' ? '' : extractStoryTime(h.content);
      if (storyTime) text = `${text} [故事时间:${storyTime}]`;
    }
    const content = imageTag ? (text ? `${imageTag} ${text}` : imageTag) : text;
    const speaker = h.role === 'user' ? '用户' : '你';
    lines.push(`${speaker}: ${content}`);
  }
  return lines;
}

// 解析 buildSummaryPrompt 要求的 "[总结]...[记忆]..." 两段式输出（同时兼容旧标记 [摘要]，两个标记都是 4 个字符，切片偏移一致）。
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

// 剧情总览的标题行："元时间 X年X月X日 及之前的旧剧情总览："（水位线 coveredUntil 为空 = 用户手写、还没合并过的总览，不带日期）。
// 摊平历史（发给模型）和合并总览的提示词（llm.js 的 buildOverviewPrompt）共用
// 对话模式叫"对话总览"，日期前不带"元时间"（对话模式里只有现实时间，不需要区分故事时间）
function overviewHeading(coveredUntil, mode = 'story') {
  if (mode === 'chat') return coveredUntil ? `${formatDayCN(coveredUntil)} 及之前的旧对话总览：` : '旧对话总览：';
  return coveredUntil ? `元时间 ${formatDayCN(coveredUntil)} 及之前的旧剧情总览：` : '旧剧情总览：';
}

// 还没并进剧情总览的日总结：早于"上一天"（原文发送的那天）、晚于总览水位线 coveredUntil、并且已经生成过总结的那些天，
// 按日期从早到晚返回 [{ dayKey, text }]。摊平历史（发给模型）和判断"要不要合并总览"都用这一份，口径保持一致。
// 只看 history 里实际还有消息的天：整天的消息被用户删光后，遗留的总结不再发送。
function collectUnmergedSummaries(characterName, history, todayKey = dayKeyOf(Date.now())) {
  const lastPastDayKey = computeLastPastDayKey(history, todayKey);
  if (lastPastDayKey === null) return [];
  const { coveredUntil } = loadStoryOverview(characterName);
  const summaries = loadDaySummaries(characterName);
  const days = new Set();
  for (const h of history) {
    if (typeof h.ts !== 'number') continue;
    const dk = dayKeyOf(h.ts);
    if (dk < lastPastDayKey && (!coveredUntil || dk > coveredUntil)) days.add(dk);
  }
  return [...days]
    .sort()
    .filter((dk) => typeof summaries[dk] === 'string' && summaries[dk])
    .map((dk) => ({ dayKey: dk, text: summaries[dk] }));
}

// 把聊天记录摊平成文本：用户说的话标"用户"，AI 说的话标"你"（不用角色名——发给 LLM 的历史里，
// AI 自己的发言统一用"你"指代，因为 AI 实际扮演的身份可能被角色资料/世界背景改写，不一定等于角色名本身）
// 图片消息在文字侧降级成 "[图片:文件名]" 标记：不支持识图的模型看文字标记也能知道"这里发过一张叫xxx的图"；
// 图片本身只在 vision 开启时对"本轮"消息以视觉格式直发，历史图片不重发（省 token）
//
// 历史分三层，越早越概括，都在同一条时间线里依次输出：
//   1. 剧情总览：水位线 coveredUntil 以前的所有日子，已经被压缩成一份不超过 1200 字的总览，作为开头：标题行 `元时间 X 及之前的旧剧情总览：` + 总览正文（不加标签）
//   2. 日总结：总览水位线之后、早于"上一天"的每一天各一行 "元时间 YYYY年M月D日 的故事总结：…"（还没生成过总结的天不输出）
//   3. 原文：今天和"上一天"（历史里早于今天的最新一天，不管隔了几天）；内部再按轮次压缩（见下）
// 时间戳：用户消息若与上一条间隔 >= 5 分钟，或者跨天了（哪怕间隔很短），都会带 [元时间 YYYY年M月D日 HH:mm] 前缀；
// 角色的回复永远不带时间戳，但"跨天"是按实际发送时间判断的，不看是谁发的这条。
//
// 对话模式（mode === 'chat'）和上面的差别：不做轮次压缩（今天 / 上一天的消息全部发原文，不用每轮摘要块）；
// 不输出"故事时间"行；时间戳前缀写 [时间 …] 而不是 [元时间 …]，日总结 / 总览的标题也不带"元时间""故事"字样。
// 日总结和总览仍然保留。
function flattenChatHistory(characterName, history, mode = 'story') {
  const chat = mode === 'chat';
  const GAP_MS = 5 * 60 * 1000;
  const todayKey = dayKeyOf(Date.now());

  // 上一天：历史里所有早于今天的日子中最新的那一天（不管隔了几天）
  const lastPastDayKey = computeLastPastDayKey(history, todayKey);

  const rawDays = new Set([todayKey]);
  if (lastPastDayKey !== null) rawDays.add(lastPastDayKey);
  const summaryOfDay = new Map(collectUnmergedSummaries(characterName, history, todayKey).map((x) => [x.dayKey, x.text]));

  // 第一遍：只按天分组，把 history 摊成 { dayKey, old, msgs } 的天块列表，
  // old = true 表示这天不发原文（要么已并进总览，要么只发日总结）
  let prevTs = null;
  let prevDayKey = null;
  let curDayKey = null;
  let curDayMsgs = []; // { h, prefix }
  const dayBlocks = [];

  const flushDay = () => {
    if (curDayKey === null) return;
    dayBlocks.push({ dayKey: curDayKey, old: !rawDays.has(curDayKey), msgs: curDayMsgs });
    curDayMsgs = [];
  };

  for (const h of history) {
    const hasTs = typeof h.ts === 'number';
    const dk = hasTs ? dayKeyOf(h.ts) : curDayKey; // 极端情况没有 ts：并入当前这天，不单独分组
    if (dk !== curDayKey) {
      flushDay();
      curDayKey = dk;
    }

    let prefix = '';
    if (h.role === 'user' && hasTs) {
      const crossedDay = prevDayKey !== null && dk !== prevDayKey;
      if (prevTs === null || h.ts - prevTs >= GAP_MS || crossedDay) {
        prefix = `[${chat ? '时间' : '元时间'} ${formatMinuteTime(h.ts)}] `;
      }
    }
    if (hasTs) {
      prevTs = h.ts;
      prevDayKey = dk;
    }
    curDayMsgs.push({ h, prefix });
  }
  flushDay();

  // 第二遍：原文天（今天 / 上一天）内部再按"轮次"压缩一层——
  // 这些天不管聊多少条，之前是无脑全量展开原文，聊得多了同样会把 prompt 撑爆。
  // 做法：把原文天的消息摊平成一条时间线（不看日期边界），按 user→assistant 配对切成"轮"，
  // 落单的消息（没配对上）自己算一轮；最近 RECENT_RAW_ROUNDS 轮保留原文，
  // 更早的轮尝试用该轮 assistant 回复自带的 [摘要] 块替换原文——找不到就整轮退回原文兜底，不丢内容。
  // 在 { h, prefix } 这些包装对象上直接标 renderMode，不动 h 本身，也不落盘，只影响这次拼 prompt。
  const RECENT_RAW_ROUNDS = 2;
  const rawItems = [];
  for (const block of dayBlocks) {
    if (block.old) continue;
    for (const item of block.msgs) rawItems.push(item);
  }
  const rounds = [];
  for (let i = 0; i < rawItems.length; i++) {
    const item = rawItems[i];
    const next = rawItems[i + 1];
    if (item.h.role === 'user' && next && next.h.role === 'assistant') {
      rounds.push([item, next]);
      i++; // next 已配进这一轮，跳过
    } else {
      rounds.push([item]);
    }
  }
  const recentStart = Math.max(0, rounds.length - RECENT_RAW_ROUNDS);
  for (let r = 0; r < rounds.length; r++) {
    const round = rounds[r];
    if (chat || r >= recentStart) { // 对话模式不压缩：每一轮都发原文
      for (const item of round) item.renderMode = 'raw';
      continue;
    }
    const assistantItem = round.find((it) => it.h.role === 'assistant');
    const summary = assistantItem ? extractTurnSummary(assistantItem.h.content) : null;
    if (!summary) {
      for (const item of round) item.renderMode = 'raw'; // 没有可用摘要：兜底保留原文
      continue;
    }
    for (const item of round) item.renderMode = 'skip';
    round[round.length - 1].renderMode = 'compact'; // 压缩行挂在这轮最后一条消息的位置，保持时间顺序
    round[round.length - 1].compactText = summary;
  }

  // 第三遍：按原来的时间顺序拼最终文本
  // sawCompact/sepInserted：压缩摘要行 和 保留原文的最近轮次 之间插一条 "——" 分隔线，只插一次——
  // 在第一条"原文"行前面、且前面确实出现过压缩摘要时插入，让模型一眼分清"这段是概述，这段是原话"。
  const lines = [];
  const overview = loadStoryOverview(characterName);
  if (overview.text) lines.push(overviewHeading(overview.coveredUntil, mode), overview.text);
  let sawCompact = false;
  let sepInserted = false;
  for (const block of dayBlocks) {
    if (block.old) {
      // 已并进总览的天（水位线以前）不输出；其余只发日总结，没生成过总结的天也不输出
      const summary = summaryOfDay.get(block.dayKey);
      if (summary) lines.push(chat ? `${formatDayCN(block.dayKey)} 的聊天总结：${summary}` : `元时间 ${formatDayCN(block.dayKey)} 的故事总结：${summary}`);
      continue;
    }
    // 今天 / 上一天：按上面标好的 renderMode 输出（原文 / 压缩摘要 / 跳过）
    for (const item of block.msgs) {
      const { h, prefix } = item;
      if (item.renderMode === 'skip') continue;
      if (item.renderMode === 'compact') {
        lines.push(item.compactText);
        sawCompact = true;
        continue;
      }
      if (sawCompact && !sepInserted) {
        lines.push('——');
        sepInserted = true;
      }
      // assistant 存档内容末尾拼着 <story_overview> 摘要块（给轮次压缩当数据源用），
      // 这里是"发原文"的分支，只要正文，摘要块不发（避免最近两轮也带一份摘要块，显得重复）
      const rawContent = h.role === 'assistant' ? splitTurnSummary(h.content).body : h.content;
      const imageTag = h.image ? `[图片:${h.image}]` : '';
      const content = imageTag ? (rawContent ? `${imageTag} ${rawContent}` : imageTag) : rawContent;
      const speaker = h.role === 'user' ? '用户' : '你';
      lines.push(`${prefix}${speaker}: ${content}`);
      // 每轮原文 assistant 回复后面跟一行它自己的故事时间（文案和聊天记录窗口气泡末尾的标签一致）：
      // 摘要块不发，模型就看不到"故事走到什么时间"，估算本轮故事时间没有锚点。
      // 逐轮贴在自己那条下面，最近两轮各有一行；压缩成摘要的轮次本来就在摘要里带着故事时间，不重复补。
      if (h.role === 'assistant' && !chat) {
        const storyTime = extractStoryTime(h.content);
        if (storyTime) lines.push(`故事时间 · ${storyTime}`);
      }
    }
  }

  return lines.join('\n');
}

module.exports = {
  splitTurnSummary,
  extractStoryTime,
  extractOverview,
  buildSummaryBlock,
  formatMinuteTime,
  dayKeyOf,
  formatDayCN,
  computeLastPastDayKey,
  overviewHeading,
  collectUnmergedSummaries,
  flattenDayLines,
  parseSummaryAndMemory,
  flattenChatHistory,
};
