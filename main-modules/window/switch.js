// ---------- 角色 / 场景切换 ----------
// 都只改 state + 写 config.json，然后把新数据推给渲染进程；已打开的聊天记录窗口跟着原地换角色。
const { state } = require('../state');
const { updateConfig } = require('../config');
const { scanScenes, setAdjust, ADJUST_DEFAULT } = require('../scene');
const { cancelSpeaking } = require('../tts');
const { send, currentCharacterPayload, currentScene } = require('./main-window');
const { retargetHistoryWindow } = require('./settings-windows');
const { rebuildMenu } = require('./menu-actions');

function switchCharacter(index) {
  if (index === state.currentIndex || !state.characters[index]) return;
  state.currentIndex = index;
  updateConfig({ lastCharacter: state.characters[state.currentIndex].name });
  rebuildMenu();
  cancelSpeaking(); // 旧角色还在合成的语音作废，不然会用旧角色的声音说话
  retargetHistoryWindow(state.characters[index].name); // 已打开的聊天记录窗口跟着换成新角色
  send('switch-character', currentCharacterPayload());
}

// name 为 null 表示切回"无场景"
function switchScene(name) {
  const target = name === null ? null : state.scenes.find((s) => s.name === name);
  if (name !== null && !target) return;
  if ((target ? target.name : null) === state.currentSceneName) return;
  state.currentSceneName = target ? target.name : null;
  updateConfig({ lastScene: state.currentSceneName });
  rebuildMenu();
  send('switch-scene', target);
}

function resetSceneAdjust() {
  if (state.currentSceneName === null) return;
  setAdjust(state.currentSceneName, { ...ADJUST_DEFAULT });
  send('scene-adjust', { ...ADJUST_DEFAULT });
}

// 重新扫描 Scene 目录并重新载入当前场景：调 scene.json 参数时不用重启程序
function reloadScenes() {
  const before = state.currentSceneName;
  state.scenes = scanScenes();
  if (state.currentSceneName && !state.scenes.some((s) => s.name === state.currentSceneName)) {
    state.currentSceneName = null;
    updateConfig({ lastScene: null });
  }
  rebuildMenu();
  if (before || state.currentSceneName) send('switch-scene', currentScene());
}

module.exports = { switchCharacter, switchScene, resetSceneAdjust, reloadScenes };
