// ---------------- 麦克风采集：点击🎙开始/停止 ----------------
// 用 ScriptProcessorNode 而不是 AudioWorklet：项目其它地方都是单文件模块，AudioWorklet 需要
// 单独的 worklet 脚本文件和一次异步 addModule，这里音频处理很轻（重采样+转int16），
// 主线程跑一跑不会卡。ScriptProcessorNode 虽然是 deprecated API，但 Chromium/Electron 里
// 还是完整可用的，等哪天真的被移除了再迁移到 AudioWorklet。
const TARGET_RATE = 16000;
const BUFFER_SIZE = 4096; // 一帧的采样点数，48kHz下约85ms，够实时也不会太碎

let audioCtx = null;
let mediaStream = null;
let sourceNode = null;
let processorNode = null;
let onChunk = null;
let recording = false;

// 线性插值重采样：麦克风原始采样率（通常48000/44100）-> 16000，单声道
function downsampleTo16k(float32Data, inputRate) {
  if (inputRate === TARGET_RATE) return float32Data;
  const ratio = inputRate / TARGET_RATE;
  const outLength = Math.max(1, Math.round(float32Data.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcIndex = i * ratio;
    const i0 = Math.floor(srcIndex);
    const i1 = Math.min(i0 + 1, float32Data.length - 1);
    const frac = srcIndex - i0;
    out[i] = float32Data[i0] + (float32Data[i1] - float32Data[i0]) * frac;
  }
  return out;
}

function floatTo16BitPCM(float32Data) {
  const out = new Int16Array(float32Data.length);
  for (let i = 0; i < float32Data.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Data[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

// onAudioChunk(arrayBuffer)：每一帧回调一次 16kHz/16bit/单声道 PCM 的 ArrayBuffer
export async function startRecording(onAudioChunk) {
  if (recording) return;
  onChunk = onAudioChunk;
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, noiseSuppression: true, echoCancellation: true },
  });
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  sourceNode = audioCtx.createMediaStreamSource(mediaStream);
  processorNode = audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1);
  processorNode.onaudioprocess = (e) => {
    if (!recording || !onChunk) return;
    const input = e.inputBuffer.getChannelData(0);
    const pcm16 = floatTo16BitPCM(downsampleTo16k(input, audioCtx.sampleRate));
    onChunk(pcm16.buffer);
  };
  sourceNode.connect(processorNode);
  // Chromium 要求 ScriptProcessorNode 接上目的地才会持续触发 onaudioprocess；
  // processorNode 本身不写输出数据，默认静音，不会有回声/破音
  processorNode.connect(audioCtx.destination);
  recording = true;
}

export function stopRecording() {
  recording = false;
  onChunk = null;
  try { processorNode && processorNode.disconnect(); } catch { /* 忽略 */ }
  try { sourceNode && sourceNode.disconnect(); } catch { /* 忽略 */ }
  try { mediaStream && mediaStream.getTracks().forEach((t) => t.stop()); } catch { /* 忽略 */ }
  try { audioCtx && audioCtx.close(); } catch { /* 忽略 */ }
  processorNode = null;
  sourceNode = null;
  mediaStream = null;
  audioCtx = null;
}

export function isRecording() {
  return recording;
}
