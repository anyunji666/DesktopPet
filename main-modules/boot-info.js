// ---------- Windows 启动诊断 ----------
// 「开机用时」口径：主板自检（UEFI 上报的 POST 耗时）+ 系统自统计的 BootTime，读不到就逐段收窄。
// 只负责"查/算/拼文案"，什么时候报、报给谁由入口（main.js 的 model-ready）决定。
// 文件末尾是启动看门狗（页面卡在加载界面时自动重载），因为它和启动计时共用同一套"启动阶段"概念。
const { execFile } = require('child_process');
const { state } = require('./state');
const { startupLog } = require('./startup-log');

// 防止 model-ready 被重复触发时重复计算 / 重复弹气泡
let bootTimerReported = false;

// 同一场开机内多次启动，各自算出来的"开机时间点"理论上只差几秒（时钟精度/计算时机导致的误差），
// 超过这个容差就认为是不同的一场开机（比如重启过、休眠又开机）
const SAME_BOOT_TOLERANCE_MS = 15000;

// 算出来/读出来的"开机用时"超过这个值就认为不可信（快速启动下的假数据 / 异常值），不展示
const MAX_PLAUSIBLE_BOOT_SEC = 600;

// 主板自检耗时（FwPostTime）的合理上限，主板固件实现不规范时可能报 0 或离谱值
const MAX_PLAUSIBLE_POST_MS = 300 * 1000;

// 系统自统计的 BootTime 要等整场启动结束、系统趋于空闲后才写入日志（实测通常在开机后
// 一两分钟，慢机器更久），本程序随登录自启时读到的还是上一次开机的旧记录（归属校验会
// 把它拒掉）。这里轮询等本次启动的事件出现，超时返回 null。
const BOOT_EVENT_POLL_TIMEOUT_MS = 5 * 60 * 1000;
const BOOT_EVENT_POLL_INTERVAL_MS = 10 * 1000;

// 只有第一次调用返回 true：等价于原来在 model-ready 里直接读写 bootTimerReported 标志
function claimBootTimerReport() {
  if (bootTimerReported) return false;
  bootTimerReported = true;
  return true;
}

function formatBootDuration(seconds) {
  if (seconds < 60) return `${seconds.toFixed(1)}秒`;
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}分${s.toFixed(1)}秒`;
}

// 查当前这次交互登录（本地账号 / 微软账号，含指纹或 PIN 登录）的登录时间点，返回毫秒时间戳；查不到返回 null。
// 用 PowerShell 走 CIM（Win32_LogonSession）而不是解析 `query user` 的文字输出——后者的表头和日期格式
// 会跟着系统语言/区域走，中文/英文/其它语言下格式都不一样，解析很容易出错；CIM 的 StartTime 转成
// DateTimeOffset 再转 Unix 毫秒，是纯数字，不受语言/区域影响。
// LogonType：2=交互登录（本机键盘密码/PIN/指纹），10/12=远程交互（RDP），11=缓存的域凭据交互登录——
// 覆盖常见的本地开机登录场景；同一用户可能有多条记录，取时间最新的一条。
function getInteractiveLogonTimeMs() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    const script =
      '$s = Get-CimInstance Win32_LogonSession | ' +
      'Where-Object { $_.LogonType -in 2,10,11,12 } | ' +
      'Sort-Object StartTime -Descending | Select-Object -First 1; ' +
      'if ($s -and $s.StartTime) { [DateTimeOffset]$s.StartTime | ForEach-Object { $_.ToUnixTimeMilliseconds() } }';
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const ms = parseInt(String(stdout).trim(), 10);
        resolve(Number.isFinite(ms) && ms > 0 ? ms : null);
      }
    );
  });
}

// 查"本次系统启动"的真实时间点，返回毫秒时间戳；查不到返回 null。
// 为什么不能只用 os.uptime()：Windows 开着「快速启动」时，点"关机"其实是内核休眠 + 注销用户，
// 内核运行时间不会清零，os.uptime() 会从上次真正重启起累计（可能好几天），
// 拿它推出来的"开机时间点"会停在几天前，再减登录时间就得到几万分钟的离谱数字。
// 系统事件日志里，每次启动（含快速启动恢复）都会记一条：
//   Microsoft-Windows-Kernel-General  ID 12（操作系统已启动）
//   Microsoft-Windows-Kernel-Boot     ID 27（启动类型：0=完整启动，1=快速启动，2=休眠恢复）
// 取这两类里最新的一条作为本次启动时间点。普通用户即可读 System 日志，不需要管理员权限。
function getLatestBootEventTimeMs() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    const script =
      "$t = @(); " +
      "$t += Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='Microsoft-Windows-Kernel-General';Id=12} -MaxEvents 1 -ErrorAction SilentlyContinue; " +
      "$t += Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='Microsoft-Windows-Kernel-Boot';Id=27} -MaxEvents 1 -ErrorAction SilentlyContinue; " +
      '$e = $t | Where-Object { $_ } | Sort-Object TimeCreated -Descending | Select-Object -First 1; ' +
      'if ($e) { [DateTimeOffset]$e.TimeCreated | ForEach-Object { $_.ToUnixTimeMilliseconds() } }';
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 8000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const ms = parseInt(String(stdout).trim(), 10);
        resolve(Number.isFinite(ms) && ms > 0 ? ms : null);
      }
    );
  });
}

// 读系统自己统计的启动总结（Diagnostics-Performance 日志里事件 ID 100「Windows 启动」，
// 任务管理器"启动"页背后就是这套数据）。返回 { bootTimeMs, numStartupApps, trend, trendDeltaMs }：
// bootTimeMs = Windows 自己度量的"从内核启动到整场就绪"总耗时（BootTime 字段，毫秒），
// 最接近"系统本身有多快"；numStartupApps = 本次跑的自启动应用数（可能缺失）；
// trend = 系统拿本场启动和近几次开机的历史基线比出来的就绪时间趋势：
// 'slower'（BootIsDegradation=true，变慢）/ 'faster'（BootImprovementDelta>0，变快）/ 'flat'（无明显变动），
// trendDeltaMs = 对应的变化量（毫秒，可能缺失）。
// 快速启动（混合关机）恢复时不会写这条事件，读不到是常态。返回 null 的情况：
// 查不到事件、事件不属于本次启动（时间点对不上，多半是上一次完整启动留下的旧记录）、数值异常。
// bootAtMs 传"本次启动时间点"，用来校验事件归属。
function getDiagnosticsBootInfo(bootAtMs, nowMs) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    const script =
      "$e = Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-Diagnostics-Performance/Operational';Id=100} -MaxEvents 1 -ErrorAction SilentlyContinue; " +
      'if ($e) { ' +
      '$x = [xml]$e.ToXml(); ' +
      "function Get-Data($n) { $d = $x.Event.EventData.Data | Where-Object { $_.Name -eq $n }; if ($d) { $d.'#text' } }; " +
      "$b = Get-Data 'BootTime'; " +
      'if ($b) { ' +
      '$ms = [DateTimeOffset]$e.TimeCreated | ForEach-Object { $_.ToUnixTimeMilliseconds() }; ' +
      "($b, $ms, (Get-Data 'BootNumStartupApps'), (Get-Data 'BootIsDegradation'), (Get-Data 'BootImprovementDelta'), (Get-Data 'BootDegradationDelta')) -join ',' " +
      '} }';
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 8000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const [bootMsStr, evMsStr, appsStr, degradStr, improveStr, degradDeltaStr] = String(stdout).trim().split(',');
        const bootTimeMs = parseInt(bootMsStr, 10);
        const eventAtMs = parseInt(evMsStr, 10);
        const sane =
          Number.isFinite(bootTimeMs) && bootTimeMs > 0 && bootTimeMs <= MAX_PLAUSIBLE_BOOT_SEC * 1000 &&
          Number.isFinite(eventAtMs) && eventAtMs >= bootAtMs && eventAtMs <= nowMs;
        if (!sane) return resolve(null);
        const numStartupApps = parseInt(appsStr, 10);
        const improvementDeltaMs = parseInt(improveStr, 10);
        const degradationDeltaMs = parseInt(degradDeltaStr, 10);
        const trend = String(degradStr).toLowerCase() === 'true'
          ? 'slower'
          : Number.isFinite(improvementDeltaMs) && improvementDeltaMs > 0 ? 'faster' : 'flat';
        const trendDeltaMs = trend === 'slower' ? degradationDeltaMs : trend === 'faster' ? improvementDeltaMs : null;
        resolve({
          bootTimeMs,
          numStartupApps: Number.isFinite(numStartupApps) && numStartupApps >= 0 ? numStartupApps : null,
          trend,
          trendDeltaMs,
        });
      }
    );
  });
}

async function pollDiagnosticsBootInfo(bootAtMs) {
  const deadline = Date.now() + BOOT_EVENT_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const info = await getDiagnosticsBootInfo(bootAtMs, Date.now());
    if (info != null) return info;
    await new Promise((r) => setTimeout(r, BOOT_EVENT_POLL_INTERVAL_MS));
  }
  return null;
}

// 兜底口径：登录完成时间 − 开机时间，返回秒数；不可用返回 null。
// 注意它只量到"登录完成"，不含登录后系统后台就绪的那段，可能比真实开机耗时少十几秒。
async function getLoginFallbackBootSec(bootAtMs, eventBootValid, nowMs) {
  const loginAtMs = await getInteractiveLogonTimeMs();
  // 登录时间要落在"开机之后、现在之前"才算有效，否则（查不到 / 系统时钟被调过导致的异常值）视为不可用
  let valid = loginAtMs != null && loginAtMs >= bootAtMs && loginAtMs <= nowMs;
  // 没读到启动事件时（bootAtMs 来自 os.uptime() 推算），用时过长基本就是快速启动导致的假数据，不展示
  if (valid && !eventBootValid && (loginAtMs - bootAtMs) / 1000 > MAX_PLAUSIBLE_BOOT_SEC) valid = false;
  return valid ? (loginAtMs - bootAtMs) / 1000 : null;
}

// 读"上次开机"的主板自检（POST）耗时，返回毫秒；读不到或数值离谱返回 null。
// 来源：UEFI 固件把从上电到交给 Windows 的耗时通过 ACPI FPDT 表上报，内核每次开机写进注册表，
// 任务管理器"上次 BIOS 所用时间"读的就是同一处。普通用户权限可读。
// 本程序随登录自启时读到的一定是本次开机的值；主板固件实现不规范时可能报 0 或离谱值，做上限校验。
function getFwPostTimeMs() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    execFile(
      'reg.exe',
      ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Power', '/v', 'FwPostTime'],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        // 输出形如 "    FwPostTime    REG_DWORD    0x42ca"
        const m = /FwPostTime\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(String(stdout));
        if (!m) return resolve(null);
        const ms = parseInt(m[1], 16);
        resolve(Number.isFinite(ms) && ms > 0 && ms <= MAX_PLAUSIBLE_POST_MS ? ms : null);
      }
    );
  });
}

// 拼开机耗时的气泡文案。postMs（主板自检）读得到时，计时起点提前到"按下电源"并分段列出；
// 读不到就按"内核启动"起算。mainSec 是系统段耗时，mainLabel 描述系统段终点：
// "系统"=启动到就绪（系统自统计 BootTime），"系统到登录"=只到登录完成（兜底估算）。
function bootTimeText(postMs, mainSec, mainLabel) {
  if (postMs == null) {
    return `${mainLabel === '系统' ? '本次开机用时' : '本次开机到登录用时'}${formatBootDuration(mainSec)}`;
  }
  if (mainLabel === '系统') {
    return `系统准备就绪用时${formatBootDuration(postMs / 1000 + mainSec)}（主板自检${formatBootDuration(postMs / 1000)}，系统加载到空闲${formatBootDuration(mainSec)}）`;
  }
  return `系统登录完成用时${formatBootDuration(postMs / 1000 + mainSec)}（主板自检${formatBootDuration(postMs / 1000)}，系统到登录${formatBootDuration(mainSec)}）`;
}

// 拼启动总结里"自启动应用数 + 与历史基线相比的就绪时间趋势"的文案，返回以"，"开头的尾巴
// （没读到总结事件时返回空串）。趋势和变化量都是系统拿本场启动与近几次开机比出来的。
function startupSummaryText(info) {
  if (!info) return '';
  const parts = [];
  if (info.numStartupApps != null) parts.push(`自启动程序${info.numStartupApps}个`);
  const delta = Number.isFinite(info.trendDeltaMs) && info.trendDeltaMs > 0
    ? formatBootDuration(info.trendDeltaMs / 1000) : '';
  if (info.trend === 'slower') parts.push(`系统就绪时间增长${delta}`);
  else if (info.trend === 'faster') parts.push(`系统就绪时间缩短${delta}`);
  else parts.push('系统就绪时间无明显变动');
  return parts.length ? `，${parts.join('，')}` : '';
}

// ---------- 启动稳定性：卡住自动重载 ----------
// 开机自启动时系统很忙（磁盘 / CPU / 显卡进程都没就绪），偶尔会让页面卡在加载界面，手动重开又正常。
// 渲染进程在"首个动作加载完"后发 boot-done；这么久没收到就重载页面，最多连续重试几次。
// 重载会重新触发 did-finish-load → 重新下发 init，等于自动帮用户"重开一次"
const BOOT_TIMEOUT_MS = 45000;
const MAX_BOOT_RELOADS = 3;
let bootDone = false;
let bootReloads = 0;
let bootTimer = null;

function armBootWatchdog() {
  clearTimeout(bootTimer);
  if (bootDone) return;
  bootTimer = setTimeout(() => reloadMainWindow(`${BOOT_TIMEOUT_MS / 1000} 秒内没有收到启动完成信号`), BOOT_TIMEOUT_MS);
}

function reloadMainWindow(reason) {
  clearTimeout(bootTimer);
  if (!state.win || state.win.isDestroyed()) return;
  if (bootReloads >= MAX_BOOT_RELOADS) {
    startupLog(`已连续重载 ${MAX_BOOT_RELOADS} 次仍未成功，不再重试（原因：${reason}）`);
    return;
  }
  bootReloads++;
  bootDone = false;
  startupLog(`重载主窗口 (${bootReloads}/${MAX_BOOT_RELOADS})：${reason}`);
  setTimeout(() => {
    if (state.win && !state.win.isDestroyed()) state.win.webContents.reloadIgnoringCache();
  }, 1500);
}

// 收到渲染进程的 boot-done：取消看门狗，重载计数清零（计数的是"连续失败"，成功一次就清零）
function markBootDone() {
  bootDone = true;
  bootReloads = 0;
  clearTimeout(bootTimer);
}

module.exports = {
  SAME_BOOT_TOLERANCE_MS,
  claimBootTimerReport,
  formatBootDuration,
  getInteractiveLogonTimeMs,
  getLatestBootEventTimeMs,
  getDiagnosticsBootInfo,
  pollDiagnosticsBootInfo,
  getLoginFallbackBootSec,
  getFwPostTimeMs,
  bootTimeText,
  startupSummaryText,
  armBootWatchdog,
  reloadMainWindow,
  markBootDone,
};
