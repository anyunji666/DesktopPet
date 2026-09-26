// ---------- API 配置 / Prompt 模板拼装 / LLM 请求 ----------
const { loadConfig, updateConfig } = require('./config');
const { loadPersona, loadDaySummary, loadMemoryIndex, loadOpenedDay, saveOpenedDay } = require('./chat-store');
const { TONE_PROMPT, toneEnabled } = require('./tts/tone');
const { extractMentionedDayKeys } = require('./date-detect');

// ---------- API 配置（存进 config.json 的 apiConfig 字段，和角色/场景选择共用同一份配置文件） ----------
function getApiConfig() {
  const cfg = loadConfig().apiConfig;
  return {
    api_url: (cfg && cfg.api_url) || '',
    api_key: (cfg && cfg.api_key) || '',
    model: (cfg && cfg.model) || '',
    temperature: Number.isFinite(cfg && cfg.temperature) ? cfg.temperature : 0.9,
    max_tokens: Number.isFinite(cfg && cfg.max_tokens) ? cfg.max_tokens : 300,
    // 当前模型是否支持识图（vision）：开=图片按 OpenAI 视觉格式直发；关=图片只以文字说明进 prompt
    vision: !!(cfg && cfg.vision),
  };
}

function saveApiConfig(patch) {
  const cur = getApiConfig();
  const next = {
    api_url: typeof patch.api_url === 'string' ? patch.api_url.trim() : cur.api_url,
    api_key: typeof patch.api_key === 'string' ? patch.api_key.trim() : cur.api_key,
    model: typeof patch.model === 'string' ? patch.model.trim() : cur.model,
    temperature: Number.isFinite(patch.temperature) ? patch.temperature : cur.temperature,
    max_tokens: Number.isFinite(patch.max_tokens) ? patch.max_tokens : cur.max_tokens,
    vision: typeof patch.vision === 'boolean' ? patch.vision : cur.vision,
  };
  updateConfig({ apiConfig: next });
  return next;
}

// ---------- Prompt 模板配置（存进 config.json 的 promptConfig 字段，全局生效，不区分角色） ----------
function getPromptConfig() {
  const cfg = loadConfig().promptConfig;
  return {
    prefix: (cfg && typeof cfg.prefix === 'string') ? cfg.prefix : '',
    readerInfo: (cfg && typeof cfg.readerInfo === 'string') ? cfg.readerInfo : '',
  };
}

function savePromptConfig(patch) {
  const cur = getPromptConfig();
  const next = {
    prefix: typeof patch.prefix === 'string' ? patch.prefix : cur.prefix,
    readerInfo: typeof patch.readerInfo === 'string' ? patch.readerInfo : cur.readerInfo,
  };
  updateConfig({ promptConfig: next });
  return next;
}

// 固定拼在模板末尾的说明段落（不受用户配置影响，硬编码）
// 解释怎么读 <user_input> 的规则，故意不算进固定前缀区——紧跟在 <user_input> 后面才最直觉，
// 让模型读完最新输入马上看到"怎么解读它"，比隔着一大段固定说明再回头看更不容易漏看/记混
const INPUT_NOTE = `## **用户的输入说明**

- 带括号的内容是用户对 你 说的话，亲爱的无所不能的 你 会动用所有能力满足用户——（元指令）
- 不带括号的内容就是用户在扮演他所设置的角色说话`;

// 固定拼在模板前面的说明段落（不受用户配置影响，硬编码）
const PROMPT_FOOTER = `## **输出控制**

- **语言：** 简体中文
- **符号规范**（严格区分）：
  - 角色的对话：用「」包裹，例：「这个给你，别嫌弃呀」
  - 角色的内心独白：用*星号*包裹，例：*其实等你好久了*
  - 没有符号的正文是旁白：描述环境、角色的动作神态，或者是对用户元指令的回答
  - 正文内容不要使用【】，详见语气描述
- 「对话」/ *内心独白* 灵活使用 标点/表情 符号：
  - 句末拖长音：「不要嘛～」
  - 句末重音：「什么！」、「真的吗！？」
  - 内心表示无语：*怎么这样···*
- **正文字数：** 角色回复的对话的内容字数每段控制在 1~200 字，也就是「」包裹的内容，可以分好几段。
  - 示例：「你不要过来～」*怎么这样···*「真是服了你了～」小拳拳锤了一下{{user}}的胸口，还是默许了{{user}}的行为。`;

// 把 epoch 毫秒格式化成 "YYYY-MM-DD HH:mm"（精确到分钟，本地时区）
function formatMinuteTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
// 摊平历史（今天 vs 上一个封存包）、以及主进程判断"跨天了要不要先补摘要"都靠这个算，抽出来两边共用。
function computeLastPastDayKey(history, refDayKey) {
  let lastPastDayKey = null;
  for (const h of history) {
    if (typeof h.ts !== 'number') continue;
    const dk = dayKeyOf(h.ts);
    if (dk < refDayKey && (lastPastDayKey === null || dk > lastPastDayKey)) lastPastDayKey = dk;
  }
  return lastPastDayKey;
}

// 摊平某一天的原始对话为 "speaker: content" 文本行，不带时间戳/日期分组——只给"生成这天的摘要"这个场景用，
// 和 flattenChatHistory 里发给正式回复 prompt 的格式（带时间戳、按天分组）是两回事。
function flattenDayLines(characterName, history, dayKey) {
  const lines = [];
  for (const h of history) {
    if (typeof h.ts !== 'number' || dayKeyOf(h.ts) !== dayKey) continue;
    const imageTag = h.image ? `[图片:${h.image}]` : '';
    const content = imageTag ? (h.content ? `${imageTag} ${h.content}` : imageTag) : h.content;
    const speaker = h.role === 'user' ? '用户' : characterName;
    lines.push(`${speaker}: ${content}`);
  }
  return lines;
}

// 生成"某天聊天摘要"用的 prompt：单独一次总结任务，不带角色人设/语气/输出格式那些约束，
// 避免摘要文本也带上角色口癖，污染归档内容。前置词（prefix）是全局的、给 AI 本身设定身份用的，
// 跟 buildPromptText 一样带上，保持这次调用里模型对自己是谁的认知一致。具体措辞先占位，后续再调整。
function buildSummaryPrompt(characterName, dayKey, dayLines) {
  const { prefix } = getPromptConfig();
  const parts = [];
  if (prefix.trim()) parts.push(prefix.trim());
  parts.push(`以下是用户和角色"${characterName}"在 ${formatDayCN(dayKey)} 的对话记录：`);
  parts.push(dayLines.join('\n'));
  parts.push('');
  parts.push('请按下面的格式输出，两部分都要给：');
  parts.push('[摘要]');
  parts.push('（不超过100字总结这天聊了什么；内容太多压不进100字就列几个要点，不需要覆盖所有细节，不要加"摘要："前缀，不要用分点符号）');
  parts.push('[记忆]');
  parts.push('（这天对话里出现的、值得长期记住的用户偏好/重要设定，浓缩成标签风格的关键词/短语，不要写完整句子，一行一条，每条不超过20字；有时效性的约定/日程不算，没有就只写"无"）');
  return parts.join('\n');
}

// 解析 buildSummaryPrompt 要求的 "[摘要]...[记忆]..." 两段式输出。
// 两个标记只要有一个缺失就把全文当摘要，不强依赖格式一定标准，LLM 偶尔不听话也不至于直接崩。
function parseSummaryAndMemory(rawText) {
  const text = (rawText || '').trim();
  const sumIdx = text.indexOf('[摘要]');
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

// 所有"封存天"（不展开、只发摘要那些天）的摘要正文加起来的总字数预算：这个才是会随着用的
// 时间变长一直往上涨的量。今天 / 上一个封印包 / 当前打开的封印包 都是全量发送，不设阈值——
// 一天内聊多少都不压缩，真正需要管的是"聊了多少天"，不是"某一天聊了多少"。
const SEALED_SUMMARY_BUDGET_CHARS = 2000;

// 把聊天记录摊平成文本：用户说的话标"用户"，AI 说的话标角色名（characterName）
// 图片消息在文字侧降级成 "[图片:文件名]" 标记：不支持识图的模型看文字标记也能知道"这里发过一张叫xxx的图"；
// 图片本身只在 vision 开启时对"本轮"消息以视觉格式直发，历史图片不重发（省 token）
//
// 历史按"自然日"分组做压缩，避免多日累积后上下文过长：
//   - 今天；"上一个封印包"（历史里早于今天的最新一天，不管隔了几天）；以及"当前打开的封印包"
//     （见 resolveOpenedDayKey：提到某个日期后跨轮持久展开，直到过了自然日或被新日期替换）=> 正常展开
//   - 其余更早的日子 => 只输出一行 "YYYY年M月D日 旧对话封印包"，具体内容不发给模型
// 时间戳：用户消息若与上一条间隔 >= 5 分钟，或者跨天了（哪怕间隔很短），都会带 [YYYY-MM-DD HH:mm] 前缀；
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

  // 第一遍：只按天分组，暂不决定封存天要不要发摘要——先把 history 摊成 { dayKey, sealed, msgs } 的天块列表，
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
        prefix = `[${formatMinuteTime(h.ts)}] `;
      }
    }
    if (hasTs) {
      prevTs = h.ts;
      prevDayKey = dk;
    }
    curDayMsgs.push({ h, prefix });
  }
  flushDay();

  // 第二遍：给封存天的摘要做总字数预算——从最新的封存天往回累加，超过 SEALED_SUMMARY_BUDGET_CHARS
  // 字就不再发更早那些天的摘要正文了（本地 -summaries.json 不受影响，之后提到那天照样能拆包展开）
  let budget = SEALED_SUMMARY_BUDGET_CHARS;
  const sendableSummary = new Map(); // dayKey -> summary 文本（只放"预算内、真发的"那些）
  for (let i = dayBlocks.length - 1; i >= 0; i--) {
    const block = dayBlocks[i];
    if (!block.sealed) continue;
    const summary = loadDaySummary(characterName, block.dayKey);
    if (!summary) continue; // 还没生成过摘要，走占位文案，不占预算
    if (summary.length > budget) continue; // 超预算：这天退化成占位文案，不是报错
    sendableSummary.set(block.dayKey, summary);
    budget -= summary.length;
  }

  // 第三遍：按原来的时间顺序拼最终文本
  const lines = [];
  for (const block of dayBlocks) {
    if (!block.sealed) {
      // 今天 / 上一个封印包 / 本轮提到的日期：不管聊了多少条、多少字，永远全量展开原文
      for (const { h, prefix } of block.msgs) {
        const imageTag = h.image ? `[图片:${h.image}]` : '';
        const content = imageTag ? (h.content ? `${imageTag} ${h.content}` : imageTag) : h.content;
        const speaker = h.role === 'user' ? '用户' : characterName;
        lines.push(`${prefix}${speaker}: ${content}`);
      }
    } else {
      const summary = sendableSummary.get(block.dayKey);
      lines.push(summary ? `${formatDayCN(block.dayKey)} 摘要：${summary}` : `${formatDayCN(block.dayKey)} 旧对话封印包`);
    }
  }

  return lines.join('\n');
}

// 按“酒馆式”单块模板拼装整份 prompt：
// 固定前缀（用户自定义前置文本 + <character_card> + <user_persona> + <memory_index> + 输出控制说明）
// --- 可变部分（<chat_history> + <user_input> + 用户输入说明，输入说明紧跟在 user_input 后面）
function buildPromptText(characterName, history, text) {
  const { prefix, readerInfo } = getPromptConfig();
  const characterCard = loadPersona(characterName);
  const chatHistoryText = flattenChatHistory(characterName, history, text);
  const nowText = formatMinuteTime(Date.now());

  // 固定内容（前缀/角色卡/用户设定/输出说明）全部前置且逐字节不变，聊天历史/本轮输入这些每次都在变的内容后置，
  // 这样发给 DeepSeek / Gemini 这类"自动前缀缓存"的 API 时，前面这一大段固定前缀才能被复用命中、省 token。
  const parts = [];
  if (prefix.trim()) parts.push(prefix.trim());
  parts.push('---');
  // 用户没填角色资料就不发这一段
  if (characterCard.trim()) {
    parts.push(`<character_card>\n<!-- 角色的设定资料。设计/扮演 该角色的行为对话时，要符合该角色的个性。 -->\n${characterCard}\n</character_card>`);
  }
  if (readerInfo.trim()) {
    parts.push(`<user_persona>\n<!-- 用户所扮演的角色设定资料 -->\n${readerInfo.trim()}\n</user_persona>`);
  }
  // hot 记忆索引：常驻的、只存"用户偏好/重要设定"这类没有时效性的长期结论的小索引，由跨天摘要/滚动摘要
  // 那次 LLM 调用顺带产出并追加，不需要每轮从全量历史里现猜。没内容就不发这一段
  const memoryIndex = loadMemoryIndex(characterName);
  if (memoryIndex.trim()) {
    parts.push(`<memory_index>\n<!-- 关于用户的长期记忆：偏好、重要设定等，需要一直记住并遵守 -->\n${memoryIndex.trim()}\n</memory_index>`);
  }
  // 当前角色的语音服务商支持语气指令（豆包 / MiMo）时，才要求 LLM 在对话内容后面写一句配音语气
  parts.push(toneEnabled(characterName) ? `${PROMPT_FOOTER}\n${TONE_PROMPT}` : PROMPT_FOOTER);
  parts.push('---');
  // ---- 以上是固定前缀，以下是每轮都会变化的内容 ----
  if (chatHistoryText.trim()) {
    parts.push(`<chat_history>\n<!-- 对话记录，按时间顺序排列；"某年某月某日 旧对话封印包"表示当天聊过，但内容已收起并未发送给你 -->\n${chatHistoryText}\n</chat_history>`);
  }
  parts.push(`<user_input>\n<!-- 用户本轮最新输入，当前系统时间：${nowText} -->\n[${nowText}] ${text}\n</user_input>`);
  parts.push('---');
  parts.push(INPUT_NOTE);

  return parts.join('\n\n');
}

// ---------- 审查用：最近一次 LLM 调用的请求/回复 ----------
// 只留最近 1 次（请求+回复算一条），正常回复和归档摘要两种调用都算在内，不区分类型，谁最后调用完就显示谁的。
// 原来是打印到 start.bat 的控制台窗口，后来发现 console.clear() 在 Windows 经典 cmd.exe 下不一定生效
// （不是 TTY / 不支持 ANSI 转义时会静默失效，导致记录在终端里一直累积），改成推给独立的
// "LLM调用记录" 窗口（window.js 的 openLlmLogWindow），窗口那边整体替换内容显示，不存在清不干净的问题。
// cmd 窗口那边不再打印任何东西，恢复成 Node/Electron 原本的样子。
let latestCall = null; // 最新一条：{ label, requestText, replyText, ts }
let logListener = null; // 由 main.js 注入：新记录产生时，推给"LLM调用记录"窗口（如果开着的话）

function setLlmLogListener(fn) {
  logListener = typeof fn === 'function' ? fn : null;
}

function getLatestLlmCall() {
  return latestCall;
}

// messages 可能是纯字符串 content，也可能是 vision 模式下的数组（文本+图片 dataURL）；
// 图片直接显示占地方又没意义，这里只留文字部分，图片用 [图片] 占位
function stringifyMessagesForLog(messages) {
  return messages
    .map((m) => {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return m.content.map((part) => (part.type === 'text' ? part.text : '[图片]')).join('\n');
      }
      return String(m.content);
    })
    .join('\n\n');
}

function logRecentCall(label, requestText, replyText) {
  latestCall = { label, requestText, replyText, ts: Date.now() };
  if (logListener) logListener(latestCall);
}

// 通用 OpenAI 兼容 /chat/completions 请求。特意放在主进程发起（而不是渲染进程 fetch），
// 是为了避免 API Key 出现在渲染进程的网络面板/DevTools 里
// label：这次调用是干嘛的（比如"对话回复 - xxx"/"摘要生成 - xxx"），只用来在调试日志里区分，不影响请求本身
async function callLLM(messages, label = '对话回复') {
  const cfg = getApiConfig();
  if (!cfg.api_url) throw new Error('未配置 API Base URL，请先在"⚙ API 设置"里填写');
  if (!cfg.model) throw new Error('未配置模型名称，请先在"⚙ API 设置"里填写');
  if (!cfg.api_key) throw new Error('未配置 API Key，请先在"⚙ API 设置"里填写');

  const baseUrl = cfg.api_url.replace(/\/$/, '');
  const url = baseUrl.endsWith('/chat/completions') ? baseUrl : baseUrl + '/chat/completions';

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.api_key}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: cfg.temperature,
      max_tokens: cfg.max_tokens,
      stream: false,
    }),
  });

  const rawText = await resp.text();
  let data = null;
  try {
    data = JSON.parse(rawText);
  } catch {}

  if (!resp.ok) {
    const msg = data && data.error && (data.error.message || JSON.stringify(data.error));
    throw new Error(`HTTP ${resp.status}${msg ? ': ' + msg : ''}`);
  }
  if (!data) throw new Error('LLM 响应不是有效 JSON');
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('LLM 响应中没有回复内容');
  const reply = content.trim();
  logRecentCall(label, stringifyMessagesForLog(messages), reply);
  return reply;
}

// 拉取模型列表（标准 OpenAI 兼容 GET /v1/models）。参数用调用方当前表单里的值（不强制先保存），
// 方便在设置弹窗里填完 url/key 直接点"加载模型"试。
function normalizeModelList(data) {
  const arr = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
  const names = arr.map((m) => (typeof m === 'string' ? m : m?.id || m?.name || '')).filter(Boolean);
  return [...new Set(names)];
}

async function fetchModelList(apiUrl, apiKey) {
  if (!apiUrl) throw new Error('请先填写 API Base URL');
  const baseUrl = apiUrl.replace(/\/$/, '');
  const url = baseUrl.endsWith('/models') ? baseUrl : `${baseUrl}/models`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
  });
  const rawText = await resp.text();
  let data = null;
  try {
    data = JSON.parse(rawText);
  } catch {}

  if (!resp.ok) {
    const msg = data && data.error && (data.error.message || JSON.stringify(data.error));
    throw new Error(`HTTP ${resp.status}${msg ? ': ' + msg : ''}`);
  }
  if (!data) throw new Error('响应不是有效 JSON');
  const list = normalizeModelList(data);
  if (!list.length) throw new Error('返回的模型列表是空的');
  return list;
}

module.exports = {
  getApiConfig,
  saveApiConfig,
  getPromptConfig,
  savePromptConfig,
  buildPromptText,
  callLLM,
  fetchModelList,
  dayKeyOf,
  computeLastPastDayKey,
  flattenDayLines,
  buildSummaryPrompt,
  parseSummaryAndMemory,
  setLlmLogListener,
  getLatestLlmCall,
};
