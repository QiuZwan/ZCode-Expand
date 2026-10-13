// src/renderer/zc-skin.js — 皮肤引擎与控制面板
//
// 由 out/renderer/index.html 里的一行 <script src="./zcode-expand/zc-skin.js"> 载入，
// 依赖先加载的 zc-skin-colors.js（window.__ZC_SKIN_COLORS__）。
//
// 注入方式与参考实现 ci-yyy/zcode-skin（MIT）一致：往 <head> 插一个 <style id="zc-skin-style">，
// 先删旧的再插新的（幂等，重复执行不会叠加）。背景层画在 :root / html body 上（见
// zc-skin-colors.js 里 buildSkinCss 的注释——应用有一条 background:0 0!important 的重置）。
//
// 两条与参考实现分道扬镳的设计（设计文档 §4 事实 9/13、§5.3）：
//   1. 背景层选择器必须压过应用那条重置，且 Windows 上要抹的是 win-alt；
//   2. 媒体不走官方 zcode-media:// 协议，而是**存进渲染层 IndexedDB、用 blob URL 播放**。
//      官方协议的授权表在主进程且渲染层够不到（host 用 process.parentPort 才能登记），
//      走它要新增「渲染层→宿主→主进程」通道 + 三处 zod schema 放行；而 blob 路线
//      完全不碰主进程，还顺带解决了"源文件被移走皮肤就废"的问题。
//      持久化前提已实测：主窗口用持久化 session（第一阶段验过 localStorage 跨重启仍在）。
//
// 面板是纯 DOM 浮层，整体带 data-zc-skin-root 标记，不往 React 树里插。

(function (root) {
  'use strict';

  var COLORS = root.__ZC_SKIN_COLORS__;
  var doc = root.document;
  var STYLE_ID = 'zc-skin-style';
  var VIDEO_ID = 'zc-skin-video';
  var STORAGE_KEY = 'zc-skin-active';
  var ROOT_ATTR = 'data-zc-skin-root';
  // localStorage 配额 5MB 量级，data URL 是 base64（比原图大 1/3），留足余量
  var MAX_DATA_URL = 1.5 * 1024 * 1024;
  // IndexedDB：视频 Blob 的家（配额是磁盘级，远大于 localStorage）
  var DB_NAME = 'zc-skin-media';
  var DB_STORE = 'media';
  var DB_KEY = 'background-video';

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
  var videoUrl = null; // 当前 <video> 用的 blob URL，替换/拆除时要 revoke
  var pendingMessage = null; // 面板建好之前产生的提示，建好后补显

  // ---------------------------------------------------------------- IndexedDB

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req;
      try {
        req = root.indexedDB.open(DB_NAME, 1);
      } catch (err) {
        reject(new Error('这个环境没有可用的 IndexedDB'));
        return;
      }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('打不开媒体库')); };
    });
  }

  function idbRun(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, mode);
        var out;
        tx.oncomplete = function () { db.close(); resolve(out); };
        tx.onerror = function () { db.close(); reject(tx.error || new Error('媒体库操作失败')); };
        tx.onabort = function () { db.close(); reject(tx.error || new Error('媒体库操作中止')); };
        try {
          out = fn(tx.objectStore(DB_STORE), function (v) { out = v; });
        } catch (err) {
          db.close();
          reject(err);
        }
      });
    });
  }

  function idbPut(key, value) {
    return idbRun('readwrite', function (store) { store.put(value, key); });
  }

  function idbGet(key) {
    return idbRun('readonly', function (store, set) {
      var q = store.get(key);
      q.onsuccess = function () { set(q.result || null); };
    });
  }

  function idbDelete(key) {
    return idbRun('readwrite', function (store) { store.delete(key); });
  }

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

  /** 还原官方外观：移除注入的样式与视频层，不碰 ZCode 自己的任何东西 */
  function clear() {
    var el = doc.getElementById(STYLE_ID);
    if (el) el.remove();
    unmountVideo();
    active = null;
  }

  function current() { return active; }

  function isVideoTheme(theme) {
    return !!(theme && theme.media && theme.media.kind === 'video');
  }

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

  // ---------------------------------------------------------------- 视频层

  /**
   * 视频的压暗不能用 CSS 背景层那条黑纱 —— 黑纱是叠在 :root 的兜底渐变上的，
   * 而视频是独立的 <video> 元素，会把黑纱整个盖在后面。
   * 改用 filter: brightness() 直接压暗视频本身；数学上等价：
   * 黑纱 alpha=a 的结果是 c×(1-a)，brightness(1-a) 同样是 c×(1-a)。
   */
  function applyVideoScrim() {
    var v = doc.getElementById(VIDEO_ID);
    if (!v) return;
    var s = active && typeof active.scrim === 'number' && isFinite(active.scrim) ? active.scrim : 0;
    s = Math.max(0, Math.min(0.85, s));
    v.style.filter = s > 0 ? 'brightness(' + (1 - s) + ')' : '';
  }

  function mountVideo(url) {
    var v = doc.getElementById(VIDEO_ID);
    if (!v) {
      v = doc.createElement('video');
      v.id = VIDEO_ID;
      v.muted = true;
      v.loop = true;
      v.autoplay = true;
      v.setAttribute('playsinline', '');
      v.setAttribute('aria-hidden', 'true');
      // z-index:-1 → 画在 canvas 背景之上、应用内容之下
      v.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;object-fit:cover;z-index:-1;pointer-events:none';
      (doc.body || doc.documentElement).appendChild(v);
    }
    if (videoUrl && videoUrl !== url) URL.revokeObjectURL(videoUrl);
    videoUrl = url;
    v.src = url;
    applyVideoScrim();
    resumeVideo();
    return v;
  }

  function resumeVideo() {
    var v = doc.getElementById(VIDEO_ID);
    if (!v || !v.src) return;
    var p = v.play();
    // 自动播放被策略拒掉不是错误路径，静默即可（muted 时通常能播）
    if (p && typeof p.catch === 'function') p.catch(function () {});
  }

  function pauseVideo() {
    var v = doc.getElementById(VIDEO_ID);
    if (!v) return;
    try { v.pause(); } catch (err) { /* ignore */ }
  }

  /** 拆视频层：暂停 → 断开 src → revoke blob URL，一样都不能少，否则 blob 泄漏 */
  function unmountVideo() {
    var v = doc.getElementById(VIDEO_ID);
    if (videoUrl) {
      try { URL.revokeObjectURL(videoUrl); } catch (err) { /* ignore */ }
      videoUrl = null;
    }
    if (!v) return;
    try { v.pause(); } catch (err) { /* ignore */ }
    v.removeAttribute('src');
    try { v.load(); } catch (err) { /* ignore */ }
    v.remove();
  }

  /** 窗口不可见就暂停，省电省 GPU；回来再续播 */
  function watchVisibility() {
    doc.addEventListener('visibilitychange', function () {
      if (doc.hidden) pauseVideo();
      else resumeVideo();
    });
  }

  // ---------------------------------------------------------------- 取色与降采样（图片 / 视频共用）

  /** 把任意可绘制的源（HTMLImageElement / HTMLVideoElement）缩到 64px 宽采样 */
  function sampleSource(src, width, height) {
    var W = 64;
    var H = Math.max(1, Math.round((W * height) / width));
    var canvas = doc.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, W, H);
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

  /**
   * 采样结果 → 完整主题的配色部分（图片与视频共用同一套推导）。
   * heroCss 是「素材没画出来时的兜底底色」，**必须跟着推导出的深浅走**：
   * 写死深色的话，遇到亮素材（判成 light、前景色是深色）就会出现深字压深底、看不清。
   */
  function colorsFromPalette(palette) {
    var appearance = palette.avgL < 0.45 ? 'dark' : 'light';
    // 素材很暗/很亮时取出的主色会看不清，先夹进安全明度区间再参与映射
    var seed = {
      accent: COLORS.ensureAccentVisible(palette.accent, appearance),
      secondary: palette.secondary,
      surface: appearance === 'dark' ? COLORS.darken(palette.avg, 0.5) : COLORS.lighten(palette.avg, 0.6),
      text: appearance === 'dark' ? COLORS.lighten(palette.avg, 0.82) : COLORS.darken(palette.avg, 0.74),
    };
    return {
      appearance: appearance,
      colors: COLORS.buildColors(seed, appearance),
      heroCss: appearance === 'dark'
        ? 'linear-gradient(135deg, ' + COLORS.darken(palette.avg, 0.62) + ' 0%, ' + COLORS.darken(palette.avg, 0.78) + ' 100%)'
        : 'linear-gradient(135deg, ' + COLORS.lighten(palette.avg, 0.72) + ' 0%, ' + COLORS.lighten(palette.avg, 0.86) + ' 100%)',
    };
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

  function baseName(name) {
    return String(name || '').replace(/\.[^.]+$/, '') || '自定义';
  }

  // ---------------------------------------------------------------- 选图

  function pickImage(file) {
    if (!file) return;
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      try {
        var palette = sampleSource(img, img.width, img.height);
        var built = colorsFromPalette(palette);
        var theme = {
          schemaVersion: 1,
          id: 'custom-' + Date.now().toString(36),
          name: baseName(file.name),
          appearance: built.appearance,
          heroDataUrl: encodeWithinBudget(img),
          colors: built.colors,
          autoGenerated: { avgL: Number(palette.avgL.toFixed(3)) },
        };
        var res = useTheme(theme, true);
        if (res.ok) { unmountVideo(); idbDelete(DB_KEY).catch(function () {}); }
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

  // ---------------------------------------------------------------- 选视频

  /** 等视频出首帧；超时或解码失败都要明确抛错，不静默卡住 */
  function sampleVideoFrame(video) {
    return new Promise(function (resolve, reject) {
      var done = false;
      function finish() {
        if (done) return;
        done = true;
        try { resolve(sampleSource(video, video.videoWidth, video.videoHeight)); }
        catch (err) { reject(err); }
      }
      function fail(message) {
        if (done) return;
        done = true;
        reject(new Error(message));
      }
      if (video.readyState >= 2 && video.videoWidth) { finish(); return; }
      video.addEventListener('loadeddata', finish, { once: true });
      video.addEventListener('error', function () { fail('这个视频解不开（编码不支持或文件损坏）'); }, { once: true });
      root.setTimeout(function () { fail('视频首帧读取超时'); }, 8000);
    });
  }

  function pickVideo(file) {
    if (!file) return;
    showMessage('正在读取视频…');
    var url = URL.createObjectURL(file);
    var probe = doc.createElement('video');
    probe.muted = true;
    probe.setAttribute('playsinline', '');
    probe.preload = 'auto';
    // 离屏 video 在部分实现里不解码帧，drawImage 会读到空 —— 挂个 1px 不可见的在文档里
    probe.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
    (doc.body || doc.documentElement).appendChild(probe);
    probe.src = url;

    function cleanupProbe() {
      try { probe.removeAttribute('src'); probe.load(); } catch (err) { /* ignore */ }
      probe.remove();
      URL.revokeObjectURL(url);
    }

    function abort(message) {
      cleanupProbe();
      showMessage(message, true);
    }

    sampleVideoFrame(probe).then(function (palette) {
      var built = colorsFromPalette(palette);
      var theme = {
        schemaVersion: 1,
        id: 'video-' + Date.now().toString(36),
        name: baseName(file.name),
        appearance: built.appearance,
        // 视频由 <video> 元素铺满，heroCss 只是兜底底色（跟着推导出的深浅走）。
        // 注意 buildSkinCss 对视频主题只把兜底画在 :root —— body 有背景会盖住视频。
        heroCss: built.heroCss,
        media: { kind: 'video', name: String(file.name || '') },
        colors: built.colors,
        autoGenerated: { avgL: Number(palette.avgL.toFixed(3)) },
      };
      cleanupProbe();
      return idbPut(DB_KEY, file).then(function () {
        var res = useTheme(theme, true);
        if (!res.ok) return res;
        mountVideo(URL.createObjectURL(file));
        renderList();
        return { ok: true };
      });
    }).then(function (res) {
      if (!res) return;
      showMessage(res.ok ? '已应用视频皮肤' : res.error, !res.ok);
    }).catch(function (err) {
      abort((err && err.message) || String(err));
    });
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
    '#zcsk-panel .zcsk-scrim{margin-top:8px}',
    '#zcsk-panel .zcsk-scrim .zcsk-lb{font-size:11px;opacity:.6;margin-bottom:4px}',
    '#zcsk-panel .zcsk-scrim .zcsk-row{display:flex;gap:6px}',
    '#zcsk-panel .zcsk-scrim .zcsk-btn{flex:1;padding:3px 0;font-size:11px}',
    '#zcsk-panel .zcsk-btn{padding:5px 8px;border-radius:6px;cursor:pointer;text-align:center;',
    'border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06)}',
    '#zcsk-panel .zcsk-btn:hover{background:rgba(255,255,255,.13)}',
    '#zcsk-panel .zcsk-btn.zcsk-on{background:rgba(255,255,255,.22);border-color:rgba(255,255,255,.42)}',
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
    if (!text) return;
    // 面板还没建好（boot 早期）就先存着，建好后补上，别把提示吞掉
    if (!ui || !ui.msg) {
      pendingMessage = { text: text, isError: !!isError };
      return;
    }
    ui.msg.textContent = text;
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
        if (res.ok) { unmountVideo(); idbDelete(DB_KEY).catch(function () {}); }
        showMessage(res.ok ? '已应用：' + theme.name : res.error, !res.ok);
        renderList();
      });
      ui.list.appendChild(row);
    });
    // 当前是自定义皮肤（图片或视频）就在列表末尾插一条
    if (active && (active.heroDataUrl || isVideoTheme(active))) {
      var row = el('div', 'zcsk-item zcsk-on');
      row.appendChild(swatch(active));
      row.appendChild(el('span', null, (isVideoTheme(active) ? '▶ ' : '') + (active.name || '自定义')));
      ui.list.appendChild(row);
    }
    // 标记当前压暗档位
    if (ui.scrimBtns) {
      var cur = active && typeof active.scrim === 'number' ? active.scrim : 0;
      ui.scrimBtns.forEach(function (b) {
        b.node.className = 'zcsk-btn' + (Math.abs(b.value - cur) < 0.001 ? ' zcsk-on' : '');
      });
    }
  }

  /** 换一档背景压暗：保留其余字段，只改 scrim，并持久化 */
  function setScrim(value) {
    if (!active) { showMessage('先选一套皮肤，再调压暗', true); return; }
    var next = {};
    for (var k in active) {
      if (Object.prototype.hasOwnProperty.call(active, k)) next[k] = active[k];
    }
    if (value > 0) next.scrim = value;
    else delete next.scrim;
    var res = useTheme(next, true);
    // 视频主题的背景不在这条 CSS 里，压暗得单独作用到 <video> 上
    if (res.ok) applyVideoScrim();
    showMessage(res.ok ? '背景压暗已调整' : res.error, !res.ok);
    renderList();
  }

  /** 还原官方外观：清样式、拆视频层、清 IndexedDB 与 localStorage */
  function resetAll() {
    clear();
    idbDelete(DB_KEY).catch(function () {});
    try { root.localStorage.removeItem(STORAGE_KEY); } catch (err) { /* 存不了就算了，界面已还原 */ }
    showMessage('已还原官方外观');
    renderList();
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
    var imgInput = doc.createElement('input');
    imgInput.type = 'file';
    imgInput.accept = 'image/*';
    imgInput.style.display = 'none';
    imgInput.addEventListener('change', function () {
      var f = imgInput.files && imgInput.files[0];
      imgInput.value = ''; // 允许连续选同一个文件
      pickImage(f);
    });
    var vidInput = doc.createElement('input');
    vidInput.type = 'file';
    vidInput.accept = 'video/*';
    vidInput.style.display = 'none';
    vidInput.addEventListener('change', function () {
      var f = vidInput.files && vidInput.files[0];
      vidInput.value = '';
      pickVideo(f);
    });
    var pickImg = el('div', 'zcsk-btn', '选图…');
    pickImg.addEventListener('click', function () { imgInput.click(); });
    var pickVid = el('div', 'zcsk-btn', '选视频…');
    pickVid.addEventListener('click', function () { vidInput.click(); });
    var reset = el('div', 'zcsk-btn', '还原');
    reset.title = '还原官方外观';
    reset.addEventListener('click', resetAll);
    acts.appendChild(pickImg);
    acts.appendChild(pickVid);
    acts.appendChild(reset);
    panel.appendChild(acts);

    // 压暗：背景图亮部大时界面文字对比度会不够，在背景之上叠一层半透明黑。
    // 关 / 轻 / 中 / 重四档，纯 CSS 分层（见 zc-skin-colors.js 的 scrim 处理）。
    var SCRIMS = [['关', 0], ['轻', 0.25], ['中', 0.45], ['重', 0.65]];
    var scrimBox = el('div', 'zcsk-scrim');
    scrimBox.appendChild(el('div', 'zcsk-lb', '背景压暗'));
    var scrimRow = el('div', 'zcsk-row');
    var scrimBtns = SCRIMS.map(function (pair) {
      var b = el('div', 'zcsk-btn', pair[0]);
      b.addEventListener('click', function () { setScrim(pair[1]); });
      scrimRow.appendChild(b);
      return { value: pair[1], node: b };
    });
    scrimBox.appendChild(scrimRow);
    panel.appendChild(scrimBox);

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
    rootNode.appendChild(imgInput);
    rootNode.appendChild(vidInput);
    (doc.body || doc.documentElement).appendChild(rootNode);

    ui = { panel: panel, list: list, msg: msg, root: rootNode, scrimBtns: scrimBtns };
    renderList();
    if (pendingMessage) {
      var pm = pendingMessage;
      pendingMessage = null;
      showMessage(pm.text, pm.isError);
    }
  }

  /** 运行时自检用：把关键状态一次问出来，省得在控制台逐个敲 */
  function diag() {
    var styleEl = doc.getElementById(STYLE_ID);
    var cs = root.getComputedStyle ? root.getComputedStyle(doc.documentElement) : null;
    var read = function (name) { return cs ? cs.getPropertyValue(name).trim() : ''; };
    var shells = {};
    COLORS.SCHELL_VARS.forEach(function (v) { shells[v] = read(v); });
    var v = doc.getElementById(VIDEO_ID);
    return {
      stylePresent: !!styleEl,
      themeId: styleEl ? styleEl.getAttribute('data-zc-skin') : null,
      cssBytes: styleEl ? styleEl.textContent.length : 0,
      shells: shells,
      background: read('--color-background'),
      sidebar: read('--color-sidebar'),
      currentTheme: active ? active.id : null,
      scrim: active && typeof active.scrim === 'number' ? active.scrim : 0,
      panelMounted: !!(ui && doc.getElementById('zcsk-launcher')),
      video: v
        ? { present: true, paused: v.paused, w: v.videoWidth, h: v.videoHeight, blobUrl: !!videoUrl, filter: v.style.filter || '(无)' }
        : { present: false },
    };
  }

  /** 恢复上次那套皮肤；视频主题要从 IndexedDB 把 Blob 取回来重挂 */
  function restore(theme) {
    if (!apply(theme)) return false;
    if (isVideoTheme(theme)) {
      idbGet(DB_KEY).then(function (blob) {
        if (!blob) {
          showMessage('上次的视频已不在媒体库里，请重选', true);
          return;
        }
        mountVideo(URL.createObjectURL(blob));
      }).catch(function (err) {
        console.warn('[zc-skin] 读取媒体库失败：', err);
        showMessage('读取视频媒体库失败：' + ((err && err.message) || err), true);
      });
    }
    return true;
  }

  function boot() {
    var saved = loadActive();
    if (!restore(saved || BUILTINS[0])) {
      // 文档没就绪就下一帧再来，别把皮肤丢了
      root.setTimeout(boot, 60);
      return;
    }
    buildPanel();
    watchVisibility();
  }

  // 先把全局挂上再 boot：万一 boot 抛错，至少还能在控制台拿到句柄排查
  root.__ZC_SKIN__ = {
    apply: apply,
    clear: clear,
    current: current,
    diag: diag,
    useTheme: useTheme,
    mountVideo: mountVideo,
    unmountVideo: unmountVideo,
    pauseVideo: pauseVideo,
    resumeVideo: resumeVideo,
    BUILTINS: BUILTINS,
  };

  if (doc.head) boot();
  else doc.addEventListener('DOMContentLoaded', boot, { once: true });
})(typeof window !== 'undefined' ? window : globalThis);
