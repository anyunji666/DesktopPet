// ---------- MiMo-V2.5-TTS（小米）语音合成 ----------
// 移植自 st-tavern-audio 的 nimo-tts.js。桌宠一次只合成一条回复，所以去掉了多 Key 轮询、
// 客户端滑动窗口限速这些为批量场景准备的机制，只保留：单 Key、超时/5xx/内容过滤重试、429 按 Retry-After 等一下重试。
// 请求是 OpenAI 风格 chat/completions + audio 字段，鉴权同时带 api-key 和 Authorization: Bearer。
// 两种模型：mimo-v2.5-tts（预置音色）、-voiceclone（参考音频复刻）
// 语气用官方"自然语言控制"：一句描述放进 user 消息（不会被念出来），要合成的文本放 assistant 消息。
// 返回格式固定 mp3：语音不落地存储，mp3 体积小传输快，人声场景音质损失基本听不出来。
const RESPONSE_FORMAT = 'mp3';
const DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1';
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_ATTEMPTS = 3; // 首次 + 2 次重试
const MAX_RETRY_AFTER_MS = 8000; // 桌宠里等太久没意义，429 最多等 8 秒

class MimoError extends Error {
  constructor(message, status = null, retryAfterMs = 0) {
    super(message);
    this.name = 'MimoError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error('已取消'));
    const onAbort = () => { clearTimeout(t); reject(new Error('已取消')); };
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function parseRetryAfterMs(value) {
  const seconds = Number(String(value || '').trim());
  const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 3000;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(1000, ms));
}

// 内容过滤：MiMo 有时以 finish_reason=content_filter 或 "considered high risk" 的文本回应
function extractContentFilterMessage(data) {
  const choice = data && data.choices && data.choices[0];
  const finishReason = String((choice && choice.finish_reason) || '').trim();
  const content = String((choice && choice.message && choice.message.content) || '').trim();
  if (finishReason === 'content_filter') return content || 'content_filter';
  if (/considered high risk|content[_ -]?filter/i.test(content)) return content;
  return '';
}

function shouldRetry(err) {
  if (!(err instanceof MimoError)) return false;
  if (/内容过滤/.test(err.message)) return true; // 风控拦截偶发且不稳定，值得再试
  if (err.status === 408) return true;
  if (typeof err.status === 'number') return err.status >= 500;
  return /请求超时|网络错误|非 JSON 响应|未找到音频数据/.test(err.message);
}

async function requestOnce({ url, key, body, timeoutMs, signal }) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
  const onAbort = () => ctrl.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': key, Authorization: `Bearer ${key}` },
        body,
        signal: ctrl.signal,
      });
    } catch (e) {
      if (signal && signal.aborted) throw new Error('已取消');
      if (timedOut) throw new MimoError(`请求超时 (${timeoutMs / 1000}s)`, 408);
      throw new MimoError(`网络错误: ${e && e.message ? e.message : e}`);
    }

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      const retryAfterMs = resp.status === 429 ? parseRetryAfterMs(resp.headers.get('retry-after')) : 0;
      throw new MimoError(`HTTP ${resp.status}: ${errText.slice(0, 300)}`, resp.status, retryAfterMs);
    }

    let data;
    try {
      data = await resp.json();
    } catch (e) {
      throw new MimoError(`非 JSON 响应: ${e && e.message ? e.message : e}`);
    }
    const filtered = extractContentFilterMessage(data);
    if (filtered) throw new MimoError(`请求被内容过滤拦截: ${filtered.slice(0, 300)}`, 400);

    const audio = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.audio;
    if (!audio || !audio.data) throw new MimoError('返回中未找到音频数据: ' + JSON.stringify(data).slice(0, 300));
    return { buffer: Buffer.from(audio.data, 'base64'), mime: 'audio/mpeg' };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * @param {object} req
 *   text        要合成的文本
 *   apiKey / baseUrl
 *   model       mimo-v2.5-tts | mimo-v2.5-tts-voiceclone
 *   voice       预置音色名 / 复刻用 data:audio/...;base64,...
 *   tone        语气指令（可选），放进 user 消息
 * @returns {Promise<{buffer: Buffer, mime: string}>}
 */
async function synthesize(req) {
  const {
    text, apiKey, baseUrl, model = 'mimo-v2.5-tts', voice, tone = '',
    signal, timeoutMs = DEFAULT_TIMEOUT_MS,
  } = req || {};

  if (!text || !String(text).trim()) throw new MimoError('MiMo: 文本为空');
  if (!apiKey) throw new MimoError('MiMo: 未配置 API Key');
  if (model === 'mimo-v2.5-tts' && !voice) throw new MimoError('MiMo: 预置音色需要指定 voice');
  if (model === 'mimo-v2.5-tts-voiceclone' && !(voice && String(voice).startsWith('data:'))) {
    throw new MimoError('MiMo: 音色复刻需要参考音频（data:audio/...;base64,...）');
  }

  const url = `${String(baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '')}/chat/completions`;
  const audio = { format: RESPONSE_FORMAT };
  if (voice) audio.voice = voice;
  const messages = [];
  const instruction = String(tone || '').trim();
  if (instruction) messages.push({ role: 'user', content: instruction });
  messages.push({ role: 'assistant', content: String(text) }); // 要合成的文本放在 assistant 消息里
  const body = JSON.stringify({ model, messages, audio });

  let lastErr;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await requestOnce({ url, key: apiKey, body, timeoutMs, signal });
    } catch (err) {
      lastErr = err;
      if (signal && signal.aborted) throw new Error('已取消');
      if (attempt === MAX_ATTEMPTS - 1) break;
      if (err instanceof MimoError && err.status === 429) await sleep(err.retryAfterMs, signal);
      else if (shouldRetry(err)) await sleep(500, signal);
      else break;
    }
  }
  throw lastErr;
}

module.exports = { synthesize, MimoError, DEFAULT_BASE_URL };
