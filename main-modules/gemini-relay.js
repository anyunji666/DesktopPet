// ---------- Gemini 多 Key 轮询中转（桌宠本地专用） ----------
// 只监听 127.0.0.1，并且要求 Host 校验 + Bearer token + 拒绝浏览器请求（详见 requestHandler）；不支持 stream（桌宠本身按非流式请求 LLM）。
// 核心逻辑（轮询 / 429 冷却 / 模型列表 / 外层重试）参考自 SillyTavern 的 gemini-relay 插件，
// 精简掉了 SSE 流式分支和 Express 路由，重试参数直接写死，不开放到界面。
const http = require('http');
const { isAllowedHost, readBodyLimited, safeEqual, createRateLimiter, redact } = require('./security');

// 安全相关参数
const MAX_BODY_BYTES = 12 * 1024 * 1024; // 请求体上限（聊天历史很长、又随消息带图时也够用；上游 Google 是 20 MB，别越过它）
const RATE_LIMIT_MAX = 30; // 每分钟最多处理的请求数（桌宠正常使用远低于此）
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
// Gemini inline_data 官方支持的图片格式（gif 等不在其中，发过去会整条请求 400）
const SUPPORTED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif']);
const MODEL_ID_RE = /^[A-Za-z0-9._-]{1,100}$/; // 模型名会拼进上游 URL 路径，只允许安全字符
const rateLimiter = createRateLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);

const RETRY_ROUNDS = 3;
const RETRY_BASE_DELAY_MS = 2000;
const RETRY_MAX_DELAY_MS = 15000;
const MODELS_CACHE_TTL_MS = 10 * 60 * 1000;

let server = null;
let keyStates = []; // [{ key, cooldownUntil }]
let rrIndex = 0;
let modelsCache = { data: null, fetchedAt: 0 };
let relayToken = ''; // 访问口令：请求必须带 Authorization: Bearer <token>

function log(...args) {
  // 日志统一脱敏：不让真实 Key / token 出现在控制台
  const secrets = [relayToken, ...keyStates.map((k) => k.key)];
  console.log('[gemini-relay]', new Date().toISOString(), ...args.map((a) => (typeof a === 'string' ? redact(a, secrets) : a)));
}

// 距离下一个太平洋时间午夜还有多少毫秒（Gemini 免费额度按太平洋时间每日重置）
function msUntilNextPTMidnight() {
  const nowPT = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const nextMidnightPT = new Date(nowPT);
  nextMidnightPT.setHours(24, 0, 0, 0);
  return nextMidnightPT - nowPT;
}

// 挑下一个可用 key（跳过冷却中的），从上次位置继续轮询；全部冷却中则选最快恢复的那个
function pickKey() {
  const now = Date.now();
  for (let i = 0; i < keyStates.length; i++) {
    const idx = (rrIndex + i) % keyStates.length;
    if (keyStates[idx].cooldownUntil <= now) {
      rrIndex = (idx + 1) % keyStates.length;
      return idx;
    }
  }
  let best = 0;
  for (let i = 1; i < keyStates.length; i++) {
    if (keyStates[i].cooldownUntil < keyStates[best].cooldownUntil) best = i;
  }
  return best;
}

// 解析 429 报错，区分"每日额度"和"每分钟限流"，给出不同冷却时长
function applyCooldown(idx, bodyText) {
  let cooldownMs = 60 * 1000;
  try {
    const body = JSON.parse(bodyText);
    const msg = (body && body.error && body.error.message) || '';
    const isDaily = /PerDay/i.test(msg) || /PerProjectPerModel-FreeTier.*Day/i.test(JSON.stringify(body));
    if (isDaily) {
      cooldownMs = msUntilNextPTMidnight();
      log(`Key #${idx + 1} 触发每日额度限制，冷却至太平洋时间午夜`);
    } else {
      const retryMatch = msg.match(/retry in ([\d.]+)s/i);
      const retrySeconds = retryMatch ? parseFloat(retryMatch[1]) : 60;
      cooldownMs = Math.ceil(retrySeconds * 1000) + 1000;
      log(`Key #${idx + 1} 触发分钟级限流，冷却 ${Math.ceil(cooldownMs / 1000)} 秒`);
    }
  } catch (e) {
    log(`Key #${idx + 1} 返回 429 但无法解析详情，按默认 1 分钟冷却`);
  }
  keyStates[idx].cooldownUntil = Date.now() + cooldownMs;
}

// 用某个 key 拉模型列表（自动翻页），只保留支持 generateContent（能聊天）的模型
async function fetchModelsWithKey(apiKey) {
  const models = [];
  let pageToken = '';
  do {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const resp = await fetch(url, { headers: { 'x-goog-api-key': apiKey } });
    if (!resp.ok) {
      const bodyText = await resp.text();
      throw { status: resp.status, body: bodyText };
    }
    const data = await resp.json();
    for (const m of data.models || []) {
      if ((m.supportedGenerationMethods || []).includes('generateContent')) {
        models.push({
          id: (m.name || '').replace(/^models\//, ''),
          object: 'model',
          created: 0,
          owned_by: 'google',
        });
      }
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return models;
}

// 拉模型列表：优先用缓存（10分钟），过期后用未冷却的 key 依次尝试
async function getModelList() {
  if (modelsCache.data && Date.now() - modelsCache.fetchedAt < MODELS_CACHE_TTL_MS) {
    return modelsCache.data;
  }
  const now = Date.now();
  const order = [...keyStates].sort((a, b) => {
    const aCooling = a.cooldownUntil > now ? 1 : 0;
    const bCooling = b.cooldownUntil > now ? 1 : 0;
    return aCooling - bCooling; // 未冷却的排前面
  });

  let lastErr = null;
  for (const keyState of order) {
    try {
      const models = await fetchModelsWithKey(keyState.key);
      modelsCache = { data: models, fetchedAt: Date.now() };
      log(`模型列表已刷新，共 ${models.length} 个可聊天模型`);
      return models;
    } catch (e) {
      lastErr = e;
      log(`某个 Key 拉取模型列表失败: ${e.status || ''} ${e.body || e.message || ''}`);
    }
  }
  if (modelsCache.data) {
    log('拉取模型列表全部失败，返回上一次的缓存数据');
    return modelsCache.data;
  }
  throw lastErr || { status: 500, body: '无法获取模型列表' };
}

// 拿一条消息的文字部分：content 可能是字符串，也可能是 OpenAI 视觉数组（桌宠开识图时发的那种）
function contentToText(content) {
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part && part.type === 'text' ? part.text || '' : ''))
      .filter(Boolean)
      .join('\n');
  }
  return typeof content === 'string' ? content : content == null ? '' : String(content);
}

// OpenAI content 数组里的单个 part -> Gemini parts
// 文本 -> { text }；图片 -> { inline_data: { mime_type, data } }（Gemini 的图片必须直接带 base64 数据，
// 只认 dataURL，http(s) 链接这种 inline_data 收不了，直接丢掉——prompt 里本来就带 [图片:文件名] 占位；
// 格式也只放行 SUPPORTED_IMAGE_MIMES 里的，gif 等不支持的格式同样丢掉）
function toGeminiParts(content) {
  if (!Array.isArray(content)) return [{ text: contentToText(content) }];
  const parts = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push({ text: part });
    } else if (part && part.type === 'text') {
      if (part.text) parts.push({ text: String(part.text) });
    } else if (part && part.type === 'image_url') {
      const match = /^data:([^;,]+);base64,(.+)$/i.exec((part.image_url && part.image_url.url) || '');
      if (match) {
        let mime = match[1].toLowerCase();
        if (mime === 'image/jpg') mime = 'image/jpeg';
        if (SUPPORTED_IMAGE_MIMES.has(mime)) {
          parts.push({ inline_data: { mime_type: mime, data: match[2] } });
        } else {
          log(`图片格式 ${mime} 不被 Gemini 支持，已丢弃这张图（文字部分照常发送）`);
        }
      }
    }
  }
  return parts;
}

// OpenAI 风格 messages 数组 -> Gemini contents 格式
function toGeminiContents(messages) {
  const contents = [];
  let systemText = '';
  for (const m of messages || []) {
    if (m.role === 'system') {
      systemText += (systemText ? '\n' : '') + contentToText(m.content);
      continue;
    }
    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts = toGeminiParts(m.content);
    if (!parts.length) continue; // 空消息（比如只有图片却没带上 base64）不占一条 content
    contents.push({ role, parts });
  }
  if (systemText && contents.length && contents[0].role === 'user') {
    // system 拼进第一条 user：那条可能是视觉数组，文字 part 不一定在 parts[0]，得找出来
    const textPart = contents[0].parts.find((p) => typeof p.text === 'string');
    if (textPart) textPart.text = systemText + '\n\n' + textPart.text;
    else contents[0].parts.unshift({ text: systemText });
  } else if (systemText && !contents.length) {
    contents.push({ role: 'user', parts: [{ text: systemText }] });
  }
  return contents;
}

// 单轮：把所有 key 轮一遍。成功则返回 resp；这一轮全部失败则抛出 lastErr
async function tryAllKeysOnce(model, contents) {
  const maxAttempts = keyStates.length;
  let lastErr = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const idx = pickKey();
    const keyState = keyStates[idx];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        // Key 放请求头而不是 URL 查询参数：URL 容易被各种日志 / 报错信息带出去
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': keyState.key },
        body: JSON.stringify({ contents }),
      });
    } catch (networkErr) {
      lastErr = { status: 0, body: redact(String(networkErr), [keyState.key]), retryable: true };
      continue;
    }

    if (resp.status === 429) {
      const bodyText = await resp.text();
      applyCooldown(idx, bodyText);
      lastErr = { status: 429, body: bodyText, retryable: true };
      continue;
    }

    if (!resp.ok) {
      const bodyText = await resp.text();
      // 5xx / 408 值得整体重试；其余 4xx 重试也没用
      const retryable = resp.status >= 500 || resp.status === 408;
      lastErr = { status: resp.status, body: bodyText, retryable };
      // 只有"这个 Key 本身有问题"才换下一个 Key：401/403，或 400 里明确说 Key 无效
      // 其它错误（请求体格式、模型不存在等）换 Key 结果一样，立刻中止，别白耗每个 Key 的额度和限频
      const keySpecific =
        resp.status === 401 || resp.status === 403 || (resp.status === 400 && /API_KEY_INVALID|API key not valid/i.test(bodyText));
      if (retryable || keySpecific) {
        if (keySpecific) log(`Key #${idx + 1} 疑似无效或无权限 (status=${resp.status})，换下一个`);
        continue;
      }
      log(`请求本身有问题 (status=${resp.status})，换 Key 也不会好，直接中止`);
      throw lastErr;
    }

    log(`Key #${idx + 1} 请求成功 (model=${model})`);
    return resp;
  }
  throw lastErr || { status: 500, body: '所有 Key 均不可用' };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 外层重试：一轮所有 key 都因临时性错误失败，指数退避后整体再来一轮；遇到不可自愈的错误直接放弃
async function callGemini(model, contents) {
  let lastErr = null;
  for (let round = 0; round < RETRY_ROUNDS; round++) {
    try {
      return await tryAllKeysOnce(model, contents);
    } catch (err) {
      lastErr = err;
      if (!err.retryable) {
        log(`遇到不可重试的错误 (status=${err.status})，不再重试`);
        break;
      }
      if (round < RETRY_ROUNDS - 1) {
        const delay = Math.min(RETRY_BASE_DELAY_MS * 2 ** round, RETRY_MAX_DELAY_MS);
        log(`第 ${round + 1}/${RETRY_ROUNDS} 轮所有 Key 均失败（临时性错误），${delay}ms 后整体重试`);
        await sleep(delay);
      }
    }
  }
  throw lastErr || { status: 500, body: '所有 Key 均调用失败' };
}

function sendJson(res, status, obj, extraHeaders) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(extraHeaders || {}),
  });
  res.end(JSON.stringify(obj));
}

async function handleChatCompletions(payload, res) {
  const model = (payload && payload.model) || '';
  if (!model) return sendJson(res, 400, { error: { message: '请求里缺少 model 字段' } });
  if (typeof model !== 'string' || !MODEL_ID_RE.test(model)) {
    return sendJson(res, 400, { error: { message: 'model 字段含有非法字符' } });
  }
  const contents = toGeminiContents(payload && payload.messages);

  try {
    const geminiResp = await callGemini(model, contents);
    const data = await geminiResp.json();
    const cand = data?.candidates?.[0];
    // 拼接所有文字 part（跳过思考摘要 thought），不再只取 parts[0]
    const text = ((cand && cand.content && cand.content.parts) || [])
      .filter((p) => p && typeof p.text === 'string' && !p.thought)
      .map((p) => p.text)
      .join('');
    if (!text) {
      // 被安全过滤 / 提示词被拒 / 其它原因没出文字：把原因带回去，别静默返回空气泡
      const blockReason = data && data.promptFeedback && data.promptFeedback.blockReason;
      const finishReason = cand && cand.finishReason;
      const reason = blockReason ? `提示词被拦截 (${blockReason})` : finishReason ? `生成中止 (${finishReason})` : '没有返回任何内容';
      log('Gemini 返回空文本:', reason);
      return sendJson(res, 502, { error: { message: 'Gemini 未返回文本：' + reason } });
    }
    sendJson(res, 200, {
      id: 'chatcmpl-relay',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: cand && cand.finishReason === 'MAX_TOKENS' ? 'length' : 'stop' }],
      usage: data.usageMetadata || {},
    });
  } catch (err) {
    log('所有 Key 均失败:', err);
    sendJson(res, err.status || 500, {
      error: { message: '所有 Key 都调用失败，详情: ' + redact(err.body || err.message || '未知错误', keyStates.map((k) => k.key)) },
    });
  }
}

// 请求入口，逐层设卡：
//   1. Host 校验：Host 头必须是 127.0.0.1/localhost + 本服务端口（挡 DNS rebinding）
//   2. 拒绝浏览器发来的请求：带 Origin / Sec-Fetch-Site 头的一律不处理（挡网页对本机端口的跨站请求；Sec-Fetch-Mode 不查，Node 自带 fetch 会固定带它）
//   3. Bearer token：桌宠自己请求时由主进程自动带上，其它程序不知道口令就进不来
//   4. 限频 + 请求体上限 + 必须是 JSON
// 任何情况下都不返回 CORS 头，也不响应 OPTIONS 预检。
function requestHandler(req, res) {
  const port = server && server.address() ? server.address().port : 0;

  if (!isAllowedHost(req.headers.host, port)) {
    return sendJson(res, 403, { error: { message: 'Forbidden host' } });
  }
  if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) {
    return sendJson(res, 403, { error: { message: 'Browser requests are not allowed' } });
  }
  if (req.method === 'OPTIONS') {
    return sendJson(res, 403, { error: { message: 'Forbidden' } });
  }

  const auth = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!relayToken || !m || !safeEqual(m[1].trim(), relayToken)) {
    return sendJson(res, 401, { error: { message: 'Unauthorized: invalid or missing relay token' } }, { 'WWW-Authenticate': 'Bearer' });
  }

  const limit = rateLimiter();
  if (!limit.ok) {
    return sendJson(res, 429, { error: { message: '请求过于频繁，请稍后再试' } }, { 'Retry-After': String(limit.retryAfterSec) });
  }

  // 只看路径，忽略查询串
  const pathname = String(req.url || '').split('?')[0];

  if (req.method === 'GET' && (pathname === '/v1/models' || pathname === '/models')) {
    getModelList()
      .then((models) => sendJson(res, 200, { object: 'list', data: models }))
      .catch((e) =>
        sendJson(res, e.status || 500, {
          error: { message: '获取模型列表失败: ' + redact(e.body || e.message || '未知错误', keyStates.map((k) => k.key)) },
        })
      );
    return;
  }

  if (req.method === 'POST' && (pathname === '/v1/chat/completions' || pathname === '/chat/completions')) {
    const ctype = String(req.headers['content-type'] || '').toLowerCase();
    if (!ctype.startsWith('application/json')) {
      req.resume();
      return sendJson(res, 415, { error: { message: 'Content-Type must be application/json' } });
    }
    readBodyLimited(req, MAX_BODY_BYTES)
      .then(async (buf) => {
        let payload;
        try {
          payload = JSON.parse(buf.toString('utf-8') || '{}');
        } catch (e) {
          return sendJson(res, 400, { error: { message: 'Invalid JSON body' } });
        }
        await handleChatCompletions(payload, res);
      })
      .catch((e) => {
        if (!res.headersSent) sendJson(res, e.status || 400, { error: { message: e.message || 'Bad request' } });
      });
    return;
  }

  sendJson(res, 404, { error: { message: 'Not found. Use POST /v1/chat/completions' } });
}

// keys 非空 -> （重新）启动或热更新 key 列表；空 -> 关停服务释放端口。
// 已在跑的情况下只热更新 key 列表、不重启服务，端口不变，界面上填好的 Base URL 不用跟着改。
// 热更新时按 key 内容匹配保留冷却状态，避免刚保存一下配置就把冷却计时重置掉。
// preferredPort：调用方记住的上次端口号；只在"这次是从头启动"时才会用到——优先复用它，
// 只有它被别的程序占用了才回退到系统自动分配的端口（调用方应该把返回状态里的新端口重新记下来）。
function setKeys(keys, preferredPort, token) {
  if (typeof token === 'string' && token) relayToken = token;
  const list = (Array.isArray(keys) ? keys : []).map((k) => (typeof k === 'string' ? k.trim() : '')).filter(Boolean);

  if (!list.length) {
    if (server) {
      server.close();
      server = null;
      log('Key 列表已清空，中转服务已停止');
    }
    keyStates = [];
    modelsCache = { data: null, fetchedAt: 0 };
    return Promise.resolve(getStatus());
  }

  const prevStates = keyStates;
  keyStates = list.map((key) => {
    const prev = prevStates.find((p) => p.key === key);
    return { key, cooldownUntil: prev ? prev.cooldownUntil : 0 };
  });
  rrIndex = 0;
  modelsCache = { data: null, fetchedAt: 0 };

  if (server) {
    log(`Key 列表已更新，共 ${keyStates.length} 个`);
    return Promise.resolve(getStatus());
  }

  const wantPort = Number.isInteger(preferredPort) && preferredPort > 0 ? preferredPort : 0;

  return new Promise((resolve, reject) => {
    const tryListen = (port, isFallback) => {
      const s = http.createServer(requestHandler);
      s.requestTimeout = 30 * 1000; // 请求体 30 秒内必须收完，防慢速占连接
      s.headersTimeout = 10 * 1000;
      s.maxHeadersCount = 50;
      s.on('error', (err) => {
        if (!isFallback && port && err.code === 'EADDRINUSE') {
          log(`记住的端口 ${port} 被占用，改用系统自动分配的端口`);
          tryListen(0, true);
          return;
        }
        log('中转服务启动失败:', err);
        if (server === s) server = null;
        reject(err);
      });
      s.listen(port, '127.0.0.1', () => {
        server = s;
        log(`中转服务已启动，共 ${keyStates.length} 个 Key，端口 ${s.address().port}`);
        resolve(getStatus());
      });
    };
    tryListen(wantPort, false);
  });
}

function getStatus() {
  return {
    running: !!server,
    port: server && server.address() ? server.address().port : null,
    keyCount: keyStates.length,
  };
}

function stopRelay() {
  if (server) {
    server.close();
    server = null;
  }
}

module.exports = { setKeys, getStatus, stopRelay };
