// ZCode-Expand 桌宠 · 桌面模式的位置（纯函数，不 import electron）
//
// 位置记成「距离工作区最近两条边的距离」，而不是绝对坐标：换分辨率、任务栏挪位置、
// 拔掉一台显示器之后，她会回到同一个角落，而不是跑到屏幕外面。
// 由 desktop.mjs 把各显示器的工作区喂进来。

/**
 * @typedef {import('./pointer.mjs').Point} Point
 * @typedef {import('./pointer.mjs').Rect} Rect
 */

/**
 * @typedef {object} DesktopPetPosition
 * @property {'left'|'right'} h
 * @property {number} dx  到该水平边的距离（px）
 * @property {'top'|'bottom'} v
 * @property {number} dy
 * @property {Rect} [area]  量它时用的工作区，用来下次找回同一块屏
 */

/** 默认：右下角贴边 @type {DesktopPetPosition} */
export const DEFAULT_DESKTOP_POSITION = { h: 'right', dx: 0, v: 'bottom', dy: 0 };

/** @param {unknown} n @returns {boolean} */
const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/**
 * @param {unknown} r
 * @returns {boolean}
 */
const isRect = (r) => {
  const o = /** @type {Record<string, unknown>|null} */ (r);
  return !!o && typeof o === 'object' && finite(o.x) && finite(o.y) && finite(o.width) && finite(o.height) && o.width > 0 && o.height > 0;
};

/**
 * 解析存下来的位置；任何读不懂的内容都退回右下角
 * @param {unknown} raw
 * @returns {DesktopPetPosition}
 */
export function parseDesktopPosition(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_DESKTOP_POSITION };
  const { h, dx, v, dy, area } = /** @type {Record<string, unknown>} */ (raw);
  if ((h !== 'left' && h !== 'right') || (v !== 'top' && v !== 'bottom') || !finite(dx) || !finite(dy) || dx < 0 || dy < 0) {
    return { ...DEFAULT_DESKTOP_POSITION };
  }
  return {
    h,
    dx,
    v,
    dy,
    ...(isRect(area) ? { area: { x: area.x, y: area.y, width: area.width, height: area.height } } : {}),
  };
}

/** @param {Rect} r @returns {Point} */
const center = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

/**
 * 点到矩形的距离（点在内部时为 0）
 * @param {Point} a
 * @param {Rect} b
 * @returns {number}
 */
const distance = (a, b) => {
  const dx = Math.max(b.x - a.x, 0, a.x - (b.x + b.width));
  const dy = Math.max(b.y - a.y, 0, a.y - (b.y + b.height));
  return Math.hypot(dx, dy);
};

/**
 * 位置属于哪块工作区：同一块还在就用同一块，否则取最近的，再否则主屏
 * @param {DesktopPetPosition} position
 * @param {readonly Rect[]} areas
 * @param {Rect} primary
 * @returns {Rect}
 */
export function chooseArea(position, areas, primary) {
  const saved = position.area;
  if (!saved) return primary;
  const same = areas.find((a) => a.x === saved.x && a.y === saved.y && a.width === saved.width && a.height === saved.height);
  if (same) return same;
  const point = center(saved);
  return [...areas].sort((a, b) => distance(point, a) - distance(point, b))[0] ?? primary;
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

/**
 * 边长 size 的盒子在该工作区里的窗口位置，总是完整落在工作区内（放不下就贴左上角）
 * @param {DesktopPetPosition} position
 * @param {Rect} area
 * @param {number} size
 * @returns {Rect}
 */
export function boundsFromPosition(position, area, size) {
  const left = position.h === 'left' ? area.x + position.dx : area.x + area.width - size - position.dx;
  const top = position.v === 'top' ? area.y + position.dy : area.y + area.height - size - position.dy;
  return {
    x: Math.round(clamp(left, area.x, area.x + area.width - size)),
    y: Math.round(clamp(top, area.y, area.y + area.height - size)),
    width: size,
    height: size,
  };
}

/**
 * 窗口位置 → 位置记录（每个轴都从**更近**的那条边量）
 * @param {Rect} bounds
 * @param {Rect} area
 * @returns {DesktopPetPosition}
 */
export function positionFromBounds(bounds, area) {
  const left = bounds.x - area.x;
  const right = area.x + area.width - (bounds.x + bounds.width);
  const top = bounds.y - area.y;
  const bottom = area.y + area.height - (bounds.y + bounds.height);
  return {
    h: left < right ? 'left' : 'right',
    dx: Math.max(0, Math.round(Math.min(left, right))),
    v: top < bottom ? 'top' : 'bottom',
    dy: Math.max(0, Math.round(Math.min(top, bottom))),
    area: { ...area },
  };
}

/**
 * 拖完落点：跟窗口内一样，盒子中心落在某条边的外侧四分之一时就吸附到那条边，
 * 两个轴各自独立（于是有四个角 + 四条边）；否则原地不动，只是保持在 工作区内。
 * @param {Rect} bounds
 * @param {Rect} area
 * @returns {Rect}
 */
export function snapToArea(bounds, area) {
  /**
   * @param {number} start
   * @param {number} size
   * @param {number} from
   * @param {number} span
   * @returns {number}
   */
  const axis = (start, size, from, span) => {
    const middle = start + size / 2 - from;
    if (middle < span / 4) return from;
    if (middle > (span * 3) / 4) return from + span - size;
    return clamp(start, from, from + span - size);
  };
  return {
    x: Math.round(axis(bounds.x, bounds.width, area.x, area.width)),
    y: Math.round(axis(bounds.y, bounds.height, area.y, area.height)),
    width: bounds.width,
    height: bounds.height,
  };
}

/**
 * 和窗口内一样：贴在左边且完全贴边时，她转向屏幕里面
 * @param {DesktopPetPosition} position
 * @returns {boolean}
 */
export function facesLeft(position) {
  return position.h === 'left' && position.dx === 0;
}
