// ---------------- "一次只能发一条"的锁状态（跟主进程 chat-lock.js 同步）----------------
// 锁在主进程，这里只存一份镜像：lock.pending = 当前正在等回复的那轮对话
// { character, source, user, imageDataURL, ts, phase }，null = 空闲；全局共用一把锁，主界面在等也算。
// 各模块不直接互相调用来刷新界面，而是 onPendingChange 订阅：锁状态一变，每个模块各自刷新自己管的控件。
import { characterName } from './state.js';
import { showToast } from './toast.js';
import { summarizingHint } from '../day-label.js';

export const lock = { pending: null };

// 当前锁所处阶段：主进程推送的 phase；本窗口刚点发送、推送还没到的那一瞬间当作 waiting
export const pendingPhase = () => (lock.pending && lock.pending.phase === 'summarizing' ? 'summarizing' : 'waiting');

// 等回复期间各阶段的提示：临时气泡的时间处 / 输入框 placeholder。
// 总结阶段写具体日期（lock.pending.summaryDay），不能写"上一日"——被总结的通常是比昨天更早的一天
export const pendingText = () =>
  pendingPhase() === 'summarizing' ? summarizingHint(lock.pending.summaryDay, true) : '等待回复中…';
export const pendingPlaceholder = () =>
  pendingPhase() === 'summarizing' ? summarizingHint(lock.pending.summaryDay, false) : '等待回复中…';

// 改记录要不要锁：只锁"正在等回复的就是这个角色"的情况（发送要不要锁见 composer.js：任何窗口在等回复都锁）
export const editLocked = () => !!lock.pending && lock.pending.character === characterName;

export function notifyEditLocked() {
  showToast('正在等待回复，暂时不能修改聊天记录', 'info');
}

const listeners = [];
export function onPendingChange(fn) {
  listeners.push(fn);
}

// 有消息发出去开始等回复 / 回复落盘或报错后解锁（p 为 null）
export function setChatPending(p) {
  lock.pending = p;
  for (const fn of listeners) fn(p);
}
