// 智能配色 —— 移植自 zcode-canvas 的 src/shared/palette.ts（MIT）
//
// 两件事：从壁纸里取种子色；由一个种子色生成整套 ZCode 颜色 token。
// 全程在 OKLCH 里算，所以"同样的明度"对每种色相都是同样的感知明度，
// 而且每个承载文字的 token 都会对着它所在的表面验对比度。
//
// 纯数学，不依赖 node 也不依赖 DOM。

export const PALETTE_VARIANTS = ['natural', 'vivid', 'soft', 'oled', 'contrast'];

const HEX = /^#[0-9a-f]{6}$/i;

export function isPaletteColor(value) {
  return typeof value === 'string' && HEX.test(value);
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function hexToRgb(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
}

function rgbToHex(rgb) {
  return `#${rgb.map((c) => Math.round(clamp(c, 0, 1) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** 一个 gamma 编码的 sRGB 通道（0..1）→ 线性光。css.mjs 算主色前景时也用这个。 */
export const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** Björn Ottosson 的 OKLab：gamma 编码的 sRGB → LCh */
function rgbToLch([r, g, b]) {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: L, c: Math.hypot(a, bb), h: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360 };
}

/** OKLab → 线性 sRGB（可能超出色域） */
export function oklabToLinear(l, a, b) {
  const l3 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m3 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s3 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ];
}

function lchToRgbRaw({ l, c, h }) {
  const angle = (h * Math.PI) / 180;
  return oklabToLinear(l, c * Math.cos(angle), c * Math.sin(angle)).map((v) => toGamma(Math.max(0, v)));
}

const inGamut = (rgb) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/** 这个明度和色相下的颜色，彩度一路降到能塞进 sRGB 为止 */
function tone(l, c, h) {
  const lightness = clamp(l, 0, 1);
  let rgb = lchToRgbRaw({ l: lightness, c, h });
  if (inGamut(rgb)) return rgb;
  let lo = 0;
  let hi = c;
  for (let i = 0; i < 18; i += 1) {
    const mid = (lo + hi) / 2;
    if (inGamut(lchToRgbRaw({ l: lightness, c: mid, h }))) lo = mid;
    else hi = mid;
  }
  rgb = lchToRgbRaw({ l: lightness, c: lo, h });
  return rgb.map((v) => clamp(v, 0, 1));
}

/** WCAG 相对亮度（线性 sRGB 通道） */
export function linearLuminance([r, g, b]) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function luminance(rgb) {
  return linearLuminance(rgb.map(toLinear));
}

export function contrastRatio(a, b) {
  const la = luminance(typeof a === 'string' ? hexToRgb(a) : a);
  const lb = luminance(typeof b === 'string' ? hexToRgb(b) : b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** 浏览器的 sRGB 合成方式：over，在 gamma 编码空间里算 */
function over(top, alpha, bottom) {
  return top.map((c, i) => c * alpha + bottom[i] * (1 - alpha));
}

const rgba = (rgb, alpha) =>
  `rgba(${rgb.map((c) => Math.round(clamp(c, 0, 1) * 255)).join(', ')}, ${Math.round(alpha * 1000) / 1000})`;

/**
 * 从缩小的壁纸里取种子色（RGBA 字节，例如 canvas 的 ImageData）。
 * 色相按 10° 分桶、按彩度加权（这样彩色区域压得过一大片灰），
 * 峰之间至少隔 30° 才各算一个种子，强的排前面。整张灰图会得到一个近中性的种子。
 * average 是整图均色，用于可读性检查（半透明表面后面透出来的就是它）。
 */
export function extractColors(rgbaBytes, maxSeeds = 5) {
  const bins = Array.from({ length: 36 }, () => ({ w: 0, a: 0, b: 0, c: 0 }));
  const sum = [0, 0, 0];
  let count = 0;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i + 3 < rgbaBytes.length; i += 4) {
    if (rgbaBytes[i + 3] < 128) continue;
    const rgb = [rgbaBytes[i] / 255, rgbaBytes[i + 1] / 255, rgbaBytes[i + 2] / 255];
    sum[0] += rgb[0]; sum[1] += rgb[1]; sum[2] += rgb[2];
    count += 1;
    const { l, c, h } = rgbToLch(rgb);
    const angle = (h * Math.PI) / 180;
    sumA += c * Math.cos(angle);
    sumB += c * Math.sin(angle);
    if (c < 0.03 || l < 0.12 || l > 0.97) continue;
    const bin = bins[Math.floor(h / 10) % 36];
    bin.w += c;
    bin.a += c * c * Math.cos(angle);
    bin.b += c * c * Math.sin(angle);
    bin.c += c * c;
  }
  if (!count) return null;
  const average = rgbToHex(sum.map((v) => v / count));
  const score = bins.map((_, i) => bins[(i + 35) % 36].w * 0.5 + bins[i].w + bins[(i + 1) % 36].w * 0.5);
  const order = score.map((s, i) => [s, i]).filter(([s]) => s > 0).sort((x, y) => y[0] - x[0]);
  const top = order[0] ? order[0][0] : 0;
  const seeds = [];
  const taken = [];
  // 彩色像素必须先占到全图可观的比例，色相才算数
  if (top > count * 0.004) {
    for (const [s, i] of order) {
      if (seeds.length >= maxSeeds || s < top * 0.06) break;
      if (taken.some((t) => Math.min(Math.abs(t - i), 36 - Math.abs(t - i)) < 3)) continue;
      taken.push(i);
      let a = 0; let b = 0; let w = 0; let c = 0;
      for (const j of [i + 35, i, i + 1]) {
        const bin = bins[j % 36];
        a += bin.a; b += bin.b; c += bin.c; w += bin.w;
      }
      const hue = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
      seeds.push(rgbToHex(tone(0.65, clamp(c / w, 0.04, 0.2), hue)));
    }
  }
  if (!seeds.length) {
    const hue = ((Math.atan2(sumB, sumA) * 180) / Math.PI + 360) % 360;
    seeds.push(rgbToHex(tone(0.65, Math.min(Math.hypot(sumA, sumB) / count, 0.02), hue)));
  }
  return { seeds, average };
}

// 各变体在两套模式下的明度阶（来自参考实现，是调出来的决策不是推导）
const TONES = {
  dark: {
    base: { frame: 0.17, main: 0.2, raised: 0.245, focused: 0.225, high: 0.3, popoverHeader: 0.215, fg: 0.93, subtle: 0.74, subtlest: 0.57, brand: 0.78, accentSurface: 0.32, border: 0.12, borderHover: 0.26 },
    oled: { frame: 0, main: 0, raised: 0.17, focused: 0.12, high: 0.23, popoverHeader: 0.14, fg: 0.93, subtle: 0.74, subtlest: 0.57, brand: 0.78, accentSurface: 0.27, border: 0.16, borderHover: 0.3 },
    contrast: { frame: 0.13, main: 0.15, raised: 0.21, focused: 0.18, high: 0.28, popoverHeader: 0.17, fg: 0.99, subtle: 0.86, subtlest: 0.7, brand: 0.86, accentSurface: 0.3, border: 0.3, borderHover: 0.5 },
  },
  light: {
    base: { frame: 0.94, main: 0.975, raised: 0.995, focused: 1, high: 0.915, popoverHeader: 0.965, fg: 0.25, subtle: 0.46, subtlest: 0.62, brand: 0.52, accentSurface: 0.92, border: 0.12, borderHover: 0.26 },
    oled: { frame: 0.94, main: 0.975, raised: 0.995, focused: 1, high: 0.915, popoverHeader: 0.965, fg: 0.25, subtle: 0.46, subtlest: 0.62, brand: 0.52, accentSurface: 0.92, border: 0.12, borderHover: 0.26 },
    contrast: { frame: 0.95, main: 0.99, raised: 1, focused: 1, high: 0.9, popoverHeader: 0.97, fg: 0.14, subtle: 0.3, subtlest: 0.45, brand: 0.42, accentSurface: 0.9, border: 0.32, borderHover: 0.5 },
  },
};

const TARGETS = {
  base: { fg: 7, subtle: 4.5, subtlest: 3, brand: 4.5 },
  contrast: { fg: 12, subtle: 7, subtlest: 4.5, brand: 7 },
};

/** 表面与主色的彩度，由种子自身的彩度推 */
function chromas(variant, seed) {
  // 近灰的种子给一套单色配色，而不是凭空造一个色相
  const gray = seed < 0.02;
  const pick = (neutral, accent, status) => ({ neutral, accent: gray ? seed : accent, status });
  switch (variant) {
    case 'vivid': return pick(Math.min(seed * 0.4, 0.04), clamp(seed * 1.3, 0.14, 0.24), 0.18);
    case 'soft': return pick(Math.min(seed * 0.15, 0.012), clamp(seed * 0.6, 0.05, 0.09), 0.1);
    case 'contrast': return pick(Math.min(seed * 0.15, 0.012), clamp(seed, 0.08, 0.16), 0.16);
    default: return pick(Math.min(seed * 0.25, 0.02), clamp(seed, 0.09, 0.16), 0.15);
  }
}

/** 把文字色的明度推离背景，直到对每一个背景都达到目标对比度，或者明度到头 */
function readable(l, c, h, backgrounds, target, mode) {
  const step = mode === 'dark' ? 0.01 : -0.01;
  let lightness = l;
  for (;;) {
    const rgb = tone(lightness, c, h);
    const contrast = Math.min(...backgrounds.map((bg) => contrastRatio(rgb, bg)));
    const next = lightness + step;
    if (contrast >= target || next > 1 || next < 0) return { rgb, contrast };
    lightness = next;
  }
}

/** 偏黑还是偏白，取在 background 上更读得清的那个 */
function onColor(background, dark, light) {
  return contrastRatio(dark, background) >= contrastRatio(light, background) ? dark : light;
}

/**
 * 由种子的色相生成两套模式的 ZCode 颜色 token。种子不是 #rrggbb 时返回 null。
 * 给了 backdrops 时，正文还要对"透过主表面看到的东西"保持可读；readability 报告达到的对比度。
 */
export function generatePalette(spec, backdrops = {}) {
  if (!spec || !isPaletteColor(spec.seed)) return null;
  const variant = PALETTE_VARIANTS.includes(spec.variant) ? spec.variant : 'natural';
  const seed = rgbToLch(hexToRgb(spec.seed));
  const hue = seed.h;
  const { neutral, accent, status } = chromas(variant, seed.c);
  const colors = { dark: {}, light: {} };
  const readability = { dark: null, light: null };

  for (const mode of ['dark', 'light']) {
    const t = TONES[mode][variant === 'oled' ? 'oled' : variant === 'contrast' ? 'contrast' : 'base'];
    const targets = TARGETS[variant === 'contrast' ? 'contrast' : 'base'];
    const surface = (l) => tone(l, l <= 0 || l >= 1 ? 0 : neutral, hue);
    const frame = surface(t.frame);
    const main = surface(t.main);
    const raised = surface(t.raised);
    const focused = surface(t.focused);
    const high = surface(t.high);
    const popoverHeader = surface(t.popoverHeader);

    const solid = [main, raised, frame, high];
    const backdrop = backdrops[mode];
    const seen = [];
    if (backdrop && isPaletteColor(backdrop.color)) {
      const wall = hexToRgb(backdrop.color);
      const underMain = over(frame, clamp(backdrop.frameAlpha, 0, 1), wall);
      seen.push(over(main, clamp(backdrop.mainAlpha, 0, 1), underMain), over(frame, clamp(backdrop.frameAlpha, 0, 1), wall));
    }
    const behindText = [...solid, ...seen];
    // 实心徽标与主按钮拿这个当文字色：深色模式用深墨、浅色模式用浅墨
    const darkInk = surface(TONES.dark.base.frame);
    const lightInk = surface(0.985);
    const ink = mode === 'dark' ? darkInk : lightInk;
    const fg = readable(t.fg, neutral * 0.5, hue, behindText, targets.fg, mode);
    const subtle = readable(t.subtle, neutral * 0.8, hue, [main, raised, ...seen], targets.subtle, mode);
    const subtlest = readable(t.subtlest, neutral, hue, [main, ...seen], targets.subtlest, mode);
    const brand = readable(t.brand, accent, hue, [main, raised], targets.brand, mode);
    const primary = readable(t.brand, accent, hue, [main, raised, ink], Math.max(targets.brand, 4.5), mode);
    if (seen.length) readability[mode] = { contrast: Math.round(fg.contrast * 100) / 100, ok: fg.contrast >= targets.subtle };

    const text = fg.rgb;
    // 推离墨色也就等于推离主表面——主表面的明度和墨色一样
    const statusTone = (h) => readable(mode === 'dark' ? 0.72 : 0.55, status, h, [ink, main], 4.5, mode).rgb;
    const success = statusTone(150);
    const warning = statusTone(85);
    const destructive = statusTone(27);
    const hex = rgbToHex;

    colors[mode] = {
      'background-win-alt': hex(frame),
      'background-alt': hex(frame),
      sidebar: hex(frame),
      background: hex(main),
      panel: hex(main),
      header: hex(main),
      tab: hex(main),
      'tab-active': hex(raised),
      'terminal-bg': hex(main),
      card: hex(raised),
      input: hex(raised),
      'input-focused': hex(focused),
      popover: hex(raised),
      'popover-header': hex(popoverHeader),
      menu: hex(raised),
      toast: hex(raised),
      secondary: hex(high),
      'card-selected': hex(high),
      tag: hex(high),
      tooltip: hex(high),
      'menu-hover': hex(high),
      border: rgba(text, t.border),
      'border-hover': rgba(text, t.borderHover),
      hover: rgba(text, 0.06),
      surface: rgba(text, 0.05),
      'surface-hover': rgba(text, 0.1),
      selected: rgba(brand.rgb, 0.16),
      foreground: hex(text),
      'foreground-subtle': hex(subtle.rgb),
      'foreground-subtlest': hex(subtlest.rgb),
      'foreground-inverse': hex(main),
      'terminal-fg': hex(text),
      primary: hex(primary.rgb),
      'primary-foreground': hex(onColor(primary.rgb, darkInk, lightInk)),
      brand: hex(brand.rgb),
      ring: hex(brand.rgb),
      'input-border-focused': hex(brand.rgb),
      accent: hex(tone(t.accentSurface, accent * 0.45, hue)),
      'terminal-cursor': hex(brand.rgb),
      'terminal-cursor-accent': hex(main),
      'terminal-selection': rgba(brand.rgb, 0.28),
      'find-highlight': rgba(brand.rgb, 0.25),
      'find-highlight-active': hex(brand.rgb),
      'interaction-ask-surface': rgba(brand.rgb, 0.1),
      'interaction-ask-foreground': hex(brand.rgb),
      success: hex(success),
      'success-foreground': hex(onColor(success, darkInk, lightInk)),
      warning: hex(warning),
      'warning-foreground': hex(onColor(warning, darkInk, lightInk)),
      destructive: hex(destructive),
      'destructive-foreground': hex(onColor(destructive, darkInk, lightInk)),
    };
  }
  return { colors, readability };
}

/**
 * 壁纸在自己那些滤镜下看起来是什么色：CSS brightness() 缩放通道，压暗蒙层混在上面。
 * overlay 不是十六进制时就退回该模式的默认（深色黑、浅色白）。
 */
export function filteredBackdrop(average, brightness, dim, overlay, mode) {
  const base = hexToRgb(average).map((c) => clamp(c * brightness, 0, 1));
  const shade = overlay && isPaletteColor(overlay) ? hexToRgb(overlay) : (mode === 'dark' ? [0, 0, 0] : [1, 1, 1]);
  return rgbToHex(over(shade, clamp(dim, 0, 1), base));
}
