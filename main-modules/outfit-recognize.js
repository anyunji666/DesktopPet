// ---------- 服饰识别：把一张图片 + 内置识别词发给已配置的 LLM，返回按模板填好的穿搭描述 ----------
// 只在「API 与全局设置」里勾选了「模型支持图片识别（vision）」时可用。
// 结果只回给页面填进描述框，不自动保存、不自动发给角色，用户看过 / 改过再保存。
const { getApiConfig } = require('./llm');
const { callLLM } = require('./llm-client');
const { OUTFIT_RECOGNIZE_PROMPT } = require('../public/outfit-prompt');

const MAX_IMAGE_DATAURL_CHARS = 14 * 1024 * 1024; // base64 后约 10MB 原图

// 有的模型会把结果包进 ``` 代码块，去掉外壳只留表格正文
function stripFence(text) {
  const t = String(text || '').trim();
  const m = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(t);
  return (m ? m[1] : t).trim();
}

async function recognizeOutfit(characterName, imageDataURL) {
  if (!getApiConfig().vision) {
    throw new Error('当前模型没有开启图片识别，请先在"⚙ API 与全局设置"里勾选"模型支持图片识别（vision）"，或者用"复制识别词"到别处识别');
  }
  if (typeof imageDataURL !== 'string' || !/^data:image\/[a-z0-9.+-]+;base64,/i.test(imageDataURL)) {
    throw new Error('请先给这套服饰上传图片');
  }
  if (imageDataURL.length > MAX_IMAGE_DATAURL_CHARS) throw new Error('图片过大');
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: OUTFIT_RECOGNIZE_PROMPT },
        { type: 'image_url', image_url: { url: imageDataURL } },
      ],
    },
  ];
  const reply = await callLLM(messages, `服饰识别 - ${characterName}`);
  return stripFence(reply);
}

module.exports = { recognizeOutfit };
