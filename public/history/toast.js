// ---------------- 页内提示条（代替 window.alert，见 history.css 里 #toast 的注释） ----------------
// kind: 'error' 红色 / 'info' 灰色
const toastEl = document.getElementById('toast');
let toastTimer = null;

export function showToast(message, kind = 'error', ms = 5000) {
  toastEl.textContent = message;
  toastEl.className = 'show' + (kind === 'info' ? ' info' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}
toastEl.addEventListener('mousedown', (e) => e.preventDefault()); // 点提示条不要让输入框失焦
toastEl.addEventListener('click', () => {
  clearTimeout(toastTimer);
  toastEl.classList.remove('show');
});

export function alertError(err) {
  showToast('出错了：' + (err && err.message ? err.message : String(err)));
}
