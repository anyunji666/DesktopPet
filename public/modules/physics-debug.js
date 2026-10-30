// ---------------- 物理调试入口：window.__phys ----------------
// 个别模型的头发 / 裙摆 / 袖口会一直抖，原因多半是某几组刚体在和大腿、手臂、手腕之类的碰撞体反复接触。
// 用法：右键菜单 → 开发者工具 → Console，输入 __phys.help() 看命令。
// 找到起作用的组合后，__phys.export() 会打印一份可以直接存成 Character/<角色名>/physics.json 的内容。
// 这里的所有修改只作用于当前这套物理实例：点"待机"或切换动作会重建物理，等于全部撤销（__phys.restore()）。
import { state } from './state.js';
import { PHYSICS_CFG, findBodies, tweakNoCollide, tweakFreeze, tweakDamping, resettlePhysics, applySpringTuning } from './physics.js';
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
// 导出用：控制台里直接传 /^裙_/ 这种正则字面量时，String() 会带上斜杠，写进 physics.json 就匹配不到了，取 source
const reStr = (re) => (re instanceof RegExp ? re.source : String(re));

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
        '  springs("发")                   只读诊断：列出关节的弹簧情况（哪些轴开了弹簧、PMX 原始刚度）和刚体自身阻尼；参数可选，按刚体名过滤',
        '  spring(1.2, 0.5)                实时调弹簧关节：刚度倍率、阻尼(0~1，越大越抑制甩动；0 = 不加)。不写参数 = 打印当前全局值',
        '  vels(0.01)                      瞬时快照：列出当前速度最大的刚体（线/角速度分开排）',
        '  measure(1.5)                    连续采样 1.5 秒，按"每秒来回换向次数"排序找抖动源（建议待机时测，跳舞时整体位移会干扰）',
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
    if (!r.changed) return console.warn(`[__phys] 命中了 ${r.bodies} / ${r.with} 个刚体，但它们本来就不互相碰撞，没有改动（不会记入 export）`);
    applied.push({ kind: 'noCollide', bodies: reStr(bodies), with: reStr(withRe) });
    console.log(`已让 ${r.changed}/${r.bodies} 个刚体不再和 ${r.with} 个目标碰撞`);
    if (r.collateral.length) console.info(`同组被连带的 ${r.collateral.length} 个刚体：`, r.collateral.slice(0, 20).join('、'));
  },
  freeze(re) {
    const p = currentPhysics();
    if (!p) return;
    const r = tweakFreeze(p, re);
    if (!r.bodies) return console.warn('[__phys] 没命中刚体');
    if (!r.changed) return console.warn('[__phys] 命中的刚体本来就是静态的，没有改动（不会记入 export）');
    applied.push({ kind: 'freeze', bodies: reStr(re) });
    console.log(`已冻结 ${r.changed}/${r.bodies} 个刚体（其余本来就是静态）`);
  },
  damping(re, linear, angular) {
    const p = currentPhysics();
    if (!p) return;
    const r = tweakDamping(p, re, linear, angular);
    if (!r.bodies) return console.warn('[__phys] 没命中刚体');
    applied.push({ kind: 'damping', bodies: reStr(re), linear: typeof linear === 'number' ? linear : null, angular: typeof angular === 'number' ? angular : null });
    console.log(`已设置 ${r.changed} 个刚体的阻尼`);
  },
  // 瞬时快照：列出当前速度最大的刚体。线速度（单位/秒）和角速度（弧度/秒）单位不同，分开排序不相加；
  // 只看动态刚体（静态刚体由骨骼驱动，速度没有意义）。单帧分不清"抖动"和"正常甩动"，要定位抖动源用 measure()
  vels(min = 0.01) {
    const p = currentPhysics();
    if (!p) return;
    const rows = [];
    for (const rb of p.bodies) {
      const body = rb.body;
      if (!body || rb.params.type === 0 || typeof body.getLinearVelocity !== 'function') continue;
      const v = body.getLinearVelocity();
      const w = body.getAngularVelocity();
      const lin = Math.hypot(v.x(), v.y(), v.z());
      const ang = Math.hypot(w.x(), w.y(), w.z());
      if (lin < min && ang < min) continue;
      rows.push({
        name: rb.params.name,
        type: TYPE_NAME[rb.params.type] || rb.params.type,
        group: rb.params.groupIndex,
        线速度: +lin.toFixed(3),
        角速度: +ang.toFixed(3),
      });
    }
    rows.sort((a, b) => b.线速度 - a.线速度);
    console.log(`速度超过 ${min} 的动态刚体 ${rows.length} 个（按线速度排序；要找抖动源请用 __phys.measure()）`);
    if (rows.length) console.table(rows.slice(0, 15));
    return rows.length;
  },
  // 连续采样 seconds 秒（每个渲染帧采一次），统计每个动态刚体的：
  //   换向/秒：线速度方向与上一帧夹角超过 90° 的次数 / 秒。抖动 = 高频来回，这个值高（≳ 10）而位移范围小就是它
  //   位移范围：采样期间位置包围盒的对角线（模型整体在移动，如跳舞时，这个值会被拉大，所以建议待机时测）
  //   平均速度：采样期间线速度的平均值
  // 改动（noCollide / freeze …）前后各测一次对比，就能看出有没有压下去
  measure(seconds = 1.5) {
    const p = currentPhysics();
    if (!p) return;
    const EPS = 0.005; // 速度低于它的帧不计入换向（静止时的数值噪声）
    const stats = new Map();
    for (const rb of p.bodies) {
      if (!rb.body || rb.params.type === 0 || typeof rb.body.getLinearVelocity !== 'function') continue;
      stats.set(rb, { prev: null, flips: 0, speedSum: 0, frames: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
    }
    if (!stats.size) return console.warn('[__phys] 没有动态刚体可测');
    const t0 = performance.now();
    console.log(`[__phys] 开始采样 ${seconds} 秒…`);
    return new Promise((resolve) => {
      const tick = () => {
        // 物理实例被重建（切动作 / 点待机）后旧刚体已销毁，不能再读
        if (currentPhysics() !== p) {
          console.warn('[__phys] 采样期间物理实例被重建，本次作废');
          return resolve(null);
        }
        for (const [rb, st] of stats) {
          const v = rb.body.getLinearVelocity();
          const vx = v.x(), vy = v.y(), vz = v.z();
          const sp = Math.hypot(vx, vy, vz);
          if (st.prev && sp > EPS && st.prev.sp > EPS && vx * st.prev.x + vy * st.prev.y + vz * st.prev.z < 0) st.flips++;
          st.prev = { x: vx, y: vy, z: vz, sp };
          st.speedSum += sp;
          st.frames++;
          const o = rb.body.getWorldTransform().getOrigin();
          const pos = [o.x(), o.y(), o.z()];
          for (let i = 0; i < 3; i++) {
            if (pos[i] < st.min[i]) st.min[i] = pos[i];
            if (pos[i] > st.max[i]) st.max[i] = pos[i];
          }
        }
        const elapsed = (performance.now() - t0) / 1000;
        if (elapsed < seconds) return requestAnimationFrame(tick);
        const rows = [];
        for (const [rb, st] of stats) {
          if (!st.frames) continue;
          rows.push({
            name: rb.params.name,
            group: rb.params.groupIndex,
            '换向/秒': +(st.flips / elapsed).toFixed(1),
            位移范围: +Math.hypot(st.max[0] - st.min[0], st.max[1] - st.min[1], st.max[2] - st.min[2]).toFixed(3),
            平均速度: +(st.speedSum / st.frames).toFixed(3),
          });
        }
        rows.sort((a, b) => b['换向/秒'] - a['换向/秒'] || b.位移范围 - a.位移范围);
        const avgFps = rows.length ? Math.round(stats.values().next().value.frames / elapsed) : 0;
        console.log(`采样 ${elapsed.toFixed(1)} 秒（约 ${avgFps} 帧/秒）。换向/秒 越高、位移范围 越小，越像抖动；排最前面的就是抖动源`);
        if (rows.length) console.table(rows.slice(0, 15));
        resolve(rows);
      };
      requestAnimationFrame(tick);
    });
  },
  // 只读诊断：判断 spring() 调的刚度/阻尼对这个模型有没有用。
  // 没开弹簧的关节（刚度全 0）不受 stiffnessScale / damping(spring) 影响，只能靠刚体自身阻尼（damping()）和关节限位
  springs(re) {
    const p = currentPhysics();
    if (!p) return;
    const rx = re ? (re instanceof RegExp ? re : new RegExp(re)) : null;
    const AXES = ['位移X', '位移Y', '位移Z', '旋转X', '旋转Y', '旋转Z'];
    const rows = [];
    let total = 0;
    let withSpring = 0;
    for (const c of p.constraints || []) {
      const params = c.params || {};
      const bodyB = c.bodyB && c.bodyB.params;
      const name = (bodyB && bodyB.name) || '(未知)';
      if (rx && !rx.test(name)) continue;
      total++;
      const on = [];
      for (let i = 0; i < 6; i++) {
        const k = i < 3 ? params.springPosition && params.springPosition[i] : params.springRotation && params.springRotation[i - 3];
        if (k) on.push(`${AXES[i]}=${+Number(k).toFixed(2)}`);
      }
      if (on.length) withSpring++;
      rows.push({
        刚体: name,
        弹簧: on.length ? on.join(' ') : '无（刚度全 0）',
        刚体线性阻尼: bodyB ? +Number(bodyB.positionDamping).toFixed(3) : '-',
        刚体角阻尼: bodyB ? +Number(bodyB.rotationDamping).toFixed(3) : '-',
      });
    }
    console.log(`命中 ${total} 个关节，其中 ${withSpring} 个开了弹簧，${total - withSpring} 个没有（没有的不受 spring() 影响，改用 damping() 调刚体阻尼）`);
    if (rows.length) console.table(rows.slice(0, 40));
    if (rows.length > 40) console.log(`只显示前 40 行，共 ${rows.length} 行；传名字过滤，如 __phys.springs("发")`);
    return { total, withSpring };
  },
  spring(stiffnessScale, damping) {
    const p = currentPhysics();
    if (!p) return;
    if (stiffnessScale === undefined && damping === undefined) {
      return console.log(`当前全局配置：stiffnessScale=${PHYSICS_CFG.stiffnessScale}，damping=${PHYSICS_CFG.damping}（改 physics.js 里的 PHYSICS_CFG 才会永久生效）`);
    }
    const cfg = {
      stiffnessScale: typeof stiffnessScale === 'number' ? stiffnessScale : PHYSICS_CFG.stiffnessScale,
      damping: typeof damping === 'number' ? damping : PHYSICS_CFG.damping,
    };
    const n = applySpringTuning(p, cfg);
    if (!n) return console.warn('[__phys] 没有可调的弹簧约束');
    console.log(`已对 ${n} 个弹簧关节设置：刚度倍率 ${cfg.stiffnessScale}，阻尼 ${cfg.damping}（可重复调用，不会叠加；__phys.restore() 恢复全局值）`);
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
