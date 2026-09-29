// ---------- 配置持久化（记住上次选择的角色 / 场景，及 API / Prompt 配置） ----------
// 密钥类字段（API Key、中转 Key、中转 token、语音服务密钥）写盘前用 Electron safeStorage 加密
// （Windows 走 DPAPI、macOS 走钥匙串、Linux 走 libsecret/kwallet），读盘时自动解密，
// 所以除本文件外的代码看到的永远是明文，不用关心加密细节。
// 系统不支持加密时（比如 Linux 没有钥匙串）退回明文存储，行为和以前一致。
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

let configPathCache = null;
function getConfigPath() {
  if (!configPathCache) configPathCache = path.join(app.getPath('userData'), 'config.json');
  return configPathCache;
}

// ---------- 密钥加解密 ----------
const ENC_PREFIX = 'enc:v1:';

function canEncrypt() {
  try {
    if (!app.isReady() || !safeStorage.isEncryptionAvailable()) return false;
    // Linux 没有可用钥匙串时 Electron 会退回 basic_text（等于没加密），这种情况不假装安全
    if (process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function') {
      if (safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
    }
    return true;
  } catch {
    return false;
  }
}

function encryptValue(v) {
  if (typeof v !== 'string' || !v || v.startsWith(ENC_PREFIX)) return v;
  return ENC_PREFIX + safeStorage.encryptString(v).toString('base64');
}

function decryptValue(v) {
  if (typeof v !== 'string' || !v.startsWith(ENC_PREFIX)) return v; // 旧版明文，原样返回，下次写盘时自动加密
  try {
    return safeStorage.decryptString(Buffer.from(v.slice(ENC_PREFIX.length), 'base64'));
  } catch (err) {
    console.warn('[pet] 密钥解密失败（可能换了电脑 / 系统账号），已当作未设置:', err && err.message ? err.message : err);
    return '';
  }
}

// 对配置里所有密钥字段套用 fn，返回新对象（不改传入的）
function mapSecrets(cfg, fn) {
  const out = { ...cfg };

  if (out.apiConfig && typeof out.apiConfig === 'object') {
    const a = { ...out.apiConfig };
    if (typeof a.api_key === 'string') a.api_key = fn(a.api_key);
    if (typeof a.relayToken === 'string') a.relayToken = fn(a.relayToken);
    if (Array.isArray(a.llmRelayKeys)) a.llmRelayKeys = a.llmRelayKeys.map((k) => (typeof k === 'string' ? fn(k) : k));
    if (Array.isArray(a.apiProfiles)) {
      a.apiProfiles = a.apiProfiles.map((p) => (p && typeof p.api_key === 'string' ? { ...p, api_key: fn(p.api_key) } : p));
    }
    out.apiConfig = a;
  }

  const providers = out.ttsConfig && typeof out.ttsConfig === 'object' ? out.ttsConfig.providers : null;
  if (providers && typeof providers === 'object') {
    const pv = { ...providers };
    if (pv.doubao && typeof pv.doubao.access_key === 'string') pv.doubao = { ...pv.doubao, access_key: fn(pv.doubao.access_key) };
    if (pv.mimo && typeof pv.mimo.api_key === 'string') pv.mimo = { ...pv.mimo, api_key: fn(pv.mimo.api_key) };
    out.ttsConfig = { ...out.ttsConfig, providers: pv };
  }
  return out;
}

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));
    return mapSecrets(raw, decryptValue);
  } catch {
    return {};
  }
}

// 合并写入：角色和场景各自更新自己的字段，互不覆盖
function updateConfig(patch) {
  try {
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    let next = { ...loadConfig(), ...patch };
    if (canEncrypt()) next = mapSecrets(next, encryptValue);
    // 先写临时文件再改名：写到一半断电 / 崩溃时不会留下半截的 config.json（连带丢掉所有密钥）
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, p);
  } catch (err) {
    console.error('[pet] 保存配置失败:', err);
  }
}

// 启动时调用一次：把旧版本留下的明文密钥升级成加密存储（空补丁写盘即可触发）
function migrateSecrets() {
  if (!canEncrypt()) return;
  try {
    const raw = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));
    let hasPlain = false;
    mapSecrets(raw, (v) => {
      if (v && !v.startsWith(ENC_PREFIX)) hasPlain = true;
      return v;
    });
    if (hasPlain) updateConfig({});
  } catch {
    // 没有配置文件 / 解析失败：没有可迁移的内容
  }
}

module.exports = { getConfigPath, loadConfig, updateConfig, migrateSecrets };
