// ---------- 公共安全工具 ----------
// 本地服务（静态服务 / Gemini 中转）的 Host 校验、请求体限长、角色名校验、
// 密钥遮罩，以及 Electron 窗口的导航 / 弹窗 / 权限收口。
const crypto = require('crypto');

// ---------- Host 校验（防 DNS rebinding）----------
// 浏览器把 evil.com 解析到 127.0.0.1 后，请求的 Host 头仍然是 evil.com:端口，
// 所以只放行 127.0.0.1 / localhost / [::1] 加上本服务的实际端口
function isAllowedHost(hostHeader, port) {
  if (typeof hostHeader !== 'string' || !hostHeader) return false;
  const h = hostHeader.toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === `[::1]:${port}`;
}

// ---------- 请求体限长读取 ----------
// 超过 maxBytes 立即中断，返回 Promise<Buffer>；超限时 reject 一个 { status: 413 } 对象
function readBodyLimited(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.resume();
      return reject({ status: 413, message: '请求体过大' });
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) {
        done = true;
        req.destroy();
        return reject({ status: 413, message: '请求体过大' });
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

// ---------- 常量时间比较（token 校验）----------
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ---------- 简单滑动窗口限频 ----------
function createRateLimiter(maxPerWindow, windowMs) {
  let hits = [];
  return function check() {
    const now = Date.now();
    hits = hits.filter((t) => now - t < windowMs);
    if (hits.length >= maxPerWindow) {
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((windowMs - (now - hits[0])) / 1000)) };
    }
    hits.push(now);
    return { ok: true };
  };
}

// ---------- 角色名 / 文件名校验 ----------
// 角色名来自 Character/ 目录名，会被拼进文件路径。这里统一收口：
// 不能为空、不能是 . / ..、不能含路径分隔符、控制字符和 Windows 保留字符
function isSafeName(name) {
  if (typeof name !== 'string') return false;
  if (!name || name.length > 120) return false;
  if (name === '.' || name === '..') return false;
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(name)) return false;
  if (name !== name.trim() || /\.$/.test(name)) return false;
  return true;
}

function assertSafeName(name) {
  if (!isSafeName(name)) throw new Error('无效的名称');
  return name;
}

// ---------- 密钥遮罩 ----------
// 渲染进程只拿得到遮罩后的字符串（••••abcd）；保存时如果原样传回遮罩，
// 主进程就认为"没改"，沿用原来的真实密钥
function maskSecret(secret) {
  const s = typeof secret === 'string' ? secret : '';
  if (!s) return '';
  return '••••' + (s.length > 8 ? s.slice(-4) : '');
}

// input 是渲染进程传来的值；candidates 是可能的原始密钥（按优先级排）。
// input 恰好等于某个候选的遮罩 -> 还原成真实密钥；否则视为用户新输入的值，原样返回
function resolveSecretInput(input, candidates) {
  if (typeof input !== 'string') return input;
  const v = input.trim();
  if (!v.startsWith('••••')) return v;
  for (const c of candidates || []) {
    if (c && maskSecret(c) === v) return c;
  }
  return ''; // 以遮罩开头却找不到对应密钥（原密钥已被清掉等），当作清空，不把遮罩当密钥存
}

// ---------- 日志脱敏 ----------
function redact(text, secrets) {
  let out = String(text == null ? '' : text);
  for (const s of secrets || []) {
    if (s && s.length >= 6) out = out.split(s).join('***');
  }
  return out.replace(/([?&]key=)[^&\s"']+/gi, '$1***');
}

// ---------- Electron 窗口加固 ----------
// origin：本地静态服务的来源（http://127.0.0.1:端口）。
// 1. 页面只能停留在自己的来源：任何跳转 / 重定向 / window.open 一律拦截
// 2. 权限请求默认全拒，只放行本来源的麦克风（语音输入要用）
// 3. 禁止 <webview>
function hardenWebContents(webContents, origin) {
  const getOrigin = typeof origin === 'function' ? origin : () => origin; // 端口启动后才知道，允许传函数
  const sameOrigin = (url) => {
    try {
      return new URL(url).origin === getOrigin();
    } catch {
      return false;
    }
  };
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  webContents.on('will-navigate', (e, url) => {
    if (!sameOrigin(url)) e.preventDefault();
  });
  webContents.on('will-redirect', (e, url) => {
    if (!sameOrigin(url)) e.preventDefault();
  });
  webContents.on('will-attach-webview', (e) => e.preventDefault());
}

function hardenSession(session, origin) {
  const getOrigin = typeof origin === 'function' ? origin : () => origin;
  const isOurs = (url) => {
    try {
      return new URL(url).origin === getOrigin();
    } catch {
      return false;
    }
  };
  session.setPermissionRequestHandler((wc, permission, callback, details) => {
    const url = (details && details.requestingUrl) || (wc && wc.getURL && wc.getURL()) || '';
    // 'media' = 麦克风 / 摄像头；只放行本来源的音频请求
    const wantsVideo = details && Array.isArray(details.mediaTypes) && details.mediaTypes.includes('video');
    callback(permission === 'media' && isOurs(url) && !wantsVideo);
  });
  session.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
    return permission === 'media' && isOurs(requestingOrigin);
  });
}

// ---------- IPC 发送方校验 ----------
// 把 ipcMain.handle / ipcMain.on 统一包一层：只处理来自本地静态服务页面的调用。
// 必须在注册任何 handler 之前调用。getOrigin 是函数（端口在启动后才知道）
function guardIpc(ipcMain, getOrigin) {
  const trusted = (e) => {
    try {
      const url = (e.senderFrame && e.senderFrame.url) || e.sender.getURL();
      return new URL(url).origin === getOrigin();
    } catch {
      return false;
    }
  };
  const origHandle = ipcMain.handle.bind(ipcMain);
  const origOn = ipcMain.on.bind(ipcMain);
  const origRemove = ipcMain.removeListener.bind(ipcMain);
  // 原函数 -> 包装函数：window.js 里有先 on 后 removeListener 的用法，移除时要找到当初挂上去的包装版
  const wrapped = new WeakMap();

  ipcMain.handle = (channel, fn) =>
    origHandle(channel, (e, ...args) => {
      if (!trusted(e)) throw new Error('拒绝来自未知页面的调用');
      return fn(e, ...args);
    });
  ipcMain.on = (channel, fn) => {
    const w =
      wrapped.get(fn) ||
      ((e, ...args) => {
        if (!trusted(e)) return;
        return fn(e, ...args);
      });
    wrapped.set(fn, w);
    return origOn(channel, w);
  };
  ipcMain.removeListener = (channel, fn) => origRemove(channel, wrapped.get(fn) || fn);
  ipcMain.off = ipcMain.removeListener;
}

module.exports = {
  isAllowedHost,
  readBodyLimited,
  safeEqual,
  generateToken,
  createRateLimiter,
  isSafeName,
  assertSafeName,
  maskSecret,
  resolveSecretInput,
  redact,
  hardenWebContents,
  hardenSession,
  guardIpc,
};
