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
// 一次只能发一条：锁在主进程（chat-lock.js），这里的两个标志只是让界面立刻做出反应——
//   localSending：本窗口刚点了发送、等回复中（主进程的推送还没到时也能马上拦住第二次发送）
//   remoteBusy：主进程广播"有一条消息在等回复"（包括聊天记录窗口发的那条）
let localSending = false;
let remoteBusy = false;
// 主进程锁当前所处阶段：'summarizing' 跨天摘要整理中 / 'waiting' 等待回复；没人在等时为 null。
// 本窗口刚点发送、主进程推送还没到的那一瞬间也当作 'waiting'，推送到了再按真实阶段更新
let pendingPhase = null;
const isBusy = () => localSending || remoteBusy;

// 各阶段给人看的提示：气泡 / 输入框 placeholder
const PHASE_BUBBLE = {
  summarizing: '正在整理上一日对话内容，等待发送中…',
  waiting: '等待回复中…',
};
const PHASE_PLACEHOLDER = {
  summarizing: '正在整理上一日对话内容…',
  waiting: '等待回复中…',
};
const currentPhase = () => (pendingPhase === 'summarizing' ? 'summarizing' : 'waiting');
// 等回复期间的气泡：本窗口自己发的才显示（别的窗口发的，这里仍只收起输入框，不弹气泡）。
// 时间给足（10 分钟）：摘要 + 回复可能很久，不能中途自己消失；回复/报错回来后会被新的 showBubble 覆盖
function showPendingBubble() {
  showBubble(PHASE_BUBBLE[currentPhase()], 10 * 60 * 1000);
}

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
  applyBusyUI();
  if (chatInput.disabled) {
    resetChatBoxTimer(); // 正在等回复：输入框用不了、也拿不到焦点，靠倒计时自动收起
  } else {
    chatInput.focus(); // focus 事件里会清掉倒计时，只要输入框有光标就不会被自动收起
  }
}
export function hideChatBox() {
  clearTimeout(chatBoxTimer);
  chatBox.classList.remove('show');
  chatInput.blur();
}

// 等回复期间：输入框和🎙禁用，placeholder 提示原因；回复/报错后恢复。所有"能不能输入"都从这里统一决定
function applyBusyUI() {
  const busy = isBusy();
  chatInput.disabled = busy;
  micBtn.disabled = busy;
  if (busy) chatInput.placeholder = PHASE_PLACEHOLDER[currentPhase()];
  else chatInput.placeholder = chatBox.classList.contains('recording') ? '正在听，点击⏹停止…' : '想对TA说点什么…';
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
  if ((!text && !image) || isBusy() || !state.characterName) return;
  localSending = true;
  applyBusyUI();
  hideChatBox();
  showPendingBubble(); // 等待占位（随阶段变化），回复/报错回来后会被下面的 showBubble 覆盖掉
  try {
    const reply = await window.petAPI.chatSend(state.characterName, text, image);
    showBubble(reply, 5000);
  } catch (err) {
    showBubble('出错了：' + (err && err.message ? err.message : String(err)), 5000);
    // 失败时把文字和图片都放回输入框/预览区，方便直接重发（主进程那边已经把没落盘的图片文件删掉了）
    if (text && !chatInput.value) chatInput.value = text;
    if (image) setPendingImage(image);
  } finally {
    localSending = false;
    applyBusyUI();
  }
}

async function sendChatMessage() {
  const text = chatInput.value.trim();
  const image = pendingImage;
  if ((!text && !image) || isBusy() || !state.characterName) return;
  chatInput.value = '';
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
  applyBusyUI(); // placeholder 由它统一决定（等回复的提示优先于录音提示）
}

async function startVoiceInput() {
  if (voiceState !== 'idle' || isBusy()) return;
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

// 主进程广播：有消息在等回复（含聊天记录窗口发的）/ 已回复或报错解锁
window.petAPI.onChatPendingChanged((pending) => {
  remoteBusy = !!pending;
  pendingPhase = pending ? pending.phase || 'waiting' : null;
  if (remoteBusy) {
    if (voiceState !== 'idle') stopVoiceInput(); // 正在录音时别人发了消息：结束录音，识别出的文字留在输入框里
    if (!localSending) hideChatBox(); // 别的窗口发起的，跟自己发送时一样把输入框收起来
    if (localSending) showPendingBubble(); // 自己发的：阶段变了（摘要 -> 等回复）同步刷新气泡文字
  }
  applyBusyUI();
});
// 刚加载时可能已经有一条在等回复（比如渲染进程被重载过），查一次对齐状态
window.petAPI.getChatPending().then((pending) => {
  remoteBusy = !!pending;
  pendingPhase = pending ? pending.phase || 'waiting' : null;
  applyBusyUI();
});

chatHistoryBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (state.characterName) window.petAPI.openHistoryWindow(state.characterName);
});
