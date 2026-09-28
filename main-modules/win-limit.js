// ---------- 普通模式下主窗口的位置限制（纯几何计算，不依赖 electron，方便单独测试）----------
// 规则：窗口正中间"宽高各一半"的那块区域必须被所有显示器工作区（workArea，已排除任务栏）
// 合起来的范围完整覆盖——多块屏幕之间可以自由拖动，窗口横跨两块屏幕时中间区域算落在
// 范围内；屏幕大小不一、排列不规则时，落在"没有屏幕的空白处"的位置同样不被允许。
// areas：各显示器工作区的数组 [{ x, y, width, height }, ...]；bounds：{ x, y, width, height }。

// 中间区域是否被工作区完整覆盖。各显示器工作区互不重叠，所以直接累加相交面积，
// 等于中间区域面积就是完整覆盖（留 1px² 的浮点容差）
function isCenterVisible(bounds, areas) {
  const cx = bounds.x + bounds.width / 4;
  const cy = bounds.y + bounds.height / 4;
  const cw = bounds.width / 2;
  const ch = bounds.height / 2;
  let covered = 0;
  for (const a of areas) {
    const ix = Math.min(cx + cw, a.x + a.width) - Math.max(cx, a.x);
    const iy = Math.min(cy + ch, a.y + a.height) - Math.max(cy, a.y);
    if (ix > 0 && iy > 0) covered += ix * iy;
  }
  return covered >= cw * ch - 1;
}

// 兜底：把窗口位置强行拉回"最近的那块屏幕"的允许范围内。
// 用于窗口当前已经在范围之外（比如上次退出后拔掉了外接屏）或缩放后越界的情况。
// 每块屏幕单独算一个夹紧后的位置，取离目标位置最近的那个。
function nearestClamp(bounds, areas) {
  if (!areas.length) return { x: bounds.x, y: bounds.y };
  const { width: w, height: h } = bounds;
  let best = null;
  let bestDist = Infinity;
  for (const a of areas) {
    const x = Math.round(Math.min(Math.max(bounds.x, a.x - w / 4), a.x + a.width - (w * 3) / 4));
    const y = Math.round(Math.min(Math.max(bounds.y, a.y - h / 4), a.y + a.height - (h * 3) / 4));
    const dist = (x - bounds.x) ** 2 + (y - bounds.y) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = { x, y };
    }
  }
  return best;
}

// 沿 (dx, dy) 方向尽量走远：能整段走完就走完，否则二分找出最远的合法位置，
// 这样鼠标猛地一划也能贴着边界停下，不会因为单帧位移太大而停在离边界很远的地方
function advance(bounds, dx, dy, areas) {
  if (dx === 0 && dy === 0) return bounds;
  const at = (t) => ({ ...bounds, x: bounds.x + Math.round(dx * t), y: bounds.y + Math.round(dy * t) });
  if (isCenterVisible(at(1), areas)) return at(1);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (isCenterVisible(at(mid), areas)) lo = mid;
    else hi = mid;
  }
  return at(lo);
}

// 拖动：返回窗口的新位置 { x, y }。
// 目标位置合法就直接过去；否则先横向、再纵向各自尽量走远（贴着边界滑动，
// 斜着往边上拖时另一个方向不会被卡住）；被限制住的位移直接丢弃。
function constrainMove(cur, dx, dy, areas) {
  const target = { ...cur, x: cur.x + dx, y: cur.y + dy };
  if (isCenterVisible(target, areas)) return { x: target.x, y: target.y };
  if (!isCenterVisible(cur, areas)) return nearestClamp(target, areas);
  const afterX = advance(cur, dx, 0, areas);
  const afterY = advance(afterX, 0, dy, areas);
  return { x: afterY.x, y: afterY.y };
}

// 缩放：next 是缩放后的目标 bounds（左上角不动、宽高已变），合法就原样返回位置，
// 越界就把位置挪回允许范围内（尺寸始终能达到）
function constrainResize(next, areas) {
  if (isCenterVisible(next, areas)) return { x: next.x, y: next.y };
  return nearestClamp(next, areas);
}

module.exports = { isCenterVisible, nearestClamp, constrainMove, constrainResize };
