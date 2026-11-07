// ---------- 角色服饰配置页面（character-outfits.html）----------
// 编辑的是 URL 里 ?character= 指定的那个角色的服饰存档（userData/outfits/<角色>/，见 main-modules/outfits.js）：
// 一套服饰 = 名称 + 一张图片 + 一段穿搭描述；点「设为穿着中」的那套，描述会写进 LLM 提示词（图片本身不发）。
// 页面里整份清单在内存里编辑，点「保存」才写盘；「设为穿着中」是单独的即时操作（要求该套已保存）。
(() => {
  const $ = (id) => document.getElementById(id);
  const character = new URLSearchParams(location.search).get('character') || '';
  document.title = '角色服饰配置 - ' + character;

  // ipcRenderer.invoke 的异常消息带 "Error invoking remote method 'xxx': Error: " 前缀，去掉只留原因
  function errText(err) {
    const m = err && err.message ? err.message : String(err);
    return m.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  }

  // 非错误类提示 2 秒后自动清空；err 常驻，等下次操作再被覆盖
  const statusTimers = {};
  function setStatus(text, cls, id = 'status') {
    const el = $(id);
    const base = id === 'status' ? 'status' : 'status inline';
    el.textContent = text || '';
    el.className = base + (cls ? ' ' + cls : '');
    if (statusTimers[id]) { clearTimeout(statusTimers[id]); statusTimers[id] = null; }
    if (text && cls !== 'err' && cls !== 'busy') {
      statusTimers[id] = setTimeout(() => { el.textContent = ''; el.className = base; }, 2000);
    }
  }

  // ---------- 状态 ----------
  // items 每项：{ id, name, text, image（已保存的文件名）, imageDataURL, imgChanged（图片是新选的，保存时要写盘）, isNew（还没保存过） }
  let items = [];
  let activeId = ''; // 当前穿着（磁盘上的）
  let sel = -1; // 选中的下标，-1 = 没有
  let loaded = false; // 加载成功前不允许保存（避免把没读出来的空清单存成覆盖）
  let limits = { maxItems: 30, maxNameChars: 30, maxTextChars: 2000 };
  let newSeq = 0;
  let recognizing = false;

  // ---------- 未保存提示 / 确认浮层（做法同「角色资产配置」窗口：页面内浮层，不弹系统对话框）----------
  let dirty = false;
  function setDirty(v) {
    dirty = v;
    $('dirty').classList.toggle('show', v);
  }
  const CLOSE_MSG = '还有没保存的修改，关掉窗口后这些修改会丢失。';
  let allowUnload = false; // 用户确认过"放弃修改"：之后再关窗口 / 重载页面就直接放行
  let confirming = false;
  let onConfirm = null; // 点「确定」后做的事
  const overlay = $('confirm-overlay');

  function hideConfirm() {
    confirming = false;
    onConfirm = null;
    overlay.classList.add('hidden');
  }
  function ask(msg, okLabel, onOk) {
    if (confirming) return;
    $('confirm-msg').textContent = msg;
    $('confirm-ok').textContent = okLabel;
    onConfirm = onOk;
    confirming = true;
    overlay.classList.remove('hidden');
    $('confirm-cancel').focus();
  }
  $('confirm-cancel').addEventListener('click', hideConfirm);
  $('confirm-ok').addEventListener('click', () => {
    const fn = onConfirm;
    hideConfirm();
    if (fn) fn();
  });
  let downOnSelf = false;
  overlay.addEventListener('mousedown', (e) => { downOnSelf = e.target === overlay; });
  overlay.addEventListener('mouseup', (e) => {
    if (downOnSelf && e.target === overlay) hideConfirm();
    downOnSelf = false;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && confirming) hideConfirm();
  });
  // 菜单里点了另一个角色：主进程把目标角色发过来，由页面决定直接换还是先问一句
  window.petAPI.onOutfitsSwitchAsk((name) => {
    if (!dirty) {
      allowUnload = true;
      window.petAPI.outfitsSwitch(name);
      return;
    }
    if (confirming) hideConfirm();
    ask(`切换到「${name}」会丢掉这些没保存的修改。`, '放弃修改并切换', () => {
      allowUnload = true;
      window.petAPI.outfitsSwitch(name);
    });
  });
  window.addEventListener('beforeunload', (e) => {
    if (allowUnload || !dirty) return;
    e.preventDefault();
    e.returnValue = ''; // Electron：返回值不是 undefined 就取消关闭，确认框由主进程把窗口提到前面后在页面里弹
    if (confirming) return;
    setTimeout(() => ask(CLOSE_MSG, '放弃修改并关闭', () => {
      allowUnload = true;
      window.close();
    }), 0);
  });

  // ---------- 列表渲染 ----------
  const nameEls = []; // 每张卡片的名称节点：改名时只更新文字，不重画整个列表
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function renderStrip() {
    const strip = $('strip');
    strip.textContent = '';
    nameEls.length = 0;
    items.forEach((it, i) => {
      const card = el('button', 'card' + (i === sel ? ' sel' : ''));
      card.type = 'button';
      if (it.imageDataURL) {
        const img = el('img', 'thumb');
        img.src = it.imageDataURL;
        img.alt = '';
        card.appendChild(img);
      } else {
        card.appendChild(el('span', 'noimg', it.image ? '图片丢失' : '无图片'));
      }
      const nm = el('span', 'nm', it.name || `服饰${i + 1}`);
      nameEls.push(nm);
      card.appendChild(nm);
      if (!it.isNew && it.id === activeId) card.appendChild(el('span', 'badge', '穿着中'));
      if (it.isNew) card.appendChild(el('span', 'unsaved', '未保存'));
      card.addEventListener('click', () => select(i));
      strip.appendChild(card);
    });
    const add = el('button', 'card add');
    add.type = 'button';
    add.textContent = '＋ 上传图片';
    add.disabled = items.length >= limits.maxItems;
    add.addEventListener('click', () => $('file').click());
    strip.appendChild(add);
    if (!items.length) strip.insertBefore(el('div', 'empty', '还没有服饰，点右边「＋」上传一张图片开始'), add);
    $('count').textContent = `${items.length} / ${limits.maxItems}`;
  }

  function renderEditor() {
    const it = items[sel];
    $('editor').classList.toggle('hidden', !it);
    if (!it) return;
    $('name').value = it.name;
    $('text').value = it.text;
    const wrap = $('preview');
    wrap.textContent = '';
    if (it.imageDataURL) {
      const img = el('img');
      img.src = it.imageDataURL;
      img.alt = it.name;
      wrap.appendChild(img);
    } else {
      wrap.appendChild(el('div', 'noimg-big', it.image ? '图片文件丢失，请重新上传' : '没有图片，点「更换图片」上传'));
    }
    renderActiveBtn();
    renderRecogBtn();
  }

  function renderActiveBtn() {
    const it = items[sel];
    if (!it) return;
    const btn = $('set-active');
    const on = !it.isNew && it.id === activeId;
    btn.classList.toggle('on', on);
    btn.textContent = on ? '✅ 穿着中（点击取消）' : '👗 设为穿着中';
    btn.disabled = it.isNew; // 新建还没保存的没有正式存档，先保存
    btn.title = it.isNew ? '请先保存' : '';
  }

  function renderRecogBtn() {
    const it = items[sel];
    $('recognize').disabled = recognizing || !it || !it.imageDataURL;
    $('recognize').textContent = recognizing ? '识别中…' : '🤖 AI 识别';
  }

  function select(i) {
    sel = i;
    setStatus('', '', 'recog-status');
    setStatus('', '', 'active-status');
    renderStrip();
    renderEditor();
  }

  // ---------- 编辑 ----------
  $('name').addEventListener('input', () => {
    const it = items[sel];
    if (!it) return;
    it.name = $('name').value;
    if (nameEls[sel]) nameEls[sel].textContent = it.name || `服饰${sel + 1}`;
    setDirty(true);
  });
  $('text').addEventListener('input', () => {
    const it = items[sel];
    if (!it) return;
    it.text = $('text').value;
    setDirty(true);
  });

  // ---------- 上传 / 拖入 / 粘贴 ----------
  async function toDataURL(file) {
    if (!file || !file.type || !file.type.startsWith('image/')) throw new Error('请选择图片文件');
    return window.imageUtils.fileToCompressedDataURL(file);
  }

  // 新建一套服饰并选中
  async function addFromFile(file) {
    if (!loaded) return setStatus('服饰存档还没加载成功，暂时不能添加', 'err');
    if (items.length >= limits.maxItems) return setStatus(`最多保存 ${limits.maxItems} 套服饰`, 'err');
    try {
      const dataURL = await toDataURL(file);
      const base = (file.name || '').replace(/\.[^.]+$/, '').trim();
      const name = (base && base !== 'image' ? base : `服饰${items.length + 1}`).slice(0, limits.maxNameChars);
      items.push({ id: 'new' + ++newSeq, name, text: '', image: '', imageDataURL: dataURL, imgChanged: true, isNew: true });
      setDirty(true);
      select(items.length - 1);
      setStatus('已添加，填好描述后点「保存服饰配置」', 'ok');
    } catch (err) {
      setStatus(errText(err), 'err');
    }
  }

  // 给选中的这套换图片（只换图，不动名称和描述）
  async function replaceImage(file) {
    const it = items[sel];
    if (!it) return;
    try {
      it.imageDataURL = await toDataURL(file);
      it.imgChanged = true;
      setDirty(true);
      renderStrip();
      renderEditor();
    } catch (err) {
      setStatus(errText(err), 'err', 'recog-status');
    }
  }

  let fileMode = 'add'; // 点的是「＋ 上传」还是「更换图片」
  $('file').addEventListener('change', async () => {
    const f = $('file').files && $('file').files[0];
    $('file').value = '';
    if (!f) return;
    if (fileMode === 'replace') await replaceImage(f);
    else await addFromFile(f);
  });
  // 「＋」卡片和「更换图片」共用同一个文件框，靠 fileMode 区分
  $('strip').addEventListener('click', (e) => {
    if (e.target.closest('.card.add')) fileMode = 'add';
  }, true);
  $('change-img').addEventListener('click', () => {
    fileMode = 'replace';
    $('file').click();
  });

  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault(); // 不拦的话 Electron 会把窗口导航到被拖进来的图片
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && f.type.startsWith('image/')) await addFromFile(f);
  });
  document.addEventListener('paste', async (e) => {
    const f = window.imageUtils.imageFileFromPaste(e);
    if (!f) return; // 没有图片就放行，让输入框正常粘贴文字
    e.preventDefault();
    await addFromFile(f);
  });

  // ---------- 识别词 / AI 识别 ----------
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
  $('copy-prompt').addEventListener('click', async () => {
    const ok = await copyText(window.OutfitPrompt.OUTFIT_RECOGNIZE_PROMPT);
    setStatus(ok ? '已复制识别词，连同图片发给 AI 即可' : '复制失败，请重试', ok ? 'ok' : 'err', 'recog-status');
  });

  async function runRecognize(it) {
    recognizing = true;
    renderRecogBtn();
    setStatus('识别中，请稍候…', 'busy', 'recog-status');
    try {
      const text = await window.petAPI.recognizeOutfit(character, it.imageDataURL);
      it.text = text.slice(0, limits.maxTextChars);
      setDirty(true);
      if (items[sel] === it) $('text').value = it.text;
      setStatus('识别完成，请检查后点「保存服饰配置」', 'ok', 'recog-status');
    } catch (err) {
      setStatus(errText(err), 'err', 'recog-status');
    } finally {
      recognizing = false;
      renderRecogBtn();
    }
  }
  $('recognize').addEventListener('click', () => {
    const it = items[sel];
    if (!it || !it.imageDataURL || recognizing) return;
    if (it.text.trim()) ask('识别结果会覆盖当前的穿搭描述，继续吗？', '覆盖并识别', () => runRecognize(it));
    else runRecognize(it);
  });

  // ---------- 设为穿着中 / 删除 ----------
  $('set-active').addEventListener('click', async () => {
    const it = items[sel];
    if (!it || it.isNew) return;
    const turnOff = it.id === activeId;
    try {
      const doc = await window.petAPI.setActiveOutfit(character, turnOff ? '' : it.id);
      activeId = doc.activeId;
      renderStrip();
      renderActiveBtn();
      setStatus(turnOff ? '已取消穿着，不再向 AI 发送服饰' : dirty ? '已设为穿着中（发给 AI 的是已保存的版本，当前修改保存后才生效）' : '已设为穿着中', 'ok', 'active-status');
    } catch (err) {
      setStatus(errText(err), 'err', 'active-status');
    }
  });

  $('delete').addEventListener('click', () => {
    const it = items[sel];
    if (!it) return;
    ask(`删除「${it.name || '这套服饰'}」？点保存后才会真正删除图片文件。`, '删除', () => {
      items.splice(sel, 1);
      sel = items.length ? Math.min(sel, items.length - 1) : -1;
      setDirty(true);
      renderStrip();
      renderEditor();
    });
  });

  // ---------- 加载 / 保存 ----------
  function adopt(doc, keepIndex) {
    limits = { maxItems: doc.maxItems, maxNameChars: doc.maxNameChars, maxTextChars: doc.maxTextChars };
    activeId = doc.activeId || '';
    items = doc.items.map((it) => ({ ...it, imgChanged: false, isNew: false }));
    sel = items.length ? Math.min(keepIndex >= 0 ? keepIndex : 0, items.length - 1) : -1;
    renderStrip();
    renderEditor();
  }

  async function load() {
    setStatus('读取中…', 'busy', 'load-status');
    try {
      adopt(await window.petAPI.getOutfits(character), 0);
      loaded = true;
      setDirty(false);
      setStatus('', '', 'load-status');
    } catch (err) {
      loaded = false;
      setStatus('读取服饰存档失败：' + errText(err), 'err', 'load-status');
    }
  }

  $('save-btn').addEventListener('click', async () => {
    if (!loaded) return setStatus('服饰存档还没加载成功，不能保存', 'err');
    const btn = $('save-btn');
    btn.disabled = true;
    setStatus('保存中…', 'busy');
    try {
      const payload = {
        items: items.map((it) => ({
          id: it.isNew ? '' : it.id,
          name: it.name,
          text: it.text,
          image: it.image,
          imageDataURL: it.imgChanged ? it.imageDataURL : undefined,
        })),
      };
      adopt(await window.petAPI.saveOutfits(character, payload), sel);
      setDirty(false);
      setStatus('已保存', 'ok');
    } catch (err) {
      setStatus('保存失败：' + errText(err), 'err');
    } finally {
      btn.disabled = false;
    }
  });

  load();
})();
