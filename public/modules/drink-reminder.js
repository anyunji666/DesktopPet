// ---------------- 喝水提醒 ----------------
// 主进程扫描 Character/<角色>/Time report/ 下的语音，随 init / switch-character 下发
// drinkReminders: [{ hour, text, url }]，到点后头顶气泡显示台词并播放对应语音。
// 只在有语音的时间点提醒（8/9/10/11/14/15/16/17/20/21/22 点，不是每个整点都有），所以叫"喝水提醒"而不是"整点报时"。
//   · 每个时间点只提醒一次；"提醒过"以语音【完整播完】为准——中途被打断（切舞 / 切角色 / 点台词 / AI 回复语音到来）
//     不算数，补报窗口内会继续重试，打断时提醒气泡也一并收起。记录在模块内，切角色不会重复提醒同一小时
//   · 错过时间点后 CATCHUP_MIN 分钟内仍会提醒（含宠物刚启动 / 舞蹈刚结束的补报），再晚就跳过
//   · 复用 playVoice 通道：菜单静音、切角色停播、静音期间只弹气泡不出声都自动生效
//   · 提醒是"低优先级插话"，下面任何一种情况都先让路，下个 tick 再试（见 isBusy）：
//     舞蹈 / 退场舞 · 模型或动作加载中 · AI 回复语音（合成中 / 排队 / 播放中）· 点击台词正在播 ·
//     正在等 AI 回复 · 正在语音输入（避免提醒外放被识别进输入框）· 头顶有普通气泡占着
import { showBubble, hideLowBubble, playVoice, canPlayVoice, isVoicePlaying } from './ui.js';
import { isTtsPlaying } from './tts.js';
import { isChatBusy, isVoiceInputActive } from './chat.js';
import { state } from './state.js';

const TICK_MS = 15000; // 检查间隔：比 1 分钟细，到点后最多迟十几秒
const CATCHUP_MIN = 10; // 时间点过后多少分钟内还允许提醒
const BUBBLE_MS = 8000; // 提醒台词一般 2~4 秒，气泡多留一点余量

let reminders = []; // 当前角色的提醒表
let enabled = true;
let lastKey = ''; // 已提醒完（或已放弃）的最后一次提醒标识 'YYYY-MM-DD|H'
let playing = false; // 提醒语音正在播（播完 / 被打断前不再重复触发）
let playStartedAt = 0;
const PLAYING_SAFETY_MS = 60000; // 兜底：万一既没收到播完也没收到打断，一分钟后强制解锁，别永久卡死

function currentKey(now) {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}|${now.getHours()}`;
}

// 现在不适合插话：只要有任何一路声音 / 交互在进行，或还没准备好播，就先等
function isBusy() {
  return (
    !state.mesh || // 模型还没加载好（启动 / 切角色中）
    state.loadingDance || // 动作加载中：这段时间 canPlayVoice 为 true，但动作就绪时会 stopVoice 把提醒掐掉
    !canPlayVoice() || // 舞蹈 / 退场舞
    isTtsPlaying() || // AI 回复语音：合成中 / 排队 / 播放中
    isVoicePlaying() || // 点击台词等其他语音正在播
    isChatBusy() || // 正在等 AI 回复（含跨天总结）
    isVoiceInputActive() // 正在语音输入：外放的提醒会被麦克风收进去
  );
}

function tick() {
  if (playing && Date.now() - playStartedAt > PLAYING_SAFETY_MS) playing = false;
  if (!enabled || playing || !reminders.length) return;
  const now = new Date();
  const key = currentKey(now);
  if (key === lastKey) return; // 这个小时已经处理过了（提醒完 / 放弃过）
  const reminder = reminders.find((r) => r.hour === now.getHours());
  if (!reminder) return;
  if (now.getMinutes() >= CATCHUP_MIN) {
    lastKey = key; // 错过太久，这个小时不再提醒
    return;
  }
  if (isBusy()) return; // 让路：下个 tick 再试
  // 气泡被普通气泡占着（等待回复 / AI 回复 / 点击台词 / 开机计时）就先不弹，下个 tick 再试
  if (!showBubble(reminder.text, BUBBLE_MS, { low: true })) return;
  playing = true;
  playStartedAt = Date.now();
  const started = playVoice(reminder.url, {
    // 播完（或这条语音文件本身出错）才算这个小时提醒过
    onEnd: () => {
      playing = false;
      lastKey = key;
    },
    // 被打断：不记为已提醒，补报窗口内重试；气泡一起收起（若已被别的气泡顶替则不动它）
    onInterrupt: () => {
      playing = false;
      hideLowBubble();
    },
  });
  if (!started) {
    playing = false;
    hideLowBubble();
  }
}

export function setDrinkReminders(list) {
  reminders = Array.isArray(list) ? list.filter((r) => r && r.url) : [];
}

export function setDrinkReminderEnabled(v) {
  enabled = v !== false;
}

export function initDrinkReminder() {
  window.petAPI.onDrinkReminderEnabled((v) => setDrinkReminderEnabled(v));
  setInterval(tick, TICK_MS);
  tick(); // 启动 / 切角色后立刻查一次：时间点刚过的话马上补报
}
