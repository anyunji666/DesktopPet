// ---------- AI 对话：一轮对话的完整流程 ----------
// 跨天总结 -> 剧情总览合并（日总结攒够字数时）-> 存图 -> 拼 prompt -> 调 LLM -> 落盘 -> 触发 TTS。
// 只管"这一轮怎么跑"：不碰 IPC、不上锁——上锁/解锁、校验角色名、把回复推给窗口都在 main.js 的 chat-send 里；
// 这里只在阶段变化时通过 chat-lock.js 的 setChatPhase 切换锁的阶段（总结 -> 合并总览 -> 等待回复），界面提示随之切换。
const { setChatPhase } = require('./chat-lock');
const { needsOverviewMerge, mergeCoolingDown, tryMergeStoryOverview } = require('./story-overview');
const {
  loadChatHistory,
  saveChatHistory,
  saveChatImage,
  deleteChatImage,
  loadDaySummary,
  saveDaySummary,
  appendMemoryLines,
} = require('./chat-store');
const { getApiConfig, buildPromptText, buildSummaryPrompt } = require('./llm');
const {
  splitTurnSummary,
  extractStoryTime,
  extractOverview,
  dayKeyOf,
  computeLastPastDayKey,
  flattenDayLines,
  parseSummaryAndMemory,
} = require('./history-flatten');
const { callLLM } = require('./llm-client');
const { getChatMode } = require('./chat-mode');
const { speakReply } = require('./tts');
const { stripTones, stripSpeakers } = require('./tts/tone');

// 一轮对话的完整流程：跨天总结 -> 合并剧情总览 -> 存图 -> 拼 prompt -> 调 LLM -> 落盘 -> 触发 TTS。
// 成功返回 { reply, committed, startIndex }；任何一步抛错都不会落历史。
// imageDataURL 可选：用户随这条消息发的图片（选文件/粘贴/截图）。图片会：
// 1) 存进 chat-history/images/<角色>/，消息里记文件名（记录窗口里能回看）
// 2) vision 开启时按 OpenAI 视觉格式随本轮消息直发给模型；关闭时只以 "[图片]" / 用户附言的文字形式进 prompt
// 报错时（总结/回复请求失败、超时等）本轮不落历史，已经存进磁盘的图片文件就成了没人引用的孤儿，
// 这里统一在失败时删掉；图片仍留在渲染进程里，界面会把它放回预览区方便直接重发
async function runChatTurn(characterName, text, imageDataURL, summaryPlan) {
  const imageHolder = { file: null }; // 已存盘、但还没写进聊天记录的图片文件名
  try {
    return await runChatTurnInner(characterName, text, imageDataURL, imageHolder, summaryPlan);
  } catch (err) {
    if (imageHolder.file) deleteChatImage(characterName, imageHolder.file);
    throw err;
  }
}

// 判断这一轮要不要先做"整理"：
//   1) 跨天总结：跨天了（本轮消息和历史最后一条不是同一天），"上一天"要往前挪一格，原文不再发送，
//      退之前得先把被挪出去的那天总结好、缓存起来（没缓存过才需要总结）；
//   2) 合并剧情总览：未并入总览的日总结超过 2000 字（见 story-overview.js）。刚生成完新日总结时在 runChatTurnInner 里判断；
//      这里只处理"日总结都齐了、但上次合并失败还欠着"的情况。
// 需要就返回 { dayToSummarize, dayLines, startPhase }（只欠合并时 dayToSummarize / dayLines 为 null），不需要返回 null。
// 纯同步、只读磁盘：chat-send 上锁前先调它，这样锁一开始就能带上正确的阶段（summarizing / merging / waiting），
// runChatTurnInner 再按这份结果去执行。
function planCrossDaySummary(characterName) {
  const history = loadChatHistory(characterName);
  if (!history.length) return null;
  const lastMsgDayKey = dayKeyOf(history[history.length - 1].ts || Date.now());
  if (dayKeyOf(Date.now()) !== lastMsgDayKey) {
    const dayToSummarize = computeLastPastDayKey(history, lastMsgDayKey);
    if (dayToSummarize && !loadDaySummary(characterName, dayToSummarize)) {
      const dayLines = flattenDayLines(characterName, history, dayToSummarize, getChatMode(characterName));
      if (dayLines.length) return { dayToSummarize, dayLines, startPhase: 'summarizing' };
    }
  }
  if (needsOverviewMerge(characterName, history) && !mergeCoolingDown(characterName)) {
    return { dayToSummarize: null, dayLines: null, startPhase: 'merging' };
  }
  return null;
}

async function runChatTurnInner(characterName, text, imageDataURL, imageHolder, summaryPlan) {
  const history = loadChatHistory(characterName);

  // === 跨天总结 + 合并剧情总览 ===
  // 这两次调用和下面生成回复的调用串行执行，不并发。
  // 日总结失败了（网络/接口报错）直接抛出去，本轮不生成回复、不落历史，跟 callLLM 本身失败的表现一致；
  // 合并总览失败不抛：水位线不动，那几天的日总结照常发送，下次再试（见 story-overview.js）。
  // 日总结落盘后，如果未并入总览的日总结超过 2000 字，紧接着合并一次（"当日总结字数到了就跟着做大总结"），然后才去生成回复。
  // 每个阶段结束都把锁切到下一个阶段，界面提示随之切换。
  if (summaryPlan) {
    if (summaryPlan.dayToSummarize) {
      const { dayToSummarize, dayLines } = summaryPlan;
      const summaryPrompt = buildSummaryPrompt(dayToSummarize, dayLines, getChatMode(characterName));
      const rawSummary = await callLLM(
        [{ role: 'user', content: summaryPrompt }],
        `总结生成 - ${characterName}`
      );
      const { summary, memoryLines } = parseSummaryAndMemory(rawSummary);
      saveDaySummary(characterName, dayToSummarize, summary || rawSummary.trim());
      if (memoryLines.length) appendMemoryLines(memoryLines, getChatMode(characterName)); // 提炼出的要求记进当前模式自己的那份
    }
    if (needsOverviewMerge(characterName, history)) {
      setChatPhase('merging');
      await tryMergeStoryOverview(characterName, history);
    }
    setChatPhase('waiting');
  }

  // === 存图并拼 prompt ===
  // 先落图片文件，再拼 prompt（vision 模式需要 dataURL，拼完就能丢掉）
  let imageFile = null;
  if (imageDataURL) imageFile = saveChatImage(characterName, imageDataURL);
  imageHolder.file = imageFile;

  // 摊平历史时本轮图片还没进 history，这里给 user_input 的文字部分兜底：
  // 和 flattenChatHistory 里历史消息的处理方式一致，带图就标 [图片:文件名]，有配文字再拼在后面
  const imageTag = imageFile ? `[图片:${imageFile}]` : '';
  const inputText = imageTag ? (text ? `${imageTag} ${text}` : imageTag) : text;
  const promptText = buildPromptText(characterName, history, inputText);

  // vision 开启且带了图：文字 + 图片按 OpenAI 视觉 content 数组发送
  const messages = [{ role: 'user', content: promptText }];
  if (imageFile && getApiConfig().vision) {
    messages[0].content = [
      { type: 'text', text: promptText },
      { type: 'image_url', image_url: { url: imageDataURL } },
    ];
  }

  // === 调 LLM 并拆解回复 ===
  // 回复末尾会带一个 <story_overview> 摘要块（给历史轮次压缩用）；配音语气则写在正文每个「」里面、台词前面
  // （例：「【嗔怪，语速偏快】你不要过来～」），和摘要块的位置互不影响。
  const rawReply = await callLLM(messages, `对话回复 - ${characterName}`);
  const { body: replyBody, summaryBlock: rawSummaryBlock } = splitTurnSummary(rawReply);
  // 对话模式不要求摘要块；模型万一还是写了也丢掉，不落档（聊天记录里不出现故事时间标签）
  const summaryBlock = getChatMode(characterName) === 'chat' ? '' : rawSummaryBlock;
  // 摘要块 / 语气都不该进气泡、聊天记录、IPC 返回值：reply 是摘掉所有语气后的干净正文，气泡 / 返回值 / 落档都用它；
  // replyBody 还带着逐句语气，只给朗读用（TTS 按「」拆出每段自己的语气）
  const replyKeepSpeakers = stripTones(characterName, replyBody); // 去了语气、还带说话者前缀：落档 / 回传给模型用
  const reply = stripSpeakers(replyKeepSpeakers); // 再去掉说话者前缀：气泡 / 聊天记录窗口 / IPC 返回值显示用

  // === 落盘 ===
  // 括号包裹的元指令/元回复不再在落档时过滤：聊天记录、聊天窗口、回填给模型的历史都保留原文。
  // "括号里的元交流不要总结进摘要"改由每回合摘要块的提示词约束（llm.js 的 SUMMARY_FOOTER）。
  const userContentForHistory = text;
  const replyTextForHistory = replyKeepSpeakers; // 存档保留说话者前缀：模型看到历史里带前缀，才会继续标注
  // 摘要块重新拼回存档内容末尾——flattenChatHistory 做轮次压缩要靠它才能把老轮次换成摘要；
  // 语气【】不拼回去，跟现在的设计一致：语气只给 TTS 用，不落档、也不发回模型
  const replyContentForHistory = summaryBlock ? `${replyTextForHistory}\n${summaryBlock}` : replyTextForHistory;
  // committed 是这轮"实际落盘"的消息（给聊天记录窗口用，内容和 get-chat-history 返回的一致：
  // 已去掉摘要块），startIndex 是它们在记录数组里的起始下标
  const startIndex = history.length;
  const committed = [];
  let assistantTs = null; // 这轮 AI 回复落盘消息的 ts：朗读合成好的语音按它存到这条消息名下；没存回复时为 null
  // 文字和图片都没有（空消息）就不占历史一条，直接跳过不存
  if (userContentForHistory || imageFile) {
    const ts = Date.now();
    history.push({ role: 'user', content: userContentForHistory, image: imageFile, ts });
    committed.push({ role: 'user', content: userContentForHistory, ts, imageDataURL: imageFile ? imageDataURL : undefined });
  }
  if (replyTextForHistory) {
    const ts = Date.now();
    assistantTs = ts;
    history.push({ role: 'assistant', content: replyContentForHistory, ts });
    // storyTime：摘要块里的故事时间，聊天记录窗口据此在气泡末尾打标签；摘要块没写就是空串
    committed.push({ role: 'assistant', content: reply, rawContent: replyContentForHistory, ts, storyTime: extractStoryTime(replyContentForHistory), summaryOverview: extractOverview(replyContentForHistory) });
  }
  saveChatHistory(characterName, history);
  imageHolder.file = null; // 已经写进聊天记录，之后再出任何问题都不能删这张图

  // === 朗读 ===
  // 朗读 AI 回复：不 await——文字气泡照常立即显示，语音合成好了再通过 'play-tts' 推给宠物窗口，同时缓存到这条消息名下。
  // 放在这里，主窗口和聊天记录窗口发起的对话都会走到，不用两处各接一遍
  // assistantTs 让语音合成好后能存到这条 AI 消息名下（聊天记录窗口双击气泡重听）
  speakReply(characterName, replyBody, assistantTs);

  return { reply, committed, startIndex };
}

module.exports = { planCrossDaySummary, runChatTurn };
