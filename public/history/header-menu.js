// ---------------- 头部"⋯"更多菜单：插入消息 / 清空对话（参照 plot-assistant 手机私信页） ----------------
import { characterName, list, emptyEl, view } from './state.js';
import { editLocked, notifyEditLocked, onPendingChange } from './pending.js';
import { alertError } from './toast.js';
import { appendMsg } from './messages.js';
import { confirmDialog } from './confirm-dialog.js';

const menuWrap = document.getElementById('menu-wrap');
const menu = document.getElementById('menu');
const menuInsertBtn = document.getElementById('menu-insert');
const menuClearBtn = document.getElementById('menu-clear');
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
    appendMsg(msg.role, msg.content, msg.ts);
    closeInsert();
  } catch (err) {
    alertError(err);
    btn.disabled = false;
  }
}
insertAsUser.addEventListener('click', () => doInsert('user'));
insertAsAssistant.addEventListener('click', () => doInsert('assistant'));

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

// 等回复期间不允许改记录：插入/清空菜单项和插入弹窗的按钮禁用，已展开的菜单收起
onPendingChange(() => {
  const el = editLocked();
  menuInsertBtn.disabled = el;
  menuClearBtn.disabled = el;
  insertAsUser.disabled = el;
  insertAsAssistant.disabled = el;
  if (el) closeMenu();
});
