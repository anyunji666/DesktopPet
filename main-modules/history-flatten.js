// ---------- 聊天历史处理：文本清洗 / 按天封存 / 摊平成 prompt 文本 ----------
// 只管"历史怎么变成一段文本"：括号元指令过滤、<story_overview> 摘要块拆分、自然日分组、封存天总结预算、
// 轮次压缩、跨天总结的解析。不碰 API 配置、不碰 prompt 模板、不发请求。
// 依赖方向：本文件只依赖 chat-store / date-detect，被 llm.js（拼 prompt）和 chat-turn.js（一轮对话流程）引用，
// 不能反过来 require llm.js，否则会循环依赖。
const { loadDaySummary, loadOpenedDay, saveOpenedDay } = require('./chat-store');
const { extractMentionedDayKeys } = require('./date-detect');

// 约定：元指令 / 元回复用（半角或全角）括号包裹，属于 OOC（出戏）内容，不算"剧情"。
// 只用于"存历史/回填下一轮 prompt"这条链路，不影响本轮气泡显示、TTS 朗读、IPC 返回值。
// 简单起见按"非嵌套括号对"整体删除；不处理嵌套括号（约定用法下不会出现嵌套）。
const META_BRACKETS = /[（(][^（）()]*[）)]/g;

function stripMetaForHistory(content) {
  if (typeof content !== 'string') return content;
  return content.replace(META_BRACKETS, '').replace(/[ \t]{2,}/g, ' ').trim();
}

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

// 封印包一行的日期展示格式："YYYY年M月D日"（不补零）
function formatDayCN(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  return `${y}年${m}月${d}日`;
}

// "上一个封存包"：history 里所有早于 refDayKey 的日子中最新的那一天（不管隔了几天），没有则返回 null。
// 摊平历史（今天 vs 上一个封存包）、以及主进程判断"跨天了要不要先补总结"都靠这个算，抽出来两边共用。
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
function flattenDayLines(characterName, history, dayKey) {
  const lines = [];
  for (const h of history) {
    if (typeof h.ts !== 'number' || dayKeyOf(h.ts) !== dayKey) continue;
    const imageTag = h.image ? `[图片:${h.image}]` : '';
    const content = imageTag ? (h.content ? `${imageTag} ${h.content}` : imageTag) : h.content;
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
  const memoryLines =
    memPart && memPart !== '无'
      ? memPart
          .split('\n')
          .map((l) => l.replace(/^[-*·]\s*/, '').trim())
          .filter(Boolean)
      : [];
  return { summary: summaryPart, memoryLines };
}

// "当前打开的封印包"：跟 today / lastPastDayKey 不一样，这个是跨轮持久的——用户提到某天后，
// 哪怕后面几轮不再重复提这个日期，这天也会一直保持展开，直到过了自然日自动失效，或者被新提到的
// 另一个日期替换掉。同一时间只能有一个（不算 today / lastPastDayKey 这两个恒定展开的）：
//   - 本轮没提到日期，或者一句话里提到了不止一个日期（判定为“提及失败”）=> 不改动槽位，原样返回
//   - 提到的日期正好是 today 或 lastPastDayKey => 这两天反正本来就展开，不占槽位，不改动
//   - 提到唯一一个、且不是 today/lastPastDayKey 的日期 => 替换槽位为这天，并写盘持久化
// 过期判定：槽位的 markedOnDay（标记发生在哪个自然日）只要不等于当前 todayKey 就算过期，
// 复用跟 lastPastDayKey 一样的自然日口径，不引入额外的时间窗概念。
function resolveOpenedDayKey(characterName, currentInputText, todayKey, lastPastDayKey) {
  const mentioned = extractMentionedDayKeys(currentInputText || '');
  if (mentioned.length === 1) {
    const day = mentioned[0];
    if (day !== todayKey && day !== lastPastDayKey) {
      saveOpenedDay(characterName, day, todayKey);
    }
  }
  const stored = loadOpenedDay(characterName);
  return stored && stored.markedOnDay === todayKey ? stored.dayKey : null;
}

// 所有"封存天"（不展开、只发总结那些天）的总结正文加起来的总字数预算：这个才是会随着用的
// 时间变长一直往上涨的量。今天 / 上一个封印包 / 当前打开的封印包 都是全量发送，不设阈值——
// 一天内聊多少都不压缩，真正需要管的是"聊了多少天"，不是"某一天聊了多少"。
const SEALED_SUMMARY_BUDGET_CHARS = 2000;

// 把聊天记录摊平成文本：用户说的话标"用户"，AI 说的话标"你"（不用角色名——发给 LLM 的历史里，
// AI 自己的发言统一用"你"指代，因为 AI 实际扮演的身份可能被角色资料/世界背景改写，不一定等于角色名本身）
// 图片消息在文字侧降级成 "[图片:文件名]" 标记：不支持识图的模型看文字标记也能知道"这里发过一张叫xxx的图"；
// 图片本身只在 vision 开启时对"本轮"消息以视觉格式直发，历史图片不重发（省 token）
//
// 历史按"自然日"分组做压缩，避免多日累积后上下文过长：
//   - 今天；"上一个封印包"（历史里早于今天的最新一天，不管隔了几天）；以及"当前打开的封印包"
//     （见 resolveOpenedDayKey：提到某个日期后跨轮持久展开，直到过了自然日或被新日期替换）=> 正常展开
//   - 其余更早的日子 => 只输出一行 "YYYY年M月D日 旧对话封印包"，具体内容不发给模型
// 时间戳：用户消息若与上一条间隔 >= 5 分钟，或者跨天了（哪怕间隔很短），都会带 [元时间 YYYY年M月D日 HH:mm] 前缀；
// 角色的回复永远不带时间戳，但"跨天"是按实际发送时间判断的，不看是谁发的这条。
function flattenChatHistory(characterName, history, currentInputText) {
  const GAP_MS = 5 * 60 * 1000;
  const todayKey = dayKeyOf(Date.now());

  // 上一个封印包：历史里所有早于今天的日子中最新的那一天（不管隔了几天）
  const lastPastDayKey = computeLastPastDayKey(history, todayKey);

  const openedDayKey = resolveOpenedDayKey(characterName, currentInputText, todayKey, lastPastDayKey);
  const unsealed = new Set([todayKey]);
  if (lastPastDayKey !== null) unsealed.add(lastPastDayKey);
  if (openedDayKey !== null) unsealed.add(openedDayKey);

  // 第一遍：只按天分组，暂不决定封存天要不要发总结——先把 history 摊成 { dayKey, sealed, msgs } 的天块列表，
  // sealed = true 表示这天不在 unsealed 集合里，属于要收起来的"封存天"
  let prevTs = null;
  let prevDayKey = null;
  let curDayKey = null;
  let curDayMsgs = []; // { h, prefix }
  const dayBlocks = [];

  const flushDay = () => {
    if (curDayKey === null) return;
    dayBlocks.push({ dayKey: curDayKey, sealed: !unsealed.has(curDayKey), msgs: curDayMsgs });
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
        prefix = `[元时间 ${formatMinuteTime(h.ts)}] `;
      }
    }
    if (hasTs) {
      prevTs = h.ts;
      prevDayKey = dk;
    }
    curDayMsgs.push({ h, prefix });
  }
  flushDay();

  // 第二遍：给封存天的总结做总字数预算——从最新的封存天往回累加，超过 SEALED_SUMMARY_BUDGET_CHARS
  // 字就不再发更早那些天的总结正文了（本地 -summaries.json 不受影响，之后提到那天照样能拆包展开）
  let budget = SEALED_SUMMARY_BUDGET_CHARS;
  const sendableSummary = new Map(); // dayKey -> summary 文本（只放"预算内、真发的"那些）
  for (let i = dayBlocks.length - 1; i >= 0; i--) {
    const block = dayBlocks[i];
    if (!block.sealed) continue;
    const summary = loadDaySummary(characterName, block.dayKey);
    if (!summary) continue; // 还没生成过总结，走占位文案，不占预算
    if (summary.length > budget) continue; // 超预算：这天退化成占位文案，不是报错
    sendableSummary.set(block.dayKey, summary);
    budget -= summary.length;
  }

  // 第二点五遍：未封存天（今天/上一个封印包/打开的封印包）内部再按"轮次"压缩一层——
  // 这些天不管聊多少条，之前是无脑全量展开原文，天数一多同样会把 prompt 撑爆。
  // 做法：把所有未封存天的消息摊平成一条时间线（不看日期边界），按 user→assistant 配对切成"轮"，
  // 落单的消息（没配对上）自己算一轮；最近 RECENT_RAW_ROUNDS 轮保留原文，
  // 更早的轮尝试用该轮 assistant 回复自带的 [摘要] 块替换原文——找不到就整轮退回原文兜底，不丢内容。
  // 在 { h, prefix } 这些包装对象上直接标 renderMode，不动 h 本身，也不落盘，只影响这次拼 prompt。
  const RECENT_RAW_ROUNDS = 2;
  const unsealedItems = [];
  for (const block of dayBlocks) {
    if (block.sealed) continue;
    for (const item of block.msgs) unsealedItems.push(item);
  }
  const rounds = [];
  for (let i = 0; i < unsealedItems.length; i++) {
    const item = unsealedItems[i];
    const next = unsealedItems[i + 1];
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
    if (r >= recentStart) {
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
  let sawCompact = false;
  let sepInserted = false;
  for (const block of dayBlocks) {
    if (!block.sealed) {
      // 今天 / 上一个封印包 / 本轮提到的日期：按上面标好的 renderMode 输出（原文 / 压缩摘要 / 跳过）
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
      }
    } else {
      const summary = sendableSummary.get(block.dayKey);
      lines.push(summary ? `元时间 ${formatDayCN(block.dayKey)} 的总结：${summary}` : `元时间 ${formatDayCN(block.dayKey)} 的旧对话封印包`);
    }
  }

  return lines.join('\n');
}

module.exports = {
  stripMetaForHistory,
  splitTurnSummary,
  extractStoryTime,
  formatMinuteTime,
  dayKeyOf,
  formatDayCN,
  computeLastPastDayKey,
  flattenDayLines,
  parseSummaryAndMemory,
  flattenChatHistory,
};
