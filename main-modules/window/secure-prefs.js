// ---------- 所有窗口共用的 webPreferences ----------
const path = require('path');
const { ROOT } = require('./root');

// 所有窗口共用的 webPreferences：
//   sandbox        —— 渲染进程沙箱化（preload 只用了 contextBridge / ipcRenderer，沙箱下可用）
//   nodeIntegration—— 页面里绝不能直接用 Node
//   webviewTag     —— 用不到 <webview>，关掉
function securePrefs() {
  return {
    preload: path.join(ROOT, 'preload.js'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
  };
}

module.exports = { securePrefs };
