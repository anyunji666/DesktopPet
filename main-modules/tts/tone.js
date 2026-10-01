// ---------- 配音语气：让 LLM 给每个「」各写一句语气指导，拆出来只给 TTS 用 ----------
// 约定的格式：语气写在每个「」里面、台词前面，用全角【】包裹：
//   「【嗔怪抗拒，语速偏快】你不要过来～」*怎么这样···*「【无奈带笑，尾音上扬】真是服了你了～」
// 这句话不进气泡、不进聊天记录、不回传给模型，只作为"语气指令"送给支持它的服务商（每段单独一条）：
//   · 豆包：additions.context_texts（官方"语音指令"，仅系统音色）
//   · MiMo：user 消息（官方"自然语言控制"，内容不会被念出来）
// Edge 没有语气能力，"不朗读"用不上 —— 这两种情况既不在提示词里要求，也不做摘除，避免误伤正文。
// 解析本身（拆出每段的 tone、摘除正文里的语气）在 text-clean.js：splitSpeechSegments / stripQuoteTones；
// 要求 LLM 写语气的提示词在 llm.js 的 OUTPUT_RULES_TONE（没开语气则发 OUTPUT_RULES_PLAIN）。
const { getTtsConfig } = require('./config');
const { stripQuoteTones } = require('./text-clean');

const TONE_PROVIDERS = ['doubao', 'mimo'];

// 当前角色的服务商是否支持语气指令
function toneEnabled(characterName) {
  return TONE_PROVIDERS.includes(getTtsConfig(characterName).voice.provider);
}

// 摘掉正文里每个「」开头的语气描述，给气泡 / 聊天记录 / IPC 返回值用。没开语气控制就原样返回
function stripTones(characterName, reply) {
  const raw = typeof reply === 'string' ? reply : '';
  return toneEnabled(characterName) ? stripQuoteTones(raw) : raw;
}

module.exports = { toneEnabled, stripTones };
