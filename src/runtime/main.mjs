// ZCode-Expand 主进程运行时（部署到 ~/.zcode-expand/runtime/main.mjs）
//
// 由 out/zcode-expand/boot.mjs 在 ZCode 自己的主进程入口**之前**加载，
// 所以这里能拿到"ZCode 还没跑起来"的时间窗——主进程侧的挂钩都靠这个窗口。
//
// 能力：
//   · 外观层：算 CSS → 通过同步 IPC 交给 preload → 由它 insertCSS
//   · 渲染层注入：注册 preload，由它把功能模块注入主窗口的主世界
//   · 原生材质：setBackgroundMaterial / setVibrancy
//   · 实时生效：监听用户目录，改动去抖后重算并推给所有窗口
//   · 入口：应用菜单 / 托盘 / 面板快捷键
//
// 外观层的实现移植自 zcode-canvas（MIT），见 appearance/ 下各文件头部。
//
// 注意：boot.mjs 已经把这整段包在 try/catch 里，但这里仍然逐个能力自己再包一层——
// 单个能力失败不应该影响其它能力，更不应该影响 ZCode 启动。

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, watch } from 'node:fs';
import { join } from 'node:path';

import { buildCss } from './appearance/css.mjs';
import { expandHome, expandPaths, listThemes, loadLook, MATERIAL_PLATFORMS, MATERIALS, readConfig, videoKey } from './appearance/look.mjs';
import { registerPanelHandlers } from './appearance/panel.mjs';
import { petPaths, resolvePetAssets } from './pet/assets.mjs';
import { createDesktopPet } from './pet/desktop.mjs';
import { zcodeLogDir } from './pet/log-tail.mjs';
import { createPetService, petMaskExpression, petPushExpression } from './pet/service.mjs';
import { desktopPetAvailability, petStatus, resolvePet } from './pet/spec.mjs';

const HOME = expandHome();
const PATHS = expandPaths(HOME);
const LOG = PATHS.log;
const RENDERER_DIR = join(HOME, 'runtime', 'renderer');

/** 落到 runtime.log 的一行（打包版没有 DevTools，这是主进程侧唯一的可观测通道） */
export function log(message) {
  try {
    mkdirSync(HOME, { recursive: true });
    if ((statSync(LOG, { throwIfNoEntry: false })?.size ?? 0) > 512 * 1024) {
      try { renameSync(LOG, `${LOG}.old`); } catch { /* 轮转失败不影响写日志 */ }
    }
    appendFileSync(LOG, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // 记日志失败本身不值得再抛
  }
}

/**
 * 兜底：ZCode-Expand **绝不该把整个 ZCode 带走**。
 *
 * Node 碰到未捕获异常是「打印到 stderr → exit(1)」，而 ZCode 是 GUI 启动的、没有 stderr，
 * 用户看到的就只是"闪退"，且不留任何线索（2026-10-14 导入主题实测：日志里一条都没多）。
 * 所以这里：栈先写进 runtime.log；**来自我们自己目录的异常拦下来、ZCode 继续跑**；
 * 不是我们的照旧退出——别替别人的 bug 兜底。
 */
function guardProcess() {
  const describe = (value) => (value && value.stack ? value.stack : String(value));
  const ours = (text) => text.includes('zcode-expand');
  process.on('uncaughtException', (error) => {
    const text = describe(error);
    log(`未捕获异常：${text}`);
    if (!ours(text)) process.exit(1);
    log('上面的异常来自 ZCode-Expand，已拦下，ZCode 继续运行');
  });
  // Node 默认把未处理的拒绝升级成未捕获异常；这里只是先记账，仍然按同一条规则处理
  process.on('unhandledRejection', (reason) => {
    const text = describe(reason);
    log(`未处理的 Promise 拒绝：${text}`);
    if (!ours(text)) process.exit(1);
    log('上面的拒绝来自 ZCode-Expand，已拦下，ZCode 继续运行');
  });
}
guardProcess();

// 注入顺序有语义：面板（overlay）先挂上，用户随时能打开它调外观；
// 视频壁纸层跟着同步；备注与账号的界面模块最后。
const RENDERER_MODULES = ['overlay.js', 'wallpaper-video.js', 'pet.js', 'zc-remarks.js', 'zc-accounts.js'];

const CHANNEL_GET = 'zcode-expand:get';
const CHANNEL_CSS = 'zcode-expand:css';
const CHANNEL_PANEL_OPEN = 'zcode-expand:panel-open';
const CHANNEL_PANEL_CHANGED = 'zcode-expand:panel-changed';
const CHANNEL_PANEL_LOG = 'zcode-expand:panel-log';
const PANEL_ACCELERATOR = 'CommandOrControl+Alt+Shift+O';
const MENU_LABEL = 'ZCode-Expand 外观中心';
const TRAY_ITEM_LABEL = 'ZCode-Expand 外观中心';
const OFFICIAL_MATERIAL = 'acrylic';
const PROTOCOL_VERSION = 1;

const encodeState = (css) => ({ v: PROTOCOL_VERSION, css });
const decodeState = (payload) => {
  if (typeof payload === 'string') return payload;
  if (typeof payload !== 'object' || payload === null) return null;
  const { v, css } = payload;
  if (v !== PROTOCOL_VERSION || typeof css !== 'string') return null;
  return css;
};

// ------------------------------------------------------------------ 外观状态

/** @type {{css: string, material: string, video: string}} */
let state = { css: '', material: OFFICIAL_MATERIAL, video: '' };
const renderers = new Set();
const lastFocused = new Map();
let shortcutRecordingActive = false;
/** @type {null | {payload: Function, configure: Function, prompt: Function}} */
let pet = null;
/**
 * 桌宠的 alpha 掩码（内联 data: URL）。
 * 为什么要单独推：file:// 页面把 file:// 图片画进 canvas 后 getImageData 会抛 SecurityError，
 * 掩码建不起来，透明处就会挡鼠标。主进程另推一张 data: URL 专门建掩码（data: 继承文档源，可读），
 * 显示仍用省流量的 file://。见 pet/assets.mjs 与 renderer/pet.js。
 */
let petMask = null;

function compute(previous) {
  try {
    const { look, warnings } = loadLook(HOME);
    if (!look) return { css: '', material: OFFICIAL_MATERIAL, video: '' };
    const result = buildCss(look);
    for (const warning of [...warnings, ...result.warnings]) log(`warn: ${warning}`);
    return {
      css: result.css,
      material: MATERIALS.includes(look.glass.material) ? look.glass.material : OFFICIAL_MATERIAL,
      video: videoKey(look),
    };
  } catch (error) {
    // 编辑 config.json 时写到一半是常事，保持上一套好用的外观
    log(`config error, keeping previous look: ${String(error)}`);
    return previous;
  }
}

// ------------------------------------------------------------------ 渲染层模块

/** 读渲染层模块源码。每次现读，改完文件重启窗口就生效。 */
function readRendererSources() {
  const out = [];
  for (const name of RENDERER_MODULES) {
    const file = join(RENDERER_DIR, name);
    if (!existsSync(file)) continue;
    try {
      out.push({ name, code: readFileSync(file, 'utf8') });
    } catch (error) {
      log(`渲染层模块读取失败 ${name}：${String(error)}`);
    }
  }
  return out;
}

// ------------------------------------------------------------------ 去抖

function debounced(fn, waitMs) {
  let timer = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(); }, waitMs);
  };
}

// ------------------------------------------------------------------ 主流程

try {
  const electron = await import('electron');
  const { app, BaseWindow, BrowserWindow, Menu, MenuItem, Tray, WebContentsView, dialog, ipcMain, powerMonitor, screen, session, shell } = electron;

  log(`runtime 已加载：pid=${process.pid} electron=${process.versions.electron} zcode=${app.getVersion()}`);

  state = compute(state);

  const isMainWindowUrl = (url) => /app\.asar\/out\/renderer\/index\.html/.test(url || '');
  const senderIsMainWindow = (event) => {
    try {
      const frame = event.senderFrame;
      return !!frame && frame === event.sender.mainFrame && isMainWindowUrl(frame.url);
    } catch {
      return false;
    }
  };

  function applyMaterialTo(contents) {
    try {
      const win = BrowserWindow.fromWebContents(contents);
      if (!win || win.isDestroyed()) return;
      // 只有这两个平台能落地：Windows 用原生材质，macOS 用 vibrancy（Linux 上什么都不会发生）
      if (!MATERIAL_PLATFORMS.includes(process.platform)) return;
      if (process.platform === 'win32') win.setBackgroundMaterial(state.material);
      else win.setVibrancy(state.material === 'none' ? null : 'under-window');
    } catch (error) {
      log(`材质应用失败：${String(error)}`);
    }
  }

  function track(contents) {
    if (renderers.has(contents)) return;
    renderers.add(contents);
    // destroyed 时**同步**清：ZCode 紧接着就要检查"这是不是最后一个窗口"
    contents.once('destroyed', () => { renderers.delete(contents); syncDesktopPet(); });
    // 渲染层没有反向 IPC，桌宠状态只能靠推：新窗口加载完补推一次。
    // 掩码也在这一层推（每个窗口一次即可，不能放进 send——那是每次情绪变化都走的路径）。
    contents.on('did-finish-load', () => {
      try {
        if (pet) contents.executeJavaScript(petPushExpression(pet.payload()), true).catch(() => {});
        const mask = petMaskExpression(petMask);
        if (mask) contents.executeJavaScript(mask, true).catch(() => {});
      } catch (error) {
        log(`桌宠状态补推失败：${String(error)}`);
      }
    });
    setImmediate(syncDesktopPet);
  }

  function reload() {
    const next = compute(state);
    let nextPetSpec = petSpec;
    try {
      if (pet) {
        const cfg = readConfig(HOME);
        nextPetSpec = resolvePet(cfg.pet, cfg.enabled !== false, desktopPetAvailability(process.platform) !== 'unavailable');
      }
    } catch (error) {
      log(`桌宠配置解析失败：${String(error)}`);
    }

    const cssChanged = next.css !== state.css;
    const materialChanged = next.material !== state.material;
    const petChanged = JSON.stringify(nextPetSpec) !== JSON.stringify(petSpec);
    // 视频壁纸不进 CSS，必须单独比——否则「视频 A → 视频 B」会被下面这条早返回判成空操作
    const videoChanged = next.video !== state.video;
    state = next;

    // ⚠️ 空操作必须真的是空操作——不推、不重配、**尤其不写日志**。
    // 这条早返回是踩出来的：reload() 写的日志本身就在被监听的目录里，
    // 于是「重算 → 写日志 → 触发监听 → 再重算」成为自激循环。
    // 2026-10-14 实测：34 秒 204 次重算（约 6 次/秒），表现为面板点击要点好几次、
    // 下拉框弹出即闪退、鼠标悬浮指针闪烁、滚动卡顿——四个症状同一个根因。
    if (!cssChanged && !materialChanged && !petChanged && !videoChanged) return;

    if (pet && petChanged) {
      try {
        pet.configure(nextPetSpec);
      } catch (error) {
        log(`桌宠重配置失败：${String(error)}`);
      }
    }
    petSpec = nextPetSpec;
    syncDesktopPet();

    for (const contents of renderers) {
      if (contents.isDestroyed()) continue;
      try {
        if (cssChanged) contents.send(CHANNEL_CSS, encodeState(state.css));
        contents.send(CHANNEL_PANEL_CHANGED);
        if (materialChanged) applyMaterialTo(contents);
      } catch (error) {
        log(`外观推送失败：${String(error)}`);
      }
    }
    log(`外观已重算（css ${state.css.length} 字节，材质 ${state.material}${petChanged ? '，桌宠设置' : ''}${videoChanged ? '，视频壁纸' : ''}）`);
  }

  // 同步交付：preload 在文档开始时同步取走，保证首帧前样式就位
  ipcMain.on(CHANNEL_GET, (event) => {
    try {
      if (!senderIsMainWindow(event)) {
        log('get refused: sender is not ZCode 主窗口');
        event.returnValue = encodeState('');
        return;
      }
      track(event.sender);
      if (state.material !== OFFICIAL_MATERIAL) applyMaterialTo(event.sender);
      event.returnValue = encodeState(state.css);
    } catch (error) {
      log(`get failed: ${String(error)}`);
      event.returnValue = encodeState('');
    }
  });

  // 渲染层功能模块（备注 / 账号）走这条
  ipcMain.on('zcode-expand:get-runtime', (event) => {
    try {
      if (!senderIsMainWindow(event)) {
        event.returnValue = { sources: [] };
        return;
      }
      event.returnValue = { sources: readRendererSources() };
    } catch (error) {
      log(`交付渲染层模块失败：${String(error)}`);
      event.returnValue = { sources: [] };
    }
  });

  ipcMain.on(CHANNEL_PANEL_LOG, (event, message) => {
    try {
      if (senderIsMainWindow(event) && typeof message === 'string') log(`overlay: ${message.slice(0, 1000)}`);
    } catch { /* 记日志绝不影响宿主 */ }
  });

  // ------------------------------------------------------------------ 桌宠

  // 素材由用户自己放（不能把第三方素材打进仓库）：没放就整体不开，不报错
  let petSpec = null;
  let petAssetsReady = false;
  try {
    const found = resolvePetAssets({ dir: petPaths().dir });
    for (const note of found.notes) log(`pet: ${note}`);
    petAssetsReady = found.ok;
    petMask = found.ok ? found.mask : null;
    pet = createPetService({
      assets: found.ok ? found.assets : null,
      logDir: zcodeLogDir(),
      log,
      send(payload) {
        // 桌面模式那只小窗也要收，不然只有主窗口里那只跟着变
        const targets = desktop ? [...renderers, desktop.contents()] : [...renderers];
        for (const contents of targets) {
          if (!contents || (contents.isDestroyed && contents.isDestroyed())) continue;
          try {
            contents.executeJavaScript(petPushExpression(payload), true).catch(() => {});
          } catch (error) {
            log(`桌宠推送失败：${String(error)}`);
          }
        }
      },
    });
    const cfg = readConfig(HOME);
    petSpec = resolvePet(cfg.pet, cfg.enabled !== false, desktopPetAvailability(process.platform) !== 'unavailable');
    pet.configure(petSpec);
    log(`桌宠已就绪（素材${found.ok ? '已找到' : '缺失，桌宠不显示'}）`);
  } catch (error) {
    log(`桌宠初始化失败（已跳过，不影响其它功能）：${String(error)}`);
    pet = null;
  }

  /**
   * 桌面模式：全 ZCode 只有一只，住在一个透明置顶的 BaseWindow 里，
   * 所以 ZCode 最小化/收托盘/被盖住时她还在。见 pet/desktop.mjs 里的边界说明。
   */
  let desktop = null;
  function syncDesktopPet() {
    try {
      if (!pet || !petSpec) return;
      if (!desktop) {
        if (!petSpec.enabled || !petSpec.desktop || renderers.size === 0) return;
        desktop = createDesktopPet({
          electron: { BaseWindow, WebContentsView, screen, ipcMain, powerMonitor },
          page: join(HOME, 'runtime', 'pet', 'desktop.html'),
          preload: join(HOME, 'runtime', 'pet', 'desktop-preload.cjs'),
          positionFile: PATHS.petPosition,
          log,
          payload: () => pet.payload(),
          mask: petMask,
        });
      }
      desktop.sync(petSpec, renderers.size);
    } catch (error) {
      log(`桌面桌宠不可用（已跳过）：${String(error)}`);
    }
  }

  // ------------------------------------------------------------------ 面板入口

  function openPanel() {
    try {
      const focused = BrowserWindow.getFocusedWindow();
      const target = focused && isMainWindowUrl(focused.webContents.getURL())
        ? focused
        : BrowserWindow.getAllWindows()
          .filter((win) => !win.isDestroyed() && isMainWindowUrl(win.webContents.getURL()))
          .sort((a, b) => (lastFocused.get(b.webContents.id) ?? 0) - (lastFocused.get(a.webContents.id) ?? 0))[0];
      if (target) {
        if (target.isMinimized()) target.restore();
        target.show();
        target.focus();
        target.webContents.send(CHANNEL_PANEL_OPEN);
      } else {
        void shell.openPath(HOME).catch((error) => log(`配置目录打开失败：${String(error)}`));
      }
    } catch (error) {
      log(`面板打开失败：${String(error)}`);
    }
  }

  const canvasMenuItem = () => new MenuItem({
    label: MENU_LABEL,
    submenu: [{ label: '打开外观中心', accelerator: shortcutRecordingActive ? undefined : PANEL_ACCELERATOR, click: openPanel }],
  });

  // ZCode 会在切语言、缩放、录快捷键、同步设置时整个重建应用菜单——
  // 换一个新 Menu 传给 setApplicationMenu，我们追加的项就被丢掉了。
  // runtime 先于 ZCode 入口加载，所以包住这个 setter 就能在每次换菜单时补回去。
  function wrapApplicationMenu() {
    const setApplicationMenu = Menu.setApplicationMenu.bind(Menu);
    Menu.setApplicationMenu = (menu) => {
      try {
        if (menu && !menu.items.some((item) => item.label === MENU_LABEL)) menu.append(canvasMenuItem());
      } catch (error) {
        log(`菜单注入失败：${String(error)}`);
      }
      return setApplicationMenu(menu);
    };
  }

  // Windows 上 ZCode 的窗口是无边框的，应用菜单根本看不见，托盘才是入口。
  // 托盘右键菜单同样是整体重建的（desktopTray.setContextMenu），所以照样包一层。
  function wrapTrayMenu() {
    if (process.platform !== 'win32') return;
    const proto = Tray.prototype;
    const setContextMenu = proto.setContextMenu;
    proto.setContextMenu = function setContextMenuWrapped(menu) {
      try {
        if (menu && !menu.items.some((item) => item.label === TRAY_ITEM_LABEL)) {
          // 放在「退出」**上面**，而不是追加到末尾。
          //
          // ZCode 的托盘模板（out/main/index.js）固定是：
          //   打开 ZCode / --- / 新建任务、打开工作区 / --- / 检查更新、关于 ZCode、导出日志 / --- / **退出**
          // 「退出」既没设 role，标签又跟着语言变（`tray.menu.quit` 查表），所以只能按位置认：
          // 跳过末尾可能多出来的分隔线之后，插在**最后一个非分隔项**之前——那一项就是「退出」。
          // 末尾真多出分隔线时也不会被顶到下面去。
          const items = menu.items;
          let quit = items.length - 1;
          while (quit >= 0 && items[quit].type === 'separator') quit -= 1;
          menu.insert(quit > 0 ? quit : items.length, new MenuItem({ label: TRAY_ITEM_LABEL, click: () => openPanel() }));
        }
      } catch (error) {
        log(`托盘菜单注入失败：${String(error)}`);
      }
      return setContextMenu.call(this, menu);
    };
  }

  /** 面板快捷键只在有 ZCode 窗口聚焦时生效，绝不做系统级热键（那会从别的应用手里抢组合键） */
  function installInWindowShortcut() {
    app.on('browser-window-created', (_event, window) => {
      try {
        window.webContents.on('before-input-event', (event, input) => {
          try {
            if (shortcutRecordingActive) return;
            if (!isMainWindowUrl(window.webContents.getURL())) return;
            const key = (input.key || '').toLowerCase();
            if (key !== 'o' || !input.alt || !input.shift) return;
            if (process.platform === 'darwin' ? !input.meta : !input.control) return;
            event.preventDefault();
            openPanel();
          } catch (error) {
            log(`快捷键处理失败：${String(error)}`);
          }
        });
        const id = window.webContents.id;
        window.on('focus', () => lastFocused.set(id, Date.now()));
        window.on('closed', () => lastFocused.delete(id));
      } catch (error) {
        log(`快捷键接线失败：${String(error)}`);
      }
    });
  }

  // ZCode 录快捷键时让位：否则用户永远没法把组合键绑给 ZCode 自己的命令。
  // 顺带旁听任务通知（卡片出现 = 在等用户），原样放行给 ZCode 自己的监听器。
  function observeZCodeIpc() {
    const observed = new Set(['zcode:set-shortcut-recording-active', 'zcode:show-task-notification']);
    const on = ipcMain.on.bind(ipcMain);
    ipcMain.on = (channel, listener) => on(channel, observed.has(channel)
      ? (event, ...args) => {
        try {
          if (channel === 'zcode:set-shortcut-recording-active' && typeof args[0] === 'boolean') shortcutRecordingActive = args[0];
          else if (channel === 'zcode:show-task-notification' && pet) pet.prompt(args[0]);
        } catch { /* 观察失败不影响原监听器 */ }
        return listener(event, ...args);
      }
      : listener);
  }

  async function pickWallpaperFile() {
    const owner = BrowserWindow.getFocusedWindow() ?? undefined;
    const options = {
      title: '选择壁纸（图片或视频）',
      properties: ['openFile'],
      filters: [
        { name: '图片与视频', extensions: ['png', 'jpg', 'jpeg', 'webp', 'avif', 'svg', 'gif', 'mp4', 'webm', 'mov', 'm4v'] },
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'avif', 'svg', 'gif'] },
        { name: '视频', extensions: ['mp4', 'webm', 'mov', 'm4v'] },
      ],
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  }

  /**
   * 另存为新主题：借系统保存框**选目录兼取名**。
   *
   * 不能用 window.prompt——Electron 把它硬桩成了抛异常（`prompt() is not supported.`，
   * 见 ZCode.exe 里编进去的 lib/renderer/window-setup），点了必然中断，表现为"没反应"。
   *
   * 返回的是**完整路径**：主题就写在用户选的地方。默认开在主题库目录，直接回车就是老行为；
   * 导航到 D:\ 也照写不误（`writeTheme` 同级暂存，跨盘 rename 不会抛 EXDEV）。
   * 系统对话框自己会问"目录已存在，是否替换"，所以这里不再自己做覆盖确认。
   */
  async function pickThemeSaveTarget(suggested) {
    const owner = BrowserWindow.getFocusedWindow() ?? undefined;
    // 建议名来自渲染层，去掉路径分隔符与控制字符再拼进 defaultPath
    const safe = String(suggested ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim().slice(0, 60) || '我的主题';
    const options = {
      title: '另存为新主题（选一个目录）',
      defaultPath: join(PATHS.userThemes, safe),
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    };
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
    return result.canceled || !result.filePath ? null : result.filePath;
  }

  /** 导入主题：选一个**文件夹**（里面要有 theme.json） */
  async function pickThemeFolder() {
    const owner = BrowserWindow.getFocusedWindow() ?? undefined;
    const options = { title: '选择一套主题文件夹（里面要有 theme.json）', properties: ['openDirectory'] };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  }

  const scheduleReload = debounced(reload, 150);

  registerPanelHandlers({
    home: HOME,
    ipc: ipcMain,
    log,
    pickWallpaperFile,
    pickThemeFolder,
    pickThemeSaveTarget,
    /**
     * 桌宠那一节要的事实，全在这儿算好给面板——素材在不在、桌面模式能不能用、各项默认值与提示。
     * 渲染层不重抄 PET_SCALE/PET_SOUNDS/平台判断，只消费结论（素材目录属于 pet 层，
     * 外观模型不该反过来依赖它，所以从这儿注入）。
     */
    petStatus: () => petStatus({
      assetsReady: petAssetsReady,
      spec: readConfig(HOME).pet,
      dir: petPaths().dir,
      platform: process.platform,
    }),
    reload: scheduleReload,
    isPanelSender: senderIsMainWindow,
  });

  // ------------------------------------------------------------------ 启动

  wrapApplicationMenu();
  wrapTrayMenu();
  installInWindowShortcut();
  observeZCodeIpc();

  app.once('ready', () => {
    try {
      const preload = join(HOME, 'runtime', 'preload.cjs');
      if (!existsSync(preload)) {
        log('preload.cjs 不存在，跳过渲染层注入');
      } else {
        session.defaultSession.registerPreloadScript({ id: 'zcode-expand', type: 'frame', filePath: preload });
        log('已注册渲染层 preload');
      }
    } catch (error) {
      log(`注册 preload 失败：${String(error)}`);
    }
    try {
      const menu = Menu.getApplicationMenu();
      if (menu && !menu.items.some((item) => item.label === MENU_LABEL)) {
        menu.append(canvasMenuItem());
        Menu.setApplicationMenu(menu);
      }
    } catch (error) {
      log(`菜单补注入失败：${String(error)}`);
    }
  });

  // 用户目录里任何改动（config.json / themes / imports）都触发一次去抖重算 —— 这就是"约 1 秒生效"。
  // 但**必须排除我们自己写的东西**（日志、桌宠位置、面板标记、原子写的临时文件），
  // 否则写入会触发监听、监听又触发写入。这是与 reload() 空操作早返回并列的第二道防线，
  // 两道都留着：万一将来又加了新的自写文件，还有一道能兜住。
  const OWN_OUTPUT = /(^|[\\/])(runtime\.log(\.old)?|pet-position\.json|\.open-panel|.*\.tmp-\d+)$/;
  try {
    mkdirSync(HOME, { recursive: true });
    watch(HOME, { recursive: true }, (_event, filename) => {
      if (filename && OWN_OUTPUT.test(String(filename))) return;
      scheduleReload();
    });
    log(`已监听 ${HOME}`);
  } catch (error) {
    log(`监听用户目录失败（改配置后需重启 ZCode 才生效）：${String(error)}`);
  }
} catch (error) {
  log(`runtime 自检失败：${String(error)}`);
}

// 对外句柄：供控制台自检（主进程 DevTools），也供后续能力挂载
globalThis.__ZC_EXPAND_RUNTIME__ = {
  version: 3,
  home: HOME,
  paths: PATHS,
  log,
  reload: () => { try { return state; } catch { return null; } },
  listThemes: () => { try { return listThemes(HOME).map((t) => t.id); } catch { return []; } },
  loadedAt: Date.now(),
};
