// ---------- 角色与音色设置页面（character-voice-settings.html） ----------
// 按 URL 里的 character 编辑一个角色的两段内容：角色设定（世界背景 / 角色资料 / 别名 / 你的资料）和
// 音色设置（服务商 + 音色 + 语音识别）。只做表单读写与状态提示，落盘和 TTS / ASR 调用都走 preload 暴露的 petAPI。
// 全局作用域写法（和页面内联脚本一致）：顶层 const / 函数直接暴露，不额外包 IIFE。
const $ = (id) => document.getElementById(id);
// 这个窗口编辑的角色：菜单里点哪个角色就是哪个
const character = new URLSearchParams(location.search).get('character') || '';
document.title = '角色与音色设置 - ' + character;

// ipcRenderer.invoke 的异常消息带 "Error invoking remote method 'xxx': Error: " 前缀，去掉只留原因
function errText(err) {
  const m = err && err.message ? err.message : String(err);
  return m.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

// 两套状态提示共用一套行为：非错误类文案 2 秒后自动清空；err 常驻，等用户下次操作再被覆盖
function makeStatus(elId, base = 'status') {
  let timer = null;
  return (text, cls) => {
    const el = $(elId);
    el.textContent = text || '';
    el.className = base + (cls ? ' ' + cls : '');
    if (timer) { clearTimeout(timer); timer = null; }
    if (text && cls !== 'err') {
      timer = setTimeout(() => {
        el.textContent = '';
        el.className = base;
      }, 2000);
    }
  };
}
const setPersonaStatus = makeStatus('persona-status');
const setVoiceStatus = makeStatus('voice-status');
// 就近提示：各自显示在触发它的控件下方，不再堆到页面最底部
const setPresetStatus = makeStatus('preset-status', 'status inline');
const setCloneStatus = makeStatus('clone-status', 'status inline');
const setAsrStatus = makeStatus('asr-status', 'status inline');

// ---------- 未保存提示 ----------
// 两段表单各记一份"改过、还没保存"的状态：标题旁边亮红点；关窗口时由 beforeunload 拦下，
// 真正的确认框在主进程的 will-prevent-unload 里弹（见 window.js），页面这边只负责"拦住"
function makeDirty(elId) {
  const el = $(elId);
  let dirty = false;
  return {
    mark() { dirty = true; el.classList.add('show'); },
    clear() { dirty = false; el.classList.remove('show'); },
    get dirty() { return dirty; },
  };
}
const personaDirty = makeDirty('persona-dirty');
const voiceDirty = makeDirty('voice-dirty');
// 用容器上的事件委托，不用给每个控件单独绑；加载时直接给 value 赋值不会触发事件，不会误报
for (const evt of ['input', 'change']) {
  $('page-persona').addEventListener(evt, () => personaDirty.mark());
  $('page-voice').addEventListener(evt, () => voiceDirty.mark());
}
// 关窗 / 换角色前的未保存确认：用页面内浮层，不弹系统对话框。
// beforeunload 里只负责"拦住"，浮层延到下一帧再显示——关闭被拦下后窗口还在，浮层才看得见
const CLOSE_MSG = '还有没保存的修改，关掉窗口后这些修改会丢失。';
let allowUnload = false; // 用户确认过"放弃修改"：之后再关窗口 / 重载页面就直接放行
let pendingSwitch = ''; // 主进程请求切换到的角色；空 = 这次只是关窗口
let confirming = false;
const confirmOverlay = $('confirm-overlay');
const confirmMsg = $('confirm-msg');
const confirmOk = $('confirm-ok');

function hideConfirm() {
  confirming = false;
  pendingSwitch = '';
  confirmOverlay.classList.add('hidden');
}
function showConfirm(msg, okLabel) {
  confirmMsg.textContent = msg;
  confirmOk.textContent = okLabel;
  if (confirming) return; // 已经显示着就只更新文案
  confirming = true;
  confirmOverlay.classList.remove('hidden');
  $('confirm-cancel').focus();
}

$('confirm-cancel').addEventListener('click', hideConfirm);
$('confirm-ok').addEventListener('click', () => {
  const target = pendingSwitch;
  allowUnload = true;
  hideConfirm();
  // 换角色：交给主进程原地重载页面（页面这边已经放行 beforeunload）；关窗口：直接关
  if (target) window.petAPI.characterVoiceSwitch(target);
  else window.close();
});
// 点遮罩本身 = 继续编辑（点浮层内部不算）；mousedown/mouseup 都落在遮罩上才判定，避免拖选文字误关
let overlayDownOnSelf = false;
confirmOverlay.addEventListener('mousedown', (e) => {
  overlayDownOnSelf = e.target === confirmOverlay;
});
confirmOverlay.addEventListener('mouseup', (e) => {
  if (overlayDownOnSelf && e.target === confirmOverlay) hideConfirm();
  overlayDownOnSelf = false;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !confirmOverlay.classList.contains('hidden')) hideConfirm();
});
// 菜单里点了另一个角色：主进程把目标角色发过来，由页面决定直接换还是先问一句
window.petAPI.onCharacterVoiceSwitchAsk((name) => {
  if (!personaDirty.dirty && !voiceDirty.dirty) {
    // 没有改动：页面本来就不会拦重载，直接请主进程换角色
    window.petAPI.characterVoiceSwitch(name);
    return;
  }
  pendingSwitch = name;
  showConfirm(`切换到「${name}」会丢掉这些没保存的修改。`, '放弃修改并切换');
});
window.addEventListener('beforeunload', (e) => {
  if (allowUnload || (!personaDirty.dirty && !voiceDirty.dirty)) return;
  e.preventDefault();
  e.returnValue = ''; // Electron：返回值不是 undefined 就取消关闭
  if (confirming) return; // 浮层已经开着就别把换角色的文案改成关窗口的
  setTimeout(() => showConfirm(CLOSE_MSG, '放弃修改并关闭'), 0);
});

// ==================== 角色设定（persona.json）====================
// 该角色的人设状态：null = 还没加载到（加载失败时会提示，此时保存不会动人设）
let personaLoaded = null;

async function loadPersona() {
  try {
    const persona = await window.petAPI.getPersona(character);
    personaLoaded = persona;
    $('persona_system').value = persona.system || '';
    $('story_background').value = persona.storyBackground || '';
    $('persona_aliases').value = (persona.aliases || []).join('、');
    $('reader_info').value = persona.readerInfo || '';
  } catch (err) {
    setPersonaStatus('加载角色设定失败：' + errText(err), 'err');
  }
}

$('persona-save-btn').addEventListener('click', async () => {
  // 加载失败时不动人设文件，避免用空表单把已有内容覆盖掉
  if (!personaLoaded) {
    setPersonaStatus('角色设定还没加载成功，无法保存', 'err');
    return;
  }
  setPersonaStatus('保存中…', 'busy');
  try {
    // 四项都清空 = 删除 persona.json，之后不再发送
    await window.petAPI.savePersona(personaLoaded.characterName, {
      system: $('persona_system').value,
      storyBackground: $('story_background').value,
      aliases: $('persona_aliases').value,
      readerInfo: $('reader_info').value,
    });
    personaDirty.clear();
    // 同一页里音色设置可能还有没保存的编辑，这里只提示、不关窗口
    setPersonaStatus('已保存', 'ok');
  } catch (err) {
    setPersonaStatus('保存失败：' + errText(err), 'err');
  }
});

// ==================== 音色设置（ttsConfig / asrConfig）====================
const PANELS = ['edge', 'doubao', 'mimo'];
const MIMO_MODES = ['preset', 'clone'];
const DOUBAO_SOURCES = ['custom', 'preset'];
const CUSTOM = '__custom__';

let cloneAudio = null; // { file, name, mime, size } | null

// 加载完整成功之前不允许试听 / 保存：加载失败（或中途出错）时表单是空的或只填了一半，
// 这时保存会把半截表单当成用户的设置覆盖进去（连带清空各角色共用的服务商密钥）
$('voice-save-btn').disabled = true;
$('test-btn').disabled = true;
// 语音识别配置单独记：读取失败时保存就跳过它，不把空值写回成默认 Resource-Id
let asrLoaded = false;
let doubaoVoiceList = []; // 豆包预置音色的当前生效列表：[{ name, speakerId, resourceId, note }]
let testAudio = null;
let testUrl = null;

function fillSelect(select, items) {
  select.innerHTML = '';
  for (const it of items) {
    const opt = document.createElement('option');
    opt.value = it.value;
    opt.textContent = it.label;
    select.appendChild(opt);
  }
}

function refreshPanels() {
  const provider = $('provider').value;
  for (const p of PANELS) $('panel-' + p).classList.toggle('show', provider === p);
  $('edge_voice_custom').classList.toggle('show', $('edge_voice').value === CUSTOM);
  for (const m of MIMO_MODES) $('mimo-sub-' + m).classList.toggle('show', $('mimo_mode').value === m);
  for (const s of DOUBAO_SOURCES) $('doubao-sub-' + s).classList.toggle('show', $('doubao_source').value === s);
  renderDoubaoPresetNote();
}

// 豆包预置音色下拉：value 用数组下标（防止音色名重复），选中时把 note 显示成一行小字提示
function fillDoubaoPresetSelect() {
  const select = $('doubao_preset_voice');
  select.innerHTML = '';
  doubaoVoiceList.forEach((v, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = v.name;
    select.appendChild(opt);
  });
}

function renderDoubaoPresetNote() {
  if ($('doubao_source').value !== 'preset') return;
  const i = Number($('doubao_preset_voice').value);
  const v = doubaoVoiceList[i];
  $('doubao_preset_note').textContent = v && v.note ? v.note : '（这条音色暂无备注）';
}

// 按 name 找回之前选中的那条预置音色（找不到就退回第一条），返回下标
function findDoubaoPresetIndex(name) {
  const i = doubaoVoiceList.findIndex((v) => v.name === name);
  return i >= 0 ? i : 0;
}

function renderClone() {
  $('clone_name').textContent = cloneAudio ? cloneAudio.name : '未选择';
  $('clone_name').title = cloneAudio ? cloneAudio.name : '';
}

// 保存的数字可能带单位（"+10%" / "-5Hz"），数字输入框里只放数值
function toNumberField(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? String(n) : '';
}

const TEST_TEXT = '「你好呀，这是语音试听。」';

async function loadVoice() {
  const cfg = await window.petAPI.ttsGetConfig(character);
  const { providers, voice, presets } = cfg;

  fillSelect($('edge_voice'), [...presets.edge, { value: CUSTOM, label: '其他（手动输入音色名）' }]);
  fillSelect($('mimo_preset_voice'), presets.mimo);
  // 用 DOM API 构造而不是拼 HTML 字符串，避免值里带引号 / 尖括号时破坏结构
  $('doubao_resource_list').replaceChildren(
    ...presets.doubaoResourceIds.map((v) => {
      const opt = document.createElement('option');
      opt.value = v;
      return opt;
    })
  );
  doubaoVoiceList = presets.doubaoVoices || [];
  fillDoubaoPresetSelect();

  $('provider').value = voice.provider;

  // Edge
  const inPresets = presets.edge.some((p) => p.value === voice.edge.voice);
  $('edge_voice').value = inPresets ? voice.edge.voice : CUSTOM;
  $('edge_voice_custom').value = inPresets ? '' : voice.edge.voice;
  $('edge_rate').value = toNumberField(voice.edge.rate);
  $('edge_pitch').value = toNumberField(voice.edge.pitch);
  $('edge_volume').value = toNumberField(voice.edge.volume);

  // 豆包
  $('doubao_app_id').value = providers.doubao.app_id;
  $('doubao_access_key').value = providers.doubao.access_key;
  $('doubao_source').value = voice.doubao.source;
  $('doubao_speaker_id').value = voice.doubao.speaker_id;
  $('doubao_resource_id').value = voice.doubao.resource_id;
  $('doubao_preset_voice').value = String(findDoubaoPresetIndex(voice.doubao.preset_name));

  // 豆包 ASR（独立于 ttsConfig 存，所有角色共用，跟音色设置一起在这段里改）
  try {
    const asrCfg = await window.petAPI.asrGetConfig();
    $('asr_resource_id').value = asrCfg.resourceId;
    asrLoaded = true;
  } catch { /* 读取失败不拦其它设置，load() 末尾会提示，保存时跳过它 */ }

  // MiMo
  $('mimo_api_key').value = providers.mimo.api_key;
  $('mimo_base_url').value = providers.mimo.base_url;
  $('mimo_mode').value = voice.mimo.mode;
  $('mimo_preset_voice').value = voice.mimo.preset_voice;
  cloneAudio = voice.mimo.clone_audio;
  renderClone();

  refreshPanels();

  // 走到这里才算加载完整，放开试听 / 保存
  $('voice-save-btn').disabled = false;
  $('test-btn').disabled = false;
  if (!asrLoaded) setAsrStatus('语音识别配置读取失败，本次保存不会修改它', 'err');
}

// 表单 -> 与主进程 ttsConfig 同结构的对象（主进程会再规整一遍）
function collect() {
  const num = (id) => $(id).value.trim();
  const doubaoSource = $('doubao_source').value;
  // source=preset 时，speaker_id/resource_id 从选中的预置音色带出，不用手填框里的值
  const doubaoPreset = doubaoVoiceList[Number($('doubao_preset_voice').value)];
  return {
    providers: {
      doubao: { app_id: $('doubao_app_id').value, access_key: $('doubao_access_key').value },
      mimo: { api_key: $('mimo_api_key').value, base_url: $('mimo_base_url').value },
    },
    voice: {
      provider: $('provider').value,
      edge: {
        voice: $('edge_voice').value === CUSTOM ? $('edge_voice_custom').value : $('edge_voice').value,
        rate: num('edge_rate'),
        pitch: num('edge_pitch'),
        volume: num('edge_volume'),
      },
      doubao: {
        source: doubaoSource,
        speaker_id: doubaoSource === 'preset' && doubaoPreset ? doubaoPreset.speakerId : $('doubao_speaker_id').value,
        resource_id: doubaoSource === 'preset' && doubaoPreset ? doubaoPreset.resourceId : $('doubao_resource_id').value,
        preset_name: doubaoSource === 'preset' && doubaoPreset ? doubaoPreset.name : '',
      },
      mimo: {
        mode: $('mimo_mode').value,
        preset_voice: $('mimo_preset_voice').value,
        clone_audio: cloneAudio,
      },
    },
  };
}

function playBytes(bytes, mime) {
  if (testAudio) testAudio.pause();
  if (testUrl) URL.revokeObjectURL(testUrl);
  testUrl = URL.createObjectURL(new Blob([bytes], { type: mime || 'audio/mpeg' }));
  testAudio = new Audio(testUrl);
  return testAudio.play();
}

$('provider').addEventListener('change', refreshPanels);
$('edge_voice').addEventListener('change', refreshPanels);
$('mimo_mode').addEventListener('change', refreshPanels);
$('doubao_source').addEventListener('change', refreshPanels);
$('doubao_preset_voice').addEventListener('change', renderDoubaoPresetNote);

$('doubao-preset-import').addEventListener('click', async () => {
  setPresetStatus('');
  try {
    const list = await window.petAPI.ttsDoubaoVoicesImport();
    if (list) {
      doubaoVoiceList = list;
      fillDoubaoPresetSelect();
      renderDoubaoPresetNote();
      voiceDirty.mark();
      setPresetStatus(`已导入 ${list.length} 条预置音色，记得点"保存"`, 'ok');
    }
  } catch (err) {
    setPresetStatus('导入失败：' + errText(err), 'err');
  }
});
$('doubao-preset-export').addEventListener('click', async () => {
  setPresetStatus('');
  try {
    const filePath = await window.petAPI.ttsDoubaoVoicesExport();
    if (filePath) setPresetStatus('已导出到 ' + filePath, 'ok');
  } catch (err) {
    setPresetStatus('导出失败：' + errText(err), 'err');
  }
});
$('doubao-preset-reset').addEventListener('click', async () => {
  setPresetStatus('');
  try {
    doubaoVoiceList = await window.petAPI.ttsDoubaoVoicesReset();
    fillDoubaoPresetSelect();
    renderDoubaoPresetNote();
    voiceDirty.mark();
    setPresetStatus('已恢复默认预置音色，记得点"保存"', 'ok');
  } catch (err) {
    setPresetStatus('恢复默认失败：' + errText(err), 'err');
  }
});

$('clone-pick').addEventListener('click', async () => {
  setCloneStatus('');
  try {
    const r = await window.petAPI.ttsPickCloneAudio(character);
    if (r) {
      cloneAudio = r;
      renderClone();
      voiceDirty.mark();
      setCloneStatus('参考音频已选择，记得点"保存"', 'ok');
    }
  } catch (err) {
    setCloneStatus('选择参考音频失败：' + errText(err), 'err');
  }
});
$('clone-clear').addEventListener('click', () => {
  cloneAudio = null;
  setCloneStatus('');
  renderClone();
  voiceDirty.mark();
});

$('test-btn').addEventListener('click', async () => {
  const btn = $('test-btn');
  btn.disabled = true;
  setVoiceStatus('合成中…', 'busy');
  try {
    const r = await window.petAPI.ttsTest(character, collect(), TEST_TEXT);
    await playBytes(r.bytes, r.mime);
    setVoiceStatus('合成成功，正在播放', 'ok');
  } catch (err) {
    setVoiceStatus('试听失败：' + errText(err), 'err');
  } finally {
    btn.disabled = false;
  }
});

$('voice-save-btn').addEventListener('click', async () => {
  setVoiceStatus('保存中…', 'busy');
  setPresetStatus('');
  setCloneStatus('');
  try {
    await window.petAPI.ttsSaveConfig(character, collect());
    if (asrLoaded) await window.petAPI.asrSaveConfig({ resourceId: $('asr_resource_id').value });
    voiceDirty.clear();
    // 同一页里角色设定可能还有没保存的编辑，这里只提示、不关窗口
    setVoiceStatus('已保存', 'ok');
  } catch (err) {
    setVoiceStatus('保存失败：' + errText(err), 'err');
  }
});

loadPersona();
loadVoice().catch((err) => setVoiceStatus('加载失败：' + errText(err), 'err'));
