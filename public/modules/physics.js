// ---------------- 物理（Ammo / Bullet） ----------------
// 头发/裙摆/飘带这些是物理骨骼，跳舞时开物理模拟它们才会自然摆动，
// 否则会僵在绑定姿态（飘带支棱出来"卡住"就是这个原因）
import { state } from './state.js';

// 头发/裙摆物理的全局调整参数（所有角色共用，想调就改这里）：
//   gravityScale    重力倍率，默认 1（调大如 1.5 让发梢更服帖下垂）
//   stiffnessScale  关节弹簧刚度倍率，默认 1（调大如 2 回弹更快、不易甩飞）
//   damping         追加阻尼 0~1（抑制甩动幅度。MMDPhysics 默认完全不设阻尼，头发容易飘得夸张）
// stiffnessScale 1.6→1.2、damping 0.25→0.16：resettlePhysics 加了清零虚假初速度的
// 修复后，甩飞已经从根上解决，不再需要靠调硬/调重阻尼来压制症状，调低这两个值
// 让头发/裙摆的摆动恢复柔软自然、不那么发硬发滞。
export const PHYSICS_CFG = {
  gravityScale: 1,
  stiffnessScale: 1.2,
  damping: 0.16,
};

// 全局物理调整（头发/裙摆甩动太夸张时抑制）。
// gravityScale 通过 helper.add 的构造参数直接生效；stiffnessScale / damping
// 需要在物理对象创建后逐个关节（btGeneric6DofSpringConstraint）设置。
// MMDPhysics 不给弹簧设阻尼（PMX 的减衰参数也没被应用），所以追加阻尼对抑制"飘"最有效。
export function applyPhysicsCfg() {
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
}

// 骨骼姿态发生"瞬间跳变"时（动作刚加载完从绑定姿态跳到第0帧、或循环动作播完
// 最后一帧跳回第0帧），MMDPhysics 会用极短的内部步长对这段跳变做有限差分，
// 算出一个离谱的瞬时速度，经弹簧约束甩到头发/裙摆上，表现为甩飞、服饰错位。
// 加大 warmup 步数（试过 8/16/26）对这个没用：three.js 的 MMDPhysics.reset()
// 只把刚体的位置/朝向传送回当前骨骼（RigidBody._setTransformFromBone），
// 完全没有清零刚体自身的线速度/角速度——那股离谱的瞬时速度就原封不动地
// 留在刚体上，warmup() 再跑多少步都只是让这份虚假速度继续参与模拟、慢慢
// 衰减，而不是消失。这里在 reset() 之后手动把每个刚体的线速度/角速度清零、
// 顺带清一下残留的外力，从源头掐断虚假初速度，再进 warmup 让弹簧/重力
// 从"静止"状态开始收敛，而不是从"带着乱七八糟速度"开始。
export function resettlePhysics(physicsObj, steps = 8) {
  if (!physicsObj) return;
  physicsObj.reset();
  const Ammo = window.Ammo;
  if (Ammo) {
    const zero = new Ammo.btVector3(0, 0, 0);
    for (const b of physicsObj.bodies || []) {
      const body = b.body;
      if (!body) continue;
      if (typeof body.setLinearVelocity === 'function') body.setLinearVelocity(zero);
      if (typeof body.setAngularVelocity === 'function') body.setAngularVelocity(zero);
      if (typeof body.clearForces === 'function') body.clearForces();
    }
    Ammo.destroy(zero);
  }
  physicsObj.warmup(steps);
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
