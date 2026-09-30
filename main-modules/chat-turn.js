// ---------- AI 对话：一轮对话的完整流程 ----------
// 跨天总结 -> 存图 -> 拼 prompt -> 调 LLM -> 落盘 -> 触发 TTS。
// 只管"这一轮怎么跑"：不碰 IPC、不上锁——上锁/解锁、校验角色名、把回复推给窗口都在 main.js 的 chat-send 里；
// 这里只在跨天总结做完时通过 chat-lock.js 的 setChatPhase 把锁的阶段切到"等待回复"，界面提示随之切换。
const { setChatPhase } = require('./chat-lock');
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
  stripMetaForHistory,
  splitTurnSummary,
  extractStoryTime,
  dayKeyOf,
  computeLastPastDayKey,
  flattenDayLines,
  parseSummaryAndMemory,
} = require('./history-flatten');
const { callLLM } = require('./llm-client');
const { speakReply } = require('./tts');
const { splitTone } = require('./tts/tone');

// 一轮对话的完整流程：跨天总结 -> 存图 -> 拼 prompt -> 调 LLM -> 落盘 -> 触发 TTS。
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

// 判断这一轮要不要先做跨天总结：跨天了（本轮消息和历史最后一条不是同一天），"旧的上一个封存包"要从"上一个封存包"
// 退到"更早"了，退之前得先把那天总结好、缓存起来（没缓存过才需要总结）。
// 需要就返回 { dayToSummarize, dayLines }，不需要返回 null。纯同步、只读磁盘：chat-send 上锁前先调它，
// 这样锁一开始就能带上正确的阶段（summarizing / waiting），runChatTurnInner 再按这份结果去执行总结。
function planCrossDaySummary(characterName) {
  const history = loadChatHistory(characterName);
  if (!history.length) return null;
  const lastMsgDayKey = dayKeyOf(history[history.length - 1].ts || Date.now());
  if (dayKeyOf(Date.now()) === lastMsgDayKey) return null;
  const dayToSummarize = computeLastPastDayKey(history, lastMsgDayKey);
  if (!dayToSummarize || loadDaySummary(characterName, dayToSummarize)) return null;
  const dayLines = flattenDayLines(characterName, history, dayToSummarize);
  return dayLines.length ? { dayToSummarize, dayLines } : null;
}

async function runChatTurnInner(characterName, text, imageDataURL, imageHolder, summaryPlan) {
  const history = loadChatHistory(characterName);

  // === 跨天总结 ===
  // 这次总结调用和下面生成回复的调用串行执行，不并发；总结这次要是失败了（网络/接口报错），
  // 直接抛出去，本轮不生成回复、不落历史，跟 callLLM 本身失败的表现一致。
  // 总结落盘后把锁切到"等待回复"阶段，界面提示随之切换。
  if (summaryPlan) {
    const { dayToSummarize, dayLines } = summaryPlan;
    const summaryPrompt = buildSummaryPrompt(characterName, dayToSummarize, dayLines);
    const rawSummary = await callLLM(
      [{ role: 'user', content: summaryPrompt }],
      `总结生成 - ${characterName}`
    );
    const { summary, memoryLines } = parseSummaryAndMemory(rawSummary);
    saveDaySummary(characterName, dayToSummarize, summary || rawSummary.trim());
    if (memoryLines.length) appendMemoryLines(characterName, memoryLines);
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
  // 回复末尾会带一个 <story_overview> 摘要块（给历史轮次压缩用），摘要块前面可能还有一句【配音语气】。
  // 必须先摘掉摘要块，剩下的部分再拆语气——如果先拆语气，摘要块跟在语气后面，语气就不是字符串真正的
  // 末尾了，splitTone 那个"只匹配末尾"的正则会直接匹配失败，语气解析会静默失效。
  const rawReply = await callLLM(messages, `对话回复 - ${characterName}`);
  const { body: replyBody, summaryBlock } = splitTurnSummary(rawReply);
  // 摘要块 / 语气都不该进气泡、聊天记录、IPC 返回值：拆完之后 reply 就是干净正文，气泡 / TTS / 返回值都用它
  const { text: reply, tone } = splitTone(characterName, replyBody);

  // === 落盘 ===
  // 只过滤"落档/回填给模型下一轮"这份记录：括号包裹的元指令/元回复属于 OOC 内容，不算剧情，
  // 不应该沉淀进长期聊天记录、也不该在后续轮次里当成故事历史又发回模型。
  // 本轮气泡显示（下面的 reply）、TTS 朗读、这次 IPC 的返回值都仍然用未过滤的原文，用户照常能看到。
  const userContentForHistory = stripMetaForHistory(text);
  const replyTextForHistory = stripMetaForHistory(reply);
  // 摘要块重新拼回存档内容末尾——flattenChatHistory 做轮次压缩要靠它才能把老轮次换成摘要；
  // 语气【】不拼回去，跟现在的设计一致：语气只给 TTS 用，不落档、也不发回模型
  const replyContentForHistory = summaryBlock ? `${replyTextForHistory}\n${summaryBlock}` : replyTextForHistory;
  // committed 是这轮"实际落盘"的消息（给聊天记录窗口用，内容和 get-chat-history 返回的一致：
  // 已过滤 OOC、已去掉摘要块），startIndex 是它们在记录数组里的起始下标
  const startIndex = history.length;
  const committed = [];
  // 过滤后文字和图片都没有了，说明这一条整个是纯元指令/元回复的 OOC 对话，不值得占历史一条，直接跳过不存
  if (userContentForHistory || imageFile) {
    const ts = Date.now();
    history.push({ role: 'user', content: userContentForHistory, image: imageFile, ts });
    committed.push({ role: 'user', content: userContentForHistory, ts, imageDataURL: imageFile ? imageDataURL : undefined });
  }
  if (replyTextForHistory) {
    const ts = Date.now();
    history.push({ role: 'assistant', content: replyContentForHistory, ts });
    // storyTime：摘要块里的故事时间，聊天记录窗口据此在气泡末尾打标签；摘要块没写就是空串
    committed.push({ role: 'assistant', content: replyTextForHistory, ts, storyTime: extractStoryTime(replyContentForHistory) });
  }
  saveChatHistory(characterName, history);
  imageHolder.file = null; // 已经写进聊天记录，之后再出任何问题都不能删这张图

  // === 朗读 ===
  // 朗读 AI 回复：不 await——文字气泡照常立即显示，语音合成好了再通过 'play-tts' 推给宠物窗口。
  // 放在这里，主窗口和聊天记录窗口发起的对话都会走到，不用两处各接一遍
  speakReply(characterName, reply, tone);

  return { reply, committed, startIndex };
}

module.exports = { planCrossDaySummary, runChatTurn };
