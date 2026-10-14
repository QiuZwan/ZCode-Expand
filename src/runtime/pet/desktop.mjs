// ZCode-Expand 桌宠 · 桌面模式（主进程侧）
//
// 全 ZCode 只有一只桌宠，住在自己那个小的、透明的、永远置顶的窗口里，于是 ZCode 最小化、
// 收进托盘、被别的窗口盖住时她还在。electron 由外部注入而不是 import，这样窗口生命周期
// 能在 ZCode 外面测。
//
// 为什么这么做（几条踩出来的边界）：
//   · 用 BaseWindow 而不是 BrowserWindow：ZCode 会从 BrowserWindow.getAllWindows() 里挑窗口
//     （最后一个窗口、OAuth 与更新兜底），还监听 browser-window-created；BaseWindow 对这一切不可见。
//   · BaseWindow 会让 window-all-closed 不触发，所以最后一个 ZCode 主页面关掉时桌宠必须先走
//     （sync 传 mainPages = 0），而且永远不拦 close 事件。
//   · 用自己的一次性 session partition：不挂本仓库的 preload、不挂 ZCode 的 preload，
//     ZCode 注入到每个页面的遥测脚本也就没有通道可用。
//   · WebContentsView 的 webContents 活得比窗口久，在 "closed" 里显式关掉它。
//
// 调用方（src/runtime/main.mjs）该怎么用：
//
//   import { BaseWindow, WebContentsView, ipcMain, powerMonitor, screen } from 'electron';
//   import { createDesktopPet } from './pet/desktop.mjs';
//
//   let desktop = null;
//   function syncDesktopPet() {
//     try {
//       if (!desktop) {
//         if (!state.pet.enabled || !state.pet.desktop || renderers.size === 0) return;
//         desktop = createDesktopPet({
//           electron: { BaseWindow, WebContentsView, screen, ipcMain, powerMonitor },
//           page: join(HOME, 'runtime', 'pet', 'desktop.html'),
//           preload: join(HOME, 'runtime', 'pet', 'desktop-preload.cjs'),
//           positionFile: petPaths().position,
//           log,
//           payload: pet.payload,          // 初始状态由本模块自己补推，页面不会停在空白
//           mask: found.mask,              // alpha 掩码的内联图（可省：省了就是整块矩形可点）
//         });
//       }
//       desktop.sync(state.pet, renderers.size);
//     } catch (error) { log(`desktop pet unavailable: ${String(error)}`); }
//   }
//   // 设置变了、或主窗口集合变了都要调一次；主窗口 destroyed 时**同步**调（ZCode 马上要检查是不是最后一个窗口）
//   // pet 的 send() 里要带上 desktop.contents()，后续的情绪变化才推得到小窗。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  boundsFromPosition,
  chooseArea,
  facesLeft,
  parseDesktopPosition,
  positionFromBounds,
  snapToArea,
} from './desktop-position.mjs';
import { decidePointer, parsePointerReport, POINTER_TIMING, probePoint } from './pointer.mjs';
import { petBase } from './spec.mjs';
import { petMaskExpression, petPushExpression } from './service.mjs';
import {
  CHANNEL_PET_DRAG,
  CHANNEL_PET_FACING,
  CHANNEL_PET_LOG,
  CHANNEL_PET_POINTER,
  CHANNEL_PET_PROBE,
} from './channels.mjs';

export const DESKTOP_PET_PARTITION = 'zcode-expand-pet';

/**
 * 桌面模式用到的 electron 部件（注入而不是 import）
 * @typedef {object} DesktopPetElectron
 * @property {*} BaseWindow
 * @property {*} WebContentsView
 * @property {*} screen
 * @property {*} ipcMain
 * @property {*} powerMonitor
 */

/**
 * @typedef {object} DesktopPetDeps
 * @property {DesktopPetElectron} electron
 * @property {string} page  桌宠页（desktop.html）的路径
 * @property {string} preload  桌宠页的 preload（desktop-preload.cjs）路径
 * @property {string} positionFile  位置存哪：本仓库自己的目录，不用 localStorage
 * @property {(message: string) => void} log
 * @property {() => import('./spec.mjs').PetPayload} payload  取当前载荷，用于页面加载完后的补推
 * @property {string|null} [mask]  角色图的内联 data: URL（resolvePetAssets 的 mask），同样在加载完后推一次
 * @property {string} [platform]
 */

/** 窗口属性：点击她不能把系统焦点带到 ZCode 不认识的窗口上，所以 focusable:false */
export const DESKTOP_WINDOW_OPTIONS = {
  frame: false,
  transparent: true,
  focusable: false,
  skipTaskbar: true,
  resizable: false,
  maximizable: false,
  minimizable: false,
  fullscreenable: false,
  hasShadow: false,
  show: false,
};

/**
 * macOS 上用非激活面板：Electron 的 "panel" 类型能浮在全屏应用之上、出现在每个 Space。
 * 没用 setVisibleOnAllWorkspaces({visibleOnFullScreen})：那个会把整个应用临时变成 UI element
 * 再变回来，每调一次 ZCode 自己的窗口与 Dock 图标都会闪一下。
 * @param {string} platform
 * @returns {Record<string, unknown>}
 */
export function desktopWindowOptions(platform) {
  return platform === 'darwin' ? { ...DESKTOP_WINDOW_OPTIONS, type: 'panel' } : { ...DESKTOP_WINDOW_OPTIONS };
}

/**
 * @typedef {object} ShownPet
 * @property {*} win
 * @property {*} contents
 * @property {number} scale
 * @property {number} size
 * @property {import('./pointer.mjs').PointerReport|null} report
 * @property {import('./pointer.mjs').PointerState} pointer
 * @property {import('./pointer.mjs').PointerMode|null} applied
 * @property {{cursor: {x: number, y: number}, bounds: {x: number, y: number, width: number, height: number}, at: number}|null} drag
 * @property {ReturnType<typeof setInterval>[]} timers
 */

/**
 * @param {DesktopPetDeps} deps
 */
export function createDesktopPet({ electron, page, preload, positionFile, log, payload, mask = null, platform = process.platform }) {
  const { BaseWindow: Window, WebContentsView: View, screen } = electron;
  /** @type {ShownPet|null} */
  let shown = null;
  /** @type {{scale: number}|null} */
  let wanted = null;

  /**
   * 把动作包一层：任何异常只记日志，绝不冒到调用方（更不许影响 ZCode）
   * @param {string} where
   * @param {Function} action
   * @returns {Function}
   */
  const guard = (where, action) => (...args) => {
    try {
      action(...args);
    } catch (error) {
      log(`desktop pet ${where}: ${String(error)}`);
    }
  };

  /** @returns {import('./desktop-position.mjs').DesktopPetPosition} */
  function readPosition() {
    try {
      return parseDesktopPosition(JSON.parse(readFileSync(positionFile, 'utf8')));
    } catch {
      return parseDesktopPosition(null);
    }
  }

  /** @param {import('./desktop-position.mjs').DesktopPetPosition} position */
  function savePosition(position) {
    try {
      mkdirSync(dirname(positionFile), { recursive: true });
      const tmp = `${positionFile}.tmp-${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify(position)}\n`);
      renameSync(tmp, positionFile);
    } catch (error) {
      log(`desktop pet position not saved: ${String(error)}`);
    }
  }

  /**
   * @param {ShownPet} target
   * @param {import('./pointer.mjs').PointerMode} mode
   */
  function apply(target, mode) {
    if (target.applied === mode || target.win.isDestroyed()) return;
    target.applied = mode;
    if (mode === 'interactive') target.win.setIgnoreMouseEvents(false);
    else if (mode === 'forward') target.win.setIgnoreMouseEvents(true, { forward: true });
    else target.win.setIgnoreMouseEvents(true);
  }

  /**
   * 只有轮询来的那次才 probe：页面回复会再触发一次判定，不能在 IPC 速度上反复问
   * @param {ShownPet|null} [target]
   * @param {boolean} [probe]
   */
  function evaluate(target = shown, probe = false) {
    if (!target || target.win.isDestroyed()) return;
    if (target.drag && Date.now() - target.drag.at > POINTER_TIMING.dragHoldMs) target.drag = null;
    const inputs = {
      cursor: screen.getCursorScreenPoint(),
      window: target.win.getContentBounds(),
      report: target.report,
      dragging: !!target.drag,
    };
    target.pointer = decidePointer(inputs, target.pointer);
    apply(target, target.pointer.mode);
    const point = probe ? probePoint(inputs, target.pointer) : null;
    if (point && !target.contents.isDestroyed()) target.contents.send(CHANNEL_PET_PROBE, point);
  }

  /**
   * 原生状态可能悄悄失效（electron#33281），隔一段时间从头设一遍
   * @param {ShownPet|null} [target]
   */
  function reissue(target = shown) {
    if (!target) return;
    target.applied = null;
    evaluate(target);
  }

  /**
   * @param {ShownPet} target
   * @param {import('./desktop-position.mjs').DesktopPetPosition} position
   */
  function sendFacing(target, position) {
    if (!target.contents.isDestroyed()) target.contents.send(CHANNEL_PET_FACING, facesLeft(position));
  }

  /** 把当前载荷补推给小窗（页面加载完、以及创建之后） */
  function sendPayload(target = shown) {
    if (!target || target.contents.isDestroyed()) return;
    const scripts = [petPushExpression(payload()), petMaskExpression(mask)];
    for (const script of scripts) {
      if (!script) continue;
      try {
        target.contents.executeJavaScript(script, true).catch(() => {});
      } catch (error) {
        log(`desktop pet payload: ${String(error)}`);
      }
    }
  }

  /** @param {number} scale */
  function create(scale) {
    const position = readPosition();
    const area = chooseArea(
      position,
      screen.getAllDisplays().map((display) => display.workArea),
      screen.getPrimaryDisplay().workArea,
    );
    const size = Math.round(petBase(area.width, area.height, scale));
    const bounds = boundsFromPosition(position, area, size);
    const win = new Window({ ...desktopWindowOptions(platform), ...bounds });
    /** @type {*} */
    let contents = null;
    try {
      // 分数缩放下新建的无边框窗口会被 Windows 凑整多几 px，显式再设一次
      win.setBounds(bounds);
      // ZCode 的 computer use 会截图并按坐标点击：她不能出现在里面
      win.setContentProtection(true);
      win.setIgnoreMouseEvents(true);
      const view = new View({
        webPreferences: { partition: DESKTOP_PET_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, preload },
      });
      contents = view.webContents;
      view.setBackgroundColor('#00000000');
      win.contentView.addChildView(view);
      const content = win.getContentBounds();
      view.setBounds({ x: 0, y: 0, width: content.width, height: content.height });
      /** @type {ShownPet} */
      const target = { win, contents, scale, size, report: null, pointer: { mode: 'through', near: false }, applied: 'through', drag: null, timers: [] };
      const owned = contents;
      win.on(
        'closed',
        guard('closed', () => {
          for (const timer of target.timers) clearInterval(timer);
          if (shown === target) shown = null;
          if (!owned.isDestroyed()) owned.close();
        }),
      );
      owned.setWindowOpenHandler(() => ({ action: 'deny' }));
      owned.on('will-navigate', (event) => event.preventDefault());
      owned.on(
        'render-process-gone',
        guard('crash', (_event, details) => {
          log(`desktop pet page gone (${details?.reason ?? 'unknown'}); hidden until the next change`);
          if (!win.isDestroyed()) win.destroy();
        }),
      );
      owned.once(
        'did-finish-load',
        guard('loaded', () => {
          if (win.isDestroyed()) return;
          win.setAlwaysOnTop(true, 'screen-saver');
          sendFacing(target, position);
          sendPayload(target);
          reissue(target);
        }),
      );
      const poll = setInterval(guard('poll', () => evaluate(target, true)), POINTER_TIMING.pollMs);
      const heal = setInterval(guard('reissue', () => reissue(target)), POINTER_TIMING.reissueMs);
      poll.unref?.();
      heal.unref?.();
      target.timers.push(poll, heal);
      shown = target;
      // 先 show 再 loadFile：在隐藏窗口里开始绘制的 WebContentsView 永远画不到屏幕上
      // （Windows + Electron 41 实测；参考实现在各平台都用这个顺序）。页面画出来之前，
      // 窗口是空的、透明的、点击穿透的。
      win.showInactive();
      win.setAlwaysOnTop(true, 'screen-saver');
      void owned.loadFile(page).catch(
        guard('load', (error) => {
          log(`desktop pet page failed to load: ${String(error)}; hidden until the next change`);
          if (!win.isDestroyed()) win.destroy();
        }),
      );
    } catch (error) {
      if (contents && !contents.isDestroyed()) contents.close();
      if (!win.isDestroyed()) win.destroy();
      throw error;
    }
  }

  function destroy() {
    const target = shown;
    shown = null;
    if (!target) return;
    for (const timer of target.timers) clearInterval(timer);
    if (!target.win.isDestroyed()) target.win.destroy();
    if (!target.contents.isDestroyed()) target.contents.close();
  }

  function recreate() {
    if (!shown || !wanted) return;
    const scale = wanted.scale;
    destroy();
    create(scale);
  }

  /** @param {*} event */
  const fromPage = (event) => !!shown && !shown.contents.isDestroyed() && event.sender === shown.contents;

  /**
   * 页面说拖拽状态变了。窗口移动由主进程按**真实光标**算：拖起来之后窗口跟着光标走，
   * 页面报的 dx/dy 立刻就没有意义了。
   * @param {unknown} kind
   */
  function drag(kind) {
    const target = shown;
    if (!target || target.win.isDestroyed()) return;
    if (kind === 'start') {
      target.drag = { cursor: screen.getCursorScreenPoint(), bounds: target.win.getBounds(), at: Date.now() };
      evaluate(target);
    } else if (kind === 'move' && target.drag) {
      const cursor = screen.getCursorScreenPoint();
      const { bounds } = target.drag;
      target.drag.at = Date.now();
      // 每次都带上尺寸：分数缩放下 setPosition 会让无边框窗口一次长 1px，而拖拽要调几百次
      target.win.setBounds({
        x: bounds.x + cursor.x - target.drag.cursor.x,
        y: bounds.y + cursor.y - target.drag.cursor.y,
        width: target.size,
        height: target.size,
      });
    } else if (kind === 'end' && target.drag) {
      target.drag = null;
      const current = { ...target.win.getBounds(), width: target.size, height: target.size };
      const area = screen.getDisplayMatching(current).workArea;
      const snapped = snapToArea(current, area);
      target.win.setBounds(snapped);
      const position = positionFromBounds(snapped, area);
      savePosition(position);
      sendFacing(target, position);
      reissue(target);
    }
  }

  // 只注册一次；每个都只回应"当前那只桌宠"的页面
  electron.ipcMain.on(
    CHANNEL_PET_POINTER,
    guard('pointer', (event, raw) => {
      if (!fromPage(event) || !shown) return;
      shown.report = parsePointerReport(raw);
      evaluate();
    }),
  );
  electron.ipcMain.on(
    CHANNEL_PET_DRAG,
    guard('drag', (event, kind) => {
      if (fromPage(event)) drag(kind);
    }),
  );
  electron.ipcMain.on(
    CHANNEL_PET_LOG,
    guard('log', (event, message) => {
      if (fromPage(event) && typeof message === 'string') log(`desktop pet page: ${message.slice(0, 1000)}`);
    }),
  );
  // 分辨率 / 缩放变了就按新几何重建，而不是去修补旧窗口
  screen.on('display-metrics-changed', guard('display', recreate));
  screen.on('display-added', guard('display', recreate));
  screen.on('display-removed', guard('display', recreate));
  electron.powerMonitor.on('resume', guard('resume', () => reissue()));

  return {
    /**
     * 该显示就显示（桌宠开着 + 桌面模式 + 至少有一个 ZCode 主页面），否则立刻销毁。
     * 没有主页面时必须**已经**销毁——ZCode 紧接着要判断"最后一个窗口是不是关了"。
     * @param {import('./spec.mjs').ResolvedPet} pet
     * @param {number} mainPages
     */
    sync: guard('sync', (pet, mainPages) => {
      wanted = pet.enabled && pet.desktop && mainPages > 0 ? { scale: pet.scale } : null;
      if (!wanted) return destroy();
      if (shown && shown.scale !== wanted.scale) destroy();
      if (!shown) create(wanted.scale);
    }),
    /** 桌宠页的 webContents（推载荷用）；没有就是 null */
    contents: () => (shown && !shown.contents.isDestroyed() ? shown.contents : null),
    /** 认身份不认 URL：只有这个 webContents 才算桌宠页 */
    isPage: (sender) => !!shown && !shown.contents.isDestroyed() && sender === shown.contents,
  };
}
