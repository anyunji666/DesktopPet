// 公共工具：读取图片文件 -> 适当压缩 -> dataURL（聊天记录窗口和主宠物窗口发图共用）
// 长边超过 1280 或原图超过 400KB 时重绘成 jpeg(0.85)；gif 在入口直接拒绝（见下面的说明）
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

  const MAX_EDGE = 1280; // 长边上限
  const MAX_BYTES = 400 * 1024; // 原图体积上限：超过就重绘压缩（用 file.size 比真实字节数，不拿 base64 字符长度当体积）
  // 主进程只收 png / jpeg / webp（chat-store.js 的 saveChatImage）：其它格式（bmp / svg / avif …）
  // 哪怕很小也要转成 jpeg，不能原样放行，否则发送时才报"不支持的图片格式"
  const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp'];

  async function fileToCompressedDataURL(file) {
    // GIF 直接拒：canvas 重绘只保留第一帧、动画全丢，不重绘又会把原图原样传下去，
    // 几十 MB 的动图要到主进程 10MB 上限才报"图片超过 10MB"，用户根本联想不到是格式问题。
    if (file.type === 'image/gif') throw new Error('不支持 GIF 图片，请换成 PNG / JPG / WebP，或截取其中一帧再发送');
    const dataURL = await readAsDataURL(file);
    const img = await loadImg(dataURL);
    const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    if (scale === 1 && ACCEPTED.includes(file.type) && file.size <= MAX_BYTES) return dataURL;
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
