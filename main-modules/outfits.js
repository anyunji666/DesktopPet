// ---------- 角色服饰：存取 + 拼进 prompt 的 <current_outfit> 文本 ----------
// 每个角色一份存档，放在用户数据目录（和聊天记录同级，不污染 Character/ 文件夹）：
//   userData/outfits/<角色名>/outfits.json   { activeId, items: [{ id, name, text, image }] }
//   userData/outfits/<角色名>/images/<文件>   服饰图片（png / jpeg / gif / webp），json 里只记文件名
// 服饰属于角色设定，不是故事进度：清空聊天记录、导入聊天记录都不影响它。
// 发给 LLM 的只有「当前穿着」那套的描述文字，图片本身不发（省 token，图片只用来预览和识别）。
// 依赖方向：llm.js -> 本文件；本文件不能 require llm.js / llm-client.js（识别调用在 outfit-recognize.js）。
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { assertSafeName } = require('./security');

const MAX_ITEMS = 30;
const MAX_NAME_CHARS = 30;
const MAX_TEXT_CHARS = 2000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

// 描写说明：描述里出现「不可见」时自动附在 <current_outfit> 里，用户不用每套都自己写
const OUTFIT_NOTE = '标注"不可见"的衣物当前被外层遮住，描写时不要提及，除非剧情中被脱下、掀开或意外露出。';

let rootCache = null;
function outfitsRoot() {
  if (!rootCache) rootCache = path.join(app.getPath('userData'), 'outfits');
  return rootCache;
}
function characterDir(characterName) {
  return path.join(outfitsRoot(), assertSafeName(characterName));
}
function imageDir(characterName) {
  return path.join(characterDir(characterName), 'images');
}
function jsonPath(characterName) {
  return path.join(characterDir(characterName), 'outfits.json');
}

// 文件名只允许单段名字，防路径逃逸
const isSafeFile = (f) => typeof f === 'string' && f.length > 0 && f.length <= 100 && !/[\\/]|\.\./.test(f);

function writeAtomic(p, text) {
  const tmp = p + '.tmp';
  try {
    fs.writeFileSync(tmp, text, 'utf-8');
    fs.renameSync(tmp, p);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

// ---------- 数据整理：读写都过一遍，页面和提示词拿到的永远是合法数据 ----------
function sanitizeDoc(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const items = [];
  const seen = new Set();
  const list = Array.isArray(src.items) ? src.items : [];
  for (const it of list) {
    if (items.length >= MAX_ITEMS) break;
    if (!it || typeof it !== 'object') continue;
    const id = typeof it.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(it.id) ? it.id : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    items.push({
      id,
      name: (typeof it.name === 'string' ? it.name.trim() : '').slice(0, MAX_NAME_CHARS),
      text: (typeof it.text === 'string' ? it.text.replace(/\r\n/g, '\n').trim() : '').slice(0, MAX_TEXT_CHARS),
      image: isSafeFile(it.image) ? it.image : '',
    });
  }
  const activeId = typeof src.activeId === 'string' && seen.has(src.activeId) ? src.activeId : '';
  return { activeId, items };
}

function readDoc(characterName) {
  try {
    return sanitizeDoc(JSON.parse(fs.readFileSync(jsonPath(characterName), 'utf-8')));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[pet] 服饰存档 ${characterName} 解析失败: ${err.message}`);
    return { activeId: '', items: [] };
  }
}

function writeDoc(characterName, doc) {
  fs.mkdirSync(characterDir(characterName), { recursive: true });
  writeAtomic(jsonPath(characterName), JSON.stringify(doc, null, 2));
}

// ---------- 图片 ----------
function readImageDataURL(characterName, filename) {
  if (!isSafeFile(filename)) return '';
  const ext = path.extname(filename).slice(1).toLowerCase();
  const mime = Object.keys(IMAGE_MIME_EXT).find((k) => IMAGE_MIME_EXT[k] === ext);
  if (!mime) return '';
  try {
    const p = path.join(imageDir(characterName), filename);
    if (!fs.existsSync(p)) return '';
    return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
  } catch (err) {
    console.warn(`[pet] 读取服饰图片失败: ${err.message}`);
    return '';
  }
}

// 校验并写入 dataURL 图片，返回新文件名；格式不对 / 超过 10MB 抛错
function writeImage(characterName, dataURL) {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(typeof dataURL === 'string' ? dataURL : '');
  if (!m) throw new Error('图片格式不正确');
  const ext = IMAGE_MIME_EXT[m[1].toLowerCase()];
  if (!ext) throw new Error('不支持的图片格式：' + m[1]);
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_IMAGE_BYTES) throw new Error('图片超过 10MB');
  const dir = imageDir(characterName);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  fs.writeFileSync(path.join(dir, name), buf);
  return name;
}

function removeImage(characterName, filename) {
  if (!isSafeFile(filename)) return;
  try {
    fs.unlinkSync(path.join(imageDir(characterName), filename));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[pet] 删除服饰图片失败: ${err.message}`);
  }
}

// ---------- 页面用的读写 ----------
// 返回给页面的结构：每套多带 imageDataURL（图片丢了就是空串，页面显示"图片丢失"）
function toPageDoc(characterName, doc) {
  return {
    activeId: doc.activeId,
    maxItems: MAX_ITEMS,
    maxNameChars: MAX_NAME_CHARS,
    maxTextChars: MAX_TEXT_CHARS,
    items: doc.items.map((it) => ({ ...it, imageDataURL: it.image ? readImageDataURL(characterName, it.image) : '' })),
  };
}

function loadOutfits(characterName) {
  return toPageDoc(characterName, readDoc(characterName));
}

// 整份保存：页面传来的 items 是最终清单（顺序、增删都以它为准）。
//   id 以 'new' 开头 = 新建，由这里分配正式 id；
//   imageDataURL 是 dataURL = 新图片（旧图片文件随后删掉）；没有 imageDataURL 就沿用 image 字段指向的已有文件；
//   activeId 不由页面决定（走 setActiveOutfit），这里沿用磁盘上的；当前穿着那套被删掉则清空。
function saveOutfits(characterName, data) {
  const incoming = data && Array.isArray(data.items) ? data.items : [];
  if (incoming.length > MAX_ITEMS) throw new Error(`最多保存 ${MAX_ITEMS} 套服饰`);
  const before = readDoc(characterName);
  const oldById = new Map(before.items.map((it) => [it.id, it]));
  const usedIds = new Set();
  const written = []; // 这次新写的图片：中途出错时回收
  const items = [];
  try {
    for (let i = 0; i < incoming.length; i++) {
      const it = incoming[i] && typeof incoming[i] === 'object' ? incoming[i] : {};
      const old = typeof it.id === 'string' ? oldById.get(it.id) : undefined;
      let id = old ? old.id : '';
      if (!id || usedIds.has(id)) id = `o${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      usedIds.add(id);
      let image = '';
      if (typeof it.imageDataURL === 'string' && it.imageDataURL.startsWith('data:')) {
        image = writeImage(characterName, it.imageDataURL);
        written.push(image);
      } else if (old && old.image && it.image === old.image) {
        image = old.image; // 只认磁盘上这套原本的图片，不信页面传来的任意文件名
      }
      items.push({ id, name: it.name || `服饰${i + 1}`, text: it.text, image });
    }
    const doc = sanitizeDoc({ activeId: before.activeId, items });
    // sanitizeDoc 会把空名字原样放过；这里统一补默认名
    doc.items.forEach((it, i) => {
      if (!it.name) it.name = `服饰${i + 1}`;
    });
    writeDoc(characterName, doc);
    // 不再被引用的旧图片文件清掉
    const keep = new Set(doc.items.map((it) => it.image).filter(Boolean));
    for (const old of before.items) if (old.image && !keep.has(old.image)) removeImage(characterName, old.image);
    return toPageDoc(characterName, doc);
  } catch (err) {
    for (const f of written) removeImage(characterName, f);
    throw err;
  }
}

// 设为当前穿着；id 为空串 = 不穿任何一套（不再向 LLM 发送服饰）
function setActiveOutfit(characterName, id) {
  const doc = readDoc(characterName);
  if (id && !doc.items.some((it) => it.id === id)) throw new Error('这套服饰还没有保存，请先保存');
  doc.activeId = id || '';
  writeDoc(characterName, doc);
  return toPageDoc(characterName, doc);
}

// ---------- 给 LLM 看的文本 ----------
// 没有当前穿着 / 描述为空就返回空串（不发这一段）
function buildOutfitBlock(characterName) {
  let doc;
  try {
    doc = readDoc(characterName);
  } catch {
    return '';
  }
  const cur = doc.items.find((it) => it.id === doc.activeId);
  if (!cur || !cur.text.trim()) return '';
  const lines = ['<current_outfit>', '<!-- 角色当前的穿搭。描写角色外貌、动作时以此为准，除非剧情中发生了换装 -->', cur.text.trim()];
  if (cur.text.includes('不可见')) lines.push(OUTFIT_NOTE);
  lines.push('</current_outfit>');
  return lines.join('\n');
}

module.exports = {
  MAX_ITEMS,
  loadOutfits,
  saveOutfits,
  setActiveOutfit,
  buildOutfitBlock,
};
