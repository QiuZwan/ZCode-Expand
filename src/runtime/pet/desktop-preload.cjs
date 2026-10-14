// ZCode-Expand 桌宠 · 桌面模式页面的 preload（只给 desktop.html 用）
//
// 这个页面在**自己的一次性 session partition** 里（desktop.mjs 的 DESKTOP_PET_PARTITION），
// 不挂本仓库的通用 preload、也不挂 ZCode 的。页面拿到的能力就这些：告诉它朝哪边看、
// 让它就某个点做一次命中测试；它往外报光标下是什么、拖拽状态、以及错误。
//
// 载荷不在这里转发：主进程用 executeJavaScript 直接调页面主世界的 window.__ZC_PET__.push()。
//
// 通道名在这里是**字面量副本**（sandbox 的 preload 只能是 CJS，Node 18 不能 require .mjs）。
// 真身在 src/runtime/pet/channels.mjs —— 改一处必须改两处。

const CHANNEL_POINTER = 'zcode-expand:pet-pointer';
const CHANNEL_PROBE = 'zcode-expand:pet-probe';
const CHANNEL_DRAG = 'zcode-expand:pet-drag';
const CHANNEL_FACING = 'zcode-expand:pet-facing';
const CHANNEL_LOG = 'zcode-expand:pet-log';

const { contextBridge, ipcRenderer } = require('electron');

try {
  contextBridge.exposeInMainWorld('__ZC_PET_PAGE__', {
    /** 主进程让它朝左边看（true）还是右边看（false） */
    onFacing(listener) {
      ipcRenderer.on(CHANNEL_FACING, (_event, left) => listener(left === true));
    },
    /** 没有 mousemove 报告光标位置时，主进程让它就这个点做一次命中测试 */
    onProbe(listener) {
      ipcRenderer.on(CHANNEL_PROBE, (_event, point) => {
        if (typeof point?.x === 'number' && typeof point.y === 'number' && Number.isFinite(point.x) && Number.isFinite(point.y)) {
          listener(point.x, point.y);
        }
      });
    },
    /** 光标下是角色图 / 气泡 / 都没有 */
    pointer(report) {
      ipcRenderer.send(CHANNEL_POINTER, report);
    },
    /** 拖拽开始 / 移动 / 结束：窗口由主进程移动 */
    drag(kind) {
      if (kind === 'start' || kind === 'move' || kind === 'end') ipcRenderer.send(CHANNEL_DRAG, kind);
    },
    /** 页面里的错误交给主进程记日志 */
    log(message) {
      if (typeof message === 'string') ipcRenderer.send(CHANNEL_LOG, message.slice(0, 1000));
    },
  });
} catch (error) {
  // 绝不让 preload 的失败影响这个页面以外的东西
  console.error('[zcode-expand] 桌宠 preload 异常：', error);
}
