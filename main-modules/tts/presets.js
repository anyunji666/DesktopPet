// ---------- 语音合成：各服务商的内置音色 / 常用取值（设置窗口下拉用） ----------
// 来源：st-tavern-audio 扩展的 edge-tts.js / nimo-voices.js。内置的只是"够用"的常用项，
// 设置窗口里都留了手动输入的口子，想用别的音色不需要改代码。

// Edge-TTS 音色（voice 就是微软的 ShortName，可以在设置里手动填任意 *Neural 音色）
const EDGE_VOICES = [
  { value: 'zh-CN-XiaoxiaoNeural', label: '晓晓（女声·普通话）' },
  { value: 'zh-CN-XiaoyiNeural', label: '晓伊（女声·普通话）' },
  { value: 'zh-CN-YunjianNeural', label: '云健（男声·普通话）' },
  { value: 'zh-CN-YunxiNeural', label: '云希（男声·普通话）' },
  { value: 'zh-CN-YunxiaNeural', label: '云夏（男童声·普通话）' },
  { value: 'zh-CN-YunyangNeural', label: '云扬（男声·普通话）' },
  { value: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北（女声·东北话）' },
  { value: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮（女声·陕西话）' },
  { value: 'zh-HK-HiuMaanNeural', label: '曉曼（女声·粤语）' },
  { value: 'zh-HK-WanLungNeural', label: '雲龍（男声·粤语）' },
  { value: 'zh-TW-HsiaoChenNeural', label: '曉臻（女声·台湾腔）' },
  { value: 'zh-TW-YunJheNeural', label: '雲哲（男声·台湾腔）' },
  { value: 'en-US-AriaNeural', label: 'Aria（女声·美式英语）' },
  { value: 'en-US-GuyNeural', label: 'Guy（男声·美式英语）' },
  { value: 'en-US-JennyNeural', label: 'Jenny（女声·美式英语）' },
  { value: 'ja-JP-NanamiNeural', label: '七海（女声·日语）' },
  { value: 'ja-JP-KeitaNeural', label: '圭太（男声·日语）' },
  { value: 'ko-KR-SunHiNeural', label: '선히（女声·韩语）' },
  { value: 'ko-KR-InJoonNeural', label: '인준（男声·韩语）' },
];

// MiMo-V2.5-TTS 官方预置音色
const MIMO_PRESET_VOICES = [
  { value: 'mimo_default', label: 'MiMo · 默认（通用）' },
  { value: '冰糖', label: '冰糖（中文女）' },
  { value: '茉莉', label: '茉莉（中文女）' },
  { value: '苏打', label: '苏打（中文男）' },
  { value: '白桦', label: '白桦（中文男）' },
  { value: 'Mia', label: 'Mia（英文女）' },
  { value: 'Chloe', label: 'Chloe（英文女）' },
  { value: 'Milo', label: 'Milo（英文男）' },
  { value: 'Dean', label: 'Dean（英文男）' },
];

// 豆包 resource_id 常用值：系统音色用 seed-tts-2.0，声音复刻的克隆音色用 seed-icl-2.0
const DOUBAO_RESOURCE_IDS = ['seed-tts-2.0', 'seed-icl-2.0'];

// 豆包内置预置音色（系统音色，resource_id 固定 seed-tts-2.0）。这是"恢复默认"时用的出厂列表；
// 用户实际看到、可编辑/导入导出的是 doubao-voices-store.js 里落盘的"生效列表"，初始值就是这份。
const DOUBAO_DEFAULT_PRESET_VOICES = [
  { name: '甜美活泼', speakerId: 'ICL_uranus_zh_female_tianmeihuopo_tob', resourceId: 'seed-tts-2.0', note: '' },
  { name: '知性女声', speakerId: 'zh_female_zhixingnv_uranus_bigtts', resourceId: 'seed-tts-2.0', note: '' },
  { name: '悠悠君子', speakerId: 'zh_male_youyoujunzi_uranus_bigtts', resourceId: 'seed-tts-2.0', note: '' },
  { name: '儒雅青年', speakerId: 'zh_male_ruyaqingnian_uranus_bigtts', resourceId: 'seed-tts-2.0', note: '' },
  { name: '温柔小哥', speakerId: 'zh_male_wenrouxiaoge_uranus_bigtts', resourceId: 'seed-tts-2.0', note: '' },
  { name: '开朗学长', speakerId: 'zh_male_kailangxuezhang_uranus_bigtts', resourceId: 'seed-tts-2.0', note: '' },
  { name: '唐僧', speakerId: 'zh_male_tangseng_uranus_bigtts', resourceId: 'seed-tts-2.0', note: '' },
  { name: '霸气青叔', speakerId: 'zh_male_baqiqingshu_uranus_bigtts', resourceId: 'seed-tts-2.0', note: '' },
  { name: '儒雅逸辰', speakerId: 'zh_male_ruyayichen_uranus_bigtts', resourceId: 'seed-tts-2.0', note: '' },
  { name: '高冷沉稳', speakerId: 'zh_male_gaolengchenwen_uranus_bigtts', resourceId: 'seed-tts-2.0', note: '' },
  { name: '天才同桌', speakerId: 'ICL_uranus_zh_male_tiancaitongzhuo_tob', resourceId: 'seed-tts-2.0', note: '' },
  { name: '直率青年', speakerId: 'ICL_uranus_zh_male_zhishuaiqingnian_tob', resourceId: 'seed-tts-2.0', note: '' },
  { name: '仗剑君子', speakerId: 'ICL_uranus_zh_male_zhangjianjunzi_tob', resourceId: 'seed-tts-2.0', note: '' },
  { name: '优柔帮主', speakerId: 'ICL_uranus_zh_male_youroubangzhu_tob', resourceId: 'seed-tts-2.0', note: '' },
  { name: '小侯爷', speakerId: 'ICL_uranus_zh_male_xiaohouye_tob', resourceId: 'seed-tts-2.0', note: '' },
  { name: '擎苍', speakerId: 'zh_male_qingcang_uranus_bigtts', resourceId: 'seed-tts-2.0', note: '' },
  { name: '小何', speakerId: 'zh_female_xiaohe_uranus_bigtts', resourceId: 'seed-tts-2.0', note: '' },
  { name: '少儿故事', speakerId: 'zh_female_shaoergushi_uranus_bigtts', resourceId: 'seed-tts-2.0', note: '' },
  { name: '温柔小雅', speakerId: 'zh_female_wenrouxiaoya_uranus_bigtts', resourceId: 'seed-tts-2.0', note: '' },
  { name: '柔美女友', speakerId: 'zh_female_roumeinvyou_uranus_bigtts', resourceId: 'seed-tts-2.0', note: '' },
  { name: '女雷神', speakerId: 'zh_female_nvleishen_uranus_bigtts', resourceId: 'seed-tts-2.0', note: '' },
  { name: '玲玲姐姐', speakerId: 'zh_female_lingling_uranus_bigtts', resourceId: 'seed-tts-2.0', note: '' },
  { name: '甜美桃子', speakerId: 'zh_female_tianmeitaozi_uranus_bigtts', resourceId: 'seed-tts-2.0', note: '' },
  { name: '柔骨魂师', speakerId: 'ICL_uranus_zh_female_rouguhunshi_tob', resourceId: 'seed-tts-2.0', note: '' },
  { name: '暖心学姐', speakerId: 'ICL_uranus_zh_female_nuanxinxuejie_tob', resourceId: 'seed-tts-2.0', note: '' },
  { name: '性感魅惑', speakerId: 'ICL_uranus_zh_female_xingganmeihuo_tob', resourceId: 'seed-tts-2.0', note: '' },
  { name: '幽默大爷', speakerId: 'ICL_uranus_zh_male_youmodaye_tob', resourceId: 'seed-tts-2.0', note: '' },
  { name: '胡子叔叔', speakerId: 'ICL_uranus_zh_male_huzishushu_tob', resourceId: 'seed-tts-2.0', note: '' },
  { name: '婆婆', speakerId: 'zh_female_popo_uranus_bigtts', resourceId: 'seed-tts-2.0', note: '' },
  { name: '和蔼奶奶', speakerId: 'ICL_uranus_zh_female_heainainai_tob', resourceId: 'seed-tts-2.0', note: '' },
  { name: '樱桃丸子', speakerId: 'zh_female_yingtaowanzi_uranus_bigtts', resourceId: 'seed-tts-2.0', note: '' },
  { name: '懒音绵宝', speakerId: 'zh_male_lanyinmianbao_uranus_bigtts', resourceId: 'seed-tts-2.0', note: '' },
  { name: '佩奇猪', speakerId: 'zh_female_peiqi_uranus_bigtts', resourceId: 'seed-tts-2.0', note: '' },
];

module.exports = { EDGE_VOICES, MIMO_PRESET_VOICES, DOUBAO_RESOURCE_IDS, DOUBAO_DEFAULT_PRESET_VOICES };
