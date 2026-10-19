/* ZCode-Expand · 任务运行状态点
 * ---------------------------------------------------------------------------
 * 本文件由 ZCode-Expand 注入到渲染层（out/renderer/zcode-expand/zc-remarks.js）。
 * 文件名沿用旧版（备注功能已于 2026-10-19 移除），现在只负责项目行/任务分区
 * 头的运行状态点。包内补丁只通过 window.__ZC_EXPAND__ 与本文件交互。
 *
 * 对外契约：
 *   isTaskListBusy(taskItems) -> boolean
 *       项目下是否有正在执行的任务。与官方任务行 spinner 同源判定：
 *       任一 task 的 __zcodeSessionActivity.phase 处于 prewarming/running 即
 *       运行中。输入是项目行的 tasks 数组。
 *   isTaskListDone(taskItems) -> boolean
 *       项目行绿点（完成待查看）：任一任务不在运行且带未读标记（unreadAt 为
 *       数字，与官方 hasUnread 同源）。刻意不用官方 taskListHasUnread——它的
 *       清除时机随版本变化（3.12.2 点击项目即清），自判定只跟随任务本身的
 *       未读状态：点开任务查看（官方清 unreadAt）或下一轮开跑才消失。
 *   isTaskListWaiting(taskItems) -> boolean
 *       项目行红点（等待确认，优先级最高，覆盖蓝绿点）：任一任务带待处理
 *       的权限/输入确认。与官方任务行「等待确认」标签同源判定：
 *       __zcodeSessionActivity.pendingInteractions 的 permissionCount +
 *       userInputCount > 0（taskList.permissionTag/userInputTag 都算）。
 *   diag() -> object
 *       自检信息，便于确认注入是否生效。
 * ---------------------------------------------------------------------------
 */
(function () {
  'use strict';

  var VERSION = '1.7.0';

  // localStorage 覆盖：可在不改包、不重新 apply 的情况下临时调参或整体关掉。
  //   localStorage.setItem('zcode-expand.remarks', JSON.stringify({enabled:false}))
  //   localStorage.setItem('zcode-expand.remarks', JSON.stringify({runningDot:{color:'#38bdf8'}}))
  // 改完执行 window.__ZC_EXPAND__.reload() 生效（或刷新窗口）。
  var OVERRIDE_KEY = 'zcode-expand.remarks';

  var CONFIG = {
    // 总开关。false 时运行状态点不再渲染
    enabled: true,
    // 运行中蓝点（zc-xp-running，脉冲动画由本模块注入）。颜色默认走补丁里
    // 的官方类 bg-sky-500 dark:bg-sky-400（与官方未读点一致）；这里只作
    // 覆盖钩子，显式给颜色才注入 background 规则。
    runningDot: {
      color: '',
    },
    // 完成待查看绿点（zc-xp-done，静态）。默认走官方类 bg-success。
    doneDot: {
      color: '',
    },
    // 等待确认红点（zc-xp-waiting，静态，优先级最高：覆盖运行蓝点与完成绿
    // 点）。默认走官方类 bg-destructive（官方 error 指示点同款）。
    waitingDot: {
      color: '',
    },
  };

  function applyOverrides() {
    var raw = null;
    try {
      raw = window.localStorage.getItem(OVERRIDE_KEY);
    } catch (err) {
      console.warn('[ZCode-Expand] 读取 localStorage 覆盖配置失败：', err);
      return '';
    }
    if (!raw) return '';
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return raw;
      if (typeof parsed.enabled === 'boolean') CONFIG.enabled = parsed.enabled;
      if (parsed.runningDot && typeof parsed.runningDot === 'object') {
        if (typeof parsed.runningDot.color === 'string') CONFIG.runningDot.color = parsed.runningDot.color;
      }
      if (parsed.doneDot && typeof parsed.doneDot === 'object') {
        if (typeof parsed.doneDot.color === 'string') CONFIG.doneDot.color = parsed.doneDot.color;
      }
      if (parsed.waitingDot && typeof parsed.waitingDot === 'object') {
        if (typeof parsed.waitingDot.color === 'string') CONFIG.waitingDot.color = parsed.waitingDot.color;
      }
      return raw;
    } catch (err) {
      console.warn('[ZCode-Expand] localStorage 覆盖配置不是合法 JSON，已忽略：', err);
      return raw;
    }
  }

  // ---------------------------------------------------------------------------
  // 任务运行状态点
  // ---------------------------------------------------------------------------

  function isTaskListBusy(taskItems) {
    if (!CONFIG.enabled) return false;
    if (!Array.isArray(taskItems)) return false;
    for (var i = 0; i < taskItems.length; i++) {
      var task = taskItems[i];
      if (!task || typeof task !== 'object') continue;
      var activity = task.__zcodeSessionActivity;
      if (activity && typeof activity === 'object') {
        var phase = activity.phase;
        if (phase === 'prewarming' || phase === 'running') return true;
      }
    }
    return false;
  }

  // 完成待查看（绿点）：任务不在运行且带未读标记。未读判定与官方 hasUnread
  // 同源（typeof unreadAt === 'number'），先看 taskMeta.unreadAt（官方数据层
  // 优先写这里），回退顶层 unreadAt。
  function isTaskListDone(taskItems) {
    if (!CONFIG.enabled) return false;
    if (!Array.isArray(taskItems)) return false;
    for (var i = 0; i < taskItems.length; i++) {
      var task = taskItems[i];
      if (!task || typeof task !== 'object') continue;
      var activity = task.__zcodeSessionActivity;
      var phase = activity && typeof activity === 'object' ? activity.phase : undefined;
      if (phase === 'prewarming' || phase === 'running') continue;
      var meta = task.taskMeta && typeof task.taskMeta === 'object' ? task.taskMeta : null;
      var unreadAt = meta && typeof meta.unreadAt === 'number'
        ? meta.unreadAt
        : (typeof task.unreadAt === 'number' ? task.unreadAt : undefined);
      if (typeof unreadAt === 'number') return true;
    }
    return false;
  }

  // 等待确认（红点）：与官方任务行「等待确认」标签同源判定（Pce）——
  // pendingInteractions.permissionCount + userInputCount > 0，权限确认和
  // 用户输入都算。优先级最高：补丁里排在运行蓝点与完成绿点之前。
  function isTaskListWaiting(taskItems) {
    if (!CONFIG.enabled) return false;
    if (!Array.isArray(taskItems)) return false;
    for (var i = 0; i < taskItems.length; i++) {
      var task = taskItems[i];
      if (!task || typeof task !== 'object') continue;
      var activity = task.__zcodeSessionActivity;
      if (!activity || typeof activity !== 'object') continue;
      var pending = activity.pendingInteractions;
      if (!pending || typeof pending !== 'object') continue;
      var permission = typeof pending.permissionCount === 'number' ? pending.permissionCount : 0;
      var userInput = typeof pending.userInputCount === 'number' ? pending.userInputCount : 0;
      if (permission + userInput > 0) return true;
    }
    return false;
  }

  // 运行点/完成点/等待点的动画与可选配色覆盖（class zc-xp-running /
  // zc-xp-done / zc-xp-waiting）。颜色默认走补丁里复用的官方类
  // （bg-sky-500 dark:bg-sky-400 / bg-success / bg-destructive），
  // 只有显式配置了颜色才注入 background 规则（非 layer 规则可覆盖
  // Tailwind utilities）。动画尊重系统"减少动态效果"偏好。
  function ensureRunningDotStyle() {
    var STYLE_ID = 'zc-xp-running-style';
    // 已存在时先移除，保证 reload() 改配置后能按新参数重建
    var existing = document.getElementById(STYLE_ID);
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    if (!CONFIG.enabled) return;
    var rules = [
      '.zc-xp-running{animation:zc-xp-pulse 2s cubic-bezier(.4,0,.6,1) infinite}',
      '@keyframes zc-xp-pulse{50%{opacity:.35}}',
      '@media (prefers-reduced-motion: reduce){.zc-xp-running{animation:none;opacity:.85}}',
    ];
    if (CONFIG.runningDot.color) {
      rules.push('.zc-xp-running{background:' + CONFIG.runningDot.color + '}');
    }
    if (CONFIG.doneDot && CONFIG.doneDot.color) {
      rules.push('.zc-xp-done{background:' + CONFIG.doneDot.color + '}');
    }
    if (CONFIG.waitingDot && CONFIG.waitingDot.color) {
      rules.push('.zc-xp-waiting{background:' + CONFIG.waitingDot.color + '}');
    }
    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = rules.join('\n');
    document.head.appendChild(el);
  }

  function diag() {
    return {
      module: 'zcode-expand/remarks',
      version: VERSION,
      injected: true,
      override: {
        key: OVERRIDE_KEY,
        raw: currentOverrideRaw,
      },
      config: {
        enabled: CONFIG.enabled,
        runningDotColor: CONFIG.runningDot.color || '(official sky)',
        doneDotColor: CONFIG.doneDot.color || '(official success)',
        waitingDotColor: CONFIG.waitingDot.color || '(official destructive)',
      },
    };
  }

  // 读取一次覆盖配置；之后可用 reload() 重新读取
  var currentOverrideRaw = applyOverrides();
  ensureRunningDotStyle();

  window.__ZC_EXPAND__ = {
    version: VERSION,
    config: CONFIG,
    isTaskListBusy: isTaskListBusy,
    isTaskListDone: isTaskListDone,
    isTaskListWaiting: isTaskListWaiting,
    diag: diag,
    reload: function () {
      currentOverrideRaw = applyOverrides();
      ensureRunningDotStyle();
      return diag();
    },
  };

  console.log('[ZCode-Expand] 任务运行状态点模块已注入 v' + VERSION + '，自检：__ZC_EXPAND__.diag()');
})();
