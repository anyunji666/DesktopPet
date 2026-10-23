// ---------- 语音合成配置：读取 / 规整 / 持久化 ----------
// 存进 config.json 的 ttsConfig 字段（和 apiConfig / promptConfig 共用同一份配置文件）：
//   providers  —— 各服务商的密钥等"全角色共用"的设置
//   characters —— 以角色名为 key，每个角色自己的"服务商 + 各家音色参数"
// 每个角色把三家的参数都留着（provider 只决定当前用哪家），切换服务商对比试音时不用重填。
const { loadConfig, updateConfig } = require('../config');
const { state } = require('../state');
const { readPersonaFile } = require('../chat-store');
const { maskSecret, resolveSecretInput } = require('../security');

const PROVIDERS = ['off', 'edge', 'doubao', 'mimo'];
const MIMO_MODES = ['preset', 'clone'];
const DOUBAO_VOICE_SOURCES = ['custom', 'preset']; // 豆包音色来源：自定义 ID 输入 / 预置音色
const DEFAULT_MIMO_BASE_URL = 'https://api.xiaomimimo.com/v1';
const DEFAULT_DOUBAO_RESOURCE_ID = 'seed-tts-2.0';

const str = (v) => (typeof v === 'string' ? v.trim() : '');

// 语速/音调/音量：只接受 "10" / "+10%" / "-5Hz" 这种写法，其它一律当"默认"（空串）
function prosody(v) {
  const s = typeof v === 'number' ? String(v) : str(v);
  return /^[+-]?\d+(\.\d+)?(%|Hz)?$/i.test(s) ? s : '';
}

// 参考音频元信息只认纯文件名，防止 config 被改成路径穿越
function cloneMeta(v) {
  if (!v || typeof v !== 'object') return null;
  const file = str(v.file);
  if (!file || file.includes('/') || file.includes('\\') || file === '.' || file === '..') return null;
  return { file, name: str(v.name) || file, mime: str(v.mime), size: Number.isFinite(v.size) ? v.size : 0 };
}

function normalizeProviders(p) {
  const src = p && typeof p === 'object' ? p : {};
  const d = src.doubao || {};
  const m = src.mimo || {};
  return {
    doubao: { app_id: str(d.app_id), access_key: str(d.access_key) },
    mimo: {
      api_key: str(m.api_key),
      base_url: str(m.base_url).replace(/\/+$/, '') || DEFAULT_MIMO_BASE_URL,
      // 返回格式固定 mp3（体积小、传输快，语音本来也不落地存储），不再开放配置
    },
  };
}

function normalizeVoice(v) {
  const src = v && typeof v === 'object' ? v : {};
  const e = src.edge || {};
  const d = src.doubao || {};
  const m = src.mimo || {};
  return {
    provider: PROVIDERS.includes(src.provider) ? src.provider : 'off',
    edge: {
      voice: str(e.voice) || 'zh-CN-XiaoxiaoNeural',
      rate: prosody(e.rate),
      pitch: prosody(e.pitch),
      volume: prosody(e.volume),
    },
    doubao: {
      // source='custom' 时 speaker_id/resource_id 是用户手填的；source='preset' 时是选中预置音色时自动带入的
      // （两种情况下最终都是这两个字段在用，合成逻辑不用关心 source），preset_name 只用来在设置窗口回显选中项
      source: DOUBAO_VOICE_SOURCES.includes(d.source) ? d.source : 'custom',
      speaker_id: str(d.speaker_id),
      resource_id: str(d.resource_id) || DEFAULT_DOUBAO_RESOURCE_ID,
      preset_name: str(d.preset_name),
    },
    mimo: {
      mode: MIMO_MODES.includes(m.mode) ? m.mode : 'preset',
      preset_voice: str(m.preset_voice) || 'mimo_default',
      clone_audio: cloneMeta(m.clone_audio),
    },
  };
}

function readAll() {
  const c = loadConfig().ttsConfig;
  return c && typeof c === 'object' ? c : {};
}

function getTtsConfig(characterName) {
  const all = readAll();
  const chars = all.characters && typeof all.characters === 'object' ? all.characters : {};
  return {
    providers: normalizeProviders(all.providers),
    voice: normalizeVoice(chars[characterName]),
  };
}

// payload = { providers?, voice }；providers 缺省时保持现有密钥不变
function saveTtsConfig(characterName, payload) {
  const all = readAll();
  const chars = all.characters && typeof all.characters === 'object' ? all.characters : {};
  const providers = normalizeProviders(payload && payload.providers ? payload.providers : all.providers);
  const voice = normalizeVoice(payload && payload.voice);
  updateConfig({ ttsConfig: { providers, characters: { ...chars, [characterName]: voice } } });
  return { providers, voice };
}

// ---------- 多角色语音：除当前角色外、已配置语音的其他角色名单 ----------
// 这些角色可能在同一个故事里开口（提示词据此生成 <voice_characters> 名单，要求模型给他们的
// 「对话」写 `角色名：` 前缀），朗读时按名字把台词路由到各自的音色（见 tts/index.js）。
// 语气开关（tone.js 的 toneEnabled）也用它判断"是否可能有别的角色需要语气指令"。
function voiceCharacterNames(selfName) {
  return state.characters
    .map((c) => (c && typeof c.name === 'string' ? c.name : null))
    .filter((n) => n && n !== selfName && getTtsConfig(n).voice.provider !== 'off');
}

// 路人 / 群演：不在 <special_roles> 名单里的人物（店员、路人、旁白里的无名角色，即使有资料设定也算）。
// 提示词要求模型给他们的「对话」写 `路人：` 前缀，朗读时整句跳过。内部用这个特殊名字当 speaker，tts/index.js 据此直接判为不朗读
const NPC_LABEL = '路人';
const NPC_SPEAKER = '\u0000npc';
// 用户扮演的角色：提示词要求模型给用户角色的「对话」写 `用户：` 前缀，朗读时同样整句跳过（用户的台词不朗读）
const USER_LABEL = '用户';
const USER_SPEAKER = '\u0000user';

// 有专属设定的角色名单（给提示词的 <special_roles> 用）：全部角色（含当前主角色），带别名。
// 名单只用来让模型标注说话者时对照角色名，不代表这些角色一定出现在当前故事里。
// 没配置语音的角色也要进名单——要让模型给他们的台词也标上名字，朗读时才能按名字跳过，
// 否则他们的台词没有前缀，会被当成当前角色的台词用当前角色的声音读出来
function getSpecialRoles() {
  return state.characters
    .map((c) => (c && typeof c.name === 'string' ? c.name : null))
    .filter(Boolean)
    .map((name) => {
      let aliases = [];
      try { aliases = readPersonaFile(name).aliases || []; } catch { /* 读不到别名就只用角色名 */ }
      return { name, aliases };
    });
}

// 全部角色里（含当前角色）有没有谁配置了语音：一个都没有就没必要让模型标注说话者
function anyVoiceConfigured() {
  return state.characters.some((c) => c && typeof c.name === 'string' && getTtsConfig(c.name).voice.provider !== 'off');
}

// 说话者识别表：Map<称呼, 角色名>，称呼 = 角色名 + 该角色的全部别名（大小写不敏感，key 统一小写）。
// 朗读时 text-clean.js 的 parseSpeakerPrefix 用它把「」前面的 `某某：` 认成具体角色；
// 同一个称呼被多个角色占用时先到先得（角色名优先于别名，所以真名不会被别名抢走）
function speakerNameMap() {
  const map = new Map();
  const names = state.characters.map((c) => (c && typeof c.name === 'string' ? c.name : null)).filter(Boolean);
  for (const n of names) map.set(n.toLowerCase(), n);
  for (const n of names) {
    let aliases = [];
    try { aliases = readPersonaFile(n).aliases || []; } catch { /* ignore */ }
    for (const a of aliases) if (!map.has(a.toLowerCase())) map.set(a.toLowerCase(), n);
  }
  if (!map.has(NPC_LABEL)) map.set(NPC_LABEL, NPC_SPEAKER); // 有角色真叫"路人"时以角色为准
  if (!map.has(USER_LABEL)) map.set(USER_LABEL, USER_SPEAKER); // 有角色真叫"用户"时以角色为准
  return map;
}

// ---------- 给渲染进程看的版本：语音服务密钥遮罩 ----------
// 设置窗口拿到的 access_key / api_key 是遮罩（••••abcd），真实密钥不离开主进程；
// 保存 / 试听时表单里原样传回遮罩，就还原成当前已存的真实密钥
function maskProviders(providers) {
  const p = normalizeProviders(providers);
  return {
    doubao: { app_id: p.doubao.app_id, access_key: maskSecret(p.doubao.access_key) },
    mimo: { api_key: maskSecret(p.mimo.api_key), base_url: p.mimo.base_url },
  };
}

function resolveProvidersInput(input) {
  const cur = normalizeProviders(readAll().providers);
  const src = input && typeof input === 'object' ? input : {};
  const d = src.doubao && typeof src.doubao === 'object' ? src.doubao : {};
  const m = src.mimo && typeof src.mimo === 'object' ? src.mimo : {};
  return {
    doubao: { app_id: d.app_id, access_key: resolveSecretInput(d.access_key, [cur.doubao.access_key]) },
    mimo: { api_key: resolveSecretInput(m.api_key, [cur.mimo.api_key]), base_url: m.base_url },
  };
}

module.exports = { normalizeProviders, normalizeVoice, getTtsConfig, saveTtsConfig, maskProviders, resolveProvidersInput, voiceCharacterNames, getSpecialRoles, anyVoiceConfigured, speakerNameMap, NPC_LABEL, NPC_SPEAKER, USER_LABEL, USER_SPEAKER };
