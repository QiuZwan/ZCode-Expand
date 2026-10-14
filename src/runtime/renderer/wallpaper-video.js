/* ZCode-Expand · 视频壁纸层
 * ---------------------------------------------------------------------------
 * CSS 放不了视频，所以视频壁纸由这一层承担：一个铺满视口的 <video>，画在界面之下。
 *
 * 层叠关系（本项目踩过的坑，见 docs/04）：
 *   <video> 是 body 的子元素且 z-index:-1。body 没有自己的层叠上下文，
 *   负 z-index 后代会上溯到**根**层叠上下文，而根层叠上下文里"流内块级后代的背景"
 *   画在"负 z-index 后代"之后——**body 一旦有背景就会把视频整块盖住**。
 *   所以外观层从不给 body 设背景（壁纸画在 body::before 上，与视频互斥）。
 *
 * 由 preload 注入主世界；与主进程的通道是 window.__ZC_EXPAND_IPC__。
 * ---------------------------------------------------------------------------
 */
(function () {
  'use strict';

  var IPC = window.__ZC_EXPAND_IPC__;
  if (!IPC) return;
  if (window.__ZC_EXPAND_VIDEO__) return; // 幂等

  var VIDEO_ID = 'zcode-expand-video';
  var currentUrl = null;

  function video() {
    return document.getElementById(VIDEO_ID);
  }

  function unmount() {
    var v = video();
    if (!v) { currentUrl = null; return; }
    try { v.pause(); } catch (e) { /* 忽略 */ }
    v.removeAttribute('src');
    try { v.load(); } catch (e) { /* 忽略 */ }
    v.remove();
    currentUrl = null;
  }

  function mount(url) {
    var v = video();
    if (!v) {
      v = document.createElement('video');
      v.id = VIDEO_ID;
      v.muted = true;
      v.loop = true;
      v.autoplay = true;
      v.setAttribute('playsinline', '');
      v.setAttribute('aria-hidden', 'true');
      v.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;object-fit:cover;z-index:-1;pointer-events:none';
      (document.body || document.documentElement).appendChild(v);
    }
    if (currentUrl !== url) {
      currentUrl = url;
      v.src = url;
    }
    resume();
  }

  function resume() {
    var v = video();
    if (!v || !v.src) return;
    var p = v.play();
    // 自动播放被策略拒掉不是错误路径，静默即可（muted 时通常能播）
    if (p && typeof p.catch === 'function') p.catch(function () {});
  }

  function pause() {
    var v = video();
    if (!v) return;
    try { v.pause(); } catch (e) { /* 忽略 */ }
  }

  /** 按当前外观同步视频层：是视频壁纸就挂上，不是就拆掉 */
  function sync(data) {
    try {
      if (!data || !data.config || data.config.enabled === false) { unmount(); return; }
      var urls = data.videoUrl || {};
      // 深浅两套可能是不同的视频；模式由 ZCode 在 <html> 上设的 class 决定
      var isDark = document.documentElement.classList.contains('dark');
      var url = isDark ? (urls.dark || urls.light) : (urls.light || urls.dark);
      if (!url) { unmount(); return; }
      mount(url);
    } catch (error) {
      console.error('[zc-expand] 视频壁纸层同步失败：', error);
    }
  }

  function refresh() {
    try {
      var p = IPC.panelGet();
      if (p && p.then) p.then(sync).catch(function () { /* 面板数据取不到就维持现状 */ });
    } catch (e) { /* 忽略 */ }
  }

  // 窗口不可见就暂停，省电省 GPU；回来再续播
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) pause();
    else resume();
  });

  // 深浅模式切换时可能换视频
  try {
    new MutationObserver(function () { refresh(); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  } catch (e) { /* MutationObserver 不可用就算了 */ }

  try { IPC.onChanged(refresh); } catch (e) { /* 忽略 */ }

  window.__ZC_EXPAND_VIDEO__ = { refresh: refresh, unmount: unmount, mount: mount };

  (function wait() {
    if (document.body) { refresh(); return; }
    setTimeout(wait, 0);
  })();
})();
