// ---------- 主窗口：尺寸常量 / 向渲染进程下发消息 / 当前角色与场景数据 ----------
const { state } = require('../state');
const { loadConfig } = require('../config');
const { loadQuotes, loadVoices, loadDrinkReminders, loadMaterialFixes, loadLights, loadPhysicsTweaks } = require('../character');
const { scanDances } = require('../dance');
const { getAdjust } = require('../scene');

// 窗口初始尺寸；右下角缩放手柄始终按这个宽高比缩放（由主进程计算，
// 不依赖页面自己的 innerWidth/innerHeight，避免 DevTools 停靠等情况把比例带偏）
const WIN_W = 720;
const WIN_H = 540;
const WIN_MIN_W = 320;
const WIN_MAX_W = 1800;

function send(channel, payload) {
  if (state.win && !state.win.isDestroyed()) state.win.webContents.send(channel, payload);
}

function currentCharacterPayload() {
  const c = state.characters[state.currentIndex];
  const q = loadQuotes(c.name);
  return {
    model: c.model,
    dances: scanDances(),
    characterName: c.name,
    quotes: q.lines,
    voices: loadVoices(c.name, q.lines),
    drinkReminders: loadDrinkReminders(c.name),
    drinkReminderEnabled: loadConfig().drinkReminderEnabled !== false,
    bubbleColor: q.color,
    materialFixes: loadMaterialFixes(c.name),
    lights: loadLights(c.name),
    physicsTweaks: loadPhysicsTweaks(c.name),
  };
}

// 发给渲染进程的场景数据 = 扫描结果 + 用户手动调整
function currentScene() {
  const s = state.scenes.find((x) => x.name === state.currentSceneName);
  return s ? { ...s, adjust: getAdjust(s.name) } : null;
}

module.exports = { WIN_W, WIN_H, WIN_MIN_W, WIN_MAX_W, send, currentCharacterPayload, currentScene };
