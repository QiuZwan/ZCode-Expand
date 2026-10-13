// 皮肤颜色数学的单测（Node 内置 test runner，零依赖）
//
// src/renderer/zc-skin-colors.js 是给浏览器用的普通 IIFE 脚本（不导出），
// 所以这里用「副作用导入 + 读全局」的方式取它的 API。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/renderer/zc-skin-colors.js';

const C = globalThis.__ZC_SKIN_COLORS__;

/** HSL 明度，独立复算（不用被测函数验证被测函数） */
function luminanceOf(hex) {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return (max + min) / 2;
}

const SAMPLE = { accent: '#3b82f6', secondary: '#f59e0b', surface: '#111827', text: '#e5e7eb' };

test('VAR_MAP 恰好 39 个键，且值全是 --color- 前缀', () => {
  const keys = Object.keys(C.VAR_MAP);
  assert.equal(keys.length, 39);
  for (const v of Object.values(C.VAR_MAP)) assert.match(v, /^--color-[a-z-]+$/);
});

test('SCHELL_VARS 含两个窗口壳变量（Windows 走的是 win-alt，漏一个就透不出来）', () => {
  assert.deepEqual([...C.SCHELL_VARS].sort(), ['--color-background-alt', '--color-background-win-alt']);
});

test('alpha 输出 #RRGGBBAA 且端点正确', () => {
  assert.equal(C.alpha('#112233', 1), '#112233ff');
  assert.equal(C.alpha('#112233', 0), '#11223300');
});

test('mix 在 t=0 返回 a、t=1 返回 b', () => {
  assert.equal(C.mix('#000000', '#ffffff', 0), '#000000');
  assert.equal(C.mix('#000000', '#ffffff', 1), '#ffffff');
  assert.equal(C.mix('#000000', '#ffffff', 0.5), '#808080');
});

// 输出要取整到 8 位色值，HSL 明度会因此有 ±1/255 量级的误差，断言给 0.01 容差
const TOL = 0.01;

test('ensureAccentVisible 把纯黑主色夹进深色主题安全明度区间', () => {
  const l = luminanceOf(C.ensureAccentVisible('#0a0a0a', 'dark'));
  assert.ok(l >= 0.52 - TOL && l <= 0.72 + TOL, `明度 ${l} 不在 [0.52, 0.72]`);
});

test('ensureAccentVisible 把纯白主色夹进浅色主题安全明度区间', () => {
  const l = luminanceOf(C.ensureAccentVisible('#fefefe', 'light'));
  assert.ok(l >= 0.30 - TOL && l <= 0.48 + TOL, `明度 ${l} 不在 [0.30, 0.48]`);
});

test('ensureAccentVisible 保住色相（红仍是红）', () => {
  const out = C.ensureAccentVisible('#3a0a0a', 'dark');
  const [r, g, b] = C.hexToRgb(out);
  assert.ok(r > g && r > b, `色相没保住：${out}`);
});

test('buildColors 每个 appearance 都产出 VAR_MAP 的全部键，且值都是合法颜色', () => {
  for (const appearance of ['dark', 'light']) {
    const colors = C.buildColors(SAMPLE, appearance);
    assert.deepEqual(Object.keys(colors).sort(), Object.keys(C.VAR_MAP).sort(), `${appearance} 键集不符`);
    for (const [k, v] of Object.entries(colors)) {
      assert.match(v, /^#[0-9a-f]{6}([0-9a-f]{2})?$/i, `${appearance}.${k} 不是合法色值：${v}`);
    }
  }
});

test('buildColors 的 background 恒为全透明（背景要透出来）', () => {
  for (const appearance of ['dark', 'light']) {
    assert.equal(C.buildColors(SAMPLE, appearance).background, '#00000000');
  }
});

test('buildSkinCss 同时把两个窗口壳变量抹成全透明（Review Focus 2）', () => {
  const css = C.buildSkinCss({ id: 'x', name: 'x', appearance: 'dark', colors: C.buildColors(SAMPLE, 'dark') });
  for (const v of C.SCHELL_VARS) {
    assert.match(css, new RegExp(`${v}\\s*:\\s*#00000000\\s*!important`), `${v} 没被抹成全透明`);
  }
});

test('buildSkinCss 的变量块同时覆盖 :root 与 :root.dark（防止切换系统深浅冲掉皮肤）', () => {
  const css = C.buildSkinCss({ id: 'x', appearance: 'dark', colors: C.buildColors(SAMPLE, 'dark') });
  assert.match(css, /:root\s*,\s*:root\.dark\s*\{/);
});

test('buildSkinCss 的背景层用高特异性选择器（避开应用那条 background:0 0!important 重置）', () => {
  const css = C.buildSkinCss({
    id: 'x',
    appearance: 'dark',
    heroDataUrl: 'data:image/jpeg;base64,AAAA',
    colors: C.buildColors(SAMPLE, 'dark'),
  });
  // 应用的 html,body,#root{background:0 0!important} 同为 (0,0,1) 且注入更晚，会压掉直白的 html/body
  assert.match(css, /:root,\s*html body\s*\{[^}]*background:\s*url\("data:image\/jpeg;base64,AAAA"\)/);
  // 确认没有退回低特异性的裸 html/body 写法
  assert.doesNotMatch(css, /(^|[^,\w])html,\s*body\s*\{/);
  assert.doesNotMatch(css, /(^|[^,\w:])html\s*\{\s*background/);
});

test('buildSkinCss 不带背景时不产出任何背景规则（只用变量配色）', () => {
  const css = C.buildSkinCss({ id: 'x', appearance: 'dark', colors: C.buildColors(SAMPLE, 'dark') });
  assert.doesNotMatch(css, /:root,\s*html body\s*\{/);
  assert.doesNotMatch(css, /\{\s*background:/);
});

test('buildSkinCss 带 heroCss 时产出渐变背景层（内置预设走这条）', () => {
  const css = C.buildSkinCss({
    id: 'x',
    appearance: 'dark',
    heroCss: 'linear-gradient(135deg, #0b1020 0%, #2b3a67 100%)',
    colors: C.buildColors(SAMPLE, 'dark'),
  });
  assert.match(css, /:root,\s*html body\s*\{[^}]*background:\s*linear-gradient\(135deg, #0b1020 0%, #2b3a67 100%\)\s*!important/);
});

test('heroDataUrl 优先于 heroCss（用户选图后不该被预设渐变盖掉）', () => {
  const css = C.buildSkinCss({
    id: 'x',
    appearance: 'dark',
    heroDataUrl: 'data:image/jpeg;base64,AAAA',
    heroCss: 'linear-gradient(red, blue)',
    colors: C.buildColors(SAMPLE, 'dark'),
  });
  assert.match(css, /background:\s*url\("data:image\/jpeg;base64,AAAA"\)/);
  assert.doesNotMatch(css, /linear-gradient\(red, blue\)/);
});

test('降采样尺寸计算：极端长宽比下短边至少为 1（Review Focus 5）', () => {
  assert.equal(C.scaledSize(10000, 200, 1920).height >= 1, true);
  assert.deepEqual(C.scaledSize(10000, 200, 1920), { width: 1920, height: 38 });
  assert.deepEqual(C.scaledSize(100, 10000, 1920), { width: 19, height: 1920 });
  // 短边四舍五入到 0 的极端情形
  assert.deepEqual(C.scaledSize(20000, 3, 1920), { width: 1920, height: 1 });
});
