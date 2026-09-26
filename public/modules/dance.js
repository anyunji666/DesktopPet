// ---------------- 舞蹈 ----------------
import * as THREE from 'three';
import { MMDAnimationHelper } from 'three/addons/animation/MMDAnimationHelper.js';
import { state, clock, loader, tmpV, audio, setGazeCenter } from './state.js';
import { PHYSICS_CFG, ensureAmmo, applyPhysicsCfg, trackAmmoObjectsDuring, trackPhysicsObjects, disposePhysics, resettlePhysics } from './physics.js';
import { showBubble, showLoading, hideLoading } from './ui.js';

// 待机动画：点"待机"或舞蹈播完后，循环播放指定舞蹈（可用 from/to 截片段，帧区间按 30fps 计）。
// 片段建议选原地不动的部分；
// 可用 node tools/extract-pose.js <pmx> <vmd> --scan <from> <to> <step> 扫描手腕高度来找。
// 设为 null = 用默认的绑定姿态+摆动待机
const IDLE_DANCE = { name: '生气了亲一下就哄好了' }; // 生气抱臂站姿 + 头颈微动（14 秒整段循环）

// 特殊动作：不出现在右键菜单里，由程序自动使用
// 开场舞：打开软件/切换角色后自动循环播放，点"待机"才回待机姿态
// 退场舞：切换角色时给旧角色播一次，播完才卸载旧模型
export const ENTRANCE_DANCE_NAME = 'Stay Tonight';
export const EXIT_DANCE_NAME = '张元英转圈';

export function stopDance() {
  state.danceMode = false;
  state.danceEndAt = Infinity;
  state.danceEndCallback = null;
  state.entranceMode = false;
  audio.pause();
  audio.currentTime = 0;
  document.getElementById('hint').style.display = 'block'; // 回待机时恢复说明文字
  if (state.mesh) resetPose();
  // 丢弃旧 helper、重建全新实例：
  // MMDAnimationHelper 内部有骨骼备份缓存（backupBones）和混合器状态，
  // 换动画时会把这些残留状态带入新动画，导致模型从旧位置开始
  // 物理对象在 Ammo 的 wasm 堆里不会被 GC，必须手动逐个销毁（见 physics.js 的 disposePhysics）
  try {
    const objs = state.mesh && state.helper ? state.helper.objects.get(state.mesh) : null;
    if (objs && objs.physics) disposePhysics(objs.physics);
  } catch {}
  state.helper = new MMDAnimationHelper({ pmxAnimation: true }); // 付与必须先于 IK，同 state.js 里首次创建时的原因
  state.helperHasMesh = false;
  state.danceFollow = null;
  state.danceZoom = 0; // danceZoomCur 在渲染循环里平滑回 0
  state.loopingAction = null; // 见 app.js animate() 里的循环衔接补热逻辑
}

export function resetPose() {
  // 还原全身骨骼到绑定姿态，并清空表情
  for (const { b, p, q, s } of state.basePose) {
    b.position.copy(p);
    b.quaternion.copy(q);
    b.scale.copy(s);
  }
  if (state.mesh.morphTargetInfluences) state.mesh.morphTargetInfluences.fill(0);
}

// 待机动画：循环播放 IDLE_DANCE 配置的片段（静音、不跟随镜头、保留说明文字，期间允许点击互动）
export function playIdle() {
  const idx = IDLE_DANCE ? state.dances.findIndex((d) => d.name === IDLE_DANCE.name) : -1;
  if (idx < 0) {
    setGazeCenter(false); // 回待机姿态：视线基准回到脸高
    stopDance();
    return;
  }
  playDance(idx, {
    loop: true,
    clipFrom: IDLE_DANCE.from,
    clipTo: IDLE_DANCE.to,
    silent: true,
    keepHint: true,
    noFollow: true,
    gazeCenter: false, // 待机动画属于待机：视线基准留在脸高，不移到模型中心
  });
}

// 动作加载/切换过程中出错时的兜底恢复：不管是动画解析异常还是物理创建失败（比如 Ammo OOM），
// 都必须把 danceMode/helperHasMesh/exitInProgress 这些状态复位，否则 animate() 里等着
// "退场舞播完再切换角色"的判断条件永远不成立，exitInProgress 会永久卡 true，
// 之后菜单里的待机/跳舞指令全部被挡住——即使切换角色的退场舞失败了，也要让 opts.onEnd
// （真正的切换逻辑）照常执行，不能把用户晾在一个已经动不了的旧角色上。
export function recoverFromDanceFailure(opts) {
  stopDance(); // 顺带做物理清理、重建 helper，把状态复位到"待机姿态"
  state.exitInProgress = false;
  state.loadingDance = false;
  clearTimeout(state.pendingDanceTimer);
  hideLoading();
  setGazeCenter(false); // 动作没切成，停在待机姿态：视线基准回到脸高
  showBubble(opts && opts.onEnd ? '切换角色时动作出了点问题，已直接切换' : '动作切换出了点问题…再试一次？');
  if (opts && opts.onEnd) opts.onEnd(); // 退场舞是切换角色用的：哪怕它失败了，切换本身也要继续
}

// opts.loop: 循环播放（开场舞/待机动画），不自动回待机；opts.onEnd: 播完一次后的回调（退场舞）
// opts.clipFrom/clipTo: 只播放帧区间片段；opts.silent: 静音；opts.keepHint: 保留说明文字；opts.noFollow: 不跟随镜头
// opts.gazeCenter: 视线基准移到模型几何中心（默认 true，即所有非待机动作）；待机动画传 false 保持脸高
export function playDance(index, opts = {}) {
  if (!state.mesh || !state.dances[index]) return;
  if (state.loadingDance) return; // 动作加载中，忽略重复点击
  clearTimeout(state.pendingDanceTimer);
  const d = state.dances[index];

  const startLoad = async () => {
    state.loadingDance = true;
    showLoading('加载动作：' + d.name);
    const hasAmmo = await ensureAmmo(); // 首次加载要下载/编译 wasm，之后再切舞就是秒回
    loader.loadAnimation(
      d.vmd,
      state.mesh,
      (clip) => {
        state.loadingDance = false;
        try {
          // 剥离当前角色要屏蔽的骨骼轨道（轨道名形如 .bones[骨骼名].position）
          if (state.ignoreBones.size) {
            clip.tracks = clip.tracks.filter((t) => {
              const m = t.name.match(/^\.bones\[(.+?)\]\./);
              return !m || !state.ignoreBones.has(m[1]);
            });
          }
          // 只播放片段（待机动画用）：按 30fps 的帧区间裁剪
          if (opts.clipFrom !== undefined && opts.clipTo !== undefined) {
            clip = THREE.AnimationUtils.subclip(clip, clip.name + '-seg', opts.clipFrom, opts.clipTo, 30);
          }
          // FK 作者的动作：腿部全靠 足/ひざ/足首 旋转轨道，IK 目标基本不动。
          // 开着 IK 播放会把脚锁死在目标点上（"粘脚"），检测到就关 IK 求解
          let fkKeys = 0;
          let ikKeys = 0;
          for (const t of clip.tracks) {
            const m = t.name.match(/^\.bones\[(.+?)\]\.(\w+)$/);
            if (!m) continue;
            if (/^[左右](足|ひざ|足首)$/.test(m[1]) && m[2] === 'quaternion') fkKeys += t.times.length;
            if (/^[左右]足ＩＫ$/.test(m[1]) && m[2] === 'position') ikKeys += t.times.length;
          }
          const fkAuthored = fkKeys > 200 && ikKeys * 10 < fkKeys;
          stopDance(); // 移除旧动画并重置骨骼姿态
          const physicsParams = { physics: hasAmmo };
          if (PHYSICS_CFG.gravityScale && PHYSICS_CFG.gravityScale !== 1) {
            physicsParams.gravity = new THREE.Vector3(0, -9.8 * 10 * PHYSICS_CFG.gravityScale, 0);
          }
          // physics: true 时会创建一整套 Ammo 刚体/形状/约束（见 physics.js 里 disposePhysics 顶部注释），
          // 拿 trackAmmoObjectsDuring 把这次调用期间 new 出来的对象全记下来，供以后彻底销毁
          const createdAmmoObjs = physicsParams.physics
            ? trackAmmoObjectsDuring(() => state.helper.add(state.mesh, { animation: clip, ...physicsParams }))
            : (state.helper.add(state.mesh, { animation: clip, ...physicsParams }), null);
          if (createdAmmoObjs) {
            const physicsObj = state.helper.objects.get(state.mesh).physics;
            if (physicsObj) trackPhysicsObjects(physicsObj, createdAmmoObjs);
          }
          applyPhysicsCfg();
          // add() 的 ik 参数只对 PMX 动画路径生效，mixer 路径要用 enable 关
          if (fkAuthored) state.helper.enable('ik', false);
          state.helperHasMesh = true;
          state.helper.update(0); // 立即求值第 0 帧，让模型从新动作的起始位置开始
          // 骨骼从绑定姿态瞬间跳到第 0 帧姿态会产生虚假初速度，见 resettlePhysics 注释
          const physicsAfterPose = state.helper.objects.get(state.mesh).physics;
          resettlePhysics(physicsAfterPose);
          hideLoading(); // 挪到复位/预热之后：把这段过程盖在加载遮罩下，用户看不到抖动
          // 从候选根骨骼里选 XZ 位移幅度最大的做镜头跟随（位移轨道可能是本地坐标，幅度比较不受影响）
          state.danceFollow = null;
          state.danceZoom = 0;
          let bestRange = 0;
          let bestName = null;
          for (const t of clip.tracks) {
            const m = t.name.match(/^\.bones\[(.+?)\]\.position$/);
            if (!m || !['センター', 'グルーブ', '全ての親', '腰'].includes(m[1])) continue;
            let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
            for (let i = 0; i < t.values.length; i += 3) {
              minX = Math.min(minX, t.values[i]);
              maxX = Math.max(maxX, t.values[i]);
              minZ = Math.min(minZ, t.values[i + 2]);
              maxZ = Math.max(maxZ, t.values[i + 2]);
            }
            const range = maxX - minX + (maxZ - minZ);
            if (range > bestRange) {
              bestRange = range;
              bestName = m[1];
            }
          }
          if (!opts.noFollow && bestName && bestRange > 0.5 && state.mesh.skeleton) {
            const bone = state.mesh.skeleton.bones.find((b) => b.name === bestName);
            if (bone) {
              bone.getWorldPosition(tmpV);
              state.danceFollow = { bone, x: tmpV.x, z: tmpV.z };
              state.danceZoom = Math.min(15, Math.max(0, (bestRange - 3) * 0.35)); // 走得越远镜头拉得越远
            }
          }
          // 平滑跟随从动作起始位置开始，避免镜头开场猛跳
          const fb = (state.danceFollow && state.danceFollow.bone) || state.followBone;
          if (fb) {
            fb.getWorldPosition(tmpV);
            state.followSmooth.x = tmpV.x;
            state.followSmooth.z = tmpV.z;
          }
          state.danceMode = true;
          // 非待机动作（开场舞/普通舞/退场舞）：视线基准移到模型中心；待机动画保持脸高
          setGazeCenter(opts.gazeCenter !== false);
          document.getElementById('hint').style.display = opts.keepHint ? 'block' : 'none'; // 跳舞时隐藏说明文字
          // 普通舞：播完一次就回待机，LoopOnce 停在末帧，
          // 由 animate() 顶层计时统一触发 stopDance（避免在 mixer.update 内部处理，时序不可靠）。
          // 开场舞（opts.loop）：LoopRepeat 一直循环，直到用户点"待机"。
          const mixer = state.helper.objects.get(state.mesh).mixer;
          const act = mixer.clipAction(clip);
          state.danceEndCallback = opts.onEnd || null;
          state.entranceMode = !!opts.loop;
          if (opts.loop) {
            act.setLoop(THREE.LoopRepeat, Infinity);
            state.danceEndAt = Infinity;
            // 循环动作衔接处（最后一帧跳回第0帧）交给 app.js 的 animate() 检测并补一次
            // warmup（MMDAnimationHelper 默认已经在 loop 时对 physics 做 reset，
            // 这里只是在那之后再补几步热身，让头发/裙摆更快落位、减少残留摆动）
            state.loopingAction = act;
          } else {
            act.setLoop(THREE.LoopOnce, 1);
            act.clampWhenFinished = true;
            state.danceEndAt = clock.elapsedTime + clip.duration;
            state.loopingAction = null;
          }
          if (d.wav && !opts.silent) {
            audio.src = d.wav;
            audio.loop = !!opts.loop;
            audio.play().catch(() => {});
          }
        } catch (err) {
          console.error(err);
          recoverFromDanceFailure(opts);
        }
      },
      undefined,
      (err) => {
        console.error(err);
        recoverFromDanceFailure(opts);
      }
    );
  };

  if (state.danceMode || state.helperHasMesh) {
    // 跳舞中切换：先回到待机姿态，短暂停顿后再载入新动作
    stopDance();
    state.pendingDanceTimer = setTimeout(startLoad, 450);
  } else {
    startLoad();
  }
}

// 切换角色：先给旧角色播一次退场舞，播完再执行真正的切换
export function playExitThen(cb) {
  const exitIdx = state.dances.findIndex((d) => d.name === EXIT_DANCE_NAME);
  if (!state.mesh || exitIdx < 0 || state.loadingDance) {
    cb(); // 没有模型/没有退场舞/动作加载中：直接切换
    return;
  }
  state.exitInProgress = true;
  playDance(exitIdx, {
    onEnd: () => {
      state.exitInProgress = false;
      cb();
    },
  });
}
