// ---------- 启动日志（userData/startup.log） ----------
// 排查"开机自启动偶尔卡在加载界面"用：主进程和渲染进程（经 IPC）把启动各阶段的时间点、错误都记到这个文件里。
// 每行带"距进程起跑多少秒"，下次再卡住时，看最后一行停在哪一步就知道卡在哪。
// 只保留最近 20 次启动的记录（每次启动以 "===== 启动 pid=" 开头成一段），不会无限增长；
// 另设 200KB 的字节上限兜底，防止某一次启动里日志异常刷屏。
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

let t0 = Date.now();
let file = null;
const KEEP_LAUNCHES = 20; // 含本次启动
const MAX_BYTES = 200 * 1024;
const LAUNCH_MARK = '\n===== 启动 pid=';

function getFile() {
  if (!file) file = path.join(app.getPath('userData'), 'startup.log');
  return file;
}

function initStartupLog(startMs) {
  t0 = startMs || Date.now();
  try {
    const f = getFile();
    try {
      const text = fs.readFileSync(f, 'utf-8');
      const blocks = text.split(LAUNCH_MARK).slice(1); // 第 0 段是第一个标记之前的残留，丢掉
      const keep = KEEP_LAUNCHES - 1; // 给本次启动留一个位置
      if (blocks.length > keep || Buffer.byteLength(text) > MAX_BYTES) {
        let out = blocks.slice(-keep).map((b) => LAUNCH_MARK + b).join('');
        const buf = Buffer.from(out, 'utf-8');
        if (buf.length > MAX_BYTES) out = buf.subarray(buf.length - MAX_BYTES / 2).toString('utf-8');
        fs.writeFileSync(f, out);
      }
    } catch {}
    fs.appendFileSync(f, `\n===== 启动 pid=${process.pid} ${new Date().toISOString()} =====\n`);
  } catch {}
}

function startupLog(msg) {
  try {
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    fs.appendFileSync(getFile(), `${new Date().toISOString()} +${sec}s ${msg}\n`);
  } catch {}
}

module.exports = { initStartupLog, startupLog, getStartupLogPath: getFile };
