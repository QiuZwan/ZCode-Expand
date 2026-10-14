#!/usr/bin/env node
// 只部署运行时到用户目录，不碰 app.asar、不检查 ZCode 进程。
//
// 为什么单独做一个：运行时（~/.zcode-expand/runtime/）是**启动时读一次**的普通文件，
// 改它既不需要重打包也不需要退出 ZCode——主进程那份重启 ZCode 生效，
// 渲染层那几份在窗口加载时生效。而 apply 为了安全总是先查进程锁，
// 于是"只想改一行功能代码"也被要求关掉整个 ZCode。这个脚本就是为那条路径准备的。
//
// 用法：
//   node scripts/deploy-runtime.mjs            # 部署 src/runtime + src/renderer
//   node scripts/deploy-runtime.mjs --check    # 只报差异，不写

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { parseArgs, REPO_ROOT } from './lib/env.mjs';

const step = (m) => console.log(`\n== ${m}`);
const info = (m) => console.log(`   ${m}`);

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** 递归比对源目录与目标目录，返回有差异/缺失的文件（相对路径） */
function diffDir(srcDir, destDir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const src = join(srcDir, entry.name);
    const dest = join(destDir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!existsSync(dest)) out.push(`${rel}/（整个目录缺失）`);
      else out.push(...diffDir(src, dest, rel));
      continue;
    }
    if (!existsSync(dest)) { out.push(`${rel}（缺失）`); continue; }
    if (statSync(dest).isFile() && sha(src) !== sha(dest)) out.push(`${rel}（内容不同）`);
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const checkOnly = !!args.check;
  const home = process.env.ZCODE_EXPAND_HOME || join(homedir(), '.zcode-expand');
  const runtimeDest = join(home, 'runtime');
  const rendererDest = join(runtimeDest, 'renderer');

  step('环境');
  info(`用户目录：${home}`);
  info(`模式：${checkOnly ? '只检查（不写盘）' : '部署'}`);

  step('差异');
  const diffs = [
    ...diffDir(join(REPO_ROOT, 'src', 'runtime'), runtimeDest),
    ...diffDir(join(REPO_ROOT, 'src', 'renderer'), rendererDest),
  ];
  if (!diffs.length) {
    console.log('\n没有差异，用户目录已是最新。');
    return;
  }
  for (const d of diffs.slice(0, 40)) info(d);
  if (diffs.length > 40) info(`… 另有 ${diffs.length - 40} 处`);

  if (checkOnly) {
    console.log(`\n共 ${diffs.length} 处差异（--check 未写盘）。`);
    return;
  }

  step('部署');
  mkdirSync(runtimeDest, { recursive: true });
  cpSync(join(REPO_ROOT, 'src', 'runtime'), runtimeDest, { recursive: true, force: true });
  info(`src/runtime → ${runtimeDest}`);
  if (existsSync(join(REPO_ROOT, 'src', 'renderer'))) {
    mkdirSync(rendererDest, { recursive: true });
    cpSync(join(REPO_ROOT, 'src', 'renderer'), rendererDest, { recursive: true, force: true });
    info(`src/renderer → ${rendererDest}`);
  }
  console.log('\n完成。主进程那份（main.mjs）要重启 ZCode 生效；渲染层那几份在窗口加载时生效。');
}

main().catch((err) => {
  console.error(`\n失败：${err.message}`);
  process.exitCode = 1;
});
