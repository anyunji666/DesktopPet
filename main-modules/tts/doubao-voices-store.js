// ---------- 豆包预置音色：生效列表的本地存取 + 导入 / 导出 / 恢复默认 ----------
// 落盘位置：userData/doubao-voices.json，和 config.json（密钥等配置）同目录，但分开成单独文件，
// 这样导入/导出/恢复默认只动这一个文件，不牵扯角色配置。首次没有这个文件时，生效列表就是内置默认值。
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { DOUBAO_DEFAULT_PRESET_VOICES } = require('./presets');

let filePathCache = null;
function getFilePath() {
  if (!filePathCache) filePathCache = path.join(app.getPath('userData'), 'doubao-voices.json');
  return filePathCache;
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');

// 校验 + 清洗一条音色：name/speakerId/resourceId 必填，note 可选
function normalizeEntry(v) {
  const src = v && typeof v === 'object' ? v : {};
  const name = str(src.name);
  const speakerId = str(src.speakerId);
  const resourceId = str(src.resourceId);
  if (!name || !speakerId || !resourceId) return null;
  return { name, speakerId, resourceId, note: str(src.note) };
}

function normalizeList(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const item of list) {
    const entry = normalizeEntry(item);
    if (entry) out.push(entry);
  }
  return out;
}

// 读取当前生效列表；文件不存在/损坏时回退内置默认值（不写回文件，保持"没导入过"的状态）
function loadVoices() {
  try {
    const raw = JSON.parse(fs.readFileSync(getFilePath(), 'utf-8'));
    const list = normalizeList(raw);
    if (list && list.length) return list;
  } catch {
    // 文件不存在或不是合法 JSON，都当作"还没自定义过"
  }
  return DOUBAO_DEFAULT_PRESET_VOICES;
}

function writeVoices(list) {
  const p = getFilePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(list, null, 2), 'utf-8');
}

// 导入：srcPath 指向用户选的 json 文件，整体覆盖替换当前生效列表
function importVoices(srcPath) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(srcPath, 'utf-8'));
  } catch (e) {
    throw new Error('不是合法的 JSON 文件: ' + (e && e.message ? e.message : e));
  }
  const list = normalizeList(raw);
  if (!list || !list.length) {
    throw new Error('文件里没有可用的音色（每条至少需要 name / speakerId / resourceId）');
  }
  writeVoices(list);
  return list;
}

// 导出：把当前生效列表写到用户选的路径
function exportVoices(destPath) {
  const list = loadVoices();
  fs.writeFileSync(destPath, JSON.stringify(list, null, 2), 'utf-8');
  return list;
}

// 恢复默认：删掉自定义文件，生效列表回落到内置默认值
function resetVoices() {
  try {
    fs.unlinkSync(getFilePath());
  } catch {
    // 本来就没有自定义过，忽略
  }
  return DOUBAO_DEFAULT_PRESET_VOICES;
}

module.exports = { loadVoices, importVoices, exportVoices, resetVoices };
