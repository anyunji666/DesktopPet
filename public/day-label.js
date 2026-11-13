// 等后台整理总结阶段的提示文案。主界面气泡/输入框（modules/chat.js）和聊天记录窗口（history/pending.js）共用，
// 两边显示同一句话。回复落档后，未压缩的聊天内容超过字数线会在后台压成小总结，小总结攒够字数再并进大总结；
// 用户在这期间发下一条消息时，要先等它整理完，这时显示这里的提示。

// waitingSend=true：气泡/临时消息用，带"等待发送中"；false：输入框 placeholder 用
export function summarizingHint(waitingSend) {
  return `正在整理聊天小总结${waitingSend ? '，等待发送中' : ''}…`;
}

// 小总结攒够字数、正在并进大总结（剧情总览 / 对话总览）的阶段提示
export function mergingHint(waitingSend) {
  return `正在整理总览${waitingSend ? '，等待发送中' : ''}…`;
}

// 各阶段统一取提示：phase = 'summarizing' | 'merging' | 其它（waiting）
export function phaseHint(phase, waitingSend) {
  if (phase === 'summarizing') return summarizingHint(waitingSend);
  if (phase === 'merging') return mergingHint(waitingSend);
  return '等待回复中…';
}
