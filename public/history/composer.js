// ---------------- 底部输入条：发送文字 / 图片 ----------------
// 选文件 / 粘贴 -> 压缩 -> 预览，随下一条消息一起发出。语音输入见 voice-input.js。
import { characterName, chatInput, micBtn } from './state.js';
import { lock, PENDING_PLACEHOLDER, pendingPhase, onPendingChange } from './pending.js';
import { alertError } from './toast.js';

const sendBtn = document.getElementById('send-btn');
const imgBtn = document.getElementById('img-btn');
const imgFile = document.getElementById('img-file');
const imgPreview = document.getElementById('img-preview');
const imgPreviewEl = document.getElementById('img-preview-el');
const imgRemove = document.getElementById('img-remove');

let sending = false; // 本窗口刚点了发送、等主进程回复中（推送还没到时也能立刻拦住重复发送）

// 发送要不要锁：本窗口刚发出 / 任何窗口在等回复都锁（全局一把锁）
export const isSendLocked = () => sending || !!lock.pending;

// 把发送锁刷到输入条上：输入框 / 发送 / 🎙 / 📷 禁用，placeholder 提示原因
export function applyComposerLock() {
  const sl = isSendLocked();
  chatInput.disabled = sl;
  sendBtn.disabled = sl;
  micBtn.disabled = sl;
  imgBtn.disabled = sl;
  if (sl) chatInput.placeholder = PENDING_PLACEHOLDER[pendingPhase()];
  else chatInput.placeholder = micBtn.classList.contains('recording') ? '正在听，点击⏹停止…' : '想对TA说点什么…';
}
onPendingChange(applyComposerLock);

// ---------------- 发送图片：选文件 / 粘贴 -> 压缩 -> 预览，随下一条消息一起发出 ----------------
let pendingImage = null; // dataURL，发送前暂存

function setPendingImage(dataURL) {
  pendingImage = dataURL;
  if (dataURL) {
    imgPreviewEl.src = dataURL;
    imgPreview.classList.add('show');
  } else {
    imgPreview.classList.remove('show');
  }
}

async function acceptImageFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  try {
    setPendingImage(await window.imageUtils.fileToCompressedDataURL(file));
    chatInput.focus();
  } catch (err) {
    alertError(err);
  }
}

imgBtn.addEventListener('click', () => imgFile.click());
imgFile.addEventListener('change', async () => {
  await acceptImageFile(imgFile.files && imgFile.files[0]);
  imgFile.value = ''; // 允许连续选同一个文件
});
imgRemove.addEventListener('click', () => setPendingImage(null));
// 输入框里直接 Ctrl+V 粘贴截图
chatInput.addEventListener('paste', async (e) => {
  const file = window.imageUtils.imageFileFromPaste(e);
  if (!file) return;
  e.preventDefault();
  await acceptImageFile(file);
});

// ---------------- 发送 ----------------
async function sendMessage() {
  const text = chatInput.value.trim();
  const image = pendingImage;
  if ((!text && !image) || isSendLocked() || !characterName) return;
  sending = true;
  chatInput.value = '';
  const sendingImage = image; // 下面马上清预览，先存住
  setPendingImage(null);
  applyComposerLock();

  // 用户消息的临时气泡、落盘后的正式消息，都由主进程的 chat-pending-changed / chat-settled 事件驱动
  // （主界面发起的对话走完全一样的路径），这里只管发出去、失败时提示
  try {
    await window.petAPI.chatSend(characterName, text, sendingImage);
  } catch (err) {
    // 失败时主进程已经解锁并推了 chat-settled(ok=false)，临时气泡会被移除，磁盘上什么都没有多
    alertError(err);
    // 失败时把文字和图片都放回输入框/预览区，方便直接重发（主进程那边已经把没落盘的图片文件删掉了）
    if (text && !chatInput.value) chatInput.value = text;
    if (sendingImage) setPendingImage(sendingImage);
  } finally {
    sending = false;
    applyComposerLock();
    if (!chatInput.disabled) chatInput.focus();
  }
}

// 重新生成用：把一条旧的用户输入（文字 + 图片）放进输入框/预览区，再按正常发送流程发出去。
// 走 sendMessage 的好处：发送失败时文字和图片会自动放回输入框，不会丢
export function resendMessage(text, imageDataURL) {
  chatInput.value = text || '';
  setPendingImage(imageDataURL || null);
  return sendMessage();
}

sendBtn.addEventListener('click', sendMessage);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    sendMessage();
  }
});
