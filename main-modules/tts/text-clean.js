// ---------- 朗读文本清洗：把 AI 回复整理成"适合读出来"的文字 ----------
// prompt 里现在要求模型输出严格分符号：角色对话用「」包裹、内心独白用 *星号* 包裹、
// 没有符号的正文是旁白。朗读规则：
//   1. 只提取所有「对话」片段拼接成朗读文本（*内心独白* 和旁白整段丢弃，不读）
//   2. 不兜底：如果整条回复里一个完整的「」都没有（模型没按格式输出），直接返回空串，不朗读
//   3. 去掉 emoji、markdown 符号、波浪号、残留的【语气描述】（正常已被 parseQuoteTone 拆出，这里双重保险）
//   4. 换行折成停顿；清洗后没有任何可读字符 => 返回空串（调用方据此跳过合成）
//   5. 超长时在句末截断（TTS 服务有长度/超时限制，桌宠回复本来也只有 2-3 句）
//
// 逐句语气：LLM 在每个「」里面、台词前面用【】写一句这句话的配音语气（例：「【嗔怪，语速偏快】你不要过来～」），
// splitSpeechSegments 把它拆成该段的 tone（只给豆包 / MiMo 当语气指令），stripQuoteTones 用来从气泡 / 聊天记录的正文里摘掉它。
//
// 朗读 AI 回复时用 splitSpeechSegments（见文件末尾）：每个「」是一段，单独发一次 TTS 请求；
// 相邻两段之间被丢弃的旁白 / 内心独白不读，但每段带上它在"阅读时间线"上的位置（readOffsetMs），
// 让语音的节奏顺着读者的阅读进度走（具体调度见 public/clip-schedule.js）。prepareSpeechText（所有「」拼成一整段）保留给设置窗口的"试听"用。

const MAX_TTS_CHARS = 400;
const TONE_MAX_CHARS = 100; // 提示词要求 ≤20 字，这里放宽一些容错；超过就当成普通台词，不拆
// 「」里开头的那一组语气描述。提示词要求全角【】，部分模型偶尔写成半角 [...]，两种都认
const LEADING_TONE_RE = new RegExp(`^\\s*(?:【([^【】\\n]{1,${TONE_MAX_CHARS}})】|\\[([^\\[\\]\\n]{1,${TONE_MAX_CHARS}})\\])\\s*`);
const READ_MS_PER_CHAR = 30; // 读者默读每个有效字的耗时（2000 字/分钟）：播放节奏按这个速度的"阅读时间线"推进
const GAP_MS_PER_CHAR = READ_MS_PER_CHAR; // 旧版"相对停顿"（gapBeforeMs）的每字毫秒数，只在没有 readOffsetMs 的老缓存语音上兜底用
const GAP_MIN_MS = 300; // 两段「」之间的最短停顿（紧挨着也留个气口）

// 拆开一个「」里面的内容：开头有语气描述就返回 { tone, body }（body 是去掉语气后的台词），没有则 tone 为空串、body 原样
function parseQuoteTone(inner) {
  const m = LEADING_TONE_RE.exec(inner);
  if (!m) return { tone: '', body: inner };
  return { tone: (m[1] || m[2] || '').trim(), body: inner.slice(m[0].length) };
}

// 摘掉正文里每个「」开头的语气描述，其余原样保留（气泡 / 聊天记录 / 回传给模型的历史都不该带语气）
function stripQuoteTones(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/「([^「」]*)」/g, (all, inner) => {
    const { tone, body } = parseQuoteTone(inner);
    return tone ? `「${body}」` : all;
  });
}

// 把所有「对话」片段（不支持嵌套，「」本身就是最小引号单位）按出现顺序取出来
function extractQuoted(s) {
  const re = /「([^「」]*)」/g;
  const parts = [];
  let m;
  while ((m = re.exec(s))) {
    if (m[1]) parts.push(m[1]);
  }
  return parts;
}

function truncateAtSentence(s, max) {
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const m = /^[\s\S]*[。！？!?…]/.exec(head);
  return m && m[0].length >= max * 0.4 ? m[0] : head;
}

// 单段文本的清洗（已经是"要读出来的内容"，不再做「」提取）：返回可朗读文本，没有可读字符返回空串
function cleanForSpeech(input) {
  let s = input;

  s = s.replace(/【[^【】]*】|\[[^[\]]*\]/g, ''); // 兜底：万一语气描述（全角【】或模型偶尔写成半角[...]）没被 parseQuoteTone 拆出，这里再挡一层
  s = s.replace(/`+/g, '').replace(/~~/g, '');
  s = s.replace(/^[ \t]*(?:#{1,6}|>)[ \t]*/gm, ''); // 标题 / 引用行首标记
  s = s.replace(/[~～]+/g, '');
  s = s.replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '');

  s = s.trim();
  // 行尾没有标点的换行补一个逗号当停顿，已有标点的直接接上
  s = s.replace(/([^\n。！？!?.…，,、；;：:])[ \t]*\n+[ \t]*/g, '$1，');
  s = s.replace(/\s*\n+\s*/g, '');
  s = s.replace(/[ \t\u3000]+/g, ' ');
  // 拼接/删符号后可能残留连续逗号或开头标点
  s = s.replace(/([，,、；;])\s*(?:[，,、；;]\s*)+/g, '$1');
  s = s.replace(/([。！？!?…])[，,、；;]+/g, '$1'); // 句末标点后紧跟拼接产生的逗号，去掉避免"。，"这种组合
  s = s.replace(/^[\s，,、；;：:]+/, '').trim();

  if (!/[\p{L}\p{N}]/u.test(s)) return '';
  return truncateAtSentence(s, MAX_TTS_CHARS);
}

// 所有「对话」拼成一整段的朗读文本（设置窗口"试听"用）
function prepareSpeechText(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw;

  s = s.replace(/\*\*([^*＊]+)\*\*/g, '$1'); // **强调** 保留文字

  const quoted = extractQuoted(s);
  if (!quoted.length) return ''; // 一个完整的「」都没有，说明模型没按格式输出，不兜底、直接不朗读
  s = quoted.join('，'); // 多段「」之间原本可能夹着被丢弃的旁白/内心独白，拼接时补个逗号当停顿，避免读起来挤在一起

  return cleanForSpeech(s);
}

// 有效字数：只数"会被读出来的字"（去掉语气【】、标点、符号、emoji、空白）
function readableLength(text) {
  return text
    .replace(/【[^【】]*】|\[[^[\]]*\]/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '').length;
}

// 旁白 / 独白折算停顿（旧版相对停顿，仅作老缓存的兜底）：有效字数 × 每字毫秒
function narrationGapMs(narration) {
  return readableLength(narration) * GAP_MS_PER_CHAR;
}

// 朗读 AI 回复：按「」切成若干段，每段 { text, gapBeforeMs }（按原文顺序）
//   · text：这个「」清洗后的朗读文本；清洗后没有可读字符的「」（比如「……」）直接丢掉
//   · tone：这个「」开头的语气描述（没写则为空串），合成这一段时当语气指令用
//   · readOffsetMs：阅读时间线上的位置 = 这个「」之前所有正文（旁白 / 独白 / 前面的台词）的有效字数 × READ_MS_PER_CHAR。
//     播放端据此调度：读者读到这里时才起播，语音比阅读慢时读者早已读完中间的旁白，只需等最小气口，不再叠加旁白时长
//   · gapBeforeMs：旧版相对停顿 = 它和上一段之间的旁白 / 独白折算时长（至少 GAP_MIN_MS），第一段为 0；
//     被丢掉的「」前后的旁白会并进下一段的停顿里。新播放端有 readOffsetMs 时不再用它，只给没有 readOffsetMs 的老缓存兜底
// 一个完整的「」都没有 => 返回空数组，不朗读（和 prepareSpeechText 一致，不兜底）
function splitSpeechSegments(raw) {
  if (typeof raw !== 'string') return [];
  const s = raw.replace(/\*\*([^*＊]+)\*\*/g, '$1');
  const re = /「([^「」]*)」/g;
  const segments = [];
  let lastEnd = 0;
  let pendingGap = 0;
  let m;
  while ((m = re.exec(s))) {
    pendingGap += narrationGapMs(s.slice(lastEnd, m.index));
    lastEnd = m.index + m[0].length;
    const { tone, body } = parseQuoteTone(m[1]);
    const text = cleanForSpeech(body);
    if (!text) continue;
    segments.push({
      text,
      tone,
      gapBeforeMs: segments.length ? Math.max(GAP_MIN_MS, pendingGap) : 0,
      readOffsetMs: readableLength(s.slice(0, m.index)) * READ_MS_PER_CHAR,
    });
    pendingGap = 0;
  }
  return segments;
}

module.exports = { MAX_TTS_CHARS, TONE_MAX_CHARS, parseQuoteTone, stripQuoteTones, READ_MS_PER_CHAR, GAP_MS_PER_CHAR, GAP_MIN_MS, prepareSpeechText, splitSpeechSegments };
