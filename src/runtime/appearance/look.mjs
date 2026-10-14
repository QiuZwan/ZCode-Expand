// 外观配置模型 —— 移植自 zcode-canvas 的 src/shared/look.ts（MIT）
//
// 一套「外观」由这些字段定义：colors / accent / radius / palette / vars / wallpaper / glass / startup。
// 主题（~/.zcode-expand/themes/<id>/theme.json）与用户配置（~/.zcode-expand/config.json）
// 是两层，逐字段合并，配置在上层；显式写 null 表示"把主题设的那项去掉"。

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GLASS_REGIONS, regionAlphas } from './glass.mjs';
import { filteredBackdrop, generatePalette, isPaletteColor, PALETTE_VARIANTS } from './palette.mjs';

export const MODES = ['dark', 'light'];
export const MATERIALS = ['acrylic', 'mica', 'tabbed', 'none'];
/**
 * 窗口材质能真正落到窗口上的平台——Windows 走 `setBackgroundMaterial`，macOS 走 `setVibrancy`，
 * Linux 上什么都没发生。主进程按它决定要不要调 API，面板按它决定要不要显示「窗口材质」这一项。
 * 参考实现只认 win32，那是它没在 macOS 上接 vibrancy；我们接了，所以这里得算上 darwin。
 */
export const MATERIAL_PLATFORMS = ['win32', 'darwin'];
export const WALLPAPER_FITS = ['cover', 'contain', 'fill', 'tile', 'center'];
export const STARTUP_ANIMATIONS = ['pop', 'fade', 'none'];

/** theme.json 格式版本；只在出现不兼容改动时才 +1 */
export const FORMAT_VERSION = 1;

export const LOOK_KEYS = ['colors', 'accent', 'radius', 'palette', 'vars', 'wallpaper', 'glass', 'startup'];

/** 用户目录。ZCODE_EXPAND_HOME 优先，默认 ~/.zcode-expand */
export function expandHome(env = process.env) {
  if (env.ZCODE_EXPAND_HOME) return env.ZCODE_EXPAND_HOME;
  return join(homedir(), '.zcode-expand');
}

export function expandPaths(home) {
  return {
    home,
    config: join(home, 'config.json'),
    userThemes: join(home, 'themes'),
    builtinThemes: join(home, 'runtime', 'themes'),
    runtime: join(home, 'runtime'),
    log: join(home, 'runtime.log'),
    petPosition: join(home, 'pet-position.json'),
    openRequest: join(home, '.open-panel'),
  };
}

export const DEFAULT_CONFIG = { enabled: true, theme: null };

export function readConfig(home) {
  const file = expandPaths(home).config;
  if (!existsSync(file)) return { ...DEFAULT_CONFIG };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(
      `配置文件 ${file} 不是有效的 JSON（${error.message}）。\n  请修正语法错误后重试；或删除该文件，外观设置会回到默认。`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`配置文件 ${file} 的内容不是 JSON 对象。\n  请修正后重试；或删除该文件，外观设置会回到默认。`);
  }
  return { ...DEFAULT_CONFIG, ...parsed };
}

/** 一次 rename 换掉 config.json，读的人永远看不到写了一半的文件 */
export function writeConfigAtomic(home, config) {
  mkdirSync(home, { recursive: true });
  const target = expandPaths(home).config;
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, target);
}

const isString = (v) => typeof v === 'string';

/** 某个路径是不是就落在 parent 里面（用来区分"主题库里的"和"外置的"） */
export function insideDir(child, parent) {
  const rel = relative(parent, child);
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
}

/** 用户主题覆盖同名内置主题 */
export function listThemes(home) {
  const found = new Map();
  const paths = expandPaths(home);
  const sources = [[paths.builtinThemes, true], [paths.userThemes, false]];
  for (const [root, builtin] of sources) {
    if (!existsSync(root)) continue;
    for (const id of readdirSync(root)) {
      const dir = join(root, id);
      const manifestFile = join(dir, 'theme.json');
      let isDir = false;
      try { isDir = statSync(dir).isDirectory(); } catch { isDir = false; }
      if (!isDir || !existsSync(manifestFile)) continue;
      try {
        found.set(id, { id, dir, builtin, manifest: JSON.parse(readFileSync(manifestFile, 'utf8')) });
      } catch {
        // 一个坏主题不能把其它主题带下水
      }
    }
  }
  // 外置主题：「另存为新主题」时选了主题库以外的目录，config.theme 就直接记那个绝对路径，
  // 主题**就住在用户选的地方**——不复制、不搬家，也就不存在两份会分叉。
  // id 用路径本身：下游一律 `listThemes().find(t => t.id === config.theme)`，不需要任何特殊分支。
  try {
    const chosen = readConfig(home).theme;
    if (typeof chosen === 'string' && isAbsolute(chosen) && !insideDir(chosen, paths.userThemes)) {
      const manifestFile = join(chosen, 'theme.json');
      if (statSync(chosen).isDirectory() && existsSync(manifestFile)) {
        found.set(chosen, { id: chosen, dir: chosen, builtin: false, manifest: JSON.parse(readFileSync(manifestFile, 'utf8')) });
      }
    }
  } catch {
    // 目录被删了、config 读不出来——都当作"这套主题不存在"，与主题被删掉是同一种表现
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function resolveFile(base, value) {
  if (value == null || value === '') return value;
  return isAbsolute(value) ? value : resolve(base, value);
}

function withResolvedFiles(spec, base) {
  const out = { ...spec };
  if (spec.wallpaper) {
    const layer = { ...spec.wallpaper };
    if ('image' in layer) layer.image = resolveFile(base, layer.image);
    for (const mode of MODES) {
      const sub = layer[mode];
      if (sub && 'image' in sub) layer[mode] = { ...sub, image: resolveFile(base, sub.image) };
    }
    out.wallpaper = layer;
  }
  if (spec.startup) out.startup = { ...spec.startup, logo: resolveFile(base, spec.startup.logo) };
  return out;
}

function perMode(value, isLeaf) {
  if (value == null) return {};
  if (isLeaf(value)) return { dark: value, light: value };
  return value;
}

/** 把「共用 + 分模式」的对象拆成每个模式各自适用的；null 表示"去掉" */
function splitModes(layer) {
  const shared = { ...layer };
  for (const mode of MODES) delete shared[mode];
  const result = {};
  for (const mode of MODES) {
    const own = layer[mode];
    result[mode] = own === null ? null : { ...shared, ...(own ?? {}) };
  }
  return result;
}

function clamp(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function resolveWallpaper(spec) {
  // 三种来源，优先级：图片文件 > 纯渐变 > 视频（视频由渲染层的 <video> 承担）
  if (!spec || (!spec.image && !spec.gradient && !spec.video)) return null;
  return {
    image: spec.image ?? null,
    fit: oneOf(spec.fit, WALLPAPER_FITS, 'cover'),
    position: spec.position || 'center',
    blur: clamp(spec.blur, 0, 200, 0),
    dim: clamp(spec.dim, 0, 1, 0.35),
    overlay: spec.overlay ?? null,
    scale: clamp(spec.scale, 0.1, 4, 1),
    saturate: clamp(spec.saturate, 0, 4, 1),
    brightness: clamp(spec.brightness, 0, 2, 1),
    contrast: clamp(spec.contrast, 0, 2, 1),
    grayscale: clamp(spec.grayscale, 0, 1, 0),
    // 我们自己的两个扩展（参考实现都只有图片文件）：
    //   gradient —— 纯 CSS 渐变，这样内置主题可以一张素材都不带
    //   video    —— 视频壁纸，CSS 放不了，交给渲染层的 <video> 层
    gradient: typeof spec.gradient === 'string' && spec.gradient.trim() ? spec.gradient.trim() : null,
    video: spec.video === true,
  };
}

/** 一层玻璃叠到下面那些上的合并；regions 逐区域、逐字段合并 */
function mergeGlass(below, layer) {
  const merged = { ...below, ...layer };
  if (below.regions || layer.regions) {
    const regions = {};
    for (const region of GLASS_REGIONS) {
      const own = { ...((below.regions ?? {})[region] ?? {}), ...((layer.regions ?? {})[region] ?? {}) };
      if (Object.keys(own).length) regions[region] = own;
    }
    merged.regions = regions;
  }
  return merged;
}

function resolveGlass(glass) {
  const opacity = clamp(glass.opacity, 0, 1, 1);
  const blur = clamp(glass.blur, 0, 100, 0);
  const regions = {};
  for (const region of GLASS_REGIONS) {
    const own = (glass.regions ?? {})[region];
    regions[region] = {
      opacity: clamp(own?.opacity, 0, 1, opacity),
      blur: region === 'frame' ? 0 : clamp(own?.blur, 0, 100, blur),
    };
  }
  return { material: oneOf(glass.material, MATERIALS, 'acrylic'), opacity, blur, regions };
}

/** 主题与配置作为层叠，底在前，文件引用已绝对化 */
export function lookLayers(config, theme, home) {
  const layers = [];
  if (theme) layers.push(withResolvedFiles(theme.manifest, theme.dir));
  layers.push(withResolvedFiles(config, home));
  return layers;
}

export function mergeLayers(layers) {
  const vars = { dark: {}, light: {} };
  const wallpaper = { dark: null, light: null };
  let accent = {};
  let radius = null;
  let glass = {};
  let startup = {};
  let palette = null;

  layers.forEach((layer, index) => {
    if (layer.palette === null) palette = null;
    else if (layer.palette && isPaletteColor(layer.palette.seed)) palette = { spec: layer.palette, layer: index };
    if (layer.accent === null) accent = {};
    else if (layer.accent !== undefined) accent = { ...accent, ...perMode(layer.accent, isString) };
    if (layer.radius !== undefined) radius = layer.radius === null ? null : clamp(layer.radius, 0, 4, 1);
    if (layer.vars === null) for (const mode of MODES) vars[mode] = {};
    else if (layer.vars) {
      const split = splitModes(layer.vars);
      for (const mode of MODES) {
        const own = split[mode];
        if (own === null) vars[mode] = {};
        else Object.assign(vars[mode], own);
      }
    }
    if (layer.wallpaper === null) for (const mode of MODES) wallpaper[mode] = null;
    else if (layer.wallpaper) {
      const split = splitModes(layer.wallpaper);
      for (const mode of MODES) {
        const own = split[mode];
        wallpaper[mode] = own === null ? null : { ...(wallpaper[mode] ?? {}), ...own };
      }
    }
    if (layer.glass) glass = mergeGlass(glass, layer.glass);
    if (layer.startup) startup = { ...startup, ...layer.startup };
  });
  return { accent, radius, vars, wallpaper, glass, startup, palette };
}

/** 把主题 + 用户配置合成一套外观。配置逐字段胜出；显式 null 去掉主题设的那项。 */
export function resolveLook(config, theme, home) {
  const layers = lookLayers(config, theme, home);
  const { accent, radius, vars, wallpaper, glass, startup, palette } = mergeLayers(layers);
  const colors = { dark: {}, light: {} };

  const resolvedGlass = resolveGlass(glass);
  const resolvedWallpaper = { dark: resolveWallpaper(wallpaper.dark), light: resolveWallpaper(wallpaper.light) };

  // 调色板替换掉它下面那些层的颜色 token，并被同层及更上层的 colors 精修：
  // 用户调色板给主题换色，主题自己的 colors 精修它自己的调色板。
  const active = palette;
  let generated = null;
  if (active) {
    const alphas = regionAlphas(resolvedGlass.regions);
    const backdrops = {};
    const average = active.spec.backdrop;
    for (const mode of MODES) {
      const shown = resolvedWallpaper[mode];
      if (!shown || !isPaletteColor(average) || alphas.main >= 1) continue;
      backdrops[mode] = {
        color: filteredBackdrop(average, shown.brightness, shown.dim, shown.overlay, mode),
        frameAlpha: alphas.frame,
        mainAlpha: alphas.main,
      };
    }
    generated = generatePalette(active.spec, backdrops);
  }
  layers.forEach((layer, index) => {
    if (generated && active && index === active.layer) for (const mode of MODES) Object.assign(colors[mode], generated.colors[mode]);
    if (layer.colors) for (const mode of MODES) Object.assign(colors[mode], layer.colors[mode]);
  });

  // 个人强调色覆盖主题的 primary 系，包括那些把 token 写死的主题。
  // 用户自己显式写的颜色 token 仍然比强调色更具体。
  const personalAccent = perMode(config.accent, isString);
  for (const mode of MODES) {
    if (!personalAccent[mode]) continue;
    const own = (config.colors ?? {})[mode] ?? {};
    for (const token of ['primary', 'brand', 'ring', 'primary-foreground']) {
      for (const key of [token, `--color-${token}`]) {
        if (!(key in own)) delete colors[mode][key];
      }
    }
  }

  return {
    colors,
    accent,
    radius,
    vars,
    wallpaper: resolvedWallpaper,
    glass: resolvedGlass,
    startup: {
      background: startup.background ?? null,
      logo: startup.logo ?? null,
      logoSize: clamp(startup.logoSize, 16, 512, 96),
      animation: oneOf(startup.animation, STARTUP_ANIMATIONS, 'pop'),
    },
    palette: generated && active
      ? {
          seed: active.spec.seed.toLowerCase(),
          variant: PALETTE_VARIANTS.includes(active.spec.variant) ? active.spec.variant : 'natural',
          readability: generated.readability,
        }
      : null,
  };
}

/**
 * 各模式的视频壁纸 URL，拼成一个字符串——用来判断"视频壁纸变没变"。
 *
 * 为什么需要它：视频路径**不进 CSS**（css.mjs 对 video 整块跳过，画面交给渲染层的 <video>），
 * 所以「视频 A → 视频 B」算出来的 css 字符串逐字节相同。外层若只比 CSS 就会把这个变化
 * 判成空操作，不推 CHANNEL_PANEL_CHANGED，渲染层的视频层便一直播着上一个视频——
 * 表现为「两个视频壁纸互切没反应，必须先切到别的壁纸再切回来」（2026-10-14 实测）。
 * 不是视频壁纸的模式留空串，于是「视频 → 图片 / 无壁纸」同样能被判出来。
 */
export function videoKey(look) {
  return MODES.map((mode) => {
    const w = look.wallpaper && look.wallpaper[mode];
    if (!w || !w.video || typeof w.image !== 'string' || !w.image) return '';
    try { return pathToFileURL(w.image).href; } catch { return ''; }
  }).join('\n');
}

const MANIFEST_KEYS = new Set(['$schema', 'format', 'name', 'description', 'author', 'version', 'license', 'source', 'modes', ...LOOK_KEYS]);

/** 不阻止主题加载、但值得报告的问题 */
export function checkManifest(id, manifest) {
  const warnings = [];
  const format = manifest.format ?? FORMAT_VERSION;
  if (!Number.isInteger(format) || format < 1) warnings.push(`theme "${id}": invalid format ${JSON.stringify(manifest.format)}`);
  else if (format > FORMAT_VERSION) warnings.push(`theme "${id}" uses format ${format}; 本扩展只懂 format ${FORMAT_VERSION}`);
  for (const key of Object.keys(manifest)) if (!MANIFEST_KEYS.has(key)) warnings.push(`theme "${id}": unknown field "${key}"`);
  if (manifest.modes !== undefined && (!Array.isArray(manifest.modes) || manifest.modes.some((m) => !MODES.includes(m))))
    warnings.push(`theme "${id}": modes 必须是 "dark" / "light" 的列表`);
  return warnings;
}

/** 从磁盘读配置 + 当前主题并解析。look 为 null 表示外观功能被关掉。 */
export function loadLook(home) {
  const warnings = [];
  const config = readConfig(home);
  if (config.enabled === false) return { look: null, warnings };
  let theme = null;
  if (config.theme) {
    theme = listThemes(home).find((t) => t.id === config.theme) ?? null;
    if (!theme) warnings.push(`theme "${config.theme}" 不存在`);
    else warnings.push(...checkManifest(theme.id, theme.manifest));
  }
  return { look: resolveLook(config, theme, home), warnings };
}
