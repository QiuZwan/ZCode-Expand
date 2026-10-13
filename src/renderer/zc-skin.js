// src/renderer/zc-skin.js — 皮肤引擎与控制面板
//
// 由 out/renderer/index.html 里的一行 <script src="./zcode-expand/zc-skin.js"> 载入，
// 依赖先加载的 zc-skin-colors.js（window.__ZC_SKIN_COLORS__）。
//
// 注入方式与参考实现 ci-yyy/zcode-skin（MIT）一致：往 <head> 插一个 <style id="zc-skin-style">，
// 先删旧的再插新的（幂等，重复执行不会叠加）。背景层画在 :root / html body 上（见
// zc-skin-colors.js 里 buildSkinCss 的注释——应用有一条 background:0 0!important 的重置）。
//
// 面板是纯 DOM 浮层，整体带 data-zc-skin-root 标记，不往 React 树里插。
// 皮肤定义存渲染层 localStorage：渲染层读不了文件（preload 只暴露 log/syncAppSettings/
// onSettingsChanged），所以第一阶段不落 ~/.zcode/v2/，也就完全不碰主进程。

(function (root) {
  'use strict';

  var COLORS = root.__ZC_SKIN_COLORS__;
  var doc = root.document;
  var STYLE_ID = 'zc-skin-style';
  var STORAGE_KEY = 'zc-skin-active';
  var ROOT_ATTR = 'data-zc-skin-root';
  // localStorage 配额 5MB 量级，data URL 是 base64（比原图大 1/3），留足余量
  var MAX_DATA_URL = 1.5 * 1024 * 1024;

  if (!COLORS) {
    // 缺依赖就明确报出来，不静默失效——静默失效会让"皮肤没生效"变成一个查不出原因的现象
    console.error('[zc-skin] 缺少 zc-skin-colors.js，皮肤引擎未启动');
    return;
  }

  // 内置预设：全部是纯 CSS 渐变，不含任何第三方视觉素材
  var PRESETS = [
    { id: 'midnight', name: '午夜蓝', appearance: 'dark',
      heroCss: 'linear-gradient(135deg, #0b1020 0%, #16233f 55%, #2b3a67 100%)',
      seed: { accent: '#5b8def', secondary: '#7c5cff', surface: '#0f172a', text: '#dbe4f5' } },
    { id: 'dusk', name: '暮色', appearance: 'dark',
      heroCss: 'linear-gradient(135deg, #1a0f1f 0%, #2d1b3d 50%, #4a2b52 100%)',
      seed: { accent: '#c084fc', secondary: '#f472b6', surface: '#170f1d', text: '#eadcf5' } },
    { id: 'mint', name: '薄荷', appearance: 'light',
      heroCss: 'linear-gradient(135deg, #e8f6f0 0%, #d3ebe2 55%, #b9dcd2 100%)',
      seed: { accent: '#0f9b7a', secondary: '#3b82f6', surface: '#eef7f3', text: '#12352c' } },
    { id: 'paper', name: '宣纸', appearance: 'light',
      heroCss: 'linear-gradient(135deg, #faf6ee 0%, #f2ebdd 55%, #e6dcc8 100%)',
      seed: { accent: '#b45309', secondary: '#0f766e', surface: '#faf6ee', text: '#3a3226' } },
  ];

  function themeFromPreset(preset) {
    return {
      schemaVersion: 1,
      id: preset.id,
      name: preset.name,
      appearance: preset.appearance,
      heroCss: preset.heroCss,
      colors: COLORS.buildColors(preset.seed, preset.appearance),
    };
  }

  var BUILTINS = PRESETS.map(themeFromPreset);
  var active = null;
  var ui = null; // 面板 DOM 句柄，全部挂在一个带 ROOT_ATTR 的容器里

  // ---------------------------------------------------------------- 引擎

  /** 插样式：先删旧的再插新的，保证幂等 */
  function apply(theme) {
    if (!theme || typeof theme !== 'object') return false;
    var head = doc.head || doc.documentElement;
    if (!head) return false; // 文档还没就绪，交给调用方稍后重试
    var prev = doc.getElementById(STYLE_ID);
    if (prev) prev.remove();
    var style = doc.createElement('style');
    style.id = STYLE_ID;
    style.setAttribute('data-zc-skin', theme.id || '');
    style.textContent = COLORS.buildSkinCss(theme);
    head.appendChild(style);
    active = theme;
    return true;
  }

  /** 还原官方外观：只移除注入的样式，不碰 ZCode 自己的任何东西 */
  function clear() {
    var el = doc.getElementById(STYLE_ID);
    if (el) el.remove();
    active = null;
  }

  function current() { return active; }

  /** 应用并持久化；持久化失败要把界面回滚，不留"看着生效、重启就没了"的半成品 */
  function useTheme(theme, persist) {
    var prev = active;
    if (!apply(theme)) return { ok: false, error: '样式注入失败（文档未就绪）' };
    if (!persist) return { ok: true };
    try {
      root.localStorage.setItem(STORAGE_KEY, JSON.stringify(theme));
      return { ok: true };
    } catch (err) {
      if (prev) apply(prev); else clear();
      return { ok: false, error: '图片太大，存不下（浏览器存储配额已满）' };
    }
  }

  function loadActive() {
    var raw;
    try { raw = root.localStorage.getItem(STORAGE_KEY); } catch (err) { return null; }
    if (!raw) return null;
    try {
      var theme = JSON.parse(raw);
      // 一条坏记录不能让整窗白屏，解析不出就退回内置第一套
      return theme && typeof theme === 'object' && theme.colors ? theme : null;
    } catch (err) {
      console.warn('[zc-skin] 本地存着一条解析不了的皮肤记录，已忽略');
      return null;
    }
  }

  // ---------------------------------------------------------------- 取色与降采样

  /** 把图缩到 64px 宽采样：按色相 30° 分桶、按饱和度加权投票取主色/辅色 */
  function sampleImage(img) {
    var W = 64;
    var H = Math.max(1, Math.round((W * img.height) / img.width));
    var canvas = doc.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, W, H);
    var data = ctx.getImageData(0, 0, W, H).data;

    var totalL = 0, sr = 0, sg = 0, sb = 0, n = 0;
    var buckets = new Map();
    for (var i = 0; i < data.length; i += 4) {
      var r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
      sr += r; sg += g; sb += b; n += 1;
      var max = Math.max(r, g, b), min = Math.min(r, g, b);
      var l = (max + min) / 2;
      totalL += l;
      var d = max - min;
      if (d === 0) continue;
      var s = d / (1 - Math.abs(2 * l - 1));
      if (s < 0.18 || l < 0.12 || l > 0.92) continue; // 太灰/太黑/太白的像素不参与投票
      var h;
      if (max === r) h = ((g - b) / d + 6) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      var key = Math.round(h / 30);
      var cur = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0, w: 0 };
      cur.r += r; cur.g += g; cur.b += b; cur.n += 1; cur.w += s;
      buckets.set(key, cur);
    }

    function toHex(r, g, b) {
      return '#' + [r, g, b].map(function (v) {
        return Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
      }).join('');
    }
    // Map 的插入序不可靠，显式按权重排序
    var ranked = Array.from(buckets.values()).sort(function (a, b) { return b.w - a.w; });
    var accent = ranked[0] ? toHex(ranked[0].r / ranked[0].n, ranked[0].g / ranked[0].n, ranked[0].b / ranked[0].n) : '#38bdf8';
    var secondary = ranked[1] ? toHex(ranked[1].r / ranked[1].n, ranked[1].g / ranked[1].n, ranked[1].b / ranked[1].n) : accent;
    return { accent: accent, secondary: secondary, avg: toHex(sr / n, sg / n, sb / n), avgL: totalL / n };
  }

  /** 缩到指定最长边，输出 data URL。有 alpha 保持 PNG，否则 JPEG */
  function encode(img, maxEdge, quality) {
    var size = COLORS.scaledSize(img.width, img.height, maxEdge);
    var canvas = doc.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    var ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, size.width, size.height);
    var px = ctx.getImageData(0, 0, size.width, size.height).data;
    var hasAlpha = false;
    for (var i = 3; i < px.length; i += 4) {
      if (px[i] < 250) { hasAlpha = true; break; }
    }
    return hasAlpha ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', quality);
  }

  /** 先按 1920 编码；超预算就降到 1280 再试一次；仍超就明确报错，不做无声截断 */
  function encodeWithinBudget(img) {
    var out = encode(img, 1920, 0.8);
    if (out.length <= MAX_DATA_URL) return out;
    out = encode(img, 1280, 0.75);
    if (out.length <= MAX_DATA_URL) return out;
    throw new Error('这张图压缩后仍然太大，换一张或先自行缩小');
  }

  function themeFromImage(img, name) {
    var palette = sampleImage(img);
    var appearance = palette.avgL < 0.45 ? 'dark' : 'light';
    // 图片很暗/很亮时取出的主色会看不清，先夹进安全明度区间再参与映射
    var seed = {
      accent: COLORS.ensureAccentVisible(palette.accent, appearance),
      secondary: palette.secondary,
      surface: appearance === 'dark' ? COLORS.darken(palette.avg, 0.5) : COLORS.lighten(palette.avg, 0.6),
      text: appearance === 'dark' ? COLORS.lighten(palette.avg, 0.82) : COLORS.darken(palette.avg, 0.74),
    };
    return {
      schemaVersion: 1,
      id: 'custom-' + Date.now().toString(36),
      name: name || '自定义',
      appearance: appearance,
      heroDataUrl: encodeWithinBudget(img),
      colors: COLORS.buildColors(seed, appearance),
      autoGenerated: { avgL: Number(palette.avgL.toFixed(3)) },
    };
  }

  // ---------------------------------------------------------------- 面板

  var CSS = [
    '#zcsk-launcher{position:fixed;right:18px;bottom:18px;width:40px;height:40px;border-radius:50%;',
    'border:1px solid rgba(255,255,255,.22);background:rgba(20,26,38,.55);backdrop-filter:blur(8px);',
    'color:#e2e8f0;font-size:18px;line-height:1;cursor:pointer;z-index:2147483000;',
    'display:flex;align-items:center;justify-content:center;transition:transform .15s ease}',
    '#zcsk-launcher:hover{transform:scale(1.08)}',
    '#zcsk-panel{position:fixed;right:18px;bottom:68px;width:264px;border-radius:12px;',
    'border:1px solid rgba(255,255,255,.16);background:rgba(15,20,32,.92);backdrop-filter:blur(14px);',
    'color:#e2e8f0;font:12px/1.6 ui-sans-serif,system-ui,"Segoe UI","Microsoft YaHei",sans-serif;',
    'box-shadow:0 12px 32px rgba(0,0,0,.45);z-index:2147483000;padding:10px;display:none}',
    '#zcsk-panel.zcsk-open{display:block}',
    '#zcsk-panel .zcsk-hd{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}',
    '#zcsk-panel .zcsk-hd b{font-size:13px}',
    '#zcsk-panel .zcsk-x{cursor:pointer;opacity:.6;padding:0 4px}',
    '#zcsk-panel .zcsk-x:hover{opacity:1}',
    '#zcsk-panel .zcsk-item{display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:6px;cursor:pointer}',
    '#zcsk-panel .zcsk-item:hover{background:rgba(255,255,255,.09)}',
    '#zcsk-panel .zcsk-item.zcsk-on{background:rgba(255,255,255,.15)}',
    '#zcsk-panel .zcsk-sw{width:22px;height:14px;border-radius:3px;flex:0 0 auto;border:1px solid rgba(255,255,255,.2)}',
    '#zcsk-panel .zcsk-act{margin-top:8px;display:flex;gap:6px}',
    '#zcsk-panel .zcsk-btn{flex:1;padding:5px 8px;border-radius:6px;cursor:pointer;text-align:center;',
    'border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06)}',
    '#zcsk-panel .zcsk-btn:hover{background:rgba(255,255,255,.13)}',
    '#zcsk-panel .zcsk-msg{margin-top:8px;min-height:16px;font-size:11px;opacity:.85;word-break:break-all}',
    '#zcsk-panel .zcsk-msg.zcsk-err{color:#fca5a5}',
  ].join('');

  function el(tag, cls, text) {
    var node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function swatch(theme) {
    var sw = el('span', 'zcsk-sw');
    if (theme.heroCss) {
      sw.style.background = theme.heroCss;
    } else if (theme.heroDataUrl) {
      sw.style.backgroundImage = 'url("' + theme.heroDataUrl + '")';
      sw.style.backgroundSize = 'cover';
      sw.style.backgroundPosition = 'center';
    } else {
      sw.style.background = (theme.colors && theme.colors.accent) || '#888';
    }
    return sw;
  }

  function showMessage(text, isError) {
    if (!ui || !ui.msg) return;
    ui.msg.textContent = text || '';
    ui.msg.className = 'zcsk-msg' + (isError ? ' zcsk-err' : '');
  }

  function renderList() {
    if (!ui) return;
    ui.list.textContent = '';
    BUILTINS.forEach(function (theme) {
      var row = el('div', 'zcsk-item' + (active && active.id === theme.id ? ' zcsk-on' : ''));
      row.appendChild(swatch(theme));
      row.appendChild(el('span', null, theme.name));
      row.addEventListener('click', function () {
        var res = useTheme(theme, true);
        showMessage(res.ok ? '已应用：' + theme.name : res.error, !res.ok);
        renderList();
      });
      ui.list.appendChild(row);
    });
    if (active && active.heroDataUrl) {
      var row = el('div', 'zcsk-item zcsk-on');
      row.appendChild(swatch(active));
      row.appendChild(el('span', null, active.name || '自定义'));
      ui.list.appendChild(row);
    }
  }

  function pickImage(file) {
    if (!file) return;
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      try {
        var theme = themeFromImage(img, String(file.name || '').replace(/\.[^.]+$/, '') || '自定义');
        var res = useTheme(theme, true);
        showMessage(res.ok ? '已应用：' + theme.name : res.error, !res.ok);
        renderList();
      } catch (err) {
        // 压缩超预算等：当前皮肤与已存记录都不动
        showMessage((err && err.message) || String(err), true);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = function () {
      // 选到非图片（.txt / .pdf / 改了后缀的）：明确报错，且不破坏当前皮肤与 localStorage
      URL.revokeObjectURL(url);
      showMessage('这个文件不是能识别的图片', true);
    };
    img.src = url;
  }

  function buildPanel() {
    var launcher = el('div');
    launcher.id = 'zcsk-launcher';
    launcher.setAttribute(ROOT_ATTR, '1');
    launcher.title = '皮肤';
    launcher.textContent = '🎨';

    var panel = el('div');
    panel.id = 'zcsk-panel';
    panel.setAttribute(ROOT_ATTR, '1');

    var hd = el('div', 'zcsk-hd');
    hd.appendChild(el('b', null, '皮肤'));
    var close = el('span', 'zcsk-x', '✕');
    close.addEventListener('click', function () { panel.classList.remove('zcsk-open'); });
    hd.appendChild(close);
    panel.appendChild(hd);

    var list = el('div');
    panel.appendChild(list);

    var acts = el('div', 'zcsk-act');
    var pick = el('div', 'zcsk-btn', '选图…');
    var input = doc.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    input.addEventListener('change', function () {
      var f = input.files && input.files[0];
      input.value = ''; // 允许连续选同一个文件
      pickImage(f);
    });
    pick.addEventListener('click', function () { input.click(); });
    var reset = el('div', 'zcsk-btn', '还原官方外观');
    reset.addEventListener('click', function () {
      clear();
      try { root.localStorage.removeItem(STORAGE_KEY); } catch (err) { /* 存不了就算了，界面已还原 */ }
      showMessage('已还原官方外观');
      renderList();
    });
    acts.appendChild(pick);
    acts.appendChild(reset);
    panel.appendChild(acts);

    var msg = el('div', 'zcsk-msg');
    panel.appendChild(msg);

    var style = doc.createElement('style');
    style.setAttribute(ROOT_ATTR, '1');
    style.textContent = CSS;

    launcher.addEventListener('click', function () {
      panel.classList.toggle('zcsk-open');
      if (panel.classList.contains('zcsk-open')) renderList();
    });

    var rootNode = el('div');
    rootNode.setAttribute(ROOT_ATTR, '1');
    rootNode.appendChild(style);
    rootNode.appendChild(panel);
    rootNode.appendChild(launcher);
    rootNode.appendChild(input);
    (doc.body || doc.documentElement).appendChild(rootNode);

    ui = { panel: panel, list: list, msg: msg, root: rootNode };
    renderList();
  }

  /** 运行时自检用：把关键状态一次问出来，省得在控制台逐个敲 */
  function diag() {
    var styleEl = doc.getElementById(STYLE_ID);
    var cs = root.getComputedStyle ? root.getComputedStyle(doc.documentElement) : null;
    var read = function (name) { return cs ? cs.getPropertyValue(name).trim() : ''; };
    var shells = {};
    COLORS.SCHELL_VARS.forEach(function (v) { shells[v] = read(v); });
    return {
      stylePresent: !!styleEl,
      themeId: styleEl ? styleEl.getAttribute('data-zc-skin') : null,
      cssBytes: styleEl ? styleEl.textContent.length : 0,
      shells: shells,
      background: read('--color-background'),
      sidebar: read('--color-sidebar'),
      currentTheme: active ? active.id : null,
      panelMounted: !!(ui && doc.getElementById('zcsk-launcher')),
    };
  }

  function boot() {
    var saved = loadActive();
    if (!apply(saved || BUILTINS[0])) {
      // 文档没就绪就下一帧再来，别把皮肤丢了
      root.setTimeout(boot, 60);
      return;
    }
    buildPanel();
  }

  // 先把全局挂上再 boot：万一 boot 抛错，至少还能在控制台拿到句柄排查
  root.__ZC_SKIN__ = {
    apply: apply,
    clear: clear,
    current: current,
    diag: diag,
    useTheme: useTheme,
    BUILTINS: BUILTINS,
  };

  if (doc.head) boot();
  else doc.addEventListener('DOMContentLoaded', boot, { once: true });
})(typeof window !== 'undefined' ? window : globalThis);
