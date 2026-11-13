// ---------- 喝水提醒开关（右键菜单里那一格）----------
// 喝水提醒读 Character/<角色>/Time report/ 下的语音（没有该目录的角色不提醒），
// 只在有语音的时间点提醒（不是每个整点都有）；开关状态记在 config.json，重启后保持。
const { loadConfig, updateConfig } = require('../config');
const { send } = require('./main-window');
const { rebuildMenu } = require('./menu-actions');

function drinkReminderOn() {
  return loadConfig().drinkReminderEnabled !== false;
}

function setDrinkReminderEnabled(enabled) {
  updateConfig({ drinkReminderEnabled: !!enabled });
  rebuildMenu();
  send('drink-reminder-enabled', !!enabled);
}

module.exports = { drinkReminderOn, setDrinkReminderEnabled };
