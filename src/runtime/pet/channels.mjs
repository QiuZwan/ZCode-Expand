// ZCode-Expand 桌宠 · 主进程 ↔ 桌面模式页面的通道名
//
// 只有桌面模式那个小窗用得到（窗口内的桌宠反过来推，见 service.mjs 的 petPushExpression）。
// 通道名在 src/runtime/pet/desktop-preload.cjs 里有一份**字面量副本**——那个文件必须是 CJS
// （sandbox 的 preload 只能是 CJS），而 Node 18 不能 require 一个 .mjs。改这里必须同步改那边。

/** 页面报告光标下是什么（命中角色图 / 气泡 / 都没有） */
export const CHANNEL_PET_POINTER = 'zcode-expand:pet-pointer';
/** 主进程让页面就某个点做一次命中测试（没有 mousemove 报告时） */
export const CHANNEL_PET_PROBE = 'zcode-expand:pet-probe';
/** 页面报告拖拽开始 / 移动 / 结束，由主进程移动窗口 */
export const CHANNEL_PET_DRAG = 'zcode-expand:pet-drag';
/** 主进程告诉页面朝哪边看 */
export const CHANNEL_PET_FACING = 'zcode-expand:pet-facing';
/** 页面把错误交给主进程记日志 */
export const CHANNEL_PET_LOG = 'zcode-expand:pet-log';
