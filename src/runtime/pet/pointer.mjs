// ZCode-Expand 桌宠 · 桌面模式的点击穿透判定（纯函数，不 import electron）
//
// 桌面小窗有三种原生状态：
//   through      setIgnoreMouseEvents(true)：点击穿过去，页面什么都收不到，不装钩子。
//   forward      setIgnoreMouseEvents(true, {forward: true})：点击照样穿过去，但页面能收到
//                鼠标移动，于是能自己判断光标在图上还是在透明处。forwarding 是系统级低级
//                鼠标钩子（WH_MOUSE_LL）：一直开着会让别的窗口里光标闪，还可能悄悄失效
//                （electron#33281），所以只在桌宠附近打开。
//   interactive  setIgnoreMouseEvents(false)：这一下点击归桌宠。
//
// 由 pet-desktop 把光标位置喂进来、应用结果。

/**
 * @typedef {object} Point
 * @property {number} x
 * @property {number} y
 */

/**
 * @typedef {object} Rect
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/** @typedef {'through'|'forward'|'interactive'} PointerMode */

/**
 * 页面就它看到的最后一次鼠标移动给出的判决，坐标是窗口内（client）坐标
 * @typedef {object} PointerReport
 * @property {boolean} hit  图上不透明的像素、或一张打开的对话气泡，正压在 (x, y) 上
 * @property {number} x
 * @property {number} y
 * @property {Rect|null} body  角色图的盒子；「靠近」是从它量的
 */

/**
 * @typedef {object} PointerInputs
 * @property {Point|null} cursor  屏幕坐标（DIP）；未知时 null
 * @property {Rect} window  窗口内容区在屏幕上的位置
 * @property {PointerReport|null} report
 * @property {boolean} dragging
 */

/**
 * @typedef {object} PointerState
 * @property {PointerMode} mode
 * @property {boolean} near
 */

export const POINTER_TIMING = {
  /** 主进程轮询光标：页面没消息时的兜底 */
  pollMs: 250,
  /** 原生状态每隔这么久重设一次，拖拽 / 显示器变化 / 唤醒之后也重设 */
  reissueMs: 5000,
  /** 页面没报告的拖拽（渲染进程没了）超过这么久就不再占着窗口 */
  dragHoldMs: 10_000,
};

/** 进入这个距离开始 forwarding，离开要超过更大的那个才停（滞回，避免边界抖动） */
export const NEAR_ENTER = 96;
export const NEAR_EXIT = 128;
/** 报告离光标这么近，才算是在描述光标当下的位置 */
const SAME_POINT = 3;

/**
 * @param {Point} point
 * @param {Rect} rect
 * @param {number} margin
 * @returns {boolean}
 */
const within = (point, rect, margin) =>
  point.x >= rect.x - margin && point.x <= rect.x + rect.width + margin && point.y >= rect.y - margin && point.y <= rect.y + rect.height + margin;

/**
 * 决定窗口该处于哪种状态。纯函数：同样的输入永远给同样的输出。
 * @param {PointerInputs} inputs
 * @param {PointerState} previous
 * @returns {PointerState}
 */
export function decidePointer(inputs, previous) {
  const { cursor, window: win, report } = inputs;
  // 拖拽时窗口跟着光标走，光标就一直在窗口上（差一帧左右的滞后）。一旦它明显离开了窗口，
  // 说明拖拽卡住了（页面挂在拖拽中途）：宁可松手，也不要一直占着一整窗的点击到 dragHoldMs。
  if (inputs.dragging && (!cursor || within(cursor, win, NEAR_EXIT))) return { mode: 'interactive', near: true };
  if (!cursor) return { mode: 'through', near: false };
  // 报告里的 body 是窗口内坐标，换算到屏幕
  const body = report?.body ? { ...report.body, x: report.body.x + win.x, y: report.body.y + win.y } : win;
  const near = within(cursor, body, previous.near ? NEAR_EXIT : NEAR_ENTER);
  // 只有「在光标当前位置」做出的报告才算数：光标移了却没有新报告（forwarding 停了、
  // 指针离开了窗口）时，桌宠就松手
  const onPet =
    !!report?.hit &&
    within(cursor, win, 0) &&
    Math.abs(cursor.x - win.x - report.x) <= SAME_POINT &&
    Math.abs(cursor.y - win.y - report.y) <= SAME_POINT;
  return { mode: onPet ? 'interactive' : near ? 'forward' : 'through', near: near || onPet };
}

/**
 * 下一次轮询时该让页面去命中测试的窗口坐标，没有就 null。
 * 用在「光标已经在窗口上、但没有关于它当前位置的报告」时：它来得比 forwarding 打开还快、
 * 之后就不动了，或者 forwarding 悄悄失效了。没有它，桌宠会在静止的光标下面一直穿透，
 * 直到光标再动一下。
 * @param {PointerInputs} inputs
 * @param {PointerState} state
 * @returns {Point|null}
 */
export function probePoint(inputs, state) {
  const { cursor, window: win, report } = inputs;
  if (inputs.dragging || !state.near || !cursor || !within(cursor, win, 0)) return null;
  const x = cursor.x - win.x;
  const y = cursor.y - win.y;
  if (report && Math.abs(x - report.x) <= SAME_POINT && Math.abs(y - report.y) <= SAME_POINT) return null;
  return { x, y };
}

/**
 * 解析页面报上来的指针报告，逐字段检查；形状不对返回 null
 * @param {unknown} raw
 * @returns {PointerReport|null}
 */
export function parsePointerReport(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { hit, x, y, body } = /** @type {Record<string, unknown>} */ (raw);
  /** @param {unknown} n @returns {boolean} */
  const finite = (n) => typeof n === 'number' && Number.isFinite(n);
  if (typeof hit !== 'boolean' || !finite(x) || !finite(y)) return null;
  /** @type {Rect|null} */
  let rect = null;
  if (body && typeof body === 'object') {
    const r = /** @type {Record<string, unknown>} */ (body);
    if (finite(r.x) && finite(r.y) && finite(r.width) && finite(r.height) && r.width >= 0 && r.height >= 0) {
      rect = { x: r.x, y: r.y, width: r.width, height: r.height };
    }
  }
  return { hit, x, y, body: rect };
}
