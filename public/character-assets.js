// ---------- 角色资产配置页面（character-assets.html）----------
// 编辑的是 URL 里 ?character= 指定的那个角色的 assets.json：角色、用户两方各一份「资产 / 负债 / 月收入 / 月支出」。
// 估值口径在 assets-calc.js（主进程拼提示词也用它），这里只管表单和实时看板。
(() => {
  const $ = (id) => document.getElementById(id);
  const C = window.AssetsCalc;
  const character = new URLSearchParams(location.search).get('character') || '';
  document.title = '角色资产配置 - ' + character;
  $('tab-character').textContent = '🎭 ' + character;

  // ipcRenderer.invoke 的异常消息带 "Error invoking remote method 'xxx': Error: " 前缀，去掉只留原因
  function errText(err) {
    const m = err && err.message ? err.message : String(err);
    return m.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  }

  // 非错误类提示 2 秒后自动清空；err 常驻，等下次操作再被覆盖
  let statusTimer = null;
  function setStatus(text, cls) {
    const el = $('status');
    el.textContent = text || '';
    el.className = 'status' + (cls ? ' ' + cls : '');
    if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
    if (text && cls !== 'err') {
      statusTimer = setTimeout(() => { el.textContent = ''; el.className = 'status'; }, 2000);
    }
  }

  // ---------- 数字 / 文字小工具 ----------
  const n = (v) => {
    const x = parseFloat(v);
    return Number.isFinite(x) && x > 0 ? x : 0;
  };
  const fmt = (v) => (Math.round(v * 100) / 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  const pct = (loss) => Math.round(n(loss) * 1000) / 10; // 0.002 → 0.2
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function div(cls) {
    const d = document.createElement('div');
    if (cls) d.className = cls;
    return d;
  }

  // ---------- 状态 ----------
  let data = null; // { currency, character: party, user: party, userKnown }，null = 还没加载成功（此时不允许保存）
  let activeTab = 'character';
  let newerNow = null; // 主进程通知过来的最新故事日期（页面有未保存修改时暂存，只用来提示）
  const cur = () => (data && data.currency) || '元';

  // ---------- 未保存提示 / 关窗口确认（做法同「角色与音色设置」窗口：页面内浮层，不弹系统对话框）----------
  let dirty = false;
  function markDirty() {
    dirty = true;
    $('dirty').classList.add('show');
  }
  function clearDirty() {
    dirty = false;
    $('dirty').classList.remove('show');
  }
  const CLOSE_MSG = '还有没保存的修改，关掉窗口后这些修改会丢失。';
  let allowUnload = false; // 用户确认过"放弃修改"：之后再关窗口 / 重载页面就直接放行
  let pendingSwitch = ''; // 主进程请求切换到的角色；空 = 这次只是关窗口
  let confirming = false;
  const overlay = $('confirm-overlay');

  function hideConfirm() {
    confirming = false;
    pendingSwitch = '';
    overlay.classList.add('hidden');
  }
  function showConfirm(msg, okLabel) {
    $('confirm-msg').textContent = msg;
    $('confirm-ok').textContent = okLabel;
    if (confirming) return;
    confirming = true;
    overlay.classList.remove('hidden');
    $('confirm-cancel').focus();
  }
  $('confirm-cancel').addEventListener('click', hideConfirm);
  $('confirm-ok').addEventListener('click', () => {
    const target = pendingSwitch;
    allowUnload = true;
    hideConfirm();
    if (target) window.petAPI.assetsSwitch(target);
    else window.close();
  });
  let downOnSelf = false;
  overlay.addEventListener('mousedown', (e) => { downOnSelf = e.target === overlay; });
  overlay.addEventListener('mouseup', (e) => {
    if (downOnSelf && e.target === overlay) hideConfirm();
    downOnSelf = false;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.classList.contains('hidden')) hideConfirm();
  });
  // 菜单里点了另一个角色：主进程把目标角色发过来，由页面决定直接换还是先问一句
  window.petAPI.onAssetsSwitchAsk((name) => {
    if (!dirty) {
      window.petAPI.assetsSwitch(name);
      return;
    }
    pendingSwitch = name;
    showConfirm(`切换到「${name}」会丢掉这些没保存的修改。`, '放弃修改并切换');
  });
  window.addEventListener('beforeunload', (e) => {
    if (allowUnload || !dirty) return;
    e.preventDefault();
    e.returnValue = ''; // Electron：返回值不是 undefined 就取消关闭，确认框由主进程把窗口提到前面后在页面里弹
    if (confirming) return;
    setTimeout(() => showConfirm(CLOSE_MSG, '放弃修改并关闭'), 0);
  });

  // ---------- 表单控件 ----------
  // 一个带标签的输入框 / 下拉框，直接读写 row[key]。o: { label, cls, options, number, step, placeholder, max, numMin, numMax, allowNeg, readOnly, disabled, view, model, after }
  function field(row, key, o) {
    const wrap = div(o.cls);
    const label = document.createElement('label');
    label.textContent = o.label;
    wrap.appendChild(label);
    let input;
    if (o.options) {
      input = document.createElement('select');
      for (const v of o.options) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        input.appendChild(opt);
      }
    } else {
      input = document.createElement('input');
      input.type = o.number ? 'number' : 'text';
      if (o.number) { input.min = o.allowNeg ? '' : o.numMin !== undefined ? String(o.numMin) : '0'; input.step = o.step || 'any'; if (o.numMax !== undefined) input.max = String(o.numMax); }
      if (o.max) input.maxLength = o.max;
      if (o.placeholder) input.placeholder = o.placeholder;
    }
    if (o.readOnly) input.readOnly = true;
    if (o.disabled) input.disabled = true;
    const raw = row[key];
    input.value = o.view ? o.view(raw) : raw === undefined || raw === null ? '' : raw;
    // 允许负数的输入框（现金类资产的金额）：负数标红
    const markNeg = () => { if (o.allowNeg) input.classList.toggle('neg', parseFloat(input.value) < 0); };
    markNeg();
    input.addEventListener(o.options ? 'change' : 'input', () => {
      if (o.numMax !== undefined && parseFloat(input.value) > o.numMax) input.value = o.numMax; // 超过上限的数直接压回上限
      row[key] = o.model ? o.model(input.value) : input.value;
      markNeg();
      if (o.after) o.after(input.value);
      markDirty();
      updateDash();
    });
    wrap.appendChild(input);
    return { wrap, input };
  }

  function delButton(onDelete) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'del-btn';
    b.textContent = '✕';
    b.title = '删除这一行';
    b.addEventListener('click', () => {
      onDelete();
      markDirty();
      updateDash();
    });
    return b;
  }

  // 各类别的名称输入提示（切换类别时跟着变）
  const NAME_HINTS = {
    现金类: '如：现金、活期存款、当天能取的银行理财',
    现金等价物: '如：货币基金、国债逆回购',
    金融资产: '如：股票、基金、债券、理财',
    不动产: '如：住宅、车位、地皮',
    动产: '如：车、贵金属、收藏品',
    经营资产: '如：非上市股权、店铺、设备',
  };

  // ---------- 各表的一行 ----------
  function assetCard(row, onDelete) {
    const card = div('row-card');
    // 现金类：金额可为负（= 透支，标红），到账天数固定 0 并锁住；其他类别：天数 1 到 31。换类别时整张卡片重画
    const build = () => {
      const isCash = row.category === C.CASH_CATEGORY;
      const head = div('row-head');
      // 叫「账户资金」的现金类资产（自动建的那条）类别锁死；名字一改就解锁，改回「账户资金」又锁上
      const name = field(row, 'name', { label: '资产名称', cls: 'f-name', placeholder: NAME_HINTS[row.category], max: 40, after: () => { category.input.disabled = C.isLockedCash(row); } });
      const category = field(row, 'category', {
        label: '类别',
        cls: 'f-kind',
        options: C.ASSET_CATEGORIES,
        disabled: C.isLockedCash(row),
        after: () => {
          if (row.category === C.CASH_CATEGORY) {
            row.days = 0;
          } else {
            if (n(row.amount) < 0) row.amount = 0; // 非现金类的金额不能为负
            // 到账天数带出该类的参考值（用户手动改过且在 1 到 31 之间就不再覆盖）
            if (!row._daysTouched || !(n(row.days) >= C.MIN_DAYS)) {
              row.days = C.CATEGORY_DEFAULTS[row.category].days;
              row._daysTouched = false;
            }
          }
          build();
        },
      });
      head.append(name.wrap, category.wrap, delButton(onDelete));

      const g = div('grid');
      const amount = isCash
        ? field(row, 'amount', { label: '金额', number: true, allowNeg: true, placeholder: '现有多少（可为负，代表透支）' })
        : field(row, 'amount', { label: '可变现金额', number: true, placeholder: '现在卖掉能拿到多少' });
      const days = isCash
        ? field(row, 'days', { label: '预计多久到账（天）', number: true, step: '1', disabled: true })
        : field(row, 'days', { label: '预计多久到账（天）', number: true, step: '1', placeholder: '1 到 31', numMin: C.MIN_DAYS, numMax: C.MAX_DAYS, after: () => { row._daysTouched = true; } });
      g.append(amount.wrap, days.wrap);
      card.replaceChildren(head, g);
    };
    build();
    return card;
  }

  // 卡片下面的一行小提示：refresh() 按当前填的内容重新决定显示什么 / 显示不显示
  function tipLine(compute) {
    const el = document.createElement('p');
    el.className = 'tip';
    const refresh = () => {
      const text = compute();
      el.textContent = text;
      el.style.display = text ? '' : 'none';
    };
    refresh();
    return { el, refresh };
  }

  function liabilityCard(row, onDelete) {
    const card = div('row-card');
    const head = div('row-head');
    const tip = tipLine(() => {
      if (n(row.principal) > 0 || n(row.periods) > 0) row.paidOff = ''; // 又改回有欠款，不再算已还完
      if (row.paidOff) {
        const start = C.dateCN(data.storyStart);
        return `${start ? '故事时间开始于 ' + start + '，' : ''}${C.dateCN(row.paidOff)}已还完本负债`;
      }
      if (n(row.principal) > 0 && !(n(row.periods) > 0)) return '没填剩余期数，视为暂时不还：只算欠款，不算进月度支出，也不自动还款。';
      return '';
    });
    head.append(field(row, 'name', { label: '负债名称', cls: 'f-name', placeholder: '如：住房按揭、车贷、消费分期', max: 40 }).wrap, delButton(onDelete));
    const g1 = div('grid');
    g1.append(
      field(row, 'principal', { label: '剩余本金', number: true, after: tip.refresh }).wrap,
      field(row, 'monthly', { label: '月供', number: true }).wrap,
      field(row, 'periods', { label: '剩余期数（月）', number: true, step: '1', after: tip.refresh }).wrap
    );
    card.append(head, g1, tip.el);
    return card;
  }

  function incomeCard(row, onDelete) {
    const card = div('row-card');
    const head = div('row-head');
    const tip = tipLine(() => (n(row.monthly) > 0 && !(n(row.payDay) > 0) ? '没填到账日，不参与自动推算。' : ''));
    head.append(field(row, 'name', { label: '项目', cls: 'f-name', placeholder: '如：税后工资、房租收入、股息与利息', max: 40 }).wrap, delButton(onDelete));
    const g1 = div('grid');
    g1.append(
      field(row, 'monthly', { label: '月金额', number: true, after: tip.refresh }).wrap,
      field(row, 'payDay', { label: '到账日（每月几号）', number: true, step: '1', placeholder: '1 到 31', numMax: 31, view: (v) => (n(v) > 0 ? v : ''), after: tip.refresh }).wrap
    );
    card.append(head, g1, tip.el);
    return card;
  }

  function expenseCard(row, onDelete) {
    const card = div('row-card');
    const head = div('row-head');
    head.append(field(row, 'name', { label: '项目', cls: 'f-name', placeholder: '如：生活开销、人情与其他', max: 40 }).wrap, delButton(onDelete));
    const g1 = div('grid');
    g1.append(field(row, 'monthly', { label: '月金额', number: true }).wrap);
    card.append(head, g1);
    return card;
  }

  // 随身携带物：物品名称 + 数量 + 单位 + 备注，只是给 AI 看的清单，不参与资金计算
  function belongingCard(row, onDelete) {
    const card = div('row-card');
    // 第一行：物品名称 + 数量 + 单位（同一行，名称占剩下的宽度）+ 删除；第二行：备注单独占一行
    const head = div('row-head');
    const qty = field(row, 'quantity', { label: '数量', number: true, step: '1', placeholder: '如：1' });
    const unit = field(row, 'unit', { label: '单位', placeholder: '如：个、支、把', max: C.MAX_UNIT });
    qty.wrap.style.cssText = 'width:72px;flex:none';
    unit.wrap.style.cssText = 'width:124px;flex:none'; // 名称是 flex:1，单位加宽就等于名称缩短，让单位提示词显示完整
    head.append(field(row, 'name', { label: '物品名称', cls: 'f-name', placeholder: '如：白色女士皮包、口红、折叠伞', max: C.MAX_ITEM_NAME }).wrap, qty.wrap, unit.wrap, delButton(onDelete));
    const g1 = div('grid');
    g1.style.gridTemplateColumns = '1fr';
    g1.style.marginTop = '10px'; // 备注和上一行拉开一点距离
    g1.append(field(row, 'note', { label: '备注', placeholder: '如：口红用来补妆', max: C.MAX_NOTE }).wrap);
    card.append(head, g1);
    return card;
  }

  const SECTIONS = [
    {
      key: 'assets',
      title: '💎 资产',
      hint: '名下拥有资产。所有「现金类」资产的金额之和就是「账户资金」（金额可为负，代表透支）：月度收入加进第一条现金类资产，月度支出和月供从它里面扣。一条都没有时会自动建一条「账户资金」。',
      blank: () => ({ name: '', category: '现金类', amount: '', days: 0 }),
      // 一条现金类资产都没有（比如删光了）：自动建一条「账户资金」放在最前面
      normalize: (rows) => {
        if (!rows.some((r) => r.category === C.CASH_CATEGORY)) rows.unshift({ name: C.DEFAULT_CASH_NAME, category: C.CASH_CATEGORY, amount: 0, days: 0, _daysTouched: true });
      },
      card: assetCard,
    },
    {
      key: 'liabilities',
      title: '🧾 负债',
      hint: '填还没还的本金和月供，不是当初借的数。每月 1 日还一期，本金按剩余期数平均减少。',
      blank: () => ({ name: '', principal: '', monthly: '', periods: '' }),
      card: liabilityCard,
    },
    {
      key: 'incomes',
      title: '💵 月度收入',
      hint: '金额填到手的数，到账日一到就加进「账户资金」。',
      blank: () => ({ name: '', monthly: '', payDay: '' }),
      card: incomeCard,
    },
    {
      key: 'expenses',
      title: '🛒 月度支出',
      hint: '每月 1 日从「账户资金」里扣。上面负债的月供会自动算进月支出，这里不用重复填。',
      blank: () => ({ name: '', monthly: '' }),
      card: expenseCard,
    },
    {
      key: 'belongings',
      title: '🎒 随身携带物',
      hint: '会告诉 AI 角色身上带着的物品，自行根据故事输出手动更改。',
      blank: () => ({ name: '', quantity: '', unit: '', note: '' }),
      card: belongingCard,
    },
  ];

  // ---------- 看板（只重写 #dash-body，输入框不重建，不会丢焦点）----------
  function updateDash() {
    const body = $('dash-body');
    if (!body || !data) return;
    const s = C.computeParty(C.sanitizeParty(data[activeTab]));
    const u = esc(cur());
    const neg = (v) => (v < 0 ? ' neg' : '');
    const tier = (when, v, action) => `<tr><td>${when}</td><td class="n main${neg(v)}">${fmt(v)}</td><td class="act">${action}</td></tr>`;
    body.innerHTML = `
      <div class="stats">
        <div class="stat"><div class="k">每月结余<small>（月收入-月支出）</small></div><div class="v${neg(s.monthlySurplus)}">${fmt(s.monthlySurplus)} ${u}</div></div>
      </div>
      <table class="tiers">
        <tr><th>取用时间</th><th class="n">能凑的钱</th><th class="act">所需操作</th></tr>
        ${tier('今天', s.today, '直接可用账户资金')}
        ${tier('一周以内', s.within7, '卖掉 7 天内能到账的资产后的账户可用资金')}
        ${tier('一月以内', s.net31, '卖掉所有资产并还清所有欠款后的账户可用资金<small>（总资产减去总负债后的净资产）</small>')}
      </table>`;
  }

  // ---------- 渲染当前标签页 ----------
  function renderSection(root, party, sec) {
    const head = div('section-head');
    const title = document.createElement('span');
    title.className = 'section-title';
    title.textContent = sec.title;
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'add-btn';
    add.textContent = '＋ 添加';
    head.append(title, add);
    const hint = document.createElement('p');
    hint.className = 'tip';
    hint.textContent = sec.hint;
    const list = div();
    root.append(head, hint, list);

    const draw = () => {
      if (sec.normalize) sec.normalize(party[sec.key]);
      list.replaceChildren();
      const rows = party[sec.key];
      if (!rows.length) {
        const e = div('empty');
        e.textContent = '还没有内容';
        list.appendChild(e);
      }
      for (const row of rows) {
        list.appendChild(
          sec.card(row, () => {
            rows.splice(rows.indexOf(row), 1);
            draw();
          })
        );
      }
      add.disabled = rows.length >= C.MAX_ROWS;
    };
    add.addEventListener('click', () => {
      party[sec.key].push(sec.blank());
      markDirty();
      draw();
      updateDash();
      const last = list.lastElementChild;
      const first = last && last.querySelector('input');
      if (first) first.focus();
    });
    draw();
  }

  function render() {
    const root = $('party-root');
    root.replaceChildren();
    $('tab-character').classList.toggle('active', activeTab === 'character');
    $('tab-user').classList.toggle('active', activeTab === 'user');
    if (!data) return;
    renderStoryRow();
    const party = data[activeTab];

    // 看板
    const dash = div('dash');
    const body = div();
    body.id = 'dash-body';
    dash.appendChild(body);
    root.appendChild(dash);

    for (const sec of SECTIONS) renderSection(root, party, sec);

    // 角色那一页：角色知不知道用户有多少钱（放在最底部，随身携带物下面）
    if (activeTab === 'character') {
      const lab = document.createElement('label');
      lab.style.cssText = 'margin-top:12px;font-size:13px;color:#555;cursor:pointer';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !!data.userKnown;
      box.addEventListener('change', () => {
        data.userKnown = box.checked;
        markDirty();
      });
      lab.append(box, '角色清楚我的财产状况');
      const t = document.createElement('p');
      t.className = 'tip';
      t.textContent = '不勾选时，AI 会被告知角色只能从衣着、住处、花钱方式去推测你有多少钱。';
      root.append(lab, t);
    }
    updateDash();
  }

  function switchTab(tab) {
    if (tab === activeTab) return;
    activeTab = tab;
    render();
  }
  $('tab-character').addEventListener('click', () => switchTab('character'));
  $('tab-user').addEventListener('click', () => switchTab('user'));
  $('currency').addEventListener('input', () => {
    if (!data) return;
    data.currency = $('currency').value.trim() || '元';
    markDirty();
    render(); // 单位出现在多处，整页重画最省事；#currency 本身不在 #party-root 里，不会丢焦点
  });

  // 从主进程拿到的行都是已存的值：标记"到账天数 / 损耗率已手动设定"，之后换类别不会把它们覆盖成参考值
  function prepare(d) {
    for (const key of ['character', 'user']) {
      for (const row of d[key].assets) {
        row._daysTouched = true;
      }
    }
    return d;
  }

  // 顶部：故事开始日期（可改）+ 当前故事时间（只读，资产已经推算到这一天）
  function renderStoryRow() {
    $('story-start').value = (data && data.storyStart) || '';
    const now = data && C.dateCN(data.now);
    let text = `已读取到的 当前故事时间：${now || ''}`; // 没读到就留空
    // 页面上有没保存的修改时，故事时间推进了：不覆盖正在填的内容，只提示；保存后数字会更新到最新
    if (newerNow !== null && newerNow !== ((data && data.now) || '')) {
      text += newerNow ? `故事时间已推进到 ${C.dateCN(newerNow)}，保存后下面的数字会更新到这一天。` : '故事时间已经变了，保存后下面的数字会按最新的故事时间重新推算。';
    }
    $('story-now').textContent = text;
  }
  $('story-start').addEventListener('change', () => {
    if (!data) return;
    data.storyStart = $('story-start').value; // 空串 = 留空，故事第一次写出时间时自动填
    markDirty();
    render(); // 负债卡片里的「故事时间开始于…」要跟着变
  });

  async function load() {
    $('save-btn').disabled = true;
    try {
      newerNow = null;
      data = prepare(await window.petAPI.getAssets(character));
      $('currency').value = data.currency;
      render();
      $('save-btn').disabled = false;
    } catch (err) {
      setStatus('加载失败：' + errText(err), 'err');
    }
  }

  $('save-btn').addEventListener('click', async () => {
    // 加载失败时不动文件，避免用空表单把已有内容覆盖掉
    if (!data) {
      setStatus('资产配置还没加载成功，无法保存', 'err');
      return;
    }
    setStatus('保存中…', 'busy');
    try {
      // 主进程会整理一遍（丢掉全空的行、修正非法值），这里直接换成它返回的版本，页面和存档保持一致
      newerNow = null;
      data = prepare(await window.petAPI.saveAssets(character, data));
      $('currency').value = data.currency;
      clearDirty();
      render();
      setStatus('已保存', 'ok');
    } catch (err) {
      setStatus('保存失败：' + errText(err), 'err');
    }
  });

  // 故事时间变了（新回复 / 编辑或删除聊天记录等）：没有未保存修改就直接刷新数字，有就只提示
  window.petAPI.onAssetsStoryChanged(async (now) => {
    if (!data || (now || '') === (data.now || '')) return;
    if (dirty) {
      newerNow = now || '';
      renderStoryRow();
      return;
    }
    try {
      const fresh = prepare(await window.petAPI.getAssets(character));
      if (dirty) { // 取数据的这一小会儿里用户开始编辑了：不覆盖
        newerNow = fresh.now || '';
        renderStoryRow();
        return;
      }
      data = fresh;
      $('currency').value = data.currency;
      render();
    } catch (err) {
      setStatus('刷新失败：' + errText(err), 'err');
    }
  });

  load();
})();
