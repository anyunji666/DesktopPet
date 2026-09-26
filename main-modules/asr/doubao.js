// ---------- 豆包"流式语音识别大模型"（ASR）WebSocket 客户端 ----------
// 接口：wss://openspeech.bytedance.com/api/v3/sauc/bigmodel（双向流式，边发音频边收中间识别结果）
// 鉴权：HTTP 握手时带 X-Api-App-Key / X-Api-Access-Key / X-Api-Resource-Id / X-Api-Connect-Id
//       （浏览器 WebSocket 不能自定义请求头，所以和 tts/edge.js 一样，用 ws 包在主进程里连）
// 协议是社区常见的"二进制帧"格式（非官方 SDK 逆向整理，字段名/含义如与官方文档有出入，
// 以后跑起来发现解析不对，优先检查这个文件里的协议常量）：
//   4 字节 header：
//     byte0 高4位=协议版本(1)，低4位=header长度(1，即这4字节本身)
//     byte1 高4位=消息类型，低4位=消息类型相关 flags
//     byte2 高4位=序列化方式(0=无 1=JSON)，低4位=压缩方式(0=无 1=gzip)
//     byte3 保留位，固定 0x00
//   flags 非 0 时，header 后跟 4 字节大端有符号序列号（负数表示"这是最后一包"）
//   再跟 4 字节大端无符号 payload 长度 + payload 本体（按 header 里的压缩方式处理）
const WebSocket = require('ws');
const crypto = require('crypto');
const zlib = require('zlib');

const WS_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel';
const IDLE_TIMEOUT_MS = 15000; // 超过这么久收不到服务端任何消息就当异常收尾，避免会话一直挂着

const PROTOCOL_VERSION = 0b0001;
const HEADER_SIZE = 0b0001;

const MSG_FULL_CLIENT_REQUEST = 0b0001;
const MSG_AUDIO_ONLY_REQUEST = 0b0010;
const MSG_ERROR_RESPONSE = 0b1111;

const FLAG_NO_SEQUENCE = 0b0000;
const FLAG_POS_SEQUENCE = 0b0001;
// 注意：这不是"负序列号"专用的独立标志位，而是两个 bit 的组合：
//   bit0=是否编码了 sequence 字段，bit1=是否是最后一包。
// 最后一包音频仍然要写入 4 字节的（负）序列号，所以 bit0 必须为 1，
// 正确值是 0b0011（历史上这里错写成 0b0010，会导致服务端把序列号字节错当成 payload 长度解析，
// 报 "declared body size does not match actual body size" 之类的错误）。
const FLAG_NEG_WITH_SEQUENCE = 0b0011;

const SERIALIZATION_JSON = 0b0001;
const SERIALIZATION_RAW = 0b0000;
const COMPRESSION_NONE = 0b0000;
const COMPRESSION_GZIP = 0b0001;

function buildHeader(messageType, flags, serialization, compression) {
  return Buffer.from([
    (PROTOCOL_VERSION << 4) | HEADER_SIZE,
    (messageType << 4) | flags,
    (serialization << 4) | compression,
    0x00,
  ]);
}

function i32be(n) {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n, 0);
  return b;
}
function u32be(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

// full client request：JSON 配置（本次识别的音频格式 + 识别参数），固定序列号 1，gzip 压缩
function buildFullClientRequest(sequence, jsonObj) {
  const payload = zlib.gzipSync(Buffer.from(JSON.stringify(jsonObj), 'utf-8'));
  const header = buildHeader(MSG_FULL_CLIENT_REQUEST, FLAG_POS_SEQUENCE, SERIALIZATION_JSON, COMPRESSION_GZIP);
  return Buffer.concat([header, i32be(sequence), u32be(payload.length), payload]);
}

// audio only request：原始 PCM 音频分片，isLast=true 时用负序列号告诉服务端"音频发完了"
function buildAudioOnlyRequest(sequence, audioBuf, isLast) {
  const payload = zlib.gzipSync(audioBuf);
  const flags = isLast ? FLAG_NEG_WITH_SEQUENCE : FLAG_POS_SEQUENCE;
  const header = buildHeader(MSG_AUDIO_ONLY_REQUEST, flags, SERIALIZATION_RAW, COMPRESSION_GZIP);
  return Buffer.concat([header, i32be(isLast ? -sequence : sequence), u32be(payload.length), payload]);
}

function parseServerMessage(buf) {
  if (!buf || buf.length < 4) return null;
  const messageType = (buf[1] >> 4) & 0x0f;
  const flags = buf[1] & 0x0f;
  const serialization = (buf[2] >> 4) & 0x0f;
  const compression = buf[2] & 0x0f;
  let offset = 4;
  let sequence = null;
  if (flags !== FLAG_NO_SEQUENCE) {
    sequence = buf.readInt32BE(offset);
    offset += 4;
  }

  if (messageType === MSG_ERROR_RESPONSE) {
    const errorCode = buf.readUInt32BE(offset);
    offset += 4;
    const size = buf.readUInt32BE(offset);
    offset += 4;
    let payload = buf.subarray(offset, offset + size);
    if (compression === COMPRESSION_GZIP && payload.length) {
      try { payload = zlib.gunzipSync(payload); } catch { /* 忽略，走兜底文本 */ }
    }
    let message = payload.toString('utf-8');
    try { message = JSON.parse(message).message || message; } catch { /* 不是 JSON 就原样用 */ }
    return { type: 'error', errorCode, message };
  }

  const size = buf.readUInt32BE(offset);
  offset += 4;
  let payload = buf.subarray(offset, offset + size);
  if (compression === COMPRESSION_GZIP && payload.length) {
    try { payload = zlib.gunzipSync(payload); } catch { /* 忽略 */ }
  }
  let json = null;
  if (serialization === SERIALIZATION_JSON && payload.length) {
    try { json = JSON.parse(payload.toString('utf-8')); } catch { /* 忽略 */ }
  }
  return { type: 'response', json, isLast: sequence !== null && sequence < 0 };
}

// 从服务端返回的 JSON 里抠识别文本：不同账号/版本返回结构可能有出入，这里尽量兼容着取
function extractText(json) {
  if (!json) return '';
  if (typeof json.text === 'string') return json.text;
  const result = json.result;
  if (result) {
    if (typeof result.text === 'string') return result.text;
    if (Array.isArray(result.utterances)) return result.utterances.map((u) => u.text || '').join('');
  }
  return '';
}

// 开一路识别会话。回调：
//   onPartial(text) —— 每收到一次服务端消息就回调一次当前识别到的文本（含中间态，会反复覆盖）
//   onFinal(text)   —— 会话正常结束（服务端返回最终包，或连接被服务端关闭）时回调一次，之后不会再有任何回调
//   onError(err)    —— 出错时回调一次（连接失败/鉴权失败/服务端错误包/超时），之后不会再有 onFinal
// 返回 { sendAudio(pcmBuffer), finish() }：finish() 通知"音频发完了"，等最终结果或连接关闭
function createAsrSession({ appId, accessKey, resourceId, onPartial, onFinal, onError }) {
  let seq = 1;
  let lastText = '';
  let finished = false;
  let idleTimer = null;

  const ws = new WebSocket(WS_URL, {
    headers: {
      'X-Api-App-Key': appId,
      'X-Api-Access-Key': accessKey,
      'X-Api-Resource-Id': resourceId,
      'X-Api-Connect-Id': crypto.randomUUID(),
    },
  });

  function resetIdleTimer() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => finishWith('语音识别响应超时，请检查网络或稍后再试'), IDLE_TIMEOUT_MS);
  }

  function finishWith(errMessage) {
    if (finished) return;
    finished = true;
    clearTimeout(idleTimer);
    try { ws.close(); } catch { /* 忽略 */ }
    if (errMessage) { if (onError) onError(new Error(errMessage)); }
    else if (onFinal) onFinal(lastText);
  }

  ws.on('open', () => {
    resetIdleTimer();
    try {
      ws.send(
        buildFullClientRequest(seq, {
          user: { uid: 'desktop-pet' },
          audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1, codec: 'raw' },
          // result_type 不填 = 默认行为：每次返回从开始到现在的所有分句结果（累加），
          // 停顿/分句不会丢内容；若填 'single' 则服务端每次只返回"当前这一句"，
          // 之前说的话会被新结果覆盖掉（之前的 bug 就是这么来的，不要再加回去）。
          request: { model_name: 'bigmodel', enable_punc: true, enable_itn: true },
        })
      );
    } catch (err) {
      finishWith('发送识别请求失败：' + (err.message || String(err)));
    }
  });

  ws.on('message', (data) => {
    resetIdleTimer();
    let msg;
    try {
      msg = parseServerMessage(Buffer.isBuffer(data) ? data : Buffer.from(data));
    } catch {
      return; // 解析失败的单条消息直接丢弃，不影响会话继续
    }
    if (!msg) return;
    if (msg.type === 'error') {
      finishWith(typeof msg.message === 'string' ? msg.message : `识别出错（错误码 ${msg.errorCode}）`);
      return;
    }
    const text = extractText(msg.json);
    if (text) {
      lastText = text;
      if (onPartial) onPartial(text);
    }
    if (msg.isLast) finishWith(null);
  });

  ws.on('unexpected-response', (_req, res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => finishWith(`连接被拒绝（HTTP ${res.statusCode}）：${body.slice(0, 200) || '请检查 App ID / Access Key / Resource ID'}`));
  });
  ws.on('error', (err) => finishWith(err && err.message ? err.message : String(err)));
  // 服务端处理完最后一包音频后通常会直接关闭连接，不一定每次都能命中上面的"负序列号"判断，
  // 这里兜底：只要还没 finish 过，连接一关就当作正常结束，把已收到的最后文本回调出去
  ws.on('close', () => { if (!finished) finishWith(null); });

  return {
    sendAudio(pcmBuffer) {
      if (finished || ws.readyState !== WebSocket.OPEN) return;
      seq += 1;
      try {
        ws.send(buildAudioOnlyRequest(seq, pcmBuffer, false));
      } catch { /* 单个音频包发送失败不致命，忽略即可 */ }
    },
    finish() {
      if (finished) return;
      if (ws.readyState !== WebSocket.OPEN) {
        finishWith(null);
        return;
      }
      seq += 1;
      try {
        ws.send(buildAudioOnlyRequest(seq, Buffer.alloc(0), true));
      } catch {
        finishWith(null);
      }
      // 不在这里直接 finishWith：等服务端的最终结果或连接关闭（上面 'message'/'close' 里处理），
      // 15 秒兜底超时见 resetIdleTimer
    },
  };
}

module.exports = { createAsrSession };
