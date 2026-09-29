// ---------------- 消息列表：渲染 / 临时气泡 / 加载与重绘 ----------------
import { characterName, list, emptyEl, view } from './state.js';
import { lock, pendingText, onPendingChange } from './pending.js';

function fmtTs(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 构造一条消息的 DOM。temp=true 是"已发出、还在等回复"的临时气泡：没有下标、没有"⋯"编辑/删除，
// 时间处显示当前阶段的提示（整理总结中 / 等待回复中）；落盘后由 chat-settled 事件把它换成正式消息
function buildMsgEl(role, content, ts, imageDataURL, temp) {
  const div = document.createElement('div');
  div.className = 'msg ' + (role === 'user' ? 'user' : 'assistant') + (temp ? ' sending' : '');

  const line = document.createElement('div');
  line.className = 'msg-line';

  if (imageDataURL) {
    const img = document.createElement('img');
    img.className = 'msg-img';
    img.src = imageDataURL;
    img.alt = '图片';
    line.appendChild(img);
  }

  if (content) {
    const text = document.createElement('div');
    text.className = 'msg-text';
    text.textContent = content;
    line.appendChild(text);
  }

  div.appendChild(line);

  // 气泡底部一行：时间戳 + "⋯"（临时气泡没有 ⋯），编辑/删除紧接在这一行下面展开
  const foot = document.createElement('div');
  foot.className = 'msg-foot';
  const tsEl = document.createElement('div');
  tsEl.className = 'ts';
  tsEl.textContent = temp ? pendingText() : fmtTs(ts);
  foot.appendChild(tsEl);
  if (!temp) {
    const more = document.createElement('button');
    more.className = 'msg-more';
    more.title = role === 'user' ? '编辑/删除' : '编辑/重新生成/删除';
    more.textContent = '⋯';
    foot.appendChild(more);
  }
  div.appendChild(foot);

  if (!temp) {
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    const editBtn = document.createElement('button');
    editBtn.className = 'act-edit';
    editBtn.textContent = '编辑';
    const delBtn = document.createElement('button');
    delBtn.className = 'act-del';
    delBtn.textContent = '删除';
    // 顺序：删除 / 编辑 /（AI 回复才有）重新生成
    actions.appendChild(delBtn);
    actions.appendChild(editBtn);
    // 只有 AI 回复才有"重新生成"：删掉它前面最近一条用户输入及之后的所有消息，再把那条输入重发一遍
    if (role !== 'user') {
      const regenBtn = document.createElement('button');
      regenBtn.className = 'act-regen';
      regenBtn.textContent = '重新生成';
      actions.appendChild(regenBtn);
    }
    div.appendChild(actions);
  }
  return div;
}

export function appendMsg(role, content, ts, imageDataURL) {
  emptyEl.style.display = 'none';
  const div = buildMsgEl(role, content, ts, imageDataURL, false);
  div.dataset.index = view.msgCount++;
  div.dataset.text = content || '';
  list.appendChild(div);
  window.scrollTo(0, document.body.scrollHeight);
}

// 等回复期间，把"发出去还没回复"的那条用户消息作为临时气泡显示在列表末尾（主界面发的、这个窗口发的都一样）。
// 幂等：想显示就保证它在最后一个，不想显示就移除；只有属于当前角色的等待才显示
export function syncTempBubble() {
  if (!view.loaded) return; // 初次加载还没完成，完成后会再调一次
  const p = lock.pending;
  const want = p && p.character === characterName;
  if (!want) {
    if (view.tempEl) {
      view.tempEl.remove();
      view.tempEl = null;
      if (!list.children.length) emptyEl.style.display = 'block'; // 第一条消息就失败了：列表回到空状态
    }
    return;
  }
  if (!view.tempEl) view.tempEl = buildMsgEl('user', p.user, p.ts, p.imageDataURL, true);
  view.tempEl.querySelector('.ts').textContent = pendingText(); // 阶段变化时只刷新文字，不重建气泡
  emptyEl.style.display = 'none';
  list.appendChild(view.tempEl); // 已在列表里也没关系，重新 append 会挪到最后
  window.scrollTo(0, document.body.scrollHeight);
}
onPendingChange(syncTempBubble);

export async function load() {
  const history = await window.petAPI.getChatHistory(characterName);
  if (!history.length) {
    emptyEl.style.display = 'block';
    return;
  }
  for (const m of history) appendMsg(m.role, m.content, m.ts, m.imageDataURL);
}

// 全量重绘（编辑/删除后调用）；keepScroll 时恢复原滚动位置，避免编辑中间的消息后跳到底部
export async function reload(keepScroll = false) {
  const prevScroll = window.scrollY;
  list.innerHTML = '';
  view.msgCount = 0;
  await load();
  syncTempBubble(); // 整页重绘会把临时气泡也清掉，正在等回复的话补回去
  if (keepScroll) window.scrollTo(0, prevScroll);
}
