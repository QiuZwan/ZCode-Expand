#!/usr/bin/env node
// 桌宠设置的归一化 + 面板那一节要的状态。**纯函数，不碰磁盘、不碰 Electron。**
//
// 为什么单独立一个文件：2026-10-14 用户把角色图放对了却看不到桌宠——因为
// 「素材在不在」（usable）和「开不开」（enabled）是两件事，而 enabled 要求**严格 true**，
// 界面上又没地方开。这条规则值得钉死。

import { petStatus, resolvePet, PET_SCALE, PET_SOUNDS } from '../src/runtime/pet/spec.mjs';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? '  —— ' + detail : ''}`); }
};

console.log('── resolvePet：enabled 必须显式 true');
{
  const on = (spec) => resolvePet(spec, true, true);
  ok('没有 spec → 关（素材在也得显式开）', on(undefined).enabled === false);
  ok('空对象 → 关', on({}).enabled === false);
  ok('enabled: false → 关', on({ enabled: false }).enabled === false);
  ok('enabled: true → 开', on({ enabled: true }).enabled === true);
  // 严格等于 true：写字符串 / 数字都不算——这是踩过的那个坑的边界
  ok('enabled: "true"（字符串）→ 仍是关', on({ enabled: 'true' }).enabled === false);
  ok('enabled: 1 → 仍是关', on({ enabled: 1 }).enabled === false);
  ok('总开关关掉时桌宠一并隐藏', resolvePet({ enabled: true }, false, true).enabled === false);

  ok('桌面模式同样要显式 true', on({ enabled: true }).desktop === false && on({ enabled: true, desktop: true }).desktop === true);
  ok('平台不支持时桌面模式被压成 false', resolvePet({ enabled: true, desktop: true }, true, false).desktop === false);

  const d = on({});
  ok('缩放默认 1.5', d.scale === PET_SCALE.fallback);
  ok('缩放夹在范围内', on({ scale: 99 }).scale === PET_SCALE.max && on({ scale: 0 }).scale === PET_SCALE.min);
  ok('音量默认 0.9、夹在 0..1', d.volume === 0.9 && on({ volume: 5 }).volume === 1 && on({ volume: -1 }).volume === 0);
  ok('音效认表里的，乱写回退 duck', on({ sound: 'fx1' }).sound === 'fx1' && on({ sound: 'nope' }).sound === 'duck');
  ok('说话默认开', d.bubble === true && on({ bubble: false }).bubble === false);
}

console.log('── petStatus：面板那一节要的事实');
{
  const base = { dir: 'C:/x/pet', platform: 'win32' };

  const noAssets = petStatus({ ...base, assetsReady: false, spec: { enabled: true } });
  ok('没素材 → 提示放图，并给出目录',
    noAssets.assetsReady === false && noAssets.hint.includes('pet.png') && noAssets.hint.includes(base.dir));
  ok('提示里说明要重启才生效', noAssets.hint.includes('重启'));

  const off = petStatus({ ...base, assetsReady: true, spec: undefined });
  ok('素材齐但没打开 → 提示怎么打开', off.hint.includes('打开后'), off.hint);

  const on = petStatus({ ...base, assetsReady: true, spec: { enabled: true } });
  ok('已经开着 → 不再唠叨（hint 为空）', on.hint === '', on.hint);

  const linux = petStatus({ ...base, platform: 'linux', assetsReady: true, spec: { enabled: true } });
  ok('平台不支持桌面模式 → 说明它只在窗口里',
    linux.desktopAvailable === false && linux.hint.includes('只在窗口里'), linux.hint);
  ok('提示优先级：没素材比没开更重要',
    petStatus({ ...base, assetsReady: false, spec: undefined }).hint.includes('pet.png'));

  const s = petStatus({ ...base, assetsReady: true, spec: {} });
  ok('把常量原样交给面板（渲染层不重抄一份）',
    s.scale.min === PET_SCALE.min && s.scale.max === PET_SCALE.max && s.scale.step === PET_SCALE.step
    && s.sounds.length === PET_SOUNDS.length && s.sounds[0] === PET_SOUNDS[0]);
  ok('defaults 是归一化过的，enabled 仍为 false',
    s.defaults.enabled === false && s.defaults.scale === PET_SCALE.fallback);
  ok('桌面模式默认关', s.defaults.desktop === false && s.desktopAvailable === true);
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
