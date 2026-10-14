// ZCode-Expand 桌宠 · 素材与路径（主进程侧，只读）
//
// **仓库里不带任何图片 / 音频素材**：参考实现用的那套（zcode-fox-widget 的狐狸图与音效）
// 是第三方素材，不随本仓库分发。素材由用户自己放到下面的目录里，找不到就当桌宠没开：
// 静默不显示，不报错、不写盘。
//
// 目录约定（默认 ~/.zcode-expand/pet/，可用 ZCODE_EXPAND_PET_DIR 覆盖）：
//
//   ~/.zcode-expand/pet/
//     pet.png                    ← 角色图，认这几种名字（.png 优先，也认 webp/gif/jpg/svg）
//     sounds/duck/press.mp3      ← 音效档位 duck：按下 / 松开各一个，认 mp3/m4a/ogg/wav
//     sounds/duck/release.mp3
//     sounds/fx1/press.mp3       ← 档位名就是设置里 sound 的取值（duck / fx1），缺档 = 这一档没声音
//     sounds/fx1/release.mp3
//
// 图片缺失 → ok:false，调用方不显示桌宠；音效缺失 → 只记一条 notes，桌宠照常显示但没有声音。
// 角色图建议是**背景透明**的 PNG：窗口内与桌面模式的「透明处不挡鼠标」靠它的 alpha 通道。
//
// ⚠️ 为什么还要单独给一份内联 data: URL（`mask`）：
//   页面是 file:// 的，而 file:// 页面把 file:// 的图片画进 canvas 之后 **getImageData 会抛
//   SecurityError**（Chromium 实测：`The canvas has been tainted by cross-origin data`），
//   于是 alpha 掩码建不起来，透明处就会挡住鼠标。
//   data: URL 继承文档源、不会被判定为跨源，掩码就能建（同一次实测确认）。
//   所以：显示用 file:// URL（每次推载荷都省），掩码用这份内联图——**每个窗口加载后推一次就够**，
//   不要放进每次情绪变化的载荷里（一张 1MB 的图 base64 之后每次都推会让推送变重）。

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PET_SOUNDS } from './spec.mjs';

/** 角色图的候选文件名，按顺序取第一个存在的 */
const IMAGE_NAMES = ['pet.png', 'pet.webp', 'pet.gif', 'pet.jpg', 'pet.jpeg', 'fox.png'];

/** 音效的候选扩展名，按顺序取第一个存在的 */
const SOUND_EXTS = ['mp3', 'm4a', 'ogg', 'wav'];

/** 内联掩码图的上限：超过就不做掩码（推送成本要可控），也不报错 */
const MASK_MAX_BYTES = 2 * 1024 * 1024;

/** 扩展名 → MIME（内联 data: URL 用得到） */
const MIME = {
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  svg: 'image/svg+xml',
};

/** ZCode-Expand 的用户目录。与 appearance/look.mjs 的 expandHome 同逻辑，刻意各留一份
 *  （那层是外观模型，桌宠不该依赖它；改规则要两边一起改）。 */
export function expandHome(env = process.env) {
  return env.ZCODE_EXPAND_HOME || join(homedir(), '.zcode-expand');
}

/**
 * 桌宠用到的两个路径。
 * 位置文件刻意**不放**在素材目录里：素材目录是用户自己维护的，不让程序往里写东西。
 * `position` 与 appearance/look.mjs 的 expandPaths().petPosition 是同一个文件。
 * @param {Record<string, string|undefined>} [env]
 * @returns {{dir: string, position: string}}  dir 素材目录；position 桌面模式位置文件
 */
export function petPaths(env = process.env) {
  const home = expandHome(env);
  return {
    dir: env.ZCODE_EXPAND_PET_DIR || join(home, 'pet'),
    position: join(home, 'pet-position.json'),
  };
}

/**
 * 存在且非空才算数：0 字节的占位文件当没有，免得显示一个破图
 * @param {string} path
 * @returns {boolean}
 */
function usable(path) {
  if (!existsSync(path)) return false;
  try {
    return statSync(path).size > 0;
  } catch {
    return false;
  }
}

/**
 * 在 dir 下按 names 里的顺序找第一个可用的文件，返回**路径**（没找到就是 null）
 * @param {string} dir
 * @param {string[]} names
 * @returns {string|null}
 */
function pick(dir, names) {
  for (const name of names) {
    const path = join(dir, name);
    if (usable(path)) return path;
  }
  return null;
}

/**
 * 角色图的内联 data: URL（alpha 掩码用；为什么不能用 file:// 见文件头）。
 * 超过上限或读不出来就是 null——只是没有掩码，桌宠照常显示。
 * @param {string} path
 * @param {string[]} notes
 * @returns {string|null}
 */
function readMask(path, notes) {
  try {
    const size = statSync(path).size;
    if (size > MASK_MAX_BYTES) {
      notes.push(`角色图 ${size} 字节，超过内联上限 ${MASK_MAX_BYTES}，不做 alpha 掩码（透明处会挡鼠标）`);
      return null;
    }
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    return `data:${MIME[ext] ?? 'image/png'};base64,${readFileSync(path).toString('base64')}`;
  } catch (error) {
    notes.push(`角色图读不出来，不做 alpha 掩码：${String(error)}`);
    return null;
  }
}

/**
 * 解析素材目录。
 * @param {{dir: string}} options
 * @returns {{ok: true, assets: import('./spec.mjs').PetAssets, mask: string|null, notes: string[]}
 *         | {ok: false, reason: string, notes: string[]}}
 */
export function resolvePetAssets({ dir }) {
  /** @type {string[]} */
  const notes = [];
  const imagePath = pick(dir, IMAGE_NAMES);
  if (!imagePath) {
    // 不是错误：用户没放素材，桌宠就是不开
    return { ok: false, reason: `${dir} 里没有角色图（${IMAGE_NAMES.join(' / ')}），桌宠不显示`, notes };
  }

  /** @type {Record<string, {press: string, release: string}>} */
  const sounds = {};
  for (const name of PET_SOUNDS) {
    const press = pick(join(dir, 'sounds', name), SOUND_EXTS.map((ext) => `press.${ext}`));
    const release = pick(join(dir, 'sounds', name), SOUND_EXTS.map((ext) => `release.${ext}`));
    if (!press || !release) {
      // 缺档只影响声音：留空串，渲染层不播放
      notes.push(`音效档位 ${name} 不完整（press / release 缺一个），这一档静音`);
      sounds[name] = { press: '', release: '' };
      continue;
    }
    sounds[name] = { press: pathToFileURL(press).href, release: pathToFileURL(release).href };
  }

  return {
    ok: true,
    assets: { image: pathToFileURL(imagePath).href, sounds },
    mask: readMask(imagePath, notes),
    notes,
  };
}
