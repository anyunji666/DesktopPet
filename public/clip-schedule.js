// ---------------- 回复语音的起播调度（宠物窗口 modules/tts.js 和聊天记录窗口 history/voice-player.js 共用） ----------
// 把正文看成一条按阅读速度推进的"阅读时间线"：每个「」带一个 readOffsetMs（读者读到它大约是第几毫秒）。
// 起播时间 = max(读者读到这里的时刻, 上一段播完 + 最小气口)：
//   · 语音比阅读慢（常态）：上一段播放期间读者早已读过中间的旁白，只需等最小气口，不再把旁白时长叠加在语音后面
//   · 两个「」之间旁白很长：读者还没读到，就等到读到再播，节奏仍顺着正文走
// 时间线的 0 点 = 第一段起播的时刻 - 它自己的 readOffsetMs（第一段永远立刻播，不等）。
// 老缓存语音没有 readOffsetMs，退回旧逻辑：直接用 gapBeforeMs 当播放前的停顿。
export const MIN_GAP_MS = 300; // 与 text-clean.js 的 GAP_MIN_MS 保持一致

// 每次开始播一条回复就新建一个调度器；返回的函数在"上一段刚播完、准备播这一段之前"调用，返回还要等多少毫秒
export function createClipScheduler() {
  let origin = null; // 阅读时间线 0 点对应的 performance.now()
  return function waitBefore(clip) {
    const now = performance.now();
    const offset = clip.readOffsetMs;
    if (!Number.isFinite(offset)) return Math.max(0, Number(clip.gapBeforeMs) || 0);
    if (origin === null) {
      origin = now - offset;
      return 0;
    }
    return Math.max(MIN_GAP_MS, origin + offset - now);
  };
}
