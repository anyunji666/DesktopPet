// ---------- API 与全局设置页面（settings.html） ----------
// 全局共用的配置都在这页：API 地址 / 密钥 / 模型、Prompt 前置文本、附加要求（故事模式 / 网聊模式各一份）、
// Gemini 轮询中转状态。只做表单读写与状态提示，落盘走 preload 暴露的 petAPI。
// 全局作用域写法（和页面内联脚本一致）：顶层 const / 函数直接暴露，不额外包 IIFE。
const $ = (id) => document.getElementById(id);
// 附加要求（故事模式 / 网聊模式各一份）：加载时记下原文与上限，保存时只有改过才提交
const MEMORY_FIELDS = {
  story: { input: 'memory_index', count: 'memory-count', msg: 'msg-memory', label: '故事模式附加要求', loaded: null },
  chat: { input: 'memory_index_chat', count: 'memory-count-chat', msg: 'msg-memory-chat', label: '网聊模式附加要求', loaded: null },
};

// 与后端 normalizeMemoryText 同一口径：每行去首尾空白、丢空行
function normalizeMemory(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join('\n');
}
function updateMemoryCount(mode) {
  const f = MEMORY_FIELDS[mode];
  const max = f.loaded ? f.loaded.maxChars : 200;
  const len = normalizeMemory($(f.input).value).length;
  const el = $(f.count);
  el.textContent = len + ' / ' + max;
  el.style.color = len > max ? '#e5534b' : '';
  el.style.fontWeight = len > max ? 'bold' : '';
}

// 状态提示：非错误类文案 2 秒后自动清空；err 常驻，等用户下次操作再被覆盖
let statusTimer = null;
function setStatus(text, cls) {
  const status = $('status');
  status.textContent = text || '';
  status.className = cls || '';
  if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
  if (text && cls !== 'err') {
    statusTimer = setTimeout(() => {
      status.textContent = '';
      status.className = '';
    }, 2000);
  }
}

// 就近提示：写到指定的 .msg 元素；非错误文案 2 秒后自动清空，err 常驻直到下次操作覆盖
const msgTimers = {};
function setMsg(id, text, cls) {
  const el = $(id);
  el.textContent = text || '';
  el.className = 'msg' + (cls ? ' ' + cls : '');
  if (msgTimers[id]) { clearTimeout(msgTimers[id]); msgTimers[id] = null; }
  if (text && cls !== 'err') {
    msgTimers[id] = setTimeout(() => {
      el.textContent = '';
      el.className = 'msg';
    }, 4000);
  }
}
const errText = (err) => (err && err.message ? err.message : String(err));

// 中转当前是否真的在跑（来自后端状态，不是 textarea 里有没有字）
let relayRunning = false;

function textareaHasKeys() {
  return $('llm_relay_keys').value.trim().length > 0;
}

// 按钮文字只在"真的在跑 且 textarea 里还有内容"时显示「停止」，
// 这样哪怕后台还没来得及停，只要把 textarea 清空，按钮也会立刻跳回「启动」
function updateRelayButton() {
  $('relay-toggle-btn').textContent = relayRunning && textareaHasKeys() ? '停止' : '启动';
}

function applyRelayStatus(status) {
  relayRunning = !!(status && status.running);
  $('relay-status-tip').textContent = relayRunning
    ? `已启动。API Base URL 可输入 http://127.0.0.1:${status.port}/v1 测试（API Key 可留空，访问口令由程序自动带上）。已保存的 Key 只显示末四位，不改动就保持原样`
    : '';
  updateRelayButton();
}

$('llm_relay_keys').addEventListener('input', updateRelayButton);

$('relay-toggle-btn').addEventListener('click', async () => {
  const btn = $('relay-toggle-btn');
  const wantStop = btn.textContent === '停止';
  const keysList = $('llm_relay_keys').value.split('\n').map((s) => s.trim()).filter(Boolean);
  // 没填内容时点「启动」什么也不做，不发请求也不切换按钮
  if (!wantStop && keysList.length === 0) return;

  btn.disabled = true;
  setMsg('msg-relay', '');
  try {
    // 只保存 llmRelayKeys 这一个字段，不影响 API Base URL / Key / 模型名等其它设置
    const result = await window.petAPI.saveApiConfig({ llmRelayKeys: wantStop ? [] : keysList });
    applyRelayStatus(result.relayStatus);
    setMsg('msg-relay', relayRunning ? '中转已启动' : '中转已停止', 'ok');
  } catch (err) {
    setMsg('msg-relay', '操作失败：' + errText(err), 'err');
  } finally {
    btn.disabled = false;
  }
});

// ---------- API Base URL 下拉：已保存的 地址+密钥 ----------
let apiProfiles = [];
const normUrl = (u) => String(u || '').trim().replace(/\/+$/, '');
// 主进程传来的密钥本身就是遮罩后的（••••abcd），这里直接显示
const maskKey = (k) => (k ? k : '无密钥');

function renderUrlList() {
  const box = $('url_list');
  box.innerHTML = '';
  if (!apiProfiles.length) {
    const empty = document.createElement('div');
    empty.className = 'combo-empty';
    empty.textContent = '还没有保存过的地址（点保存后会出现在这里）';
    box.appendChild(empty);
    return;
  }
  const current = normUrl($('api_url').value);
  for (const p of apiProfiles) {
    const item = document.createElement('div');
    item.className = 'combo-item' + (normUrl(p.api_url) === current ? ' active' : '');
    item.title = p.api_url;

    const url = document.createElement('span');
    url.className = 'url';
    url.textContent = p.api_url;

    const key = document.createElement('span');
    key.className = 'key';
    key.textContent = maskKey(p.api_key);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del';
    del.textContent = '✕';
    del.title = '删除这条保存的地址和密钥';
    let armTimer = null;
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      // 两步确认：第一次点变成"确认删除"，3 秒内再点才真删（密钥删了找不回来）
      if (!del.classList.contains('armed')) {
        del.classList.add('armed');
        del.textContent = '确认删除';
        armTimer = setTimeout(() => {
          del.classList.remove('armed');
          del.textContent = '✕';
        }, 3000);
        return;
      }
      clearTimeout(armTimer);
      setMsg('msg-url', '');
      try {
        apiProfiles = await window.petAPI.deleteApiProfile(p.api_url);
        renderUrlList();
      } catch (err) {
        setMsg('msg-url', '删除失败：' + errText(err), 'err');
      }
    });

    item.addEventListener('click', () => {
      $('api_url').value = p.api_url;
      $('api_key').value = p.api_key || '';
      closeUrlList();
    });

    item.append(url, key, del);
    box.appendChild(item);
  }
}

function closeUrlList() {
  $('url_list').classList.remove('show');
}

$('url_toggle').addEventListener('click', (e) => {
  e.stopPropagation();
  const box = $('url_list');
  if (box.classList.contains('show')) {
    closeUrlList();
  } else {
    renderUrlList();
    box.classList.add('show');
  }
});
document.addEventListener('click', (e) => {
  if (!$('url_combo').contains(e.target)) closeUrlList();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeUrlList();
});

async function load() {
  const cfg = await window.petAPI.getApiConfig();
  apiProfiles = cfg.apiProfiles || [];
  $('api_url').value = cfg.api_url || '';
  $('api_key').value = cfg.api_key || '';
  $('model').value = cfg.model || '';
  $('temperature').value = cfg.temperature;
  $('max_tokens').value = cfg.max_tokens;
  $('vision').checked = !!cfg.vision;
  $('llm_relay_keys').value = (cfg.llmRelayKeys || []).join('\n');
  applyRelayStatus(await window.petAPI.getRelayStatus());

  const promptCfg = await window.petAPI.getPromptConfig();
  $('prompt_prefix').value = promptCfg.prefix || '';

  for (const [mode, f] of Object.entries(MEMORY_FIELDS)) {
    try {
      const memory = await window.petAPI.getMemoryIndex(mode);
      f.loaded = { original: normalizeMemory(memory.text), maxChars: memory.maxChars };
      $(f.input).value = memory.text || '';
      updateMemoryCount(mode);
    } catch (err) {
      setMsg(f.msg, '加载' + f.label + '失败：' + errText(err), 'err');
    }
  }
}

for (const [mode, f] of Object.entries(MEMORY_FIELDS)) {
  $(f.input).addEventListener('input', () => {
    updateMemoryCount(mode);
    setMsg(f.msg, '');
  });
}

$('save-btn').addEventListener('click', async () => {
  // 附加要求超限先拦在最前面，别让其它设置存了一半才报错
  for (const f of Object.values(MEMORY_FIELDS)) {
    if (f.loaded && normalizeMemory($(f.input).value).length > f.loaded.maxChars) {
      setMsg(f.msg, f.label + '超过 ' + f.loaded.maxChars + ' 字上限，请删减后再保存', 'err');
      return;
    }
    setMsg(f.msg, '');
  }
  setStatus('保存中…', '');
  try {
    await window.petAPI.saveApiConfig({
      api_url: $('api_url').value,
      api_key: $('api_key').value,
      model: $('model').value,
      temperature: parseFloat($('temperature').value),
      max_tokens: parseInt($('max_tokens').value, 10),
      vision: $('vision').checked,
    });
    await window.petAPI.savePromptConfig({
      prefix: $('prompt_prefix').value,
    });
    // 附加要求：没改动就不提交（避免覆盖设置窗口开着期间 AI 自动追加的内容，也不会在有角色等回复时被锁误拦）
    for (const [mode, f] of Object.entries(MEMORY_FIELDS)) {
      if (!f.loaded) continue;
      const cur = normalizeMemory($(f.input).value);
      if (cur !== f.loaded.original) {
        await window.petAPI.saveMemoryIndex(cur, mode);
      }
    }
    // 保存成功：不需要绿色"已保存"文案停留，直接关闭设置窗口
    window.close();
  } catch (err) {
    setStatus('保存失败：' + (err && err.message ? err.message : String(err)), 'err');
  }
});

$('load-models-btn').addEventListener('click', async () => {
  const btn = $('load-models-btn');
  const select = $('model_select');
  btn.disabled = true;
  btn.textContent = '加载中…';
  setMsg('msg-models', '');
  try {
    // 直接用表单里当前填的值去拉，不强制先保存
    const list = await window.petAPI.fetchModelList($('api_url').value.trim(), $('api_key').value.trim());
    select.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = `共 ${list.length} 个模型，选一个：`;
    placeholder.disabled = true;
    placeholder.selected = true;
    select.appendChild(placeholder);
    for (const name of list) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    }
    select.classList.add('show');
    setMsg('msg-models', `已获取 ${list.length} 个模型，从下拉框里选一个`, 'ok');
  } catch (err) {
    select.classList.remove('show');
    setMsg('msg-models', '加载模型列表失败：' + errText(err), 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '🔄 加载模型';
  }
});

$('model_select').addEventListener('change', (e) => {
  if (e.target.value) $('model').value = e.target.value;
});

load();
