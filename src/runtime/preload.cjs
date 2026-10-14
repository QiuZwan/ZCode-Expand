// ZCode-Expand 渲染层 preload（部署到 ~/.zcode-expand/runtime/preload.cjs）
//
// 由主进程 registerPreloadScript 注册给每一帧。职责：
//   1. 把外观 CSS 用 webFrame.insertCSS 注进页面——**样式不进 DOM**，React 碰不到
//   2. 把功能模块（备注 / 账号）与外观中心面板注入**主世界**
//
// 为什么不能在 preload 里直接 import 模块：
//   preload 跑在隔离世界，而模块要碰 window.__ZC_EXPAND__、React 内部、页面 DOM。
//   所以用 webFrame.executeJavaScript 注入主世界——实测（2026-10-14 探针）：
//     · 注入的代码确实在主世界（页面自己的脚本能读到它设的全局）
//     · 注入时机在页面脚本之前（ZCode 的入口是 deferred，更在后面）
//     · 但那一刻 document.head / documentElement 都还是 null，readyState 是 "loading"
//   所以垫片要先等 documentElement 出现。
//
// 源码不在这里读：渲染层可能开着 sandbox（ZCode 的渲染进程带 --enable-sandbox），
// preload 拿不到 node:fs。改由主进程通过同步 IPC 提供。

const { ipcRenderer, webFrame, contextBridge } = require('electron');

const CHANNEL_GET = 'zcode-expand:get';
const CHANNEL_CSS = 'zcode-expand:css';
const CHANNEL_PANEL_OPEN = 'zcode-expand:panel-open';
const CHANNEL_PANEL_CHANGED = 'zcode-expand:panel-changed';
const CHANNEL_PANEL_LOG = 'zcode-expand:panel-log';
const CHANNEL_GET_RUNTIME = 'zcode-expand:get-runtime';
const STYLE_ID = 'zcode-expand-style';

// 只在 ZCode 主窗口干活。preload 注册给每一帧，webview / 插件沙箱也会命中，
// 那些地方没有 #root、没有 ZCode 的 React 树，注进去只会报错。
const MAIN_WINDOW = /app\.asar\/out\/renderer\/index\.html/;

const PROTOCOL_VERSION = 1;

function decodeState(payload) {
  if (typeof payload === 'string') return payload;
  if (typeof payload !== 'object' || payload === null) return null;
  const { v, css } = payload;
  if (v !== PROTOCOL_VERSION || typeof css !== 'string') return null;
  return css;
}

/** 垫片：等 documentElement 就绪，再按顺序执行各模块；单个模块失败不影响其它模块 */
function buildShim(sources) {
  return `(function () {
  var list = ${JSON.stringify(sources)};
  function run() {
    if (!document.documentElement) { setTimeout(run, 0); return; }
    for (var i = 0; i < list.length; i++) {
      try {
        (new Function(list[i].code))();
      } catch (error) {
        console.error('[zcode-expand] 模块注入失败：' + list[i].name, error);
      }
    }
  }
  run();
})();`;
}

/** 外观 CSS 的注入/替换。先删旧的再插新的，保证幂等（重复注入不会叠加）。 */
function injectCss(css) {
  try {
    const existing = document.getElementById(STYLE_ID);
    if (existing) existing.remove();
    if (!css) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  } catch (error) {
    console.error('[zcode-expand] CSS 注入失败：', error);
  }
}

/** 等 documentElement 就绪后再跑；CSS 与垫片共用 */
function whenReady(fn) {
  const tick = () => {
    if (document.documentElement) {
      try { fn(); } catch (error) { console.error('[zcode-expand] preload 注入异常：', error); }
      return;
    }
    setTimeout(tick, 0);
  };
  tick();
}

try {
  if (MAIN_WINDOW.test(location.href)) {
    // ⓪ 给主世界的面板搭一座桥：主世界没有 ipcRenderer，只能由 preload 用 contextBridge 暴露
    try {
      contextBridge.exposeInMainWorld('__ZC_EXPAND_IPC__', {
        panelGet: () => ipcRenderer.invoke('zcode-expand:panel-get'),
        panelApply: (input) => ipcRenderer.invoke('zcode-expand:panel-apply', input),
        panelPreview: (input) => ipcRenderer.invoke('zcode-expand:panel-preview', input),
        panelPickWallpaper: () => ipcRenderer.invoke('zcode-expand:panel-pick-wallpaper'),
        panelSelectWallpaper: (id) => ipcRenderer.invoke('zcode-expand:panel-select-wallpaper', id),
        panelSaveTheme: (value) => ipcRenderer.invoke('zcode-expand:panel-save-theme', value),
        panelSaveThemeAs: (suggested) => ipcRenderer.invoke('zcode-expand:panel-save-theme-as', suggested),
        panelImportTheme: () => ipcRenderer.invoke('zcode-expand:panel-import-theme'),
        /** 外观变化时回调（主进程推 CHANNEL_PANEL_CHANGED 触发），用于视频壁纸层这类常驻同步 */
        onChanged: (cb) => {
          if (typeof cb !== 'function') return;
          ipcRenderer.on(CHANNEL_PANEL_CHANGED, () => { try { cb(); } catch (e) { /* 回调失败不影响推流 */ } });
        },
        log: (message) => ipcRenderer.send(CHANNEL_PANEL_LOG, String(message).slice(0, 1000)),
      });
    } catch (error) {
      console.error('[zcode-expand] 面板 IPC 桥暴露失败：', error);
    }

    // ① 同步取外观 CSS —— 首帧之前就位，不会先闪官方画面
    const payloadCss = ipcRenderer.sendSync(CHANNEL_GET);
    const css = decodeState(payloadCss);
    whenReady(() => injectCss(css || ''));

    // ② 主进程重算外观后推过来
    ipcRenderer.on(CHANNEL_CSS, (_event, payload) => {
      const next = decodeState(payload);
      if (next !== null) whenReady(() => injectCss(next));
    });

    // ③ 功能模块注入主世界（垫片用 webFrame.executeJavaScript，落在主世界）
    const runtime = ipcRenderer.sendSync(CHANNEL_GET_RUNTIME);
    const sources = (runtime && runtime.sources) || [];
    if (sources.length) {
      webFrame.executeJavaScript(buildShim(sources)).catch((error) => {
        console.error('[zcode-expand] 功能模块注入失败：', error);
      });
    }

    // ④ 外观中心面板：由主进程推事件开合
    ipcRenderer.on(CHANNEL_PANEL_OPEN, () => {
      webFrame.executeJavaScript('window.__ZC_EXPAND_PANEL__ && window.__ZC_EXPAND_PANEL__.open()')
        .catch((error) => console.error('[zcode-expand] 面板打开失败：', error));
    });
    ipcRenderer.on(CHANNEL_PANEL_CHANGED, () => {
      webFrame.executeJavaScript('window.__ZC_EXPAND_PANEL__ && window.__ZC_EXPAND_PANEL__.refresh()')
        .catch(() => { /* 面板没挂上就算了 */ });
    });

    // 面板把错误回传到主进程日志（打包版没有 DevTools）
    try {
      window.addEventListener('error', (event) => {
        const message = event && event.message;
        if (typeof message === 'string' && message.includes('zcode-expand')) {
          ipcRenderer.send(CHANNEL_PANEL_LOG, message);
        }
      });
    } catch { /* 仅日志 */ }
  }
} catch (error) {
  // 绝不让 preload 的失败影响 ZCode 自己的页面
  console.error('[zcode-expand] preload 异常：', error);
}
