// ZCode-Expand 桌宠 · 设置解析与载荷编解码（主进程侧，纯函数）
//
// 不 import electron / node：主进程、桌面页、渲染层模块都按同一套字段说话。
//
// 与参考实现（zcode-canvas 的 shared/pet.ts）的差别：
//   · 协议版本号在这里独立定义（`PET_PROTOCOL_VERSION`），渲染层脚本
//     `src/runtime/renderer/pet.js` 里有一份副本——没有构建步骤，两边只能靠注释对齐，
//     改一处必须改另一处（grep `PET_PROTOCOL_VERSION` 能同时找到）。
//   · 设置解析（resolvePet）保留，但**开关由调用方决定**：本仓库没有 config.json，
//     main.mjs 从哪取值（环境变量 / store / 设置项）由调用方定，这里只做归一化与限幅。

import { PET_MOODS } from './mood.mjs';

/** 载荷协议版本。渲染层与主进程升级不同步时，版本不符就忽略，等下个版本对齐。 */
export const PET_PROTOCOL_VERSION = 1;

/**
 * 音效档位的名字。素材目录里就是 `sounds/<名字>/press.*` 与 `sounds/<名字>/release.*`
 * @typedef {'duck'|'fx1'} PetSound
 */

/** @type {readonly PetSound[]} */
export const PET_SOUNDS = ['duck', 'fx1'];

/** 缩放范围与默认值 */
export const PET_SCALE = { min: 0.6, max: 2.5, step: 0.1, fallback: 1.5 };

/** 音量默认值（0 为静音） */
const PET_VOLUME_FALLBACK = 0.9;

/**
 * 设置项原样形状（都是可选的，缺省即默认）
 * @typedef {object} PetSpec
 * @property {boolean} [enabled]  默认关；要显示桌宠必须显式 true
 * @property {number} [scale]
 * @property {number} [volume]  0 静音
 * @property {PetSound} [sound]
 * @property {boolean} [bubble]  点击时、以及 agent 需要你时说话
 * @property {boolean} [desktop]  桌面模式：一个置顶透明小窗，而不是每个 ZCode 窗口里一只
 */

/**
 * 归一化后的设置
 * @typedef {object} ResolvedPet
 * @property {boolean} enabled
 * @property {number} scale
 * @property {number} volume
 * @property {PetSound} sound
 * @property {boolean} bubble
 * @property {boolean} desktop  生效的桌面模式：用户要了、且本平台支持
 */

/**
 * 桌面模式只在 Windows / macOS 提供：Wayland 下 Linux 应用放不了自己的窗口，
 * 而且 Linux 也没有「只有透明部分点击穿透」这套。
 * @param {string} platform
 * @returns {boolean}
 */
export function desktopPetSupported(platform) {
  return platform === 'win32' || platform === 'darwin';
}

/**
 * "forced"：在不提供桌面模式的平台上（Linux），用 ZCODE_EXPAND_PET_DESKTOP=force 强开，
 * 方便在真机上试。程序自己永远不会设置它，也不会持久化；在支持的平台上它没有作用。
 * @typedef {'supported'|'forced'|'unavailable'} DesktopPetAvailability
 */

/**
 * @param {string} platform
 * @param {Record<string, string|undefined>} [env]
 * @returns {DesktopPetAvailability}
 */
export function desktopPetAvailability(platform, env = {}) {
  if (desktopPetSupported(platform)) return 'supported';
  return env.ZCODE_EXPAND_PET_DESKTOP === 'force' ? 'forced' : 'unavailable';
}

/**
 * 桌宠方形盒子的边长（px）。参考 fox widget 的 --zcw-base：
 * 先取窗口短边的 28%（不超过 250px），再乘缩放，最后夹在 122 ~ 625px。
 * @param {number} width
 * @param {number} height
 * @param {number} scale
 * @returns {number}
 */
export function petBase(width, height, scale) {
  return Math.min(625, Math.max(122, Math.min(250, Math.min(width, height) * 0.28) * scale));
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clamp(value, min, max, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/**
 * 归一化设置。`canvasEnabled` 为 false（总开关关闭）时桌宠一并隐藏；
 * `desktopAvailable` 为 false（见 desktopPetSupported）时桌宠只待在窗口里。
 * @param {unknown} spec
 * @param {boolean} [canvasEnabled]
 * @param {boolean} [desktopAvailable]
 * @returns {ResolvedPet}
 */
export function resolvePet(spec, canvasEnabled = true, desktopAvailable = false) {
  const own = spec && typeof spec === 'object' && !Array.isArray(spec) ? /** @type {PetSpec} */ (spec) : {};
  return {
    enabled: canvasEnabled && own.enabled === true,
    scale: Math.round(clamp(own.scale, PET_SCALE.min, PET_SCALE.max, PET_SCALE.fallback) * 10) / 10,
    volume: clamp(own.volume, 0, 1, PET_VOLUME_FALLBACK),
    sound: PET_SOUNDS.includes(own.sound) ? own.sound : 'duck',
    bubble: own.bubble !== false,
    desktop: desktopAvailable && own.desktop === true,
  };
}

/**
 * 桌宠的素材：主进程解析出来的 file:// URL。
 * 图片与音效都是**用户自己放**的第三方素材，仓库里不带任何一份。
 * @typedef {object} PetAssets
 * @property {string} image  角色图（file:// URL）
 * @property {Record<string, {press: string, release: string}>} sounds  音效档位；某一档缺失就是两个空串
 */

/**
 * 推给页面的载荷。带版本号：runtime 在磁盘上被升级后，新页面可能撞上还在跑的老主进程。
 * @typedef {object} PetPayload
 * @property {number} v
 * @property {ResolvedPet} pet
 * @property {PetMood} mood
 * @property {PetAssets} assets
 */

/**
 * @param {ResolvedPet} pet
 * @param {import('./mood.mjs').PetMood} mood
 * @param {PetAssets} assets
 * @returns {PetPayload}
 */
export function encodePet(pet, mood, assets) {
  return { v: PET_PROTOCOL_VERSION, pet, mood, assets };
}

/**
 * 解载荷；版本不符（或形状不对）返回 null——不认识的载荷宁可不显示。
 * @param {unknown} payload
 * @returns {{pet: ResolvedPet, mood: import('./mood.mjs').PetMood, assets: PetAssets}|null}
 */
export function decodePet(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const { v, pet, mood, assets } = /** @type {Partial<PetPayload>} */ (payload);
  if (v !== PET_PROTOCOL_VERSION || !pet || !assets || !PET_MOODS.includes(mood)) return null;
  // 桌面模式是否生效由主进程决定，这里只看形状
  return { pet: resolvePet(pet, true, true), mood, assets };
}

/**
 * 面板「桌宠」那一节要的全部事实，一处算好给渲染层。
 *
 * 为什么要有它：**"放好素材"和"开不开"是两件事**——素材只决定能不能显示，`enabled` 才决定
 * 显不显示。这两条面板都得摆出来，否则用户就会遇到"图片放了、日志说找到了、就是不出来、
 * 也没地方开"（2026-10-14 实测踩过）。渲染层不重抄 PET_SCALE / PET_SOUNDS / 平台判断，只消费这里。
 *
 * @param {object} options
 * @param {boolean} options.assetsReady  角色图找到了没有（启动时解析一次）
 * @param {unknown} options.spec          config.pet 原样
 * @param {string} options.dir            素材目录（给提示文案用；由调用方给，避免 spec 反向依赖 assets）
 * @param {string} options.platform
 * @param {Record<string, string|undefined>} [options.env]
 */
export function petStatus({ assetsReady, spec, dir, platform, env = {} }) {
  const desktopAvailable = desktopPetAvailability(platform, env) !== 'unavailable';
  const wanted = resolvePet(spec, true, desktopAvailable).enabled;
  // 提示一次只说最要紧的那条：先"没素材"，再"平台不支持"，最后才是"还没打开"
  let hint = '';
  if (!assetsReady) hint = `没找到角色图：把 pet.png（建议背景透明的 PNG）放进 ${dir}，放好后重启 ZCode 生效`;
  else if (!desktopAvailable) hint = '这个平台用不了桌面模式，桌宠只在窗口里';
  else if (!wanted) hint = '打开后 AI 思考、干活、等你时它会有反应';
  return {
    assetsReady,
    dir,
    desktopAvailable,
    scale: { ...PET_SCALE },
    sounds: [...PET_SOUNDS],
    // 面板画控件时用这些当缺省，免得渲染层再抄一遍 1.5 / 0.9
    defaults: resolvePet(undefined, true, desktopAvailable),
    hint,
  };
}
