// ---------- API 配置 / Prompt 模板配置 / Prompt 拼装 ----------
// 只管"发给模型的 prompt 长什么样"和"配置存取"。历史怎么摊平在 history-flatten.js，
// 请求怎么发出去在 llm-client.js（它反过来依赖本文件的 getApiConfig，所以本文件不能 require 它）。
const { loadConfig, updateConfig } = require('./config');
const { loadPersona, loadStoryBackground, loadMemoryIndex } = require('./chat-store');
const { TONE_PROMPT, toneEnabled } = require('./tts/tone');
const { flattenChatHistory, formatMinuteTime, formatDayCN } = require('./history-flatten');
const { buildFestivalBlock } = require('./holiday');
const { generateToken, maskSecret, resolveSecretInput } = require('./security');

// ---------- API 配置（存进 config.json 的 apiConfig 字段，和角色/场景选择共用同一份配置文件） ----------

// 已保存过的 API 地址 + 密钥（设置窗口里 API Base URL 的下拉选择框用）。
// 每次保存设置时把当前 地址+密钥 记进来（同地址覆盖密钥并提到最前），最多留 MAX_API_PROFILES 条。
const MAX_API_PROFILES = 20;
// 地址比较时忽略首尾空白和末尾的斜杠：https://x.com/v1 和 https://x.com/v1/ 算同一条
function normApiUrl(u) {
  return String(u || '').trim().replace(/\/+$/, '');
}
function sanitizeApiProfiles(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const p of list) {
    if (!p || typeof p.api_url !== 'string') continue;
    const url = p.api_url.trim();
    const key = normApiUrl(url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ api_url: url, api_key: typeof p.api_key === 'string' ? p.api_key.trim() : '' });
  }
  return out.slice(0, MAX_API_PROFILES);
}

function getApiConfig() {
  const cfg = loadConfig().apiConfig;
  return {
    api_url: (cfg && cfg.api_url) || '',
    api_key: (cfg && cfg.api_key) || '',
    apiProfiles: sanitizeApiProfiles(cfg && cfg.apiProfiles),
    model: (cfg && cfg.model) || '',
    temperature: Number.isFinite(cfg && cfg.temperature) ? cfg.temperature : 0.9,
    max_tokens: Number.isFinite(cfg && cfg.max_tokens) ? cfg.max_tokens : 300,
    // 当前模型是否支持识图（vision）：开=图片按 OpenAI 视觉格式直发；关=图片只以文字说明进 prompt
    vision: !!(cfg && cfg.vision),
    // Gemini 多 Key 轮询中转要用的 Key 列表；非空时 main.js 会自动起本地中转服务
    llmRelayKeys: Array.isArray(cfg && cfg.llmRelayKeys) ? cfg.llmRelayKeys : [],
    // 上次中转服务实际分配到的端口：记住它，下次优先复用，不用每次都变
    llmRelayPort: Number.isInteger(cfg && cfg.llmRelayPort) ? cfg.llmRelayPort : null,
    // 本地中转的访问口令（自动生成，桌宠自己请求中转时由主进程自动带上，不需要用户填）
    relayToken: (cfg && typeof cfg.relayToken === 'string') ? cfg.relayToken : '',
  };
}

// 没有口令就生成一个并保存；已有的沿用
function ensureRelayToken() {
  const cur = getApiConfig();
  if (cur.relayToken) return cur.relayToken;
  const token = generateToken();
  saveApiConfig({ relayToken: token });
  return token;
}

// ---------- 给渲染进程看的版本：密钥一律遮罩 ----------
// 渲染进程（设置窗口）拿到的 api_key / 已保存列表里的 api_key / 中转 Key 都是遮罩后的字符串
// （形如 ••••abcd），真实密钥不离开主进程。保存时如果原样传回遮罩，resolveApiPatch 会还原成真实密钥。
function getApiConfigForRenderer() {
  const c = getApiConfig();
  return {
    api_url: c.api_url,
    api_key: maskSecret(c.api_key),
    apiProfiles: c.apiProfiles.map((p) => ({ api_url: p.api_url, api_key: maskSecret(p.api_key) })),
    model: c.model,
    temperature: c.temperature,
    max_tokens: c.max_tokens,
    vision: c.vision,
    llmRelayKeys: c.llmRelayKeys.map(maskSecret),
    llmRelayPort: c.llmRelayPort,
  };
}

// 渲染进程传来的保存请求 -> 还原遮罩后的补丁（只放行它有权改的字段，relayToken 不允许从渲染进程改）
function resolveApiPatch(patch) {
  const cur = getApiConfig();
  const out = { ...patch };
  delete out.relayToken;
  delete out.apiProfiles;

  const urlForMatch = typeof patch.api_url === 'string' ? patch.api_url : cur.api_url;
  const sameUrlProfile = cur.apiProfiles.find((p) => normApiUrl(p.api_url) === normApiUrl(urlForMatch));
  const candidates = [sameUrlProfile && sameUrlProfile.api_key, cur.api_key, ...cur.apiProfiles.map((p) => p.api_key)];
  if (typeof patch.api_key === 'string') out.api_key = resolveSecretInput(patch.api_key, candidates);

  if (Array.isArray(patch.llmRelayKeys)) {
    out.llmRelayKeys = patch.llmRelayKeys
      .map((k) => resolveSecretInput(typeof k === 'string' ? k : '', cur.llmRelayKeys))
      .filter(Boolean);
  }
  return out;
}

// 拉模型列表时表单里的 Key 可能是遮罩：还原成真实密钥（优先取和该地址对应的已保存密钥）
function resolveApiKeyForUrl(apiUrl, apiKey) {
  const cur = getApiConfig();
  const sameUrlProfile = cur.apiProfiles.find((p) => normApiUrl(p.api_url) === normApiUrl(apiUrl));
  return resolveSecretInput(apiKey, [sameUrlProfile && sameUrlProfile.api_key, cur.api_key, ...cur.apiProfiles.map((p) => p.api_key)]);
}

function saveApiConfig(patch) {
  const cur = getApiConfig();
  const next = {
    api_url: typeof patch.api_url === 'string' ? patch.api_url.trim() : cur.api_url,
    api_key: typeof patch.api_key === 'string' ? patch.api_key.trim() : cur.api_key,
    model: typeof patch.model === 'string' ? patch.model.trim() : cur.model,
    temperature: Number.isFinite(patch.temperature) ? patch.temperature : cur.temperature,
    max_tokens: Number.isFinite(patch.max_tokens) ? patch.max_tokens : cur.max_tokens,
    vision: typeof patch.vision === 'boolean' ? patch.vision : cur.vision,
    llmRelayKeys: Array.isArray(patch.llmRelayKeys)
      ? patch.llmRelayKeys.map((k) => (typeof k === 'string' ? k.trim() : '')).filter(Boolean)
      : cur.llmRelayKeys,
    llmRelayPort: Number.isInteger(patch.llmRelayPort) ? patch.llmRelayPort : cur.llmRelayPort,
    apiProfiles: cur.apiProfiles,
    relayToken: typeof patch.relayToken === 'string' && patch.relayToken ? patch.relayToken : cur.relayToken,
  };
  // 只有这次明确带了 api_url（即设置窗口点保存）才记进已保存列表；
  // 其它只改别的字段的调用（比如记录中转端口）不动这个列表
  if (typeof patch.api_url === 'string' && normApiUrl(next.api_url)) {
    const k = normApiUrl(next.api_url);
    next.apiProfiles = [
      { api_url: next.api_url, api_key: next.api_key },
      ...cur.apiProfiles.filter((p) => normApiUrl(p.api_url) !== k),
    ].slice(0, MAX_API_PROFILES);
  }
  updateConfig({ apiConfig: next });
  return next;
}

// 从已保存列表里删掉一条（只删这条历史记录，不影响当前正在用的 api_url / api_key）
function deleteApiProfile(url) {
  const cur = getApiConfig();
  const k = normApiUrl(url);
  const next = { ...cur, apiProfiles: cur.apiProfiles.filter((p) => normApiUrl(p.api_url) !== k) };
  updateConfig({ apiConfig: next });
  return next.apiProfiles;
}

// ---------- Prompt 模板配置（存进 config.json 的 promptConfig 字段，全局生效，不区分角色） ----------
function getPromptConfig() {
  const cfg = loadConfig().promptConfig;
  return {
    prefix: (cfg && typeof cfg.prefix === 'string') ? cfg.prefix : '',
    readerInfo: (cfg && typeof cfg.readerInfo === 'string') ? cfg.readerInfo : '',
  };
}

function savePromptConfig(patch) {
  const cur = getPromptConfig();
  const next = {
    prefix: typeof patch.prefix === 'string' ? patch.prefix : cur.prefix,
    readerInfo: typeof patch.readerInfo === 'string' ? patch.readerInfo : cur.readerInfo,
  };
  updateConfig({ promptConfig: next });
  return next;
}

// 固定拼在模板末尾的说明段落（不受用户配置影响，硬编码）
// 解释怎么读 <user_input> 的规则，故意不算进固定前缀区——紧跟在 <user_input> 后面才最直觉，
// 让模型读完最新输入马上看到"怎么解读它"，比隔着一大段固定说明再回头看更不容易漏看/记混
const INPUT_NOTE = `## **用户的输入说明**

- 带括号的内容是用户对 你 说的话——（元指令），亲爱的无所不能的 你 会动用所有能力满足用户
- 不带括号的内容就是用户在扮演他所设置的角色和 你 所扮演的角色互动`;

// 固定拼在模板末尾的说明段落（不受用户配置影响，硬编码）
const PROMPT_FOOTER = `## **必须遵守的强制性输出规则**

- **内容要求：** 
  - 没有接收到用户的元指令时不以旁白介入，评判角色行为
  - 不预叙后续发生之事：❌他不知道这将是最后一次、❌她浑然不觉将要发生什么
  - 场景动态推进：每轮的输出要有节奏，如果是无聊的日常故事可以大幅跳过一些天数，加点趣味性的事件。自由切换故事场景，避免故事停滞不前。
- **语言：** 简体中文
- **符号规范**（严格区分）：
  - 角色的对话：用「」包裹，例：「这个给你，别嫌弃呀」
  - 角色的内心独白：用*星号*包裹，例：*其实等你好久了*
  - 没有符号的是正文：描述环境、角色的动作神态等
  - 对用户的元指令的回答用括号包裹
  - 正文内容不要使用【】符号
- 「对话」内容灵活使用标点符号：
  - 句末拖长音：「不要嘛～」
  - 句末重音：「什么！」
  - 疑问/质疑：「是这样吗？」
- **正文字数：** 正文总字数不超过1200字，角色回复的对话内容的字数每段控制在 1~20 字。正文可以是单个字的简短对话回复，也可以是场景描绘里穿插着对话回复。
  - 示例：「你不要过来～」*怎么这样···*「真是服了你了～」小拳拳锤了一下{{user}}的胸口，还是默许了{{user}}的行为。
- **摘要模块：** 对本轮的正文内容进行一次总结。每次回复必须以摘要块结尾，缺失=不合格
  - 输出格式：
  <story_overview>
  故事时间: <本轮场景结束时故事里的时间，日期部分请写成"YYYY年M月D日"格式，后面可接具体时刻；会跟着"场景动态推进"跳跃（比如一下跳过几天），不是用户发消息的真实时间>
  概述: <按时间顺序列出本轮正文发生的关键事件及其造成的角色实际改变（关系/处境/认知），平铺直叙，不用比喻/形容词；无实质进展则留空，不超150字>
  </story_overview>
  - 摘要示例（仅供格式参考，具体内容需按当轮对话实际生成）：
  <story_overview>
  故事时间: 2026年9月27日 21:40
  概述: 女主借口漏水深夜造访男主公寓，实则想拖延离开、试探男主的态度；男主识破了这个借口，却仍配合她演下去，两人关系从单纯的房东房客多了一层暧昧的试探。
  </story_overview>`;

// 生成"某天聊天总结"用的 prompt：单独一次总结任务，不带角色人设/语气/输出格式那些约束，
// 避免总结文本也带上角色口癖，污染归档内容。前置词（prefix）是全局的、给 AI 本身设定身份用的，
// 跟 buildPromptText 一样带上，保持这次调用里模型对自己是谁的认知一致。具体措辞先占位，后续再调整。
function buildSummaryPrompt(characterName, dayKey, dayLines) {
  const { prefix } = getPromptConfig();
  const parts = [];
  if (prefix.trim()) parts.push(prefix.trim());
  parts.push(`以下是用户和角色"${characterName}"在 ${formatDayCN(dayKey)} 的对话记录：`);
  parts.push(dayLines.join('\n'));
  parts.push('');
  parts.push('请按下面的格式输出，两部分都要给：');
  parts.push('[总结]');
  parts.push('（不超过100字总结这天聊了什么；内容太多压不进100字就列几个要点，不需要覆盖所有细节，不要加"总结："前缀，不要用分点符号）');
  parts.push('[记忆]');
  parts.push('（这天对话里出现的、值得长期记住的用户偏好/重要设定，浓缩成标签风格的关键词/短语，不要写完整句子，一行一条，每条不超过20字；有时效性的约定/日程不算，没有就只写"无"）');
  return parts.join('\n');
}

// 按“酒馆式”单块模板拼装整份 prompt：
// 固定前缀（用户自定义前置文本 + <character_card> + <user_persona> + <memory_index>）
// --- 可变部分（<chat_history> + <user_input>）
// --- 尾部固定说明（用户输入说明 + 必须遵守的强制性输出规则，两段都紧跟在最新内容后面，强化权重）
function buildPromptText(characterName, history, text) {
  const { prefix, readerInfo } = getPromptConfig();
  const storyBackground = loadStoryBackground(characterName);
  const characterCard = loadPersona(characterName);
  const chatHistoryText = flattenChatHistory(characterName, history, text);
  const nowText = formatMinuteTime(Date.now());

  // 固定内容（前缀/世界背景/角色卡/用户设定/输出说明）全部前置且逐字节不变，聊天历史/本轮输入这些每次都在变的内容后置，
  // 这样发给 DeepSeek / Gemini 这类"自动前缀缓存"的 API 时，前面这一大段固定前缀才能被复用命中、省 token。
  const parts = [];
  if (prefix.trim()) parts.push(prefix.trim());
  parts.push('---');
  // 世界背景拼在角色资料前面，没填就不发这一段
  if (storyBackground.trim()) {
    parts.push(`<story_background>\n<!-- 故事的世界背景以及设定 -->\n${storyBackground.trim()}\n</story_background>`);
  }
  // 用户没填角色资料就不发这一段
  if (characterCard.trim()) {
    parts.push(`<character_card>\n<!-- 角色的设定资料。设计/扮演 该角色的行为对话时，要符合该角色的个性。 -->\n${characterCard}\n</character_card>`);
  }
  if (readerInfo.trim()) {
    parts.push(`<user_persona>\n<!-- 用户所扮演的角色设定资料 -->\n${readerInfo.trim()}\n</user_persona>`);
  }
  // hot 记忆索引：常驻的、只存"用户偏好/重要设定"这类没有时效性的长期结论的小索引，由跨天总结/滚动总结
  // 那次 LLM 调用顺带产出并追加，不需要每轮从全量历史里现猜。没内容就不发这一段
  const memoryIndex = loadMemoryIndex(characterName);
  if (memoryIndex.trim()) {
    parts.push(`<memory_index>\n<!-- 关于用户的长期记忆：偏好、重要设定等，需要一直记住并遵守 -->\n${memoryIndex.trim()}\n</memory_index>`);
  }
  parts.push('---');
  // ---- 以上是固定前缀，以下是每轮都会变化的内容 ----
  if (chatHistoryText.trim()) {
    parts.push(`<chat_history>\n<!-- 对话记录，按时间顺序排列；元时间指实际聊天日期，不同于故事时间 -->\n${chatHistoryText}\n</chat_history>`);
  }
  // 故事时间的星期 + 国际/中国节日（取自上一轮摘要的"故事时间"，解析不出日期就不发这一段）。
  // 每轮都会变，所以放在固定前缀之后、紧贴 user_input，不破坏前缀缓存
  const festivalBlock = buildFestivalBlock(history);
  if (festivalBlock) parts.push(festivalBlock);
  parts.push(`<user_input>\n<!-- 用户本轮最新输入，元时间 ${nowText} -->\n${text}\n</user_input>`);
  parts.push('---');
  parts.push(INPUT_NOTE);
  parts.push('---');
  // 输出规则挪到全篇末尾、紧跟在输入说明后面，让模型读完"这轮要看什么、怎么解读"之后
  // 立刻看到"必须怎么写"，强化权重；代价是这段固定内容不再享受前缀缓存（见上面 parts 顺序的注释），
  // 换来的是更贴近生成位置、更不容易被中间的长历史冲淡。
  // 当前角色的语音服务商支持语气指令（豆包 / MiMo）时，才要求 LLM 在对话内容后面写一句配音语气
  parts.push(toneEnabled(characterName) ? `${PROMPT_FOOTER}\n${TONE_PROMPT}` : PROMPT_FOOTER);

  return parts.join('\n\n');
}

module.exports = {
  getApiConfig,
  getApiConfigForRenderer,
  resolveApiPatch,
  resolveApiKeyForUrl,
  ensureRelayToken,
  saveApiConfig,
  deleteApiProfile,
  getPromptConfig,
  savePromptConfig,
  buildPromptText,
  buildSummaryPrompt,
};
