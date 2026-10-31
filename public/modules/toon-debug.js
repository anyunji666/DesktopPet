// ---------------- toon 明暗调试入口：window.__toon ----------------
// 多数 PMX 的 toon 图接近纯白，模型基本是平光。这里用程序生成的渐变替换它（原理见 model.js 的 applyToon）。
// 用法：右键菜单 → 开发者工具 → Console，输入 __toon.help() 看命令。
// 调好后 __toon.export() 会打印一段可以直接并进 Character/<角色名>/fixes.json 的 "toon" 字段。
// 这里的修改只作用于当前模型、不落盘；切换角色会回到该角色 fixes.json 里的值。
import { state } from './state.js';
import { applyToon, TOON_DEFAULTS } from './model.js';

const PRESETS = {
  soft: { shade: 0.85, threshold: 0, soft: 0.35 }, // 柔和过渡，偏自然立体
  cel: { shade: 0.78, threshold: 0, soft: 0.04 }, // 赛璐璐硬边
  off: { shade: 1 }, // 无阴影（恢复模型自带 toon）
};

let cfg = null;
let cfgMesh = null;

// 当前模型变了（切换角色）就重新从 fixes.json 读起，避免把上一个角色的调试值带过来
function cur() {
  if (!state.mesh) {
    console.warn('[__toon] 模型还没加载好');
    return null;
  }
  if (cfgMesh !== state.mesh) {
    cfgMesh = state.mesh;
    cfg = JSON.parse(JSON.stringify((state.materialFixes && state.materialFixes.toon) || {}));
  }
  return cfg;
}

const names = () => {
  const set = new Set();
  state.mesh.traverse((o) => {
    if (o.isMesh && Array.isArray(o.material)) for (const m of o.material) if ('gradientMap' in m) set.add(m.name);
  });
  return [...set];
};

const num = (v, fallback, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
const effective = (c, name) => ({ ...TOON_DEFAULTS, ...(c[name] || c['*'] || {}) });
const reOf = (x) => (x instanceof RegExp ? x : new RegExp(x));
const apply = () => applyToon(state.mesh, cfg);

// 对 re 命中的材质（不写 = 全部，写进 "*"）设置参数；参数传 null / 不传 = 沿用该目标当前的值
function setTarget(re, patch) {
  const c = cur();
  if (!c) return;
  if (re === undefined || re === null) {
    c['*'] = { ...effective(c, '*'), ...patch };
    // 已有的单独材质条目保留（它们优先于 "*"），想清掉用 clear()
  } else {
    const rx = reOf(re);
    const hit = names().filter((n) => rx.test(n));
    if (!hit.length) return console.warn(`[__toon] 没有材质名命中 ${rx}，用 materials() 看材质名`);
    for (const n of hit) c[n] = { ...effective(c, n), ...patch };
    console.log(`已设置 ${hit.length} 个材质：${hit.join('、')}`);
  }
  apply();
}

const api = {
  help() {
    console.log(
      [
        '__toon 命令（材质名参数是正则，可省略；省略 = 对所有材质生效）：',
        '  set(shade, threshold, soft, "材质名正则")',
        '       shade      暗部受光系数 0~1（1 = 无阴影，0.8 = 暗部降到 80%）',
        '       threshold  明暗分界 -1~1（0 = 光擦过的位置；越大阴影区越大，越小阴影越少）',
        '       soft       过渡宽度 0~1（0.03 = 赛璐璐硬边，0.3 以上 = 柔和）',
        '       任何一个传 null 就沿用当前值，例如 set(0.8) 只改 shade、set(null, 0.2, null) 只改分界',
        '  preset("soft" | "cel" | "off", "材质名正则")   一组现成参数：soft 柔和 / cel 硬边 / off 关闭',
        '  off("目|睫|眉")        这些材质不加阴影（眼睛、睫毛、眉毛这类通常不该有阴影）',
        '  materials()            列出所有材质和当前生效的参数',
        '  clear()                清空所有调试值（全部恢复模型自带 toon，即平光）',
        '  reset()                回到 fixes.json 里写的值',
        '  export()               打印可并进 fixes.json 的 "toon" 字段',
        '',
        '建议调试顺序：',
        '  1) preset("soft")                    先整体看一眼',
        '  2) set(0.7)                          加深暗部，看层次是否够',
        '  3) set(null, 0.2, null)              调分界：阴影多一点或少一点',
        '  4) set(null, null, 0.05)             想要赛璐璐硬边就压小 soft',
        '  5) off("目|睫|眉|白")                眼睛周围去掉阴影',
        '  6) set(0.9, null, null, "肌|颜")      皮肤的阴影单独调浅',
        '  光的颜色/强度/位置在 lights.json 里；key 光方向现在才会影响明暗，调完 toon 后可以回头改 key 的 position。',
        '  加了阴影后整体会变暗，必要时回去调 brightness / lights.json。',
      ].join('\n')
    );
  },
  set(shade, threshold, soft, re) {
    const patch = {};
    const c = cur();
    if (!c) return;
    const base = effective(c, '*');
    patch.shade = num(shade, base.shade, 0, 1);
    patch.threshold = num(threshold, base.threshold, -1, 1);
    patch.soft = num(soft, base.soft, 0, 1);
    // 只覆盖传了值的字段：没传的保持目标自己的当前值，所以这里再收窄一次
    const only = {};
    if (shade !== null && shade !== undefined) only.shade = patch.shade;
    if (threshold !== null && threshold !== undefined) only.threshold = patch.threshold;
    if (soft !== null && soft !== undefined) only.soft = patch.soft;
    setTarget(re, only);
  },
  preset(name, re) {
    const p = PRESETS[name];
    if (!p) return console.warn(`[__toon] 没有这个预设：${name}（可用：${Object.keys(PRESETS).join(' / ')}）`);
    setTarget(re, p);
  },
  off(re) {
    if (re === undefined) return console.warn('[__toon] off() 需要材质名正则，例如 off("目|睫|眉")；想全部关掉用 clear()');
    setTarget(re, { shade: 1 });
  },
  materials() {
    const c = cur();
    if (!c) return;
    console.table(
      names().map((n) => {
        const e = effective(c, n);
        return { name: n, shade: e.shade, threshold: e.threshold, soft: e.soft, 生效: e.shade < 1 ? '是' : '否' };
      })
    );
  },
  clear() {
    if (!cur()) return;
    cfg = {};
    apply();
    console.log('已清空，所有材质回到模型自带 toon');
  },
  reset() {
    cfgMesh = null;
    if (!cur()) return;
    apply();
    console.log('已回到 fixes.json 里的 toon 设置', cfg);
  },
  export() {
    const c = cur();
    if (!c) return;
    // 去掉等于无效果的条目，保持 "*" 在最前
    const out = {};
    const keys = Object.keys(c).sort((a, b) => (a === '*' ? -1 : b === '*' ? 1 : 0));
    for (const k of keys) {
      const e = { ...TOON_DEFAULTS, ...c[k] };
      if (k === '*' && e.shade >= 1) continue;
      out[k] = { shade: +e.shade.toFixed(3), threshold: +e.threshold.toFixed(3), soft: +e.soft.toFixed(3) };
    }
    const text = JSON.stringify({ toon: out }, null, 2);
    console.log(`并进 Character/<角色文件夹>/fixes.json（和 brightness 等字段并列）：\n${text}`);
    return text;
  },
};

window.__toon = api;
