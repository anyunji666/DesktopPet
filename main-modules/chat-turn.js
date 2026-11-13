// ---------- AI 对话：一轮对话的完整流程 ----------
// （上一轮的后台整理还没跑完就先等它）-> 存图 -> 拼 prompt -> 调 LLM -> 落盘 -> 触发 TTS。
// 只管"这一轮怎么跑"：不碰 IPC、不上锁——上锁/解锁、校验角色名、把回复推给窗口都在 main.js 的 chat-send 里；
// 回复落档之后要不要压缩小总结 / 合并大总结，由 main.js 解锁后调 summarizer.js 的 startBackgroundCompaction 在后台处理，
// 这里只在"上一轮后台整理还没跑完"时通过 chat-lock.js 的 setChatPhase 切换锁的阶段（整理 -> 等待回复），界面提示随之切换。
const { setChatPhase } = require('./chat-lock');
const { getCompactionJob } = require('./summarizer');
const {
  loadChatHistory,
  saveChatHistory,
  saveChatImage,
  deleteChatImage,
} = require('./chat-store');
const { getApiConfig, buildPromptText } = require('./llm');
const {
  splitTurnSummary,
  extractStoryTime,
  extractOverview,
} = require('./history-flatten');
const { callLLM } = require('./llm-client');
const { getChatMode } = require('./chat-mode');
const { pickLibraryImage, withImageTag } = require('./image-library');
const { speakReply } = require('./tts');
const { stripTones, stripSpeakers } = require('./tts/tone');

// 一轮对话的完整流程：等上一轮后台整理 -> 存图 -> 拼 prompt -> 调 LLM -> 落盘 -> 触发 TTS。
// 成功返回 { reply, committed, startIndex }；任何一步抛错都不会落历史。
// imageDataURL 可选：用户随这条消息发的图片（选文件/粘贴/截图）。图片会：
// 1) 存进 chat-history/images/<角色>/，消息里记文件名（记录窗口里能回看）
// 2) vision 开启时按 OpenAI 视觉格式随本轮消息直发给模型；关闭时只以 "[图片]" / 用户附言的文字形式进 prompt
// 报错时（回复请求失败、超时等）本轮不落历史，已经存进磁盘的图片文件就成了没人引用的孤儿，
// 这里统一在失败时删掉；图片仍留在渲染进程里，界面会把它放回预览区方便直接重发
async function runChatTurn(characterName, text, imageDataURL) {
  const imageHolder = { file: null }; // 已存盘、但还没写进聊天记录的图片文件名
  try {
    return await runChatTurnInner(characterName, text, imageDataURL, imageHolder);
  } catch (err) {
    if (imageHolder.file) deleteChatImage(characterName, imageHolder.file);
    throw err;
  }
}

async function runChatTurnInner(characterName, text, imageDataURL, imageHolder) {
  // === 等上一轮的后台整理 ===
  // 上一轮回复后触发的小总结 / 大总结还没跑完：等它跑完再拼这一轮的 prompt，这样 prompt 里用的是压缩后的历史。
  // 后台整理失败不会抛到这里（summarizer.js 里兜住了），那段内容照常按原样发送。
  const job = getCompactionJob(characterName);
  if (job) {
    setChatPhase(job.stage === 'merge' ? 'merging' : 'summarizing');
    await job.promise;
    setChatPhase('waiting');
  }
  const history = loadChatHistory(characterName);

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
  // 回复末尾会带一个 <story_overview> 摘要块（给历史里较早的轮次替换原文用）；配音语气则写在正文每个「」里面、台词前面
  // （例：「【嗔怪，语速偏快】你不要过来～」），和摘要块的位置互不影响。
  const rawReply = await callLLM(messages, `对话回复 - ${characterName}`);
  const { body: rawReplyBody, summaryBlock: rawSummaryBlock } = splitTurnSummary(rawReply);
  // 图库标签：模型在回复开头写的 [img:类别/图片名] 在这里摘掉（气泡 / 朗读 / 返回值都用摘干净的正文），
  // 找到图就带上 dataURL 给聊天记录窗口显示，规范化后的标签落档时再补回（见下面的 replyTextForHistory）；找不到图只摘标签
  const imagePick = pickLibraryImage(characterName, rawReplyBody);
  const replyBody = imagePick.text;
  // 网聊模式不要求摘要块；模型万一还是写了也丢掉，不落档（聊天记录里不出现故事时间标签）
  const summaryBlock = getChatMode(characterName) === 'chat' ? '' : rawSummaryBlock;
  // 摘要块 / 语气都不该进气泡、聊天记录、IPC 返回值：reply 是摘掉所有语气后的干净正文，气泡 / 返回值 / 落档都用它；
  // replyBody 还带着逐句语气，只给朗读用（TTS 按「」拆出每段自己的语气）
  const replyKeepSpeakers = stripTones(characterName, replyBody); // 去了语气、还带说话者前缀：落档 / 回传给模型用
  const reply = stripSpeakers(replyKeepSpeakers); // 再去掉说话者前缀：气泡 / 聊天记录窗口 / IPC 返回值显示用

  // === 落盘 ===
  // 括号包裹的元指令/元回复不再在落档时过滤：聊天记录、聊天窗口、回填给模型的历史都保留原文。
  // "括号里的元交流不要总结进摘要"改由每回合摘要块的提示词约束（llm.js 的 SUMMARY_FOOTER）。
  const userContentForHistory = text;
  // 存档保留说话者前缀：模型看到历史里带前缀，才会继续标注；发过图的话正文前补回规范化的 [img:类别/图片名]，模型下一轮能看到自己发过什么
  const replyTextForHistory = replyKeepSpeakers ? withImageTag(imagePick.id, replyKeepSpeakers) : replyKeepSpeakers;
  // 摘要块重新拼回存档内容末尾——flattenChatHistory 要靠它才能把老轮次换成摘要，压缩字数也按摘要算；
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
    committed.push({ role: 'assistant', content: reply, rawContent: replyContentForHistory, imageDataURL: imagePick.imageDataURL, ts, storyTime: extractStoryTime(replyContentForHistory), summaryOverview: extractOverview(replyContentForHistory) });
  }
  saveChatHistory(characterName, history);
  imageHolder.file = null; // 已经写进聊天记录，之后再出任何问题都不能删这张图

  // === 朗读 ===
  // 朗读 AI 回复：不 await——文字气泡照常立即显示，语音合成好了再通过 'play-tts' 推给宠物窗口，同时缓存到这条消息名下。
  // 放在这里，主窗口和聊天记录窗口发起的对话都会走到，不用两处各接一遍
  // assistantTs 让语音合成好后能存到这条 AI 消息名下（聊天记录窗口双击气泡重听）
  speakReply(characterName, replyBody, assistantTs);

  // 桌宠头顶的小气泡只显示文字：发过图就把 [img:类别/图片名] 标签原样放在正文前面当提示；
  // 聊天记录窗口的气泡（committed）仍然是图片 + 摘掉标签的正文。朗读用的 replyBody 已摘掉标签，标签不会被读出来
  const bubbleReply = imagePick.id ? `[img:${imagePick.id}]\n${reply}` : reply;
  return { reply: bubbleReply, committed, startIndex };
}

module.exports = { runChatTurn };
