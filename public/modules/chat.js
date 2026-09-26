// ---------------- AI 对话：双击呼出输入框 ----------------
// 跟台词气泡（ui.js 的 showBubble）是两套不同的东西：这里是 AI 对话输入框，
// 发送后的回复仍然通过气泡显示，历史消息列表在独立的聊天记录窗口里。
import { state } from './state.js';
import { showBubble } from './ui.js';
import { startRecording, stopRecording } from './mic.js';

const chatBox = document.getElementById('chat-box');
const chatInput = document.getElementById('chat-input');
const chatHistoryBtn = document.getElementById('chat-history-btn');
let chatBoxTimer = null;
let chatSending = false;

// ---------------- 语音输入：点击🎙开始，再点一下停止，识别文字实时写回输入框 ----------------
const micBtn = document.getElementById('mic-btn');

let voiceState = 'idle'; // idle -> starting -> recording -> idle（再次点击收尾）
let asrSessionId = null;

function resetChatBoxTimer() {
  clearTimeout(chatBoxTimer);
  chatBoxTimer = setTimeout(hideChatBox, 3000);
}
export function showChatBox() {
  chatBox.classList.add('show');
  chatInput.disabled = false;
  chatInput.focus(); // focus 事件里会清掉倒计时，只要输入框有光标就不会被自动收起
}
export function hideChatBox() {
  clearTimeout(chatBoxTimer);
  chatBox.classList.remove('show');
  chatInput.blur();
}

// 输入框/按钮上的鼠标操作不要冒泡到 document，否则会被当成"拖拽窗口"或触发右键菜单
chatBox.addEventListener('mousedown', (e) => e.stopPropagation());
chatBox.addEventListener('contextmenu', (e) => e.stopPropagation());

// 有光标（focus）时不倒计时；失焦后才开始 3 秒无操作自动收起
chatInput.addEventListener('focus', () => clearTimeout(chatBoxTimer));
chatInput.addEventListener('blur', () => {
  if (chatBox.classList.contains('show')) resetChatBoxTimer();
});
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    sendChatMessage();
  } else if (e.key === 'Escape') {
    hideChatBox();
  }
});

// ---------------- 发送图片：选文件 / 粘贴 -> 压缩 -> 内嵌小预览，随下一条消息一起发出 ----------------
// 跟 history.html 共用 image-utils.js；主窗口本身不展示消息列表（只靠气泡显示 AI 回复），
// 发出的图片落盘后能在聊天记录窗口里回看。
let pendingImage = null; // dataURL，发送前暂存
const imgBtn = document.getElementById('img-btn');
const imgFile = document.getElementById('img-file');
const imgPreview = document.getElementById('img-preview');
const imgPreviewEl = document.getElementById('img-preview-el');
const imgRemove = document.getElementById('img-remove');

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
  } catch (err) {
    showBubble('出错了：' + (err && err.message ? err.message : String(err)), 5000);
  } finally {
    chatInput.focus(); // 选图/粘贴后把焦点还给输入框：既方便继续打字，也顺带清掉自动收起的倒计时
  }
}

// 选图按钮点击到文件选择器弹出、用户选完之间有一段不确定的时间，先清掉倒计时防止中途被自动收起
imgBtn.addEventListener('click', () => {
  clearTimeout(chatBoxTimer);
  imgFile.click();
});
imgFile.addEventListener('change', async () => {
  await acceptImageFile(imgFile.files && imgFile.files[0]);
  imgFile.value = ''; // 允许连续选同一个文件
});
imgRemove.addEventListener('click', () => {
  setPendingImage(null);
  chatInput.focus();
});
// 输入框里 Ctrl+V 直接粘贴截图
chatInput.addEventListener('paste', async (e) => {
  const file = window.imageUtils.imageFileFromPaste(e);
  if (!file) return;
  e.preventDefault();
  await acceptImageFile(file);
});

// 文字输入框 / 语音识别结果，最终都走这一个函数把消息发给 LLM，共用"思考中"气泡 + 报错处理
async function sendToAI(text, image) {
  if ((!text && !image) || chatSending || !state.characterName) return;
  chatSending = true;
  hideChatBox();
  showBubble('……', 60000); // 思考中占位，回复/报错回来后会被下面的 showBubble 覆盖掉
  try {
    const reply = await window.petAPI.chatSend(state.characterName, text, image);
    showBubble(reply, 5000);
  } catch (err) {
    showBubble('出错了：' + (err && err.message ? err.message : String(err)), 5000);
    if (image) setPendingImage(image); // 失败时把图片放回预览，方便直接重发
  } finally {
    chatSending = false;
    chatInput.disabled = false;
  }
}

async function sendChatMessage() {
  const text = chatInput.value.trim();
  const image = pendingImage;
  if ((!text && !image) || chatSending || !state.characterName) return;
  chatInput.value = '';
  chatInput.disabled = true;
  const sendingImage = image; // 下面马上清预览，先存住
  setPendingImage(null);
  sendToAI(text, sendingImage);
}

// ---------------- 语音输入的状态流转：点击🎙 -> 开 ASR 会话 -> 开始录音；再点一下 -> 停止 ----------------
function setRecordingUI(on) {
  chatBox.classList.toggle('recording', on);
  micBtn.classList.toggle('recording', on);
  micBtn.textContent = on ? '⏹' : '🎙';
  micBtn.title = on ? '停止录音' : '语音输入';
  chatInput.placeholder = on ? '正在听，点击⏹停止…' : '想对TA说点什么…';
}

async function startVoiceInput() {
  if (voiceState !== 'idle' || chatSending) return;
  clearTimeout(chatBoxTimer); // 录音期间不能被"3秒无操作自动收起"打断
  voiceState = 'starting';
  setRecordingUI(true);
  let sessionId;
  try {
    sessionId = await window.petAPI.asrStart();
  } catch (err) {
    voiceState = 'idle';
    setRecordingUI(false);
    showBubble('语音识别出错：' + (err && err.message ? err.message : String(err)), 4000);
    return;
  }
  if (voiceState !== 'starting') {
    // 等 asrStart 返回的这段时间里已经被点了一下"停止"（stopVoiceInput 把状态推回了 idle），直接收尾不用再开麦
    window.petAPI.asrStop(sessionId);
    return;
  }
  asrSessionId = sessionId;
  try {
    await startRecording((chunk) => window.petAPI.asrSendChunk(sessionId, chunk));
    voiceState = 'recording';
  } catch (err) {
    // 多半是麦克风权限被拒绝
    window.petAPI.asrStop(sessionId);
    asrSessionId = null;
    voiceState = 'idle';
    setRecordingUI(false);
    showBubble('无法访问麦克风：' + (err && err.message ? err.message : String(err)), 4000);
  }
}

function stopVoiceInput() {
  if (voiceState === 'idle') return;
  if (voiceState === 'starting') {
    voiceState = 'idle'; // asrStart 还没返回；等它回来后 startVoiceInput 自己会看到状态不对而收尾
    setRecordingUI(false);
    return;
  }
  voiceState = 'idle';
  stopRecording();
  setRecordingUI(false);
  if (asrSessionId) window.petAPI.asrStop(asrSessionId);
  chatInput.focus(); // 识别文字已经留在输入框里，把光标还回去方便直接改字/回车发送
}

// 点击 🎙：idle 时开始录音，录音中再点一下就停止（跟微信按住说话不同，这里是点击切换）
function toggleVoiceInput() {
  if (voiceState === 'idle') startVoiceInput();
  else stopVoiceInput();
}

window.petAPI.onAsrPartial((sessionId, text) => {
  if (sessionId !== asrSessionId) return;
  chatInput.value = text; // 实时把中间识别结果显示在输入框里，让你看到正在识别什么
});
window.petAPI.onAsrFinal((sessionId, text) => {
  if (sessionId !== asrSessionId) return;
  asrSessionId = null;
  chatInput.value = (text || '').trim(); // 最终识别结果留在输入框里，自己看一眼再按 Enter/点发送
});
window.petAPI.onAsrError((sessionId, message) => {
  if (sessionId !== asrSessionId) return;
  asrSessionId = null;
  voiceState = 'idle';
  setRecordingUI(false);
  showBubble('语音识别出错：' + message, 4000);
});

// mousedown 阶段阻止默认的"点击按钮转移焦点"，输入框全程保持聚焦，
// 录音过程中和结束后都能立刻继续打字/回车发送
micBtn.addEventListener('mousedown', (e) => e.preventDefault());
micBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleVoiceInput();
});

chatHistoryBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (state.characterName) window.petAPI.openHistoryWindow(state.characterName);
});
