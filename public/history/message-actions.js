// ---------------- 消息的"⋯"展开 / 编辑 / 删除（事件委托，动态插入的行不用重复绑） ----------------
import { characterName, list } from './state.js';
import { editLocked, notifyEditLocked, onPendingChange } from './pending.js';
import { alertError } from './toast.js';
import { reload } from './messages.js';
import { confirmDialog } from './confirm-dialog.js';

function endEdit(row) {
  const box = row.querySelector('.msg-edit');
  if (box) box.remove();
  const line = row.querySelector('.msg-line');
  if (line) line.style.display = '';
  row.classList.remove('editing');
}

function startEdit(row) {
  // 一行进入编辑态前，先把别的还在编辑的行收掉
  list.querySelectorAll('.msg-edit').forEach((b) => endEdit(b.closest('.msg')));
  row.classList.remove('actions-show');

  const line = row.querySelector('.msg-line');
  const original = row.dataset.text || '';
  line.style.display = 'none';
  row.classList.add('editing');

  const box = document.createElement('div');
  box.className = 'msg-edit';
  const ta = document.createElement('textarea');
  ta.className = 'edit-input';
  // 不设 maxLength：插入的消息可能超过 300 字，编辑时不能被挡住
  ta.value = original;

  const btns = document.createElement('div');
  btns.className = 'edit-btns';
  const cancel = document.createElement('button');
  cancel.className = 'edit-cancel';
  cancel.textContent = '取消';
  const save = document.createElement('button');
  save.className = 'edit-save';
  save.textContent = '保存';
  btns.appendChild(cancel);
  btns.appendChild(save);

  box.appendChild(ta);
  box.appendChild(btns);
  row.insertBefore(box, line);
  ta.focus();

  cancel.addEventListener('click', () => endEdit(row));
  save.addEventListener('click', async () => {
    const text = ta.value.trim();
    if (!text) {
      ta.focus();
      return;
    }
    if (editLocked()) return notifyEditLocked();
    save.disabled = true;
    try {
      await window.petAPI.editChatMessage(characterName, +row.dataset.index, text);
      row.dataset.text = text;
      row.querySelector('.msg-text').textContent = text;
      endEdit(row);
    } catch (err) {
      alertError(err);
      save.disabled = false;
    }
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      save.click();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      endEdit(row);
    }
  });
}

list.addEventListener('click', async (e) => {
  const moreBtn = e.target.closest('.msg-more');
  if (moreBtn) {
    const row = moreBtn.closest('.msg');
    const willShow = !row.classList.contains('actions-show');
    // 同一时间只展开一行操作
    list.querySelectorAll('.msg.actions-show').forEach((el) => el.classList.remove('actions-show'));
    row.classList.toggle('actions-show', willShow);
    return;
  }

  const editBtn = e.target.closest('.act-edit');
  if (editBtn) {
    startEdit(editBtn.closest('.msg'));
    return;
  }

  const delBtn = e.target.closest('.act-del');
  if (delBtn) {
    const row = delBtn.closest('.msg');
    if (editLocked()) return notifyEditLocked();
    if (!(await confirmDialog('确定要删除这条消息吗？此操作不可撤销。'))) return;
    if (editLocked()) return notifyEditLocked(); // 确认期间刚好发出了新消息
    try {
      await window.petAPI.deleteChatMessage(characterName, +row.dataset.index);
      await reload(true);
    } catch (err) {
      alertError(err);
    }
  }
});

// 点消息操作以外的地方：收起展开的 编辑/删除 行（不用再点一次"⋯"才能收起）
document.addEventListener('click', (e) => {
  list.querySelectorAll('.msg.actions-show').forEach((row) => {
    if (!e.target.closest('.msg-more') && !row.querySelector('.msg-actions').contains(e.target)) {
      row.classList.remove('actions-show');
    }
  });
});

// 等回复期间不允许改记录：藏掉每条消息的"⋯"和展开的 编辑/删除（CSS 的 edit-locked），
// 已经打开的编辑框保留，只是暂时不能保存
onPendingChange(() => {
  const el = editLocked();
  document.body.classList.toggle('edit-locked', el);
  list.querySelectorAll('.edit-save').forEach((b) => (b.disabled = el));
  if (el) list.querySelectorAll('.msg.actions-show').forEach((row) => row.classList.remove('actions-show'));
});
