// src/runtime/renderer/pet.js — 桌宠（渲染层）
//
// 一份脚本、两种摆放，共用同一个显示层（createDisplay：长相、动作、气泡、音效、点击、拖拽）：
//   · 窗口内：ZCode 每个主窗口里一只。自己的 host + closed shadow DOM，位置吸附后记 localStorage；
//   · 桌面模式页：桌面小窗（src/runtime/pet/desktop.html）加载的也是这份脚本。认到
//     window.__ZC_PET_PAGE__ 桥（desktop-preload.cjs 暴露）就走桌面页分支，位置由主进程摆。
//
// 注入与调用（调用方要做的两件事，本文件不自己注册任何 IPC）：
//   1. 把 'pet.js' 加进 src/runtime/main.mjs 的 RENDERER_MODULES（部署到 ~/.zcode-expand/runtime/renderer/）；
//   2. 主进程拿到载荷后推进来：contents.executeJavaScript(petPushExpression(payload), true)，
//      petPushExpression 见 src/runtime/pet/service.mjs；新窗口 did-finish-load 时补推一次 pet.payload()，
//      同时推一次掩码图 petMaskExpression(mask)（每个窗口一次，见下）。
//   自检：控制台 __ZC_PET__.diag()（maskSource: inline / file）。
//
// 「透明处不挡鼠标」靠角色图的 alpha 掩码。掩码要在 canvas 上读像素，而 **file:// 的图会让
// canvas 变脏**（getImageData 直接抛 SecurityError，Chromium 实测），所以除了 file:// 的显示图，
// 主进程还会推一张内联 data: URL 专门用来建掩码（data: 继承文档源，读得出来）。
// 没推那张图时退回「角色图整块矩形可点」——桌宠照常工作，只是透明处会挡住鼠标。
//
// 素材：仓库里不带任何图片 / 音效（第三方素材不分发）。主进程从用户目录解析（src/runtime/pet/assets.mjs），
// 把 file:// URL 放进载荷；没有素材就没有 enabled:true 的载荷，于是桌宠不出现、也不报错。
//
// ⚠️ 与 src/runtime/pet/spec.mjs 的重复：协议版本号与情绪名各留一份（没有构建步骤，单文件脚本
//    不能 import）。改一处必须改另一处，grep PET_PROTOCOL_VERSION / PET_MOODS 能同时找到。

(function (root) {
  'use strict';

  var VERSION = 1;
  /** 必须与 src/runtime/pet/spec.mjs 的 PET_PROTOCOL_VERSION 一致 */
  var PET_PROTOCOL_VERSION = 1;
  /** 必须与 src/runtime/pet/mood.mjs 的 PET_MOODS 一致 */
  var MOODS = ['idle', 'thinking', 'working', 'waiting', 'done', 'error'];
  /** 会开口说话的情绪（其余只是动作变化） */
  var ANNOUNCED = { waiting: true, done: true, error: true };

  /** 窗口内摆放的位置：按每个轴的自由空间取比例，0 / 1 就是贴边的两端 */
  var PREF_KEY = 'zcode-expand:pet:v1';
  /** 让开 ZCode 的标题栏与窗口按钮 */
  var TOP_MARGIN = 32;

  var BUBBLE_MS = 5000;
  /** 超过这个位移才算拖拽，否则算点击（点击让 ta 说话） */
  var DRAG_THRESHOLD = 5;
  /** alpha 小于等于这个值就当作透明，鼠标穿过去 */
  var ALPHA_HIT = 10;
  /** 命中掩码的分辨率（越小越省，152 足够分辨角色轮廓） */
  var MASK_SIZE = 152;
  /** 角色图占盒子边长的比例：不是 1 是因为盒子要留出头顶气泡与描边的空间 */
  var FIGURE_RATIO = 0.5945;
  /** 气泡的 viewBox：所有气泡内文字尺寸都以它为单位（--u = 盒子边长 / 这个宽度） */
  var BUBBLE_VIEW_W = 1026;
  var BUBBLE_VIEW_H = 700;

  var doc = root.document;

  // ---- 台词 ----------------------------------------------------------------

  /** "A" 常规字号、会换行；"B" 大字、单行 */
  function pickOne(lines, random) {
    return lines[Math.floor(random() * lines.length)] || lines[0];
  }

  // 台词是**本模块自己写的**：参考实现的随机台词来自第三方组件（zcode-fox-widget）的
  // 台词包，不随本仓库分发。三组按权重抽，groups 里的 weight 就是权重。
  var GROUPS = [
    { weight: 7, size: 'B', lines: ['在呢', '收到', '来了来了'] },
    { weight: 10, size: 'A', lines: ['今天也要好好干活', '别一直盯着我看…', '需要我搭把手吗', '我先眯一会儿', '记得喝水'] },
    { weight: 4, size: 'A', lines: ['这次一定不返工', '改完记得跑一遍测试', '别熬夜了'] },
    { weight: 1, size: 'B', lines: ['哦…'] },
  ];

  function randomLine(random) {
    var roll = (random || Math.random)() * GROUPS.reduce(function (sum, group) { return sum + group.weight; }, 0);
    for (var i = 0; i < GROUPS.length; i++) {
      roll -= GROUPS[i].weight;
      if (roll < 0) return { text: pickOne(GROUPS[i].lines, random || Math.random), size: GROUPS[i].size };
    }
    return { text: GROUPS[0].lines[0], size: GROUPS[0].size };
  }

  var MOOD_LINES = {
    waiting: ['该你了', '有个问题要问你', '等你点确认'],
    done: ['搞定啦', '做完了', '收工'],
    error: ['出错了…', '这个没跑通', '失败了，来看看'],
  };

  function moodLine(mood, random) {
    var lines = MOOD_LINES[mood];
    return lines ? { text: pickOne(lines, random || Math.random), size: 'A' } : null;
  }

  // ---- 载荷解码 -------------------------------------------------------------

  function isFinite_(n) {
    return typeof n === 'number' && isFinite(n);
  }

  function clamp(n, min, max, fallback) {
    return isFinite_(n) ? Math.min(max, Math.max(min, n)) : fallback;
  }

  /**
   * 解主进程推来的载荷。版本不符、形状不对一律 null（宁可不显示，也不要误解一个半懂的载荷）。
   * 版本号与字段见 src/runtime/pet/spec.mjs 的 encodePet / decodePet。
   */
  function decodePet(payload) {
    if (!payload || typeof payload !== 'object') return null;
    if (payload.v !== PET_PROTOCOL_VERSION) return null;
    if (MOODS.indexOf(payload.mood) === -1) return null;
    var pet = payload.pet;
    var assets = payload.assets;
    if (!pet || typeof pet !== 'object' || !assets || typeof assets !== 'object') return null;
    if (typeof assets.image !== 'string') return null;
    return {
      pet: {
        // 没有图（用户还没放素材时主进程就是这么发的）＝ 桌宠整体关闭，不去显示一个破图
        enabled: pet.enabled === true && assets.image !== '',
        scale: clamp(pet.scale, 0.6, 2.5, 1.5),
        volume: clamp(pet.volume, 0, 1, 0.9),
        sound: typeof pet.sound === 'string' ? pet.sound : 'duck',
        bubble: pet.bubble !== false,
        desktop: pet.desktop === true,
      },
      mood: payload.mood,
      assets: assets,
    };
  }

  // ---- 显示层 ---------------------------------------------------------------

  // 盒子按边长 --u * BUBBLE_VIEW_W 缩放：所有尺寸都写成 --u 的倍数，换大小不用改样式。
  // --fill / --ink 是气泡与徽章的取色，随深浅主题变（host 上的 data-theme）。
  var STYLE = [
    ':host{all:initial}',
    '.pet{position:fixed;left:0;top:0;pointer-events:none;user-select:none;-webkit-user-select:none;',
    'font-family:system-ui,"Microsoft YaHei","PingFang SC",sans-serif;--fill:#fff;--ink:#203170;--text:#536ba9;transition:transform .3s ease}',
    ':host([data-theme=dark]) .pet{--fill:#2b2b2b;--ink:#d4d4d4;--text:#d4d4d4}',
    '.pet[hidden]{display:none}',
    // 贴左边时整体镜像，于是她面朝屏幕里面
    '.pet.left{transform:scaleX(-1)}',
    '.body{position:absolute;inset:0;transform-origin:50% 100%;transition:transform .22s cubic-bezier(.34,1.56,.64,1)}',
    '.body.pressed{transform:scaleY(.88) scaleX(1.05)}',
    '.figure{position:absolute;right:0;bottom:0;width:' + (FIGURE_RATIO * 100).toFixed(2) + '%;height:' + (FIGURE_RATIO * 100).toFixed(2) + '%;transform-origin:50% 100%;pointer-events:none;cursor:grab}',
    '.figure.dragging{cursor:grabbing}',
    '.char{display:block;width:100%;height:100%;pointer-events:none;-webkit-user-drag:none;user-select:none}',
    '.badge{position:absolute;left:2%;top:6%;width:calc(var(--u) * 118);height:calc(var(--u) * 118);border-radius:50%;display:grid;place-items:center;',
    'font-weight:800;font-size:calc(var(--u) * 78);line-height:1;color:#fff;border:calc(var(--u) * 9) solid var(--fill);box-sizing:border-box;',
    'opacity:0;transform:scale(.4);transition:opacity .2s ease,transform .25s cubic-bezier(.34,1.56,.64,1);pointer-events:none}',
    '.pet.left .badge{transform:scale(.4) scaleX(-1)}',
    '.pet[data-mood=thinking] .badge{background:#7d90c2}.pet[data-mood=thinking] .badge:after{content:"···";letter-spacing:-.08em}',
    '.pet[data-mood=waiting] .badge{background:#ff8a00}.pet[data-mood=waiting] .badge:after{content:"!"}',
    '.pet[data-mood=done] .badge{background:#f5b400}.pet[data-mood=done] .badge:after{content:"★"}',
    '.pet[data-mood=error] .badge{background:#4aa3ff}.pet[data-mood=error] .badge:after{content:"💧";font-size:calc(var(--u) * 60)}',
    '.pet:is([data-mood=thinking],[data-mood=waiting],[data-mood=done],[data-mood=error]):not(.talking) .badge{opacity:1;transform:none}',
    '.pet.left:is([data-mood=thinking],[data-mood=waiting],[data-mood=done],[data-mood=error]):not(.talking) .badge{transform:scaleX(-1)}',
    // 动作：每个情绪一套，尽量只用 transform，免得触发布局
    '.pet[data-mood=idle] .figure{animation:breathe 3.2s ease-in-out infinite}',
    '.pet[data-mood=thinking] .figure{animation:tilt 2.4s ease-in-out infinite}',
    '.pet[data-mood=working] .figure{animation:bob .5s ease-in-out infinite}',
    '.pet[data-mood=waiting] .figure{animation:hop .9s cubic-bezier(.3,0,.4,1) infinite}',
    '.pet[data-mood=done] .figure{animation:cheer .7s cubic-bezier(.34,1.56,.64,1) 2,breathe 3.2s ease-in-out 1.4s infinite}',
    '.pet[data-mood=error] .figure{animation:shake .5s ease-in-out,droop .4s ease-out .5s forwards}',
    '@keyframes breathe{0%,100%{transform:none}50%{transform:scaleY(1.025)}}',
    '@keyframes tilt{0%,100%{transform:rotate(-3deg)}50%{transform:rotate(3deg)}}',
    '@keyframes bob{0%,100%{transform:none}50%{transform:translateY(-3%)}}',
    '@keyframes hop{0%,100%{transform:none}35%{transform:translateY(-9%)}55%{transform:scale(1.04,.96)}}',
    '@keyframes cheer{0%,100%{transform:none}40%{transform:translateY(-14%) scale(.97,1.03)}70%{transform:scale(1.05,.95)}}',
    '@keyframes shake{0%,100%{transform:none}20%,60%{transform:translateX(-4%)}40%,80%{transform:translateX(4%)}}',
    '@keyframes droop{to{transform:translateY(4%) scale(1.02,.96);filter:saturate(.7)}}',
    '@media (prefers-reduced-motion:reduce){.pet .figure{animation:none!important}.body,.badge,.pet{transition:none}}',
    // 气泡：一个椭圆加一条尾巴，气泡内文字用 --u 定字号
    '.bubble{position:absolute;left:0;top:0;width:100%;aspect-ratio:' + BUBBLE_VIEW_W + '/' + BUBBLE_VIEW_H + ';pointer-events:none}',
    '.bubble svg{display:block;width:100%;height:100%;pointer-events:none}',
    '.bubble svg :is(path,ellipse){fill:var(--fill);stroke:var(--ink);pointer-events:none;cursor:pointer;opacity:0;transform:scale(.7);transform-box:fill-box;transform-origin:50% 50%;transition:opacity .2s ease,transform .2s ease}',
    '.bubble .b2{transition-delay:.3s}.bubble .b1{transition-delay:.2s}.bubble .shape{transition-delay:.1s}',
    '.bubble.open svg :is(path,ellipse){opacity:1;transform:none;pointer-events:visiblePainted}',
    '.bubble.open .b2{transition-delay:0s}.bubble.open .b1{transition-delay:.13s}.bubble.open .shape{transition-delay:.26s}',
    '.text{position:absolute;left:44.25%;top:38%;transform:translate(-50%,-50%);pointer-events:none;opacity:0;transition:opacity .16s ease}',
    '.pet.left .text{transform:translate(-50%,-50%) scaleX(-1)}',
    '.bubble.open .text{opacity:1;transition:opacity .16s ease .36s}',
    '.text{text-align:center;color:var(--text);line-height:1.15;white-space:nowrap}',
    '.text.a{font-size:calc(var(--u) * 66);font-weight:600;letter-spacing:.06em;white-space:normal;width:max-content;max-width:calc(var(--u) * 560);line-height:1.2}',
    '.text.b{font-size:calc(var(--u) * 128);font-weight:800;line-height:1.05}',
    '.text[hidden]{display:none}',
  ].join('');

  // 气泡形状：一个大椭圆（用两段圆弧拼）+ 尾巴 + 两个小气泡。纯几何图形，
  // 没有外部素材；改气泡长相就改这几个数（坐标系是 BUBBLE_VIEW_W × BUBBLE_VIEW_H）。
  var BUBBLE_MARKUP =
    '<svg viewBox="0 0 ' + BUBBLE_VIEW_W + ' ' + BUBBLE_VIEW_H + '" preserveAspectRatio="xMidYMid meet" aria-hidden="true">' +
    '<path class="shape" stroke-width="18" stroke-linejoin="round" stroke-linecap="round" ' +
    'd="M 856 300 A 356 232 0 1 0 144 302 A 356 232 0 0 0 330 468 A 58 33 12 0 0 438 490 A 356 232 0 0 0 856 300 Z"/>' +
    '<ellipse class="b1" cx="348" cy="558" rx="37" ry="26" stroke-width="18"/>' +
    '<ellipse class="b2" cx="438" cy="644" rx="24" ry="18" stroke-width="18"/></svg>';

  /**
   * 显示层。host 由摆放方插进文档；这里只管长相与交互，不管位置算法。
   *
   * @param {HTMLElement} host
   * @param {{start: Function, move: Function, drop: Function}} drag
   *        start() 拖拽开始；move(dx, dy) 每次移动（dx/dy 是相对按下的位移，页面 px）；
   *        drop() 松手。按一下没动 = 点击，由显示层自己处理（说话）。
   * @param {Function} log
   */
  function createDisplay(host, drag, log) {
    function report(where) {
      return function (error) {
        log('pet ' + where + ': ' + String(error));
      };
    }
    function guard(where, action) {
      return function () {
        try {
          return action.apply(null, arguments);
        } catch (error) {
          report(where)(error);
          return undefined;
        }
      };
    }

    var shadow = host.attachShadow({ mode: 'closed' });
    var sheet = doc.createElement('style');
    sheet.textContent = STYLE;
    var pet = doc.createElement('div');
    pet.className = 'pet';
    pet.dataset.mood = 'idle';
    pet.hidden = true;
    // 常量模板，只有字面量；任何数据都只经 textContent 进去
    pet.innerHTML =
      '<div class="body"><div class="figure"><img class="char" alt="" draggable="false"><span class="badge"></span></div></div>' +
      '<div class="bubble">' + BUBBLE_MARKUP + '<div class="text" hidden></div></div>';
    shadow.append(sheet, pet);

    function q(selector) {
      return pet.querySelector(selector);
    }
    var body = q('.body');
    var figure = q('.figure');
    var char = q('.char');
    var bubble = q('.bubble');
    var text = q('.text');
    var press = new Audio();
    var release = new Audio();

    var view = null;
    var flipped = false;
    /** 角色图的 alpha 掩码（MASK_SIZE × MASK_SIZE）；读不到就是 null = 整块可点 */
    var mask = null;
    var maskFor = '';
    /**
     * 掩码的图源。默认用载荷里的 file:// 图，但 **file:// 的图会让 canvas 变脏**
     * （getImageData 直接抛 SecurityError，Chromium 实测），于是透明处会挡住鼠标。
     * 主进程可以另推一张内联 data: URL（见 src/runtime/pet/service.mjs 的 petMaskExpression），
     * data: 继承文档源、不会被判跨源，掩码就能建起来；没推就是整块可点这个退路。
     */
    var maskUrl = '';
    var pointer = null;
    var bubbleTimer = null;
    var bubbleFrom = null;
    var releaseTimer = null;
    var listeners = [];

    /** 给角色图做一张降采样的 alpha 掩码，用来判断"点在不在她身上" */
    function buildMask(url) {
      if (!url || maskFor === url) return;
      maskFor = url;
      mask = null;
      var image = new Image();
      image.decoding = 'async';
      image.onload = guard('mask', function () {
        var canvas = doc.createElement('canvas');
        canvas.width = canvas.height = MASK_SIZE;
        var context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context || maskFor !== url) return;
        context.drawImage(image, 0, 0, MASK_SIZE, MASK_SIZE);
        var pixels = context.getImageData(0, 0, MASK_SIZE, MASK_SIZE).data;
        var alpha = new Uint8Array(MASK_SIZE * MASK_SIZE);
        for (var i = 0; i < alpha.length; i++) alpha[i] = pixels[i * 4 + 3];
        mask = alpha;
        image.removeAttribute('src');
      });
      image.src = url;
    }

    /** 视口坐标点是否落在角色图的不透明像素上 */
    function hits(x, y) {
      if (pet.hidden) return false;
      var rect = char.getBoundingClientRect();
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom || !rect.width || !rect.height) return false;
      if (!mask) return true;
      var u = (x - rect.left) / rect.width;
      if (flipped) u = 1 - u;
      var v = (y - rect.top) / rect.height;
      var column = Math.min(MASK_SIZE - 1, Math.floor(u * MASK_SIZE));
      var row = Math.min(MASK_SIZE - 1, Math.floor(v * MASK_SIZE));
      return mask[row * MASK_SIZE + column] > ALPHA_HIT;
    }

    /** 是否有一张打开的气泡压在这个视口点上 */
    function hitsBubble(x, y) {
      if (pet.hidden || !bubble.classList.contains('open')) return false;
      var target = shadow.elementFromPoint(x, y);
      return !!target && bubble.contains(target);
    }

    function play(audio, url) {
      if (!view || view.pet.volume <= 0 || !url) return; // 没有这一档音效就安静着
      audio.volume = view.pet.volume;
      audio.currentTime = 0;
      // 自动播放被拦、设备没了都无所谓：不要声音也正常
      var played = audio.play();
      if (played && played.catch) played.catch(function () {});
    }
    function pressDown() {
      body.classList.add('pressed');
      clearTimeout(releaseTimer);
      play(press, currentSound().press);
    }
    /** 短按：松开音在按下音结束前 100ms 起；长按：立刻起 */
    function pressUp() {
      body.classList.remove('pressed');
      var sound = currentSound();
      var remaining = (press.duration - press.currentTime) * 1000;
      if (!press.paused && !press.ended && isFinite_(remaining)) {
        releaseTimer = setTimeout(function () { play(release, sound.release); }, Math.max(0, remaining - 100));
      } else {
        play(release, sound.release);
      }
    }
    function currentSound() {
      if (!view || !view.assets.sounds) return { press: '', release: '' };
      return view.assets.sounds[view.pet.sound] || { press: '', release: '' };
    }

    function hideBubble() {
      clearTimeout(bubbleTimer);
      bubble.classList.remove('open');
      pet.classList.remove('talking');
      bubbleFrom = null;
    }
    function showBubble(line, from) {
      if (!view || !view.pet.bubble) return;
      text.textContent = line.text;
      text.className = 'text ' + (line.size === 'A' ? 'a' : 'b');
      text.hidden = false;
      bubble.classList.add('open');
      pet.classList.add('talking');
      bubbleFrom = from;
      clearTimeout(bubbleTimer);
      bubbleTimer = setTimeout(guard('bubble', hideBubble), BUBBLE_MS);
    }

    function on(target, name, action, options) {
      var listener = guard(name, action);
      target.addEventListener(name, listener, options);
      listeners.push(function () { target.removeEventListener(name, listener, options); });
    }

    /** 只有角色图的不透明像素才接管指针（透明处让鼠标穿过去） */
    function track(x, y) {
      if (!pointer) figure.style.pointerEvents = hits(x, y) ? 'auto' : 'none';
    }
    on(
      root,
      'pointermove',
      function (event) {
        track(event.clientX, event.clientY);
      },
      { capture: true, passive: true },
    );
    on(figure, 'pointerdown', function (event) {
      if (event.button !== 0) return;
      event.preventDefault();
      pointer = { x: event.clientX, y: event.clientY, moved: false, id: event.pointerId };
      pressDown();
      try {
        figure.setPointerCapture(event.pointerId);
      } catch (error) {
        // 合成事件、或指针已经松开：框内拖拽照常能用
      }
    });
    on(figure, 'pointermove', function (event) {
      if (!pointer || event.pointerId !== pointer.id) return;
      var dx = event.clientX - pointer.x;
      var dy = event.clientY - pointer.y;
      if (!pointer.moved && Math.hypot(dx, dy) <= DRAG_THRESHOLD) return;
      if (!pointer.moved) {
        pointer.moved = true;
        figure.classList.add('dragging');
        drag.start();
      }
      drag.move(dx, dy);
    });
    var end = function (event) {
      if (!pointer || event.pointerId !== pointer.id) return;
      var moved = pointer.moved;
      pointer = null;
      figure.classList.remove('dragging');
      pressUp();
      if (moved) drag.drop();
      else if (event.type === 'pointerup') showBubble(randomLine(), 'click');
    };
    on(figure, 'pointerup', end);
    on(figure, 'pointercancel', end);
    on(bubble, 'click', hideBubble);

    function update(next) {
      var previous = view;
      view = next;
      if (!next.pet.enabled) {
        hideBubble();
        pet.hidden = true;
        return false;
      }
      pet.hidden = false;
      if (char.getAttribute('src') !== next.assets.image) char.src = next.assets.image;
      // 有内联图就用它建掩码（file:// 的图建不了，见 maskUrl 的注释）
      buildMask(maskUrl || next.assets.image);
      var sound = currentSound();
      if (press.getAttribute('src') !== sound.press) {
        if (sound.press) press.setAttribute('src', sound.press);
        else press.removeAttribute('src');
      }
      if (release.getAttribute('src') !== sound.release) {
        if (sound.release) release.setAttribute('src', sound.release);
        else release.removeAttribute('src');
      }
      pet.dataset.mood = next.mood;
      if (!next.pet.bubble) hideBubble();
      if (!previous || previous.mood === next.mood || !previous.pet.enabled) return true;
      // 已经过时的通知（比如问题已经被答复了）跟着一起收掉
      if (bubbleFrom !== null && bubbleFrom !== 'click' && bubbleFrom !== next.mood) hideBubble();
      // 用户点出来的气泡不打断
      if (ANNOUNCED[next.mood] && bubbleFrom !== 'click') {
        var line = moodLine(next.mood);
        if (line) showBubble(line, next.mood);
      }
      return true;
    }

    return {
      update: function (next) {
        try {
          return update(next);
        } catch (error) {
          report('update')(error);
          return false;
        }
      },
      /** 摆放：盒子边长 base，左上角在 (left, top)，视口坐标 */
      place: guard('place', function (left, top, base) {
        var s = pet.style;
        s.width = s.height = base + 'px';
        s.left = left + 'px';
        s.top = top + 'px';
        s.setProperty('--u', base / BUBBLE_VIEW_W + 'px');
      }),
      face: guard('face', function (left) {
        flipped = left;
        pet.classList.toggle('left', left);
      }),
      hits: function (x, y) {
        try {
          return hits(x, y);
        } catch (error) {
          return false;
        }
      },
      hitsBubble: function (x, y) {
        try {
          return hitsBubble(x, y);
        } catch (error) {
          return false;
        }
      },
      track: guard('track', track),
      /**
       * 换成用这张图建掩码（主进程推来的内联 data: URL）；传空串就退回载荷里的图。
       * 掩码源变了要立刻重建一次：view 已经在的时候顺手就把掩码补上。
       */
      mask: guard('mask', function (url) {
        maskUrl = typeof url === 'string' ? url : '';
        maskFor = '';
        if (view) buildMask(maskUrl || view.assets.image);
      }),
      maskSource: function () {
        return maskUrl ? 'inline' : 'file';
      },
      figureRect: function () {
        return char.getBoundingClientRect();
      },
      dragging: function () {
        return !!pointer && pointer.moved === true;
      },
      dispose: guard('dispose', function () {
        clearTimeout(bubbleTimer);
        clearTimeout(releaseTimer);
        for (var i = 0; i < listeners.length; i++) listeners[i]();
        listeners = [];
        host.remove();
      }),
    };
  }

  // ---- 摆放一：窗口内 -------------------------------------------------------

  /** 每个轴各自吸附：盒子中心落在窗口外侧四分之一时贴那条边，可以组合成四个角 */
  function snapPosition(left, top, base, width, height, topMargin) {
    function free(span) {
      return Math.max(0, span - base);
    }
    function fraction(offset, span) {
      return free(span) ? Math.min(1, Math.max(0, offset / free(span))) : 1;
    }
    function axis(offset, span, center) {
      if (center < span / 4) return 0;
      if (center > (span * 3) / 4) return 1;
      return fraction(offset, span);
    }
    return {
      x: axis(left, width, left + base / 2),
      // 顶部 32px 是让给标题栏的，吸附范围从那里往下算
      y: axis(top - topMargin, height - topMargin, top - topMargin + base / 2),
    };
  }

  function readPosition(raw) {
    try {
      var saved = JSON.parse(raw || 'null');
      function valid(n) {
        return typeof n === 'number' && isFinite(n) && n >= 0 && n <= 1;
      }
      return saved && valid(saved.x) && valid(saved.y) ? { x: saved.x, y: saved.y } : { x: 1, y: 1 };
    } catch (error) {
      return { x: 1, y: 1 };
    }
  }

  function mountInWindow(log) {
    var position = readPosition(safeGet());
    var view = null;
    var display = null;
    /** 内联掩码图，早于 display 建好时先记在这里 */
    var pendingMask = '';
    var box = { left: 0, top: 0, base: 0 };
    var from = { left: 0, top: 0 };
    var removers = [];

    function safeGet() {
      try {
        return root.localStorage.getItem(PREF_KEY);
      } catch (error) {
        return null;
      }
    }
    function savePosition() {
      try {
        root.localStorage.setItem(PREF_KEY, JSON.stringify(position));
      } catch (error) {
        log('pet position: ' + String(error));
      }
    }

    function layout() {
      if (!display || !view) return;
      var width = root.innerWidth;
      var height = root.innerHeight;
      var base = petBaseJs(width, height, view.pet.scale);
      var left = Math.max(0, width - base) * position.x;
      var top = TOP_MARGIN + Math.max(0, height - TOP_MARGIN - base) * position.y;
      box = { left: left, top: top, base: base };
      display.place(left, top, base);
      display.face(position.x === 0);
    }

    function build() {
      var host = doc.createElement('zcode-expand-pet');
      // 在皮肤面板（2147483000）与备注 / 账号浮层（2147483646）之下，在 ZCode 自己的层之上
      host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147482000;';
      doc.documentElement.append(host);
      var built = createDisplay(
        host,
        {
          start: function () {
            from = { left: box.left, top: box.top };
          },
          move: function (dx, dy) {
            var width = root.innerWidth;
            var height = root.innerHeight;
            var left = Math.min(Math.max(0, width - box.base), Math.max(0, from.left + dx));
            var top = Math.min(Math.max(TOP_MARGIN, height - box.base), Math.max(TOP_MARGIN, from.top + dy));
            built.place(left, top, box.base);
            box = { left: left, top: top, base: box.base };
          },
          drop: function () {
            position = snapPosition(box.left, box.top, box.base, root.innerWidth, root.innerHeight, TOP_MARGIN);
            savePosition();
            layout();
          },
        },
        log,
      );
      // 主进程的内联掩码图可能比这里先到，建好 DOM 之后补上
      if (pendingMask) built.mask(pendingMask);
      function on(name, action) {
        var listener = function (event) {
          try {
            action(event);
          } catch (error) {
            log('pet ' + name + ': ' + String(error));
          }
        };
        root.addEventListener(name, listener);
        removers.push(function () {
          root.removeEventListener(name, listener);
        });
      }
      on('resize', layout);
      on('storage', function (event) {
        if (event.key !== PREF_KEY) return;
        position = readPosition(event.newValue);
        layout();
      });
      on('pagehide', function () {
        for (var i = 0; i < removers.length; i++) removers[i]();
        removers = [];
        if (display) display.dispose();
        display = null;
      });
      return built;
    }

    // 主题：ZCode 把深浅挂在根元素的 .dark 上（跟 zc-skin-colors.js 的 :root.dark 同一套）
    function theme() {
      return doc.documentElement && doc.documentElement.classList.contains('dark') ? 'dark' : 'light';
    }
    try {
      var observer = new MutationObserver(function () {
        var host = doc.querySelector('zcode-expand-pet');
        if (host) host.setAttribute('data-theme', theme());
      });
      observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['class'] });
    } catch (error) {
      log('pet theme: ' + String(error));
    }

    return {
      /** @param {{pet: object, mood: string, assets: object}} next */
      update: function (next) {
        try {
          view = next;
          // 桌面模式下只有一只，住在那个小窗里；窗口内这只按"关掉"处理
          var here = next.pet.enabled && !next.pet.desktop;
          if (!here && !display) return;
          if (!display) {
            display = build();
            var host = doc.querySelector('zcode-expand-pet');
            if (host) host.setAttribute('data-theme', theme());
          }
          var forDisplay = here ? next : { pet: Object.assign({}, next.pet, { enabled: false }), mood: next.mood, assets: next.assets };
          if (display.update(forDisplay)) layout();
        } catch (error) {
          log('pet update: ' + String(error));
        }
      },
      dispose: function () {
        try {
          if (display) display.dispose();
        } catch (error) {
          log('pet dispose: ' + String(error));
        }
      },
      mask: function (url) {
        // 还没建 DOM 也先记着：build() 之后 update() 会用它
        pendingMask = url;
        try {
          if (display) display.mask(url);
        } catch (error) {
          log('pet mask: ' + String(error));
        }
      },
      state: function () {
        return { position: position, box: box, maskSource: display ? display.maskSource() : 'none' };
      },
    };
  }

  /** 与 src/runtime/pet/spec.mjs 的 petBase 同值（那份在主进程用，这份在渲染层用） */
  function petBaseJs(width, height, scale) {
    return Math.min(625, Math.max(122, Math.min(250, Math.min(width, height) * 0.28) * scale));
  }

  // ---- 摆放二：桌面模式页 ---------------------------------------------------

  function mountInPage(api, log) {
    var display = null;
    var facing = false;
    var last = { x: -1, y: -1 };
    /** 内联掩码图，早于 display 建好时先记在这里 */
    var pendingMask = '';

    function layout() {
      if (!display) return;
      display.place(0, 0, Math.min(root.innerWidth, root.innerHeight));
      display.face(facing);
      report();
    }
    function report() {
      if (!display) return;
      var body = display.figureRect();
      api.pointer({
        hit: display.hits(last.x, last.y) || display.hitsBubble(last.x, last.y),
        x: last.x,
        y: last.y,
        body: { x: body.left, y: body.top, width: body.width, height: body.height },
      });
    }

    var host = doc.createElement('zcode-expand-pet');
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;';
    (doc.body || doc.documentElement).append(host);
    display = createDisplay(
      host,
      {
        start: function () {
          api.drag('start');
        },
        // 拖起来之后窗口跟着真实光标走，页面报的位移不再有意义
        move: function () {
          api.drag('move');
        },
        drop: function () {
          api.drag('end');
        },
      },
      log,
    );
    if (pendingMask) display.mask(pendingMask);

    // 主题：桌面小窗没有 ZCode 的 .dark，用系统深浅
    function theme() {
      var dark = false;
      try {
        dark = root.matchMedia('(prefers-color-scheme: dark)').matches;
      } catch (error) {
        dark = false;
      }
      host.setAttribute('data-theme', dark ? 'dark' : 'light');
    }
    theme();
    try {
      var media = root.matchMedia('(prefers-color-scheme: dark)');
      if (media.addEventListener) media.addEventListener('change', theme);
    } catch (error) {
      log('pet theme: ' + String(error));
    }

    api.onFacing(function (left) {
      try {
        facing = left;
        layout();
      } catch (error) {
        log('pet facing: ' + String(error));
      }
    });
    // 主进程在没有 mousemove 报告时问一下光标那个点（见 src/runtime/pet/pointer.mjs）
    api.onProbe(function (x, y) {
      try {
        if (display.dragging()) return;
        last = { x: x, y: y };
        display.track(x, y);
        report();
      } catch (error) {
        log('pet probe: ' + String(error));
      }
    });
    root.addEventListener('resize', function () {
      try {
        layout();
      } catch (error) {
        log('pet resize: ' + String(error));
      }
    });
    // 光标靠近时（forwarding 开着）或落在图上时（窗口接管了指针）都会来 mousemove，
    // 每次都报，于是判决描述的永远是光标当下的位置
    root.addEventListener(
      'mousemove',
      function (event) {
        try {
          if (display.dragging()) return;
          last = { x: event.clientX, y: event.clientY };
          report();
        } catch (error) {
          log('pet pointer: ' + String(error));
        }
      },
      { passive: true },
    );

    return {
      update: function (next) {
        if (display.update(next)) layout();
      },
      dispose: function () {
        display.dispose();
      },
      mask: function (url) {
        pendingMask = url;
        try {
          display.mask(url);
        } catch (error) {
          log('pet mask: ' + String(error));
        }
      },
      state: function () {
        return { facing: facing, last: last, maskSource: display.maskSource() };
      },
    };
  }

  // ---- 全局句柄 -------------------------------------------------------------

  var errors = [];
  function log(message) {
    try {
      console.warn('[zcode-expand] ' + message);
    } catch (error) {
      // 控制台都没了就没什么可做的
    }
    errors.push({ at: Date.now(), message: String(message) });
    if (errors.length > 12) errors.shift();
  }

  var mode = root.__ZC_PET_PAGE__ ? 'desktop-page' : 'window';
  var mounted = null;
  var latest = null;
  var lastPushAt = 0;
  var pushes = 0;
  /** 掩码图比 mount 先到时先存着（boot 之后再补进去） */
  var pendingImageUrl = '';
  var maskReceivedAt = 0;

  function boot() {
    try {
      mounted = mode === 'desktop-page' ? mountInPage(root.__ZC_PET_PAGE__, log) : mountInWindow(log);
      if (pendingImageUrl) mounted.mask(pendingImageUrl);
      if (latest) mounted.update(latest);
      console.log('[ZCode-Expand] 桌宠模块已注入 v' + VERSION + '（' + mode + '），自检：__ZC_PET__.diag()');
    } catch (error) {
      // 桌宠永远不能影响 ZCode 自己的页面
      log('pet boot: ' + String(error));
      console.error('[zcode-expand] 桌宠启动失败（已忽略）：', error);
    }
  }

  // 先把全局挂上再 boot：万一 boot 抛错，至少还能在控制台拿到句柄排查
  root.__ZC_PET__ = {
    push: function (payload) {
      try {
        lastPushAt = Date.now();
        pushes++;
        var view = decodePet(payload);
        if (!view) {
          log('pet: 不认识的载荷（版本 ' + (payload && payload.v) + '），已忽略');
          return false;
        }
        latest = view;
        if (mounted) mounted.update(view);
        return true;
      } catch (error) {
        log('pet push: ' + String(error));
        return false;
      }
    },
    /**
     * 主进程另推的掩码图（内联 data: URL），见 src/runtime/pet/service.mjs 的 petMaskExpression。
     * 每个窗口加载后推一次就够；没推就是"整块矩形可点"这个退路。
     */
    image: function (url) {
      try {
        maskReceivedAt = Date.now();
        if (mounted) mounted.mask(typeof url === 'string' ? url : '');
        else pendingImageUrl = typeof url === 'string' ? url : '';
        return true;
      } catch (error) {
        log('pet image: ' + String(error));
        return false;
      }
    },
    diag: function () {
      return {
        version: VERSION,
        protocol: PET_PROTOCOL_VERSION,
        mode: mode,
        pushes: pushes,
        lastPushAt: lastPushAt,
        mood: latest ? latest.mood : null,
        enabled: latest ? latest.pet.enabled : false,
        desktop: latest ? latest.pet.desktop : false,
        image: latest ? latest.assets.image : null,
        maskAt: maskReceivedAt,
        state: mounted ? mounted.state() : null,
        errors: errors.slice(-5),
      };
    },
    errors: function () {
      return errors.slice();
    },
  };

  boot();
})(typeof window !== 'undefined' ? window : globalThis);
