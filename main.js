const { app, BrowserWindow, ipcMain, dialog, powerMonitor, screen, session } = require('electron');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFile } = require('child_process');

// 进程真正起跑的时间点，尽量贴近文件顶部，用来算"程序启动用时"（跟开机、登录、
// 隔了多久才手动打开都没关系，纯粹是这个 Electron 进程自己跑起来花了多久）
const APP_PROCESS_START_MS = Date.now();
const { initStartupLog, startupLog } = require('./main-modules/startup-log');

const ROOT = __dirname;

const { startServer } = require('./main-modules/server');
const geminiRelay = require('./main-modules/gemini-relay');
const { hardenWebContents, hardenSession, guardIpc, isSafeName, maskSecret } = require('./main-modules/security');
const { state } = require('./main-modules/state');
const { constrainMove, constrainResize, isCenterVisible } = require('./main-modules/win-limit');
const { requestClickThrough } = require('./main-modules/drag-guard');
const { beginChat, endChat, getChatPending, assertHistoryEditable, assertGlobalMemoryEditable } = require('./main-modules/chat-lock');
const { planCrossDaySummary, runChatTurn } = require('./main-modules/chat-turn');
const { exportToFile, importFromFile } = require('./main-modules/chat-transfer');
const { loadConfig, updateConfig, migrateSecrets } = require('./main-modules/config');
const { scanCharacters } = require('./main-modules/character');
const { scanScenes, setAdjust, normAdjust } = require('./main-modules/scene');
const {
  readPersonaFile,
  savePersonaFile,
  loadChatHistory,
  saveChatHistory,
  onChatHistorySaved,
  readChatImageDataURL,
  deleteChatImage,
  clearChatImages,
  readChatVoice,
  deleteChatVoice,
  clearChatVoices,
  clearDaySummaries,
  loadMemoryIndex,
  saveMemoryIndexManual,
  MEMORY_MAX_CHARS,
  clearOpenedDay,
} = require('./main-modules/chat-store');
const { loadAssets, saveAssetsFile, currentStoryDate } = require('./main-modules/assets');
const { getTtsConfig, saveTtsConfig, getPresets, testVoice } = require('./main-modules/tts');
const { maskProviders, resolveProvidersInput } = require('./main-modules/tts/config');
const { getAsrConfig, saveAsrConfig } = require('./main-modules/asr/config');
const { createAsrSession } = require('./main-modules/asr/doubao');
const { importCloneAudio, AUDIO_EXTENSIONS } = require('./main-modules/tts/clone-store');
const doubaoVoicesStore = require('./main-modules/tts/doubao-voices-store');
const {
  getApiConfig,
  getApiConfigForRenderer,
  resolveApiPatch,
  resolveApiKeyForUrl,
  ensureRelayToken,
  saveApiConfig,
  deleteApiProfile,
  getPromptConfig,
  savePromptConfig,
} = require('./main-modules/llm');
const { stripSpeakers } = require('./main-modules/tts/tone');
const { splitTurnSummary, extractStoryTime, extractOverview, buildSummaryBlock } = require('./main-modules/history-flatten');
const { fetchModelList, setLlmLogListener, getLatestLlmCall } = require('./main-modules/llm-client');
const {
  securePrefs,
  WIN_W,
  WIN_H,
  WIN_MIN_W,
  WIN_MAX_W,
  computeDesktopLayout,
  getAboutInfo,
  openRepoUrl,
  toggleDevEntries,
  openHistoryWindow,
  confirmCharacterVoiceSwitch,
  confirmAssetsSwitch,
  send,
  currentCharacterPayload,
  currentScene,
  buildMenu,
  migrateAutoLaunch,
} = require('./main-modules/window');

// ---------- 单实例锁：防止重复启动多个宠物互相抢资源（重复启动会明显变卡） ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (state.win && !state.win.isDestroyed()) {
      state.win.show();
      state.win.focus();
    }
  });
}

// ---------- 安全加固：窗口 / 权限 / IPC ----------
// 本地页面的来源（端口在静态服务启动后才确定，所以用函数延迟取值）
const pageOrigin = () => `http://127.0.0.1:${state.serverPort}`;

// 所有 IPC 只接受来自本地静态服务页面的调用（必须在注册任何 handler 之前包好）
guardIpc(ipcMain, pageOrigin);

// 每个窗口都：不许跳转到外部页面、不许 window.open、不许挂 webview
app.on('browser-window-created', (_e, win) => hardenWebContents(win.webContents, pageOrigin));

// 权限请求默认全拒，只放行本地页面的麦克风（语音输入）
app.whenReady().then(() => hardenSession(session.defaultSession, pageOrigin));

// ---------- 启动计时气泡 ----------
// 不管是不是开机自启动触发的，每次模型出现都报一次用时；但同一场开机内只在"第一次启动"
// 报完整的「开机用时 + 程序启动用时」，之后同一场开机里再打开（手动关了又重开等）只报
// 真实的「程序启动用时」，不再重复报开机用时（开机用时跟这是第几次打开程序无关）。
let bootTimerReported = false; // 防止 model-ready 被重复触发时重复计算 / 重复弹气泡

// 同一场开机内多次启动，各自算出来的"开机时间点"理论上只差几秒（时钟精度/计算时机导致的误差），
// 超过这个容差就认为是不同的一场开机（比如重启过、休眠又开机）
const SAME_BOOT_TOLERANCE_MS = 15000;

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

// 算出来/读出来的"开机用时"超过这个值就认为不可信（快速启动下的假数据 / 异常值），不展示
const MAX_PLAUSIBLE_BOOT_SEC = 600;

// 读系统自己统计的开机耗时：Diagnostics-Performance 日志（任务管理器"启动"页背后就是这套数据）
// 里事件 ID 100（Windows 启动）的 BootTime 字段，单位毫秒，是 Windows 自己度量的
// "从按下电源到启动完成"的总耗时，最接近"系统本身有多快"。
// 快速启动（混合关机）恢复时不会写这条事件，读不到是常态。返回 null 的情况：
// 查不到事件、事件不属于本次启动（时间点对不上，多半是上一次完整启动留下的旧记录）、数值异常。
// bootAtMs 传"本次启动时间点"，用来校验事件归属。
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

// 系统自统计的 BootTime 要等整场启动结束、系统趋于空闲后才写入日志（实测通常在开机后
// 一两分钟，慢机器更久），本程序随登录自启时读到的还是上一次开机的旧记录（归属校验会
// 把它拒掉）。这里轮询等本次启动的事件出现，超时返回 null。
const BOOT_EVENT_POLL_TIMEOUT_MS = 5 * 60 * 1000;
const BOOT_EVENT_POLL_INTERVAL_MS = 10 * 1000;

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
const MAX_PLAUSIBLE_POST_MS = 300 * 1000;

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

// 上次记的位置是否还能用：显示器插拔/分辨率变化后，坐标可能落在当前所有屏幕范围之外，
// 那种情况下用它会导致窗口开到看不见的地方，宁可放弃、退回默认居中。
// 判定标准和运行时的位置限制（win-limit.js）保持一致：窗口正中间一半的区域被工作区完整覆盖即可，
// 不能只看左上角——窗口左上角被允许部分移出屏幕，按左上角判会把这种合法位置误判成不可用
function isPositionUsable(x, y, width, height) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const areas = screen.getAllDisplays().map((d) => d.workArea);
  return isCenterVisible({ x, y, width, height }, areas);
}

// ---------- 主窗口位置/大小的持久化 ----------
// 只在 before-quit 里存不够：Windows 上系统关机/重启/注销不会触发 before-quit，
// 那种情况下位置不会更新，开机自启后就回到上次手动退出时的旧位置。
// 所以拖动/缩放（防抖）、关机事件里也各存一次，三处共用这一个函数。
// 桌面模式下真实窗口是被临时纵向展开的那一份，要存的是进入前记下的 state.normalWinBounds
function savePetBounds() {
  if (!state.win || state.win.isDestroyed()) return;
  if (state.win.isMinimized()) return; // 最小化时 Windows 会报 -32000 这种假坐标
  const bounds = state.bgMouseInteraction ? state.win.getBounds() : state.normalWinBounds || state.win.getBounds();
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.x <= -30000 || bounds.y <= -30000) return;
  updateConfig({ winPosition: { x: bounds.x, y: bounds.y }, winSize: { width: bounds.width, height: bounds.height } });
}

let saveBoundsTimer = null;
function scheduleSavePetBounds() {
  clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(savePetBounds, 500);
}

// 上次关闭时记的宽度是否还能用：落在 [WIN_MIN_W, WIN_MAX_W] 区间内才算合法，
// 高度始终按固定比例（WIN_H/WIN_W）跟着宽度换算，不单独存/单独校验
function isWidthValid(width) {
  return Number.isFinite(width) && width >= WIN_MIN_W && width <= WIN_MAX_W;
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

ipcMain.on('boot-done', () => {
  bootDone = true;
  bootReloads = 0; // 计数的是"连续失败"，成功一次就清零
  clearTimeout(bootTimer);
  startupLog('收到启动完成信号，看门狗已取消');
});
ipcMain.on('startup-log', (_e, msg) => startupLog('[页面] ' + String(msg).slice(0, 500)));
ipcMain.on('renderer-reload', (_e, reason) => {
  startupLog('[页面] 请求重载：' + String(reason).slice(0, 200));
  reloadMainWindow('页面请求：' + String(reason).slice(0, 100));
});

async function createWindow() {
  startupLog('createWindow 开始');
  // 旧版本留下的明文密钥升级成加密存储（系统不支持加密时什么也不做）
  migrateSecrets();
  const server = await startServer();
  const port = server.address().port;
  state.serverPort = port;
  startupLog(`静态服务已启动，端口 ${port}`);

  // 如果之前保存过 Gemini 轮询代理的 Key，启动时自动把本地中转服务起起来（只监听 127.0.0.1）
  // 优先复用上次记住的端口，避免每次开机 Base URL 都要重新填
  (() => {
    const cfgApi = getApiConfig();
    geminiRelay
      .setKeys(cfgApi.llmRelayKeys, cfgApi.llmRelayPort, ensureRelayToken())
      .then((status) => {
        if (status.port && status.port !== cfgApi.llmRelayPort) saveApiConfig({ llmRelayPort: status.port });
      })
      .catch((err) => {
        console.error('[pet] Gemini 轮询中转启动失败:', err);
      });
  })();

  state.characters = scanCharacters();
  const cfg = loadConfig();
  const savedIndex = state.characters.findIndex((c) => c.name === cfg.lastCharacter);
  state.currentIndex = savedIndex >= 0 ? savedIndex : 0;

  state.scenes = scanScenes();
  state.currentSceneName = state.scenes.some((s) => s.name === cfg.lastScene) ? cfg.lastScene : null;

  // 记住主窗口关闭前的位置：只在坐标仍落在当前屏幕范围内时采用，否则走默认居中
  const savedPos = cfg.winPosition;

  // 记住关闭前的大小：宽度合法就用，高度按固定比例跟着换算（跟拖拽缩放手柄时的算法保持一致）
  const savedSize = cfg.winSize;
  const useSavedSize = savedSize && isWidthValid(savedSize.width);
  const initW = useSavedSize ? Math.round(savedSize.width) : WIN_W;
  const initH = useSavedSize ? Math.round((initW * WIN_H) / WIN_W) : WIN_H;

  // 位置是否可用要结合窗口大小判断（看中间区域是否在屏幕内），所以放在大小算完之后
  const useSavedPos = savedPos && isPositionUsable(savedPos.x, savedPos.y, initW, initH);
  if (savedPos && !useSavedPos) {
    startupLog(`上次记的位置 (${savedPos.x}, ${savedPos.y}) 不在当前屏幕范围内，改用默认居中`);
  }

  // "正常模式"下窗口该在的位置/大小——不管这次是不是以桌面模式启动，都先算出来存好，
  // 退出桌面模式时要用它恢复
  const normalBounds = {
    ...(useSavedPos ? { x: Math.round(savedPos.x), y: Math.round(savedPos.y) } : {}),
    width: initW,
    height: initH,
  };

  // 背景鼠标互动：上次关闭时是什么状态，这次就从什么状态开始
  state.bgMouseInteraction = cfg.bgMouseInteraction !== false;

  // "LLM记录"/"开发者工具"菜单项：默认隐藏，上次在关于窗口里打开过才显示
  state.showDevEntries = cfg.showDevEntries === true;

  // 桌面模式下直接按桌面布局创建窗口（而不是先建正常小窗口再跳变），避免启动瞬间闪一下。
  // 布局算法跟运行中切换进入桌面模式共用 computeDesktopLayout：模型视口 = 普通窗口的位置/大小，
  // 窗口只在纵向展开。没有保存过位置时，普通窗口原本是交给系统居中的，但桌面布局需要确切坐标，
  // 这里按主屏工作区手动居中，效果一致，退出桌面模式时也恢复到这个位置
  if (!state.bgMouseInteraction && normalBounds.x === undefined) {
    const wa = screen.getPrimaryDisplay().workArea;
    normalBounds.x = Math.round(wa.x + (wa.width - normalBounds.width) / 2);
    normalBounds.y = Math.round(wa.y + (wa.height - normalBounds.height) / 2);
  }
  state.normalWinBounds = normalBounds;

  let createBounds = normalBounds;
  let initialDesktopViewport = null;
  if (!state.bgMouseInteraction) {
    const layout = computeDesktopLayout(normalBounds);
    createBounds = layout.bounds;
    initialDesktopViewport = layout.viewport;
  }

  state.win = new BrowserWindow({
    ...createBounds,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    webPreferences: securePrefs(),
  });
  // 用 'screen-saver' 层级而不是构造参数里的普通 alwaysOnTop:true——层级越高，
  // 越不容易在系统状态切换时被压到后面（见下面 reassertAlwaysOnTop 的注释）
  state.win.setAlwaysOnTop(true, 'screen-saver');
  if (!state.bgMouseInteraction) state.win.setIgnoreMouseEvents(true, { forward: true });

  // 拖动/缩放过程中和结束后都存位置（防抖）；用 move/resize 而不是 moved/resized，
  // 因为拖动是渲染进程通过 setPosition 驱动的，Windows 上 moved 只在系统自己的拖动循环结束时才触发
  state.win.on('move', scheduleSavePetBounds);
  state.win.on('resize', scheduleSavePetBounds);
  // Windows 关机/重启/注销：before-quit 不会触发，这里同步存一次
  state.win.on('session-end', savePetBounds);

  state.menu = buildMenu();

  // 禁用 Chromium 自带的 Ctrl+滚轮 / 捏合页面缩放（Ctrl+滚轮留给"背景前后移动"）
  try {
    Promise.resolve(state.win.webContents.setVisualZoomLevelLimits(1, 1)).catch(() => {});
  } catch {}

  state.win.loadURL(`http://127.0.0.1:${port}/public/index.html`);
  const wc = state.win.webContents;
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = 被新的导航取消，不算失败
    startupLog(`页面加载失败 code=${code} ${desc} ${url}`);
    reloadMainWindow(`页面加载失败 ${desc}`);
  });
  wc.on('render-process-gone', (_e, details) => {
    startupLog(`渲染进程退出 reason=${details.reason} exitCode=${details.exitCode}`);
    if (details.reason !== 'clean-exit') reloadMainWindow(`渲染进程退出 ${details.reason}`);
  });
  wc.on('unresponsive', () => startupLog('页面无响应'));
  app.on('child-process-gone', (_e, details) => {
    if (details.type === 'GPU') startupLog(`GPU 进程退出 reason=${details.reason}`);
  });
  wc.on('did-finish-load', () => {
    startupLog('页面 did-finish-load，下发 init 并启动看门狗');
    armBootWatchdog();
    send('init', {
      ...currentCharacterPayload(),
      scene: currentScene(),
      bgMouseInteraction: state.bgMouseInteraction,
      desktopViewport: initialDesktopViewport,
    });
  });
}

// 屏保退出 / 系统睡眠唤醒之后，Windows 会重新洗一遍所有窗口的层级(Z-order)，
// 无边框+透明+不进任务栏的窗口很容易在这次重排里被桌面/资源管理器盖到下面，
// 且不会自动恢复——所以这两个时机各重新置顶一次
function reassertAlwaysOnTop() {
  if (state.win && !state.win.isDestroyed()) state.win.setAlwaysOnTop(true, 'screen-saver');
}
powerMonitor.on('unlock-screen', reassertAlwaysOnTop); // 屏保退出 / 锁屏解锁
powerMonitor.on('resume', reassertAlwaysOnTop); // 系统从睡眠中唤醒
powerMonitor.on('shutdown', savePetBounds); // 关机/重启前再存一次（macOS/Linux；Windows 靠上面窗口的 session-end）

// 每次 LLM 调用完（对话回复 / 归档总结都算），把最新这一条实时推给"LLM调用记录"窗口；
// 窗口没开着时 llmLogWin 是 null/已销毁，这里直接跳过，等窗口下次打开时用 get-llm-log 兜底拿一次
setLlmLogListener((call) => {
  if (state.llmLogWin && !state.llmLogWin.isDestroyed()) {
    state.llmLogWin.webContents.send('llm-log-updated', call);
  }
});

// ---------- IPC ----------
// 模型刚出现在屏幕上（渲染进程通知）：算一次启动用时气泡。
// 「程序启动用时」= 从这个进程真正起跑（APP_PROCESS_START_MS）到模型出现，跟开机/登录/
// 手动打开的时机都无关，是真实的程序启动耗时，每次都算。
// 「开机用时」= 按电源 → 系统就绪：主板自检（UEFI 上报的 POST 耗时）+ 系统自统计的 BootTime
// （Diagnostics-Performance 事件 ID 100）。哪一段读不到就把起点/终点相应收窄（最窄为
// "内核启动 → 登录完成"），并在措辞上如实标注，只在"这场开机第一次启动本程序"时报一次。
ipcMain.on('model-ready', async () => {
  if (bootTimerReported) return;
  bootTimerReported = true;

  const now = Date.now();
  const programStartSec = (now - APP_PROCESS_START_MS) / 1000;
  // 开机时间点：优先用事件日志里的真实启动时间（快速启动下也准确）；
  // 读不到再退回 now - os.uptime()（快速启动下会偏早，后面有上限兜底）
  const eventBootAtMs = await getLatestBootEventTimeMs();
  const eventBootValid = eventBootAtMs != null && eventBootAtMs <= now;
  const bootAtMs = eventBootValid ? eventBootAtMs : now - os.uptime() * 1000;

  const cfg = loadConfig();
  const sameBoot = Number.isFinite(cfg.lastBootAtMs) && Math.abs(bootAtMs - cfg.lastBootAtMs) <= SAME_BOOT_TOLERANCE_MS;
  const alreadyShownThisBoot = sameBoot && cfg.bootIntroShown;

  if (alreadyShownThisBoot) {
    send('boot-timer-bubble', `你好啊~本次程序启动用时${formatBootDuration(programStartSec)}。`);
    return;
  }

  // 这场开机第一次启动：算"开机用时"
  // 主板自检（POST）耗时读得到时，计时起点提前到"按下电源"，并分段列出；
  // 系统段优先用系统自己统计的 BootTime（Diagnostics-Performance 事件 ID 100，系统启动到完全就绪）。
  // 但这条总结事件要等整场启动结束、系统趋于空闲后才写入日志（通常在开机后一两分钟），
  // 本程序随登录自启时大概率还没写好；它需要可靠的"本次启动时间点"做归属校验
  // （防止拿到上一次完整启动留下的旧记录），所以只在读到了启动事件时才走这条路。
  const postMs = await getFwPostTimeMs();
  if (eventBootValid) {
    let diagInfo = await getDiagnosticsBootInfo(bootAtMs, now);
    if (diagInfo != null) {
      // 开机很久后才手动打开程序的情况：事件早已写好，一声招呼报全两项
      send('boot-timer-bubble', `你好啊~${bootTimeText(postMs, diagInfo.bootTimeMs / 1000, '系统')}${startupSummaryText(diagInfo)}，程序启动用时${formatBootDuration(programStartSec)}。`);
      updateConfig({ lastBootAtMs: bootAtMs, bootIntroShown: true });
      return;
    }
    // 事件还没写：先打招呼（只报程序启动用时），后台等系统写完事件再补报开机用时
    send('boot-timer-bubble', `你好啊~程序启动用时${formatBootDuration(programStartSec)}。`);
    updateConfig({ lastBootAtMs: bootAtMs, bootIntroShown: true });
    diagInfo = await pollDiagnosticsBootInfo(bootAtMs);
    if (diagInfo != null) {
      send('boot-timer-bubble', `${bootTimeText(postMs, diagInfo.bootTimeMs / 1000, '系统')}${startupSummaryText(diagInfo)}。`);
      return;
    }
    // 轮询超时：退到下面的兜底口径，只补报兜底结果
  }

  // 兜底口径：系统自统计读不到（快速启动没有这条事件 / 权限不够 / 轮询超时），
  // 用"登录完成时间 − 开机时间"估算。注意它只量到"登录完成"，不含登录后系统
  // 后台就绪的那段（可能比真实开机耗时少十几秒），措辞上区分开。主板自检照样拼进去。
  const fallbackSec = await getLoginFallbackBootSec(bootAtMs, eventBootValid, now);
  let fallbackText;
  if (fallbackSec != null) {
    fallbackText = `${bootTimeText(postMs, fallbackSec, '系统到登录')}。`;
  } else if (postMs != null) {
    // 连登录时间都没读到：至少把读到的主板自检报出来
    fallbackText = `本次主板自检用时${formatBootDuration(postMs / 1000)}，系统耗时未能精确获取。`;
  } else {
    fallbackText = '本次开机用时未能精确获取。';
  }
  if (eventBootValid) {
    // 轮询超时后来到这里，第一声招呼已经打完，只补报兜底结果
    send('boot-timer-bubble', fallbackText);
  } else {
    // 连启动事件都没读到：招呼还没打，补上程序启动用时
    send('boot-timer-bubble', `你好啊~${fallbackText}程序启动用时${formatBootDuration(programStartSec)}。`);
  }
  updateConfig({ lastBootAtMs: bootAtMs, bootIntroShown: true });
});

// 所有显示器的工作区（已排除任务栏），供窗口位置限制使用
function getWorkAreas() {
  return screen.getAllDisplays().map((d) => d.workArea);
}

// ---- 关于窗口：读取信息 / 打开 GitHub / 连续点版本号切换开发者菜单项 ----
// 只响应关于窗口自己发来的请求（别的子窗口共用同一个 preload，不该能调用这些）
const fromAboutWin = (e) => state.aboutWin && !state.aboutWin.isDestroyed() && e.sender === state.aboutWin.webContents;
ipcMain.handle('get-about-info', (e) => (fromAboutWin(e) ? getAboutInfo() : null));
ipcMain.on('about-open-repo', (e) => {
  if (fromAboutWin(e)) openRepoUrl();
});
ipcMain.handle('about-toggle-dev-entries', (e) => (fromAboutWin(e) ? toggleDevEntries() : state.showDevEntries));

ipcMain.on('window-move', (_e, dx, dy) => {
  if (!state.win || state.win.isDestroyed() || state.bgMouseInteraction === false) return;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return; // 非数值会让 setPosition 抛异常
  // 位置限制：窗口中间一半的区域不能移出屏幕工作区（多显示器合并计算，详见 win-limit.js）；
  // 被限制住的那部分位移直接丢弃
  const cur = state.win.getBounds();
  const pos = constrainMove(cur, Math.round(dx), Math.round(dy), getWorkAreas());
  state.win.setPosition(pos.x, pos.y);
});

// 缩放：渲染进程只上报"鼠标相对按下时的水平位移"，尺寸和宽高比全部在这里算
ipcMain.on('window-resize-begin', () => {
  if (!state.win || state.win.isDestroyed() || state.bgMouseInteraction === false) return;
  state.resizeStartW = state.win.getBounds().width;
});

ipcMain.on('window-resize-by', (_e, dx) => {
  if (!state.win || state.win.isDestroyed() || state.bgMouseInteraction === false || !Number.isFinite(dx)) return;
  if (!(state.resizeStartW > 0)) return; // 没收到 begin（或窗口已销毁重建）时没有基准宽度，直接忽略
  const w = Math.max(WIN_MIN_W, Math.min(WIN_MAX_W, Math.round(state.resizeStartW + dx)));
  const h = Math.round((w * WIN_H) / WIN_W);
  // 缩放时左上角不动、向右下放大，窗口变大后中间区域可能被推出工作区，这里一并限制
  const cur = state.win.getBounds();
  const pos = constrainResize({ x: cur.x, y: cur.y, width: w, height: h }, getWorkAreas());
  state.win.setBounds({ x: pos.x, y: pos.y, width: w, height: h });
});

// 桌面模式下，渲染进程每次"是否悬停在模型/展开的对话框上"这个判定结果变化时上报一次
// （不是每帧都发，见 app.js 里的防抖），据此切换窗口是否穿透鼠标事件。
// 非桌面模式下这个开关本来就没打开，忽略即可，不需要额外判断。
// 子窗口正在被拖动/缩放时不立刻生效，只记下最新值、拖完再恢复（见 main-modules/drag-guard.js）。
ipcMain.on('set-click-through', (_e, ignore) => requestClickThrough(ignore));

ipcMain.on('scene-adjust-save', (_e, name, adj) => {
  if (typeof name !== 'string' || !state.scenes.some((s) => s.name === name)) return;
  setAdjust(name, normAdjust(adj));
});

ipcMain.on('show-menu', () => {
  if (state.menu && state.win) state.menu.popup({ window: state.win });
});

// 声音开关状态：渲染进程应用完静音后上报，菜单据此显示勾选（见 window.js 的"声音开关状态"注释）。
// 必须在 guardIpc 之后注册，才会经过来源校验
ipcMain.on('mute-changed', (_e, muted) => {
  state.muted = !!muted;
  state.menu = buildMenu();
});

// ---------- IPC：AI 对话 ----------
// 一次只能发一条：chat-send 开头上锁（chat-lock.js），LLM 回复且落盘/报错之后才解锁，
// 期间主界面和聊天记录窗口的发送都被禁用，同一角色的聊天记录也不允许编辑/插入/删除/清空。
// 这里只做 IPC 层（校验 / 上锁 / 解锁 / 推送）；一轮对话本身怎么跑（跨天总结 -> 存图 -> 拼 prompt ->
// 调 LLM -> 落盘 -> TTS）在 main-modules/chat-turn.js。

ipcMain.handle('chat-send', async (e, characterName, message, imageDataURL) => {
  if (typeof characterName !== 'string' || !state.characters.some((c) => c.name === characterName)) {
    throw new Error('未知角色');
  }
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text && !imageDataURL) throw new Error('消息不能为空');

  // === 上锁 ===
  // 已经有一条在等回复时 beginChat 会直接抛错，本次发送被拒绝（不影响正在进行的那一条）
  // 先判断要不要做跨天总结，锁一开始就带上对应阶段（同步、无 await，判断到上锁之间不会有别的改动插进来）
  const summaryPlan = planCrossDaySummary(characterName);
  const fromMainWindow = state.win && !state.win.isDestroyed() && e.sender === state.win.webContents;
  beginChat({
    character: characterName,
    source: fromMainWindow ? 'main' : 'history',
    user: text,
    imageDataURL,
    phase: summaryPlan ? 'summarizing' : 'waiting',
    summaryDay: summaryPlan ? summaryPlan.dayToSummarize : null, // 界面提示里要写具体是哪一天
  });

  // === 跑一轮对话，成功/失败都要解锁 ===
  let turn;
  try {
    turn = await runChatTurn(characterName, text, imageDataURL, summaryPlan);
  } catch (err) {
    endChat({ ok: false });
    throw err;
  }
  endChat({ ok: true, committed: turn.committed, startIndex: turn.startIndex });

  // 主窗口自己发起的对话，气泡由渲染进程本地展示（chat.js 里 chatSend 之后直接 showBubble）；
  // 聊天记录窗口发起的对话，额外把回复推给主宠物窗口头顶显示一下。
  // （聊天记录窗口里的消息不再靠这里推送：发出时的临时气泡、落盘后的正式消息，
  //  都由 chat-lock.js 的 chat-pending-changed / chat-settled 事件统一处理，两个窗口发起的对话走同一条路径）
  if (!fromMainWindow) send('show-bubble', turn.reply);

  return turn.reply;
});

// 渲染进程拿到的密钥一律是遮罩（••••abcd），真实密钥不离开主进程；
// 保存时原样传回遮罩 = 沿用原密钥（见 llm.js 的 resolveApiPatch）
ipcMain.handle('get-api-config', () => getApiConfigForRenderer());
ipcMain.handle('save-api-config', async (_e, patch) => {
  saveApiConfig(resolveApiPatch(patch && typeof patch === 'object' ? patch : {}));
  const next = getApiConfig();
  const relayStatus = await geminiRelay.setKeys(next.llmRelayKeys, next.llmRelayPort, ensureRelayToken()).catch((err) => {
    console.error('[pet] Gemini 轮询中转启动失败:', err);
    return geminiRelay.getStatus();
  });
  // 实际分配到的端口和记的不一样时（第一次生成 / 原端口被占用被迫换新的），更新记录，下次继续沿用
  if (relayStatus.port && relayStatus.port !== next.llmRelayPort) {
    saveApiConfig({ llmRelayPort: relayStatus.port });
  }
  return { ...getApiConfigForRenderer(), relayStatus };
});
// 删除设置窗口里"已保存的 API 地址"下拉中的一条，返回删除后的列表
ipcMain.handle('delete-api-profile', (_e, url) =>
  deleteApiProfile(typeof url === 'string' ? url : '').map((p) => ({ api_url: p.api_url, api_key: maskSecret(p.api_key) }))
);
ipcMain.handle('get-relay-status', () => geminiRelay.getStatus());
ipcMain.handle('get-prompt-config', () => getPromptConfig());
ipcMain.handle('save-prompt-config', (_e, patch) => savePromptConfig(patch && typeof patch === 'object' ? patch : {}));

// ---------- IPC：指定角色的设定（persona）编辑（角色与音色设置窗口用，按窗口打开的角色，不跟桌宠当前角色） ----------
// 返回该角色已填写的世界背景 / 角色资料 / 别名 / 你的资料（没填就是空字符串或空数组）
ipcMain.handle('get-persona', (_e, characterName) => {
  if (!validCharacter(characterName)) throw new Error('未知角色');
  const { system, storyBackground, aliases, readerInfo } = readPersonaFile(characterName);
  return {
    characterName,
    system,
    storyBackground,
    aliases,
    readerInfo,
  };
});
ipcMain.handle('save-persona', (_e, characterName, data) => {
  if (!validCharacter(characterName)) throw new Error('未知角色');
  const d = data && typeof data === 'object' ? data : {};
  savePersonaFile(characterName, {
    system: typeof d.system === 'string' ? d.system.trim() : '',
    storyBackground: typeof d.storyBackground === 'string' ? d.storyBackground.trim() : '',
    aliases: d.aliases, // 数组或分隔字符串，savePersonaFile 里统一清洗
    readerInfo: typeof d.readerInfo === 'string' ? d.readerInfo.trim() : '',
  });
  return true;
});
// ---------- IPC：指定角色的资产配置（角色资产配置窗口用，按窗口打开的角色，不跟桌宠当前角色） ----------
// 读取 / 保存都经过 assets-calc 的 sanitize，页面拿到和存进去的永远是整理过的合法数据
ipcMain.handle('get-assets', (_e, characterName) => {
  if (!validCharacter(characterName)) throw new Error('未知角色');
  return loadAssets(characterName, loadChatHistory(characterName)); // 推算到当前故事日期
});
ipcMain.handle('save-assets', (_e, characterName, data) => {
  if (!validCharacter(characterName)) throw new Error('未知角色');
  return saveAssetsFile(characterName, data && typeof data === 'object' ? data : {}, loadChatHistory(characterName));
});
// 聊天记录一写盘（新回复 / 编辑 / 删除 / 重新生成 / 清空）就把当前故事日期告诉已打开的资产配置窗口，
// 页面据此刷新推算后的数字（有未保存修改时只提示，不覆盖）
onChatHistorySaved((characterName, history) => {
  const w = state.assetsWin;
  if (!w || w.isDestroyed() || state.assetsWinCharacter !== characterName) return;
  w.webContents.send('assets-story-changed', currentStoryDate(history));
});
// 角色资产配置窗口：页面在浮层里确认"放弃修改并切换"后，主进程把窗口原地重载成目标角色
ipcMain.on('assets-switch-confirm', (_e, characterName) => {
  confirmAssetsSwitch(characterName);
});
// ---------- IPC：附加要求（memory index）编辑（API 与全局设置窗口用） ----------
// 附加要求 = 跨天总结时 AI 从元交流里自动提炼的长期设定/要求，这里允许用户手动增删改。全局共用一份，不区分角色。
ipcMain.handle('get-memory-index', () => ({ text: loadMemoryIndex(), maxChars: MEMORY_MAX_CHARS }));
ipcMain.handle('save-memory-index', (_e, text) => {
  // 任何角色正在等回复 / 做跨天总结时，总结那次调用可能马上要往这份附加要求里追加，此时手动保存会互相覆盖，直接拦下
  assertGlobalMemoryEditable();
  saveMemoryIndexManual(text);
  return true;
});
ipcMain.handle('fetch-model-list', (_e, apiUrl, apiKey) => {
  const url = typeof apiUrl === 'string' ? apiUrl : '';
  return fetchModelList(url, resolveApiKeyForUrl(url, typeof apiKey === 'string' ? apiKey : ''));
});
// 窗口刚打开时查一下当前有没有在等回复的对话（之后的变化走 chat-pending-changed 推送）
ipcMain.handle('get-chat-pending', () => getChatPending());
ipcMain.handle('get-chat-history', (_e, characterName) => {
  if (typeof characterName !== 'string') return [];
  return loadChatHistory(characterName).map((m) => ({
    ...m,
    // assistant 消息存盘时末尾拼了 <story_overview> 摘要块（给轮次压缩用），聊天记录窗口只是给人看的，
    // 这个标签用户不需要看到——只处理这个接口的返回值，磁盘上的历史文件本身不受影响
    // 说话者前缀（多角色语音用）也只在显示时摘掉，存档里保留
    content: m.role === 'assistant' ? stripSpeakers(splitTurnSummary(m.content).body) : m.content,
    // 编辑框用的完整原文（带说话者前缀 + 末尾的摘要块）：气泡显示摘了这些，编辑时要看到存档里的真实内容
    rawContent: m.content,
    // AI 消息的故事时间（取自被剥掉的那个摘要块），记录窗口拿去在气泡末尾打标签；摘要里没有就是空串，不显示
    storyTime: m.role === 'assistant' ? extractStoryTime(m.content) : '',
    // 摘要的"概述"部分：平时不显示，只在编辑 AI 消息时和故事时间一起出现在两个摘要输入框里
    summaryOverview: m.role === 'assistant' ? extractOverview(m.content) : '',
    // 图片消息附带 dataURL 供记录窗口直接渲染缩略图；文件丢了就当纯文字消息
    imageDataURL: m.image ? readChatImageDataURL(characterName, m.image) : undefined,
  }));
});
// 聊天记录窗口双击 AI 气泡重听：按消息的 ts 取缓存的回复语音，没有（没调用过 TTS / 老消息）返回 null
ipcMain.handle('get-chat-voice', (_e, characterName, ts) => {
  if (!validCharacter(characterName)) return null;
  return readChatVoice(characterName, ts);
});
ipcMain.on('open-history-window', (_e, characterName) => {
  if (typeof characterName === 'string') openHistoryWindow(characterName);
});
// 角色与音色设置窗口：页面在浮层里确认"放弃修改并切换"后，主进程把窗口原地重载成目标角色
ipcMain.on('character-voice-switch-confirm', (_e, characterName) => {
  confirmCharacterVoiceSwitch(characterName);
});
// LLM 调用记录窗口打开时，用这个拿一次"当前已有的最新一条"（窗口开着之后的新记录走上面的实时推送）
ipcMain.handle('get-llm-log', () => getLatestLlmCall());

// ---------- IPC：语音合成（角色与音色设置窗口的音色设置区用） ----------
// 密钥是各角色共用的，音色参数按角色分开存；试听用表单当前值，不要求先保存
ipcMain.handle('tts-get-config', (_e, characterName) => {
  if (!validCharacter(characterName)) throw new Error('未知角色');
  const cfg = getTtsConfig(characterName);
  return { characterName, ...cfg, providers: maskProviders(cfg.providers), presets: getPresets() };
});
ipcMain.handle('tts-save-config', (_e, characterName, payload) => {
  if (!validCharacter(characterName)) throw new Error('未知角色');
  const p = payload && typeof payload === 'object' ? payload : {};
  // 表单里原样传回的遮罩密钥要还原成已存的真实密钥
  const saved = saveTtsConfig(characterName, { ...p, providers: p.providers ? resolveProvidersInput(p.providers) : undefined });
  return { ...saved, providers: maskProviders(saved.providers) };
});
ipcMain.handle('tts-test', (_e, characterName, payload, text) => {
  if (!validCharacter(characterName)) throw new Error('未知角色');
  const p = payload && typeof payload === 'object' ? payload : {};
  return testVoice({ ...p, providers: resolveProvidersInput(p.providers) }, typeof text === 'string' ? text : '');
});
// MiMo 音色复刻：弹系统文件选择框，选中的参考音频复制进用户数据目录，返回元信息给设置窗口
ipcMain.handle('tts-pick-clone-audio', async (e, characterName) => {
  if (!validCharacter(characterName)) throw new Error('未知角色');
  const parent = BrowserWindow.fromWebContents(e.sender);
  const opts = {
    title: '选择音色复刻的参考音频',
    properties: ['openFile'],
    filters: [{ name: '音频文件', extensions: AUDIO_EXTENSIONS }],
  };
  const r = await (parent ? dialog.showOpenDialog(parent, opts) : dialog.showOpenDialog(opts));
  if (r.canceled || !r.filePaths.length) return null;
  return importCloneAudio(characterName, r.filePaths[0]);
});

// 豆包预置音色：导入（整体覆盖替换生效列表）/ 导出（当前生效列表存成 json）/ 恢复默认（回落到内置列表）
ipcMain.handle('tts-doubao-voices-import', async (e) => {
  const parent = BrowserWindow.fromWebContents(e.sender);
  const opts = {
    title: '导入豆包预置音色',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  };
  const r = await (parent ? dialog.showOpenDialog(parent, opts) : dialog.showOpenDialog(opts));
  if (r.canceled || !r.filePaths.length) return null;
  return doubaoVoicesStore.importVoices(r.filePaths[0]);
});
ipcMain.handle('tts-doubao-voices-export', async (e) => {
  const parent = BrowserWindow.fromWebContents(e.sender);
  const opts = {
    title: '导出豆包预置音色',
    defaultPath: 'doubao-voices.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  };
  const r = await (parent ? dialog.showSaveDialog(parent, opts) : dialog.showSaveDialog(opts));
  if (r.canceled || !r.filePath) return null;
  doubaoVoicesStore.exportVoices(r.filePath);
  return r.filePath;
});
ipcMain.handle('tts-doubao-voices-reset', () => doubaoVoicesStore.resetVoices());

// ---------- IPC：语音识别（ASR，点击🎙说话用）----------
// sessionId -> 会话句柄；按 sender 隔离，主窗口和聊天记录窗口各自独立调用互不干扰
const asrSessions = new Map();

ipcMain.handle('asr-start', (e) => {
  const cfg = getAsrConfig();
  if (!cfg.appId || !cfg.accessKey) {
    throw new Error('尚未配置豆包的 App ID / Access Key，请先在"角色与音色设置"的音色设置里填好（语音识别复用这套凭据）');
  }
  const sessionId = crypto.randomUUID();
  const sender = e.sender;
  const session = createAsrSession({
    appId: cfg.appId,
    accessKey: cfg.accessKey,
    resourceId: cfg.resourceId,
    onPartial: (text) => {
      if (!sender.isDestroyed()) sender.send('asr-partial', sessionId, text);
    },
    onFinal: (text) => {
      asrSessions.delete(sessionId);
      if (!sender.isDestroyed()) sender.send('asr-final', sessionId, text);
    },
    onError: (err) => {
      asrSessions.delete(sessionId);
      if (!sender.isDestroyed()) sender.send('asr-error', sessionId, err.message || String(err));
    },
  });
  asrSessions.set(sessionId, session);
  return sessionId;
});

// 高频小包，走 send 不走 invoke（不需要每帧等一次往返）
ipcMain.on('asr-audio-chunk', (_e, sessionId, chunk) => {
  const session = asrSessions.get(sessionId);
  if (!session || !chunk) return;
  session.sendAudio(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
});

ipcMain.handle('asr-stop', (_e, sessionId) => {
  const session = asrSessions.get(sessionId);
  if (session) session.finish();
  return true;
});

ipcMain.handle('asr-get-config', () => ({ resourceId: getAsrConfig().resourceId }));
ipcMain.handle('asr-save-config', (_e, patch) => saveAsrConfig(patch && typeof patch === 'object' ? patch : {}));

// ---------- IPC：聊天记录的编辑 / 添加 / 删除 / 清空（聊天记录窗口用） ----------
// 和 chat-send 一样校验角色名（防路径注入），内容按索引定位——history.html 渲染顺序就是数组顺序。
function validCharacter(characterName) {
  return typeof characterName === 'string' && isSafeName(characterName) && state.characters.some((c) => c.name === characterName);
}

// 编辑消息。AI 消息的 content 是"完整原文"：正文 + 末尾的 <story_overview> 摘要块（和存档里的格式一致，编辑框里直接显示，
// 摘要不再单独拆成输入框）。保存时在这里校验摘要块：
//   · 没有摘要块 = 去掉摘要，这一轮在历史里发原文、不压缩（和以前"两项都留空"一致）
//   · 有摘要块就必须成对、只有一个、在末尾，且里面至少有"故事时间:"或"概述:"一行有内容；块里完全是空的就当去掉摘要
// 返回 { display, raw, storyTime }：气泡该显示的文字（AI 消息摘掉说话者前缀）、编辑框下次要显示的原文、故事时间标签
ipcMain.handle('edit-chat-message', (_e, characterName, index, content) => {
  if (!validCharacter(characterName)) throw new Error('未知角色');
  assertHistoryEditable(characterName); // 正在等这个角色的回复时不允许改记录
  if (!Number.isInteger(index) || index < 0) throw new Error('无效的消息索引');
  const text = typeof content === 'string' ? content.trim() : '';
  if (!text) throw new Error('消息不能为空');

  const history = loadChatHistory(characterName);
  if (index >= history.length) throw new Error('无效的消息索引');
  const target = history[index];
  if (target.role === 'assistant') {
    const opens = (text.match(/<story_overview>/g) || []).length;
    const closes = (text.match(/<\/story_overview>/g) || []).length;
    let body = text;
    let block = '';
    if (opens || closes) {
      const sp = splitTurnSummary(text);
      if (opens !== 1 || closes !== 1 || !sp.summaryBlock) throw new Error('摘要块格式不对：<story_overview> 和 </story_overview> 必须成对出现，且只能有一个');
      if (!text.endsWith('</story_overview>')) throw new Error('摘要块必须放在消息的最末尾');
      body = sp.body;
      const inner = sp.summaryBlock.replace(/^<story_overview>|<\/story_overview>$/g, '').trim();
      if (inner) {
        const t = extractStoryTime(sp.summaryBlock);
        const o = extractOverview(sp.summaryBlock);
        if (!t && !o) throw new Error('摘要块里要写"故事时间: …"或"概述: …"（至少一行有内容），不需要摘要就整块删掉');
        block = sp.summaryBlock;
      }
    }
    if (!body) throw new Error('正文不能为空');
    target.content = block ? `${body}\n${block}` : body;
  } else {
    target.content = text;
  }
  saveChatHistory(characterName, history);
  if (target.role === 'assistant') {
    const sp = splitTurnSummary(target.content);
    return { display: stripSpeakers(sp.body), raw: target.content, storyTime: extractStoryTime(target.content), overview: extractOverview(target.content) };
  }
  return { display: text, raw: text, storyTime: '', overview: '' };
});

ipcMain.handle('add-chat-message', (_e, characterName, role, content) => {
  if (!validCharacter(characterName)) throw new Error('未知角色');
  assertHistoryEditable(characterName); // 正在等这个角色的回复时不允许改记录
  if (role !== 'user' && role !== 'assistant') throw new Error('无效的消息身份');
  const text = typeof content === 'string' ? content.trim() : '';
  if (!text) throw new Error('消息不能为空');

  const history = loadChatHistory(characterName);
  const msg = { role, content: text, ts: Date.now() };
  history.push(msg);
  saveChatHistory(characterName, history);
  return msg;
});

ipcMain.handle('delete-chat-message', (_e, characterName, index) => {
  if (!validCharacter(characterName)) throw new Error('未知角色');
  assertHistoryEditable(characterName); // 正在等这个角色的回复时不允许改记录
  if (!Number.isInteger(index) || index < 0) throw new Error('无效的消息索引');

  const history = loadChatHistory(characterName);
  if (index >= history.length) throw new Error('无效的消息索引');
  const removed = history.splice(index, 1)[0];
  saveChatHistory(characterName, history); // 先落盘，成功后再删图片/语音文件，避免记录还在、附件却没了
  if (removed && removed.image) deleteChatImage(characterName, removed.image); // 图片文件跟着删
  if (removed) deleteChatVoice(characterName, removed.ts); // 回复语音也跟着删
  return true;
});

// 批量删除：删掉 fromIndex 起（含）到末尾的所有消息，一次读盘、一次落盘（"重新生成"用）。
// 图片文件跟着删；校验放在删除之前，出错不会删一半。
ipcMain.handle('truncate-chat-history', (_e, characterName, fromIndex) => {
  if (!validCharacter(characterName)) throw new Error('未知角色');
  assertHistoryEditable(characterName); // 正在等这个角色的回复时不允许改记录
  if (!Number.isInteger(fromIndex) || fromIndex < 0) throw new Error('无效的消息索引');

  const history = loadChatHistory(characterName);
  if (fromIndex >= history.length) throw new Error('无效的消息索引');
  const removed = history.splice(fromIndex);
  saveChatHistory(characterName, history); // 先落盘，成功后再删图片文件，避免记录还在图片却没了
  for (const m of removed) {
    if (!m) continue;
    if (m.image) deleteChatImage(characterName, m.image);
    deleteChatVoice(characterName, m.ts); // 回复语音跟着删
  }
  return removed.length;
});

// 聊天记录导出 / 导入（文件格式和校验见 chat-transfer.js）。取消选择文件返回 null
ipcMain.handle('export-chat-history', async (e, characterName) => {
  if (!validCharacter(characterName)) throw new Error('未知角色');
  const parent = BrowserWindow.fromWebContents(e.sender);
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const opts = {
    title: '记录导出',
    defaultPath: `${characterName}-聊天记录-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  };
  const r = await (parent ? dialog.showSaveDialog(parent, opts) : dialog.showSaveDialog(opts));
  if (r.canceled || !r.filePath) return null;
  return { filePath: r.filePath, count: exportToFile(characterName, r.filePath) };
});

ipcMain.handle('import-chat-history', async (e, characterName) => {
  if (!validCharacter(characterName)) throw new Error('未知角色');
  assertHistoryEditable(characterName); // 正在等这个角色的回复时不允许改记录
  const parent = BrowserWindow.fromWebContents(e.sender);
  const opts = {
    title: '记录导入（会覆盖当前记录）',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  };
  const r = await (parent ? dialog.showOpenDialog(parent, opts) : dialog.showOpenDialog(opts));
  if (r.canceled || !r.filePaths.length) return null;
  assertHistoryEditable(characterName); // 选文件期间可能刚好发出了新消息，落盘前再查一次
  return importFromFile(characterName, r.filePaths[0]);
});

ipcMain.handle('clear-chat-history', (_e, characterName) => {
  if (!validCharacter(characterName)) throw new Error('未知角色');
  assertHistoryEditable(characterName); // 正在等这个角色的回复时不允许改记录
  saveChatHistory(characterName, []);
  clearChatImages(characterName); // 图片文件夹整个清掉
  clearChatVoices(characterName); // 回复语音文件夹也整个清掉
  clearDaySummaries(characterName); // 按天总结缓存也一起清掉
  clearOpenedDay(characterName); // 当前打开的封印包也跟着清掉，避免指向已经不存在的历史
  return true;
});

app.whenReady().then(() => {
  if (gotLock) {
    initStartupLog(APP_PROCESS_START_MS);
    startupLog('app ready');
    migrateAutoLaunch();
    createWindow().catch((err) => startupLog('createWindow 出错: ' + (err && err.stack ? err.stack : err)));
  }
});
app.on('window-all-closed', () => app.quit());

// 退出前记住主窗口位置，下次启动原样恢复；随后强制销毁窗口，防止渲染进程卡住
// （WebGL 资源释放慢）拖着整个进程退不干净。注意：任务管理器强杀/断电这类非正常退出不会走到这里，
// 那种情况下位置就不会更新，这是可以接受的取舍。
// 桌面模式下真实窗口的位置/大小是被临时纵向展开的那一份，不是用户认知里
// "普通模式窗口"该在的地方——这时候不能存窗口当前的实际 bounds，要存 state.normalWinBounds
// （切换进桌面模式前记下的那份快照），不然下次启动或者切回普通模式时就会用错位置。
app.on('before-quit', () => {
  geminiRelay.stopRelay();
  clearTimeout(saveBoundsTimer);
  if (state.win && !state.win.isDestroyed()) {
    savePetBounds();
    state.win.destroy();
  }
});
