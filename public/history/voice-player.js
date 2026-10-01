// ---------------- 双击 AI 气泡重听回复语音 ----------------
// 语音由主进程在回复合成时按这条 AI 消息的 ts 缓存到磁盘（chat-store 的 saveChatVoice）；这里双击气泡时向主进程取，
// 在聊天记录窗口自己的 Audio 里播放，不走宠物窗口（不受宠物静音 / 跳舞状态影响）。
//   · 播放节奏和宠物窗口一致：每段播放前按阅读时间线调度（clip-schedule.js），播完才进下一段；老缓存没有 readOffsetMs 时退回 gapBeforeMs
//   · 没有缓存语音的气泡（没调用过 TTS / 老消息 / 用户消息）双击没有反应
//   · 编辑过的气泡仍然播原来的语音（语音按 ts 挂在消息上，和文字内容无关）
//   · 再双击正在播的那条 = 停止；双击另一条 = 先停掉前一条再播
import { characterName, list } from './state.js';
import { createClipScheduler } from '../clip-schedule.js';

let runId = 0; // 当前播放任务的编号；stopReplay 递增它，旧任务醒来发现对不上就自行退出
let wakeCurrent = null; // 当前在等的东西（停顿计时 / 一段语音播完）的唤醒函数，停止时用来立刻叫醒
let audio = null;
let currentUrl = null;
let playingTs = null; // 正在重听的那条消息的 ts

function releaseUrl() {
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = null;
  }
}

export function stopReplay() {
  runId++;
  playingTs = null;
  if (audio) {
    audio.onended = audio.onerror = null;
    audio.pause();
    audio = null;
  }
  releaseUrl();
  if (wakeCurrent) {
    const wake = wakeCurrent;
    wakeCurrent = null;
    wake();
  }
}

// 等一件事发生：register(done) 里安排"什么时候调 done"；stopReplay 也会调 done 把它叫醒
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
const playClip = (url) =>
  pause((done) => {
    const a = new Audio(url);
    audio = a;
    a.onended = a.onerror = done;
    a.play().catch(done); // 播放被拒绝 / 解码失败：跳过这一段，不卡住后面的
  });

async function runClips(clips, id) {
  const waitBefore = createClipScheduler();
  for (const clip of clips) {
    const wait = waitBefore(clip);
    if (wait > 0) {
      await sleep(wait);
      if (id !== runId) return;
    }
    currentUrl = URL.createObjectURL(new Blob([clip.bytes], { type: clip.mime || 'audio/mpeg' }));
    await playClip(currentUrl);
    if (id !== runId) return; // 被停止：stopReplay 已经回收过 URL
    releaseUrl();
  }
  if (id === runId) {
    playingTs = null;
    audio = null;
  }
}

async function toggleReplay(ts) {
  if (playingTs === ts) {
    stopReplay();
    return;
  }
  stopReplay();
  const id = runId;
  let voice;
  try {
    voice = await window.petAPI.getChatVoice(characterName, ts);
  } catch {
    return;
  }
  if (id !== runId || !voice || !Array.isArray(voice.clips) || !voice.clips.length) return; // 取的期间又双击了别处 / 没有缓存语音
  playingTs = ts;
  runClips(voice.clips, id);
}

// 只有 AI 气泡响应；临时气泡（等回复中）、正在编辑的气泡、气泡上的按钮 / 输入框都不触发
function replayRow(e) {
  const row = e.target.closest('.msg.assistant');
  if (!row || row.classList.contains('sending') || row.classList.contains('editing')) return null;
  if (e.target.closest('button, textarea, .edit-btns')) return null;
  return row;
}

// 双击默认会选中一个词：第二下按下时就拦掉默认行为，免得每次重听都先闪一下选区（单击拖选、三击选段不受影响）
list.addEventListener('mousedown', (e) => {
  if (e.detail === 2 && replayRow(e)) e.preventDefault();
});

list.addEventListener('dblclick', (e) => {
  const row = replayRow(e);
  if (!row || !row.dataset.ts) return;
  const ts = Number(row.dataset.ts);
  if (!Number.isFinite(ts)) return;
  const sel = window.getSelection();
  if (sel) sel.removeAllRanges();
  toggleReplay(ts);
});
