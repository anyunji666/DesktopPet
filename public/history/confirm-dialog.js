// ---------------- 通用确认弹窗（替代 window.confirm，原因见 history.css 里 #confirm-dialog 的注释） ----------------
import { editLocked, onPendingChange } from './pending.js';

const confirmOverlay = document.getElementById('confirm-overlay');
const confirmMsg = document.getElementById('confirm-msg');
const confirmOk = document.getElementById('confirm-ok');
const confirmCancel = document.getElementById('confirm-cancel');
let confirmResolve = null;

export function confirmDialog(message) {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    confirmMsg.textContent = message;
    confirmOverlay.classList.remove('hidden');
    setTimeout(() => confirmOk.focus(), 50);
  });
}
function closeConfirm(result) {
  confirmOverlay.classList.add('hidden');
  if (confirmResolve) {
    const resolve = confirmResolve;
    confirmResolve = null;
    resolve(result);
  }
}
confirmOk.addEventListener('click', () => closeConfirm(true));
confirmCancel.addEventListener('click', () => closeConfirm(false));
// 点遮罩本身才算取消（点弹窗内部不算），mousedown/mouseup 都落在遮罩上才判定，避免拖选文字误关——跟插入弹窗一致
let confirmOverlayDownOnSelf = false;
confirmOverlay.addEventListener('mousedown', (e) => {
  confirmOverlayDownOnSelf = e.target === confirmOverlay;
});
confirmOverlay.addEventListener('mouseup', (e) => {
  if (confirmOverlayDownOnSelf && e.target === confirmOverlay) closeConfirm(false);
  confirmOverlayDownOnSelf = false;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !confirmOverlay.classList.contains('hidden')) closeConfirm(false);
});

// 等回复期间不允许改记录：删除/清空的确认弹窗直接取消
onPendingChange(() => {
  if (editLocked() && !confirmOverlay.classList.contains('hidden')) closeConfirm(false);
});
