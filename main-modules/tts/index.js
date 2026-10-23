// ---------- 语音合成入口：按角色配置分发到 Edge / 豆包 / MiMo，朗读 AI 回复 ----------
// 特意放在主进程（而不是渲染进程直连）：
//   · Edge-TTS 的 WebSocket 需要自定义 Origin/UA 头，浏览器 API 做不到
//   · 豆包 / MiMo 从 127.0.0.1 页面直接 fetch 可能被 CORS 拦
//   · 和 callLLM 一样，Key 不出现在渲染进程
// 朗读按「」分段：每个「」单独请求一次，整条回复的音频都合成好（缓存一回合）后，用一次 'play-tts' 把
// clips（带各段在阅读时间线上的位置）推给宠物窗口，由渲染进程按停顿排队、用 voiceAudio 一段段播放
// （静音、压低舞蹈音乐等沿用台词语音的逻辑）。同时按这条 AI 消息的 ts 把整回合语音缓存到磁盘（chat-store 的 saveChatVoice），
// 聊天记录窗口双击气泡可以重听；消息被删时语音跟着删，编辑不影响（ts 不变）。
const { state } = require('../state');
const { getTtsConfig, saveTtsConfig, normalizeProviders, normalizeVoice, speakerNameMap, NPC_SPEAKER, USER_SPEAKER } = require('./config');
const { prepareSpeechText, splitSpeechSegments } = require('./text-clean');
const { loadChatHistory, saveChatVoice } = require('../chat-store');
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

// cfg = { providers, voice }（已 normalize）；tone 是这一段的语气指令（可选，只有豆包 / MiMo 会用）；返回 { buffer, mime }
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
const SEGMENT_CONCURRENCY = 2; // 同时在途的分段请求数（MiMo 复刻每次都带参考音频、豆包可能有 QPS 限制，别开太大）
const SEGMENT_RETRY = 1; // 单段失败后额外重试次数

let currentCtrl = null; // 在途的合成请求；新回复到来 / 切角色时整批取消

function currentCharacterName() {
  const c = state.characters[state.currentIndex];
  return c ? c.name : null;
}

// 告诉宠物窗口"AI 回复语音是否正在合成"：合成期间渲染进程既没在播也没排队，喝水提醒据此避让，
// 否则提醒刚开口、回复语音就到了，会被硬切。以 currentCtrl 是否存在为准，新旧请求交替时不会误报 false
function notifySynthState() {
  try {
    if (state.win && !state.win.isDestroyed()) state.win.webContents.send('tts-synth-state', !!currentCtrl);
  } catch {}
}

function cancelSpeaking() {
  if (currentCtrl) {
    currentCtrl.abort();
    currentCtrl = null;
    notifySynthState();
  }
}

// 合成一段：失败重试 SEGMENT_RETRY 次；被取消（切角色 / 新回复）时立刻抛出，不再重试
async function synthesizeSegment(cfg, text, signal, tone) {
  let lastErr;
  for (let attempt = 0; attempt <= SEGMENT_RETRY; attempt++) {
    try {
      return await synthesizeWith(cfg, text, signal, tone);
    } catch (err) {
      if (signal.aborted) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

// 合成期间用户可能已经删了这条消息 / 点了重新生成：消息不在了就不存，免得留下没人引用的语音文件
function persistVoice(characterName, msgTs, clips) {
  if (!Number.isFinite(msgTs)) return; // 这轮没存 AI 消息（回复为空），没有可挂的地方
  try {
    const exists = loadChatHistory(characterName).some((m) => m && m.role === 'assistant' && m.ts === msgTs);
    if (exists) saveChatVoice(characterName, msgTs, clips);
  } catch (err) {
    console.warn('[pet] 保存回复语音失败:', err && err.message ? err.message : err);
  }
}

// 不返回 Promise 给调用方等待：文字气泡照常立即显示，语音合成好了再推给渲染进程。
// 任何失败都只打日志，不能影响文字对话（具体错误可在角色与音色设置窗口音色设置区的"试听"里看到）
// reply：带逐句语气的正文原文（每个「」开头的【语气】由 splitSpeechSegments 拆成各段自己的 tone，每段请求带自己那一条；
//   气泡 / 聊天记录用的是摘掉语气后的正文，见 chat-turn.js）
// msgTs：这条 AI 消息在聊天记录里的 ts，合成好的语音按它缓存；缺省（null）只播放、不缓存
// 多角色语音：回复里其他角色的台词由模型用 `角色名：「对话」` 标注（提示词见 llm.js 的 SPEAKER_RULE），
//   splitSpeechSegments 按全部角色名把每段的 speaker 拆出来，这里再按 speaker 取各角色自己的
//   TTS 配置分段合成——同一回合的语音可以来自不同服务商/音色，播放/缓存流程不变。
//   没标注的段落默认当前角色；说话者没配置语音（off）的段落整段不读（用别人的音色读更违和，
//   想读就在角色与音色设置里给那个角色配一个）。称呼可以是角色名或别名（persona.json 的 aliases）。
//   当前角色自己没配语音、但回复里有别的角色配了语音的台词，那些台词照常朗读
async function speakReply(characterName, reply, msgTs = null) {
  let ctrl = null;
  try {
    // 只有当前展示的角色才开口（聊天记录窗口里和非当前角色聊天时，宠物不该用别人的声音说话）
    if (currentCharacterName() !== characterName) return;
    // 说话者识别表 = 全部角色的名字 + 别名（不限已配置语音的，路由时再各自判断）
    const segments = splitSpeechSegments(reply, speakerNameMap());
    if (!segments.length) return;

    // 每段按说话者解析各自的 TTS 配置（带缓存，同一说话者只取一次）
    const cfgCache = new Map();
    const SILENT_CFG = { voice: { provider: 'off' } };
    const cfgFor = (speaker) => {
      if (speaker === NPC_SPEAKER || speaker === USER_SPEAKER) return SILENT_CFG; // 路人 / 用户：不朗读
      const name = speaker || characterName;
      if (!cfgCache.has(name)) cfgCache.set(name, getTtsConfig(name));
      return cfgCache.get(name);
    };
    // 没有任何一段能发给 TTS（当前角色和各说话者都没配置语音）就不动现有的播放
    if (!segments.some((seg) => cfgFor(seg.speaker).voice.provider !== 'off')) return;

    // 路由日志：看每句台词交给了谁 / 哪家服务商；认不出的"某某："也提示一下，方便排查别名没配的情况
    console.log('[pet] 语音路由:', segments.map((seg, i) => {
      const who = seg.speaker === NPC_SPEAKER ? '路人' : seg.speaker === USER_SPEAKER ? '用户' : seg.speaker || characterName;
      return `#${i + 1} ${who}→${cfgFor(seg.speaker).voice.provider}`;
    }).join('  '));
    for (const seg of segments) {
      if (seg.unknownLabel) console.warn(`[pet] 「」前的"${seg.unknownLabel}："不是已知角色名/别名，按当前角色 ${characterName} 朗读（如果这是某个角色，请在角色资料里给它加别名）`);
    }

    cancelSpeaking();
    ctrl = new AbortController();
    currentCtrl = ctrl;
    notifySynthState();

    // 每个「」一次请求，SEGMENT_CONCURRENCY 路并发；结果按原文顺序放进 results 缓存
    const results = new Array(segments.length).fill(null);
    let next = 0;
    const worker = async () => {
      while (!ctrl.signal.aborted) {
        const i = next++;
        if (i >= segments.length) return;
        const segCfg = cfgFor(segments[i].speaker);
        if (segCfg.voice.provider === 'off') continue; // 说话者没配置语音：跳过（results[i] 保持 null，走既有的"失败跳过"路径）
        try {
          results[i] = await synthesizeSegment(segCfg, segments[i].text, ctrl.signal, segments[i].tone);
        } catch (err) {
          if (ctrl.signal.aborted) return;
          console.warn(`[pet] 语音合成失败（第 ${i + 1}/${segments.length} 段）:`, err && err.message ? err.message : err);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(SEGMENT_CONCURRENCY, segments.length) }, worker));
    if (ctrl.signal.aborted) return;
    currentCtrl = null; // 状态在 finally 里统一通知（此时 play-tts 已先于通知推出，渲染端不会出现空档）
    // 合成期间可能已经切了角色
    if (currentCharacterName() !== characterName) return;

    // 整回合缓存好了才一起推。失败的段落跳过（readOffsetMs 是绝对位置，不受影响；兜底用的 gapBeforeMs 会并进下一段）
    const clips = [];
    let carryGap = 0;
    segments.forEach((seg, i) => {
      const r = results[i];
      if (!r) {
        carryGap += seg.gapBeforeMs;
        return;
      }
      clips.push({
        bytes: r.buffer,
        mime: r.mime,
        gapBeforeMs: clips.length ? carryGap + seg.gapBeforeMs : 0, // 旧版相对停顿：仅老播放逻辑 / 兜底
        readOffsetMs: seg.readOffsetMs, // 阅读时间线位置：播放端按它调度，失败跳过的段不影响后面段的位置
      });
      carryGap = 0;
    });
    if (!clips.length) return;
    if (state.win && !state.win.isDestroyed()) {
      state.win.webContents.send('play-tts', { clips });
    }
    persistVoice(characterName, msgTs, clips); // 先推送播放，再落盘缓存，播放不等磁盘
  } catch (err) {
    if (ctrl && ctrl.signal.aborted) return;
    console.warn('[pet] 语音合成失败:', err && err.message ? err.message : err);
  } finally {
    if (ctrl && currentCtrl === ctrl) currentCtrl = null;
    if (ctrl) notifySynthState();
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
