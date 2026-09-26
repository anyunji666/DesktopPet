// ---------- 语音合成入口：按角色配置分发到 Edge / 豆包 / MiMo，朗读 AI 回复 ----------
// 特意放在主进程（而不是渲染进程直连）：
//   · Edge-TTS 的 WebSocket 需要自定义 Origin/UA 头，浏览器 API 做不到
//   · 豆包 / MiMo 从 127.0.0.1 页面直接 fetch 可能被 CORS 拦
//   · 和 callLLM 一样，Key 不出现在渲染进程
// 合成结果通过 'play-tts' 推给宠物窗口，由渲染进程用 voiceAudio 播放（静音、压低舞蹈音乐等沿用台词语音的逻辑）。
const { state } = require('../state');
const { getTtsConfig, saveTtsConfig, normalizeProviders, normalizeVoice } = require('./config');
const { prepareSpeechText } = require('./text-clean');
const { readCloneAudioDataURL } = require('./clone-store');
const { EDGE_VOICES, MIMO_PRESET_VOICES, DOUBAO_RESOURCE_IDS } = require('./presets');
const doubaoVoicesStore = require('./doubao-voices-store');
const edge = require('./edge');
const doubao = require('./doubao');
const mimo = require('./mimo');

// MiMo 两种音色来源 -> { model, voice }
// "音色复刻"：每次合成都带上参考音频（data:audio/...），走 voiceclone 模型
function resolveMimoPayload(m) {
  switch (m.mode) {
    case 'preset':
      return { model: 'mimo-v2.5-tts', voice: m.preset_voice };
    case 'clone':
      return { model: 'mimo-v2.5-tts-voiceclone', voice: readCloneAudioDataURL(m.clone_audio && m.clone_audio.file) };
    default:
      throw new Error('MiMo：未知的音色模式');
  }
}

// cfg = { providers, voice }（已 normalize）；tone 是可选的语气指令（只有豆包 / MiMo 会用）；返回 { buffer, mime }
async function synthesizeWith(cfg, text, signal, tone = '') {
  const { providers, voice } = cfg;
  switch (voice.provider) {
    case 'edge': {
      const e = voice.edge;
      return edge.synthesize({ text, voice: e.voice, rate: e.rate, pitch: e.pitch, volume: e.volume, signal });
    }
    case 'doubao': {
      const key = providers.doubao;
      const d = voice.doubao;
      if (!key.app_id || !key.access_key) throw new Error('豆包：请先填写 App ID 和 Access Key');
      if (!d.speaker_id) throw new Error('豆包：请填写 speaker_id');
      return doubao.synthesize({
        appId: key.app_id,
        accessKey: key.access_key,
        speaker: d.speaker_id,
        resourceId: d.resource_id,
        text,
        tone,
        signal,
      });
    }
    case 'mimo': {
      const key = providers.mimo;
      if (!key.api_key) throw new Error('MiMo：请先填写 API Key');
      const p = resolveMimoPayload(voice.mimo);
      return mimo.synthesize({
        text,
        apiKey: key.api_key,
        baseUrl: key.base_url,
        model: p.model,
        voice: p.voice,
        tone,
        signal,
      });
    }
    default:
      throw new Error('未选择语音服务商');
  }
}

// ---------- 朗读 AI 回复 ----------
let currentCtrl = null; // 在途的合成请求；新回复到来 / 切角色时取消

function currentCharacterName() {
  const c = state.characters[state.currentIndex];
  return c ? c.name : null;
}

function cancelSpeaking() {
  if (currentCtrl) {
    currentCtrl.abort();
    currentCtrl = null;
  }
}

// 不返回 Promise 给调用方等待：文字气泡照常立即显示，语音合成好了再推给渲染进程。
// 任何失败都只打日志，不能影响文字对话（具体错误可在音色设置窗口的"试听"里看到）
// tone：LLM 在回复末尾写的语气指导（已由 tone.js 拆出，reply 里不含它），可为空
async function speakReply(characterName, reply, tone = '') {
  let ctrl = null;
  try {
    // 只有当前展示的角色才开口（聊天记录窗口里和非当前角色聊天时，宠物不该用别人的声音说话）
    if (currentCharacterName() !== characterName) return;
    const cfg = getTtsConfig(characterName);
    if (cfg.voice.provider === 'off') return;
    const text = prepareSpeechText(reply);
    if (!text) return;

    cancelSpeaking();
    ctrl = new AbortController();
    currentCtrl = ctrl;
    const { buffer, mime } = await synthesizeWith(cfg, text, ctrl.signal, tone);
    if (ctrl.signal.aborted) return;
    currentCtrl = null;
    // 合成期间可能已经切了角色
    if (currentCharacterName() !== characterName) return;
    if (state.win && !state.win.isDestroyed()) {
      state.win.webContents.send('play-tts', { bytes: buffer, mime, text: reply });
    }
  } catch (err) {
    if (ctrl && ctrl.signal.aborted) return;
    console.warn('[pet] 语音合成失败:', err && err.message ? err.message : err);
  } finally {
    if (ctrl && currentCtrl === ctrl) currentCtrl = null;
  }
}

// ---------- 设置窗口用 ----------
function getPresets() {
  return {
    edge: EDGE_VOICES,
    mimo: MIMO_PRESET_VOICES,
    doubaoResourceIds: DOUBAO_RESOURCE_IDS,
    doubaoVoices: doubaoVoicesStore.loadVoices(),
  };
}

// 试听：用设置窗口表单里当前填的值（不要求先保存）合成一句话，返回音频给设置窗口自己播放
async function testVoice(payload, text) {
  const cfg = {
    providers: normalizeProviders(payload && payload.providers),
    voice: normalizeVoice(payload && payload.voice),
  };
  if (cfg.voice.provider === 'off') throw new Error('当前选择的是"不朗读"，请先选一个语音服务商');
  const sample = prepareSpeechText(text) || '你好呀，这是语音试听。';
  const { buffer, mime } = await synthesizeWith(cfg, sample);
  return { bytes: buffer, mime };
}

module.exports = { getTtsConfig, saveTtsConfig, getPresets, speakReply, cancelSpeaking, testVoice };
