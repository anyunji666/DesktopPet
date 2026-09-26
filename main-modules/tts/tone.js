// ---------- 配音语气：让 LLM 在对话内容后面写一句语气指导，拆出来只给 TTS 用 ----------
// 约定的格式（提示词和解析共用下面这组常量，改格式只需要改这里）：
//   哦？最近又干出什么大事啦~【日常的闲聊，俏皮轻快的语气，语速偏快】
// 这句话不进气泡、不进聊天记录，只作为"语气指令"送给支持它的服务商：
//   · 豆包：additions.context_texts（官方"语音指令"，仅系统音色）
//   · MiMo：user 消息（官方"自然语言控制"，内容不会被念出来）
// Edge 没有语气能力，"不朗读"用不上 —— 这两种情况既不在提示词里要求，也不做拆分，避免误伤正文。
const { getTtsConfig } = require('./config');

const TONE_OPEN = '【';
const TONE_CLOSE = '】';
const TONE_MAX_CHARS = 100; // 提示词要求 ≤30 字，这里放宽一些容错；超过就当成普通正文，不拆
const TONE_PROVIDERS = ['doubao', 'mimo'];

// 只匹配回复最末尾的一组【…】（后面只允许有空白）
// 提示词要求模型用全角【】，但部分模型偶尔会写成半角 [...]，这里两种都认，避免解析不到导致语气描述漏拆、混进正文
const TRAILING_TONE = new RegExp(
  `(?:${TONE_OPEN}([^${TONE_OPEN}${TONE_CLOSE}\\n]{1,${TONE_MAX_CHARS}})${TONE_CLOSE}|\\[([^\\[\\]\\n]{1,${TONE_MAX_CHARS}})\\])\\s*$`
);

// 拼进 prompt 输出控制段落的要求（接在 llm.js 的 PROMPT_FOOTER 后面）
const TONE_PROMPT = [
  `- **语气描述：** 正文输出完后，紧跟着用${TONE_OPEN}${TONE_CLOSE}包裹写一句本次对话内容的语气指导（不超过 30 字，不计入上面的字数限制），概括对话内容的语气走向。要写成有画面感的具体描述，包含情绪、语调走向和说话状态，例如 ${TONE_OPEN}暧昧的悄悄话，压低声音带着笑意，语速偏慢${TONE_CLOSE}。`,
  `  - 格式示例：「你不要过来～」*怎么这样···*「真是服了你了～」小拳拳锤了一下{{user}}的胸口，还是默许了{{user}}的行为。${TONE_OPEN}先嗔怪后娇羞，语气从抗拒软化成撒娇，语速偏快${TONE_CLOSE}`,
].join('\n');

// 当前角色的服务商是否支持语气指令
function toneEnabled(characterName) {
  return TONE_PROVIDERS.includes(getTtsConfig(characterName).voice.provider);
}

// 把回复拆成 { text, tone }。没开语气控制 / 没写语气 / 拆完正文为空 => 原样返回、tone 为空
function splitTone(characterName, reply) {
  const raw = typeof reply === 'string' ? reply : '';
  if (!toneEnabled(characterName)) return { text: raw, tone: '' };
  const m = TRAILING_TONE.exec(raw);
  if (!m) return { text: raw, tone: '' };
  const text = raw.slice(0, m.index).trim();
  if (!text) return { text: raw, tone: '' };
  return { text, tone: (m[1] || m[2] || '').trim() };
}

module.exports = { TONE_PROMPT, toneEnabled, splitTone };
