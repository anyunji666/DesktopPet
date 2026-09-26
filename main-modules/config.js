// ---------- 配置持久化（记住上次选择的角色 / 场景，及 API / Prompt 配置） ----------
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

let configPathCache = null;
function getConfigPath() {
  if (!configPathCache) configPathCache = path.join(app.getPath('userData'), 'config.json');
  return configPathCache;
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));
  } catch {
    return {};
  }
}

// 合并写入：角色和场景各自更新自己的字段，互不覆盖
function updateConfig(patch) {
  try {
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ ...loadConfig(), ...patch }, null, 2));
  } catch (err) {
    console.error('[pet] 保存配置失败:', err);
  }
}

module.exports = { getConfigPath, loadConfig, updateConfig };
