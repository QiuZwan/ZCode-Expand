#!/usr/bin/env node
// Wallpaper Engine 导入：把 WE 项目里的静态壁纸导入为 ZCode-Expand 外观主题
//
// 只读用户指定的 WE 项目目录（不联网、不改源文件、不启动 Wallpaper Engine），
// 产出 `<zcode-expand home>/themes/<id>/theme.json` + 壁纸图片。
//
// 用法：
//   node scripts/we-import.mjs <项目目录> [选项]
//   node scripts/we-import.mjs "<Steam>/steamapps/workshop/content/431960/<项目ID>"
//
// 选项：
//   --dry-run            只报会做什么，不写盘
//   --force              目标主题已存在时覆盖（默认拒绝，提示改用 --force）
//   --preview            导入 scene / video / web 项目的静态预览图
//   --id=<主题id>        指定主题目录名（默认取项目文件夹名）
//   --themes=<目录>      指定主题根目录
//                        默认 $ZCODE_EXPAND_HOME/themes 或 ~/.zcode-expand/themes
//   -h, --help           显示帮助
//
// 退出码：0 成功或无需改动；1 拒绝导入（原因在 stderr）

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** 主题格式版本（外观层契约） */
const THEME_FORMAT = 1;

/** 可直接导入的图片格式：浏览器能渲染、不引入任何可执行内容 */
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.bmp'];

/** 只有静态预览图可选的项目类型（与参考实现一致），一律要求显式 --preview */
const PREVIEW_TYPES = ['scene', 'video', 'web'];

/** 不带值的开关 */
const BOOLEAN_FLAGS = new Set(['dry-run', 'force', 'preview', 'help', 'h']);

/** 支持带值的开关；不认识的一律报错，避免把 `--theme=<dir>` 之类的笔误当成主题根 */
const VALUE_FLAGS = new Set(['id', 'themes']);

function helpText() {
  return `ZCode-Expand · Wallpaper Engine 导入

用法：
  node scripts/we-import.mjs <WE 项目目录> [选项]

把 Wallpaper Engine 项目里的静态图片导入为本仓库的外观主题：
  <主题根>/<id>/theme.json                 主题清单（format=1，wallpaper.image 指向同目录的图片）
  <主题根>/<id>/wallpaper-<摘要><扩展名>   壁纸本体（从 WE 项目拷贝，名字带源图内容摘要）

选项：
  --dry-run            只报会做什么，不写盘
  --force              目标主题已存在时覆盖（默认拒绝）
  --preview            导入 scene / video / web 项目的静态预览图
  --id=<主题id>        指定主题目录名（默认取项目文件夹名，限 A-Za-z0-9._-）
  --themes=<目录>      指定主题根目录（默认 $ZCODE_EXPAND_HOME/themes 或 ~/.zcode-expand/themes）
  -h, --help           显示本帮助

说明：
  · 只读指定的项目目录，不联网、不修改 WE 的文件、不启动 Wallpaper Engine。
  · 只处理 type=image；scene / video / web 必须加 --preview 才会导入其静态预览图。
  · 每次调用只处理一个项目目录；传入 Steam workshop 根目录会列出其中的项目并中止。
  · 同名主题重复导入：内容完全一致时为无操作；不一致时要求 --force 才覆盖。
  · --force 只会重写本工具自己产出的 theme.json 与图片，主题目录里的其它文件不动。`;
}

/** 解析 `--key` / `--key=value` / `-h`；其余为位置参数。未知开关一律报错，避免静默吞掉写错的参数。 */
function parseArgv(argv) {
  const flags = new Map();
  const positional = [];
  for (const arg of argv) {
    if (arg === '-h') {
      flags.set('help', true);
      continue;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (!name) throw new Error(`无法解析参数：${arg}`);
      if (BOOLEAN_FLAGS.has(name)) {
        if (eq !== -1) throw new Error(`开关 --${name} 不带值，请直接写 --${name}`);
        flags.set(name, true);
      } else if (VALUE_FLAGS.has(name)) {
        if (eq === -1) throw new Error(`开关 --${name} 需要写成 --${name}=<值>`);
        flags.set(name, arg.slice(eq + 1));
      } else {
        throw new Error(`未知开关 --${name}。可用：--dry-run / --force / --preview / --id=<主题id> / --themes=<目录>。`);
      }
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`无法解析参数：${arg}`);
    positional.push(arg);
  }
  return { flags, positional };
}

/** 主题根目录：--themes > $ZCODE_EXPAND_HOME/themes > 用户目录/.zcode-expand/themes */
function resolveThemesRoot(explicit) {
  if (explicit) return resolve(explicit);
  const home = process.env.ZCODE_EXPAND_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.zcode-expand');
  return join(resolve(home), 'themes');
}

/** 目录名转安全主题 id（与渲染层/主题 id 的字符约定一致：字母数字 . _ -） */
function safeId(name) {
  return (
    name
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/\.{2,}/g, '.')
      .replace(/^[^A-Za-z0-9]+|-+$/g, '') || 'we-theme'
  );
}

/** 文件名主体转安全段（去空白/中文/怪异字符），用于描述与命名 */
function safeStem(name) {
  return (
    name
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/\.{2,}/g, '.')
      .replace(/^[^A-Za-z0-9]+|-+$/g, '') || 'wallpaper'
  );
}

/**
 * 目标图片名 `wallpaper-<内容摘要 12 位><扩展名>`：文件名里带源图摘要（取舍自参考实现的 contentTag），
 * 于是「换图不改名」也能区分新旧——不会出现「文件名相同所以跳过拷贝、磁盘上却还是旧图」。
 */
function imageFileName(extension, tag) {
  const name = `wallpaper-${tag}${extension}`;
  if (name.includes(sep) || name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(`内部错误：非法的目标图片名 ${name}`);
  }
  return name;
}

/** 内容摘要（sha256 前 12 位）：源图换了就换文件名，主题目录里不会留旧图的混淆版本 */
function contentTag(buffer) {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 12);
}

function isInside(root, file) {
  const rel = relative(root, file);
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
}

/** 真路径，用于校验解析后的路径仍落在允许的根目录内（挡住 symlink 越界） */
function realOrNull(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * 判定用户给出的目录是「一个 WE 项目」还是「放着许多项目的目录」。
 * 后者在 Steam workshop 里很常见（每个项目一个数字子目录），直接从它们里面按名字猜一个项目不靠谱，
 * 所以列出候选并中止；命中多个时给出前 8 个示例。
 */
function resolveProjectDir(input) {
  const dir = resolve(input);
  if (!existsSync(dir)) throw new Error(`目录不存在：${dir}`);
  if (!statSync(dir).isDirectory()) throw new Error(`不是目录：${dir}`);
  if (existsSync(join(dir, 'project.json'))) return dir;

  const candidates = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'project.json')))
    .map((e) => join(dir, e.name));
  if (candidates.length > 0) {
    const shown = candidates.slice(0, 8).map((c) => `    ${c}`);
    if (candidates.length > shown.length) shown.push(`    ...（其余 ${candidates.length - shown.length} 个）`);
    throw new Error(
      `${dir} 下没有 project.json，但它包含 ${candidates.length} 个 Wallpaper Engine 项目（本工具一次处理一个）：\n` +
        `${shown.join('\n')}\n请把其中一个项目目录作为参数重试。`
    );
  }
  throw new Error(`${dir} 下没有 project.json，不是 Wallpaper Engine 项目目录`);
}

/** 解析 project.json 中指向项目内文件的字段（file / preview），并校验存在性与格式 */
function projectImagePath(projectDir, value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`project.json 缺少 ${label} 文件路径`);
  const normalized = value.replace(/\\/g, '/');
  if (isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized) || normalized.split('/').some((part) => part === '..')) {
    throw new Error(`${label} 路径必须是项目目录内的相对路径：${value}`);
  }
  const file = resolve(projectDir, normalized);
  if (!isInside(resolve(projectDir), file)) throw new Error(`${label} 路径超出项目目录：${value}`);
  const realRoot = realOrNull(projectDir);
  const real = realOrNull(file);
  if (realRoot && real && !isInside(realRoot, real)) throw new Error(`${label} 的真实路径超出项目目录（疑似链接）：${value}`);
  if (!real || !statSync(real).isFile()) throw new Error(`${label} 文件不存在：${value}`);
  const extension = extname(file).toLowerCase();
  if (!IMAGE_EXTENSIONS.includes(extension)) {
    throw new Error(
      `${label} 不是支持的图片格式（支持 ${IMAGE_EXTENSIONS.map((e) => e.slice(1)).join('/')}）：${value}`
    );
  }
  return { file, extension };
}

/** 读 WE 项目定义：类型决定用 file 还是 preview，以及是否需要 --preview */
function projectSource(projectDir, preview) {
  const manifestPath = join(projectDir, 'project.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new Error(`project.json 不是有效 JSON：${err.message}`);
  }
  const type = typeof manifest.type === 'string' ? manifest.type.toLowerCase() : '';
  if (type === 'image') {
    if (preview) throw new Error('type=image 的项目原图可直接导入，不需要 --preview；请去掉该开关后重试。');
    const picked = projectImagePath(projectDir, manifest.file, 'image');
    return { type, ...picked };
  }
  if (PREVIEW_TYPES.includes(type)) {
    if (!preview) {
      throw new Error(
        `type=${type} 不是静态原图，不能直接当壁纸导入（它需要 Wallpaper Engine 运行时渲染/播放）。\n` +
          `如要导入它的静态预览图，请显式加 --preview 重试。`
      );
    }
    const picked = projectImagePath(projectDir, manifest.preview, 'preview');
    return { type, ...picked };
  }
  throw new Error(
    `不支持的项目类型 ${JSON.stringify(manifest.type)}（本工具只支持 type=image；scene/video/web 需 --preview）。`
  );
}

/** 待写入的计划；--dry-run 只打印它 */
function describePlan(plan, themesRoot) {
  console.log(`WE 项目    ${plan.projectDir}`);
  console.log(`类型       ${plan.type}（${plan.usedPreview ? '使用静态预览图' : '使用原图'}）`);
  console.log(`源图       ${plan.sourceRel}（${plan.sourceSize.toLocaleString()} 字节，sha256:${plan.tag}）`);
  console.log(`主题 id    ${plan.id}`);
  console.log(`主题目录   ${plan.themeDir}`);
  console.log(`主题名     ${plan.theme.name}`);
  console.log(`目标图片   ${plan.imageName}`);
  if (plan.action === 'create') console.log(`动作       新建主题（主题根：${themesRoot}）`);
  else if (plan.action === 'overwrite') console.log(`动作       覆盖已有主题（${plan.oldImageName ? `替换图片 ${plan.oldImageName} → ${plan.imageName}` : `写入图片 ${plan.imageName}`}）`);
  else console.log('动作       无改动（theme.json 与图片均已是本次导入的结果）');
  if (plan.staleDrop > 0) console.log(`附带清理   ${plan.staleDrop} 个本工具此前产出的旧图片文件`);
}

/** 读已有主题目录的产出信息；目录不存在返回 null */
function themeAt(themeDir) {
  let lst;
  try {
    lst = lstatSync(themeDir);
  } catch {
    return null;
  }
  if (lst.isSymbolicLink()) throw new Error(`主题目录是符号链接，为安全起见拒绝写入：${themeDir}`);
  if (!lst.isDirectory()) throw new Error(`主题路径已存在但不是目录：${themeDir}`);

  const manifestPath = join(themeDir, 'theme.json');
  let theme = null;
  if (existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
      theme =
        parsed && parsed.format === THEME_FORMAT && parsed.wallpaper && typeof parsed.wallpaper.image === 'string'
          ? parsed
          : null;
    } catch {
      theme = null;
    }
  }

  let imageName = null;
  let imageTag = null;
  if (theme) {
    const imagePath = join(themeDir, theme.wallpaper.image);
    try {
      // 只认普通文件：符号链接一律视为「不是本工具的产物」，不写穿、不删
      if (lstatSync(imagePath).isFile()) {
        imageName = basename(imagePath);
        imageTag = fileTag(imagePath); // 磁盘上的实际字节，用来判定「真的没变」
      }
    } catch {
      imageName = null;
    }
  }
  return { theme, imageName, imageTag };
}

/** 列出主题目录里本工具此前产出的图片（用于覆盖时清理旧图） */
function ownImageFiles(themeDir) {
  const found = new Set();
  for (const name of readdirSync(themeDir)) {
    if (!/^wallpaper-[0-9a-f]{12}\.[A-Za-z0-9]{1,8}$/.test(name)) continue;
    try {
      if (lstatSync(join(themeDir, name)).isFile()) found.add(name);
    } catch {
      // 读不到就跳过，不阻拦主流程
    }
  }
  return found;
}

/** 目标图片的 sha256 前 12 位（磁盘上实际内容），读不到返回 null */
function fileTag(path) {
  try {
    return contentTag(readFileSync(path));
  } catch {
    return null;
  }
}

/** 原子写 theme.json：先写临时文件再 rename（同目录内替换，失败不会留下半个文件） */
function writeFileAtomic(file, text) {
  const tmp = join(resolve(file, '..'), `.${basename(file)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, file);
  } finally {
    if (existsSync(tmp)) {
      try {
        unlinkSync(tmp);
      } catch {
        // 清理失败不影响已经 rename 成功的结果
      }
    }
  }
}

function buildTheme(name, imageName, source) {
  const theme = { format: THEME_FORMAT, name, wallpaper: { image: imageName, fit: 'cover' } };
  if (source && source.trim()) theme.description = source.trim();
  return theme;
}

async function main() {
  const { flags, positional } = parseArgv(process.argv.slice(2));
  if (flags.get('help')) {
    console.log(helpText());
    return;
  }
  if (positional.length === 0) throw new Error('缺少参数：请给出一个 Wallpaper Engine 项目目录。\n\n' + helpText());
  if (positional.length > 1) {
    throw new Error(`一次只处理一个项目目录，收到 ${positional.length} 个：${positional.join(', ')}`);
  }

  const dryRun = flags.get('dry-run') === true;
  const force = flags.get('force') === true;
  const preview = flags.get('preview') === true;

  const projectDir = resolveProjectDir(positional[0]);
  const themesRoot = resolveThemesRoot(flags.get('themes'));
  if (isInside(projectDir, themesRoot)) throw new Error(`主题根目录位于项目目录内部，会自我覆盖，请改用 --themes=<目录>：${themesRoot}`);

  // ---- 1) 读项目定义 ----
  const source = projectSource(projectDir, preview);
  const buffer = readFileSync(source.file);
  const tag = contentTag(buffer);
  const stem = safeStem(basename(source.file, extname(source.file)));
  const imageName = imageFileName(source.extension, tag);

  const manifest = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'));
  const title = typeof manifest.title === 'string' && manifest.title.trim() ? manifest.title.trim() : basename(projectDir);
  const themeName = preview && source.type !== 'image' ? `${title}（预览图）` : title;

  const id = typeof flags.get('id') === 'string' ? flags.get('id') : safeId(basename(projectDir));
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error(`主题 id "${id}" 非法：只允许字母、数字、点、下划线与连字符，且以字母或数字开头。`);
  }

  // ---- 2) 目标目录与已有内容 ----
  const themeDir = join(themesRoot, id);
  const existing = existsSync(themeDir) ? themeAt(themeDir) : null;
  // 覆盖前清理本工具此前产出的图片：名字带摘要，除本次目标外一律是旧版本（含直接被替换掉的那张）
  const stale = new Set();
  if (existing) {
    for (const name of ownImageFiles(themeDir)) {
      if (name !== imageName) stale.add(name);
    }
  }
  const staleDrop = stale.size;
  const deleteImages = new Set(stale);
  deleteImages.add(imageName); // 走到覆盖分支即「无改动」判定不成立，目标图同样要重写
  const theme = buildTheme(themeName, imageName, `导入自 Wallpaper Engine 项目「${basename(projectDir)}」（源图 ${stem}${source.extension}）`);

  const plan = {
    action: existing ? 'overwrite' : 'create',
    projectDir,
    type: source.type,
    usedPreview: preview && source.type !== 'image',
    sourceFile: source.file,
    sourceRel: relative(projectDir, source.file).replace(/\\/g, '/'),
    sourceSize: buffer.length,
    tag,
    id,
    themeDir,
    theme,
    imageName,
    oldImageName: existing?.imageName ?? null,
    staleDrop,
  };

  // ---- 3) 同内容重复导入 = 无操作（纯幂等；与 --force 无关）----
  // 三重比对：theme.json 逐字符一致 + 图片文件名一致 + 磁盘图片字节与源图一致。
  // 第三重不能省：文件名带摘要，但若那张图曾被手工改动/上一次写入中断，只看名字会误报「无改动」。
  if (
    existing &&
    existing.theme &&
    existing.imageName === imageName &&
    existing.imageTag === tag &&
    JSON.stringify(existing.theme) === JSON.stringify(theme)
  ) {
    describePlan({ ...plan, action: 'noop', staleDrop: 0 }, themesRoot);
    console.log('\n检查 1 个项目：无需改动 1，已跳过 0，失败 0。');
    return;
  }

  // ---- 4) 已存在且不同：默认拒绝，要求 --force ----
  if (existing && !force) {
    throw new Error(
      `主题 "${id}" 已存在：${themeDir}\n` +
        `  已有：${existing.theme ? `name=${JSON.stringify(existing.theme.name)}，图片 ${existing.imageName ?? '(缺失)'}` : '不是本工具产出的主题'}\n` +
        `  本次：name=${JSON.stringify(themeName)}，图片 ${imageName}\n` +
        `加 --force 覆盖（只重写本工具产出的 theme.json 与图片，主题目录里的其它文件不动），或用 --id=<主题id> 换个名字。`
    );
  }

  // ---- 5) 演练或写入 ----
  describePlan(plan, themesRoot);
  if (dryRun) {
    console.log('\n[dry-run] 未写入任何文件。检查 1 个项目：将导入 1，已跳过 0，失败 0。');
    return;
  }

  mkdirSync(themeDir, { recursive: true });
  const themeReal = realOrNull(themeDir);
  const rootReal = realOrNull(themesRoot);
  if (!themeReal || !rootReal || !isInside(rootReal, themeReal)) {
    throw new Error(`主题目录的真实路径超出主题根目录（疑似链接）：${themeDir}`);
  }
  // 只删本工具自己按命名规则产出的图片，且只认普通文件（符号链接一律不碰）
  for (const name of deleteImages) {
    try {
      if (lstatSync(join(themeDir, name)).isFile()) unlinkSync(join(themeDir, name));
    } catch {
      // 已被手工删掉则忽略
    }
  }
  // 走到这里说明「无改动」判定不成立：目标图要么不存在，要么是手工改过/上次中断的残留，一律重写
  const imagePath = join(themeDir, imageName);
  const leftover = lstatSync(imagePath, { throwIfNoEntry: false });
  if (leftover && !leftover.isFile()) throw new Error(`目标图片路径已存在且不是普通文件，拒绝写入：${imagePath}`);
  copyFileSync(source.file, imagePath);
  writeFileAtomic(join(themeDir, 'theme.json'), JSON.stringify(theme, null, 2) + '\n');

  console.log(`\n完成：主题 ${id} → ${themeDir}`);
  console.log('检查 1 个项目：已导入 1，已跳过 0，失败 0。');
}

main().catch((err) => {
  console.error(`失败：${err.message}`);
  // 失败原因已经打在错误里；跳过与失败都按数量报，不静默
  console.error('检查 1 个项目：已导入 0，已跳过 0，失败 1。');
  process.exitCode = 1;
});
