// ---------------- 喝水提醒 ----------------
// 主进程扫描 Character/<角色>/Time report/ 下的语音，随 init / switch-character 下发
// drinkReminders: [{ hour, text, url }]，到点后头顶气泡显示台词并播放对应语音。
// 只在有语音的时间点提醒（8/9/10/11/14/15/16/17/20/21/22 点，不是每个整点都有），所以叫"喝水提醒"而不是"整点报时"。
//   · 每个时间点只提醒一次（记录在模块内，切角色不会重复提醒同一小时）
//   · 错过时间点后 CATCHUP_MIN 分钟内仍会提醒（含宠物刚启动 / 舞蹈刚结束的补报），再晚就跳过
//   · 复用 playVoice 通道：菜单静音、切角色停播、静音期间只弹气泡不出声都自动生效
//   · AI 回复语音正在播 / 正在跳舞时先让路，下个 tick 再试，直到超过补报窗口放弃
import { showBubble, playVoice, canPlayVoice } from './ui.js';
import { isTtsPlaying } from './tts.js';

const TICK_MS = 15000; // 检查间隔：比 1 分钟细，到点后最多迟十几秒
const CATCHUP_MIN = 10; // 时间点过后多少分钟内还允许提醒
const BUBBLE_MS = 8000; // 提醒台词一般 2~4 秒，气泡多留一点余量

let reminders = []; // 当前角色的提醒表
let enabled = true;
let lastKey = ''; // 已提醒过（或已放弃）的最后一次提醒标识 'YYYY-MM-DD|H'

function currentKey(now) {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}|${now.getHours()}`;
}

function tick() {
  if (!enabled || !reminders.length) return;
  const now = new Date();
  const key = currentKey(now);
  if (key === lastKey) return; // 这个小时已经处理过了（提醒过 / 放弃过）
  const reminder = reminders.find((r) => r.hour === now.getHours());
  if (!reminder) return;
  if (now.getMinutes() >= CATCHUP_MIN) {
    lastKey = key; // 错过太久，这个小时不再提醒
    return;
  }
  if (isTtsPlaying() || !canPlayVoice()) return; // 让路：下个 tick 再试
  lastKey = key;
  showBubble(reminder.text, BUBBLE_MS);
  playVoice(reminder.url);
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
