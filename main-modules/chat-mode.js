// ---------- 聊天模式：故事模式 / 对话模式（按角色各自记住） ----------
// 故事模式（默认，老用户行为不变）：AI 扮演角色和其他人物、一起编故事，提示词带服饰 / 资产配置，
//   每轮回复末尾要求写 <story_overview> 摘要块（故事时间 + 概述），历史按摘要压缩；
// 对话模式：就是和角色聊天——不要求 AI 编故事，提示词不带服饰 / 资产配置，不要求写每轮摘要块
//   （历史原文直接发，不做轮次压缩），时间只用现实时间；每日总结照常生成。
// 存进 config.json 的 chatModes 字段：{ [角色名]: 'story' | 'chat' }，没记录的角色就是故事模式。
const { loadConfig, updateConfig } = require('./config');

const CHAT_MODES = ['story', 'chat'];
const DEFAULT_CHAT_MODE = 'story';

function getChatMode(characterName) {
  const modes = loadConfig().chatModes;
  const m = modes && typeof modes === 'object' ? modes[characterName] : null;
  return CHAT_MODES.includes(m) ? m : DEFAULT_CHAT_MODE;
}

// 保存并返回生效的模式；传入非法值抛错（不静默回退，避免界面显示和实际不一致）
function setChatMode(characterName, mode) {
  if (!CHAT_MODES.includes(mode)) throw new Error('无效的聊天模式');
  const cur = loadConfig().chatModes;
  const next = { ...(cur && typeof cur === 'object' ? cur : {}) };
  if (mode === DEFAULT_CHAT_MODE) delete next[characterName]; // 默认值不占配置
  else next[characterName] = mode;
  updateConfig({ chatModes: next });
  return mode;
}

module.exports = { CHAT_MODES, DEFAULT_CHAT_MODE, getChatMode, setChatMode };
