#!/usr/bin/env node
// 渲染层外观面板的**结构性守卫**。
//
// 这一层没有 DOM 可用（本仓库刻意零依赖，不引 jsdom），跑不了真行为，
// 只能把"踩过的结构错"钉成断言。所以只写有因果关系的几条，不写"文件里有这个字符串"那种空测试。

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const renderer = (name) => readFileSync(join(here, '..', 'src', 'runtime', 'renderer', name), 'utf8');
const source = renderer('overlay.js');

// 去掉注释再扫：说明性注释里提到某个 API 不该判违规。
// 行注释按"行首或前面有空白"来认——不能写成 (^|[^:])：file:///C:/a.mp4 里第二对斜杠
// 前面是 /，会被当成注释起点，把后半行的真调用整段吃掉（假阴性，本守卫自检过）。
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? '  —— ' + detail : ''}`); }
};

console.log('── 操作提示只能有一个落点');
{
  // 2026-10-14 实测：面板里有两个 class="msg" 的元素——壁纸区一个行内提示（"当前：xx.mp4"），
  // 面板底部一个固定提示。而 msg() 用 rootNode.querySelector('.msg') 取的是**文档顺序里第一个**，
  // 也就是壁纸区那个（它在 .bd 里，排在面板底部那个前面）。
  // 后果：操作提示跑到面板中间，写进哪儿还取决于"当下有没有壁纸"——
  // 刚选完壁纸那一刻壁纸区那行还没重建出来，提示才落到真正的底部。
  const created = [...source.matchAll(/el\('div',\s*'msg'/g)].length;
  ok('整份源码只创建一处 .msg（底部那条固定提示）', created === 1, `找到 ${created} 处`);

  // 只取函数体，避免匹配到函数上方那段解释性注释里出现的 querySelector 字样
  const body = /function msg\(text, isError\)\s*\{([\s\S]*?)\n  \}/.exec(source);
  ok('取到了 msg() 函数体', !!body);
  if (body) {
    ok('msg() 按 id 定位底部提示', body[1].includes('getElementById(STATUS_ID)'));
    ok('msg() 不再用"第一个匹配"的选择器', !body[1].includes('querySelector'), body[1].trim());
  }

  ok('壁纸区的行内提示用 note 类名，不叫 msg', source.includes("el('div', 'note'"));
  ok('底部提示节点带上了 STATUS_ID', /status\.id = STATUS_ID/.test(source));
}

console.log('── 取色：图片与视频共用同一份采样');
{
  // 2026-10-14：视频壁纸取色原本必然失败——imageUrl 对视频也给的是 mp4 的文件 URL，
  // 塞进 <img> 只会 onerror。现在视频走"采常驻视频层的当前帧"，采样逻辑两边共用一份。
  const picks = [...source.matchAll(/getImageData\(/g)].length;
  ok('采样逻辑只有一份（seedFromSource），没有为视频再抄一遍', picks === 1, `找到 ${picks} 处`);
  ok('视频走 pickSeedFromVideo', source.includes('function pickSeedFromVideo()'));
  ok('视频取色前先判 readyState，否则会画到全黑帧', /readyState < 2/.test(source));

  // 跨文件约定：视频层的元素 id 一个字面量写死在两个文件里，改名必须两边一起改。
  // 从 wallpaper-video.js 里把 id 抠出来比对，改单边就会红。
  const layer = renderer('wallpaper-video.js');
  const declared = /var VIDEO_ID = '([^']+)'/.exec(layer);
  ok('视频层声明了 VIDEO_ID', !!declared, declared ? declared[1] : '没找到');
  if (declared) {
    ok('overlay.js 取的是同一个元素', source.includes(`getElementById('${declared[1]}')`), declared[1]);
  }
}

console.log('── 渲染层不许用同步模态框');
{
  // window.confirm / alert / prompt 在 Electron 里都是**同步**的：渲染层脚本会一直停摆到
  // 对话框关闭（要等 DialogClosedCallback 回来），窗口本身也被禁用来做模态。
  // 2026-10-14 实测：点「丢弃所有个人覆盖」弹确认框，期间整个界面卡住，取消后还要等
  // 积压的事件跑完，输入框才聚焦。prompt 更狠——渲染层被直接桩成抛异常。
  // 需要一个"你确定吗"，就学参考实现：按钮点两次，第二次前自己变成确认态。
  const dir = join(here, '..', 'src', 'runtime', 'renderer');
  const files = readdirSync(dir).filter((name) => name.endsWith('.js'));
  ok('扫到了渲染层文件', files.length > 0, files.join(', '));

  // 去掉注释再扫：说明性注释里写 window.confirm 不该判违规（stripComments 在文件头上）
  const banned = /window\s*\.\s*(confirm|alert|prompt)\s*\(/;
  const offenders = files.filter((name) => banned.test(stripComments(renderer(name))));
  ok('没有任何渲染层模块调用 window.confirm/alert/prompt', offenders.length === 0, offenders.join(', '));

  // 守卫自检：一条认得出真调用、放过注释、且不被 file:// 骗过的规则才有意义
  ok('守卫本身有效（认调用 / 放过注释 / 不被 file:// 骗）',
    banned.test(stripComments("if (!window.confirm('x')) return;"))
    && !banned.test(stripComments('  // 别用 window.confirm 这种东西'))
    && !banned.test(stripComments('/* window.alert(1) */'))
    && banned.test(stripComments("var u = 'file:///C:/a.mp4'; window.alert(1);")));

  ok('丢弃按钮改走"点两次"确认', source.includes('确认丢弃') && source.includes('function disarmDiscard'));
}

console.log('── 滑块/下拉显示"生效值"，文本框显示"覆盖值"');
{
  // 2026-10-14 实测：主题 custom-2 自带 glass.opacity=0.18，而滑块读的是 config 那层，
  // 没覆盖时硬编码兜底成 1。于是点一下毛玻璃的 ↺，画面整个透出来，面板参数却纹丝不动。
  // 滑块/下拉没法表达"未设置"，必须显示生效值（主题 ⊕ 覆盖）；文本框靠"留空=主题的"表达未覆盖，
  // 所以仍只显示覆盖值，把主题那个值写进 placeholder。
  const pins = [
    ["slider('整体不透明', effGlass.opacity", '整体不透明'],
    ["slider('整体模糊', effGlass.blur", '整体模糊'],
    ["select('窗口材质', effGlass.material", '窗口材质'],
    ['var region = effRegions[key]', '四个区域的透明度/模糊'],
    ['var variant = effPalette ? effPalette.variant', '配色风格'],
    ["slider('logo 尺寸', effStartup.logoSize", 'logo 尺寸'],
    ["select('动画', effStartup.animation", '启动动画'],
    ["slider('整体圆角', look.radius", '整体圆角'],
    ["select('适配', effWallpaper.fit", '壁纸适配'],
    ['var axes = positionAxes(effWallpaper.position)', '壁纸位置两轴'],
    ["slider('模糊', effWallpaper.blur", '壁纸模糊'],
    ["slider('压暗', effWallpaper.dim", '壁纸压暗'],
    ["slider('缩放', effWallpaper.scale", '壁纸缩放'],
    ["slider('饱和度', effWallpaper.saturate", '壁纸饱和度'],
    ["slider('亮度', effWallpaper.brightness", '壁纸亮度'],
    ["slider('对比度', effWallpaper.contrast", '壁纸对比度'],
    ["slider('灰度', effWallpaper.grayscale", '壁纸灰度'],
  ];
  for (const [snippet, name] of pins) ok(`${name} 读生效值`, source.includes(snippet), snippet);

  ok('文本框仍只显示覆盖值（主题的值进 placeholder）',
    source.includes('seedInput.value = seed;')
    && source.includes('seedInput.placeholder = effPalette ?')
    && source.includes("accent.value = cfg.accent || ''")
    && source.includes('accent.placeholder = effAccent ?')
    && source.includes('stBg.value = startup.background || \'\''));

  ok('滑块值不再直接读覆盖层（cfg / glass / startup / wp 都不许）',
    !/slider\('[^']*',\s*(cfg|glass|startup|wp)\./.test(source));

  // 壁纸参数按模式各有一套：显示的是"当前模式"那套，那两件事必须配套
  ok('深浅两套不一致时，说明数字代表哪一套', source.includes('深浅两套的壁纸参数不一样'));
  ok('切换深浅模式会强制重渲染（否则滑块停在上一个模式的值上）',
    /if \(next === lastMode\) return;\s*\n\s*lastMode = next;\s*\n\s*refresh\(true\);/.test(source));
}

console.log('── 空转的 ↺ 置灰、落不了地的控件藏起来');
{
  // 参考实现的两个挂点接上了：overrides → ↺ 置灰；platform → 非 win32 藏「窗口材质」。
  // 我们没用它的 overrides —— 那把 accent/radius/palette/glass 混成"theme"一个布尔，
  // 撑不起逐节的 ↺。改用主进程跑一遍 unsetControls 比对得出的 resettable（逐节、且不会漂移）。
  ok('↺ 查 resettable 决定能不能点', source.includes('data.resettable[groupName] !== false'));
  ok('不可重置时置灰并写明原因',
    source.includes("'rs' + (canReset ? '' : ' off')") && source.includes('这一节还没有个人覆盖'));
  ok('置灰时干脆不挂 click（免得空转写盘、白重算）', /if \(canReset\) rs\.addEventListener/.test(source));
  ok('置灰样式存在且悬停不亮',
    source.includes('.sec>h4 .rs.off{opacity:.2;cursor:default}')
    && source.includes('.sec>h4 .rs.off:hover{opacity:.2}'));

  // 窗口材质只在能真正落地的平台出现。判断由主进程给（materialApplies），
  // 面板不许自己认平台名——那样又变成两个来源。
  ok('窗口材质按 materialApplies 显隐', source.includes('if (data.materialApplies) {'));
  const code = stripComments(source);
  ok('面板里没有任何平台名硬编码', !/['"](win32|darwin|linux)['"]/.test(code) && !/process\.platform/.test(code));
}

console.log('── 面板有「桌宠」一节');
{
  // 2026-10-14：用户把角色图放对了却看不到桌宠——「素材在不在」和「开不开」是两件事，
  // 而那个开关当时在界面上**根本不存在**。这一节补上了：开关 + 大小/音效/音量/说话/桌面模式 + 提示。
  ok('有独立的桌宠一节，且带整节重置', source.includes("section('桌宠', 'pet')"));
  ok('开关写进 config.pet.enabled', source.includes('apply({ pet: { enabled: on } }'));
  ok('五项控件齐全', ['大小', '音效', '音量', '说话', '桌面模式'].every((label) => source.includes(`('${label}',`)));
  ok('关着时不铺开一堆没用的控件', /if \(petOn\) \{[\s\S]{0,1200}?桌面模式/.test(source));
  ok('提示行用的是主进程给的那句', source.includes('petStatus.hint'));
  ok('渲染层不重抄桌宠常量/平台判断',
    source.includes('data.petStatus')
    && !/PET_SCALE|PET_SOUNDS|desktopPetAvailability|process\.platform/.test(stripComments(source)));
  ok('两按钮开关的样式在位', source.includes('.sw2{display:flex') && source.includes('.sw2 .btn.on{'));
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
