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
    // 主进程只收 png / jpeg / gif / webp（chat-store.js 的 saveChatImage）：其它格式（bmp / svg / avif …）
    // 哪怕很小也要转成 jpeg，不能原样放行，否则发送时才报"不支持的图片格式"
    const accepted = ['image/png', 'image/jpeg', 'image/webp'].includes(file.type);
    if (scale === 1 && accepted && dataURL.length < 500000) return dataURL;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    // JPEG 没有透明通道：不垫底色的话，带透明的 PNG 截图透明处会变成纯黑
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
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
