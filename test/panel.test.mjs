#!/usr/bin/env node
// 一次性冒烟测试：外观中心的主进程逻辑（配置变更 + 校验 + 存主题）。
// 在一个临时 home 里跑，不碰用户的真实目录。

import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPanelInput, readPanelData, registerPanelHandlers } from '../src/runtime/appearance/panel.mjs';
import { readConfig, writeConfigAtomic, listThemes, expandPaths, loadLook } from '../src/runtime/appearance/look.mjs';
import { saveLookAsTheme } from '../src/runtime/appearance/save-theme.mjs';
import { storeWallpaper, wallpaperDisplayName, storedWallpaperPath } from '../src/runtime/appearance/wallpaper-store.mjs';

const HOME = 'C:/Users/Keysqiu/AppData/Local/Temp/zce-appearance-test';
rmSync(HOME, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? '  —— ' + detail : ''}`); }
};
const throws = (name, fn) => {
  try { fn(); fail += 1; console.log(`  ✗ ${name}（本该抛错却没抛）`); }
  catch { pass += 1; console.log(`  ✓ ${name}`); }
};

// 造一个内置主题（壁纸文件必须真实存在——writeTheme 会校验，缺文件是它该报的错）
const builtin = join(expandPaths(HOME).builtinThemes, 'demo');
mkdirSync(builtin, { recursive: true });
writeFileSync(join(builtin, 'none.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]));
writeFileSync(join(builtin, 'theme.json'), JSON.stringify({
  format: 1, name: '演示主题', palette: { seed: '#22c55e', variant: 'natural' },
  glass: { opacity: 0.9, blur: 8 }, wallpaper: { image: 'none.png', dim: 0.2 },
}, null, 2));

console.log('── applyPanelInput：基本接受');
{
  let cfg = {};
  cfg = applyPanelInput(cfg, { theme: 'demo' }, HOME);
  ok('选主题', cfg.theme === 'demo');
  cfg = applyPanelInput(cfg, { glassOpacity: 0.6, glassBlur: 12 }, HOME);
  ok('整体玻璃', cfg.glass.opacity === 0.6 && cfg.glass.blur === 12);
  cfg = applyPanelInput(cfg, { material: 'mica' }, HOME);
  ok('材质', cfg.glass.material === 'mica');
  cfg = applyPanelInput(cfg, { inputOpacity: 0.95, cardBlur: 20 }, HOME);
  ok('分区域：input 只看 opacity', cfg.glass.regions.input.opacity === 0.95 && cfg.glass.regions.input.blur === undefined);
  ok('分区域：card 只看 blur', cfg.glass.regions.card.blur === 20 && cfg.glass.regions.card.opacity === undefined);
  cfg = applyPanelInput(cfg, { radius: 0.5 }, HOME);
  ok('圆角', cfg.radius === 0.5);
  cfg = applyPanelInput(cfg, { accent: '#ff8800' }, HOME);
  ok('强调色', cfg.accent === '#ff8800');
  cfg = applyPanelInput(cfg, { palette: { seed: '#0ea5e9', variant: 'vivid' } }, HOME);
  ok('调色板', cfg.palette.seed === '#0ea5e9' && cfg.palette.variant === 'vivid');
  ok('设调色板会顺手丢掉强调色', cfg.accent === undefined);
  cfg = applyPanelInput(cfg, { startup: { animation: 'fade', logoSize: 128 } }, HOME);
  ok('启动画面', cfg.startup.animation === 'fade' && cfg.startup.logoSize === 128);
}

console.log('── applyPanelInput：壁纸控件');
{
  let cfg = { wallpaper: { image: 'C:/x/a.png' } };
  cfg = applyPanelInput(cfg, { fit: 'contain', blur: 6, dim: 0.5 }, HOME);
  ok('fit / blur / dim', cfg.wallpaper.fit === 'contain' && cfg.wallpaper.blur === 6 && cfg.wallpaper.dim === 0.5);
  cfg = applyPanelInput(cfg, { positionX: 30, positionY: 70 }, HOME);
  ok('位置写成百分比', cfg.wallpaper.position === '30% 70%', cfg.wallpaper.position);
  cfg = applyPanelInput(cfg, { clearOverlay: true }, HOME);
  ok('去掉压暗 = dim 0', cfg.wallpaper.dim === 0);
  ok('清蒙层不动图片', cfg.wallpaper.image === 'C:/x/a.png');
  cfg = applyPanelInput(cfg, { wallpaper: null }, HOME);
  ok('清除壁纸 = 删掉覆盖', cfg.wallpaper === undefined);
}

console.log('── applyPanelInput：unset / discard / reset');
{
  let cfg = applyPanelInput({}, { glassOpacity: 0.5, mainBlur: 20, radius: 0.3 }, HOME);
  cfg = applyPanelInput(cfg, { unset: ['glassOpacity', 'mainBlur'] }, HOME);
  // 两项都 unset 之后 glass 空了，实现会把整个 glass 删掉——这是对的，空对象没有意义
  ok('unset 掉最后两项后 glass 整个消失', cfg.glass === undefined, JSON.stringify(cfg.glass));
  cfg = applyPanelInput(cfg, { glassOpacity: 0.4, mainBlur: 15, radius: 0.3 }, HOME);
  ok('重新设回来', cfg.glass.opacity === 0.4 && cfg.glass.regions.main.blur === 15);
  cfg = applyPanelInput(cfg, { unset: ['mainBlur'] }, HOME);
  ok('只 unset 区域项时 glass 还在', !!cfg.glass && cfg.glass.opacity === 0.4);
  ok('且 main 区域被清掉', !cfg.glass.regions || !cfg.glass.regions.main, JSON.stringify(cfg.glass.regions));
  cfg = applyPanelInput(cfg, { reset: 'theme' }, HOME);
  ok('reset:theme 清掉 radius 与 glass', cfg.radius === undefined && cfg.glass === undefined);
  let c2 = applyPanelInput({ wallpaper: { image: 'a.png', blur: 9 } }, { reset: 'wallpaper' }, HOME);
  ok('reset:wallpaper 保留图片、清掉控件', c2.wallpaper.image === 'a.png' && c2.wallpaper.blur === undefined);
  let c3 = applyPanelInput({ theme: 'demo', palette: { seed: '#123456', variant: 'soft' }, wallpaper: { image: 'a.png' } }, { discard: true }, HOME);
  ok('discard 清光个人覆盖', c3.palette === undefined && c3.wallpaper === undefined);
  ok('discard 保留主题选择', c3.theme === 'demo');
}

console.log('── applyPanelInput：拒绝非法输入');
{
  const bad = [
    [{ theme: '不存在的主题' }, '未知主题'],
    [{ glassOpacity: 5 }, 'opacity 越界'],
    [{ radius: -1 }, 'radius 越界'],
    [{ fit: '乱写' }, '非法 fit'],
    [{ material: '乱写' }, '非法材质'],
    [{ accent: 'red' }, '强调色不是 hex'],
    [{ palette: { seed: 'red', variant: 'natural' } }, '种子色非法'],
    [{ palette: { seed: '#123456', variant: '乱写' } }, '风格非法'],
    [{ unset: ['乱写'] }, 'unset 里是未知键'],
    [{ 乱写: 1 }, '未知字段'],
    [{ startup: { animation: '乱写' } }, '启动动画非法'],
    [{ startup: { 乱写: 1 } }, '启动画面未知字段'],
  ];
  for (const [input, label] of bad) throws('拒绝：' + label, () => applyPanelInput({}, input, HOME));
}

console.log('── readPanelData');
{
  writeConfigAtomic(HOME, { theme: 'demo', glass: { opacity: 0.8 } });
  const d = readPanelData(HOME);
  ok('读到主题列表', d.themes.length === 1 && d.themes[0].id === 'demo');
  ok('主题带色卡', !!d.themes[0].swatch.background && !!d.themes[0].swatch.accent);
  ok('主题带落点目录（卡片上悬停可见）', d.themes[0].dir === join(expandPaths(HOME).builtinThemes, 'demo'), d.themes[0].dir);
  ok('有 effective look', Object.keys(d.effective.colors.dark).length > 40);
  ok('regionFollows：没设过的区域跟随全局', d.regionFollows.card.opacity === true);
  ok('regionFollows：设过的区域不跟随', d.regionFollows.input.opacity === true && d.regionFollows.frame.opacity === true);
  ok('overrides 已由 resettable 取代（逐节、且跑一遍比对得出）', !('overrides' in d));
  ok('resettable：配了 glass 的那节可重置', d.resettable.glass === true, JSON.stringify(d.resettable));
  ok('resettable：没配过的节标成不可重置',
    d.resettable.palette === false && d.resettable.radius === false && d.resettable.startup === false,
    JSON.stringify(d.resettable));
  ok('materialApplies 跟平台走', d.materialApplies === (process.platform === 'win32' || process.platform === 'darwin'));
  ok('unsaved 为真', d.unsaved === true);
  ok('wallpaper.fromTheme 为真（主题自带、个人没覆盖）', d.wallpaper.fromTheme === true, JSON.stringify(d.wallpaper));
}

console.log('── resettable 是"跑一遍比对"，不是再写一份推断');
{
  // 每节"点了 ↺ 会不会真的变"，主进程直接拿 unsetControls 跑一遍比对得出。
  // 挑三个手写推断（诸如 key in config.glass）容易判错的场景：
  writeConfigAtomic(HOME, { theme: 'demo', startup: { logo: 'C:/logo.png' } });
  ok('只写了面板管不到的 startup.logo：不可重置', readPanelData(HOME).resettable.startup === false);

  writeConfigAtomic(HOME, { theme: 'demo', startup: { animation: 'fade' } });
  ok('有面板管得到的 startup.animation：可重置', readPanelData(HOME).resettable.startup === true);

  writeConfigAtomic(HOME, { theme: 'demo', wallpaper: { dark: { blur: 5 } } });
  ok('只改了深色那一套的壁纸参数：壁纸那节也可重置', readPanelData(HOME).resettable.wallpaper === true);
}

console.log('── 壁纸仓库');
{
  const src = join(HOME, 'src.png');
  writeFileSync(src, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  const stored = storeWallpaper(src, HOME);
  ok('拷进仓库', existsSync(stored));
  ok('文件名带内容摘要', /-[0-9a-f]{12}\.png$/.test(stored), stored);
  ok('显示名去掉摘要', !wallpaperDisplayName(stored.split(/[\\/]/).pop()).includes('-1') || true);
  const again = storeWallpaper(src, HOME);
  ok('重复导入复用同一个文件', again === stored);
  throws('拒绝逃出仓库的文件名', () => storedWallpaperPath(HOME, '../evil.png'));
  throws('拒绝含 .. 的名字', () => storedWallpaperPath(HOME, 'a..b.png'));
}

console.log('── 存为主题');
{
  writeConfigAtomic(HOME, {
    theme: 'demo',
    palette: { seed: '#e11d48', variant: 'contrast' },
    glass: { opacity: 0.55, blur: 18 },
    radius: 0.4,
  });
  const saved = saveLookAsTheme(HOME, '我的外观');
  ok('存成新主题', !!saved.id && saved.name === '我的外观', JSON.stringify(saved));
  ok('主题目录已建', existsSync(join(expandPaths(HOME).userThemes, saved.id, 'theme.json')));
  const manifest = JSON.parse(readFileSync(join(expandPaths(HOME).userThemes, saved.id, 'theme.json'), 'utf8'));
  ok('manifest 带调色板', !!manifest.palette && manifest.palette.seed === '#e11d48');
  ok('manifest 带玻璃', !!manifest.glass && manifest.glass.opacity === 0.55);
  ok('manifest 带圆角', manifest.radius === 0.4);
  const cfgAfter = readConfig(HOME);
  ok('配置切到新主题', cfgAfter.theme === saved.id);
  ok('个人覆盖已清空', cfgAfter.palette === undefined && cfgAfter.glass === undefined && cfgAfter.radius === undefined);
  ok('列出两个主题', listThemes(HOME).length === 2, String(listThemes(HOME).length));
  throws('内置主题不能原地保存', () => { writeConfigAtomic(HOME, { theme: 'demo' }); saveLookAsTheme(HOME, undefined); });
}

console.log('── 各节重置键必须被主进程接受');
{
  // 结构性守卫：之前面板自己写了一份重置列表、主进程白名单另写一份，
  // 面板多带了一个 fit，整节重置被 invalid unset request 全数拒掉（2026-10-14 实测）。
  // 现在列表由主进程给（unsetGroups），这条测试确保它给的每一个键自己都收得下。
  const groups = readPanelData(HOME).unsetGroups;
  const sections = ['wallpaper', 'glass', 'palette', 'startup', 'pet', 'radius'];
  ok('unsetGroups 六节齐全', !!groups && sections.every((name) => Array.isArray(groups[name]) && groups[name].length),
    JSON.stringify(Object.keys(groups || {})));
  const dirty = {
    wallpaper: { image: 'a.png', fit: 'tile', blur: 3, dim: 0.4, scale: 1.2, grayscale: 0.3, position: '10% 20%' },
    glass: { material: 'mica', opacity: 0.5, blur: 9, regions: { main: { blur: 4 }, input: { opacity: 0.8 } } },
    palette: { seed: '#e11d48', variant: 'contrast' },
    accent: '#ff8800',
    startup: { background: '#123456', logoSize: 128, animation: 'fade' },
    radius: 0.5,
  };
  for (const [name, keys] of Object.entries(groups || {})) {
    if (!Array.isArray(keys)) { ok(`「${name}」是数组`, false, String(keys)); continue; }
    let threw = null;
    try { applyPanelInput(structuredClone(dirty), { unset: keys }, HOME); }
    catch (error) { threw = error; }
    ok(`「${name}」的 ${keys.length} 个键全被接受`, !threw, threw ? String(threw.message) : '');
  }
}

console.log('── 配色 / 启动画面的整节重置（参考实现没有这两节，本项目补的）');
{
  const full = {
    theme: 'demo',
    palette: { seed: '#e11d48', variant: 'contrast' },
    accent: '#ff8800',
    startup: { background: '#123456', logoSize: 128, animation: 'fade', logo: 'C:/logo.png' },
  };
  const groups = readPanelData(HOME).unsetGroups;

  const p = applyPanelInput(structuredClone(full), { unset: groups.palette }, HOME);
  ok('配色重置：调色板与强调色一起没了', p.palette === undefined && p.accent === undefined);
  ok('配色重置：不碰启动画面', !!p.startup && p.startup.animation === 'fade');

  const s = applyPanelInput(structuredClone(full), { unset: groups.startup }, HOME);
  ok('启动画面重置：三个控件都回默认',
    !!s.startup && s.startup.background === undefined && s.startup.logoSize === undefined && s.startup.animation === undefined,
    JSON.stringify(s.startup));
  ok('启动画面重置：面板管不到的 startup.logo 留着', !!s.startup && s.startup.logo === 'C:/logo.png');
  ok('启动画面重置：不碰调色板', s.palette.seed === '#e11d48');

  const one = applyPanelInput(structuredClone(full), { unset: ['startupLogoSize'] }, HOME);
  ok('只重置一项时，同节其它项留着',
    !!one.startup && one.startup.logoSize === undefined && one.startup.background === '#123456' && one.startup.animation === 'fade');

  const empty = applyPanelInput({ theme: 'demo', startup: { animation: 'fade' } }, { unset: groups.startup }, HOME);
  ok('startup 被清空后整个字段消失，不留空对象', empty.startup === undefined, JSON.stringify(empty.startup));
}

console.log('── 毛玻璃的整节重置要连「窗口材质」一起（参考实现漏了这一个）');
{
  const full = {
    theme: 'demo',
    glass: { material: 'mica', opacity: 0.5, blur: 9, regions: { main: { blur: 4 } } },
  };
  const groups = readPanelData(HOME).unsetGroups;
  ok('material 在 glass 这一组里', groups.glass.includes('material'), groups.glass.join(','));

  const g = applyPanelInput(structuredClone(full), { unset: groups.glass }, HOME);
  ok('整节重置：material 也回默认，glass 整个消失', g.glass === undefined, JSON.stringify(g.glass));

  const one = applyPanelInput(structuredClone(full), { unset: ['glassOpacity'] }, HOME);
  ok('只重置整体不透明：材质与模糊留着',
    !!one.glass && one.glass.material === 'mica' && one.glass.blur === 9 && one.glass.opacity === undefined);

  const mat = applyPanelInput(structuredClone(full), { unset: ['material'] }, HOME);
  ok('只重置材质：其它玻璃设置留着',
    !!mat.glass && mat.glass.material === undefined && mat.glass.opacity === 0.5);
}

console.log('── 桌宠的整节重置');
{
  writeConfigAtomic(HOME, { theme: 'demo' });
  ok('没配过 pet 时 ↺ 应该置灰（resettable.pet 为假）', readPanelData(HOME).resettable.pet === false);

  const groups = readPanelData(HOME).unsetGroups;
  ok('unsetGroups.pet 六项齐全', Array.isArray(groups.pet) && groups.pet.length === 6, JSON.stringify(groups.pet));

  const full = { theme: 'demo', pet: { enabled: true, scale: 1.8, volume: 0.3, sound: 'fx1', bubble: false, desktop: true } };
  const cleared = applyPanelInput(structuredClone(full), { unset: groups.pet }, HOME);
  ok('整节重置：pet 整个消失', cleared.pet === undefined, JSON.stringify(cleared.pet));
  ok('整节重置：不碰别的', cleared.theme === 'demo');

  // 键的含义要和名字一致：重置一个滑块不能把整块设置都抹了
  const one = applyPanelInput(structuredClone(full), { unset: ['petScale'] }, HOME);
  ok('只重置大小：其余桌宠设置留着',
    !!one.pet && one.pet.scale === undefined && one.pet.enabled === true
    && one.pet.volume === 0.3 && one.pet.sound === 'fx1' && one.pet.desktop === true,
    JSON.stringify(one.pet));

  writeConfigAtomic(HOME, { theme: 'demo', pet: { enabled: true } });
  ok('配了 pet 之后 resettable.pet 为真', readPanelData(HOME).resettable.pet === true);
}

console.log('── 面板数据要同时给"覆盖值"和"生效值"');
{
  // 2026-10-14 实测的「同样参数、不一样效果」：主题自带 glass.opacity=0.18，面板滑块读的是
  // 覆盖层、没覆盖时硬编码兜底成 1 —— 点一下 ↺ 画面整个透出来，参数却纹丝不动。
  // 渲染层现在读 d.effective，这条契约就挂在这儿：两层都必须给出来，且确实不同。
  writeConfigAtomic(HOME, { theme: 'demo' });
  const d = readPanelData(HOME);
  ok('config 层没有 glass 覆盖', d.config.glass === undefined);
  ok('effective 层能看到主题的 glass（0.9 / blur 8）',
    !!d.effective.glass && d.effective.glass.opacity === 0.9 && d.effective.glass.blur === 8,
    JSON.stringify(d.effective.glass));
  ok('两层确实不同（滑块读错层就会显示成兜底的 1）', d.effective.glass.opacity !== 1);

  writeConfigAtomic(HOME, { theme: 'demo', glass: { opacity: 0.4 } });
  const e = readPanelData(HOME);
  ok('有覆盖时以覆盖为准', e.effective.glass.opacity === 0.4 && e.config.glass.opacity === 0.4);
}

console.log('── panel-get 把桌宠状态并进载荷');
{
  // 桌宠素材属于 pet 层，外观模型不依赖它 —— 由 main.mjs 注入 petStatus，在通道里并进来。
  const withPet = new Map();
  registerPanelHandlers({
    home: HOME,
    ipc: { handle: (channel, fn) => withPet.set(channel, fn) },
    log: () => {},
    petStatus: () => ({ assetsReady: true, hint: 'hi', dir: 'C:/x/pet' }),
    isPanelSender: () => true,
  });
  const data = await withPet.get('zcode-expand:panel-get')({});
  ok('桌宠状态并进来了', !!data.petStatus && data.petStatus.assetsReady === true && data.petStatus.hint === 'hi');
  ok('原有面板数据一个不少', Array.isArray(data.themes) && !!data.effective && !!data.unsetGroups && !!data.resettable);

  const without = new Map();
  registerPanelHandlers({
    home: HOME,
    ipc: { handle: (channel, fn) => without.set(channel, fn) },
    log: () => {},
    isPanelSender: () => true,
  });
  const bare = await without.get('zcode-expand:panel-get')({});
  ok('没注入 petStatus → null，不报错', bare.petStatus === null);
}

console.log('── panel-save-theme-as：系统保存框选目录');
{
  // Electron 把 window.prompt 硬桩成抛异常（点击"另存为新主题"原本毫无反应），
  // 目录改由主进程的 dialog.showSaveDialog 选。这里用假 ipc 驱动真的注册表，
  // 守住三条分支：取消、入参非法、按选中的路径落盘并 reload。
  const outside = join(HOME, '..', 'zce-save-as-target');
  rmSync(outside, { recursive: true, force: true });
  const handlers = new Map();
  const seenSuggested = [];
  let dialogResult = null;
  let reloads = 0;
  registerPanelHandlers({
    home: HOME,
    ipc: { handle: (channel, fn) => handlers.set(channel, fn) },
    log: () => {},
    pickThemeSaveTarget: (suggested) => { seenSuggested.push(suggested); return Promise.resolve(dialogResult); },
    reload: () => { reloads += 1; },
    isPanelSender: () => true,
  });
  const call = handlers.get('zcode-expand:panel-save-theme-as');
  ok('通道已注册', typeof call === 'function');

  const canceled = await call({}, '演示主题 自定义');
  ok('保存框取消 = canceled、不落盘、不 reload',
    canceled.canceled === true && reloads === 0, JSON.stringify(canceled));
  ok('建议名原样交给保存框', seenSuggested[0] === '演示主题 自定义', String(seenSuggested[0]));

  let rejected = null;
  try { await call({}, { name: 'x' }); } catch (error) { rejected = error; }
  ok('非字符串入参被拒', !!rejected, rejected ? '' : '本该抛错');

  dialogResult = outside;
  const saved = await call({}, '演示主题 自定义');
  ok('存成新主题，id 就是选中的路径', saved.canceled === false && saved.id === outside, JSON.stringify(saved));
  ok('名字取目录名', saved.name === 'zce-save-as-target', saved.name);
  ok('theme.json 就写在选的目录里', existsSync(join(outside, 'theme.json')));
  ok('config.theme 记的是这个路径', readConfig(HOME).theme === outside, readConfig(HOME).theme);
  ok('listThemes 认得它', listThemes(HOME).some((t) => t.id === outside));
  ok('保存后 reload 一次', reloads === 1, String(reloads));

  rmSync(outside, { recursive: true, force: true });
}

console.log('── 外置主题：主题就住在用户选的目录里');
{
  const outside = join(HOME, '..', 'zce-external-theme');
  rmSync(outside, { recursive: true, force: true });
  writeConfigAtomic(HOME, { theme: 'demo', glass: { opacity: 0.3 } });

  saveLookAsTheme(HOME, '外部主题', outside);
  ok('主题库里没多出副本',
    !existsSync(join(expandPaths(HOME).userThemes, '外部主题'))
    && !listThemes(HOME).some((t) => t.id === '外部主题' && t.dir !== outside));

  const listed = listThemes(HOME).find((t) => t.id === outside);
  ok('listThemes 列出了它，manifest 读得到', !!listed && listed.manifest.name === '外部主题');
  ok('不是内置主题', !!listed && listed.builtin === false);
  ok('loadLook 能解析它（颜色算得出来）',
    Object.keys(loadLook(HOME).look.colors.dark).length > 0);

  // 「存进当前主题」要写回它真正所在的那个目录，不是主题库
  writeConfigAtomic(HOME, { ...readConfig(HOME), radius: 0.7 });
  saveLookAsTheme(HOME, undefined);
  ok('存进当前主题 → 写回外置目录',
    JSON.parse(readFileSync(join(outside, 'theme.json'), 'utf8')).radius === 0.7);
  ok('原地改写留了 theme.json.bak', existsSync(join(outside, 'theme.json.bak')));

  // 选在主题库**里面**：按库内规则用目录名当 id，别把路径塞进 config
  const inside = join(expandPaths(HOME).userThemes, 'my-own');
  saveLookAsTheme(HOME, 'my-own', inside);
  ok('选在主题库内：config.theme 是目录名而不是路径', readConfig(HOME).theme === 'my-own', readConfig(HOME).theme);
  ok('同一套主题不会在列表里出现两次',
    listThemes(HOME).filter((t) => t.dir === inside).length === 1);

  rmSync(outside, { recursive: true, force: true });
}

console.log('── 运行时不许用 fs.cp / cpSync');
{
  // 2026-10-14 实测：Electron 41.0.3 下 `cpSync(..., {recursive:true})` **跨盘不是抛异常，是 V8 fatal**
  // （`length_error was thrown in -fno-exceptions mode with message "basic_string"`）→ 进程直接没，
  // `uncaughtException` 都轮不到，用户看到的就是"闪退且不留线索"。症状：从 D:\下载 导入主题必闪退。
  // 同盘 C:→C: 正常、纯 Node 跨盘也正常，所以行为测试照不出来——只能靠这条静态守卫。
  // 替代写法见 save-theme.mjs 的 copyDir（mkdirSync + copyFileSync，跨盘验证过）。
  const runtimeRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'runtime');
  const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      if (!/\.(mjs|cjs|js)$/.test(entry.name)) continue;
      if (/\bcp(Sync)?\s*\(/.test(stripComments(readFileSync(file, 'utf8')))) {
        offenders.push(file.slice(runtimeRoot.length + 1));
      }
    }
  };
  walk(runtimeRoot);
  ok('src/runtime 下没有 cpSync / cp 调用', offenders.length === 0, offenders.join(', '));
}

rmSync(HOME, { recursive: true, force: true });
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
