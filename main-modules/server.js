// ---------- 本地静态服务器（解决中文路径 / file:// 限制） ----------
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isAllowedHost } = require('./security');

const ROOT = path.join(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.tga': 'application/octet-stream',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.pmx': 'application/octet-stream',
  '.pmd': 'application/octet-stream',
  '.vmd': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};

// ---------- 目录白名单 ----------
// 只对外提供渲染进程真正要用的目录，项目根目录下的其它文件（main.js、package.json、
// 文档、tools/ 等）一律不可访问。node_modules 也只开放 three 的 build 和 examples/jsm。
const ALLOWED_PREFIXES = [
  'public',
  'Character',
  'Actions',
  'Scene',
  path.join('node_modules', 'three', 'build'),
  path.join('node_modules', 'three', 'examples', 'jsm'),
].map((p) => path.join(ROOT, p));

// 路径边界判断：必须是白名单目录本身或它的子路径。
// 不能用 startsWith(dir)——"/proj/public-evil" 也以 "/proj/public" 开头
function isInside(dir, target) {
  const rel = path.relative(dir, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isAllowedPath(target, prefixes = ALLOWED_PREFIXES) {
  return prefixes.some((dir) => isInside(dir, target));
}

// 白名单目录解析成真实路径的版本：项目目录本身可能是通过软链 / 联接点打开的，
// 解析后的文件真实路径要和这一份比，不然会把正常文件误拦
function resolveRealPrefixes() {
  return ALLOWED_PREFIXES.map((dir) => {
    try {
      return fs.realpathSync(dir);
    } catch {
      return dir; // 目录不存在（比如没装 three）就保持原样，不影响其它目录
    }
  });
}

// ---------- CSP ----------
// 页面里的内联 <script> 没有 nonce，改用哈希放行：读取 HTML 时把每段内联脚本的 sha256 算出来加进策略，
// 这样 HTML 里的内联脚本照常工作，而被注入进来的脚本因为哈希对不上会被拒绝。
// 设为 true 时只上报不拦截（控制台会打印违规项），排查"某功能被 CSP 挡了"时可以临时打开。
const CSP_REPORT_ONLY = false;

function buildCsp(inlineScriptHashes) {
  const scriptSrc = ["'self'", "'wasm-unsafe-eval'", ...inlineScriptHashes].join(' ');
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function inlineScriptHashes(html) {
  const hashes = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (/\bsrc\s*=/.test(m[1])) continue; // 外部脚本走 'self'，不用哈希
    // HTML 解析器会把 CRLF / CR 统一成 LF 再交给脚本引擎，CSP 哈希按解析后的文本算，这里要先做同样的换行归一
    const text = m[2].replace(/\r\n?/g, '\n');
    hashes.push(`'sha256-${crypto.createHash('sha256').update(text, 'utf8').digest('base64')}'`);
  }
  return hashes;
}

function securityHeaders(extra) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    // 只允许同源加载：别的网页用 <script src=http://127.0.0.1:端口/...> 之类的方式嵌入这里的资源会被浏览器拒绝
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-cache',
    ...extra,
  };
}

function startServer() {
  let listenPort = 0;
  const realPrefixes = resolveRealPrefixes();
  const server = http.createServer((req, res) => {
    // 1. Host 校验：挡 DNS rebinding
    if (!isAllowedHost(req.headers.host, listenPort)) {
      res.writeHead(403, securityHeaders());
      return res.end();
    }
    // 2. 只读服务，只接受 GET / HEAD
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, securityHeaders({ Allow: 'GET, HEAD' }));
      return res.end();
    }

    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    } catch {
      res.writeHead(400, securityHeaders());
      return res.end();
    }
    if (urlPath.includes('\0')) {
      res.writeHead(400, securityHeaders());
      return res.end();
    }
    if (urlPath.endsWith('/')) urlPath += 'index.html';

    // 3. 隐藏文件（.git、.env 之类）一律不出
    if (urlPath.split('/').some((seg) => seg.startsWith('.'))) {
      res.writeHead(403, securityHeaders());
      return res.end();
    }

    // 4. 目录白名单（按路径边界判断，不是字符串前缀）
    const filePath = path.normalize(path.join(ROOT, urlPath));
    if (!isAllowedPath(filePath)) {
      res.writeHead(403, securityHeaders());
      return res.end();
    }

    // 5. 解析符号链接后再判一次，防止白名单目录里的软链指到目录外
    fs.realpath(filePath, (rerr, real) => {
      if (rerr || !isAllowedPath(real, realPrefixes)) {
        res.writeHead(rerr ? 404 : 403, securityHeaders());
        return res.end(rerr ? 'Not Found' : undefined);
      }
      fs.stat(real, (err, stat) => {
        if (err || !stat.isFile()) {
          res.writeHead(404, securityHeaders());
          return res.end('Not Found');
        }
        const ext = path.extname(real).toLowerCase();
        const type = MIME[ext] || 'application/octet-stream';

        // HTML：读进内存，按内联脚本算 CSP 哈希；其它文件直接流式返回
        if (ext === '.html') {
          fs.readFile(real, 'utf-8', (rerr2, html) => {
            if (rerr2) {
              res.writeHead(500, securityHeaders());
              return res.end();
            }
            const cspName = CSP_REPORT_ONLY ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';
            res.writeHead(200, securityHeaders({ 'Content-Type': type, [cspName]: buildCsp(inlineScriptHashes(html)) }));
            res.end(req.method === 'HEAD' ? undefined : html);
          });
          return;
        }

        res.writeHead(200, securityHeaders({ 'Content-Type': type, 'Content-Length': stat.size }));
        if (req.method === 'HEAD') return res.end();
        const stream = fs.createReadStream(real);
        stream.on('error', () => res.destroy());
        stream.pipe(res);
      });
    });
  });
  server.requestTimeout = 30 * 1000;
  server.headersTimeout = 10 * 1000;
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      listenPort = server.address().port;
      resolve(server);
    })
  );
}

module.exports = { startServer };
