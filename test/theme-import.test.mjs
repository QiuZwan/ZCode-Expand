// 主题导入的冒烟测试：从「别人给的文件夹」导入一套主题，并守住错误路径。
// 与 test/ 下另外两个一样用自建断言 + 非零退出码，node --test 按退出码判成败。
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { importThemeFromDir } from '../src/runtime/appearance/save-theme.mjs';
import { listThemes, resolveLook, expandPaths } from '../src/runtime/appearance/look.mjs';
import { readPanelData } from '../src/runtime/appearance/panel.mjs';

const HOME = join(process.env.TEMP || '/tmp', `zce-import-test-${process.pid}`);
rmSync(HOME, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? '  —— ' + detail : ''}`); }
};
const throws = (name, fn) => {
  try { fn(); fail += 1; console.log(`  ✗ ${name}（本该抛错）`); }
  catch { pass += 1; console.log(`  ✓ ${name}`); }
};

// 造一个「别人给的主题」
const src = join(HOME, '别人的主题');
mkdirSync(join(src, 'sub'), { recursive: true });
writeFileSync(join(src, 'theme.json'), JSON.stringify({
  format: 1, name: '赛博紫', palette: { seed: '#a855f7', variant: 'vivid' },
  wallpaper: { gradient: 'linear-gradient(135deg,#1a0033,#4c1d95)' },
}, null, 2));
writeFileSync(join(src, 'cover.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]));
writeFileSync(join(src, 'sub', 'extra.txt'), 'nested');
writeFileSync(join(src, 'theme.json.bak'), '不该被搬进来');

const r = importThemeFromDir(HOME, src);
ok('导入返回 id 与名字', r.id && r.name === '赛博紫', JSON.stringify(r));
ok('目录已生成', existsSync(join(expandPaths(HOME).userThemes, r.id, 'theme.json')));
ok('嵌套子目录一起带过来', existsSync(join(expandPaths(HOME).userThemes, r.id, 'sub', 'extra.txt')));
ok('.bak 没被搬进来', !existsSync(join(expandPaths(HOME).userThemes, r.id, 'theme.json.bak')));
ok('源目录没被动过', existsSync(join(src, 'theme.json')));
ok('listThemes 能列出它', listThemes(HOME).some((t) => t.id === r.id));
ok('面板数据里有它、且带名字', readPanelData(HOME).themes.some((t) => t.id === r.id && t.name === '赛博紫'));
ok('它能被解析出配色', Object.keys(resolveLook({ theme: r.id }, listThemes(HOME).find((t) => t.id === r.id), HOME).colors.dark).length > 40);

const r2 = importThemeFromDir(HOME, src);
ok('重名自动换 id，不覆盖', r2.id !== r.id, r2.id);
ok('两套都在', listThemes(HOME).length === 2);

const empty = join(HOME, '空目录');
mkdirSync(empty, { recursive: true });
throws('没有 theme.json 的文件夹被拒绝', () => importThemeFromDir(HOME, empty));
const bad = join(HOME, '坏json');
mkdirSync(bad, { recursive: true });
writeFileSync(join(bad, 'theme.json'), '{ 不是 json');
throws('坏 JSON 被拒绝', () => importThemeFromDir(HOME, bad));
const noname = join(HOME, '缺名字');
mkdirSync(noname, { recursive: true });
writeFileSync(join(noname, 'theme.json'), JSON.stringify({ format: 1, palette: { seed: '#123456' } }));
throws('缺 name 被拒绝', () => importThemeFromDir(HOME, noname));

rmSync(HOME, { recursive: true, force: true });
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
