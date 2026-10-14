// ZCode-Expand 桌宠 · 主进程侧服务
//
// 桌宠开着的时候跟随 ZCode 的日志，并接住 ZCode 的卡片通知，情绪变了就推一次。
// 不 import electron：main.mjs 只负责把 IPC 接进来。**不额外起进程、不开端口**，
// 轮询就发生在主进程自己身上；对 ZCode 的文件只读。
//
// ---------------------------------------------------------------------------
// 调用方（src/runtime/main.mjs）该怎么用
// ---------------------------------------------------------------------------
//
//   import { createPetService, petPushExpression, petMaskExpression } from './pet/service.mjs';
//   import { petPaths, resolvePetAssets } from './pet/assets.mjs';
//   import { zcodeLogDir } from './pet/log-tail.mjs';
//   import { resolvePet, desktopPetAvailability } from './pet/spec.mjs';
//
//   // 1) 素材：用户没放就 ok:false，此时桌宠整体不开（不报错）
//   const { dir, position } = petPaths();
//   const found = resolvePetAssets({ dir });
//   for (const note of found.notes) log(`pet: ${note}`);
//
//   // 2) 服务
//   const pet = createPetService({
//     assets: found.ok ? found.assets : null,   // 传 null 也行：内部按「没素材」处理
//     logDir: zcodeLogDir(),
//     log,
//     send(payload) {
//       // 推给每一个显示桌宠的页面（ZCode 主窗口 + 桌面模式小窗）
//       for (const contents of [...renderers, ...(desktopPage ? [desktopPage] : [])]) {
//         if (contents.isDestroyed()) continue;
//         try {
//           // push 表达式用 executeJavaScript 注入主世界；U+2028/2029 已按 zc-usage.mjs 的惯例转义
//           contents.executeJavaScript(petPushExpression(payload), true).catch(() => {});
//         } catch (error) { log(`pet update failed: ${String(error)}`); }
//       }
//     },
//   });
//
//   // 3) 设置（开关从哪来由你定：环境变量 / store / 设置项都行）
//   pet.configure(resolvePet({ enabled: true, desktop: true }, true, desktopPetAvailability(process.platform) !== 'unavailable'));
//
//   // 4) 新窗口加载完要把当前状态补推一次（渲染层没有反向 IPC，只能靠推）。
//   //    内联图（petMaskExpression）也在这里推：每个窗口一次就够，透明处不挡鼠标靠它。
//   const maskJs = petMaskExpression(found.ok ? found.mask : null);
//   contents.on('did-finish-load', () => {
//     try {
//       contents.executeJavaScript(petPushExpression(pet.payload()), true).catch(() => {});
//       if (maskJs) contents.executeJavaScript(maskJs, true).catch(() => {});
//     } catch {}
//   });
//
//   // 5) 旁听 ZCode 自己的 IPC：在 ZCode 自己的监听器看到之前截一份，原样放行
//   const ZCODE_SHOW_TASK_NOTIFICATION = 'zcode:show-task-notification';
//   //（挂在你已有的 IPC 包装里）
//   if (channel === ZCODE_SHOW_TASK_NOTIFICATION) pet.prompt(args[0]);
//
// 桌面模式（另一个置顶透明小窗）另见 desktop.mjs；它由 createDesktopPet({electron, ...}).sync(pet, mainPages) 驱动。
// ---------------------------------------------------------------------------

import { createMoodStabilizer, createPetTracker, parseLogLine, parsePromptNotification, PET_TIMING } from './mood.mjs';
import { encodePet, resolvePet } from './spec.mjs';
import { createLogTail } from './log-tail.mjs';

// executeJavaScript 的字符串字面量必须是合法 JS：JSON.stringify 不转义 U+2028/2029
// （合法 JSON、非法 JS 行终结符），任意文本都可能携带 → 必须显式转义。
// 与 src/main/zc-usage.mjs 里的同名函数是刻意各留一份（两侧注入位置不同，不跨文件 import）。
const U2028 = String.fromCharCode(0x2028);
const U2029 = String.fromCharCode(0x2029);

/**
 * 把载荷包成一条可在渲染层主世界执行的表达式，给 `webContents.executeJavaScript` 用。
 * 渲染层模块 `src/runtime/renderer/pet.js` 会挂上 `window.__ZC_PET__`。
 * @param {import('./spec.mjs').PetPayload} payload
 * @returns {string}
 */
export function petPushExpression(payload) {
  return `window.__ZC_PET__&&window.__ZC_PET__.push(${escapeJs(JSON.stringify(payload))})`;
}

/**
 * 把角色图的内联 data: URL 包成一条表达式。**每个窗口加载后推一次就够**，不要放进每次
 * 情绪变化的载荷里（一张图 base64 之后每次都推会让推送变重）。渲染层用它建 alpha 掩码，
 * 没有它桌宠就退化成"整块矩形可点"（透明处会挡鼠标）。原因见 pet/assets.mjs 的文件头。
 * @param {string|null} mask  resolvePetAssets 的 mask 字段；null 表示不推
 * @returns {string|null}
 */
export function petMaskExpression(mask) {
  if (!mask) return null;
  return `window.__ZC_PET__&&window.__ZC_PET__.image(${escapeJs(JSON.stringify(mask))})`;
}

/**
 * executeJavaScript 的字符串字面量必须是合法 JS：JSON.stringify 不转义 U+2028/2029
 * （合法 JSON、非法 JS 行终结符），任意文本都可能携带 → 必须显式转义。
 * 与 src/main/zc-usage.mjs 里的同名函数是刻意各留一份（两侧注入位置不同，不跨文件 import）。
 * @param {string} json
 * @returns {string}
 */
function escapeJs(json) {
  return json.split(U2028).join('\\u2028').split(U2029).join('\\u2029');
}

/**
 * @typedef {object} PetServiceDeps
 * @property {import('./spec.mjs').PetAssets|null} assets  素材；null / 缺 image 时服务整体保持关闭
 * @property {string} logDir  ZCode 日志目录（zcodeLogDir()）
 * @property {(payload: import('./spec.mjs').PetPayload) => void} send  把载荷交给调用方推送
 * @property {(message: string) => void} log
 * @property {number} [pollMs]  轮询间隔，默认 500ms
 * @property {() => number} [now]  取时间，便于测试
 */

/**
 * 建桌宠服务。开着的时候每次轮询：读日志新增行 → 更新状态机 → 情绪有变化才推。
 * 每个可能失败的地方自己兜住：读日志、解析、推送都不允许把异常冒到调用方。
 * @param {PetServiceDeps} deps
 */
export function createPetService({ assets, logDir, send, log, pollMs = 500, now = Date.now }) {
  /** 素材是否可用：不可用则永不开机（不显示，也不记错误，只记一条提示） */
  const usable = !!(assets && assets.image);
  let pet = resolvePet(undefined);
  /** @type {import('./mood.mjs').PetMood} */
  let mood = 'idle';
  /** @type {{tracker: ReturnType<typeof createPetTracker>, stabilize: ReturnType<typeof createMoodStabilizer>, tail: ReturnType<typeof createLogTail>, timer: ReturnType<typeof setInterval>}|null} */
  let running = null;
  let lastError = '';
  let warnedNoAssets = false;

  /** 当前要给页面的载荷 */
  const payload = () => encodePet(pet, mood, usable ? assets : { image: '', sounds: {} });

  function tick() {
    if (!running) return;
    try {
      running.tail.poll();
      const next = running.stabilize(running.tracker.mood(now()), now());
      lastError = '';
      if (next === mood) return;
      mood = next;
      send(payload());
    } catch (error) {
      // 同一条错误只记一次，避免日志被刷爆
      if (String(error) !== lastError) log(`pet unavailable: ${(lastError = String(error))}`);
    }
  }

  function start() {
    const tracker = createPetTracker();
    const tail = createLogTail(logDir, (line) => {
      const event = parseLogLine(line);
      if (event) tracker.ingest(event, now());
    });
    const timer = setInterval(tick, pollMs);
    timer.unref?.();
    running = { tracker, stabilize: createMoodStabilizer(PET_TIMING.holdMs), tail, timer };
    tick();
  }

  function stop() {
    if (running) clearInterval(running.timer);
    running = null;
    mood = 'idle';
  }

  /** 关掉时也发一次：让页面立刻把桌宠藏起来 */
  function push() {
    try {
      send(payload());
    } catch (error) {
      log(`pet push failed: ${String(error)}`);
    }
  }

  return {
    /**
     * 应用归一化后的设置；按需开始 / 停止跟随日志。
     * @param {import('./spec.mjs').ResolvedPet} next
     */
    configure(next) {
      // 没素材就当没开：不启动轮询、不推 enabled:true
      const wanted = usable ? next : { ...next, enabled: false };
      if (wanted.enabled && !usable && !warnedNoAssets) {
        warnedNoAssets = true;
        log('pet: 未提供可用素材，桌宠保持关闭（目录约定见 pet/assets.mjs，放好素材后重启即生效）');
      }
      if (JSON.stringify(wanted) === JSON.stringify(pet)) return;
      pet = wanted;
      if (pet.enabled && !running) start();
      if (!pet.enabled && running) stop();
      push();
    },
    /**
     * ZCode 的 `zcode:show-task-notification` 载荷（在它去 ZCode 自己监听器的路上截一份）
     * @param {unknown} raw
     */
    prompt(raw) {
      if (!running) return;
      try {
        const event = parsePromptNotification(raw);
        if (event) running.tracker.ingest(event, now());
        tick();
      } catch (error) {
        log(`pet prompt failed: ${String(error)}`);
      }
    },
    /** 当前载荷（新窗口加载完 / 渲染层主动要的时候用） */
    payload,
    /** 自检信息（主进程 DevTools 里看一眼就够） */
    status() {
      return { usable, running: !!running, enabled: pet.enabled, desktop: pet.desktop, mood, lastError, logDir };
    },
  };
}
