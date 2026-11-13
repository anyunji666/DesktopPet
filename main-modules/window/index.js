// ---------- 窗口领域入口：只做装配与再导出（main.js 仍 require('./main-modules/window')）----------
// 子模块之间不互相 require：右键菜单点某项要调的动作（切角色 / 切场景 / 进出桌面模式 / 各设置窗口 / 开关类）
// 在这里一次性注入给 menu-actions.js；谁改了要在菜单上体现的状态，调 menu-actions.js 的 rebuildMenu() 重建菜单。
// 依赖方向：menu-actions / root / main-window / secure-prefs 是底层；settings-windows、desktop-mode、auto-launch、
// drink-reminder、menu 只依赖底层；switch 额外单向依赖 settings-windows（切角色时让已打开的聊天记录窗口原地换角色）；
// 本文件在最后把它们接起来，整张图没有反向依赖。
const { setMenuActions, setMenuBuilder } = require('./menu-actions');
const { securePrefs } = require('./secure-prefs');
const { WIN_W, WIN_H, WIN_MIN_W, WIN_MAX_W, send, currentCharacterPayload, currentScene } = require('./main-window');
const {
  openSettingsWindow,
  openCharacterVoiceWindow,
  confirmCharacterVoiceSwitch,
  openOutfitsWindow,
  confirmOutfitsSwitch,
  openAssetsWindow,
  confirmAssetsSwitch,
  openHistoryWindow,
  openAboutWindow,
  openLlmLogWindow,
  getAboutInfo,
  openRepoUrl,
  toggleDevEntries,
} = require('./settings-windows');
const { computeDesktopLayout, enterDesktopMode, exitDesktopMode, toggleBgMouseInteraction } = require('./desktop-mode');
const { switchCharacter, switchScene, resetSceneAdjust, reloadScenes } = require('./switch');
const { getAutoLaunchMode, migrateAutoLaunch, applyAutoLaunchMode } = require('./auto-launch');
const { drinkReminderOn, setDrinkReminderEnabled } = require('./drink-reminder');
const { buildMenu } = require('./menu');

// 菜单项点击时要调的动作（menu.js 只按名字取用）
setMenuActions({
  switchCharacter,
  switchScene,
  resetSceneAdjust,
  reloadScenes,
  toggleBgMouseInteraction,
  openSettingsWindow,
  openCharacterVoiceWindow,
  openOutfitsWindow,
  openAssetsWindow,
  openAboutWindow,
  openLlmLogWindow,
  getAutoLaunchMode,
  applyAutoLaunchMode,
  drinkReminderOn,
  setDrinkReminderEnabled,
});

// 菜单构建器：各领域模块改完状态后调 rebuildMenu()，由它重建并写回 state.menu
setMenuBuilder(buildMenu);

module.exports = {
  securePrefs,
  WIN_W,
  WIN_H,
  WIN_MIN_W,
  WIN_MAX_W,
  computeDesktopLayout,
  enterDesktopMode,
  exitDesktopMode,
  toggleBgMouseInteraction,
  openSettingsWindow,
  openCharacterVoiceWindow,
  confirmCharacterVoiceSwitch,
  openOutfitsWindow,
  confirmOutfitsSwitch,
  openAssetsWindow,
  confirmAssetsSwitch,
  openHistoryWindow,
  openLlmLogWindow,
  openAboutWindow,
  getAboutInfo,
  openRepoUrl,
  toggleDevEntries,
  send,
  currentCharacterPayload,
  currentScene,
  buildMenu,
  switchCharacter,
  switchScene,
  resetSceneAdjust,
  reloadScenes,
  getAutoLaunchMode,
  migrateAutoLaunch,
};
