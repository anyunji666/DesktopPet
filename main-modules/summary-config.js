// ---------- 总结相关的数值常量（不提供界面设置，要调整只改这一处） ----------
// 历史分三层发给模型：大总结（对话总览 / 剧情总览）→ 小总结 → 还没压缩的内容（故事模式是逐轮摘要，网聊模式是原文）+ 最近几轮原文。
// 压缩规则：不含"最近 RECENT_RAW_ROUNDS 轮"的未压缩部分字数超过 COMPACT_TRIGGER_CHARS，回复落档后在后台压成一条小总结；
// 小总结累计超过 MERGE_THRESHOLD_CHARS，接着并进大总结。

module.exports = {
  // 未压缩部分（不含最近 N 轮）超过这个字数就压缩一次
  COMPACT_TRIGGER_CHARS: 5000,
  // 一条小总结的目标长度（提示词要求不超过这个字数）
  SMALL_SUMMARY_TARGET_CHARS: 500,
  // 模型输出略超目标不算失败；超过这个长度才直接截断（只有空输出才算压缩失败）
  SMALL_SUMMARY_CUT_CHARS: 800,
  // 未并入大总结的小总结累计超过这个字数，就合并进大总结
  MERGE_THRESHOLD_CHARS: 2000,
  // 大总结的目标长度（提示词里写的上限）；手动保存 / 导入时的校验上限在 chat-store.js 的 STORY_OVERVIEW_MAX_CHARS
  OVERVIEW_TARGET_CHARS: 1200,
  // 始终保留原文、不参与压缩的最近轮数（一轮 = 用户一条 + AI 一条）
  RECENT_RAW_ROUNDS: 2,
  // 一次后台整理里最多连续压缩几条小总结（正常一次就够，攒了很多时才会用到）
  MAX_COMPACT_PER_RUN: 3,
};
