// 壁纸仓库 —— 移植自 zcode-canvas 的 src/shared/wallpaper-store.ts（MIT）
//
// 面板选图与 Wallpaper Engine 导入都写进同一个仓库（<home>/imports/wallpaper），
// 所以命名、路径安全、新导入的蒙层策略不会各写各的。

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, resolve, sep } from 'node:path';

/** Chromium 能从 CSS background url 渲染的图片格式；gif 在那里会播放动画。可执行的一律不收。 */
export const WALLPAPER_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.avif', '.svg', '.gif'];

/** 视频壁纸（本项目扩展，参考实现没有）。用 <video> 播放，不进 CSS。 */
export const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.m4v'];

/**
 * 仓库里的壁纸文件允许待在哪儿。只允许扁平的、白名单形态的文件名；
 * 路径上已经有东西时，它的真实位置仍必须在仓库内——种在那儿的符号链接绝不能被写穿。
 */
export function storedWallpaperPath(home, fileName) {
  if (typeof fileName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(fileName) || fileName.includes('..'))
    throw new Error('invalid wallpaper file name');
  const root = resolve(home, 'imports', 'wallpaper');
  const candidate = resolve(root, fileName);
  if (dirname(candidate) !== root) throw new Error('wallpaper path escapes the store');
  let realRoot;
  try {
    realRoot = realpathSync(root);
  } catch {
    return candidate;
  }
  try {
    const real = realpathSync(candidate);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new Error('wallpaper path escapes the store');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return candidate;
}

/** 把一段名字压成 storedWallpaperPath 认的形态：以字母数字开头、不含 ".." */
function safeSegment(value) {
  return (
    value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/\.{2,}/g, '.').replace(/^[^A-Za-z0-9]+|-+$/g, '') || 'wallpaper'
  );
}

/**
 * 仓库文件名的短内容摘要：两张不同图片即使恰好同名也绝不互相覆盖，
 * 而重复选中同一张图会复用同一个文件。
 */
function contentTag(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12);
}

/** 去掉内容摘要的显示名，例如 "pic-1a2b….jpg" → "pic.jpg" */
export function wallpaperDisplayName(fileName) {
  return fileName.replace(/-[0-9a-f]{12}(?=\.[^.]+$)/, '');
}

/**
 * 把已经校验过的图片拷进仓库，命名 <前缀>-<原名>-<内容摘要><扩展名>，返回仓库内路径。
 * 摘要就在名字里，所以已经躺在那儿的同名文件字节必然相同，拷贝直接跳过。
 * 目标处被种了符号链接时抛错。
 */
export function storeWallpaper(source, home, prefix = []) {
  const extension = extname(source).toLowerCase();
  mkdirSync(resolve(home, 'imports', 'wallpaper'), { recursive: true });
  // 按原拼写剥扩展名，这样 PIC.PNG 会变成 "PIC-….png" 而不是 "PIC.PNG-….png"
  const stem = [...prefix, basename(source, extname(source))].map(safeSegment).join('-');
  const destination = storedWallpaperPath(home, `${stem}-${contentTag(source)}${extension}`);
  if (!existsSync(destination)) copyFileSync(source, destination);
  return destination;
}

/** 新导入只用亮度调；用户已经显式配过的蒙层原样保留 */
export function withUnobscuredOverlay(wallpaper) {
  if (wallpaper.dim !== undefined || wallpaper.dark?.dim !== undefined || wallpaper.light?.dim !== undefined) return wallpaper;
  return { ...wallpaper, dim: 0 };
}

/** 所有可选的壁纸扩展名（图片 + 视频） */
export const ALL_WALLPAPER_EXTENSIONS = [...WALLPAPER_EXTENSIONS, ...VIDEO_EXTENSIONS];
