// ---------- MiMo 音色复刻：参考音频的本地存取 ----------
// 参考音频存进用户数据目录下的 tts-clone/（和 chat-history/ 一样，与角色资源目录分开），
// 每个角色一份，文件名 = 角色名 + 扩展名。config 里只记文件名等元信息，合成时才读文件转 data URL，
// 所以不像 ST 扩展那样需要 IndexedDB。
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

// MiMo 官方限制：参考音频只支持 mp3 / wav；转成 base64 后的字符串不能超过 10 MB。
// base64 会比原文件大约 1/3，所以原文件上限取 7 MB（留出余量，不用去纠结官方说的 MB 是 1000 还是 1024 进制）
const MAX_CLONE_BYTES = 7 * 1000 * 1000;
const AUDIO_MIME = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};
const AUDIO_EXTENSIONS = Object.keys(AUDIO_MIME).map((e) => e.slice(1));

let cloneDirCache = null;
function getCloneDir() {
  if (!cloneDirCache) cloneDirCache = path.join(app.getPath('userData'), 'tts-clone');
  return cloneDirCache;
}

function safeName(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '_');
}

// 把用户选的音频复制进 tts-clone/，返回要写进 config 的元信息
function importCloneAudio(characterName, srcPath) {
  const ext = path.extname(srcPath).toLowerCase();
  const mime = AUDIO_MIME[ext];
  if (!mime) throw new Error(`不支持的音频格式，请选 ${AUDIO_EXTENSIONS.join(' / ')} 文件`);
  const size = fs.statSync(srcPath).size;
  if (size === 0) throw new Error('参考音频是空文件');
  if (size > MAX_CLONE_BYTES) throw new Error('参考音频超过 7 MB（MiMo 要求转成 base64 后不超过 10 MB），请裁短后再选');

  const dir = getCloneDir();
  fs.mkdirSync(dir, { recursive: true });
  const base = safeName(characterName);
  // 该角色之前若有别的扩展名的旧参考音频，一并清掉，避免残留
  for (const f of fs.readdirSync(dir)) {
    if (path.parse(f).name === base) fs.unlinkSync(path.join(dir, f));
  }
  const file = base + ext;
  fs.copyFileSync(srcPath, path.join(dir, file));
  return { file, name: path.basename(srcPath), mime, size };
}

// 读参考音频并拼成 MiMo 要求的 data:audio/...;base64,... 。file 只允许是纯文件名（防路径穿越）
function readCloneAudioDataURL(file) {
  if (typeof file !== 'string' || !file || path.basename(file) !== file) {
    throw new Error('请先在音色设置里选择复刻用的参考音频');
  }
  let buf;
  try {
    buf = fs.readFileSync(path.join(getCloneDir(), file));
  } catch {
    throw new Error('复刻参考音频文件已丢失，请重新选择');
  }
  const mime = AUDIO_MIME[path.extname(file).toLowerCase()];
  if (!mime) throw new Error(`参考音频格式不受支持，请重新选择 ${AUDIO_EXTENSIONS.join(' / ')} 文件`);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

module.exports = { MAX_CLONE_BYTES, AUDIO_EXTENSIONS, importCloneAudio, readCloneAudioDataURL };
