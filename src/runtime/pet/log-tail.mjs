// ZCode-Expand 桌宠 · 跟随 ZCode 的 JSONL 事件日志（主进程侧，只读）
//
// 只读：不写、不锁、不轮转 ZCode 的文件。不 import electron，可在 node 下直接跑。
//
// 行为（与参考实现 pet-log.ts 一致）：
//   · 从「今天」那个文件的**末尾**开始——桌宠反映的是从现在起发生的事，不是回放一整天；
//   · 跨零点的长回合：先把昨天那个文件读完，再切到今天这个；
//   · 单次最多读 1MB，更大的积压直接跳过（它描述的是过去，跳过时丢弃半行）；
//   · 文件变小 == 被换过，从头重读。

import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** ZCode 写日志的地方（adapters/src/logging）：ZCODE_LOG_DIR，否则 ~/.zcode/cli/log */
export function zcodeLogDir(env = process.env) {
  return env.ZCODE_LOG_DIR || join(homedir(), '.zcode', 'cli', 'log');
}

/**
 * ZCode 的命名：一天一个文件，文件名用**本地**日期
 * @param {string} dir
 * @param {Date} date
 * @returns {string}
 */
export function zcodeLogFile(dir, date) {
  const day = [
    date.getFullYear().toString().padStart(4, '0'),
    (date.getMonth() + 1).toString().padStart(2, '0'),
    date.getDate().toString().padStart(2, '0'),
  ].join('-');
  return join(dir, `zcode-${day}.jsonl`);
}

/** 每次轮询最多读这么多字节；更大的积压直接跳过，它描述的是过去 */
const MAX_READ = 1024 * 1024;
const NEWLINE = 0x0a;

/**
 * @typedef {object} LogTail
 * @property {(now?: Date) => void} poll  读出上次之后新增的内容，按整行回调
 */

/**
 * @param {string} dir  日志目录
 * @param {(line: string) => void} onLine  每读到一个完整行回调一次（空行不回调）
 * @returns {LogTail}
 */
export function createLogTail(dir, onLine) {
  /** 当前跟随的文件，null = 还没初始化 */
  let file = null;
  /** 已读到的字节偏移 */
  let offset = 0;
  /** 最后一个换行之后的字节：ZCode 正在写、还没写完的那一行 */
  let rest = Buffer.alloc(0);
  /** 跳过一大段之后，读到的第一行是个半截行，要丢掉 */
  let skipFirst = false;

  /** 文件大小；不存在返回 null */
  const size = (path) => statSync(path, { throwIfNoEntry: false })?.size ?? null;

  /**
   * @param {number} at
   * @param {boolean} fragment  从 at 开始读到的第一行是否是半截行
   */
  function restart(at, fragment) {
    offset = at;
    rest = Buffer.alloc(0);
    skipFirst = fragment;
  }

  /**
   * @param {Buffer} bytes
   */
  function emit(bytes) {
    const data = rest.length ? Buffer.concat([rest, bytes]) : bytes;
    let start = 0;
    for (let index = data.indexOf(NEWLINE); index !== -1; index = data.indexOf(NEWLINE, start)) {
      const text = data.subarray(start, index).toString('utf8');
      start = index + 1;
      if (skipFirst) skipFirst = false;
      else if (text) onLine(text);
    }
    rest = Buffer.from(data.subarray(start));
  }

  /**
   * 把 path 里尚未读过的字节读出来
   * @param {string} path
   */
  function drain(path) {
    const end = size(path);
    if (end === null) return;
    if (end < offset) restart(0, false);
    if (end - offset > MAX_READ) restart(end - MAX_READ, true);
    if (end === offset) return;
    const chunk = Buffer.alloc(end - offset);
    const fd = openSync(path, 'r');
    try {
      const read = readSync(fd, chunk, 0, chunk.length, offset);
      offset += read;
      emit(chunk.subarray(0, read));
    } finally {
      closeSync(fd);
    }
  }

  return {
    poll(now = new Date()) {
      const today = zcodeLogFile(dir, now);
      if (file === null) {
        // 首次：定位到今天这个文件的末尾，不回放
        file = today;
        restart(size(today) ?? 0, false);
        return;
      }
      if (file !== today) {
        // 跨零点：先把昨天那个文件收尾，再切到今天从头读
        drain(file);
        file = today;
        restart(0, false);
      }
      drain(file);
    },
  };
}
