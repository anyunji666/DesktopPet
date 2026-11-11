// ---------- 角色图库：扫描 Character/<角色>/images/ + 提示词清单 + 回复里的 [img:类别/图片名] 标签解析 ----------
// 目录约定：
//   Character/<角色>/images/<类别>/<图片名>.png|jpg|jpeg|gif|webp   子文件夹名 = 类别，文件名（不含扩展名）= 图片名
//   Character/<角色>/images/<图片名>.png                              根目录下没分类的图，归入「未分类」
// 没有 images/ 文件夹、或里面没有可用图片 = 这个角色没有图库：提示词里不发清单，回复里的标签也一律不认。
// 每次用到都现扫目录（不缓存），往文件夹里加图 / 删图下一轮对话就生效，不用重启。
//
// 标签约定：模型在正文前单独输出 [img:类别/图片名]，每条回复最多一张（多写的忽略）。
// 标签只在主进程认：落盘的 assistant 内容里保留规范化后的标签（下一轮模型能看到自己发过什么），
// 气泡 / 朗读用的文字里摘掉；聊天记录窗口按标签现读图片，以 dataURL 经 IPC 给渲染进程（不用动本地静态服务器的目录白名单）。
const fs = require('fs');
const path = require('path');
const { CHARACTER_ROOT } = require('./character');
const { assertSafeName } = require('./security');

const EXT_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const UNCATEGORIZED = '未分类';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 和聊天图片上限一致，超了当没有这张图
// 全角冒号 / 冒号两侧空格都容错；名字里不能有 ] 和换行（扫描时这类文件名会被跳过）
const TAG_RE = /\[\s*img\s*[:：]\s*([^\]\n]+?)\s*\]/gi;

function imagesDir(characterName) {
  try {
    return path.join(CHARACTER_ROOT, assertSafeName(characterName), 'images');
  } catch {
    return null;
  }
}

// 文件名能不能当标签里的"图片名"：不能含会破坏标签的字符
function nameUsable(name) {
  return !!name && !/[\]\[\r\n/\\]/.test(name);
}

// 扫描图库，返回 [{ category, items: [{ name, file, mime }] }]，类别和图片都按名字排序（输出稳定，不破坏前缀缓存）。
// 只扫一层子文件夹；同一类别里同名（不同扩展名）只留第一张；点开头的隐藏文件、不支持的扩展名、超大文件都跳过
function scanImageLibrary(characterName) {
  const root = imagesDir(characterName);
  if (!root) return [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return []; // 没有 images/ 文件夹
  }

  const byCategory = new Map(); // 类别名 -> Map<图片名, item>
  const addFile = (category, dir, fileName) => {
    if (fileName.startsWith('.')) return;
    const ext = path.extname(fileName).toLowerCase();
    const mime = EXT_MIME[ext];
    if (!mime) return;
    const name = path.basename(fileName, path.extname(fileName)).trim();
    if (!nameUsable(name)) {
      console.warn(`[pet] 图库跳过文件名含特殊字符的图片: ${category}/${fileName}`);
      return;
    }
    const file = path.join(dir, fileName);
    try {
      if (fs.statSync(file).size > MAX_IMAGE_BYTES) {
        console.warn(`[pet] 图库跳过超过 10MB 的图片: ${category}/${fileName}`);
        return;
      }
    } catch {
      return;
    }
    if (!byCategory.has(category)) byCategory.set(category, new Map());
    const items = byCategory.get(category);
    if (!items.has(name)) items.set(name, { name, file, mime });
  };

  const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  for (const ent of entries.slice().sort((a, b) => byName(a.name, b.name))) {
    const full = path.join(root, ent.name);
    if (ent.isDirectory()) {
      if (ent.name.startsWith('.') || !nameUsable(ent.name.trim())) continue;
      let files;
      try {
        files = fs.readdirSync(full, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const f of files.slice().sort((a, b) => byName(a.name, b.name))) {
        if (f.isFile()) addFile(ent.name.trim(), full, f.name);
      }
    } else if (ent.isFile()) {
      addFile(UNCATEGORIZED, root, ent.name);
    }
  }

  const out = [];
  for (const [category, items] of byCategory) {
    out.push({ category, items: [...items.values()].sort((a, b) => byName(a.name, b.name)) });
  }
  // 「未分类」放最后，其余类别按名字排
  out.sort((a, b) => (a.category === UNCATEGORIZED) - (b.category === UNCATEGORIZED) || byName(a.category, b.category));
  return out;
}

// 拼进 LLM 提示词的 <image_library> 块；没有图库返回空串（调用方不发这一段）
function buildImageLibraryBlock(characterName) {
  const lib = scanImageLibrary(characterName);
  if (!lib.length) return '';
  const example = `${lib[0].category}/${lib[0].items[0].name}`;
  const lines = [
    '<image_library>',
    `<!-- 角色可发送给用户的图片。若场景需要，可在正文前单独一行输出 [img:类别/图片名]。类别和图片名必须与下列完全一致，只挑选最合适的一张输出，不要自己编造，场景不需要就不要发。格式示例：[img:${example}] -->`,
    '',
  ];
  lib.forEach((c, i) => {
    if (i > 0) lines.push('');
    lines.push(`${c.category}：`);
    for (const it of c.items) lines.push(`* ${it.name}`);
  });
  lines.push('</image_library>');
  return lines.join('\n');
}

// 把标签里的 id 对应到图库里的一张图，返回 { id: 规范化的 "类别/图片名", file, mime } 或 null。
// 容错：全角斜杠、图片名后面多带了扩展名、模型漏写类别但图片名在全库里唯一
function findLibraryImage(lib, rawId) {
  const id = String(rawId || '').replace(/／/g, '/').trim();
  if (!id) return null;
  const hit = (cat, item) => ({ id: `${cat.category}/${item.name}`, file: item.file, mime: item.mime });
  const stripExt = (n) => (EXT_MIME[path.extname(n).toLowerCase()] ? path.basename(n, path.extname(n)) : n);
  const findIn = (cat, n) => cat.items.find((it) => it.name === n || it.name === stripExt(n));

  const slash = id.indexOf('/');
  if (slash >= 0) {
    const catName = id.slice(0, slash).trim();
    const name = id.slice(slash + 1).trim();
    const cat = lib.find((c) => c.category === catName);
    const item = cat && findIn(cat, name);
    return item ? hit(cat, item) : null;
  }
  const matches = [];
  for (const c of lib) {
    const item = findIn(c, id);
    if (item) matches.push(hit(c, item));
  }
  return matches.length === 1 ? matches[0] : null;
}

function readDataURL(img) {
  try {
    return `data:${img.mime};base64,${fs.readFileSync(img.file).toString('base64')}`;
  } catch (err) {
    console.warn(`[pet] 读取图库图片失败: ${err.message}`);
    return null;
  }
}

// 处理一段 assistant 正文：摘掉所有 [img:...] 标签，取第一个标签去图库里找图。
// 返回 { text: 摘掉标签后的正文, id: 规范化的 "类别/图片名"（没发图 / 找不到 = ''）, imageDataURL: 图片 dataURL（没有 = undefined） }。
// 没有标签时不扫目录、不读文件（历史里绝大多数消息走这条快路径）
function pickLibraryImage(characterName, text) {
  const raw = typeof text === 'string' ? text : '';
  const tags = [];
  const stripped = raw.replace(TAG_RE, (_m, id) => {
    tags.push(id);
    return '';
  });
  if (!tags.length) return { text: raw, id: '', imageDataURL: undefined };
  const clean = stripped.replace(/\n{3,}/g, '\n\n').trim();

  const img = findLibraryImage(scanImageLibrary(characterName), tags[0]);
  if (!img) {
    console.warn(`[pet] 回复里的图片标签找不到对应图片，已忽略: [img:${tags[0]}]`);
    return { text: clean, id: '', imageDataURL: undefined };
  }
  const dataURL = readDataURL(img);
  if (!dataURL) return { text: clean, id: '', imageDataURL: undefined };
  return { text: clean, id: img.id, imageDataURL: dataURL };
}

// 落盘用：给 assistant 正文前面补回规范化的标签（没发图就原样返回）
function withImageTag(id, text) {
  return id ? `[img:${id}]\n${text}` : text;
}

module.exports = { scanImageLibrary, buildImageLibraryBlock, pickLibraryImage, withImageTag, findLibraryImage };
