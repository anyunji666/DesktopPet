// ---------------- AI 回复语音播放 ----------------
// 主进程把 AI 回复合成好音频后推 'play-tts'，这里负责播放：
//   · 复用 voiceAudio（与台词语音同一通道：菜单静音、切角色停播、压低舞蹈音乐都自动生效）
//   · 气泡延长到语音结束（默认 5 秒，2-3 句话读出来可能十几秒，不延长的话气泡会先消失）
import { showBubble, playVoice } from './ui.js';

const BUBBLE_TAIL_MS = 1500; // 语音结束后气泡再多留一会儿
const BUBBLE_MAX_MS = 40000;
const BUBBLE_MIN_MS = 5000;

let currentUrl = null;
function releaseUrl() {
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = null;
  }
}

export function initTtsPlayback() {
  window.petAPI.onPlayTts(({ bytes, mime, text }) => {
    releaseUrl();
    const url = URL.createObjectURL(new Blob([bytes], { type: mime || 'audio/mpeg' }));
    currentUrl = url;
    // 用 reply 原文重新显示一次气泡：即使语音比"文字气泡"先到（或气泡已被点击台词覆盖），
    // 屏幕上显示的也总是正在朗读的这段话
    showBubble(text, BUBBLE_MIN_MS);
    playVoice(url, {
      onMetadata: (duration) => {
        // 部分 mp3 没有时长头，duration 可能是 Infinity：按字数粗估（约 0.28 秒/字）
        const sec = Number.isFinite(duration) && duration > 0 ? duration : text.length * 0.28;
        const ms = Math.min(BUBBLE_MAX_MS, Math.max(BUBBLE_MIN_MS, sec * 1000 + BUBBLE_TAIL_MS));
        showBubble(text, ms);
      },
      onEnd: () => {
        if (currentUrl === url) releaseUrl();
      },
    });
  });
}
