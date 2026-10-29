// ---------------- 物理（Ammo / Bullet） ----------------
// 头发/裙摆/飘带这些是物理骨骼，跳舞时开物理模拟它们才会自然摆动，
// 否则会僵在绑定姿态（飘带支棱出来"卡住"就是这个原因）
//
// ⚠ 碰撞组语义与 MMD 相反（three.js 的问题，不是模型文件的错）：
//   PMX 里每个刚体有一个 16 位「非衝突グループフラグ」，置 1 = 不与那一组碰撞；
//   但 MMDPhysics 在创建刚体时直接把它当 Bullet 的碰撞掩码传进去
//   （MMDPhysics.js 的 world.addRigidBody(body, 1 << groupIndex, groupTarget)），
//   而 Bullet 的掩码是置 1 = 会碰撞 —— 两者正好反过来。
//   后果举例：作者写"袖子不碰手腕"，在这里变成"袖子只碰手腕"（因此一直抖）；
//   作者写 flag=0（MMD 里是"碰所有组"），在这里掩码 0 变成"谁都不碰"。
//   所以本项目里所有 collision 相关配置（physics.json 的 bodies/with、__phys.find() 打印的
//   collidesWith、__phys.noCollide 的参数）都按「置 1 = 会碰撞」来理解，不要拿 MMD 编辑器的
//   非衝突グループ勾选状态直接对照，两边是反的。
//   three 的 MMD 支持在 r172 之后已整体移除，上游不会再修；症状用角色级 physics.json 收掉。
import { state } from './state.js';

// 头发/裙摆物理的全局调整参数（所有角色共用，想调就改这里）：
//   gravityScale    重力倍率，默认 1（调大如 1.5 让发梢更服帖下垂）
//   stiffnessScale  关节弹簧刚度倍率，默认 1（调大如 2 回弹更快、不易甩飞）
//   damping         追加阻尼 0~1（抑制甩动幅度。MMDPhysics 默认完全不设阻尼，头发容易飘得夸张）
// stiffnessScale 1.6→1.2、damping 0.25→0.16：当初是在"清零虚假初速度"补丁之后调低的，
// 但实测真正解决开场甩飞的是 dance.js 的 PHYSICS_ENGAGE_DELAY（开场先停物理），
// 不是清零速度/加热身步数。所以这两个值当时的调法依据并不牢靠，摆动手感不对可以重新调。
//   accumulateStep    屏幕刷新率高于 65Hz（如 144Hz）时，MMDPhysics 默认每一帧都强制跑一整步（1/65 秒），
//                     物理就比真实时间快（144Hz 约 2.2 倍）。打开后改成让 Bullet 自己按真实时间攒步数。
//                     模拟结果：60Hz 下和原来数值完全一致，144Hz 下抖动指标约减半。设 false = 用回 three.js 原行为
export const PHYSICS_CFG = {
  gravityScale: 1,
  stiffnessScale: 1.2,
  damping: 0.16,
  accumulateStep: true,
};

// 全局物理调整（头发/裙摆甩动太夸张时抑制）。
// gravityScale 通过 helper.add 的构造参数直接生效；stiffnessScale / damping
// 需要在物理对象创建后逐个关节（btGeneric6DofSpringConstraint）设置。
// MMDPhysics 不给弹簧设阻尼（PMX 的减衰参数也没被应用），所以追加阻尼对抑制"飘"最有效。
// opts.idle：这次创建的是待机动画的物理（physics.json 里 when 为 "idle" 的 noCollide / freeze 只在待机时生效；
// 待机动画只有头部在动，身体不动，关掉碰撞不会穿模，跳舞等大动作则保持原有碰撞）
export function applyPhysicsCfg(opts = {}) {
  const cfg = PHYSICS_CFG;
  const objs = state.mesh ? state.helper.objects.get(state.mesh) : null;
  const p = objs && objs.physics;
  if (!cfg || !p) return;
  if (cfg.stiffnessScale && cfg.stiffnessScale !== 1) {
    for (const c of p.constraints || []) {
      const con = c.constraint;
      if (!con || typeof con.getStiffness !== 'function' || typeof con.setStiffness !== 'function') continue;
      for (let i = 0; i < 6; i++) {
        const k = con.getStiffness(i);
        if (k > 0) con.setStiffness(i, k * cfg.stiffnessScale);
      }
    }
  }
  if (cfg.damping) {
    // 弹簧约束带阻尼接口就用它；没有就落到刚体阻尼上（相当于空气阻力，kinematic 骨骼刚体不受影响）
    let jointDamping = false;
    for (const c of p.constraints || []) {
      const con = c.constraint;
      if (!con || typeof con.setDamping !== 'function') continue;
      for (let i = 0; i < 6; i++) con.setDamping(i, cfg.damping);
      jointDamping = true;
    }
    if (!jointDamping) {
      for (const b of p.bodies || []) {
        const body = b.body;
        if (!body || typeof body.getLinearDamping !== 'function') continue;
        const ld = body.getLinearDamping();
        const ad = body.getAngularDamping();
        body.setDamping(Math.min(ld + cfg.damping, 1), Math.min(ad + cfg.damping, 1));
      }
    }
  }
  applyStepAccumulation(p);
  applyCharacterTweaks(p, state.physicsTweaks, opts);
}

// ---------------- 步长 / 按角色微调 ----------------

// 刚体名（PMX 里的名字）匹配：re 可以是 RegExp 或正则字符串。返回 MMDPhysics 的 RigidBody 包装对象数组
export function findBodies(physics, re) {
  const rx = re instanceof RegExp ? re : new RegExp(re);
  return (physics.bodies || []).filter((rb) => rx.test((rb.params && rb.params.name) || ''));
}

// 替换 MMDPhysics._stepSimulation：把真实经过的时间直接交给 Bullet 按 unitStep 攒子步。
// three.js 原实现在 delta < unitStep 时会强制跑一整步（见 PHYSICS_CFG.accumulateStep 的说明），
// delta ≥ unitStep 时和下面完全一样，所以刷新率 ≤65Hz 的机器行为不变。
function stepAccumulated(delta) {
  const unit = this.unitStep;
  const dt = Math.min(delta, unit * this.maxStepNum); // 卡顿后一次性补太多步会炸，和原实现一样封顶
  this.world.stepSimulation(dt, this.maxStepNum, unit);
}

function applyStepAccumulation(physics) {
  try {
    if (PHYSICS_CFG.accumulateStep) physics._stepSimulation = stepAccumulated;
  } catch (err) {
    console.warn('[pet] 物理步长设置失败，已沿用默认值:', err);
  }
}

// 改某个刚体的碰撞掩码（它能和哪些组碰撞）。
// 必须把刚体从世界摘下来再按新掩码加回去：Bullet 的碰撞对在宽相阶段按掩码生成，只改掩码不会清掉
// 已经存在的碰撞对（控制台里实时调试时就是这种情况）；摘除时会连带清掉它参与的所有碰撞对。
// params 是从模型几何里共享出来的对象，不能原地改，换成本实例私有的副本
function setBodyMask(physics, rb, mask) {
  physics.world.removeRigidBody(rb.body);
  physics.world.addRigidBody(rb.body, 1 << rb.params.groupIndex, mask);
  rb.params = { ...rb.params, groupTarget: mask };
}

// bodiesRe 命中的刚体不再和 withRe 命中的刚体碰撞。
// 碰撞过滤是按"组"做的：把 withRe 命中刚体所在的组从 bodiesRe 刚体的掩码里去掉，
// 所以同组里没被 withRe 命中的刚体也会一起被排除，这部分放进 collateral 返回，让调用方提示。
export function tweakNoCollide(physics, bodiesRe, withRe) {
  const A = findBodies(physics, bodiesRe);
  const B = findBodies(physics, withRe);
  const result = { bodies: A.length, with: B.length, changed: 0, collateral: [] };
  if (!A.length || !B.length) return result;
  const groups = new Set(B.map((rb) => rb.params.groupIndex));
  let clearBits = 0;
  for (const g of groups) clearBits |= 1 << g;
  const inB = new Set(B);
  result.collateral = (physics.bodies || [])
    .filter((rb) => !inB.has(rb) && groups.has(rb.params.groupIndex))
    .map((rb) => rb.params.name);
  for (const rb of A) {
    const mask = rb.params.groupTarget & ~clearBits;
    if (mask !== rb.params.groupTarget) {
      setBodyMask(physics, rb, mask);
      result.changed++;
    }
  }
  return result;
}

// 命中的动态刚体改成"跟随骨骼"（和 PMX 里的静态刚体一样，由动画驱动、不再被模拟），
// 对应骨骼也不再被物理改写。刚体质量/类型要改，必须先从世界摘下来再加回去
export function tweakFreeze(physics, re) {
  const Ammo = window.Ammo;
  const world = physics.world;
  let frozen = 0;
  const targets = findBodies(physics, re);
  for (const rb of targets) {
    if (!rb.body || rb.params.type === 0 || rb.params.boneIndex === -1) continue;
    world.removeRigidBody(rb.body);
    const zero = new Ammo.btVector3(0, 0, 0);
    rb.body.setMassProps(0, zero);
    Ammo.destroy(zero);
    rb.body.setCollisionFlags(rb.body.getCollisionFlags() | 2); // CF_KINEMATIC_OBJECT
    rb.body.setActivationState(4); // DISABLE_DEACTIVATION，和 MMDPhysics 对静态刚体的处理一致
    world.addRigidBody(rb.body, 1 << rb.params.groupIndex, rb.params.groupTarget);
    rb.params = { ...rb.params, type: 0 };
    rb.reset(); // 刚体传送回当前骨骼
    frozen++;
  }
  return { bodies: targets.length, changed: frozen };
}

// 覆盖命中刚体的阻尼（0~1，传 null / undefined 的那一项保持不变）
export function tweakDamping(physics, re, linear, angular) {
  const targets = findBodies(physics, re);
  for (const rb of targets) {
    const lin = typeof linear === 'number' ? linear : rb.params.positionDamping;
    const ang = typeof angular === 'number' ? angular : rb.params.rotationDamping;
    rb.body.setDamping(lin, ang);
  }
  return { bodies: targets.length, changed: targets.length };
}

// 把 physics.json 的内容套到刚体上。写错名字（一个刚体都没命中）会在控制台提示，方便排查
export function applyCharacterTweaks(physics, tweaks, opts = {}) {
  if (!tweaks) return;
  const tag = '[pet][physics.json]';
  try {
    const on = (it, dflt) => (it.when || dflt) === 'always' || !!opts.idle; // when: "idle" 的条目只在待机动画的物理里生效
    for (const it of tweaks.noCollide || []) {
      if (!on(it, 'idle')) continue;
      const r = tweakNoCollide(physics, it.bodies, it.with);
      if (!r.bodies || !r.with) console.warn(`${tag} noCollide 没命中刚体：bodies "${it.bodies}" ${r.bodies} 个，with "${it.with}" ${r.with} 个`);
      else if (r.collateral.length) {
        console.info(`${tag} noCollide "${it.bodies}" ↛ "${it.with}"：同组的另外 ${r.collateral.length} 个刚体也一并不再碰撞（如 ${r.collateral.slice(0, 5).join('、')}）`);
      }
    }
    for (const it of tweaks.freeze || []) {
      if (!on(it, 'idle')) continue;
      const r = tweakFreeze(physics, it.bodies);
      if (!r.bodies) console.warn(`${tag} freeze 没命中刚体："${it.bodies}"`);
    }
    for (const it of tweaks.damping || []) {
      if (!on(it, 'always')) continue;
      const r = tweakDamping(physics, it.bodies, it.linear, it.angular);
      if (!r.bodies) console.warn(`${tag} damping 没命中刚体："${it.bodies}"`);
    }
  } catch (err) {
    console.error(`${tag} 应用失败，已忽略剩余配置:`, err);
  }
}

// 把物理刚体传送回当前骨骼姿态（RigidBody._setTransformFromBone）。
// 用在"物理停了一段时间、骨骼已经转到别处"之后重新开启物理之前，避免刚体从旧位置被猛拽过来。
//
// 开场甩飞/裙摆错位的真正解法是 dance.js 里的 PHYSICS_ENGAGE_DELAY：开场先关物理，
// 等大转向播完再 reset + 开启。开场处试过的"清零刚体线/角速度"和"加大 warmup 步数（8/16/26）"
// 对"甩飞"没有帮助，所以默认只做 reset。
// 循环动作衔接点的抖动同理：真正原因是 helper 在循环点默认会 reset 物理，
// 已在 dance.js 里对循环动作关掉 resetPhysicsOnLoop，不需要额外补丁。
//
// steps > 0：reset 之后再预演 steps 步（每步 1/60 秒，同步一帧内跑完）。
// 用途不是防甩飞，而是让头发/裙摆在物理接管前先垂落到位：reset 会把刚体放回"静止形状"，
// 物理一开就要实时垂落，肉眼能看到一下下坠+摆动；预演后接管时已是垂着的状态。
export function resettlePhysics(physicsObj, steps = 0) {
  if (!physicsObj) return;
  physicsObj.reset();
  if (steps > 0) physicsObj.warmup(steps);
}

let ammoPromise = null;
export function ensureAmmo() {
  if (!ammoPromise) {
    ammoPromise = new Promise((resolve) => {
      if (window.Ammo && window.Ammo.btVector3) return resolve(true);
      const s = document.createElement('script');
      s.src = '/node_modules/three/examples/jsm/libs/ammo.wasm.js';
      s.onload = async () => {
        try {
          window.Ammo = await window.Ammo(); // MMDPhysics 引用的是全局 Ammo
          resolve(true);
        } catch (err) {
          console.error('[pet] Ammo 初始化失败，物理已禁用:', err);
          resolve(false);
        }
      };
      s.onerror = () => {
        console.error('[pet] ammo.wasm.js 加载失败，物理已禁用');
        resolve(false);
      };
      document.head.appendChild(s);
    });
  }
  return ammoPromise;
}

// 物理实例 -> 它在构造期间 new 出来的全部 Ammo 对象（Set）。
// 用来兜底回收 shape / motionState / constructionInfo，以及 world 内部的
// dispatcher / broadphase / solver / collisionConfig ——这些 three.js 的 MMDPhysics
// 都没有存成能从外部访问的字段，之前版本只能眼睁睁看着它们泄漏。
const physicsAmmoObjects = new WeakMap();

// 临时把 window.Ammo 上所有 bt* 构造函数换成"顺手记一笔"的版本，
// 在 fn()（也就是 helper.add(...,{physics:true}) 这一次同步调用）执行期间，
// 把过程中 new 出来的每一个 Ammo 对象都塞进 Set 里，跑完立刻把原函数换回去，
// 不影响这次调用之外的任何 Ammo 使用。
export function trackAmmoObjectsDuring(fn) {
  const Ammo = window.Ammo;
  const created = new Set();
  const restores = [];
  if (Ammo) {
    for (const key of Object.keys(Ammo)) {
      if (!/^bt[A-Z]/.test(key)) continue; // 只拦 Bullet 的类（btVector3/btRigidBody/...），别的字段不动
      const orig = Ammo[key];
      if (typeof orig !== 'function') continue;
      const wrapped = function (...args) {
        const inst = new orig(...args);
        created.add(inst);
        return inst; // 构造函数显式 return 对象时，new 出来的就是这个对象——原样返回，用法和原类完全一样
      };
      Ammo[key] = wrapped;
      restores.push([key, orig]);
    }
  }
  try {
    fn();
  } finally {
    for (const [key, orig] of restores) Ammo[key] = orig;
  }
  return created;
}

// 记录一个物理实例构造期间创建出的 Ammo 对象，供 disposePhysics 兜底销毁。
export function trackPhysicsObjects(physics, created) {
  physicsAmmoObjects.set(physics, created);
}

// 彻底释放一个 MMDPhysics 实例在 Ammo wasm 堆里占用的对象。
// three.js 的 MMDPhysics（已废弃，r172 起移除）本身不带销毁方法：
// 每根物理骨骼（头发/裙摆…）在 _init 时各自 new 出刚体(body)、形状(shape)、
// MotionState、ConstructionInfo、私有的两个 Transform，约束(constraint)之间
// 也各 new 一个 6DofSpringConstraint，world 自己还带着 dispatcher/broadphase/
// solver/collisionConfig——这些全是 wasm 线性内存里的对象，JS 变量丢了不会被 GC 回收。
// 早期版本只 destroy(world) 一个对象，其余全部永久残留；换几次角色/动作攒下来，
// wasm 堆用满就会 abort(OOM)，Ammo 从此整个失效、所有动作都卡死。
// 现在能拿到具名引用的（body/constraint/两个 boneOffset Transform/对象池）直接按
// Bullet 要求的顺序摘除+销毁；剩下拿不到具名引用的（shape/motionState/
// constructionInfo/dispatcher/broadphase/solver/collisionConfig）靠
// physicsAmmoObjects 里记录的"构造期间创建过的所有对象"兜底销毁掉，
// 用 destroyed 去重，避免同一个对象被销毁两次。
export function disposePhysics(physics) {
  if (!physics || !window.Ammo || !window.Ammo.destroy) return;
  const Ammo = window.Ammo;
  const world = physics.world;
  const tracked = physicsAmmoObjects.get(physics);
  const destroyed = new Set();
  const safeDestroy = (o) => {
    if (!o || destroyed.has(o)) return;
    destroyed.add(o);
    try {
      Ammo.destroy(o);
    } catch {}
  };
  try {
    // 约束：先从 world 摘除，再销毁
    for (const c of physics.constraints || []) {
      try {
        if (c.constraint && world) world.removeConstraint(c.constraint);
      } catch {}
      safeDestroy(c.constraint);
    }
    // 刚体：先从 world 摘除，再销毁刚体本身，以及它私有的两个 Transform
    for (const b of physics.bodies || []) {
      try {
        if (b.body && world) world.removeRigidBody(b.body);
      } catch {}
      safeDestroy(b.body);
      safeDestroy(b.boneOffsetForm);
      safeDestroy(b.boneOffsetFormInverse);
    }
    // ResourceManager 对象池里还躺着的 Transform/Quaternion/Vector3（没被复用掉的那些）
    const manager = physics.manager;
    if (manager) {
      for (const arr of [manager.transforms, manager.quaternions, manager.vector3s]) {
        for (const o of arr || []) safeDestroy(o);
      }
    }
    // world 必须先于它内部的 dispatcher/broadphase/solver/collisionConfig 销毁
    // （world 析构时还会用到它们；这几个反过来对 world 没有所有权关系）
    safeDestroy(world);
    // 兜底：形状/MotionState/ConstructionInfo，以及上面这几个内部对象
    if (tracked) {
      for (const o of tracked) safeDestroy(o);
    }
  } catch {}
  physicsAmmoObjects.delete(physics);
}
