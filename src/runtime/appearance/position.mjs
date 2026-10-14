// CSS background-position ←→ 面板的两个滑块 —— 移植自 zcode-canvas 的 src/shared/position.ts（MIT）
//
// 纯字符串运算。主进程用它写位置，渲染层用它显示，所以滑块显示的两轴永远就是下一次写入会保留的两轴。

/**
 * 一到两段式 position（关键字或 0..100%）的 X / Y 百分比；
 * 滑块表达不了的值返回 null（calc()、长度、三段以上、超过 100%）。
 */
export function positionAxes(value) {
  if (!value) return null;
  const keywords = { left: 0, top: 0, center: 50, right: 100, bottom: 100 };
  const parts = value.trim().toLowerCase().split(/\s+/);
  const axis = (part) => {
    if (part in keywords) return keywords[part];
    const match = /^(\d+(?:\.\d+)?)%$/.exec(part);
    if (!match) return null;
    const n = Number(match[1]);
    return n <= 100 ? n : null;
  };
  if (parts.length === 1) {
    const n = axis(parts[0]);
    if (n === null) return null;
    return parts[0] === 'top' || parts[0] === 'bottom' ? [50, n] : [n, 50];
  }
  if (parts.length !== 2) return null;
  const vertical = (part) => part === 'top' || part === 'bottom';
  const horizontal = (part) => part === 'left' || part === 'right';
  const reversed = vertical(parts[0]) && (horizontal(parts[1]) || parts[1] === 'center');
  const x = axis(parts[reversed ? 1 : 0]);
  const y = axis(parts[reversed ? 0 : 1]);
  return x === null || y === null ? null : [x, y];
}
