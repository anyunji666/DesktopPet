// ---------- LLM 请求客户端：调用日志 / callLLM / 拉模型列表 ----------
// 只管"把请求发出去并拿回结果"：读 API 配置（来自 llm.js）、发 OpenAI 兼容请求、超时处理、记最近一次调用。
// 依赖方向：本文件 -> llm.js（只取 getApiConfig）；llm.js 不能反向 require 本文件，否则会循环依赖。
const { getApiConfig } = require('./llm');
const geminiRelay = require('./gemini-relay');

// 请求地址指向本机的 Gemini 中转时，自动带上中转的访问口令，用户不用手填。
// 只对"本机 + 中转当前端口"生效，口令绝不会发给任何其它地址
function relayTokenFor(url, cfg) {
  try {
    const u = new URL(url);
    const isLocal = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
    const relayPort = geminiRelay.getStatus().port || cfg.llmRelayPort;
    if (isLocal && relayPort && Number(u.port) === relayPort && cfg.relayToken) return cfg.relayToken;
  } catch {}
  return '';
}

// ---------- 审查用：最近一次 LLM 调用的请求/回复 ----------
// 只留最近 1 次（请求+回复算一条），正常回复和归档摘要两种调用都算在内，不区分类型，谁最后调用完就显示谁的。
// 原来是打印到 start.bat 的控制台窗口，后来发现 console.clear() 在 Windows 经典 cmd.exe 下不一定生效
// （不是 TTY / 不支持 ANSI 转义时会静默失效，导致记录在终端里一直累积），改成推给独立的
// "LLM调用记录" 窗口（window.js 的 openLlmLogWindow），窗口那边整体替换内容显示，不存在清不干净的问题。
// cmd 窗口那边不再打印任何东西，恢复成 Node/Electron 原本的样子。
let latestCall = null; // 最新一条：{ label, requestText, replyText, ts }
let logListener = null; // 由 main.js 注入：新记录产生时，推给"LLM调用记录"窗口（如果开着的话）

function setLlmLogListener(fn) {
  logListener = typeof fn === 'function' ? fn : null;
}

function getLatestLlmCall() {
  return latestCall;
}

// messages 可能是纯字符串 content，也可能是 vision 模式下的数组（文本+图片 dataURL）；
// 图片直接显示占地方又没意义，这里只留文字部分，图片用 [图片] 占位
function stringifyMessagesForLog(messages) {
  return messages
    .map((m) => {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return m.content.map((part) => (part.type === 'text' ? part.text : '[图片]')).join('\n');
      }
      return String(m.content);
    })
    .join('\n\n');
}

function logRecentCall(label, requestText, replyText) {
  latestCall = { label, requestText, replyText, ts: Date.now() };
  if (logListener) logListener(latestCall);
}

// 单次 LLM 请求的超时上限（含读取响应体）。超时按报错处理：抛错、本轮不落历史，
// 聊天发送锁（chat-lock.js）随之释放，不会因为请求挂住而把两个窗口一直锁死
const LLM_TIMEOUT_MS = 120 * 1000;

// 通用 OpenAI 兼容 /chat/completions 请求。特意放在主进程发起（而不是渲染进程 fetch），
// 是为了避免 API Key 出现在渲染进程的网络面板/DevTools 里
// label：这次调用是干嘛的（比如"对话回复 - xxx"/"摘要生成 - xxx"），只用来在调试日志里区分，不影响请求本身
async function callLLM(messages, label = '对话回复') {
  const cfg = getApiConfig();
  if (!cfg.api_url) throw new Error('未配置 API Base URL，请先在"⚙ API 设置"里填写');
  if (!cfg.model) throw new Error('未配置模型名称，请先在"⚙ API 设置"里填写');

  const baseUrl = cfg.api_url.replace(/\/$/, '');
  const url = baseUrl.endsWith('/chat/completions') ? baseUrl : baseUrl + '/chat/completions';
  // 走本地中转时口令自动带上，不再要求填 API Key；其它地址仍必须有 Key
  const bearer = relayTokenFor(url, cfg) || cfg.api_key;
  if (!bearer) throw new Error('未配置 API Key，请先在"⚙ API 设置"里填写');

  // === 发请求 + 读响应体（共用一个 120 秒计时器）===
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, LLM_TIMEOUT_MS);
  let resp;
  let rawText;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: cfg.temperature,
        max_tokens: cfg.max_tokens,
        stream: false,
      }),
      signal: controller.signal,
    });
    rawText = await resp.text();
  } catch (err) {
    if (timedOut) throw new Error(`LLM 请求超时（超过 ${LLM_TIMEOUT_MS / 1000} 秒没有返回）`);
    throw err;
  } finally {
    clearTimeout(timer);
  }

  // === 解析响应 ===
  let data = null;
  try {
    data = JSON.parse(rawText);
  } catch {}

  if (!resp.ok) {
    const msg = data && data.error && (data.error.message || JSON.stringify(data.error));
    throw new Error(`HTTP ${resp.status}${msg ? ': ' + msg : ''}`);
  }
  if (!data) throw new Error('LLM 响应不是有效 JSON');
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('LLM 响应中没有回复内容');
  const reply = content.trim();
  logRecentCall(label, stringifyMessagesForLog(messages), reply);
  return reply;
}

// 拉取模型列表（标准 OpenAI 兼容 GET /v1/models）。参数用调用方当前表单里的值（不强制先保存），
// 方便在设置弹窗里填完 url/key 直接点"加载模型"试。
function normalizeModelList(data) {
  const arr = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
  const names = arr.map((m) => (typeof m === 'string' ? m : m?.id || m?.name || '')).filter(Boolean);
  return [...new Set(names)];
}

async function fetchModelList(apiUrl, apiKey) {
  if (!apiUrl) throw new Error('请先填写 API Base URL');
  const baseUrl = apiUrl.replace(/\/$/, '');
  const url = baseUrl.endsWith('/models') ? baseUrl : `${baseUrl}/models`;
  const bearer = relayTokenFor(url, getApiConfig()) || apiKey;
  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
  });
  const rawText = await resp.text();
  let data = null;
  try {
    data = JSON.parse(rawText);
  } catch {}

  if (!resp.ok) {
    const msg = data && data.error && (data.error.message || JSON.stringify(data.error));
    throw new Error(`HTTP ${resp.status}${msg ? ': ' + msg : ''}`);
  }
  if (!data) throw new Error('响应不是有效 JSON');
  const list = normalizeModelList(data);
  if (!list.length) throw new Error('返回的模型列表是空的');
  return list;
}

module.exports = {
  callLLM,
  fetchModelList,
  setLlmLogListener,
  getLatestLlmCall,
};
