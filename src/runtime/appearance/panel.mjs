// 外观中心的全部主进程逻辑 —— 移植自 zcode-canvas 的 src/runtime/panel.ts（MIT）
//
// 刻意不 import electron，方便在 ZCode 之外测：main.mjs 只负责接 IPC 通道、开原生文件对话框。
//
// 面板做的事：选主题、存壁纸、应用**校验过的**个人外观控件。
// 清掉图片 = 回到主题的壁纸；重置控件 = 图片留着。

import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildCss, isSafeCssValue } from './css.mjs';
import { GLASS_REGIONS } from './glass.mjs';
import {
  listThemes, LOOK_KEYS, MATERIAL_PLATFORMS, MATERIALS, readConfig, resolveLook, STARTUP_ANIMATIONS, WALLPAPER_FITS, writeConfigAtomic,
} from './look.mjs';
import { isPaletteColor, PALETTE_VARIANTS } from './palette.mjs';
import { positionAxes } from './position.mjs';
import { importThemeFromDir, saveLookAsTheme } from './save-theme.mjs';
import { storedWallpaperPath, storeWallpaper, ALL_WALLPAPER_EXTENSIONS, VIDEO_EXTENSIONS, wallpaperDisplayName, withUnobscuredOverlay } from './wallpaper-store.mjs';

function safeSwatchColor(value) {
  return typeof value === 'string' && value.trim() && isSafeCssValue(value, 'color') ? value : null;
}

/**
 * 主题色卡。
 * ⚠️ 不能只读 manifest.colors：用 palette 生成配色的主题（本项目四套内置主题都是）
 * 根本没写 colors，全都会退化成同一个兜底色——2026-10-14 截图里四张卡一模一样就是这么来的。
 * 正解是把这套主题解析一遍，从解析结果里取。
 */
function themeSwatchOf(entry, home) {
  const fallback = { background: '#202534', accent: '#8b7cf5' };
  try {
    const look = resolveLook({ theme: entry.id }, entry, home);
    const dark = look.colors.dark;
    return {
      background: safeSwatchColor(dark.background) ?? safeSwatchColor(dark['background-win-alt']) ?? fallback.background,
      accent: safeSwatchColor(dark.primary) ?? safeSwatchColor(dark.brand) ?? fallback.accent,
    };
  } catch {
    return fallback;
  }
}

function themeHasWallpaper(manifest) {
  const wallpaper = manifest.wallpaper;
  return !!wallpaper && !!(wallpaper.image || (wallpaper.dark && wallpaper.dark.image) || (wallpaper.light && wallpaper.light.image));
}

/** 忽略不支持的格式、目录、以及逃出仓库的符号链接 */
export function listStoredWallpapers(home) {
  const root = resolve(home, 'imports', 'wallpaper');
  if (!existsSync(root)) return [];
  const wallpapers = [];
  for (const id of readdirSync(root)) {
    try {
      const ext = extname(id).toLowerCase();
      if (!ALL_WALLPAPER_EXTENSIONS.includes(ext)) continue;
      const file = storedWallpaperPath(home, id);
      if (!statSync(file).isFile()) continue;
      wallpapers.push({
        id,
        name: wallpaperDisplayName(id),
        url: pathToFileURL(file).href,
        animated: ext === '.gif',
        video: VIDEO_EXTENSIONS.includes(ext),
      });
    } catch {
      // 一个坏条目或恶意符号链接不能把整个库藏起来
    }
  }
  return wallpapers.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function selectedStoredWallpaperId(home, image) {
  if (typeof image !== 'string') return null;
  const id = basename(image);
  try {
    const file = resolve(home, image);
    return storedWallpaperPath(home, id) === file && statSync(file).isFile() ? id : null;
  } catch {
    return null;
  }
}

const WALLPAPER_NUMBERS = {
  blur: [0, 200],
  dim: [0, 1],
  scale: [0.1, 4],
  saturate: [0, 4],
  brightness: [0, 2],
  contrast: [0, 2],
  grayscale: [0, 1],
};
const WALLPAPER_CONTROL_KEYS = ['fit', 'position', ...Object.keys(WALLPAPER_NUMBERS)];

const REGION_INPUTS = {
  frameOpacity: ['frame', 'opacity', 1],
  mainOpacity: ['main', 'opacity', 1],
  mainBlur: ['main', 'blur', 100],
  cardOpacity: ['card', 'opacity', 1],
  cardBlur: ['card', 'blur', 100],
  inputOpacity: ['input', 'opacity', 1],
  inputBlur: ['input', 'blur', 100],
};
const REGION_INPUT_KEYS = Object.keys(REGION_INPUTS);
const PANEL_INPUT_KEYS = new Set([
  'theme', 'wallpaper', 'fit', ...Object.keys(WALLPAPER_NUMBERS), ...REGION_INPUT_KEYS,
  'glassOpacity', 'glassBlur', 'material', 'accent', 'radius', 'palette', 'startup', 'positionX', 'positionY',
  'reset', 'clearOverlay', 'discard', 'unset', 'pet',
]);
// 可被「重置这一节」撤掉的控件名。
// ⚠️ 比参考实现多了 "fit"：它原本不在表里，于是面板按整节重置时带着 fit 一起发过来会被整条拒掉
// （2026-10-14 实测：错误是 invalid unset request）。fit 本来就是这一节的控件，理应可重置。
// 配色 / 启动画面两节参考实现也没有，是本项目补的（2026-10-14）：键名沿用「配置对象名前缀」的写法。
const UNSET_KEYS = new Set([
  'glassOpacity', 'glassBlur', 'material', 'radius', 'positionX', 'positionY', 'fit',
  ...Object.keys(WALLPAPER_NUMBERS), ...REGION_INPUT_KEYS,
  'palette', 'accent', 'startupBackground', 'startupLogoSize', 'startupAnimation',
  'petEnabled', 'petScale', 'petSound', 'petVolume', 'petBubble', 'petDesktop',
]);
/** 用 withoutWallpaperKeys 直接删掉的壁纸键（position 两轴另有一套"只回退被重置的那一轴"的逻辑） */
const WALLPAPER_UNSETTABLE = ['fit', ...Object.keys(WALLPAPER_NUMBERS)];

export function readPanelData(home) {
  const config = readConfig(home);
  const themes = listThemes(home);
  const wallpapers = listStoredWallpapers(home);
  const id = selectedStoredWallpaperId(home, config.wallpaper && config.wallpaper.image);
  const file = typeof (config.wallpaper && config.wallpaper.image) === 'string' && config.wallpaper.image
    ? wallpaperDisplayName(basename(config.wallpaper.image))
    : null;
  const active = config.theme ? themes.find((entry) => entry.id === config.theme) : undefined;
  // 手写的 `wallpaper: null` 确实会去掉主题的壁纸，别谎报它还显示着
  const fromTheme = !file && config.wallpaper !== null && active !== undefined && themeHasWallpaper(active.manifest);
  const effective = resolveLook(config, active ?? null, home);
  const imageUrl = (mode) => {
    const image = effective.wallpaper[mode] && effective.wallpaper[mode].image;
    try { return image ? pathToFileURL(image).href : null; } catch { return null; }
  };
  // 视频壁纸走 <video>，CSS 用不上它；渲染层要这个 URL 才能挂视频层
  const videoUrl = (mode) => {
    const w = effective.wallpaper[mode];
    const image = w && w.image;
    if (!w || !w.video || !image) return null;
    try { return pathToFileURL(image).href; } catch { return null; }
  };
  const unsetGroups = {
    wallpaper: ['fit', 'positionX', 'positionY', ...Object.keys(WALLPAPER_NUMBERS)],
    glass: ['material', 'glassOpacity', 'glassBlur', ...REGION_INPUT_KEYS],
    palette: ['palette', 'accent'],
    startup: ['startupBackground', 'startupLogoSize', 'startupAnimation'],
    pet: ['petEnabled', 'petScale', 'petSound', 'petVolume', 'petBubble', 'petDesktop'],
    radius: ['radius'],
  };
  return {
    config,
    themes: themes.map((entry) => ({
      id: entry.id,
      name: entry.manifest.name,
      builtin: entry.builtin,
      // 主题可以住在主题库以外（另存为新主题时选了别的目录），所以把落点也告诉面板，
      // 卡片上悬停能看见"这套主题到底在哪"
      dir: entry.dir,
      swatch: themeSwatchOf(entry, home),
    })),
    wallpapers,
    effective,
    regionFollows: Object.fromEntries(GLASS_REGIONS.map((region) => {
      const set = (field) => {
        const a = active && active.manifest.glass && active.manifest.glass.regions && active.manifest.glass.regions[region];
        const b = config.glass && config.glass.regions && config.glass.regions[region];
        return (a && a[field] !== undefined) || (b && b[field] !== undefined);
      };
      return [region, { opacity: !set('opacity'), blur: !set('blur') }];
    })),
    unsaved: LOOK_KEYS.some((key) => config[key] !== undefined),
    /**
     * 各节「重置」要发的键。**由主进程给，面板只消费**——
     * 之前是面板自己写一份、主进程白名单另写一份，于是面板多带了一个 fit，
     * 整节重置被 invalid unset request 全数拒掉（2026-10-14 实测）。同一份数据只有一个来源，这种错就不可能再犯。
     */
    unsetGroups,
    /**
     * 每一节「点了 ↺ 会不会真的变」。直接拿 unsetControls 跑一遍比对得出，
     * 而不是再写一份"这一节有哪些键"的推断——那种两份列表的错这个项目已经犯过一次。
     * 面板据此把空转的 ↺ 置灰。
     */
    resettable: Object.fromEntries(Object.entries(unsetGroups).map(([name, keys]) => {
      try {
        const after = structuredClone(config);
        unsetControls(after, keys, home);
        return [name, JSON.stringify(after) !== JSON.stringify(config)];
      } catch { return [name, false]; }
    })),
    // 面板不直接认平台：材质在 win32 走 setBackgroundMaterial、darwin 走 setVibrancy，
    // 哪个平台能落地是主进程的事实（见 main.mjs 的 applyMaterialTo），面板只消费结论。
    materialApplies: MATERIAL_PLATFORMS.includes(process.platform),
    imageUrl: { dark: imageUrl('dark'), light: imageUrl('light') },
    videoUrl: { dark: videoUrl('dark'), light: videoUrl('light') },
    wallpaper: { id: id && wallpapers.some((entry) => entry.id === id) ? id : null, file, fromTheme },
  };
}

/** 玻璃覆盖，去掉指定的区域字段；空 regions 与空 glass 都消失 */
function withoutRegionFields(glass, keys) {
  if (!glass.regions) return glass;
  const regions = { ...glass.regions };
  for (const key of keys) {
    const [region, field] = REGION_INPUTS[key];
    const own = { ...(regions[region] ?? {}) };
    delete own[field];
    if (Object.keys(own).length) regions[region] = own;
    else delete regions[region];
  }
  const next = { ...glass, regions };
  if (!Object.keys(regions).length) delete next.regions;
  return next;
}

function parsePalette(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid palette');
  const { seed, variant, backdrop, ...rest } = raw;
  if (Object.keys(rest).length || !isPaletteColor(seed) || !PALETTE_VARIANTS.includes(variant)
    || (backdrop !== undefined && !isPaletteColor(backdrop))) throw new Error('invalid palette');
  return { seed: seed.toLowerCase(), variant, ...(backdrop ? { backdrop: backdrop.toLowerCase() } : {}) };
}

function panelNumber(raw, min, max, label) {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < min || raw > max) throw new Error(`invalid ${label}`);
  return raw;
}

function copyWallpaper(wallpaper) {
  const copy = { ...(wallpaper ?? {}) };
  for (const mode of ['dark', 'light']) if (copy[mode] && typeof copy[mode] === 'object') copy[mode] = { ...copy[mode] };
  return copy;
}

function withoutWallpaperKeys(wallpaper, keys) {
  if (wallpaper === null || wallpaper === undefined) return wallpaper;
  const clean = { ...wallpaper };
  for (const key of keys) delete clean[key];
  for (const mode of ['dark', 'light']) {
    if (clean[mode] && typeof clean[mode] === 'object') {
      const own = { ...clean[mode] };
      for (const key of keys) delete own[key];
      clean[mode] = own;
    }
  }
  return Object.keys(clean).length ? clean : undefined;
}

const withoutWallpaperControls = (wallpaper) => withoutWallpaperKeys(wallpaper, WALLPAPER_CONTROL_KEYS);

function setWallpaper(config, wallpaper) {
  if (wallpaper === undefined) delete config.wallpaper;
  else config.wallpaper = wallpaper;
}

/** 去掉单项个人覆盖。单个位置轴回退到主题的那个轴，另一个轴不动。 */
function unsetControls(next, keys, home) {
  if (!Array.isArray(keys) || !keys.length || keys.some((key) => typeof key !== 'string' || !UNSET_KEYS.has(key)))
    throw new Error('invalid unset request');
  const glass = withoutRegionFields({ ...(next.glass ?? {}) }, keys.filter((key) => key in REGION_INPUTS));
  if (keys.includes('glassOpacity')) delete glass.opacity;
  if (keys.includes('glassBlur')) delete glass.blur;
  // 「窗口材质」就在毛玻璃这一节里，整节重置理应连它一起回默认（参考实现漏了这一个）
  if (keys.includes('material')) delete glass.material;
  if (next.glass) {
    if (Object.keys(glass).length) next.glass = glass;
    else delete next.glass;
  }
  if (keys.includes('radius')) delete next.radius;
  if (keys.includes('palette')) delete next.palette;
  if (keys.includes('accent')) delete next.accent;
  // 逐项删，不整个丢掉 startup：里面还可能有面板管不到的字段（主题带的 startup.logo）
  if (next.startup) {
    const startup = { ...next.startup };
    if (keys.includes('startupBackground')) delete startup.background;
    if (keys.includes('startupLogoSize')) delete startup.logoSize;
    if (keys.includes('startupAnimation')) delete startup.animation;
    if (Object.keys(startup).length) next.startup = startup;
    else delete next.startup;
  }
  // pet 的六项**正好覆盖** PetSpec 的全部字段，但照样逐项删——"键的含义要和名字一致"，
  // 免得将来加了面板管不到的字段时，重置一个滑块把整块设置都抹了
  if (next.pet) {
    const pet = { ...next.pet };
    if (keys.includes('petEnabled')) delete pet.enabled;
    if (keys.includes('petScale')) delete pet.scale;
    if (keys.includes('petSound')) delete pet.sound;
    if (keys.includes('petVolume')) delete pet.volume;
    if (keys.includes('petBubble')) delete pet.bubble;
    if (keys.includes('petDesktop')) delete pet.desktop;
    if (Object.keys(pet).length) next.pet = pet;
    else delete next.pet;
  }
  setWallpaper(next, withoutWallpaperKeys(next.wallpaper, keys.filter((key) => WALLPAPER_UNSETTABLE.includes(key))));
  const axes = keys.filter((key) => key === 'positionX' || key === 'positionY');
  if (!axes.length || !next.wallpaper) return;
  const own = positionAxes(next.wallpaper.position);
  const withoutPosition = withoutWallpaperKeys(next.wallpaper, ['position']);
  const theme = next.theme ? listThemes(home).find((entry) => entry.id === next.theme) ?? null : null;
  const inherited = resolveLook({ ...next, wallpaper: withoutPosition }, theme, home).wallpaper;
  const fallback = positionAxes(inherited.dark && inherited.dark.position)
    ?? positionAxes(inherited.light && inherited.light.position)
    ?? [50, 50];
  const x = axes.includes('positionX') ? fallback[0] : (own ? own[0] : fallback[0]);
  const y = axes.includes('positionY') ? fallback[1] : (own ? own[1] : fallback[1]);
  if (x === fallback[0] && y === fallback[1]) setWallpaper(next, withoutPosition);
  else next.wallpaper = { ...copyWallpaper(withoutPosition), position: `${x}% ${y}%` };
}

/**
 * 把一个面板请求应用到配置上。**只有请求里出现的字段会变**：
 * 选主题绝不清掉壁纸覆盖，改壁纸设置也绝不清掉主题。
 * 面板 UI 不可能产出的东西一律抛错。
 */
export function applyPanelInput(config, input, home) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid panel request');
  for (const key of Object.keys(input)) if (!PANEL_INPUT_KEYS.has(key)) throw new Error(`unknown panel field ${key}`);
  const next = { ...config };
  if (input.discard !== undefined) {
    if (input.discard !== true) throw new Error('invalid discard request');
    for (const key of LOOK_KEYS) delete next[key];
  }
  if (input.reset !== undefined) {
    if (input.reset === 'theme') {
      delete next.accent;
      delete next.radius;
      delete next.glass;
      delete next.palette;
    } else if (input.reset === 'wallpaper') {
      const wallpaper = withoutWallpaperControls(next.wallpaper);
      if (wallpaper === undefined) delete next.wallpaper;
      else next.wallpaper = wallpaper;
    } else throw new Error('invalid reset target');
  }
  if (input.unset !== undefined) unsetControls(next, input.unset, home);
  if (input.clearOverlay !== undefined) {
    if (input.clearOverlay !== true) throw new Error('invalid clearOverlay request');
    const wallpaper = { ...copyWallpaper(next.wallpaper), dim: 0 };
    for (const mode of ['dark', 'light']) {
      if (wallpaper[mode] && typeof wallpaper[mode] === 'object') {
        const own = { ...wallpaper[mode] };
        delete own.dim;
        wallpaper[mode] = own;
      }
    }
    next.wallpaper = wallpaper;
  }
  if (input.theme !== undefined) {
    if (input.theme === null || input.theme === '') next.theme = null;
    else if (typeof input.theme === 'string' && listThemes(home).some((entry) => entry.id === input.theme)) next.theme = input.theme;
    else throw new Error('unknown theme');
  }
  if (input.wallpaper !== undefined) {
    // 清掉 = 去掉覆盖。写 null 反而是"完全没有壁纸"：
    // resolveLook 里配置里的显式 null 也会把主题自己的壁纸去掉。
    if (input.wallpaper === null) delete next.wallpaper;
    else throw new Error('wallpaper must be picked with the file dialog');
  }
  const request = input;
  const numberKeys = Object.keys(WALLPAPER_NUMBERS);
  if (input.fit !== undefined || numberKeys.some((key) => request[key] !== undefined)
    || input.positionX !== undefined || input.positionY !== undefined) {
    const wallpaper = copyWallpaper(next.wallpaper);
    if (input.fit !== undefined) {
      if (typeof input.fit !== 'string' || !WALLPAPER_FITS.includes(input.fit)) throw new Error('invalid wallpaper fit');
      wallpaper.fit = input.fit;
      for (const mode of ['dark', 'light']) if (wallpaper[mode] && typeof wallpaper[mode] === 'object') delete wallpaper[mode].fit;
    }
    for (const key of numberKeys) {
      const raw = request[key];
      if (raw === undefined) continue;
      const [min, max] = WALLPAPER_NUMBERS[key];
      wallpaper[key] = panelNumber(raw, min, max, `wallpaper ${key}`);
      for (const mode of ['dark', 'light']) if (wallpaper[mode] && typeof wallpaper[mode] === 'object') delete wallpaper[mode][key];
    }
    if (input.positionX !== undefined || input.positionY !== undefined) {
      const currentTheme = next.theme ? listThemes(home).find((entry) => entry.id === next.theme) ?? null : null;
      const resolved = resolveLook(next, currentTheme, home);
      const prior = positionAxes(wallpaper.position)
        ?? positionAxes(resolved.wallpaper.dark && resolved.wallpaper.dark.position)
        ?? positionAxes(resolved.wallpaper.light && resolved.wallpaper.light.position)
        ?? [50, 50];
      const x = input.positionX === undefined ? prior[0] : panelNumber(input.positionX, 0, 100, 'wallpaper positionX');
      const y = input.positionY === undefined ? prior[1] : panelNumber(input.positionY, 0, 100, 'wallpaper positionY');
      wallpaper.position = `${x}% ${y}%`;
      for (const mode of ['dark', 'light']) if (wallpaper[mode] && typeof wallpaper[mode] === 'object') delete wallpaper[mode].position;
    }
    next.wallpaper = wallpaper;
  }
  const regionKeys = REGION_INPUT_KEYS.filter((key) => request[key] !== undefined);
  if (input.glassOpacity !== undefined || input.glassBlur !== undefined || input.material !== undefined || regionKeys.length) {
    const glass = { ...(next.glass ?? {}), ...(next.glass && next.glass.regions ? { regions: { ...next.glass.regions } } : {}) };
    if (input.glassOpacity !== undefined) glass.opacity = panelNumber(input.glassOpacity, 0, 1, 'glass opacity');
    if (input.glassBlur !== undefined) glass.blur = panelNumber(input.glassBlur, 0, 100, 'glass blur');
    if (input.material !== undefined) {
      if (typeof input.material !== 'string' || !MATERIALS.includes(input.material)) throw new Error('invalid material');
      glass.material = input.material;
    }
    for (const key of regionKeys) {
      const [region, field, max] = REGION_INPUTS[key];
      const regions = glass.regions ?? {};
      regions[region] = { ...(regions[region] ?? {}), [field]: panelNumber(request[key], 0, max, `glass ${key}`) };
      glass.regions = regions;
    }
    next.glass = glass;
  }
  if (input.palette !== undefined) {
    // 清掉 = 去掉覆盖，主题自己的调色板重新生效。设一个则顺手丢掉个人强调色：
    // 不然它会把调色板的 primary 又刷一遍。
    if (input.palette === null) delete next.palette;
    else {
      next.palette = parsePalette(input.palette);
      delete next.accent;
    }
  }
  if (input.accent !== undefined) {
    if (input.accent === null) delete next.accent;
    else if (typeof input.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.accent)) next.accent = input.accent;
    else throw new Error('invalid accent');
  }
  if (input.radius !== undefined) next.radius = panelNumber(input.radius, 0, 4, 'radius');
  if (input.startup !== undefined) {
    if (!input.startup || typeof input.startup !== 'object' || Array.isArray(input.startup)) throw new Error('invalid startup');
    const merged = { ...(next.startup ?? {}) };
    const patch = input.startup;
    for (const key of Object.keys(patch)) {
      if (!['background', 'logo', 'logoSize', 'animation'].includes(key)) throw new Error(`unknown startup field ${key}`);
    }
    if (patch.background !== undefined) {
      if (patch.background === null || patch.background === '') delete merged.background;
      else if (typeof patch.background === 'string' && isSafeCssValue(patch.background, 'image')) merged.background = patch.background;
      else throw new Error('invalid startup background');
    }
    if (patch.logo !== undefined) {
      if (patch.logo === null || patch.logo === '') delete merged.logo;
      else if (typeof patch.logo === 'string') merged.logo = patch.logo;
      else throw new Error('invalid startup logo');
    }
    if (patch.logoSize !== undefined) merged.logoSize = panelNumber(patch.logoSize, 16, 512, 'startup logoSize');
    if (patch.animation !== undefined) {
      if (!STARTUP_ANIMATIONS.includes(patch.animation)) throw new Error('invalid startup animation');
      merged.animation = patch.animation;
    }
    if (Object.keys(merged).length) next.startup = merged;
    else delete next.startup;
  }
  if (input.pet !== undefined) {
    if (!input.pet || typeof input.pet !== 'object' || Array.isArray(input.pet)) throw new Error('invalid pet patch');
    next.pet = { ...(next.pet ?? {}), ...input.pet };
  }
  return next;
}

/** 把主进程选中的图片拷进仓库，返回仓库内路径 */
export function importWallpaperFile(source, home) {
  const extension = extname(source).toLowerCase();
  if (!ALL_WALLPAPER_EXTENSIONS.includes(extension))
    throw new Error(`不支持的壁纸格式 "${extension || basename(source)}"，支持 ${ALL_WALLPAPER_EXTENSIONS.join(' / ')}`);
  if (!existsSync(source) || !statSync(source).isFile()) throw new Error(`所选文件不可用: ${basename(source)}`);
  return storeWallpaper(source, home);
}

/**
 * 注册面板通道。每条注册各自兜底：
 * 注册不上的通道、或某次请求里挂掉的处理器，记一笔跳过——基础外观运行时照常跑。
 */
export function registerPanelHandlers({ home, ipc, log, pickWallpaperFile, pickThemeFolder, pickThemeSaveTarget, petStatus, reload, isPanelSender }) {
  const register = (channel, listener) => {
    try {
      ipc.handle(channel, async (event, value) => {
        try {
          if (!isPanelSender(event)) throw new Error('refused: sender is not an authorized appearance panel caller');
          return await listener(event, value);
        } catch (error) {
          log(`panel ${channel} failed: ${String(error)}`);
          throw error;
        }
      });
    } catch (error) {
      log(`panel ${channel} unavailable: ${String(error)}`);
    }
  };

  // 桌宠那节的事实（素材在不在、平台能不能用桌面模式、默认值）由 main.mjs 注入后并进来。
  // 不放进 readPanelData：素材目录属于 pet 层，外观模型不该反过来依赖它。
  register('zcode-expand:panel-get', () => ({
    ...readPanelData(home),
    petStatus: typeof petStatus === 'function' ? petStatus() : null,
  }));

  register('zcode-expand:panel-apply', (_event, value) => {
    const config = applyPanelInput(readConfig(home), value, home);
    writeConfigAtomic(home, config);
    reload();
    return { ok: true };
  });

  register('zcode-expand:panel-preview', (_event, value) => {
    const config = applyPanelInput(readConfig(home), value, home);
    if (config.enabled === false) return { css: '' };
    const theme = config.theme ? listThemes(home).find((entry) => entry.id === config.theme) ?? null : null;
    return { css: buildCss(resolveLook(config, theme, home)).css };
  });

  register('zcode-expand:panel-pick-wallpaper', async () => {
    const source = await pickWallpaperFile();
    if (!source) return { canceled: true };
    const destination = importWallpaperFile(source, home);
    const config = readConfig(home);
    config.wallpaper = withUnobscuredOverlay({
      ...(config.wallpaper ?? {}),
      image: destination,
      video: VIDEO_EXTENSIONS.includes(extname(destination).toLowerCase()) ? true : undefined,
    });
    if (!config.wallpaper.video) delete config.wallpaper.video;
    writeConfigAtomic(home, config);
    reload();
    return { canceled: false, file: wallpaperDisplayName(basename(destination)) };
  });

  register('zcode-expand:panel-select-wallpaper', (_event, value) => {
    if (typeof value !== 'string' || !ALL_WALLPAPER_EXTENSIONS.includes(extname(value).toLowerCase()))
      throw new Error('invalid stored wallpaper id');
    const file = storedWallpaperPath(home, value);
    if (!statSync(file).isFile()) throw new Error('stored wallpaper is not a file');
    const config = readConfig(home);
    config.wallpaper = withUnobscuredOverlay({ ...(config.wallpaper ?? {}), image: file });
    if (VIDEO_EXTENSIONS.includes(extname(file).toLowerCase())) config.wallpaper.video = true;
    else delete config.wallpaper.video;
    writeConfigAtomic(home, config);
    reload();
    return { ok: true };
  });

  // 给了 name 就存成新主题；不给就存进正在用的用户主题
  register('zcode-expand:panel-save-theme', (_event, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid save request');
    const { name, ...rest } = value;
    if (Object.keys(rest).length) throw new Error('invalid save request');
    const saved = saveLookAsTheme(home, name);
    reload();
    return saved;
  });

  // 另存为新主题：目录由系统保存框选（渲染层没有可用的 prompt），取消则什么都不做。
  // 选中路径就是主题的落点——主题库认得绝对路径，所以不复制、不搬家。
  register('zcode-expand:panel-save-theme-as', async (_event, suggested) => {
    if (typeof suggested !== 'string') throw new Error('invalid save request');
    if (typeof pickThemeSaveTarget !== 'function') throw new Error('这个平台不支持保存对话框');
    const target = await pickThemeSaveTarget(suggested);
    if (target === null) return { canceled: true };
    const saved = saveLookAsTheme(home, basename(target), target);
    reload();
    return { canceled: false, ...saved };
  });

  // 从别处导入一套主题（用户拷来的皮肤文件夹）
  register('zcode-expand:panel-import-theme', async () => {
    if (typeof pickThemeFolder !== 'function') throw new Error('这个平台不支持选择文件夹');
    const source = await pickThemeFolder();
    if (!source) return { canceled: true };
    const imported = importThemeFromDir(home, source);
    reload();
    return { canceled: false, ...imported };
  });
}
