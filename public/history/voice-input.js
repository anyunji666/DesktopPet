// ---------------- 语音输入：点击🎙开始，再点一下停止，识别文字实时写回输入框（跟主窗口逻辑一致）----------------
import { startRecording, stopRecording } from '../modules/mic.js';
import { chatInput, micBtn } from './state.js';
import { onPendingChange } from './pending.js';
import { applyComposerLock, isSendLocked } from './composer.js';
import { alertError, showToast } from './toast.js';

let voiceState = 'idle'; // idle -> starting -> recording -> idle（再次点击收尾）
let asrSessionId = null;

function setRecordingUI(on) {
  micBtn.classList.toggle('recording', on);
  micBtn.textContent = on ? '⏹' : '🎙';
  micBtn.title = on ? '停止录音' : '语音输入';
  applyComposerLock(); // placeholder 由它统一决定（等回复的提示优先于录音提示）
}

async function startVoiceInput() {
  if (voiceState !== 'idle' || isSendLocked()) return;
  voiceState = 'starting';
  setRecordingUI(true);
  let sessionId;
  try {
    sessionId = await window.petAPI.asrStart();
  } catch (err) {
    voiceState = 'idle';
    setRecordingUI(false);
    alertError(err);
    return;
  }
  if (voiceState !== 'starting') {
    // 等 asrStart 返回的这段时间里已经被点了一下"停止"，直接收尾不用再开麦
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
    alertError(err);
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

window.petAPI.onAsrPartial((sessionId, text) => {
  if (sessionId !== asrSessionId) return;
  chatInput.value = text; // 实时把中间识别结果显示在输入框里
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
  showToast('语音识别出错：' + message);
});

// mousedown 阶段阻止默认的"点击按钮转移焦点"，输入框全程保持聚焦
micBtn.addEventListener('mousedown', (e) => e.preventDefault());
micBtn.addEventListener('click', () => {
  if (voiceState === 'idle') startVoiceInput();
  else stopVoiceInput();
});

// 录音中有消息发出去了（本窗口或主界面发的）：结束录音，识别出的文字留在输入框里
onPendingChange((p) => {
  if (p && voiceState !== 'idle') stopVoiceInput();
});
