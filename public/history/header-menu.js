// ---------------- 头部"⋯"更多菜单：插入消息 / 剧情总览 / 记录导出导入 / 清空对话（参照 plot-assistant 手机私信页） ----------------
import { characterName, list, emptyEl, view } from './state.js';
import { editLocked, notifyEditLocked, onPendingChange } from './pending.js';
import { alertError, showToast } from './toast.js';
import { appendMsg, reload } from './messages.js';
import { confirmDialog } from './confirm-dialog.js';

const menuWrap = document.getElementById('menu-wrap');
const menu = document.getElementById('menu');
const menuInsertBtn = document.getElementById('menu-insert');
const menuModeBtn = document.getElementById('menu-mode');
const menuOverviewBtn = document.getElementById('menu-overview');
const menuClearBtn = document.getElementById('menu-clear');
const menuExportBtn = document.getElementById('menu-export');
const menuImportBtn = document.getElementById('menu-import');
const insertOverlay = document.getElementById('insert-overlay');
const insertText = document.getElementById('insert-text');
const insertAsUser = document.getElementById('insert-as-user');
const insertAsAssistant = document.getElementById('insert-as-assistant');

function closeMenu() {
  menu.classList.add('hidden');
}
document.getElementById('menu-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  menu.classList.toggle('hidden');
});

// 点菜单以外的地方收起菜单
document.addEventListener('click', (e) => {
  if (!menu.classList.contains('hidden') && !menuWrap.contains(e.target)) closeMenu();
});

// ---- 插入消息弹窗 ----
function openInsert() {
  closeMenu();
  insertText.value = '';
  insertAsUser.disabled = false;
  insertAsAssistant.disabled = false;
  insertOverlay.classList.remove('hidden');
  setTimeout(() => insertText.focus(), 50);
}
function closeInsert() {
  insertOverlay.classList.add('hidden');
}
menuInsertBtn.addEventListener('click', openInsert);
document.getElementById('insert-close').addEventListener('click', closeInsert);
// 点遮罩本身才关（点弹窗内部不关），用 pointerdown/mouseup 都在遮罩上时判定，避免拖选文本误关
let overlayDownOnSelf = false;
insertOverlay.addEventListener('mousedown', (e) => {
  overlayDownOnSelf = e.target === insertOverlay;
});
insertOverlay.addEventListener('mouseup', (e) => {
  if (overlayDownOnSelf && e.target === insertOverlay) closeInsert();
  overlayDownOnSelf = false;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !insertOverlay.classList.contains('hidden')) closeInsert();
});

async function doInsert(role) {
  const text = insertText.value.trim();
  if (!text) {
    insertText.focus();
    return;
  }
  if (editLocked()) return notifyEditLocked();
  const btn = role === 'user' ? insertAsUser : insertAsAssistant;
  btn.disabled = true;
  try {
    const msg = await window.petAPI.addChatMessage(characterName, role, text);
    // 插入的 AI 消息里带 [img:…] 图库标签时，整页重绘一次，让标签变成图片（reload 走 get-chat-history 的标签解析）
    if (role === 'assistant' && /\[\s*img\s*[:：]/i.test(msg.content)) await reload(true);
    else appendMsg(msg.role, msg.content, msg.ts);
    closeInsert();
  } catch (err) {
    alertError(err);
    btn.disabled = false;
  }
}
insertAsUser.addEventListener('click', () => doInsert('user'));
insertAsAssistant.addEventListener('click', () => doInsert('assistant'));

// ---- 模式切换：故事模式 / 网聊模式（按角色保存，主进程 chat-mode.js） ----
const modeOverlay = document.getElementById('mode-overlay');
const modeOptions = [...modeOverlay.querySelectorAll('.mode-option')];
const MODE_LABEL = { story: '故事模式', chat: '网聊模式' };
let currentMode = 'story';

// 总览在两种模式下叫法不同：故事模式"剧情总览"，网聊模式"对话总览"（菜单项、弹窗标题 / 说明 / 占位提示、保存提示都跟着换）
const OVERVIEW_TEXTS = {
  story: {
    name: '剧情总览',
    hint: '小总结攒够 2000 字后，会由 AI 连同上一版总览一起再压缩成这份总览，作为更早剧情的脉络发给 AI。可以直接修改，保存后下次对话就会按改后的内容发送；清空保存则不再发送这段时间的内容。',
    placeholder: '还没有剧情总览。小总结攒够字数后会自动生成，也可以在这里手动写一份。',
  },
  chat: {
    name: '对话总览',
    hint: '小总结攒够 2000 字后，会由 AI 连同上一版总览一起再压缩成这份总览，作为更早聊天的脉络发给 AI。可以直接修改，保存后下次对话就会按改后的内容发送；清空保存则不再发送这段时间的内容。',
    placeholder: '还没有对话总览。小总结攒够字数后会自动生成，也可以在这里手动写一份。',
  },
};
function overviewTexts() {
  return OVERVIEW_TEXTS[currentMode] || OVERVIEW_TEXTS.story;
}
function renderOverviewTexts() {
  const t = overviewTexts();
  document.getElementById('menu-overview').textContent = t.name;
  document.querySelector('#overview-dialog .dialog-head span').textContent = t.name;
  document.querySelector('#overview-dialog .dialog-hint').textContent = t.hint;
  document.getElementById('overview-text').placeholder = t.placeholder;
}

function renderMode() {
  renderOverviewTexts();
  for (const b of modeOptions) b.classList.toggle('active', b.dataset.mode === currentMode);
  // 标题里角色名前的"聊天记录"换成当前模式名，不用打开菜单也能看出来
  document.getElementById('title').textContent = MODE_LABEL[currentMode] + ' · ' + characterName;
}
function closeMode() {
  modeOverlay.classList.add('hidden');
}
async function openMode() {
  closeMenu();
  try {
    currentMode = await window.petAPI.getChatMode(characterName);
  } catch (err) {
    return alertError(err);
  }
  renderMode();
  modeOverlay.classList.remove('hidden');
}
menuModeBtn.addEventListener('click', openMode);
document.getElementById('mode-close').addEventListener('click', closeMode);
modeOverlay.addEventListener('click', (e) => {
  if (e.target === modeOverlay) closeMode();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modeOverlay.classList.contains('hidden')) closeMode();
});
for (const b of modeOptions) {
  b.addEventListener('click', async () => {
    const mode = b.dataset.mode;
    if (mode === currentMode) return closeMode();
    if (editLocked()) return notifyEditLocked();
    try {
      currentMode = await window.petAPI.setChatMode(characterName, mode);
    } catch (err) {
      return alertError(err);
    }
    renderMode();
    closeMode();
    showToast(`已切换为${MODE_LABEL[currentMode]}`, 'info');
    // 两个模式的聊天记录是分开存的：切换后把列表换成新模式的记录
    try {
      emptyEl.style.display = 'none';
      await reload();
      window.scrollTo(0, document.body.scrollHeight);
    } catch (err) {
      alertError(err);
    }
  });
}
// 窗口一打开先按默认的故事模式显示标题，读到实际模式后立刻更新（读取失败就保持默认，不打扰）
renderMode();
window.petAPI.getChatMode(characterName).then((m) => { currentMode = m; renderMode(); }).catch(() => {});

// ---- 剧情总览：查看 / 手动编辑 ----
// 总览由小总结攒够字数后自动合并生成（主进程 story-overview.js），这里只改正文；水位线（"已整理到哪个时间点"）只读展示。
// 等回复期间不能保存（主进程也会拦）；后台合并写盘前会核对总览有没有被改过，被改过就丢弃合并结果。
const overviewOverlay = document.getElementById('overview-overlay');
const overviewText = document.getElementById('overview-text');
const overviewCovered = document.getElementById('overview-covered');
const overviewCount = document.getElementById('overview-count');
const overviewSave = document.getElementById('overview-save');
let overviewMax = 1600;

function refreshOverviewCount() {
  const n = overviewText.value.trim().length;
  overviewCount.textContent = `${n} / ${overviewMax} 字`;
  overviewCount.classList.toggle('over', n > overviewMax);
  overviewSave.disabled = n > overviewMax || editLocked();
}
overviewText.addEventListener('input', refreshOverviewCount);

async function openOverview() {
  closeMenu();
  let data;
  try {
    data = await window.petAPI.getStoryOverview(characterName);
  } catch (err) {
    return alertError(err);
  }
  overviewMax = data.maxChars || 1600;
  overviewText.value = data.text || '';
  const label = data.coveredLabel || '';
  overviewCovered.textContent = label ? `已整理到 ${label}（这个时间点及以前的小总结不再单独发送）` : '';
  refreshOverviewCount();
  overviewOverlay.classList.remove('hidden');
  setTimeout(() => overviewText.focus(), 50);
}
function closeOverview() {
  overviewOverlay.classList.add('hidden');
}
menuOverviewBtn.addEventListener('click', openOverview);
document.getElementById('overview-close').addEventListener('click', closeOverview);
document.getElementById('overview-cancel').addEventListener('click', closeOverview);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !overviewOverlay.classList.contains('hidden')) closeOverview();
});
overviewSave.addEventListener('click', async () => {
  if (editLocked()) return notifyEditLocked();
  overviewSave.disabled = true;
  try {
    await window.petAPI.saveStoryOverview(characterName, overviewText.value);
    closeOverview();
    showToast(overviewTexts().name + '已保存', 'info');
  } catch (err) {
    alertError(err);
  } finally {
    refreshOverviewCount();
  }
});

// ---- 清空对话 ----
menuClearBtn.addEventListener('click', async () => {
  closeMenu();
  if (editLocked()) return notifyEditLocked();
  if (!(await confirmDialog(`确定要清空和「${characterName}」的全部聊天记录吗？此操作不可撤销。`))) return;
  if (editLocked()) return notifyEditLocked(); // 确认期间刚好发出了新消息
  try {
    await window.petAPI.clearChatHistory(characterName);
    list.innerHTML = '';
    view.msgCount = 0;
    emptyEl.style.display = 'block';
    window.scrollTo(0, 0);
  } catch (err) {
    alertError(err);
  }
});

// ---- 导出 / 导入聊天记录 ----
menuExportBtn.addEventListener('click', async () => {
  closeMenu();
  try {
    const r = await window.petAPI.exportChatHistory(characterName);
    if (r) showToast(`已导出 ${r.count} 条消息`, 'info');
  } catch (err) {
    alertError(err);
  }
});

menuImportBtn.addEventListener('click', async () => {
  closeMenu();
  if (editLocked()) return notifyEditLocked();
  if (!(await confirmDialog(`导入会用文件里的内容覆盖和「${characterName}」现有的全部聊天记录（包括小总结和总览），此操作不可撤销。建议先导出备份。继续选择文件吗？`))) return;
  if (editLocked()) return notifyEditLocked(); // 确认期间刚好发出了新消息
  try {
    const r = await window.petAPI.importChatHistory(characterName);
    if (!r) return; // 取消选择文件
    emptyEl.style.display = 'none';
    await reload();
    window.scrollTo(0, document.body.scrollHeight);
    const notes = [];
    if (r.skipped) notes.push(`跳过 ${r.skipped} 条无效消息`);
    if (r.imageFailed) notes.push(`${r.imageFailed} 张图片导入失败`);
    showToast(`已导入 ${r.count} 条消息` + (notes.length ? `（${notes.join('，')}）` : ''), 'info');
  } catch (err) {
    alertError(err);
  }
});

// 等回复期间不允许改记录：插入/清空/导入菜单项、插入弹窗和剧情总览弹窗的保存按钮禁用，已展开的菜单收起（查看总览仍可用）
onPendingChange(() => {
  const el = editLocked();
  menuInsertBtn.disabled = el;
  menuModeBtn.disabled = el;
  for (const b of modeOptions) b.disabled = el;
  menuClearBtn.disabled = el;
  menuImportBtn.disabled = el;
  if (!overviewOverlay.classList.contains('hidden')) refreshOverviewCount(); // 弹窗开着时跟着锁状态更新保存按钮
  insertAsUser.disabled = el;
  insertAsAssistant.disabled = el;
  if (el) closeMenu();
});
