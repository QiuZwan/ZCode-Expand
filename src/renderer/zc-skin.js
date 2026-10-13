// src/renderer/zc-skin.js — 皮肤引擎（注入 / 还原 / 自检）
//
// 由 out/renderer/index.html 里的一行 <script src="./zcode-expand/zc-skin.js"> 载入，
// 依赖先加载的 zc-skin-colors.js（window.__ZC_SKIN_COLORS__）。
//
// 注入方式与参考实现 ci-yyy/zcode-skin（MIT）一致：往 <head> 插一个 <style id="zc-skin-style">，
// 先删旧的再插新的（幂等，重复执行不会叠加）。背景画在 html 上，界面自己的面板靠
// buildSkinCss 抹成全透明透出背景——注意它是**两个**窗口壳变量都抹，原因见
// doc/20261013-设计文档-皮肤控制.md §4 事实 9（Windows 走的是 win-alt，不是 alt）。
//
// 控制面板在 Task 4 追加，本文件先只做引擎。

(function (root) {
  'use strict';

  var COLORS = root.__ZC_SKIN_COLORS__;
  var STYLE_ID = 'zc-skin-style';

  if (!COLORS) {
    // 缺依赖就明确报出来，不静默失效——静默失效会让"皮肤没生效"变成一个查不出原因的现象
    console.error('[zc-skin] 缺少 zc-skin-colors.js，皮肤引擎未启动');
    return;
  }

  // 内置预设：全部是纯 CSS 渐变，不含任何第三方视觉素材
  var PRESETS = [
    {
      id: 'midnight',
      name: '午夜蓝',
      appearance: 'dark',
      heroCss: 'linear-gradient(135deg, #0b1020 0%, #16233f 55%, #2b3a67 100%)',
      seed: { accent: '#5b8def', secondary: '#7c5cff', surface: '#0f172a', text: '#dbe4f5' },
    },
    {
      id: 'dusk',
      name: '暮色',
      appearance: 'dark',
      heroCss: 'linear-gradient(135deg, #1a0f1f 0%, #2d1b3d 50%, #4a2b52 100%)',
      seed: { accent: '#c084fc', secondary: '#f472b6', surface: '#170f1d', text: '#eadcf5' },
    },
    {
      id: 'mint',
      name: '薄荷',
      appearance: 'light',
      heroCss: 'linear-gradient(135deg, #e8f6f0 0%, #d3ebe2 55%, #b9dcd2 100%)',
      seed: { accent: '#0f9b7a', secondary: '#3b82f6', surface: '#eef7f3', text: '#12352c' },
    },
    {
      id: 'paper',
      name: '宣纸',
      appearance: 'light',
      heroCss: 'linear-gradient(135deg, #faf6ee 0%, #f2ebdd 55%, #e6dcc8 100%)',
      seed: { accent: '#b45309', secondary: '#0f766e', surface: '#faf6ee', text: '#3a3226' },
    },
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

  /** 插样式：先删旧的再插新的，保证幂等 */
  function apply(theme) {
    if (!theme || typeof theme !== 'object') return false;
    var head = document.head || document.documentElement;
    if (!head) return false; // 文档还没就绪，交给调用方稍后重试
    var prev = document.getElementById(STYLE_ID);
    if (prev) prev.remove();
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.setAttribute('data-zc-skin', theme.id || '');
    style.textContent = COLORS.buildSkinCss(theme);
    head.appendChild(style);
    active = theme;
    return true;
  }

  /** 还原官方外观：只移除注入的样式，不碰 ZCode 自己的任何东西 */
  function clear() {
    var el = document.getElementById(STYLE_ID);
    if (el) el.remove();
    active = null;
  }

  function current() {
    return active;
  }

  /** 运行时自检用：把关键状态一次问出来，省得在控制台逐个敲 */
  function diag() {
    var el = document.getElementById(STYLE_ID);
    var cs = root.getComputedStyle ? root.getComputedStyle(document.documentElement) : null;
    var read = function (name) {
      return cs ? cs.getPropertyValue(name).trim() : '';
    };
    var shells = {};
    COLORS.SCHELL_VARS.forEach(function (v) {
      shells[v] = read(v);
    });
    return {
      stylePresent: !!el,
      themeId: el ? el.getAttribute('data-zc-skin') : null,
      cssBytes: el ? el.textContent.length : 0,
      shells: shells,
      background: read('--color-background'),
      sidebar: read('--color-sidebar'),
      currentTheme: active ? active.id : null,
    };
  }

  function boot() {
    // Task 4 会把这行换成「读 localStorage，失败则回退内置第一套」
    apply(BUILTINS[0]);
  }

  if (document.head) boot();
  else document.addEventListener('DOMContentLoaded', boot, { once: true });

  root.__ZC_SKIN__ = {
    apply: apply,
    clear: clear,
    current: current,
    diag: diag,
    BUILTINS: BUILTINS,
  };
})(typeof window !== 'undefined' ? window : globalThis);
