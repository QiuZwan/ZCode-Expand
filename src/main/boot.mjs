// ZCode-Expand 引导脚本（打进 app.asar 的 out/zcode-expand/boot.mjs）
//
// 由补丁把 package.json 的 "main" 从 "out/main/index.js" 改指向本文件。
// 职责只有两件，且必须永远保持这么简单——**它是整条链的单点故障**：
//   1. 从用户目录加载 runtime（不存在就跳过）
//   2. import 原始主进程入口
//
// 硬要求（2026-10-14 修）：**除了最后那行 import 原始入口，本文件顶层不得有任何可能抛错的语句。**
// 首版把 `const HOME = ...join(homedir(), ...)` 写在模块顶层、所有 try/catch 之外——
// 只要 homedir() 或 process.env 出岔子，boot.mjs 直接抛，而它是 main，ZCode 就起不来。
// 现在所有取值与判断都收进 loadRuntime() 的 try/catch，顶层只剩一行 await import。
//
// 环境变量：
//   ZCODE_EXPAND_DISABLE=1   临时停用 runtime（ZCode 照常启动）
//   ZCODE_EXPAND_HOME=<目录> 覆盖用户目录（默认 ~/.zcode-expand）

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

async function loadRuntime() {
  try {
    if (process.env.ZCODE_EXPAND_DISABLE === "1") return;
    const base =
      process.env.ZCODE_EXPAND_HOME ||
      (typeof homedir === "function" ? join(homedir(), ".zcode-expand") : "");
    if (!base) return;
    const entry = join(base, "runtime", "main.mjs");
    if (!existsSync(entry)) return;
    // 用 file:// URL 加载，避免 Windows 路径被当包名解析
    await import(pathToFileURL(entry).href);
  } catch (error) {
    console.error("[zcode-expand] runtime 加载失败（已忽略，ZCode 继续启动）：", error);
  }
}

await loadRuntime();

// 原始入口：out/zcode-expand/boot.mjs → out/main/index.js
// 这一行刻意留在 try/catch 之外：它是 ZCode 自己的入口，它失败就该失败，不该被我们吞掉。
await import("../main/index.js");
