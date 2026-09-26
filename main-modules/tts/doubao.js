// ---------- 豆包（火山引擎）语音合成 ----------
// 移植自 st-tavern-audio 的 doubao-tts.js：改 CJS、用 Buffer 代替 atob，
// 增加 AbortSignal（切角色/新消息时取消在途请求），流末尾没带换行的最后一行也会解析。
// 接口：openspeech.bytedance.com/api/v3/tts/unidirectional（流式，逐行 JSON，音频为 base64 分片）
// 鉴权：X-Api-App-Key（App ID）/ X-Api-Access-Key / X-Api-Resource-Id
const API_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const DEFAULT_TIMEOUT_MS = 20000;
const TIMEOUT_RETRY_COUNT = 1;
const CODE_DONE = 20000000;

// 处理流里的一行 JSON：返回 { audio?: Buffer, done?: true }；出错抛异常
function handleLine(line) {
  let data;
  try {
    data = JSON.parse(line);
  } catch {
    return {}; // 非 JSON 行忽略
  }
  if (data.code === 0 && data.data) return { audio: Buffer.from(data.data, 'base64') };
  if (data.code === CODE_DONE) return { done: true };
  if (data.code > 0) throw new Error(`豆包TTS错误: ${JSON.stringify(data)}`);
  return {};
}

/**
 * @param {object} req
 *   appId / accessKey / speaker（speaker_id）/ resourceId（如 seed-tts-2.0）/ text
 *   tone   语气指令（可选），进 additions.context_texts（官方"语音指令"，只对 2.0 系统音色确定有效）
 *   signal(AbortSignal)
 * @returns {Promise<{buffer: Buffer, mime: string}>}
 */
async function synthesize(req) {
  const { appId, accessKey, speaker, resourceId, text, tone, signal, timeoutMs = DEFAULT_TIMEOUT_MS, apiUrl = API_URL } = req || {};
  if (!(appId && accessKey && speaker && resourceId && text)) {
    throw new Error('豆包TTS请求参数不完整（需要 appId/accessKey/speaker/resourceId/text）');
  }

  const additions = {};
  if (tone) additions.context_texts = [tone];

  const body = JSON.stringify({
    user: { uid: 'desktop-pet' },
    req_params: {
      text,
      speaker,
      audio_params: { format: 'mp3', sample_rate: 24000 },
      additions: JSON.stringify(additions),
    },
  });
  const headers = {
    'X-Api-App-Key': appId,
    'X-Api-Access-Key': accessKey,
    'X-Api-Resource-Id': resourceId,
    'Content-Type': 'application/json',
  };

  for (let attempt = 0; attempt <= TIMEOUT_RETRY_COUNT; attempt++) {
    if (signal && signal.aborted) throw new Error('已取消');
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
    const onAbort = () => ctrl.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      const resp = await fetch(apiUrl, { method: 'POST', headers, body, signal: ctrl.signal });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status}${errText ? ': ' + errText.slice(0, 300) : ''}`);
      }
      if (!resp.body) throw new Error('响应无 body，无法流式读取');

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      const chunks = [];
      let buffer = '';
      let finished = false;
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const r = handleLine(line);
          if (r.audio) chunks.push(r.audio);
          if (r.done) { finished = true; break; }
        }
      }
      if (!finished && buffer.trim()) {
        const r = handleLine(buffer.trim());
        if (r.audio) chunks.push(r.audio);
      }
      if (!chunks.length) throw new Error('豆包TTS未返回任何音频数据');
      return { buffer: Buffer.concat(chunks), mime: 'audio/mpeg' };
    } catch (err) {
      if (signal && signal.aborted) throw new Error('已取消');
      if (timedOut) {
        if (attempt < TIMEOUT_RETRY_COUNT) continue; // 超时重试一次
        throw new Error(`豆包TTS请求超时 (${timeoutMs / 1000}s)`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
}

module.exports = { synthesize };
