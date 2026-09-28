// ---------------- 聊天记录窗口：共享状态 ----------------
// 当前角色、几个各模块都要用的 DOM 引用，以及消息列表的渲染状态。
// 渲染状态放在 view 对象里（而不是各自 export let）：ES 模块里 import 进来的变量不能重新赋值，
// 包成对象属性，谁改了大家都能看到。
const params = new URLSearchParams(location.search);
export const characterName = params.get('character') || '';

export const list = document.getElementById('list');
export const emptyEl = document.getElementById('empty');
export const chatInput = document.getElementById('chat-input');
export const micBtn = document.getElementById('mic-btn');

export const view = {
  // 已渲染的消息条数：每行的 data-index 直接用主进程里记录数组的下标（渲染顺序 = 数组顺序），
  // 编辑/删除按这个索引回传主进程操作文件。
  msgCount: 0,
  loaded: false, // 首次历史消息是否已渲染完（没完成前收到的推送先记状态，完成后统一补上）
  reloadAfterLoad: false, // 首次加载期间已经有新消息落盘了，加载完要重读一遍
  tempEl: null, // 临时气泡（"发出还没回复"的那条用户消息）
};
