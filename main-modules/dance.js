// ---------- 扫描共享动作池 Actions/ 下的全部动作 ----------
// 动作文件只存一份在 Actions/ 下，所有角色直接使用全部动作，不再需要按角色配置白名单
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ACTIONS_ROOT = path.join(ROOT, 'Actions');

function scanDances() {
  const dances = [];
  const names = fs
    .readdirSync(ACTIONS_ROOT)
    .filter((name) => fs.statSync(path.join(ACTIONS_ROOT, name)).isDirectory())
    .sort();
  for (const name of names) {
    const dir = path.join(ACTIONS_ROOT, name);
    const files = fs.readdirSync(dir);
    // 过滤镜头/表情文件，选最大的 vmd 作为主动作
    const vmds = files
      .filter((f) => /\.vmd$/i.test(f) && !/镜头|camera|表情/i.test(f))
      .map((f) => ({ f, size: fs.statSync(path.join(dir, f)).size }))
      .sort((a, b) => b.size - a.size);
    if (!vmds.length) {
      console.warn(`[pet] 动作 "${name}" 目录下没有可用的 vmd 文件，已跳过`);
      continue;
    }
    // 目录里放 preferred.txt（内容为一行 vmd 文件名）可以手动指定用哪个动作文件，
    // 解决同一目录有多个版本（如 YYB 版/普通版）时自动选错的问题
    let pick = vmds[0].f;
    try {
      const preferred = fs.readFileSync(path.join(dir, 'preferred.txt'), 'utf-8').trim();
      if (preferred && vmds.some((v) => v.f === preferred)) pick = preferred;
      else if (preferred) console.warn(`[pet] 动作 "${name}" 的 preferred.txt 指定的 "${preferred}" 不存在，仍用最大文件`);
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[pet] 动作 "${name}" 的 preferred.txt 读取失败: ${err.message}`);
    }
    // 动作配乐支持 wav/mp3/ogg/m4a/flac/aac（一个目录放多个时按此优先级取第一个）
    const wav = files.find((f) => /\.(wav|mp3|ogg|m4a|flac|aac)$/i.test(f));
    const base = `/Actions/${encodeURIComponent(name)}/`;
    dances.push({
      name,
      vmd: base + encodeURIComponent(pick),
      wav: wav ? base + encodeURIComponent(wav) : null,
    });
  }
  return dances;
}

module.exports = { ACTIONS_ROOT, scanDances };
