// ---------- 语音合成配置：读取 / 规整 / 持久化 ----------
// 存进 config.json 的 ttsConfig 字段（和 apiConfig / promptConfig 共用同一份配置文件）：
//   providers  —— 各服务商的密钥等"全角色共用"的设置
//   characters —— 以角色名为 key，每个角色自己的"服务商 + 各家音色参数"
// 每个角色把三家的参数都留着（provider 只决定当前用哪家），切换服务商对比试音时不用重填。
const { loadConfig, updateConfig } = require('../config');

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

module.exports = { normalizeProviders, normalizeVoice, getTtsConfig, saveTtsConfig };
