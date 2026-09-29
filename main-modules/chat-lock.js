// ---------- AI 对话的"一次只能发一条"锁 ----------
// 主界面输入框和聊天记录窗口都能发消息，而一条消息从发出到回复落盘之间有一段不短的等待
// （LLM 请求 + 可能的跨天总结）。这期间：
//   1) 不允许再发第二条（两个窗口共用同一把锁，任何一边在等，另一边也发不了）
//   2) 不允许改动同一角色的聊天记录（编辑/插入/删除/清空），否则 chat-send 结尾整份落盘时会把改动覆盖掉
// 锁放在主进程，不依赖任何一个窗口自己的界面状态；界面上的禁用只是给人看的，真正的拦截在这里。
// 状态存在 state.chatPending 上，开始/结束都会广播给主窗口和聊天记录窗口，两边按钮据此联动。
// 锁内分两个阶段（phase），只影响界面上给人看的提示文案，不影响拦截规则：
//   'summarizing'：跨天了，正在先给某一天生成总结（这次 LLM 调用完才会去生成回复）。被总结的不一定是昨天：
//                  昨天是"上一个封印包"、保持展开，通常摘的是更早的一天，日期放在 summaryDay 里给界面显示
//   'waiting'    ：等待 LLM 回复（没有总结要做的对话从头到尾都是这个阶段）
const { state } = require('./state');

function sendTo(win, channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// 主窗口只需要知道"有人在等"，不用带上用户消息/图片
function lightPending(p) {
  return p ? { character: p.character, source: p.source, phase: p.phase, summaryDay: p.summaryDay } : null;
}

function broadcastPending() {
  const p = state.chatPending;
  sendTo(state.win, 'chat-pending-changed', lightPending(p));
  // 聊天记录窗口要拿去渲染那条"已发出、还在等回复"的临时气泡，所以带完整内容
  sendTo(state.historyWin, 'chat-pending-changed', p);
}

// 开始一轮对话：已经有一轮在等就抛错（这就是"一次只能发一条"的兜底），否则上锁并广播
// phase 是起始阶段：已知要先做跨天总结就传 'summarizing'，这样界面从一开始就显示对的提示，不会先闪一下"等待回复"
// summaryDay：phase 为 'summarizing' 时被总结的那天（YYYY-MM-DD），只用于界面提示
function beginChat({ character, source, user, imageDataURL, phase = 'waiting', summaryDay = null }) {
  if (state.chatPending) throw new Error('上一条消息还没有回复，请等它回复或报错后再发送');
  state.chatPending = { character, source, user, imageDataURL: imageDataURL || null, ts: Date.now(), phase, summaryDay };
  broadcastPending();
}

// 切换阶段并广播（比如总结整理完了，进入等待回复）。没有在等的对话、或阶段没变就什么都不做
function setChatPhase(phase) {
  const p = state.chatPending;
  if (!p || p.phase === phase) return;
  p.phase = phase;
  broadcastPending();
}

// 结束一轮对话（成功或失败都必须调用，chat-send 用 try/catch 保证）。
// 先把结果推给聊天记录窗口（让它去掉临时气泡、追加真正落盘的消息），再广播解锁。
// ok=true 时 committed 是这轮实际落盘的消息，startIndex 是它们在记录数组里的起始下标；
// 记录窗口拿 startIndex 跟自己已渲染的条数对一下，对不上就整页重读，不会错位。
function endChat({ ok, committed = [], startIndex = 0 }) {
  const p = state.chatPending;
  state.chatPending = null;
  if (p) sendTo(state.historyWin, 'chat-settled', { character: p.character, ok, committed, startIndex });
  broadcastPending();
}

function getChatPending() {
  return state.chatPending;
}

// 修改聊天记录前调用：这个角色正在等回复时抛错。只锁正在等回复的那个角色，其它角色的记录照常可改
function assertHistoryEditable(characterName) {
  if (state.chatPending && state.chatPending.character === characterName) {
    throw new Error('正在等待回复，暂时不能修改聊天记录');
  }
}

module.exports = { beginChat, endChat, setChatPhase, getChatPending, assertHistoryEditable };
