// src/renderer/zc-skin-colors.js — 皮肤颜色数学与 CSS 拼装（纯函数，不碰 DOM）
//
// 做法取自 ci-yyy/zcode-skin（MIT）的 lib/palette.mjs 与 lib/theme.mjs：
//   4 个色（accent / secondary / surface / text）→ 一套完整的语义界面变量，深浅两套策略。
// 关键差异（见 doc/20261013-设计文档-皮肤控制.md §4 事实 9）：
//   参考实现只抹 --color-background-alt，因为它在 macOS 上跑；ZCode 的窗口壳按平台取类名，
//   Windows / Linux / 非桌面全走 --color-background-win-alt（不透明），所以两个都要抹，
//   否则 Windows 上背景被那层壳完全挡死。
//
// 本文件是给浏览器用的普通 IIFE 脚本（不导出），末尾把 API 挂到全局；
// 单测靠「副作用导入 + 读全局」取用（见 test/zc-skin-colors.test.mjs）。

(function (root) {
  'use strict';

  // theme.json 的 colors 键 → ZCode 界面里的 CSS 变量名
  // （变量清单来自 app.asar 内 out/renderer/assets/styles-*.css 的语义变量，本项目已在 3.15.1 核对）
  var VAR_MAP = {
    background: '--color-background',
    backgroundAlt: '--color-background-alt',
    sidebar: '--color-sidebar',
    panel: '--color-panel',
    header: '--color-header',
    card: '--color-card',
    cardSelected: '--color-card-selected',
    cardBorder: '--color-card-border',
    popover: '--color-popover',
    popoverForeground: '--color-popover-foreground',
    input: '--color-input',
    inputFocused: '--color-input-focused',
    inputBorder: '--color-input-border',
    inputBorderHover: '--color-input-border-hover',
    inputBorderFocused: '--color-input-border-focused',
    border: '--color-border',
    borderHover: '--color-border-hover',
    foreground: '--color-foreground',
    foregroundInverse: '--color-foreground-inverse',
    foregroundSubtle: '--color-foreground-subtle',
    foregroundSubtlest: '--color-foreground-subtlest',
    primary: '--color-primary',
    primaryForeground: '--color-primary-foreground',
    secondary: '--color-secondary',
    brand: '--color-brand',
    accent: '--color-accent',
    hover: '--color-hover',
    selected: '--color-selected',
    surface: '--color-surface',
    surfaceHover: '--color-surface-hover',
    menu: '--color-menu',
    menuHover: '--color-menu-hover',
    toast: '--color-toast',
    tooltip: '--color-tooltip',
    tooltipForeground: '--color-tooltip-foreground',
    tag: '--color-tag',
    tabActive: '--color-tab-active',
    terminalBg: '--color-terminal-bg',
    terminalFg: '--color-terminal-fg',
  };

  // 窗口壳变量：铺满整窗的那层底，必须抹成全透明才能让 html 的背景透出来。
  // ZCode 的窗口壳组件（styles-*.js 里的 data-desktop-window-frame）按平台取类名：
  //   isDesktop=i, isMacDesktop=a, isWindowsDesktop=o, l=i&&!a&&!o（Linux 桌面）
  //   类名 = (!i || o || l) ? 'bg-background-win-alt' : 'bg-background-alt'
  // 即 background-alt 只在 macOS 桌面用，其余（Windows / Linux / web）全走 win-alt。
  var SCHELL_VARS = ['--color-background-alt', '--color-background-win-alt'];

  var TRANSPARENT = '#00000000';

  function hexToRgb(hex) {
    var h = String(hex).replace('#', '');
    if (h.length === 8) h = h.slice(0, 6);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  function to2(x) {
    return Math.round(x).toString(16).padStart(2, '0');
  }

  function mix(a, b, t) {
    var A = hexToRgb(a);
    var B = hexToRgb(b);
    return '#' + to2(A[0] + (B[0] - A[0]) * t) + to2(A[1] + (B[1] - A[1]) * t) + to2(A[2] + (B[2] - A[2]) * t);
  }

  function alpha(hex, a) {
    var c = hexToRgb(hex);
    return '#' + to2(c[0]) + to2(c[1]) + to2(c[2]) + Math.round(a * 255).toString(16).padStart(2, '0');
  }

  function darken(hex, t) {
    return mix(hex, '#000000', t);
  }

  function lighten(hex, t) {
    return mix(hex, '#ffffff', t);
  }

  /** WCAG 相对亮度（0~1），用于深浅判定 */
  function luminance(hex) {
    var c = hexToRgb(hex).map(function (v) {
      var x = v / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b);
    var min = Math.min(r, g, b);
    var l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l: l };
    var d = max - min;
    var s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    var h;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
    return { h: h, s: s, l: l };
  }

  function hslToHex(h, s, l) {
    function hue2rgb(p, q, t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    var r, g, b;
    if (s === 0) {
      r = g = b = l;
    } else {
      var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      var p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }
    return '#' + to2(r * 255) + to2(g * 255) + to2(b * 255);
  }

  /**
   * 主色可见度保障：图片整体很暗/很亮时，取出的主色也会过暗/过亮，直接当按钮色会看不清。
   * 在 HSL 空间保住色相（图片的身份色），把饱和度提到可用、明度搬进安全区间。
   */
  function ensureAccentVisible(accent, appearance) {
    var c = hexToRgb(accent);
    var hsl = rgbToHsl(c[0], c[1], c[2]);
    var h = hsl.h, s = hsl.s, l = hsl.l;
    if (s < 0.45) s = Math.min(0.7, s + 0.25); // 太灰的色提饱和
    if (appearance === 'dark') {
      if (l < 0.52) l = 0.52; // 深色主题：主色要亮
      if (l > 0.72) l = 0.72;
    } else {
      if (l > 0.48) l = 0.48; // 浅色主题：主色要深
      if (l < 0.30) l = 0.30;
    }
    return hslToHex(h, s, l);
  }

  /** 4 色 → 全部 39 个语义变量；深浅两套策略 */
  function buildColors(input, appearance) {
    var accent = input.accent;
    var secondary = input.secondary;
    var surface = input.surface;
    var text = input.text;

    if (appearance === 'light') {
      // 浅色：surface 是偏白底，text 是深色墨
      var cardL = lighten(surface, 0.35);
      return {
        background: TRANSPARENT,
        backgroundAlt: alpha(surface, 0.55),
        sidebar: alpha(surface, 0.97),
        panel: alpha(cardL, 0.97),
        header: alpha(surface, 0.97),
        card: alpha(cardL, 0.96),
        cardSelected: alpha(mix(surface, accent, 0.22), 0.96),
        cardBorder: alpha(accent, 0.22),
        popover: alpha(cardL, 0.98),
        popoverForeground: mix(text, '#000000', 0.1),
        input: alpha('#ffffff', 0.92),
        inputFocused: alpha('#ffffff', 0.97),
        inputBorder: alpha(accent, 0.35),
        inputBorderHover: alpha(accent, 0.6),
        inputBorderFocused: accent,
        border: alpha(text, 0.14),
        borderHover: alpha(text, 0.28),
        foreground: text,
        foregroundInverse: '#ffffff',
        foregroundSubtle: alpha(text, 0.62),
        foregroundSubtlest: alpha(text, 0.45),
        primary: accent,
        primaryForeground: '#ffffff',
        secondary: alpha(accent, 0.14),
        brand: accent,
        accent: alpha(accent, 0.12),
        hover: alpha(text, 0.07),
        selected: alpha(accent, 0.22),
        surface: alpha(accent, 0.07),
        surfaceHover: alpha(accent, 0.13),
        menu: alpha(cardL, 0.98),
        menuHover: alpha(accent, 0.16),
        toast: alpha(cardL, 0.98),
        tooltip: alpha(cardL, 0.98),
        tooltipForeground: mix(text, '#000000', 0.1),
        tag: alpha(accent, 0.16),
        tabActive: alpha(mix(surface, accent, 0.22), 0.95),
        terminalBg: alpha('#ffffff', 0.92),
        terminalFg: text,
      };
    }

    // 深色：surface 是深底，text 是亮字
    var card = lighten(surface, 0.06);
    var deep = darken(surface, 0.35);
    return {
      background: TRANSPARENT,
      backgroundAlt: alpha(deep, 0.55),
      sidebar: alpha(deep, 0.94),
      panel: alpha(surface, 0.95),
      header: alpha(deep, 0.94),
      card: alpha(card, 0.92),
      cardSelected: alpha(mix(card, accent, 0.2), 0.94),
      cardBorder: alpha(accent, 0.26),
      popover: alpha(card, 0.97),
      popoverForeground: text,
      input: alpha(deep, 0.94),
      inputFocused: alpha(card, 0.96),
      inputBorder: alpha(accent, 0.3),
      inputBorderHover: alpha(accent, 0.55),
      inputBorderFocused: accent,
      border: alpha(text, 0.12),
      borderHover: alpha(text, 0.24),
      foreground: text,
      foregroundInverse: darken(surface, 0.5),
      foregroundSubtle: alpha(text, 0.6),
      foregroundSubtlest: alpha(text, 0.44),
      primary: accent,
      primaryForeground: darken(surface, 0.5),
      secondary: alpha(accent, 0.18),
      brand: accent,
      accent: alpha(accent, 0.16),
      hover: alpha(text, 0.08),
      selected: alpha(secondary, 0.28),
      surface: alpha(text, 0.05),
      surfaceHover: alpha(text, 0.1),
      menu: alpha(card, 0.97),
      menuHover: alpha(accent, 0.2),
      toast: alpha(card, 0.97),
      tooltip: alpha(card, 0.97),
      tooltipForeground: text,
      tag: alpha(secondary, 0.24),
      tabActive: alpha(mix(card, accent, 0.2), 0.94),
      terminalBg: alpha(deep, 0.95),
      terminalFg: text,
    };
  }

  /**
   * 降采样目标尺寸。短边必须至少 1px —— 极端长宽比（如 20000×3）四舍五入会算出 0，
   * 那会画出 0 高度的 canvas 并在 getImageData 上炸掉。
   */
  function scaledSize(width, height, maxEdge) {
    var longest = Math.max(width, height);
    var scale = longest > maxEdge ? maxEdge / longest : 1;
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    };
  }

  /** 主题定义 → 要注入的完整 CSS */
  function buildSkinCss(theme) {
    var colors = (theme && theme.colors) || {};
    var appearance = theme && theme.appearance === 'light' ? 'light' : 'dark';
    var declarations = [];

    Object.keys(VAR_MAP).forEach(function (key) {
      var value = colors[key];
      if (key === 'background' || key === 'backgroundAlt') {
        // 背景层要透出来：全窗底色与 macOS 那层蒙层都抹掉（原值多为半透明深色，等于蒙了层黑纱）
        value = TRANSPARENT;
      } else if (!value) {
        return;
      }
      declarations.push('  ' + VAR_MAP[key] + ': ' + String(value).trim() + ' !important;');
    });

    // win-alt 不在 VAR_MAP 里（它是窗口壳专用变量，不参与主题配色），单独补一条
    var covered = {};
    Object.keys(VAR_MAP).forEach(function (k) { covered[VAR_MAP[k]] = true; });
    SCHELL_VARS.forEach(function (cssVar) {
      if (covered[cssVar]) return;
      declarations.push('  ' + cssVar + ': ' + TRANSPARENT + ' !important;');
    });

    var parts = ['/* ZCode Expand · 皮肤 · ' + (theme.name || theme.id || '未命名') + ' · 自动注入，手动修改会被覆盖 */'];

    if (theme.heroDataUrl) {
      parts.push('html { background: url("' + theme.heroDataUrl + '") center / cover no-repeat !important; }');
    }

    // :root.dark 一并覆盖，保证皮肤配色与 ZCode 自己的深浅设置无关，切换系统主题不会把它冲掉
    parts.push(
      ':root, :root.dark {\n' +
        '  color-scheme: ' + appearance + ' !important;\n' +
        declarations.join('\n') +
        '\n}'
    );

    return parts.join('\n\n');
  }

  root.__ZC_SKIN_COLORS__ = {
    VAR_MAP: VAR_MAP,
    SCHELL_VARS: SCHELL_VARS,
    TRANSPARENT: TRANSPARENT,
    hexToRgb: hexToRgb,
    mix: mix,
    alpha: alpha,
    darken: darken,
    lighten: lighten,
    luminance: luminance,
    ensureAccentVisible: ensureAccentVisible,
    buildColors: buildColors,
    scaledSize: scaledSize,
    buildSkinCss: buildSkinCss,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
