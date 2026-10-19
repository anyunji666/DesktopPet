// ---------------- 消息的"⋯"展开 / 编辑 / 删除（事件委托，动态插入的行不用重复绑） ----------------
import { characterName, list } from './state.js';
import { editLocked, notifyEditLocked, onPendingChange } from './pending.js';
import { alertError } from './toast.js';
import { reload } from './messages.js';
import { confirmDialog } from './confirm-dialog.js';
import { resendMessage } from './composer.js';
import { showToast } from './toast.js';

// 退出编辑态：去掉输入框和按钮行，恢复文字/时间行，清掉进入编辑时设置的气泡最小宽度
function endEdit(row) {
  row.querySelectorAll('.edit-input, .edit-summary, .edit-btns').forEach((el) => el.remove());
  const text = row.querySelector('.msg-text');
  if (text) text.style.display = '';
  row.style.minWidth = '';
  row.classList.remove('editing');
}

// 原地编辑：气泡尺寸保持和原来一样——
// 1) 进入编辑前先量出气泡宽度和文字高度，宽度不低于原来，输入框高度不低于原文字高度；
// 2) 输入框用负 margin 抵消自身 padding，文字位置、换行都和原来一致，进入编辑时不会跳动；
// 3) 图片保留显示，只把文字换成输入框；
// 4) 取消/保存按钮替换掉底部的"时间戳 + ⋯"那一行，整体高度基本不变。
function startEdit(row) {
  // 一行进入编辑态前，先把别的还在编辑的行收掉
  list.querySelectorAll('.msg.editing').forEach((r) => endEdit(r));
  row.classList.remove('actions-show');

  const line = row.querySelector('.msg-line');
  const textEl = row.querySelector('.msg-text'); // 纯图片消息没有文字元素
  const original = row.dataset.text || '';

  // 必须在隐藏/替换任何东西之前测量
  const lockWidth = textEl ? getComputedStyle(row).width : '';
  const origHeight = textEl ? textEl.getBoundingClientRect().height : 0;
  const hasImg = !!line.querySelector('.msg-img');

  // 用 min-width 而不是 width：不会比原来窄；极短的消息（如"好的"）放不下两个按钮时才允许略微变宽
  if (lockWidth) row.style.minWidth = lockWidth;
  if (textEl) textEl.style.display = 'none';
  row.classList.add('editing');

  const ta = document.createElement('textarea');
  ta.className = 'edit-input';
  // 不设 maxLength：插入的消息可能超过 300 字，编辑时不能被挡住
  ta.value = original;
  // 图片和文字并排时，左边只留 2px 内边距（图片和文字之间本来就有 6px 间距）
  ta.style.setProperty('--pl', hasImg ? '2px' : '8px');
  if (textEl) ta.style.minHeight = origHeight + 12 + 'px'; // 12 = 上下 padding
  else ta.style.minWidth = '10em'; // 纯图片消息：没有原文字宽度可参照，给输入框一个最小宽度
  // 输入框放在原文字的位置，图片（如果有）留在原处
  line.appendChild(ta);

  // 自动增高：高度跟着内容走，但不低于原文字高度（minHeight），不出现内部滚动条
  const autosize = () => {
    ta.style.height = '0px';
    ta.style.height = ta.scrollHeight + 'px';
  };
  ta.addEventListener('input', autosize);

  // AI 消息：正文下面多出"摘要"区（平时不显示），故事时间 / 概述各一个输入框。
  // 摘要是每轮回复末尾自带的 <story_overview> 块，老轮次发给模型时用它替换原文；两项都清空 = 这一轮发原文、不压缩
  let timeInput = null;
  let overviewInput = null;
  if (row.classList.contains('assistant')) {
    const box = document.createElement('div');
    box.className = 'edit-summary';
    const mk = (label, value, placeholder, rows) => {
      const wrap = document.createElement('label');
      wrap.className = 'edit-summary-field';
      const cap = document.createElement('span');
      cap.textContent = label;
      const inp = document.createElement(rows ? 'textarea' : 'input');
      if (rows) inp.rows = rows;
      inp.value = value;
      inp.placeholder = placeholder;
      wrap.appendChild(cap);
      wrap.appendChild(inp);
      box.appendChild(wrap);
      return inp;
    };
    timeInput = mk('故事时间', row.dataset.storyTime || '', '例：2026年9月27日 21:40', 0);
    overviewInput = mk('概述', row.dataset.overview || '', '本轮关键事件及角色的实际改变', 2);
    const hint = document.createElement('div');
    hint.className = 'edit-summary-hint';
    hint.textContent = '摘要用于压缩历史。两项都留空 = 这一轮在历史中发送原文';
    box.appendChild(hint);
    const grow = () => {
      overviewInput.style.height = '0px';
      overviewInput.style.height = overviewInput.scrollHeight + 'px';
    };
    overviewInput.addEventListener('input', grow);
    row.insertBefore(box, row.querySelector('.msg-story-time') || row.querySelector('.msg-foot'));
    grow();
    // 摘要框里 Enter 不触发保存（概述可以多行）；Esc 取消、Ctrl/Cmd+Enter 保存
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        endEdit(row);
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        save.click();
      } else if (e.key === 'Enter' && e.target === timeInput) {
        e.preventDefault(); // 故事时间是单行
      }
    });
  }

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
  row.insertBefore(btns, row.querySelector('.msg-foot')); // 底部时间行在编辑态由 CSS 隐藏

  autosize();
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
      const summary = timeInput
        ? { storyTime: timeInput.value.trim().replace(/\s*\n\s*/g, ' '), overview: overviewInput.value.trim() }
        : undefined;
      await window.petAPI.editChatMessage(characterName, +row.dataset.index, text, summary);
      row.dataset.text = text;
      if (summary) {
        row.dataset.storyTime = summary.storyTime;
        row.dataset.overview = summary.overview;
        // 同步气泡末尾的 🕰 故事时间标签：有就更新/补上，清空就去掉
        let st = row.querySelector('.msg-story-time');
        if (summary.storyTime) {
          if (!st) {
            st = document.createElement('div');
            st.className = 'msg-story-time';
            row.insertBefore(st, row.querySelector('.msg-foot'));
          }
          st.textContent = '🕰 ' + summary.storyTime;
        } else if (st) {
          st.remove();
        }
      }
      let t = row.querySelector('.msg-text');
      if (!t) {
        // 纯图片消息第一次加文字：补一个文字元素
        t = document.createElement('div');
        t.className = 'msg-text';
        line.appendChild(t);
      }
      t.textContent = text;
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

// 重新生成：找到这条 AI 回复前面最近的一条用户输入，删掉它和它后面的所有消息（含这条），
// 再把这条输入（文字 + 图片）放进输入框重新发送，时间用重发时的最新时间
async function regenerate(row) {
  row.classList.remove('actions-show');
  if (editLocked()) return notifyEditLocked();

  // 往上找最近的用户消息（DOM 顺序 = 记录数组顺序，data-index 就是数组下标）
  let userRow = row.previousElementSibling;
  while (userRow && !userRow.classList.contains('user')) userRow = userRow.previousElementSibling;
  if (!userRow) return showToast('这条回复前面没有用户输入，无法重新生成', 'info');
  const userIdx = +userRow.dataset.index;

  try {
    // 先取一份完整记录：拿用户输入的文字和图片（删除会连图片文件一起删掉）
    const history = await window.petAPI.getChatHistory(characterName);
    const src = history[userIdx];
    if (!src || src.role !== 'user') throw new Error('记录已变化，请刷新后重试');
    const text = src.content || '';
    const image = src.imageDataURL;
    if (!text && !image) throw new Error('找不到可重发的用户输入');

    // 要删的比"最新一轮"（一条用户输入 + 一条回复）还多时，先用页内确认框问一下
    if (history.length - userIdx > 2) {
      const ok = await confirmDialog('重新生成会清除这条消息后的所有消息（包括这条回复）。此操作不可撤销，确定吗？');
      if (!ok) return;
      if (editLocked()) return notifyEditLocked(); // 确认期间刚好发出了新消息
    }

    // 主进程一次性删掉 userIdx 起到末尾的所有消息（含图片文件）
    await window.petAPI.truncateChatHistory(characterName, userIdx);
    await reload();
    window.scrollTo(0, document.body.scrollHeight);

    await resendMessage(text, image);
  } catch (err) {
    alertError(err);
    await reload(true).catch(() => {}); // 出错时按磁盘现状重绘
  }
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

  const regenBtn = e.target.closest('.act-regen');
  if (regenBtn) {
    await regenerate(regenBtn.closest('.msg'));
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
