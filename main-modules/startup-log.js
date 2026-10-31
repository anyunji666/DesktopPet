// ---------- 启动日志（userData/startup.log） ----------
// 排查"开机自启动偶尔卡在加载界面"用：主进程和渲染进程（经 IPC）把启动各阶段的时间点、错误都记到这个文件里。
// 每行带"距进程起跑多少秒"，下次再卡住时，看最后一行停在哪一步就知道卡在哪。
// 文件超过 200KB 时只保留后面 100KB，不会无限增长。
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

let t0 = Date.now();
let file = null;
const MAX_BYTES = 200 * 1024;
const KEEP_BYTES = 100 * 1024;

function getFile() {
  if (!file) file = path.join(app.getPath('userData'), 'startup.log');
  return file;
}

function initStartupLog(startMs) {
  t0 = startMs || Date.now();
  try {
    const f = getFile();
    try {
      if (fs.statSync(f).size > MAX_BYTES) {
        const buf = fs.readFileSync(f);
        fs.writeFileSync(f, buf.subarray(buf.length - KEEP_BYTES));
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
