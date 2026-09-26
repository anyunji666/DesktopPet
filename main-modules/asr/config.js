// ---------- 豆包"流式语音识别大模型"配置 ----------
// 密钥复用 tts/config.js 里 providers.doubao 的 App ID / Access Key（同一个火山引擎账号）；
// 这里只单独存一个 Resource-Id（ASR 和 TTS 的 Resource-Id 不是一回事，版本也可能不止一种，
// 具体取值需要用户去火山引擎控制台的接入文档确认，这里只给一个最常见的占位默认值）。
const { loadConfig, updateConfig } = require('../config');
const { normalizeProviders } = require('../tts/config');

const DEFAULT_RESOURCE_ID = 'volc.bigasr.sauc.duration'; // 小时版最常见的取值，不保证适配所有账号，见设置界面提示

function getAsrConfig() {
  const c = loadConfig();
  const asr = c.asrConfig && typeof c.asrConfig === 'object' ? c.asrConfig : {};
  const doubao = normalizeProviders(c.ttsConfig && c.ttsConfig.providers).doubao;
  const resourceId = typeof asr.resourceId === 'string' && asr.resourceId.trim() ? asr.resourceId.trim() : DEFAULT_RESOURCE_ID;
  return { appId: doubao.app_id, accessKey: doubao.access_key, resourceId };
}

function saveAsrConfig(patch) {
  const resourceId = patch && typeof patch.resourceId === 'string' ? patch.resourceId.trim() : '';
  updateConfig({ asrConfig: { resourceId: resourceId || DEFAULT_RESOURCE_ID } });
  return getAsrConfig();
}

module.exports = { getAsrConfig, saveAsrConfig, DEFAULT_RESOURCE_ID };
