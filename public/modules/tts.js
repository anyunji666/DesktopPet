// ---------------- AI 回复语音播放 ----------------
// 主进程把 AI 回复按「」分段合成好、缓存一回合后，一次性推 'play-tts' { clips: [{ bytes, mime, gapBeforeMs, readOffsetMs }] }，
// 这里负责按顺序一段段播：
//   · 每段播放前按"阅读时间线"调度（见 clip-schedule.js）：读者读到这个「」、且上一段播完并留够气口后才起播，播完才进下一段
//   · 复用 voiceAudio（与台词语音同一通道：菜单静音、切角色停播、压低舞蹈音乐都自动生效）
//   · 气泡不在这里管：文字回复回来时 chat.js 已经显示过一次，语音只负责出声
//   · 队列随时可被作废（新回复到来 / 点击台词 / 切角色 / 开始跳舞退场）：见 cancelQueue 和 ui.js 的 setVoiceCancelHook
import { playVoice, canPlayVoice, setVoiceCancelHook } from './ui.js';
import { createClipScheduler } from '../clip-schedule.js';

let runId = 0; // 当前队列的编号；cancelQueue 递增它，旧队列的协程醒来发现编号对不上就自行退出
let wakeCurrent = null; // 当前正在等的东西（停顿计时 / 一段语音播完）的唤醒函数，作废时用来立刻叫醒
let currentUrl = null;

function releaseUrl() {
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = null;
  }
}

function cancelQueue() {
  runId++;
  releaseUrl();
  if (wakeCurrent) {
    const wake = wakeCurrent;
    wakeCurrent = null;
    wake();
  }
}

// 等一件事发生：register(done) 里安排"什么时候调 done"；cancelQueue 也会调 done 把它叫醒
function pause(register) {
  return new Promise((resolve) => {
    const done = () => {
      if (wakeCurrent === done) wakeCurrent = null;
      resolve();
    };
    wakeCurrent = done;
    register(done);
  });
}

const sleep = (ms) => pause((done) => setTimeout(done, ms));
const playClip = (url) => pause((done) => playVoice(url, { keepQueue: true, onEnd: done }));

async function runClips(clips, id) {
  const waitBefore = createClipScheduler();
  for (const clip of clips) {
    const wait = waitBefore(clip);
    if (wait > 0) {
      await sleep(wait);
      if (id !== runId) return;
    }
    // 跳舞 / 退场期间不播角色语音：停顿期间切到舞蹈了，剩下的整个丢掉
    if (!canPlayVoice()) return;
    currentUrl = URL.createObjectURL(new Blob([clip.bytes], { type: clip.mime || 'audio/mpeg' }));
    await playClip(currentUrl);
    if (id !== runId) return; // 播放途中被作废：cancelQueue 已经回收过 URL
    releaseUrl();
  }
}

export function initTtsPlayback() {
  setVoiceCancelHook(cancelQueue);
  window.petAPI.onPlayTts(({ clips }) => {
    cancelQueue(); // 上一条回复没播完的部分作废
    if (!Array.isArray(clips) || !clips.length || !canPlayVoice()) return;
    runClips(clips, runId);
  });
}
