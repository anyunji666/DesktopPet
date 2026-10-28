// ---------------- 物理调试入口：window.__phys ----------------
// 个别模型的头发 / 裙摆 / 袖口会一直抖，原因多半是某几组刚体在和大腿、手臂、手腕之类的碰撞体反复接触。
// 用法：右键菜单 → 开发者工具 → Console，输入 __phys.help() 看命令。
// 找到起作用的组合后，__phys.export() 会打印一份可以直接存成 Character/<角色名>/physics.json 的内容。
// 这里的所有修改只作用于当前这套物理实例：点"待机"或切换动作会重建物理，等于全部撤销（__phys.restore()）。
import { state } from './state.js';
import { findBodies, tweakNoCollide, tweakFreeze, tweakDamping, resettlePhysics } from './physics.js';
import { playIdle } from './dance.js';

const applied = []; // 本次调试里做过的修改，export() 用

function currentPhysics() {
  const objs = state.mesh && state.helper ? state.helper.objects.get(state.mesh) : null;
  const p = objs && objs.physics;
  if (!p) console.warn('[__phys] 当前没有物理实例：需要模型有物理刚体，且正在播放待机动画或舞蹈');
  return p || null;
}

const bin16 = (n) => (n >>> 0).toString(2).padStart(16, '0').slice(-16);
const TYPE_NAME = ['静态(跟骨骼)', '动态(物理)', '动态+骨骼位置'];

const api = {
  help() {
    console.log(
      [
        '__phys 命令（名字参数都是正则，匹配 PMX 里的刚体名）：',
        '  find("裙")                      列出名字含"裙"的刚体（类型 / 组 / 能碰撞的组 / 质量）',
        '  groups()                        按碰撞组汇总，看看裙摆和谁在同一个世界里互相碰撞',
        '  noCollide("^裙_", "腕|ひじ|手")   命中的第一组刚体不再和第二组碰撞（会提示被连带的同组刚体）',
        '  freeze("袖")                    命中的动态刚体改成跟随骨骼（不再模拟）',
        '  damping("^裙_", 0.98, 0.98)     覆盖线性 / 角阻尼（0~1）',
        '  reset()                         把刚体传送回当前骨骼并预演 60 步（等于"拖一下"的效果）',
        '  restore()                       重新进入待机，撤销以上所有修改',
        '  export()                        打印可存成 physics.json 的配置',
      ].join('\n')
    );
  },
  find(re) {
    const p = currentPhysics();
    if (!p) return;
    const rows = findBodies(p, re).map((rb) => ({
      name: rb.params.name,
      type: TYPE_NAME[rb.params.type] || rb.params.type,
      group: rb.params.groupIndex,
      collidesWith: bin16(rb.params.groupTarget),
      mass: +Number(rb.params.weight).toFixed(2),
    }));
    console.log(`命中 ${rows.length} 个刚体（collidesWith 从左到右是第 15 组 … 第 0 组）`);
    if (rows.length) console.table(rows);
    return rows.length;
  },
  groups() {
    const p = currentPhysics();
    if (!p) return;
    const map = new Map();
    for (const rb of p.bodies) {
      const g = rb.params.groupIndex;
      if (!map.has(g)) map.set(g, { group: g, count: 0, types: new Set(), samples: [] });
      const e = map.get(g);
      e.count++;
      e.types.add(TYPE_NAME[rb.params.type]);
      if (e.samples.length < 4) e.samples.push(rb.params.name);
    }
    console.table([...map.values()].sort((a, b) => a.group - b.group).map((e) => ({ ...e, types: [...e.types].join('/'), samples: e.samples.join('、') })));
  },
  noCollide(bodies, withRe) {
    const p = currentPhysics();
    if (!p) return;
    const r = tweakNoCollide(p, bodies, withRe);
    if (!r.bodies || !r.with) return console.warn(`[__phys] 没命中：第一组 ${r.bodies} 个，第二组 ${r.with} 个`);
    applied.push({ kind: 'noCollide', bodies: String(bodies), with: String(withRe) });
    console.log(`已让 ${r.changed}/${r.bodies} 个刚体不再和 ${r.with} 个目标碰撞`);
    if (r.collateral.length) console.info(`同组被连带的 ${r.collateral.length} 个刚体：`, r.collateral.slice(0, 20).join('、'));
  },
  freeze(re) {
    const p = currentPhysics();
    if (!p) return;
    const r = tweakFreeze(p, re);
    if (!r.bodies) return console.warn('[__phys] 没命中刚体');
    applied.push({ kind: 'freeze', bodies: String(re) });
    console.log(`已冻结 ${r.changed}/${r.bodies} 个刚体（其余本来就是静态）`);
  },
  damping(re, linear, angular) {
    const p = currentPhysics();
    if (!p) return;
    const r = tweakDamping(p, re, linear, angular);
    if (!r.bodies) return console.warn('[__phys] 没命中刚体');
    applied.push({ kind: 'damping', bodies: String(re), linear: typeof linear === 'number' ? linear : null, angular: typeof angular === 'number' ? angular : null });
    console.log(`已设置 ${r.changed} 个刚体的阻尼`);
  },
  reset() {
    const p = currentPhysics();
    if (p) resettlePhysics(p, 60);
  },
  restore() {
    applied.length = 0;
    playIdle();
  },
  export() {
    const out = { noCollide: [], freeze: [], damping: [] };
    for (const a of applied) {
      if (a.kind === 'noCollide') out.noCollide.push({ bodies: a.bodies, with: a.with, when: 'idle' });
      else if (a.kind === 'freeze') out.freeze.push({ bodies: a.bodies, when: 'idle' });
      else if (a.kind === 'damping') {
        const d = { bodies: a.bodies };
        if (a.linear !== null) d.linear = a.linear;
        if (a.angular !== null) d.angular = a.angular;
        out.damping.push(d);
      }
    }
    for (const k of ['noCollide', 'freeze', 'damping']) if (!out[k].length) delete out[k];
    const text = JSON.stringify(out, null, 2);
    console.log(`存成 Character/<角色文件夹>/physics.json（noCollide / freeze 默认只在待机动画里生效，想让跳舞时也生效就把 when 改成 "always"）：\n${text}`);
    return text;
  },
};

window.__phys = api;
