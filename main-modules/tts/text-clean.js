// ---------- 朗读文本清洗：把 AI 回复整理成"适合读出来"的文字 ----------
// prompt 里现在要求模型输出严格分符号：角色对话用「」包裹、内心独白用 *星号* 包裹、
// 没有符号的正文是旁白。朗读规则：
//   1. 只提取所有「对话」片段拼接成朗读文本（*内心独白* 和旁白整段丢弃，不读）
//   2. 不兜底：如果整条回复里一个完整的「」都没有（模型没按格式输出），直接返回空串，不朗读
//   3. 去掉 emoji、markdown 符号、波浪号、残留的【语气描述】（正常应已被 splitTone 摘掉，这里双重保险）
//   4. 换行折成停顿；清洗后没有任何可读字符 => 返回空串（调用方据此跳过合成）
//   5. 超长时在句末截断（TTS 服务有长度/超时限制，桌宠回复本来也只有 2-3 句）

const MAX_TTS_CHARS = 400;

// 把所有「对话」片段（不支持嵌套，「」本身就是最小引号单位）按出现顺序取出来
function extractQuoted(s) {
  const re = /「([^「」]*)」/g;
  const parts = [];
  let m;
  while ((m = re.exec(s))) {
    if (m[1]) parts.push(m[1]);
  }
  return parts;
}

function truncateAtSentence(s, max) {
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const m = /^[\s\S]*[。！？!?…]/.exec(head);
  return m && m[0].length >= max * 0.4 ? m[0] : head;
}

function prepareSpeechText(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw;

  s = s.replace(/\*\*([^*＊]+)\*\*/g, '$1'); // **强调** 保留文字

  const quoted = extractQuoted(s);
  if (!quoted.length) return ''; // 一个完整的「」都没有，说明模型没按格式输出，不兜底、直接不朗读
  s = quoted.join('，'); // 多段「」之间原本可能夹着被丢弃的旁白/内心独白，拼接时补个逗号当停顿，避免读起来挤在一起

  s = s.replace(/【[^【】]*】|\[[^[\]]*\]/g, ''); // 兜底：万一语气描述（全角【】或模型偶尔写成半角[...]）没被 splitTone 摘掉，这里再挡一层
  s = s.replace(/`+/g, '').replace(/~~/g, '');
  s = s.replace(/^[ \t]*(?:#{1,6}|>)[ \t]*/gm, ''); // 标题 / 引用行首标记
  s = s.replace(/[~～]+/g, '');
  s = s.replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '');

  s = s.trim();
  // 行尾没有标点的换行补一个逗号当停顿，已有标点的直接接上
  s = s.replace(/([^\n。！？!?.…，,、；;：:])[ \t]*\n+[ \t]*/g, '$1，');
  s = s.replace(/\s*\n+\s*/g, '');
  s = s.replace(/[ \t\u3000]+/g, ' ');
  // 拼接/删符号后可能残留连续逗号或开头标点
  s = s.replace(/([，,、；;])\s*(?:[，,、；;]\s*)+/g, '$1');
  s = s.replace(/([。！？!?…])[，,、；;]+/g, '$1'); // 句末标点后紧跟拼接产生的逗号，去掉避免"。，"这种组合
  s = s.replace(/^[\s，,、；;：:]+/, '').trim();

  if (!/[\p{L}\p{N}]/u.test(s)) return '';
  return truncateAtSentence(s, MAX_TTS_CHARS);
}

module.exports = { MAX_TTS_CHARS, prepareSpeechText };
