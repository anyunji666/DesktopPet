// ---------- Edge-TTS（微软 Edge 在线朗读，免费，无需 API Key） ----------
// 移植自 st-tavern-audio 的 edge-tts.js，改成 Node 主进程版：
//   · 浏览器 WebSocket 没法自定义请求头（Origin 会变成 http://127.0.0.1:端口），
//     这里用 ws 包，带上和 edge-tts 参考实现一致的 Origin / User-Agent / muid
//   · 握手被 403 拒绝时按响应头 Date 校正本机时钟偏差后重试一次
//     （Sec-MS-GEC 是按时间戳算的反爬校验，本机时钟差几分钟就会 403）
// 协议是社区逆向所得，非官方接口，微软改协议后可能失效。参考：https://github.com/rany2/edge-tts
const crypto = require('crypto');

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WSS_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
// 微软会随 Edge 发版轮换这个版本号；版本过旧时握手会被 403 拒绝。403 且时钟没问题时，先检查这个常量
// （社区参考实现里目前可用的值见 rany2/edge-tts）
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const CHROMIUM_MAJOR = CHROMIUM_FULL_VERSION.split('.')[0];
const ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
const USER_AGENT =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR}.0.0.0`;
const DEFAULT_TIMEOUT_MS = 20000;

// 本机时钟与微软服务器的偏差（秒）。握手 403 时按服务器返回的 Date 更新
let clockSkewSec = 0;

function loadWs() {
  try {
    return require('ws');
  } catch {
    throw new Error('缺少依赖 ws（Edge-TTS 需要），请在项目目录运行 npm install 后重启宠物');
  }
}

function genConnectionId() {
  return crypto.randomUUID().replace(/-/g, '');
}

function genMuid() {
  return crypto.randomBytes(16).toString('hex').toUpperCase();
}

// Windows 纪元(1601-01-01)起的 100ns ticks，向下取整到 5 分钟，与 TrustedClientToken 拼接后 SHA-256，取大写十六进制
function generateSecMsGec() {
  const WIN_EPOCH_OFFSET_SEC = 11644473600;
  let ticks = Math.floor(Date.now() / 1000 + clockSkewSec) + WIN_EPOCH_OFFSET_SEC;
  ticks -= ticks % 300;
  const ticks100ns = BigInt(ticks) * 10000000n;
  return crypto.createHash('sha256').update(`${ticks100ns}${TRUSTED_CLIENT_TOKEN}`).digest('hex').toUpperCase();
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 语速/音量按 %，音调按 Hz；只填数字时自动补正负号和单位，已带单位的原样透传
function normalizeProsodyValue(v, unit) {
  if (v === undefined || v === null || String(v).trim() === '') return `+0${unit}`;
  let s = String(v).trim();
  if (!/^[+-]/.test(s)) s = `+${s}`;
  if (!/%$|Hz$/i.test(s)) s += unit;
  return s;
}

function guessLangFromVoice(voice) {
  const m = /^([a-z]{2,3}-[A-Z]{2})/.exec(String(voice || ''));
  return m ? m[1] : 'zh-CN';
}

function buildSsml({ text, voice, rate, pitch, volume }) {
  const r = normalizeProsodyValue(rate, '%');
  const p = normalizeProsodyValue(pitch, 'Hz');
  const v = normalizeProsodyValue(volume, '%');
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${guessLangFromVoice(voice)}'>` +
    `<voice name='${voice}'>` +
    `<prosody pitch='${p}' rate='${r}' volume='${v}'>${escapeXml(text)}</prosody>` +
    `</voice></speak>`
  );
}

function dateHeader() {
  // 值本身不影响解析，只要存在即可
  return new Date().toString() + ' (Coordinated Universal Time)';
}

function synthesizeOnce({ text, voice, rate, pitch, volume, timeoutMs, signal, endpoint }) {
  const WebSocket = loadWs();
  return new Promise((resolve, reject) => {
    const connectionId = genConnectionId();
    const url =
      `${endpoint}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&ConnectionId=${connectionId}` +
      `&Sec-MS-GEC=${generateSecMsGec()}&Sec-MS-GEC-Version=1-${CHROMIUM_FULL_VERSION}`;

    let settled = false;
    const chunks = [];
    let total = 0;
    let timer = null;
    let ws = null;
    let onAbort = null;

    // 诊断信息：超时 / 没有音频时，用来说明卡在哪一步（未连上 / 连上没数据 / 有数据没结束）
    const t0 = Date.now();
    const diag = { openMs: null, messages: 0, paths: [] };
    let closeInfo = '';
    const describeStage = () => {
      if (diag.openMs === null) return '未能建立连接（WebSocket 握手没有完成）';
      const parts = [`连接已建立（握手耗时 ${diag.openMs}ms）`];
      if (!diag.messages) {
        parts.push('但没有收到服务端任何数据');
      } else {
        const paths = diag.paths.length ? diag.paths.join(' / ') : '无 Path';
        parts.push(`收到 ${diag.messages} 条消息（${paths}），音频 ${total} 字节${total ? '，但没收到结束标记' : ''}`);
      }
      if (closeInfo) parts.push(closeInfo);
      return parts.join('，');
    };

    const cleanup = () => {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { ws && ws.terminate(); } catch {}
      reject(err);
    };
    // 收到 turn.end / 服务端关闭连接：有音频数据就算成功（服务端提前关闭时用已收到的数据兜底）
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try { ws && ws.close(); } catch {}
      if (total > 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`Edge-TTS 未返回任何音频数据（可能是音色名不存在，或微软临时限制了访问）：${describeStage()}`));
    };

    if (signal) {
      if (signal.aborted) return reject(new Error('已取消'));
      onAbort = () => fail(new Error('已取消'));
      signal.addEventListener('abort', onAbort, { once: true });
    }
    timer = setTimeout(() => fail(new Error(`Edge-TTS 请求超时 (${timeoutMs / 1000}s)：${describeStage()}`)), timeoutMs);

    try {
      ws = new WebSocket(url, {
        headers: {
          Pragma: 'no-cache',
          'Cache-Control': 'no-cache',
          Origin: ORIGIN,
          'User-Agent': USER_AGENT,
          'Accept-Encoding': 'gzip, deflate, br',
          'Accept-Language': 'en-US,en;q=0.9',
          Cookie: `muid=${genMuid()};`,
        },
      });
    } catch (e) {
      return fail(new Error(`Edge-TTS 连接创建失败: ${e && e.message ? e.message : e}`));
    }

    ws.on('open', () => {
      diag.openMs = Date.now() - t0;
      const now = dateHeader();
      ws.send(
        `X-Timestamp:${now}\r\n` +
          `Content-Type:application/json; charset=utf-8\r\n` +
          `Path:speech.config\r\n\r\n` +
          JSON.stringify({
            context: {
              synthesis: {
                audio: {
                  metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false },
                  outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
                },
              },
            },
          })
      );
      ws.send(
        `X-RequestId:${connectionId}\r\n` +
          `Content-Type:application/ssml+xml\r\n` +
          `X-Timestamp:${now}\r\n` +
          `Path:ssml\r\n\r\n` +
          buildSsml({ text, voice, rate, pitch, volume })
      );
    });

    ws.on('message', (data, isBinary) => {
      diag.messages++;
      if (!isBinary) {
        const txt = data.toString();
        const p = /Path:([\w.]+)/.exec(txt);
        if (p && !diag.paths.includes(p[1])) diag.paths.push(p[1]);
        if (txt.includes('Path:turn.end')) finish();
        return;
      }
      // 二进制消息：前 2 字节（大端）是 header 文本长度，之后是 header 文本，再之后才是音频数据
      const buf = Buffer.isBuffer(data) ? data : Buffer.concat([].concat(data));
      if (buf.length < 2) return;
      const headerLen = buf.readUInt16BE(0);
      const headerText = buf.subarray(2, 2 + headerLen).toString('utf8');
      const hp = /Path:([\w.]+)/.exec(headerText);
      if (hp && !diag.paths.includes(hp[1])) diag.paths.push(hp[1]);
      if (!headerText.includes('Path:audio')) return;
      const audio = buf.subarray(2 + headerLen);
      if (audio.length) {
        chunks.push(audio);
        total += audio.length;
      }
    });

    ws.on('unexpected-response', (_req, res) => {
      const err = new Error(`Edge-TTS 握手被拒绝 (HTTP ${res.statusCode})`);
      err.status = res.statusCode;
      err.serverDate = res.headers && res.headers.date;
      res.resume();
      fail(err);
    });
    ws.on('error', (e) => fail(new Error(`Edge-TTS 连接出错: ${e && e.message ? e.message : e}`)));
    ws.on('close', (code, reason) => {
      const r = reason && reason.length ? `, ${reason.toString()}` : '';
      closeInfo = `服务端已关闭连接 (code ${code}${r})`;
      finish();
    });
  });
}

/**
 * @param {object} req
 *   text / voice（如 zh-CN-XiaoxiaoNeural）/ rate / pitch / volume / signal(AbortSignal)
 * @returns {Promise<{buffer: Buffer, mime: string}>}
 */
async function synthesize(req) {
  const { text, voice, rate, pitch, volume, signal, timeoutMs = DEFAULT_TIMEOUT_MS, endpoint = WSS_URL } = req || {};
  if (!text || !voice) throw new Error('Edge-TTS 缺少 text 或 voice 参数');
  // voice 会拼进 SSML 属性，只允许微软音色名里会出现的字符
  if (!/^[A-Za-z0-9_-]+$/.test(voice)) throw new Error(`Edge-TTS 音色名不合法: ${voice}`);
  const args = { text, voice, rate, pitch, volume, timeoutMs, signal, endpoint };
  try {
    return { buffer: await synthesizeOnce(args), mime: 'audio/mpeg' };
  } catch (err) {
    // 403 + 服务器 Date：本机时钟偏差导致 Sec-MS-GEC 失效，校正后重试一次
    const serverMs = err && err.status === 403 && err.serverDate ? Date.parse(err.serverDate) : NaN;
    if (!Number.isFinite(serverMs)) throw err;
    clockSkewSec = (serverMs - Date.now()) / 1000;
    return { buffer: await synthesizeOnce(args), mime: 'audio/mpeg' };
  }
}

module.exports = { synthesize };
