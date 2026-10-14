// 主题工坊 —— 移植自 zcode-canvas 的 src/shared/save-theme.ts（MIT）
//
// 把「主题 + 个人覆盖」压成**一个**主题目录，渲染结果完全一样。
// 这样在面板里调出来的一套外观可以存下来、切回去、也能分享。
// 与原版的差异：不写 $schema（原版指向它自己的仓库地址，写进我们的主题里是错的）。

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path';
import { ACCENT_TOKENS, contrastForeground } from './css.mjs';
import {
  FORMAT_VERSION,
  insideDir,
  listThemes,
  LOOK_KEYS,
  lookLayers,
  mergeLayers,
  MODES,
  expandPaths,
  readConfig,
  resolveLook,
  writeConfigAtomic,
} from './look.mjs';

const shortToken = (key) => (key.startsWith('--color-') ? key.slice('--color-'.length) : key);

/** 两套模式一致时只写一份，存出来的主题读起来像手写的 */
function shared(byMode) {
  const { dark, light } = byMode;
  if (!dark && !light) return undefined;
  if (dark && light && JSON.stringify(dark) === JSON.stringify(light)) return { ...dark };
  return { dark, light };
}

/**
 * 主题 + 配置压成单层主题。只有两条规则是跨层的，在这里写死：
 * 个人调色板替换主题的颜色 token；个人强调色压过下面那层的 primary。
 * 文件引用保持绝对路径（写盘时再拷进主题目录）。
 */
export function flattenLook(config, theme, home) {
  const merged = mergeLayers(lookLayers(config, theme, home));
  const look = {};
  if (merged.palette) look.palette = merged.palette.spec;
  const dark = merged.accent.dark;
  const light = merged.accent.light;
  if (dark || light) look.accent = dark === light ? dark : merged.accent;
  if (merged.radius !== null) look.radius = merged.radius;
  const vars = shared({
    dark: Object.keys(merged.vars.dark).length ? merged.vars.dark : null,
    light: Object.keys(merged.vars.light).length ? merged.vars.light : null,
  });
  if (vars) look.vars = vars;
  const wallpaper = shared({
    dark: merged.wallpaper.dark && merged.wallpaper.dark.image ? merged.wallpaper.dark : null,
    light: merged.wallpaper.light && merged.wallpaper.light.image ? merged.wallpaper.light : null,
  });
  if (wallpaper) look.wallpaper = wallpaper;
  if (Object.keys(merged.glass).length) look.glass = merged.glass;
  if (Object.keys(merged.startup).length) look.startup = merged.startup;

  // 颜色：两层合出来的结果，减去压平后的调色板自己会生成的那些
  const target = resolveLook(config, theme, home).colors;
  const generated = resolveLook({}, { id: '', dir: home, builtin: false, manifest: { name: '', ...look } }, home).colors;
  const colors = {};
  for (const mode of MODES) {
    const want = {};
    for (const [key, value] of Object.entries(target[mode])) want[shortToken(key)] = value;
    const own = {};
    for (const [key, value] of Object.entries(want)) if (generated[mode][key] !== value) own[key] = value;
    // 只有个人强调色才去掉生成的 token；单层时必须把它们点名写出来
    const accent = merged.accent[mode];
    for (const token of ACCENT_TOKENS) {
      if (accent && token in generated[mode] && !(token in want)) {
        own[token] = token === 'primary-foreground' ? contrastForeground(accent) : accent;
      }
    }
    if (Object.keys(own).length) colors[mode] = own;
  }
  if (colors.dark || colors.light) look.colors = colors;
  return look;
}

function themeName(raw) {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name || name.length > 60 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('invalid theme name');
  return name;
}

/** 由显示名派生一个没被占用的目录名；非拉丁名回退成 "custom" */
function themeId(name, taken) {
  const base = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'custom';
  let id = base;
  for (let n = 2; taken(id); n += 1) id = `${base}-${n}`;
  return id;
}

/**
 * 把 look 写成一套主题。`targetDir` 给出时主题就写在那个目录（「另存为新主题」时用户选的路径），
 * 否则写在主题库的 `<userThemes>/<id>` 下。
 * 引用到的文件按内容摘要命名拷进来；已经在主题目录里的文件原地不动。
 * 新目录先在**同级**暂存再整体移进去（同级是为了避免跨盘 renameSync 抛 EXDEV——
 * 主题库在 C: 而目标在 D: 是常事），这样热重载永远看不到写了一半的主题；
 * 原地改写时旧 theme.json 留成 theme.json.bak。
 */
export function writeTheme(home, id, meta, look, replace, targetDir) {
  const dir = targetDir ?? join(expandPaths(home).userThemes, id);
  // 库内主题的 id 要进 config、也要当路径段，必须是 slug；外置主题由路径本身定位，不校验 id
  if (!targetDir && !/^[\w-]+$/.test(id)) throw new Error(`invalid theme id ${JSON.stringify(id)}`);
  // 目标已存在就原地写（用户已经在系统对话框里确认过覆盖了），否则先暂存再搬
  const inPlace = replace || existsSync(dir);
  if (!targetDir && !replace && inPlace) throw new Error(`主题目录已存在: ${dir}`);
  const staging = inPlace ? dir : join(dirname(dir), `.theme-${process.pid}`);
  if (!inPlace) rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    const place = (file, stem) => {
      if (!file) return file;
      const inside = relative(dir, file);
      if (inPlace && inside && !inside.startsWith('..') && !isAbsolute(inside)) return inside.replace(/\\/g, '/');
      if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`找不到主题用到的文件: ${file}`);
      const name = `${stem}-${createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12)}${extname(file).toLowerCase()}`;
      if (!existsSync(join(staging, name))) copyFileSync(file, join(staging, name));
      return name;
    };
    const manifest = { format: FORMAT_VERSION, ...meta, ...look };
    if (look.wallpaper) {
      const wallpaper = { ...look.wallpaper };
      if (wallpaper.image) wallpaper.image = place(wallpaper.image, 'wallpaper');
      for (const mode of MODES) {
        const own = wallpaper[mode];
        if (own && own.image) wallpaper[mode] = { ...own, image: place(own.image, 'wallpaper') };
      }
      manifest.wallpaper = wallpaper;
    }
    if (look.startup && look.startup.logo) manifest.startup = { ...look.startup, logo: place(look.startup.logo, 'logo') };
    const file = join(staging, 'theme.json');
    if (inPlace && existsSync(file)) copyFileSync(file, `${file}.bak`);
    writeFileSync(`${file}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
    if (!inPlace) {
      mkdirSync(dirname(dir), { recursive: true });
      renameSync(staging, dir);
    }
  } catch (error) {
    if (!inPlace) rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/**
 * 把一个外来的主题文件夹导入进来（用户从别处拷来的一套皮肤）。
 * 校验 theme.json 存在且合法，再整体拷进用户主题目录；目录名从显示名派生并保证不撞车。
 * 返回 { id, name }。
 */
export function importThemeFromDir(home, sourceDir) {
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) throw new Error(`不是一个文件夹：${sourceDir}`);
  const manifestFile = join(sourceDir, 'theme.json');
  if (!existsSync(manifestFile)) throw new Error('这个文件夹里没有 theme.json，不像是一套主题');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  } catch (error) {
    throw new Error(`theme.json 不是合法 JSON：${error.message}`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('theme.json 的内容不是对象');
  const name = themeName(manifest.name);

  const themes = listThemes(home);
  const taken = (candidate) =>
    themes.some((entry) => entry.id === candidate) || existsSync(join(expandPaths(home).userThemes, candidate));
  const id = themeId(name, taken);
  const dest = join(expandPaths(home).userThemes, id);

  mkdirSync(expandPaths(home).userThemes, { recursive: true });
  // 先拷到暂存目录再整体改名进主题目录：热重载永远看不到一半的主题
  const staging = join(home, `.theme-import-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  try {
    copyDir(sourceDir, staging);
    // 备份文件不用跟着搬
    rmSync(join(staging, 'theme.json.bak'), { force: true });
    renameSync(staging, dest);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return { id, name };
}

/**
 * 递归拷贝目录内容。
 *
 * ⚠️ **不能用 `node:fs` 的 `cpSync(..., { recursive: true })`**：**跨盘时它会把 Electron 主进程直接带走**。
 * 不是抛异常——是 V8 fatal：`length_error was thrown in -fno-exceptions mode with message "basic_string"`，
 * 连 `uncaughtException` 都轮不到，用户看到的就是"闪退且不留任何线索"
 * （2026-10-14 实测：Electron 41.0.3 下 D: → C: 递归必崩；C: → C: 正常；纯 Node 24 跨盘也正常）。
 * 症状就是"从 D:\下载 导入主题"必闪退。
 *
 * 所以自己走一遍：`mkdirSync` + `copyFileSync`——这条路跨盘是验证过的（壁纸导入一直用它）。
 * 非普通文件（符号链接等）跳过：主题目录里不该有，硬跟过去还可能绕成环。
 */
function copyDir(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dest = join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else if (entry.isFile()) copyFileSync(src, dest);
    else throw new Error(`主题目录里有不支持的文件类型：${src}`);
  }
}
/**
 * 把当前外观存进正在用的用户主题（不给 name）或存成新主题，然后切过去、清掉所有个人覆盖：
 * 从此这套外观归主题所有。
 */
export function saveLookAsTheme(home, name, targetDir) {
  const config = readConfig(home);
  const themes = listThemes(home);
  const current = config.theme ? themes.find((entry) => entry.id === config.theme) ?? null : null;
  const look = flattenLook(config, current, home);
  let id;
  let meta;
  if (name === undefined) {
    if (!current || current.builtin) throw new Error('只有用户主题能原地保存');
    id = current.id;
    meta = Object.fromEntries(Object.entries(current.manifest).filter(([key]) => !LOOK_KEYS.includes(key)));
    // current.dir 对外置主题是它真正所在的那个目录，所以"存进当前主题"两种主题都写对地方
    writeTheme(home, id, meta, look, true, current.dir);
  } else {
    // 派生来源的署名（素材许可、出处）跟着走
    const license = current?.manifest?.license;
    const source = current?.manifest?.source;
    const modes = current?.manifest?.modes;
    meta = { name: themeName(name), ...(license ? { license } : {}), ...(source ? { source } : {}), ...(modes ? { modes } : {}) };
    if (targetDir) {
      // 主题就住在用户选的目录里，config.theme 直接记这个绝对路径（listThemes 认得）
      id = insideDir(targetDir, expandPaths(home).userThemes) ? basename(targetDir) : targetDir;
      writeTheme(home, id, meta, look, false, targetDir);
    } else {
      id = themeId(meta.name, (candidate) => themes.some((entry) => entry.id === candidate) || existsSync(join(expandPaths(home).userThemes, candidate)));
      writeTheme(home, id, meta, look, false);
    }
  }
  const next = { ...config, theme: id };
  for (const key of LOOK_KEYS) delete next[key];
  writeConfigAtomic(home, next);
  return { id, name: meta.name };
}
