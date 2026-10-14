/* ZCode-Expand · 外观中心面板
 * ---------------------------------------------------------------------------
 * 由 preload 注入主世界（见 runtime/preload.cjs）。纯 DOM 浮层，带 data-zc-expand-root 标记，
 * 整体移除时一个选择器清干净；不往 React 树里插任何东西。
 *
 * 与主进程的通道：window.__ZC_EXPAND_IPC__（preload 用 contextBridge 暴露）。
 * 所有请求都发到主进程做**校验后**才落盘——面板自己不直接写文件。
 *
 * 交互模型（照参考实现 zcode-canvas 的 overlay）：改动即应用（写配置 → 主进程重算 → 推回 CSS），
 * 主题色卡悬停出预览、移开还原。所以这里不需要"确定/取消"。
 * ---------------------------------------------------------------------------
 */
(function () {
  'use strict';

  var IPC = window.__ZC_EXPAND_IPC__;
  if (!IPC) {
    console.error('[zc-expand] 缺少 __ZC_EXPAND_IPC__，外观面板未启动');
    return;
  }
  if (window.__ZC_EXPAND_PANEL__) return; // 幂等：注入两次也只挂一个

  var ROOT_ATTR = 'data-zc-expand-root';
  var STYLE_ID = 'zcode-expand-panel-style';
  var PANEL_ID = 'zcode-expand-panel';
  var LAUNCHER_ID = 'zcode-expand-launcher';
  var STATUS_ID = 'zcode-expand-status';
  var data = null;
  var rootNode = null;

  function log(message) {
    try { IPC.log(message); } catch (e) { /* 仅日志 */ }
  }
  function safe(promise) {
    return promise && promise.catch ? promise.catch(function (error) {
      log('面板请求失败: ' + String(error && error.message ? error.message : error));
      return null;
    }) : promise;
  }
  /** 把 Electron 包过的 IPC 错误还原成人话：剥掉 "Error invoking remote method 'xxx': Error: " 前缀 */
  function reason(error) {
    var text = String(error && error.message ? error.message : error);
    var m = /remote method '[^']*':\s*(?:Error:\s*)?([\s\S]+)$/.exec(text);
    return m ? m[1] : text;
  }

  var CSS = [
    '#' + LAUNCHER_ID + '{position:fixed;right:18px;bottom:70px;width:38px;height:38px;border-radius:50%;',
    'border:1px solid rgba(255,255,255,.22);background:rgba(20,26,38,.55);backdrop-filter:blur(8px);',
    'color:#e2e8f0;font-size:17px;line-height:1;cursor:pointer;z-index:2147483000;',
    'display:flex;align-items:center;justify-content:center;transition:transform .15s ease}',
    '#' + LAUNCHER_ID + ':hover{transform:scale(1.08)}',
    '#' + PANEL_ID + '{position:fixed;right:18px;top:56px;bottom:118px;width:320px;border-radius:14px;overflow:hidden;',
    'border:1px solid rgba(255,255,255,.16);background:rgba(15,20,32,.94);backdrop-filter:blur(16px);',
    'color:#e2e8f0;font:12px/1.6 ui-sans-serif,system-ui,"Segoe UI","Microsoft YaHei",sans-serif;',
    'box-shadow:0 16px 40px rgba(0,0,0,.5);z-index:2147483000;display:none;flex-direction:column}',
    '#' + PANEL_ID + '.open{display:flex}',
    '#' + PANEL_ID + ' .hd{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;',
    'border-bottom:1px solid rgba(255,255,255,.1);flex:0 0 auto}',
    '#' + PANEL_ID + ' .hd b{font-size:13px}',
    '#' + PANEL_ID + ' .x{cursor:pointer;opacity:.6;padding:0 5px}',
    '#' + PANEL_ID + ' .x:hover{opacity:1}',
    '#' + PANEL_ID + ' .bd{overflow-y:auto;padding:12px 12px 16px;flex:1 1 auto}',
    // 纵向节奏统一在这里定义，组件自己不再各写各的间距：
    //   节与节 16 / 节标题下 8 / 控件行下 6 / 按钮行下 8 / 列表上下 8
    // 并且凡是"最后一个孩子"都不再留尾距，免得每个节底部都多出一截。
    '#' + PANEL_ID + ' .sec{margin-bottom:16px}',
    '#' + PANEL_ID + ' .sec:last-child{margin-bottom:0}',
    '#' + PANEL_ID + ' .sec>h4{font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.55;',
    'margin:0 0 8px;display:flex;justify-content:space-between;align-items:center}',
    '#' + PANEL_ID + ' .sec>h4 .rs{cursor:pointer;opacity:.6;font-size:11px;text-transform:none;letter-spacing:0}',
    '#' + PANEL_ID + ' .sec>h4 .rs:hover{opacity:1}',
    // 这一节没有个人覆盖时 ↺ 是空转，置灰且不响应悬停
    '#' + PANEL_ID + ' .sec>h4 .rs.off{opacity:.2;cursor:default}',
    '#' + PANEL_ID + ' .sec>h4 .rs.off:hover{opacity:.2}',
    '#' + PANEL_ID + ' .row{display:flex;align-items:center;gap:8px;margin-bottom:6px}',
    '#' + PANEL_ID + ' .row:last-child{margin-bottom:0}',
    '#' + PANEL_ID + ' .row>label{flex:0 0 104px;opacity:.75;font-size:11px;white-space:nowrap}',
    '#' + PANEL_ID + ' .row>input[type=range]{flex:1;min-width:0}',
    // 原生下拉的弹层由 Chromium 自己画：不声明 color-scheme 它会画成白底，
    // 而选项文字继承面板的浅色 → 浅字压白底看不清（2026-10-14 实测）。
    // color-scheme 管弹层底色，option 再兜一层。面板本身恒为深色，所以固定 dark 是对的。
    '#' + PANEL_ID + ' .row>select,#' + PANEL_ID + ' .row>input[type=text]{flex:1;min-width:0;background:rgba(255,255,255,.07);',
    'color:inherit;border:1px solid rgba(255,255,255,.16);border-radius:6px;padding:3px 6px;font:inherit;color-scheme:dark}',
    '#' + PANEL_ID + ' option{background:#0f1420;color:#e2e8f0}',
    '#' + PANEL_ID + ' .val{flex:0 0 38px;text-align:right;opacity:.6;font-variant-numeric:tabular-nums}',
    '#' + PANEL_ID + ' .themes{display:grid;grid-template-columns:repeat(auto-fill,minmax(88px,1fr));gap:6px;',
    'margin:0 0 8px}',
    '#' + PANEL_ID + ' .themes:last-child{margin-bottom:0}',
    '#' + PANEL_ID + ' .th{border:1px solid rgba(255,255,255,.14);border-radius:8px;overflow:hidden;cursor:pointer}',
    '#' + PANEL_ID + ' .th:hover{border-color:rgba(255,255,255,.4)}',
    '#' + PANEL_ID + ' .th.on{border-color:#60a5fa;box-shadow:0 0 0 1px #60a5fa inset}',
    '#' + PANEL_ID + ' .th .sw{height:26px;display:flex;align-items:flex-end;justify-content:flex-end;padding:3px}',
    '#' + PANEL_ID + ' .th .sw i{width:12px;height:12px;border-radius:50%;display:block;border:1px solid rgba(0,0,0,.3)}',
    '#' + PANEL_ID + ' .th .nm{padding:3px 5px;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#' + PANEL_ID + ' .btn{padding:4px 9px;border-radius:6px;cursor:pointer;text-align:center;',
    'border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);font-size:11px}',
    '#' + PANEL_ID + ' .btn:hover{background:rgba(255,255,255,.13)}',
    // 置灰：当前状态下这个动作不成立（例如内置主题不能原地保存），但仍然可点——点了会说明原因
    '#' + PANEL_ID + ' .btn.off{opacity:.4}',
    '#' + PANEL_ID + ' .btn.off:hover{background:rgba(255,255,255,.06)}',
    // 按钮行本来没有下边距，后面跟着控件行时就会贴死（2026-10-14 截图里的「清除调色板 / 强调色」）；
    // 最后一行的尾距照旧去掉。
    '#' + PANEL_ID + ' .btns{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}',
    '#' + PANEL_ID + ' .btns:last-child{margin-bottom:0}',
    // 两按钮开关：选中那个亮蓝边，和主题卡的选中态同一个色
    '#' + PANEL_ID + ' .sw2{display:flex;gap:6px;flex:1;min-width:0}',
    '#' + PANEL_ID + ' .sw2 .btn{flex:1;padding:3px 0}',
    '#' + PANEL_ID + ' .sw2 .btn.on{border-color:#60a5fa;background:rgba(96,165,250,.16)}',
    '#' + PANEL_ID + ' .note{margin-top:8px;font-size:11px;opacity:.75;word-break:break-all}',
    // 操作提示固定钉在面板底部。它是 flex 里不参与伸缩的一项（flex:0 0 auto），
    // 否则会被上面的滚动区挤扁、文字被面板的圆角裁掉。
    '#' + PANEL_ID + ' .msg{flex:0 0 auto;padding:0 12px 10px;font-size:11px;opacity:.75;min-height:15px;word-break:break-all}',
    '#' + PANEL_ID + ' .msg.err{color:#fca5a5}',
    '#' + PANEL_ID + ' .wp{display:flex;gap:4px;flex-wrap:wrap;margin:8px 0}',
    '#' + PANEL_ID + ' .wp:last-child{margin-bottom:0}',
    '#' + PANEL_ID + ' .wp .th2{position:relative;display:block;line-height:0;cursor:pointer}',
    '#' + PANEL_ID + ' .wp .box{width:34px;height:26px;border-radius:5px;display:block;object-fit:cover;',
    'background-size:cover;background-position:center;border:1px solid rgba(255,255,255,.2)}',
    '#' + PANEL_ID + ' .wp .th2.on .box{border-color:#60a5fa}',
    '#' + PANEL_ID + ' .wp .play{position:absolute;left:2px;bottom:1px;font-size:9px;color:#fff;',
    'text-shadow:0 1px 2px #000;pointer-events:none;font-weight:400}',
  ].join('\n');

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  /**
   * 操作提示。**必须按 id 取**，不能用 querySelector('.msg')——
   * 壁纸区里还有一个同类的行内提示，querySelector 拿到的是文档顺序里第一个，
   * 于是提示会跑到面板中间去，落在哪儿还要看当下有没有壁纸（2026-10-14 实测）。
   */
  function msg(text, isError) {
    var m = document.getElementById(STATUS_ID);
    if (!m) return;
    m.textContent = text || '';
    m.className = 'msg' + (isError ? ' err' : '');
  }

  // ---------------------------------------------------------------- 请求

  function apply(input, note) {
    return safe(IPC.panelApply(input)).then(function (res) {
      if (res && res.ok) { msg(note || ''); return refresh(); }
      msg('改动没生效', true);
      return null;
    });
  }

  /** 悬停预览：只算不写。回来后把 <style> 换成预览版。 */
  var previewTimer = null;
  function preview(input) {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(function () {
      safe(IPC.panelPreview(input)).then(function (res) {
        if (!res || typeof res.css !== 'string') return;
        var style = document.getElementById('zcode-expand-style');
        if (style) style.textContent = res.css;
      });
    }, 60);
  }

  /**
   * 撤销预览：拿**当前已提交配置**的 CSS 换回去。
   * 不能靠 refresh()——它现在有数据签名守卫，数据没变就不会重渲染，样式会一直停在预览版。
   */
  function restoreCss() {
    clearTimeout(previewTimer);
    safe(IPC.panelPreview({})).then(function (res) {
      if (!res || typeof res.css !== 'string') return;
      var style = document.getElementById('zcode-expand-style');
      if (style) style.textContent = res.css;
    });
  }

  // ---------------------------------------------------------------- 控件

  function slider(label, value, min, max, step, onInput, onDone) {
    var row = el('div', 'row');
    row.appendChild(el('label', null, label));
    var range = document.createElement('input');
    range.type = 'range';
    range.min = String(min); range.max = String(max); range.step = String(step);
    range.value = String(value);
    var out = el('span', 'val', String(Math.round(value * 100) / 100));
    range.addEventListener('input', function () {
      out.textContent = String(Math.round(Number(range.value) * 100) / 100);
      if (onInput) onInput(Number(range.value));
    });
    // 松手才落盘，避免拖动时写几百次配置
    range.addEventListener('change', function () { if (onDone) onDone(Number(range.value)); });
    row.appendChild(range);
    row.appendChild(out);
    return row;
  }

  function select(label, value, options, onChange) {
    var row = el('div', 'row');
    row.appendChild(el('label', null, label));
    var sel = document.createElement('select');
    options.forEach(function (opt) {
      var o = document.createElement('option');
      o.value = opt[0];
      o.textContent = opt[1];
      if (String(value) === String(opt[0])) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () { onChange(sel.value); });
    row.appendChild(sel);
    return row;
  }

  /**
   * 两个按钮组成的开关（对应参考实现的 mode-switch）。面板里的布尔项都用它——
   * 原生 checkbox 在这个深色面板里既难看清又和别的控件不同高。
   * 已经处于目标状态时点了不发请求，省一次写盘 + 重算。
   */
  function switchRow(label, on, onChange) {
    var row = el('div', 'row');
    row.appendChild(el('label', null, label));
    var box = el('div', 'sw2');
    [['关', false], ['开', true]].forEach(function (pair) {
      var btn = el('div', 'btn' + (on === pair[1] ? ' on' : ''), pair[0]);
      btn.addEventListener('click', function () { if (on !== pair[1]) onChange(pair[1]); });
      box.appendChild(btn);
    });
    row.appendChild(box);
    return row;
  }

  /**
   * 一节的外壳。第二个参数是**组名**（`unsetGroups` / `resettable` 的键），不是键数组——
   * 两个表都按同一个名字查，就不会再出现"面板自己写一份重置列表"那种两个来源的问题。
   * 各节要发哪些键由主进程给（`data.unsetGroups`），面板只消费。
   */
  function section(title, groupName) {
    var sec = el('div', 'sec');
    var hd = el('h4');
    hd.appendChild(el('span', null, title));
    var groups = (data && data.unsetGroups) || {};
    var keys = groupName ? groups[groupName] : null;
    if (keys && keys.length) {
      // 没有个人覆盖时 ↺ 是空转（还会白写一次 config、白重算一次外观），照主进程算的结果置灰
      var canReset = !data.resettable || data.resettable[groupName] !== false;
      var rs = el('span', 'rs' + (canReset ? '' : ' off'), '↺');
      rs.title = canReset ? '重置这一节' : '这一节还没有个人覆盖';
      if (canReset) rs.addEventListener('click', function () { apply({ unset: keys }, '已重置：' + title); });
      hd.appendChild(rs);
    }
    sec.appendChild(hd);
    return sec;
  }

  // ---------------------------------------------------------------- 渲染

  function render() {
    if (!data) return;
    var cfg = data.config || {};
    // 面板是两层模型：cfg 是**个人覆盖**（写入永远写这层），look 是**生效值**（主题 ⊕ 覆盖）。
    // 滑块 / 下拉必须显示 look —— 它们没法表达"未设置"，读 cfg 就只能拿硬编码默认值兜底，
    // 于是主题自带的值永远不出现在面板上（2026-10-14 实测：主题 glass.opacity=0.18，滑块显示 1，
    // 点一下 ↺ 画面整个透出来，参数却纹丝不动）。文本框相反：它靠"留空=主题的"表达未覆盖，
    // 所以只显示 cfg，把主题的值写进 placeholder。
    var look = data.effective || {};
    var effGlass = look.glass || {};
    var effRegions = effGlass.regions || {};
    var effStartup = look.startup || {};
    var effPalette = look.palette || null;
    var effAccent = (look.accent && (look.accent.dark || look.accent.light)) || '';
    // 壁纸参数按模式各有一套（主题可以分别给 dark / light）。面板写出的是**扁平值**——一次改两套，
    // 所以显示取"当前模式的生效值"，那正是此刻屏幕上用的那个；两套不一致时下面会补一句说明。
    var wallpaperMode = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    var effWallpaper = (look.wallpaper && look.wallpaper[wallpaperMode]) || {};
    var startup = cfg.startup || {};
    var palette = cfg.palette || null;

    var body = rootNode.querySelector('.bd');
    // 重建 DOM 会丢掉滚动位置，拖完滑块/改完一项就跳回顶部——记住再放回去
    var keepScroll = body.scrollTop;
    body.textContent = '';

    // ── 主题
    var themes = section('主题');
    var grid = el('div', 'themes');
    (data.themes || []).forEach(function (theme) {
      var card = el('div', 'th' + (cfg.theme === theme.id ? ' on' : ''));
      // 主题可以住在主题库以外（另存为新主题时选了别的目录），落点得能看见
      card.title = theme.dir ? theme.name + '\n' + theme.dir : theme.name;
      var sw = el('div', 'sw');
      sw.style.background = theme.swatch.background;
      var dot = document.createElement('i');
      dot.style.background = theme.swatch.accent;
      sw.appendChild(dot);
      card.appendChild(sw);
      card.appendChild(el('div', 'nm', theme.name + (theme.builtin ? '' : ' ·自')));
      card.addEventListener('mouseenter', function () {
        // 已经是当前主题就不必预览：省掉一次样式表重写
        if (cfg.theme !== theme.id) preview({ theme: theme.id });
      });
      card.addEventListener('mouseleave', restoreCss);
      card.addEventListener('click', function () { apply({ theme: theme.id }, '已切换主题：' + theme.name); });
      grid.appendChild(card);
    });
    var noneCard = el('div', 'th' + (cfg.theme ? '' : ' on'));
    noneCard.appendChild(el('div', 'sw'));
    noneCard.appendChild(el('div', 'nm', '（不使用主题）'));
    noneCard.addEventListener('click', function () { apply({ theme: null }, '已停用主题'); });
    grid.appendChild(noneCard);
    themes.appendChild(grid);
    // 主题库是 ~/.zcode-expand/themes/ 下的文件夹，可以整体拷来拷去；
    // 丢进去也能被识别（文件监听会重载），但没有入口就发现不了，所以给个按钮。
    var themeBtns = el('div', 'btns');
    var importBtn = el('div', 'btn', '导入主题…');
    importBtn.title = '选一个别处拷来的主题文件夹（里面要有 theme.json），整套拷进你的主题库——壁纸会一起带过来。'
      + '\n也可以直接把文件夹丢进 ' + '~/.zcode-expand/themes/，一样会被认出来。';
    importBtn.addEventListener('click', function () {
      safe(IPC.panelImportTheme()).then(function (res) {
        if (!res || res.canceled) return;
        msg('已导入主题：' + res.name + '（在下面的列表里，点一下就能用）');
        refresh();
      });
    });
    themeBtns.appendChild(importBtn);
    themes.appendChild(themeBtns);
    body.appendChild(themes);

    // ── 壁纸
    var wpSec = section('壁纸', 'wallpaper');
    var btns = el('div', 'btns');
    var pick = el('div', 'btn', '选图/视频…');
    pick.addEventListener('click', function () {
      safe(IPC.panelPickWallpaper()).then(function (res) {
        if (!res || res.canceled) return;
        msg('已应用壁纸：' + res.file);
        refresh();
      });
    });
    var clear = el('div', 'btn', '清除壁纸');
    clear.addEventListener('click', function () { apply({ wallpaper: null }, '已清除个人壁纸'); });
    var clearDim = el('div', 'btn', '去掉压暗');
    clearDim.addEventListener('click', function () { apply({ clearOverlay: true }, '已去掉压暗蒙层'); });
    btns.appendChild(pick); btns.appendChild(clear); btns.appendChild(clearDim);
    wpSec.appendChild(btns);

    if (data.wallpaper && (data.wallpaper.file || data.wallpaper.fromTheme)) {
      // 类名是 note 不是 msg：msg 是底部那条固定提示的专属，两者不能混（见 msg() 的注释）
      wpSec.appendChild(el('div', 'note', '当前：' + (data.wallpaper.file || '（主题自带）')));
    }
    // 深浅两套的壁纸参数不一致时，下面那些数字只代表当前这一套——不说清楚就会被当成自相矛盾
    if (look.wallpaper && JSON.stringify(look.wallpaper.dark) !== JSON.stringify(look.wallpaper.light)) {
      wpSec.appendChild(el('div', 'note', '下面显示的是当前「' + (wallpaperMode === 'dark' ? '深色' : '浅色') + '」那套；深浅两套的壁纸参数不一样。'));
    }

    var library = (data.wallpapers || []);
    if (library.length) {
      var libBox = el('div', 'wp');
      library.forEach(function (item) {
        var wrap = el('span', 'th2' + (data.wallpaper && data.wallpaper.id === item.id ? ' on' : ''));
        wrap.title = item.name + (item.video ? '（视频）' : item.animated ? '（动图）' : '');
        var box;
        if (item.video) {
          // 视频没法用 background-image 出预览（CSS 放不了视频），
          // 所以用真的 <video> 渲染首帧：preload=metadata 省流量，loadedmetadata 后 seek 一下逼它解码那一帧。
          box = document.createElement('video');
          box.muted = true;
          box.preload = 'metadata';
          box.setAttribute('playsinline', '');
          box.src = item.url + '#t=0.1';
          box.addEventListener('loadedmetadata', function () {
            try { box.currentTime = Math.min(0.5, (box.duration || 1) * 0.1); } catch (e) { /* 忽略 */ }
          }, { once: true });
        } else {
          box = el('span');
          box.style.backgroundImage = 'url("' + item.url + '")';
        }
        box.className = 'box';
        wrap.appendChild(box);
        if (item.video) wrap.appendChild(el('b', 'play', '▶'));
        wrap.addEventListener('click', function () {
          safe(IPC.panelSelectWallpaper(item.id)).then(function () { msg('已应用：' + item.name); refresh(); });
        });
        libBox.appendChild(wrap);
      });
      wpSec.appendChild(libBox);
    }

    wpSec.appendChild(select('适配', effWallpaper.fit || 'cover', [
      ['cover', '铺满（裁切）'], ['contain', '完整显示（留边）'], ['fill', '拉伸铺满'],
      ['tile', '平铺'], ['center', '居中不缩放'],
    ], function (v) { apply({ fit: v }, '适配已改'); }));

    var axes = positionAxes(effWallpaper.position);
    wpSec.appendChild(slider('水平位置', axes ? axes[0] : 50, 0, 100, 1, null, function (v) { apply({ positionX: v }); }));
    wpSec.appendChild(slider('垂直位置', axes ? axes[1] : 50, 0, 100, 1, null, function (v) { apply({ positionY: v }); }));
    wpSec.appendChild(slider('模糊', effWallpaper.blur != null ? effWallpaper.blur : 0, 0, 60, 1, null, function (v) { apply({ blur: v }); }));
    wpSec.appendChild(slider('压暗', effWallpaper.dim != null ? effWallpaper.dim : 0.35, 0, 1, 0.05, null, function (v) { apply({ dim: v }); }));
    wpSec.appendChild(slider('缩放', effWallpaper.scale != null ? effWallpaper.scale : 1, 0.5, 2, 0.05, null, function (v) { apply({ scale: v }); }));
    wpSec.appendChild(slider('饱和度', effWallpaper.saturate != null ? effWallpaper.saturate : 1, 0, 2, 0.05, null, function (v) { apply({ saturate: v }); }));
    wpSec.appendChild(slider('亮度', effWallpaper.brightness != null ? effWallpaper.brightness : 1, 0, 2, 0.05, null, function (v) { apply({ brightness: v }); }));
    wpSec.appendChild(slider('对比度', effWallpaper.contrast != null ? effWallpaper.contrast : 1, 0, 2, 0.05, null, function (v) { apply({ contrast: v }); }));
    wpSec.appendChild(slider('灰度', effWallpaper.grayscale != null ? effWallpaper.grayscale : 0, 0, 1, 0.05, null, function (v) { apply({ grayscale: v }); }));
    body.appendChild(wpSec);

    // ── 毛玻璃
    var glSec = section('毛玻璃', 'glass');
    // 窗口材质只在它能真正落地的平台显示：win32 走 setBackgroundMaterial、darwin 走 setVibrancy，
    // Linux 上主进程什么都不做，摆着这个下拉是骗人的。判断由主进程给（materialApplies）。
    if (data.materialApplies) {
      glSec.appendChild(select('窗口材质', effGlass.material || 'acrylic', [
        ['acrylic', '亚克力（默认）'], ['mica', 'Mica'], ['tabbed', 'Tabbed'], ['none', '关掉材质'],
      ], function (v) { apply({ material: v }, '材质已改'); }));
    }
    glSec.appendChild(slider('整体不透明', effGlass.opacity != null ? effGlass.opacity : 1, 0, 1, 0.02, null, function (v) { apply({ glassOpacity: v }); }));
    glSec.appendChild(slider('整体模糊', effGlass.blur != null ? effGlass.blur : 0, 0, 40, 1, null, function (v) { apply({ glassBlur: v }); }));
    var follows = data.regionFollows || {};
    function regionSlider(label, key, field, max) {
      var followsGlobal = follows[key] && follows[key][field];
      var region = effRegions[key] || {};
      var value = region[field] != null ? region[field]
        : (field === 'opacity' ? (effGlass.opacity != null ? effGlass.opacity : 1) : (effGlass.blur != null ? effGlass.blur : 0));
      var row = slider(label + (followsGlobal ? '（跟随）' : ''), value, 0, max, field === 'opacity' ? 0.02 : 1, null, function (v) {
        var input = {}; input[key + (field === 'opacity' ? 'Opacity' : 'Blur')] = v; apply(input);
      });
      return row;
    }
    glSec.appendChild(regionSlider('侧栏', 'frame', 'opacity', 1));
    glSec.appendChild(regionSlider('主区', 'main', 'opacity', 1));
    glSec.appendChild(regionSlider('主区模糊', 'main', 'blur', 40));
    glSec.appendChild(regionSlider('卡片', 'card', 'opacity', 1));
    glSec.appendChild(regionSlider('卡片模糊', 'card', 'blur', 40));
    glSec.appendChild(regionSlider('输入框', 'input', 'opacity', 1));
    glSec.appendChild(regionSlider('输入框模糊', 'input', 'blur', 40));
    body.appendChild(glSec);

    // ── 配色
    var palSec = section('配色', 'palette');
    var seed = palette ? palette.seed : '';
    var variant = effPalette ? effPalette.variant : 'natural';
    var seedRow = el('div', 'row');
    seedRow.appendChild(el('label', null, '种子色'));
    var seedInput = document.createElement('input');
    seedInput.type = 'text';
    // 输入框只显示覆盖值（留空=主题的），主题那个值放 placeholder，别让它隐身
    seedInput.placeholder = effPalette ? '#rrggbb（留空=主题的 ' + effPalette.seed + '）' : '#rrggbb';
    seedInput.value = seed;
    seedInput.addEventListener('change', function () {
      var v = seedInput.value.trim();
      if (!/^#[0-9a-fA-F]{6}$/.test(v)) { msg('种子色要写成 #rrggbb', true); return; }
      apply({ palette: { seed: v, variant: variant } }, '调色板已应用');
    });
    seedRow.appendChild(seedInput);
    palSec.appendChild(seedRow);
    palSec.appendChild(select('风格', variant, [
      ['natural', '自然'], ['vivid', '鲜艳'], ['soft', '柔和'], ['oled', '纯黑 OLED'], ['contrast', '高对比'],
    ], function (v) {
      // 只改风格时种子色要沿用**生效**的那个，否则没覆盖过的用户会被悄悄换成默认蓝
      var current = seed || (effPalette && effPalette.seed) || '#3b82f6';
      apply({ palette: { seed: current, variant: v } }, '风格已改');
    }));
    var palBtns = el('div', 'btns');
    var fromWallpaper = el('div', 'btn', '从壁纸取色');
    fromWallpaper.addEventListener('click', function () { pickSeedFromWallpaper(); });
    var clearPal = el('div', 'btn', '清除调色板');
    clearPal.addEventListener('click', function () { apply({ palette: null }, '已清除个人调色板'); });
    palBtns.appendChild(fromWallpaper); palBtns.appendChild(clearPal);
    palSec.appendChild(palBtns);

    var accentRow = el('div', 'row');
    accentRow.appendChild(el('label', null, '强调色'));
    var accent = document.createElement('input');
    accent.type = 'text';
    accent.placeholder = effAccent ? '#rrggbb（留空=主题的 ' + effAccent + '）' : '#rrggbb（留空=主题的）';
    accent.value = cfg.accent || '';
    accent.addEventListener('change', function () {
      var v = accent.value.trim();
      if (!v) { apply({ accent: null }, '已清除强调色'); return; }
      if (!/^#[0-9a-fA-F]{6}$/.test(v)) { msg('强调色要写成 #rrggbb', true); return; }
      apply({ accent: v }, '强调色已应用');
    });
    accentRow.appendChild(accent);
    palSec.appendChild(accentRow);
    body.appendChild(palSec);

    // ── 启动画面
    var stSec = section('启动画面', 'startup');
    var stRow = el('div', 'row');
    stRow.appendChild(el('label', null, '背景'));
    var stBg = document.createElement('input');
    stBg.type = 'text';
    // 主题的背景可能是整条渐变，长到塞不下 —— 超过 20 字截断加省略号
    var themeBg = effStartup.background ? String(effStartup.background) : '';
    var hintBg = themeBg.length > 20 ? themeBg.slice(0, 20) + '…' : themeBg;
    stBg.placeholder = hintBg ? 'CSS 颜色或渐变（留空=主题的 ' + hintBg + '）' : 'CSS 颜色或渐变，留空=官方';
    stBg.value = startup.background || '';
    stBg.addEventListener('change', function () { apply({ startup: { background: stBg.value.trim() || null } }, '启动背景已改'); });
    stRow.appendChild(stBg);
    stSec.appendChild(stRow);
    stSec.appendChild(slider('logo 尺寸', effStartup.logoSize != null ? effStartup.logoSize : 96, 32, 256, 1, null, function (v) {
      apply({ startup: { logoSize: v } });
    }));
    stSec.appendChild(select('动画', effStartup.animation || 'pop', [
      ['pop', '弹出（官方）'], ['fade', '淡入'], ['none', '静止'],
    ], function (v) { apply({ startup: { animation: v } }, '启动动画已改'); }));
    body.appendChild(stSec);

    // ── 圆角
    // radius 为 null 与 1 是一个意思：都用官方那套 rem（见 css.mjs 的 `look.radius !== null && !== 1`）
    var rdSec = section('圆角', 'radius');
    rdSec.appendChild(slider('整体圆角', look.radius != null ? look.radius : 1, 0, 2, 0.05, null, function (v) { apply({ radius: v }); }));
    body.appendChild(rdSec);

    // ── 桌宠
    //
    // 「放好素材」和「开不开」是两件事：素材只决定**能不能**显示，开关才决定显不显示。
    // 面板得把这两条都摆出来，否则就会出现"图片放了、日志说找到了、就是不出来、也没地方开"
    // （2026-10-14 本人踩过）。素材在不在、平台支不支持桌面模式、各项默认值——都由主进程
    // 算好放在 data.petStatus 里，渲染层不重抄 PET_SCALE / PET_SOUNDS / 平台判断。
    var petStatus = data.petStatus || null;
    var petCfg = cfg.pet || {};
    var petOn = petCfg.enabled === true;
    var petDefaults = (petStatus && petStatus.defaults) || {};
    var petScale = (petStatus && petStatus.scale) || { min: 0.6, max: 2.5, step: 0.1 };
    var petSec = section('桌宠', 'pet');
    petSec.appendChild(switchRow('启用', petOn, function (on) {
      apply({ pet: { enabled: on } }, on ? '桌宠已出现' : '桌宠已收起');
    }));
    // 关着的时候不铺开一堆没用的控件（参考实现也是这么收的）
    if (petOn) {
      petSec.appendChild(slider('大小',
        petCfg.scale != null ? petCfg.scale : (petDefaults.scale != null ? petDefaults.scale : 1.5),
        petScale.min, petScale.max, petScale.step, null,
        function (v) { apply({ pet: { scale: v } }, '桌宠大小已改'); }));
      var soundLabels = { duck: '小黄鸭', fx1: '音效 1' };
      petSec.appendChild(select('音效', petCfg.sound || petDefaults.sound || 'duck',
        ((petStatus && petStatus.sounds) || ['duck', 'fx1']).map(function (s) { return [s, soundLabels[s] || s]; }),
        function (v) { apply({ pet: { sound: v } }, '桌宠音效已改'); }));
      petSec.appendChild(slider('音量',
        petCfg.volume != null ? petCfg.volume : (petDefaults.volume != null ? petDefaults.volume : 0.9),
        0, 1, 0.05, null,
        function (v) { apply({ pet: { volume: v } }, '桌宠音量已改'); }));
      petSec.appendChild(switchRow('说话', petCfg.bubble !== false, function (on) {
        apply({ pet: { bubble: on } }, on ? '桌宠会说话了' : '桌宠安静了');
      }));
      petSec.appendChild(switchRow('桌面模式', petCfg.desktop === true, function (on) {
        apply({ pet: { desktop: on } }, on ? '桌宠搬到桌面上了（ZCode 最小化时也在）' : '桌宠回到窗口里');
      }));
    }
    if (petStatus && petStatus.hint) petSec.appendChild(el('div', 'note', petStatus.hint));
    body.appendChild(petSec);

    // ── 底部动作
    //
    // 模型：外观 = 主题（预设）+ 个人覆盖（你在面板上调的每一项，盖在主题之上）。
    // 这三个按钮就是在处置那层覆盖，所以每个都要说清楚它动的是哪一层。
    var actSec = el('div', 'sec');
    actSec.appendChild(el('h4', null, '这套调整怎么办'));
    var acts = el('div', 'btns');
    var activeTheme = (data.themes || []).find(function (t) { return t.id === cfg.theme; });
    var canSaveInPlace = !!activeTheme && !activeTheme.builtin;

    var saveIn = el('div', 'btn' + (canSaveInPlace ? '' : ' off'), '存进当前主题');
    saveIn.title = canSaveInPlace
      ? '把「' + activeTheme.name + '」和你在面板上调的每一项合成一份，写回这个主题（旧的留一份 .bak），然后清空个人覆盖——从此这些调整归主题所有。'
      : (cfg.theme
        ? '当前是内置主题「' + (activeTheme ? activeTheme.name : cfg.theme) + '」，不能改写。想保留这套调整请用「另存为新主题…」。'
        : '还没选主题。先在上面选一套，或用「另存为新主题…」把当前调整存成一套新主题。');
    saveIn.addEventListener('click', function () {
      if (!canSaveInPlace) {
        msg(cfg.theme ? '内置主题不能改写，用「另存为新主题…」' : '先选一套主题，或用「另存为新主题…」', true);
        return;
      }
      safe(IPC.panelSaveTheme({})).then(function (res) {
        if (res && res.id) { msg('已存进主题：' + res.name + '（个人覆盖已清空）'); refresh(); }
        else msg('保存失败', true);
      });
    });

    var saveAs = el('div', 'btn', '另存为新主题…');
    saveAs.title = '把当前这一整套（主题 + 你的每一项调整）压成一份新主题存下来并切过去。适合备用、分享，或当前是内置主题时把调整留住。';
    // 名字交给主进程的系统保存框收：Electron 把 window.prompt 硬桩成抛异常，调它点击必然中断。
    // 这里**不走 safe()**——保存失败的原因（名字不合法、写盘失败）要原样给人看，不能被吞成"保存失败"。
    saveAs.addEventListener('click', function () {
      var suggested = activeTheme ? activeTheme.name + ' 自定义' : '我的主题';
      IPC.panelSaveThemeAs(suggested).then(function (res) {
        if (!res || res.canceled) return;
        if (res.id) { msg('已存为新主题：' + res.name); refresh(); }
        else msg('保存失败', true);
      }, function (error) {
        log('另存为新主题失败: ' + reason(error));
        msg('保存失败：' + reason(error), true);
      });
    });

    var discard = el('div', 'btn', '丢弃所有个人覆盖');
    discard.title = '清掉你在面板里调的全部设置（含壁纸），回到当前主题本来的样子。主题选择保留。';
    // 不用 window.confirm：那是**同步模态框**——渲染层脚本整个停摆（Electron 要等
    // DialogClosedCallback 回来才放行），窗口又被 Windows 禁用，于是弹窗期间界面全卡，
    // 关掉之后还得把积压的事件跑完才恢复（2026-10-14 实测）。
    // 照参考实现改成"点两次"：第一次按钮自己变成确认态，4 秒不点就退回。
    var discardArmed = false;
    var discardTimer = null;
    function disarmDiscard() {
      clearTimeout(discardTimer);
      discardTimer = null;
      discardArmed = false;
      discard.textContent = '丢弃所有个人覆盖';
    }
    discard.addEventListener('click', function () {
      if (!discardArmed) {
        discardArmed = true;
        discard.textContent = '确认丢弃';
        discardTimer = setTimeout(disarmDiscard, 4000);
        return;
      }
      disarmDiscard();
      apply({ discard: true }, '已丢弃个人覆盖，回到主题原样');
    });

    acts.appendChild(saveIn); acts.appendChild(saveAs); acts.appendChild(discard);
    actSec.appendChild(acts);
    body.appendChild(actSec);

    body.scrollTop = keepScroll;
  }

  /** 位置解析在前端也要一份，用来显示滑块（与主进程同源算法，纯字符串运算） */
  function positionAxes(value) {
    if (!value) return null;
    var keywords = { left: 0, top: 0, center: 50, right: 100, bottom: 100 };
    var parts = String(value).trim().toLowerCase().split(/\s+/);
    function axis(part) {
      if (part in keywords) return keywords[part];
      var m = /^(\d+(?:\.\d+)?)%$/.exec(part);
      if (!m) return null;
      var n = Number(m[1]);
      return n <= 100 ? n : null;
    }
    if (parts.length === 1) {
      var n = axis(parts[0]);
      if (n === null) return null;
      return parts[0] === 'top' || parts[0] === 'bottom' ? [50, n] : [n, 50];
    }
    if (parts.length !== 2) return null;
    var x = axis(parts[0]);
    var y = axis(parts[1]);
    return x === null || y === null ? null : [x, y];
  }

  /** 从一张已就绪的位图源（<img>，或 <video> 的当前帧）缩到 32px 取种子色；取不到返回 null */
  function seedFromSource(source) {
    var size = 32;
    var canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, size, size);
    var d = ctx.getImageData(0, 0, size, size).data;
    var best = null;
    var bestScore = -1;
    for (var i = 0; i < d.length; i += 4) {
      var r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
      var max = Math.max(r, g, b), min = Math.min(r, g, b);
      var l = (max + min) / 2;
      var s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
      if (l < 0.15 || l > 0.9) continue;
      var score = s;
      if (score > bestScore) { bestScore = score; best = [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)]; }
    }
    if (!best) return null;
    return '#' + best.map(function (v) { return v.toString(16).padStart(2, '0'); }).join('');
  }

  /** 取到种子色后统一走这里：保留当前的配色风格，只换种子 */
  function applySeed(hex) {
    apply({ palette: { seed: hex, variant: (data.config.palette && data.config.palette.variant) || 'natural' } }, '已从壁纸取色：' + hex);
  }

  /**
   * 从当前壁纸取种子色。
   * 图片：把 <img> 缩到 32px 采样，走与主进程同一套色相分桶；
   * 视频：采样常驻视频层的**当前帧**——那层本来就在播，不必为一个颜色再解码一次，
   *       取到的也正是用户此刻看见的画面（所以同一段视频不同时刻取到的颜色会不同，这是预期的）。
   */
  function pickSeedFromWallpaper() {
    var videos = (data && data.videoUrl) || {};
    if (videos.dark || videos.light) { pickSeedFromVideo(); return; }
    var url = data && data.imageUrl && (data.imageUrl.dark || data.imageUrl.light);
    if (!url) { msg('先选一张壁纸，才能从它取色', true); return; }
    var img = new Image();
    img.onload = function () {
      try {
        var hex = seedFromSource(img);
        if (!hex) { msg('这张图没取到可用的颜色', true); return; }
        applySeed(hex);
      } catch (error) {
        msg('取色失败：' + String(error && error.message ? error.message : error), true);
      }
    };
    img.onerror = function () { msg('壁纸读不出来，取色失败', true); };
    img.src = url;
  }

  /** 视频壁纸取色：直接采视频层当前那一帧 */
  function pickSeedFromVideo() {
    // id 与 wallpaper-video.js 的 VIDEO_ID 一致（test/overlay.test.mjs 会核对两边）
    var layer = document.getElementById('zcode-expand-video');
    if (!layer) { msg('视频层还没挂上，稍等一下再试', true); return; }
    // readyState < HAVE_CURRENT_DATA 时还没有可画的帧，画出来是全黑
    if (layer.readyState < 2 || !layer.videoWidth) { msg('视频还没加载好，稍等一下再试', true); return; }
    try {
      var hex = seedFromSource(layer);
      if (!hex) { msg('这段视频没取到可用的颜色', true); return; }
      applySeed(hex);
    } catch (error) {
      msg('取色失败：' + String(error && error.message ? error.message : error), true);
    }
  }

  // ---------------------------------------------------------------- 挂载

  var lastSignature = null;

  function refresh(force) {
    return safe(IPC.panelGet()).then(function (res) {
      if (!res) return null;
      data = res;
      var signature = null;
      try { signature = JSON.stringify(res); } catch (e) { signature = null; }
      // 数据没变就不重建 DOM。重建会把鼠标底下的元素整个换掉，表现为：
      // 点击要按好几次才生效、原生下拉框弹出即被销毁、指针悬浮闪烁、滚动位置跳回顶部。
      // 主进程那边已经修了自激循环，这里是面板自己的第二道保险。
      if (!force && signature !== null && signature === lastSignature) return res;
      lastSignature = signature;
      render();
      return res;
    });
  }

  function build() {
    var style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      style.setAttribute(ROOT_ATTR, '1');
      style.textContent = CSS;
      (document.head || document.documentElement).appendChild(style);
    }

    var launcher = el('div');
    launcher.id = LAUNCHER_ID;
    launcher.setAttribute(ROOT_ATTR, '1');
    launcher.title = '外观中心（Ctrl+Alt+Shift+O）';
    launcher.textContent = '🎨';

    var panel = el('div');
    panel.id = PANEL_ID;
    panel.setAttribute(ROOT_ATTR, '1');
    var hd = el('div', 'hd');
    hd.appendChild(el('b', null, '外观中心'));
    var close = el('span', 'x', '✕');
    close.addEventListener('click', function () { panel.classList.remove('open'); });
    hd.appendChild(close);
    panel.appendChild(hd);
    panel.appendChild(el('div', 'bd'));
    var status = el('div', 'msg');
    status.id = STATUS_ID;
    panel.appendChild(status);

    rootNode = el('div');
    rootNode.setAttribute(ROOT_ATTR, '1');
    rootNode.appendChild(panel);
    rootNode.appendChild(launcher);
    (document.body || document.documentElement).appendChild(rootNode);

    launcher.addEventListener('click', function () { api.open(); });

    window.__ZC_EXPAND_PANEL__ = api;
  }

  var api = {
    open: function () {
      var panel = document.getElementById(PANEL_ID);
      if (!panel) return;
      panel.classList.add('open');
      refresh();
    },
    close: function () {
      var panel = document.getElementById(PANEL_ID);
      if (panel) panel.classList.remove('open');
    },
    refresh: function () { refresh(); },
  };

  // 深浅模式切换：壁纸滑块显示的是"当前模式那套"，数据没变但展示得跟着变。
  // 这跟 CHANNEL_PANEL_CHANGED 那条路不重合——切换模式不改 CSS 字符串，主进程不会推东西过来，
  // 只能自己听 <html> 的 class；并且要 force，否则数据签名没变会被 refresh() 的守卫挡掉。
  try {
    var lastMode = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    new MutationObserver(function () {
      var next = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
      if (next === lastMode) return;
      lastMode = next;
      refresh(true);
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  } catch (e) { /* MutationObserver 不可用就算了 */ }

  // 等 body 出来再挂（preload 注入时文档还是空的）
  (function wait() {
    if (document.body) { build(); refresh(); return; }
    setTimeout(wait, 0);
  })();
})();
