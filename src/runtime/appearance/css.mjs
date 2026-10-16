// 外观 CSS 生成 —— 移植自 zcode-canvas 的 src/shared/css.ts（MIT）
//
// 与 ZCode 的契约（取自它的源码，本项目已在 3.15.3 实测复核）：
//   · 设计 token 是 <html> 上的 --color-* 自定义属性，靠 .dark / .theme-zai-dark / .theme-zai-light 切换
//   · [data-desktop-window-frame]（#root 内）是最外那层被绘制的表面，Windows 上由
//     --color-background-win-alt 撑着；主区是 bg-background
//   · 启动画面是 #loading > .startup-logo-shell > svg.startup-logo，body.zcode-startup-ready 一设上 #root 就淡入
// 弹层/菜单/对话框 portal 到 <body>，在 #root 之外，所以它们保持不透明。
// 3.15 起还有第二样东西画在 #root 之外（读 3.15.3 构建产物实证，非源码）：侧栏里打开的插件页，
// 它的 <webview> 被搬进 <body> 下追加的一层。打开设置**不卸载**工作区，只是盖住它并置 opacity:0
// （外层带 data-root-workspace-surface="inert"）——这个 0 到不了那一层：不透明的设置页能盖住它，
// 半透明的就会透出来，所以要由样式表自己把它藏掉（见 PLUGIN_PAGE_LAYER）。
//
// 选择器带 id，这样无论样式表先后都能压过 ZCode 自己的规则——本项目踩过这个坑（见 docs/04 皮肤一节）。

import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { BLUR_REGIONS, BLURRED_SURFACES, regionAlphas } from './glass.mjs';
import { linearLuminance, oklabToLinear, toLinear } from './palette.mjs';

/** 按「被哪个区域绘制」把表面 token 变半透明（见 glass.mjs） */
const SURFACES = [
  ['background-win-alt', 'frame'],
  ['background-alt', 'frame'],
  ['sidebar', 'frame'],
  ['background', 'main'],
  ['panel', 'main'],
  ['header', 'main'],
  ['tab', 'main'],
  ['tab-active', 'main'],
  ['terminal-bg', 'main'],
  ['card', 'card'],
  ['secondary', 'card'],
  ['input', 'input'],
  ['input-focused', 'input'],
];

const COLOR_TOKEN = /^(--color-)?[a-z0-9][a-z0-9-]*$/;

/** coding-plan 购买页：唯一一个从 #root 内部整屏盖上来、而不是 portal 到 body 的表面 */
export const UPGRADE_SURFACE = 'section[data-testid="coding-plan-upgrade-surface"]';

/** 设置页盖住工作区时的那个工作区：ZCode 不卸载它，只把它置成 opacity:0 */
export const COVERED_WORKSPACE = '[data-root-workspace-surface="inert"]';

/**
 * <body> 下托着「侧栏里打开的插件页 <webview>」的那一层：挂在 #root 外，却按面板位置对齐。
 * 不透明的设置页原本能盖住它，半透明的会让它整个透出来——所以设置打开期间，
 * 样式表要按 ZCode 藏工作区的同样方式把它藏掉。
 */
export const PLUGIN_PAGE_LAYER = '[data-sandbox-page-parking]';

const MATH_FUNCTIONS = ['calc', 'min', 'max', 'clamp'];
const COLOR_FUNCTIONS = ['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix', 'light-dark'];
const GRADIENT_FUNCTIONS = [
  'linear-gradient', 'radial-gradient', 'conic-gradient',
  'repeating-linear-gradient', 'repeating-radial-gradient', 'repeating-conic-gradient',
];

// 各类型允许调用的函数。**任何能加载资源的东西（url / image / image-set…）都不在任何列表上**：
// 整张表里唯一的 url() 是下面 cssUrl() 自己拼的本地文件。
const VALUE_FUNCTIONS = {
  color: new Set([...MATH_FUNCTIONS, ...COLOR_FUNCTIONS]),
  image: new Set([...MATH_FUNCTIONS, ...COLOR_FUNCTIONS, ...GRADIENT_FUNCTIONS]),
  position: new Set(MATH_FUNCTIONS),
  vars: new Set([...MATH_FUNCTIONS, ...COLOR_FUNCTIONS, ...GRADIENT_FUNCTIONS, 'var']),
};

/**
 * 主题与配置的值会原样进到生成的样式表里，所以每个字段都按**语法**收，而不是黑名单：
 * 不许有任何能逃出声明、编出 CSS 转义或起一个 at-rule 的字符；引号只允许 vars 用；
 * 每个函数调用都必须在它那一类的列表上。
 */
export function isSafeCssValue(value, kind) {
  if (/[\u0000-\u001f\u007f;{}<>@`\\]/.test(value)) return false;
  if (kind !== 'vars' && /["']/.test(value)) return false;
  const functions = VALUE_FUNCTIONS[kind];
  for (const call of value.matchAll(/([A-Za-z][\w-]*)?\(/g)) {
    if (!call[1] || !functions.has(call[1])) return false;
  }
  return true;
}

export function tokenProperty(key) {
  return key.startsWith('--') ? key : `--color-${key}`;
}

function cssUrl(file) {
  let url = pathToFileURL(file).href;
  try {
    // 带个 mtime 查询串，换掉磁盘上的文件后热重载能立刻看到
    url += `?v=${Math.round(statSync(file).mtimeMs)}`;
  } catch {
    // 文件不在：URL 照留，渲染层就是不出图而已
  }
  return `url("${url.replace(/"/g, '%22')}")`;
}

const percent = (alpha) => Math.round(alpha * 1000) / 10;

function callArgs(color, fn) {
  const match = color.match(new RegExp(`^${fn}\\(([^)]*)\\)$`, 'i'));
  if (!match) return null;
  return match[1].split('/')[0].trim().split(/[\s,]+/).filter(Boolean);
}

const numberOrPercent = (part, percentScale) => {
  const match = part.match(/^([+-]?\d*\.?\d+)(%)?$/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? (match[2] ? value * percentScale : value) : null;
};

function hueInTurns(part) {
  const match = part.match(/^([+-]?\d*\.?\d+)(deg|grad|rad|turn)?$/i);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  switch ((match[2] || '').toLowerCase()) {
    case 'grad': return value / 400;
    case 'rad': return value / (2 * Math.PI);
    case 'turn': return value;
    default: return value / 360;
  }
}

const okLightness = (part) => numberOrPercent(part, 0.01);

/** 颜色 → 线性 sRGB 通道（0..1）；算不出来的语法返回 null */
function accentLinear(color) {
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const hex = color.match(/^#([0-9a-f]+)$/i);
  if (hex) {
    const digits = hex[1];
    const pairs = digits.length === 3 || digits.length === 4
      ? [...digits.slice(0, 3)].map((c) => c + c)
      : digits.length === 6 || digits.length === 8
        ? [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 6)]
        : null;
    if (!pairs) return null;
    return pairs.map((p) => toLinear(parseInt(p, 16) / 255));
  }
  const rgbArgs = callArgs(color, 'rgba?');
  if (rgbArgs && rgbArgs.length >= 3) {
    const channel = (part) => {
      const match = part.match(/^([+-]?\d*\.?\d+)(%)?$/);
      if (!match || !Number.isFinite(Number(match[1]))) return null;
      return match[2] ? Number(match[1]) / 100 : Number(match[1]) / 255;
    };
    const channels = rgbArgs.slice(0, 3).map(channel);
    if (channels.every((c) => c != null)) return channels.map((c) => toLinear(clamp01(c)));
  }
  const hslArgs = callArgs(color, 'hsla?');
  if (hslArgs && hslArgs.length >= 3) {
    const hue = hueInTurns(hslArgs[0]);
    const saturation = numberOrPercent(hslArgs[1], 0.01);
    const lightness = numberOrPercent(hslArgs[2], 0.01);
    if (hue == null || saturation == null || lightness == null) return null;
    const h = hue * 360;
    const channel = (n) => {
      const k = (((h / 30 + n) % 12) + 12) % 12;
      return clamp01(lightness - saturation * Math.min(lightness, 1 - lightness) * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
    };
    // CSS Color 4 在 n = 0（红）、8（绿）、4（蓝）处求值
    return [0, 8, 4].map((n) => toLinear(channel(n)));
  }
  const oklab = (lightness, a, b) => oklabToLinear(lightness, a, b).map(clamp01);
  const oklabArgs = callArgs(color, 'oklab');
  if (oklabArgs && oklabArgs.length >= 3) {
    const lightness = okLightness(oklabArgs[0]);
    const a = numberOrPercent(oklabArgs[1], 0.004);
    const b = numberOrPercent(oklabArgs[2], 0.004);
    if (lightness == null || a == null || b == null) return null;
    return oklab(lightness, a, b);
  }
  const oklchArgs = callArgs(color, 'oklch');
  if (oklchArgs && oklchArgs.length >= 3) {
    const lightness = okLightness(oklchArgs[0]);
    const chroma = numberOrPercent(oklchArgs[1], 0.004);
    const hue = hueInTurns(oklchArgs[2]);
    if (lightness == null || chroma == null || hue == null) return null;
    const angle = hue * 2 * Math.PI;
    return oklab(lightness, chroma * Math.cos(angle), chroma * Math.sin(angle));
  }
  return null;
}

/**
 * 主色上最读得清的前景：黑或白，取 WCAG 对比度更高的那个（分界在 L = √0.0525 − 0.05 ≈ 0.179）。
 * hex / rgb() / hsl() / oklch() / oklab() 能算；算不了的语法退回白色——
 * 这类值通常是饱和的中深色，配白字正好。
 */
export function contrastForeground(color) {
  const linear = accentLinear(color.trim());
  if (!linear) return '#ffffff';
  return linearLuminance(linear) > Math.sqrt(0.0525) - 0.05 ? '#000000' : '#ffffff';
}

const MODE_SELECTOR = {
  dark: 'html:root.dark',
  light: 'html:root:not(.dark)',
};

/** Tailwind v4 的默认圆角刻度（rem），ZCode 的 rounded-* 工具类读的就是这些变量 */
const RADII = [
  ['xs', 0.125], ['sm', 0.25], ['md', 0.375], ['lg', 0.5],
  ['xl', 0.75], ['2xl', 1], ['3xl', 1.5], ['4xl', 2],
];

export const ACCENT_TOKENS = ['primary', 'brand', 'ring', 'primary-foreground'];

function block(selector, declarations) {
  return declarations.length ? `${selector} {\n  ${declarations.join(';\n  ')};\n}` : '';
}

/** 会动东西的规则，系统要求减少动效时就不给 */
function unlessReducedMotion(rule) {
  return rule ? `@media (prefers-reduced-motion: no-preference) {\n${rule.replace(/^/gm, '  ')}\n}` : '';
}

/**
 * 壁纸层：画在 body::before（fixed，z-index:-1）。
 * ⚠️ z-index:-1 的坑见 docs/04：body 没有自己的层叠上下文，负 z-index 后代会上溯到根层叠上下文，
 * 于是 body 自己的背景会盖在它上面——所以**绝不能同时给 body 设背景**（本实现不给）。
 * mode 为 null 表示两套模式共用一张。
 */
function wallpaperRules(wallpaper, root, mode, safe) {
  const label = mode ? `wallpaper.${mode}` : 'wallpaper';
  if (!safe(`${label}.position`, wallpaper.position, 'position')) return [];
  const rules = [];
  const url = wallpaper.image ? cssUrl(wallpaper.image) : null;
  const size = { cover: 'cover', contain: 'contain', fill: '100% 100%', tile: 'auto', center: 'auto' }[wallpaper.fit];
  const repeat = wallpaper.fit === 'tile' ? 'repeat' : 'no-repeat';
  const bleed = wallpaper.blur ? `${-wallpaper.blur * 2}px` : '0';
  const n = (value) => Math.round(value * 1000) / 1000;
  // 缩放是锚在 position 上的 transform，所以主体不会跑位——而且它对每种 fit 都成立，tile 也是。
  // 滤镜跟在同一层上。
  const filters = [
    wallpaper.blur ? `blur(${wallpaper.blur}px)` : '',
    wallpaper.saturate !== 1 ? `saturate(${n(wallpaper.saturate)})` : '',
    wallpaper.brightness !== 1 ? `brightness(${n(wallpaper.brightness)})` : '',
    wallpaper.contrast !== 1 ? `contrast(${n(wallpaper.contrast)})` : '',
    wallpaper.grayscale > 0 ? `grayscale(${n(wallpaper.grayscale)})` : '',
  ].filter(Boolean);
  const layer = ['content: ""', 'position: fixed', 'z-index: -1', 'pointer-events: none'];

  // 渐变壁纸（本项目扩展）：内置主题用它可以一张素材都不带
  const gradientOk = wallpaper.gradient && safe(`${label}.gradient`, wallpaper.gradient, 'image') ? wallpaper.gradient : null;

  // 视频壁纸：CSS 放不了视频，这一层交给渲染层的 <video>；这里只保留压暗蒙层与布局。
  if (!wallpaper.video && (url || gradientOk)) {
    rules.push(
      block(`${root} body::before`, [
        ...layer,
        `inset: ${bleed}`,
        gradientOk && !url
          ? `background: ${gradientOk}`
          : `background: ${url} ${wallpaper.position} / ${size} ${repeat}`,
        ...(url && wallpaper.scale !== 1 ? [`transform: scale(${n(wallpaper.scale)})`, `transform-origin: ${wallpaper.position}`] : []),
        ...(filters.length ? [`filter: ${filters.join(' ')}`] : []),
      ]),
    );
    if (url && (wallpaper.fit === 'contain' || wallpaper.fit === 'center')) {
      // 留白处用同一张图的模糊放大版填上（渐变不需要）
      rules.push(block(`${root}::before`, [...layer, 'inset: -60px', `background: ${url} center / cover no-repeat`, 'filter: blur(40px)']));
    }
  }
  if (wallpaper.dim > 0) {
    const pct = Math.round(wallpaper.dim * 1000) / 10;
    const overlay = wallpaper.overlay && safe(`${label}.overlay`, wallpaper.overlay, 'color') ? wallpaper.overlay : null;
    rules.push(block(`${root} body::after`, [...layer, 'inset: 0', 'transition: opacity 0.3s ease']));
    // ZCode 是首帧之后才设主题 class 的，启动画面上模式未知；蒙层先藏着，等界面淡入再显。
    rules.push(block('body:not(.zcode-startup-ready)::after', ['opacity: 0']));
    for (const m of mode ? [mode] : ['dark', 'light']) {
      const color = overlay ?? (m === 'dark' ? '#000000' : '#ffffff');
      rules.push(block(`${MODE_SELECTOR[m]} body::after`, [`background: color-mix(in srgb, ${color} ${pct}%, transparent)`]));
    }
  }
  return rules;
}

export function buildCss(look) {
  const warnings = [];
  const rules = [];
  const safe = (label, value, kind) => {
    if (isSafeCssValue(value, kind)) return true;
    warnings.push(`ignored unsafe value for ${label}`);
    return false;
  };

  for (const mode of ['dark', 'light']) {
    const declarations = [];
    const colors = look.colors[mode];
    for (const [key, value] of Object.entries(colors)) {
      // key 一样会进样式表，所以它和 value 同为安全边界
      if (!COLOR_TOKEN.test(key)) {
        warnings.push(`ignored colors.${mode}.${JSON.stringify(key)}: not a color token, move it to vars`);
        continue;
      }
      if (safe(`colors.${mode}.${key}`, value, 'color')) declarations.push(`${tokenProperty(key)}: ${value}`);
    }
    const accent = look.accent[mode];
    if (accent && safe(`accent.${mode}`, accent, 'color')) {
      // 主题在 colors 里显式写了的 token，胜过从 accent 推出来的
      const derived = {
        primary: accent,
        brand: accent,
        ring: accent,
        'primary-foreground': contrastForeground(accent),
      };
      for (const token of ACCENT_TOKENS) {
        if (!(token in colors) && !(`--color-${token}` in colors)) declarations.push(`--color-${token}: ${derived[token]}`);
      }
    }
    for (const [key, value] of Object.entries(look.vars[mode])) {
      if (!/^--[\w-]+$/.test(key)) warnings.push(`ignored vars.${mode}.${JSON.stringify(key)}: custom property names start with --`);
      else if (safe(`vars.${mode}.${key}`, value, 'vars')) declarations.push(`${key}: ${value}`);
    }
    rules.push(block(MODE_SELECTOR[mode], declarations));
  }

  if (look.radius !== null && look.radius !== 1) {
    const scale = look.radius;
    rules.push(block('html:root', RADII.map(([name, rem]) => `--radius-${name}: ${scale === 0 ? '0' : `${Math.round(rem * scale * 1000) / 1000}rem`}`)));
  }

  const regions = look.glass.regions;
  const alphas = regionAlphas(regions);
  const translucent = SURFACES.filter(([, region]) => percent(alphas[region]) < 100);
  if (translucent.length) {
    // 自定义属性不能引用自己，所以原值先在上一层（body 从 <html> 继承）captured 下来，
    // 再在 #root 上重新声明成半透明。
    rules.push(block('body', translucent.map(([token]) => `--zc-src-${token}: var(--color-${token})`)));
    rules.push(
      block(
        '#root',
        translucent.map(([token, region]) => `--color-${token}: color-mix(in srgb, var(--zc-src-${token}) ${percent(alphas[region])}%, transparent)`),
      ),
    );
    // 购买页子树继承的是 captured 的值，而不是 #root 上的半透明值
    rules.push(block(UPGRADE_SURFACE, translucent.map(([token]) => `--color-${token}: var(--zc-src-${token})`)));
    // 插件页那一层在 #root 之外，拿不到上面的半透明值，设置页半透明时会整个透出来。只在设置盖住工作区时藏它。
    rules.push(block(`body:has(> #root ${COVERED_WORKSPACE}) > ${PLUGIN_PAGE_LAYER}`, ['opacity: 0']));
    // 共用半径的区域合成一条规则，没调过时就只有一条声明
    const byBlur = new Map();
    for (const region of BLUR_REGIONS) {
      const { opacity, blur } = regions[region];
      if (opacity >= 1 || blur <= 0) continue;
      byBlur.set(blur, [...(byBlur.get(blur) ?? []), ...BLURRED_SURFACES[region]]);
    }
    for (const [blur, selectors] of byBlur) {
      // 购买页浮层及其内部（它的 <webview> 也用 .bg-background 画）不上 backdrop-filter，
      // 不透明表面只会把它盖住而已。
      const blurred = selectors.map((s) => `#root ${s}:not(${UPGRADE_SURFACE}, ${UPGRADE_SURFACE} *)`);
      rules.push(block(blurred.join(',\n'), [`backdrop-filter: blur(${blur}px)`]));
    }
  }

  const dark = look.wallpaper.dark;
  const light = look.wallpaper.light;
  if (dark || light) {
    const shared = JSON.stringify(dark) === JSON.stringify(light);
    if (shared) rules.push(...wallpaperRules(dark, 'html', null, safe));
    else {
      for (const mode of ['dark', 'light']) {
        const wallpaper = look.wallpaper[mode];
        if (wallpaper) rules.push(...wallpaperRules(wallpaper, MODE_SELECTOR[mode], mode, safe));
      }
      // 主题 class 首帧后才设，模式未知；两张壁纸都先别露面，免得闪错的那张
      rules.push(
        block('body::before, html::before', ['transition: opacity 0.3s ease']),
        block('body:not(.zcode-startup-ready)::before, html:has(> body:not(.zcode-startup-ready))::before', ['opacity: 0']),
      );
    }
  }

  const startup = look.startup;
  if (startup.background && safe('startup.background', startup.background, 'image')) {
    rules.push(block('body #loading', [`background: ${startup.background}`]));
  }
  if (startup.logo) {
    rules.push(
      block('#loading .startup-logo-shell', [
        `width: ${startup.logoSize}px`,
        `height: ${startup.logoSize}px`,
        `background: ${cssUrl(startup.logo)} center / contain no-repeat`,
        'box-shadow: none',
        'border-radius: 0',
      ]),
      block('#loading .startup-logo-shell::before, #loading .startup-logo', ['display: none']),
    );
  } else if (startup.logoSize !== 96) {
    rules.push(block('#loading .startup-logo-shell', [`width: ${startup.logoSize}px`, `height: ${startup.logoSize}px`]));
  }
  // 每个启动动画都必须结束，而且不能早于 ZCode 开始监听：它的 animationend 不来，启动画面就不收。
  if (startup.animation === 'fade') {
    rules.push(
      '@keyframes zc-startup-fade { from { opacity: 0 } to { opacity: 1 } }',
      unlessReducedMotion(block('#loading .startup-logo-shell', ['transform: none', 'animation: zc-startup-fade 0.6s ease forwards'])),
    );
  } else if (startup.animation === 'none') {
    // 静止，但踩着 ZCode 自己的动画时序：animation:none 或早早结束的动画会让它一直等那 1 秒兜底
    rules.push(
      '@keyframes zc-startup-none { to { opacity: 1 } }',
      block('#loading .startup-logo-shell', ['transform: none', 'opacity: 1', 'animation-name: zc-startup-none']),
    );
  }

  const css = rules.filter(Boolean).join('\n\n');
  return { css: css ? `/* ZCode-Expand 外观 */\n${css}\n` : '', warnings };
}
