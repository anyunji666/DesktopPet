// 公共工具：读取图片文件 -> 适当压缩 -> dataURL（聊天记录窗口和主宠物窗口发图共用）
// 长边超过 1280 或原始超过 ~500KB 时压成 jpeg(0.85)；gif 不压缩（保留动画）
(function () {
  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('读取图片失败'));
      reader.readAsDataURL(file);
    });
  }

  function loadImg(dataURL) {
    return new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('图片解析失败'));
      el.src = dataURL;
    });
  }

  async function fileToCompressedDataURL(file) {
    const dataURL = await readAsDataURL(file);
    if (file.type === 'image/gif') return dataURL;
    const img = await loadImg(dataURL);
    const MAX = 1280;
    const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
    if (scale === 1 && dataURL.length < 500000) return dataURL;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  }

  // 从粘贴事件里找图片文件，返回 File 或 null
  function imageFileFromPaste(e) {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const item of items) {
      if (item.type && item.type.startsWith('image/')) return item.getAsFile();
    }
    return null;
  }

  window.imageUtils = { fileToCompressedDataURL, imageFileFromPaste };
})();
