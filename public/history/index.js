// ---------------- 聊天记录窗口入口 ----------------
// 只做串联：加载各功能模块（各自注册自己的事件/订阅）、接主进程推送、首次加载。
// 模块依赖单向：state / toast ← pending ← {messages, composer, confirm-dialog} ←
// {voice-input（依赖 composer）, message-actions, header-menu（依赖 messages / confirm-dialog）} ← index；
// 没有模块反过来依赖入口，也没有循环 import。
import { characterName, view } from './state.js';
import { alertError } from './toast.js';
import { setChatPending } from './pending.js';
import { appendMsg, load, reload } from './messages.js';
import './composer.js';
import './voice-input.js';
import './message-actions.js';
import './confirm-dialog.js';
import './header-menu.js';

document.getElementById('title').textContent = '聊天记录 · ' + characterName;

// ---------------- 跟主进程同步"等回复"状态 ----------------
// 有消息发出去开始等回复 / 回复落盘或报错后解锁（payload 为 null）
window.petAPI.onChatPendingChanged((p) => setChatPending(p));

// 这轮结束：去掉临时气泡；成功的话追加真正落盘的消息（用户消息 + 回复）。
// 用主进程给的起始下标核对一下自己已渲染的条数，对不上（比如首次加载期间发生的）就整页重读，避免下标错位
window.petAPI.onChatSettled(async (data) => {
  if (!data || data.character !== characterName) return;
  setChatPending(null);
  if (!data.ok || !data.committed || !data.committed.length) return;
  if (!view.loaded) {
    view.reloadAfterLoad = true;
    return;
  }
  if (view.msgCount !== data.startIndex) {
    try {
      await reload();
      window.scrollTo(0, document.body.scrollHeight);
    } catch (err) {
      alertError(err);
    }
    return;
  }
  for (const m of data.committed) appendMsg(m.role, m.content, m.ts, m.imageDataURL);
});

// ---------------- 首次加载 ----------------
// 等历史消息真正渲染上屏后再上报，主进程据此恢复宠物窗口渲染，
// 避免过早恢复导致气泡内容被抢资源卡住、非要点一下窗口才显示；
// 万一取历史记录失败也照样上报，不靠主进程 5 秒兜底才恢复渲染
load()
  .catch((err) => alertError(err))
  .finally(async () => {
    view.loaded = true;
    window.petAPI.notifyHistoryContentReady();
    try {
      // 首次加载期间已经有对话落盘了：重读一遍，保证列表和磁盘一致
      if (view.reloadAfterLoad) await reload();
      // 窗口是在等回复的过程中打开的：补上那条临时气泡、把发送/编辑锁起来（之后的变化靠推送）
      setChatPending(await window.petAPI.getChatPending());
    } catch (err) {
      alertError(err);
    }
  });
