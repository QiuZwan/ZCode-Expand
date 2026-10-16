#!/usr/bin/env node
// 一次性冒烟测试：外观层的四个纯函数模块能不能跑通、产出是否合理。
// 不是为了覆盖，是为了抓移植时的打字错（手抄 1500 行的主要风险）。

import { regionAlphas, mainCappedByFrame, GLASS_REGIONS, regionHighlightCss } from '../src/runtime/appearance/glass.mjs';
import { generatePalette, extractColors, contrastRatio, isPaletteColor, filteredBackdrop } from '../src/runtime/appearance/palette.mjs';
import { resolveLook, mergeLayers, checkManifest, DEFAULT_CONFIG, videoKey } from '../src/runtime/appearance/look.mjs';
import { buildCss, contrastForeground, isSafeCssValue, COVERED_WORKSPACE, PLUGIN_PAGE_LAYER } from '../src/runtime/appearance/css.mjs';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? '  —— ' + detail : ''}`); }
};

console.log('── glass');
{
  const opaque = { frame: { opacity: 1, blur: 0 }, main: { opacity: 1, blur: 0 }, card: { opacity: 1, blur: 0 }, input: { opacity: 1, blur: 0 } };
  const a = regionAlphas(opaque);
  ok('全不透明 → 全部 alpha = 1', GLASS_REGIONS.every((r) => a[r] === 1));
  ok('mainCappedByFrame(全不透明) = false', mainCappedByFrame(opaque) === false);

  const glassy = { frame: { opacity: 0.6, blur: 0 }, main: { opacity: 0.5, blur: 20 }, card: { opacity: 0.5, blur: 20 }, input: { opacity: 0.5, blur: 20 } };
  const b = regionAlphas(glassy);
  ok('壳 = 0.6×0.7 = 0.42', Math.abs(b.frame - 0.42) < 1e-9, String(b.frame));
  ok('主区 alpha 在 (0,1)', b.main > 0 && b.main < 1, String(b.main));
  ok('抬起的表面比主区实', b.card > b.main);
  ok('frame 区不参与模糊，regionHighlightCss(frame) 指向窗口壳', regionHighlightCss('frame').includes('data-desktop-window-frame'));
  ok('regionHighlightCss(null) 为空', regionHighlightCss(null) === '');
}

console.log('── palette');
{
  ok('isPaletteColor 认 #rrggbb', isPaletteColor('#3b82f6') && !isPaletteColor('red') && !isPaletteColor('#abc'));
  ok('对比度黑白 = 21', Math.abs(contrastRatio('#000000', '#ffffff') - 21) < 1e-6);

  const p = generatePalette({ seed: '#3b82f6', variant: 'natural' });
  ok('生成成功', !!p);
  const keys = Object.keys(p.colors.dark);
  ok('暗色 token 数 > 40', keys.length > 40, String(keys.length));
  ok('亮暗两套都有', Object.keys(p.colors.light).length === keys.length);
  ok('每个 token 都是合法色值', keys.every((k) => /^#[0-9a-f]{6}$/i.test(p.colors.dark[k]) || /^rgba\(/.test(p.colors.dark[k])),
    keys.find((k) => !/^#[0-9a-f]{6}$/i.test(p.colors.dark[k]) && !/^rgba\(/.test(p.colors.dark[k])));
  ok('正文对主表面的对比度 ≥ 4.5', contrastRatio(p.colors.dark.foreground, p.colors.dark.background) >= 4.5,
    String(contrastRatio(p.colors.dark.foreground, p.colors.dark.background).toFixed(2)));

  const five = ['natural', 'vivid', 'soft', 'oled', 'contrast'].map((v) => generatePalette({ seed: '#e05252', variant: v }));
  ok('五种风格都能生成', five.every(Boolean));
  ok('oled 的 frame 是纯黑', five[3].colors.dark['background-win-alt'] === '#000000', five[3].colors.dark['background-win-alt']);
  ok('五种风格产出互不相同', new Set(five.map((g) => g.colors.dark.background)).size >= 3);

  ok('种子非法 → null', generatePalette({ seed: 'blue' }) === null);

  // 造一张 4×4 的纯红图，取色应给出偏红的种子
  const bytes = [];
  for (let i = 0; i < 16; i += 1) bytes.push(220, 40, 40, 255);
  const ex = extractColors(bytes);
  ok('extractColors 有结果', !!ex && ex.seeds.length > 0);
  ok('平均色偏红', ex && ex.average.startsWith('#') && parseInt(ex.average.slice(1, 3), 16) > parseInt(ex.average.slice(5, 7), 16));

  const fb = filteredBackdrop('#808080', 1, 0.5, null, 'dark');
  ok('压暗后比原色暗', parseInt(fb.slice(1, 3), 16) < 0x80, fb);
}

console.log('── look（解析）');
{
  const config = {
    theme: null,
    palette: { seed: '#7c3aed', variant: 'vivid' },
    glass: { material: 'mica', opacity: 0.7, blur: 12, regions: { input: { opacity: 0.9 } } },
    wallpaper: { image: 'C:/tmp/a.png', fit: 'cover', dim: 0.4 },
    radius: 0.5,
    startup: { animation: 'fade' },
  };
  const look = resolveLook(config, null, 'C:/home');
  ok('调色板生效（colors 非空）', Object.keys(look.colors.dark).length > 40, String(Object.keys(look.colors.dark).length));
  ok('材质取到 mica', look.glass.material === 'mica');
  ok('全局透明度 0.7，input 区域单独 0.9', Math.abs(look.glass.regions.input.opacity - 0.9) < 1e-9 && Math.abs(look.glass.regions.main.opacity - 0.7) < 1e-9);
  ok('圆角 0.5', look.radius === 0.5);
  ok('壁纸被解析', look.wallpaper.dark && look.wallpaper.dark.image === 'C:/tmp/a.png');
  ok('壁纸 video 默认 false', look.wallpaper.dark.video === false);
  ok('启动动画 fade', look.startup.animation === 'fade');

  const off = resolveLook({ enabled: false }, null, 'C:/home');
  ok('关掉时 colors 为空', Object.keys(off.colors.dark).length === 0);

  const bad = resolveLook({ palette: { seed: '#ff0000' }, wallpaper: { image: 'x.png', fit: '不存在' } }, null, 'C:/h');
  ok('非法 fit 回退 cover', bad.wallpaper.dark.fit === 'cover', bad.wallpaper.dark.fit);

  const w = checkManifest('t', { name: 'x', 乱写: 1 });
  ok('未知字段被报出来', w.some((m) => m.includes('unknown field')));
}

console.log('── css（生成）');
{
  const look = resolveLook({
    palette: { seed: '#0ea5e9', variant: 'natural' },
    wallpaper: { image: 'C:/tmp/a.png', fit: 'cover', dim: 0.4, blur: 8 },
    glass: { opacity: 0.6, blur: 14 },
    startup: { animation: 'fade', logoSize: 120 },
    radius: 0.5,
  }, null, 'C:/home');
  const { css, warnings } = buildCss(look);
  ok('没有告警', warnings.length === 0, warnings.join('; '));
  ok('产出 CSS', css.length > 500, String(css.length));
  ok('含暗色选择器 html:root.dark', css.includes('html:root.dark'));
  ok('含亮色选择器', css.includes('html:root:not(.dark)'));
  ok('壁纸用 file:// URL', css.includes('url("file:///C:/tmp/a.png') || css.includes('url("file:///c:/tmp/a.png'), css.slice(0, 200));
  ok('壁纸层 z-index:-1', css.includes('z-index: -1'));
  ok('毛玻璃用 #root 上的 color-mix', css.includes('#root {') && css.includes('color-mix('));
  ok('有 backdrop-filter', css.includes('backdrop-filter: blur(14px)'));
  // 侧栏插件页的 <webview> 在 <body> 下、#root 之外，设置页半透明时会整个透出来。
  // 只在这个状态下藏它，且必须和 ZCode 藏工作区用同一个判定条件。
  ok('玻璃下：设置盖住工作区时藏掉侧栏插件页那层',
    css.includes(`body:has(> #root ${COVERED_WORKSPACE}) > ${PLUGIN_PAGE_LAYER} {\n  opacity: 0;\n}`),
    css.split('\n').find((l) => l.includes('sandbox-page-parking')));
  ok('全不透明（无玻璃）时不生成这条规则',
    !buildCss(resolveLook({}, null, 'C:/home')).css.includes(PLUGIN_PAGE_LAYER));
  ok('启动画面 logo 尺寸生效', css.includes('width: 120px'));
  ok('圆角变量被写', css.includes('--radius-lg:'));
  ok('不含 !important 之外的危险值', !css.includes('@import'));

  // 视频壁纸：不应产出背景 url，但保留压暗蒙层
  const vid = resolveLook({ wallpaper: { image: 'C:/tmp/a.mp4', video: true, dim: 0.5 } }, null, 'C:/h');
  const v = buildCss(vid);
  ok('视频壁纸不出 body::before 背景', !v.css.includes('body::before {'), v.css.slice(0, 160));
  ok('视频壁纸仍出压暗蒙层', v.css.includes('body::after'));

  ok('对比度守卫：白底选黑字', contrastForeground('#ffffff') === '#000000');
  ok('对比度守卫：黑底选白字', contrastForeground('#000000') === '#ffffff');
  ok('CSS 值守卫：挡住 url()', !isSafeCssValue('url(evil)', 'color'));
  ok('CSS 值守卫：挡住分号注入', !isSafeCssValue('red; }', 'color'));
  ok('CSS 值守卫：放行正常色值', isSafeCssValue('#3b82f6', 'color') && isSafeCssValue('oklch(0.7 0.1 200)', 'color'));
  ok('CSS 值守卫：vars 放行 var()', isSafeCssValue('var(--color-x)', 'vars'));
}

console.log('── 视频壁纸的"变没变"指纹');
{
  // 2026-10-14 实测的 bug：两个视频壁纸互切没反应，必须先切到别的壁纸再切回来。
  // 成因是视频路径不进 CSS，「视频 A → 视频 B」算出来的 css 逐字节相同，
  // 外层只比 CSS 就把它判成空操作、不推通知，渲染层的 <video> 于是不换片。
  // 这两条断言把"必须另算指纹"这个前提钉死：CSS 相同，而 videoKey 必须不同。
  const at = (wallpaper) => resolveLook({ wallpaper }, null, 'C:/home');
  const videoLook = (image) => at({ image, video: true });

  const a = videoLook('C:/tmp/a.mp4');
  const b = videoLook('C:/tmp/b.mp4');
  ok('两段不同视频的 CSS 逐字节相同（所以光比 CSS 判不出切换）', buildCss(a).css === buildCss(b).css);
  ok('但 videoKey 不同', videoKey(a) !== videoKey(b), `${videoKey(a)} vs ${videoKey(b)}`);
  ok('videoKey 是 file:// URL', videoKey(a).startsWith('file:///'), videoKey(a));
  ok('同一段视频重复解析，videoKey 稳定', videoKey(videoLook('C:/tmp/a.mp4')) === videoKey(a));

  ok('换成图片壁纸：videoKey 里不再有 URL', !videoKey(at({ image: 'C:/tmp/c.png' })).includes('file://'));
  ok('清掉壁纸：videoKey 里不再有 URL', !videoKey(at({ image: null })).includes('file://'));
  ok('视频 → 图片：videoKey 变', videoKey(at({ image: 'C:/tmp/c.png' })) !== videoKey(a));
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
