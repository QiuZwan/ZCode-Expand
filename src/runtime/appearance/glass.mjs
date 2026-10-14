// 玻璃（半透明）模型 —— 移植自 zcode-canvas 的 src/shared/glass.ts（MIT）
//
// 纯函数，不依赖 node 也不依赖 DOM：CSS 生成、配色的可读性检查、面板、preload 共用同一份。
//
// ZCode 是一层层画的：窗口壳（侧栏也显示它，侧栏自己没有背景）→ 主区 → 卡片 / 输入框。
// 每个区域可以有自己的不透明度；没给的就跟随全局 glass.opacity。

/** 四个区域 */
export const GLASS_REGIONS = ['frame', 'main', 'card', 'input'];

/**
 * 会吃到 backdrop-filter 的区域。**窗口壳永远不吃**——它一旦有 backdrop-filter 就会成为
 * 内部所有元素的 backdrop root，把主区的模糊从壁纸上切掉。
 */
export const BLUR_REGIONS = ['main', 'card', 'input'];

/** 各区域表面用的 Tailwind 背景类，模糊加在它们身上 */
export const BLURRED_SURFACES = {
  frame: [],
  main: ['.bg-background', '.bg-panel'],
  card: ['.bg-card'],
  input: ['.bg-input'],
};

/**
 * 面板里正在调某个区域时给它的控件描个边；region 为 null 返回空串。
 * 描边画在盒子内侧，所以布局不会动。
 */
export function regionHighlightCss(region) {
  if (!region) return '';
  const selectors = region === 'frame' ? ['[data-desktop-window-frame]'] : BLURRED_SURFACES[region];
  return `${selectors.map((s) => `#root ${s}`).join(',\n')} {\n  outline: 2px solid var(--color-primary) !important;\n  outline-offset: -2px !important;\n}\n`;
}

const clamp01 = (value) => Math.min(1, Math.max(0, value));

/**
 * 各区域自身表面的 alpha（0..1）；1 表示完全不动官方颜色。
 *
 * 一个区域的不透明度是这样落到 alpha 上的：
 *   · 窗口壳保持更透（×0.7）
 *   · 主区的 alpha 是"反推"出来的——壳和主区叠在一起，看到的效果正好等于主区要的透明度
 *   · 抬起来的表面（卡片、输入框）保留剩余不透明度的一半，保证字还读得清
 * 主区比它下面的壳更透时会在 alpha 0 触底：它不可能比壳还透。
 */
export function regionAlphas(regions) {
  const frame = regions.frame.opacity >= 1 ? 1 : regions.frame.opacity * 0.7;
  const main = regions.main.opacity;
  const raised = (opacity) => (opacity >= 1 ? 1 : 1 - (1 - opacity) * 0.5);
  return {
    frame,
    main: main >= 1 ? 1 : frame >= 1 ? main : clamp01(1 - (1 - main) / (1 - frame)),
    card: raised(regions.card.opacity),
    input: raised(regions.input.opacity),
  };
}

/** 主区被设得比它下面的壳还透时为真（面板要据此给提示） */
export function mainCappedByFrame(regions) {
  const frame = regionAlphas(regions).frame;
  return regions.main.opacity < 1 && frame < 1 && regions.main.opacity < frame - 1e-9;
}
