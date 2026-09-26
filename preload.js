const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petAPI', {
  // 拖拽移动窗口
  move: (dx, dy) => ipcRenderer.send('window-move', dx, dy),
  // 调整窗口大小：按下手柄时通知开始，拖动时只上报水平位移，宽高由主进程按固定比例计算
  resizeBegin: () => ipcRenderer.send('window-resize-begin'),
  resizeBy: (dx) => ipcRenderer.send('window-resize-by', dx),
  // 右键菜单
  showMenu: () => ipcRenderer.send('show-menu'),
  // 主进程推送菜单动作
  onAction: (cb) => ipcRenderer.on('menu-action', (_e, action) => cb(action)),
  // 主进程推送初始化数据（模型路径 + 舞蹈列表）
  onInit: (cb) => ipcRenderer.on('init', (_e, data) => cb(data)),
  // 主进程推送角色切换数据（新模型路径 + 新角色专属舞蹈列表）
  onSwitchCharacter: (cb) => ipcRenderer.on('switch-character', (_e, data) => cb(data)),
  // 主进程推送场景切换数据（场景描述对象；null 表示回到"无场景"）
  onSwitchScene: (cb) => ipcRenderer.on('switch-scene', (_e, data) => cb(data)),
  // 保存某个场景的手动调整（大小 / 位置）；主进程要求重置时推送 scene-adjust
  saveSceneAdjust: (name, adj) => ipcRenderer.send('scene-adjust-save', name, adj),
  onSceneAdjust: (cb) => ipcRenderer.on('scene-adjust', (_e, adj) => cb(adj)),

  // ---- AI 对话 ----
  chatSend: (characterName, message, imageDataURL) => ipcRenderer.invoke('chat-send', characterName, message, imageDataURL),
  getApiConfig: () => ipcRenderer.invoke('get-api-config'),
  saveApiConfig: (cfg) => ipcRenderer.invoke('save-api-config', cfg),
  getPromptConfig: () => ipcRenderer.invoke('get-prompt-config'),
  savePromptConfig: (cfg) => ipcRenderer.invoke('save-prompt-config', cfg),
  // 当前角色的人设（persona.json）读取 / 保存（设置窗口用）
  getPersona: () => ipcRenderer.invoke('get-persona'),
  savePersona: (characterName, system) => ipcRenderer.invoke('save-persona', characterName, system),
  fetchModelList: (apiUrl, apiKey) => ipcRenderer.invoke('fetch-model-list', apiUrl, apiKey),
  getChatHistory: (characterName) => ipcRenderer.invoke('get-chat-history', characterName),
  openHistoryWindow: (characterName) => ipcRenderer.send('open-history-window', characterName),
  // 主进程推送：别的窗口（如聊天记录窗口）发起的对话有了回复，主宠物窗口据此显示头顶气泡
  onShowBubble: (cb) => ipcRenderer.on('show-bubble', (_e, text) => cb(text)),
  // 主进程推送：主窗口发起的对话完成，聊天记录窗口据此实时追加消息
  onChatUpdated: (cb) => ipcRenderer.on('chat-updated', (_e, data) => cb(data)),
  // 聊天记录窗口的消息编辑 / 添加 / 删除 / 清空
  editChatMessage: (characterName, index, content) => ipcRenderer.invoke('edit-chat-message', characterName, index, content),
  addChatMessage: (characterName, role, content) => ipcRenderer.invoke('add-chat-message', characterName, role, content),
  deleteChatMessage: (characterName, index) => ipcRenderer.invoke('delete-chat-message', characterName, index),
  clearChatHistory: (characterName) => ipcRenderer.invoke('clear-chat-history', characterName),

  // ---- LLM 调用记录窗口（审查用）----
  getLlmLog: () => ipcRenderer.invoke('get-llm-log'),
  onLlmLogUpdated: (cb) => ipcRenderer.on('llm-log-updated', (_e, data) => cb(data)),

  // ---- 语音合成（TTS）----
  // 主进程推送：AI 回复合成好了，宠物窗口据此播放并把气泡延长到语音结束
  onPlayTts: (cb) => ipcRenderer.on('play-tts', (_e, data) => cb(data)),
  // 音色设置窗口：读取 / 保存某角色的语音配置，试听（用表单当前值），选择音色复刻的参考音频
  ttsGetConfig: (characterName) => ipcRenderer.invoke('tts-get-config', characterName),
  ttsSaveConfig: (characterName, payload) => ipcRenderer.invoke('tts-save-config', characterName, payload),
  ttsTest: (characterName, payload, text) => ipcRenderer.invoke('tts-test', characterName, payload, text),
  ttsPickCloneAudio: (characterName) => ipcRenderer.invoke('tts-pick-clone-audio', characterName),
  // 豆包预置音色：导入（选文件，整体覆盖替换）/ 导出（另存为 json）/ 恢复默认
  ttsDoubaoVoicesImport: () => ipcRenderer.invoke('tts-doubao-voices-import'),
  ttsDoubaoVoicesExport: () => ipcRenderer.invoke('tts-doubao-voices-export'),
  ttsDoubaoVoicesReset: () => ipcRenderer.invoke('tts-doubao-voices-reset'),

  // ---- 语音识别（ASR，点击🎙开始/再点一下停止）----
  asrStart: () => ipcRenderer.invoke('asr-start'),
  asrSendChunk: (sessionId, chunk) => ipcRenderer.send('asr-audio-chunk', sessionId, chunk),
  asrStop: (sessionId) => ipcRenderer.invoke('asr-stop', sessionId),
  // 中间识别结果（会反复覆盖）/ 最终结果（每次会话恰好一次）/ 出错，都带 sessionId，渲染进程按需自行比对
  onAsrPartial: (cb) => ipcRenderer.on('asr-partial', (_e, sessionId, text) => cb(sessionId, text)),
  onAsrFinal: (cb) => ipcRenderer.on('asr-final', (_e, sessionId, text) => cb(sessionId, text)),
  onAsrError: (cb) => ipcRenderer.on('asr-error', (_e, sessionId, message) => cb(sessionId, message)),
  asrGetConfig: () => ipcRenderer.invoke('asr-get-config'),
  asrSaveConfig: (patch) => ipcRenderer.invoke('asr-save-config', patch),
});
