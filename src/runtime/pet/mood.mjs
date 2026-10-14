// ZCode-Expand 桌宠 · 情绪状态机（主进程侧，纯函数）
//
// 把 ZCode 的活动折成桌宠唯一展示的情绪。两个输入来源、各自一个解析器，于是
// 「对 ZCode 内部格式的依赖」全部收在本文件里：
//
//   · ZCode 的 JSONL 事件日志（~/.zcode/cli/log/zcode-<本地日期>.jsonl），管回合与工具；
//   · ZCode 自己的 zcode:show-task-notification IPC，在提问卡 / 批准卡出现时发出。
//     ZCode 等用户的时候日志里什么都没有，所以这是唯一的「等待」信号。
//
// 会话分别跟踪、再按紧迫度合并：一个会话在等用户，不会被另一个只是在忙的会话盖住。
// 子代理用自己的 sessionId（sess_subagent_<agentId>）记日志，由父会话的 subagent.* 收尾。
//
// 字段名与真实日志核对过（ZCode 3.15.3，2026-10-14 ~/.zcode/cli/log/）：
//   turn.started / turn.completed / turn.failed     → sessionId、status（"cancelled" 不算失败）
//   model.request.started / tool.call.*             → sessionId、toolCallId、context.querySource
//   tool.permission.resolved                        → context.requestId（形如 perm_…）
//   subagent.completed                              → context.agentId；sessionId 是父会话
//
// 本文件不 import node: 也不 import electron：可在 node 下直接单测（见文件末尾的导出）。

/**
 * 桌宠的情绪。idle 发呆 / thinking 思考 / working 干活 / waiting 等用户 / done 完成 / error 失败
 * @typedef {'idle'|'thinking'|'working'|'waiting'|'done'|'error'} PetMood
 */

/** @type {readonly PetMood[]} */
export const PET_MOODS = ['idle', 'thinking', 'working', 'waiting', 'done', 'error'];

/** 越靠前越紧迫：合并多会话时取最紧迫的那个。 @type {readonly PetMood[]} */
const URGENCY = ['waiting', 'error', 'working', 'thinking', 'done', 'idle'];

/** 时间常量，集成时可整体覆盖（单测靠它把时间拨快） */
export const PET_TIMING = {
  /** "done" / "error" 保持多久后回到 idle */
  resultMs: 30_000,
  /** 回合开着但这么久没有任何事件，就当作已经结束（ZCode 中途退出、丢行） */
  staleMs: 10 * 60_000,
  /** 一张卡这么久没人理，就当作已经不在了 */
  promptStaleMs: 4 * 60 * 60_000,
  /** 相邻两个安静情绪之间至少要显示这么久，防止一秒内来回跳 */
  holdMs: 1500,
};

/**
 * 时间常量的形状（覆盖值可以是它的子集）
 * @typedef {typeof PET_TIMING} PetTiming
 */

/**
 * 归一到状态机的日志事件
 * @typedef {object} PetEvent
 * @property {string} event  ZCode 日志事件名，或 PROMPT_SHOWN
 * @property {string} sessionId
 * @property {string} [toolCallId]
 * @property {string} [status]
 * @property {string} [agentId]
 * @property {string} [querySource]
 * @property {string} [requestId]  把「显示的卡」和它的 tool.permission.resolved 配对：卡的交互 id（perm_…）
 */

/** 不是日志事件：一张提问卡 / 批准卡出现了（parsePromptNotification） */
export const PROMPT_SHOWN = 'zc-expand.prompt.shown';

/** 走 ZCode 权限流的卡，最后会有一条同 id 的 tool.permission.resolved */
const PERMISSION_PREFIX = 'perm_';
const SUBAGENT_PREFIX = 'sess_subagent_';
/** @param {string} sessionId */
const isSubagent = (sessionId) => sessionId.startsWith(SUBAGENT_PREFIX);

/** 便宜的预筛：日志里绝大多数行是模型诊断与持久化噪音，正则先挡掉再 JSON.parse */
const RELEVANT = /"event":"(?:turn\.(?:started|completed|failed)|model\.request\.started|tool\.call\.(?:started|completed|failed)|tool\.permission\.resolved|subagent\.(?:completed|failed|background\.(?:completed|stopped|failed)))"/;

/** 属于用户可见回合的 querySource；其余（起标题、做摘要之类）从不开回合 */
const TURN_SOURCES = new Set(['main_turn', 'subagent']);

const PROMPT_STATUSES = new Set(['permission_request', 'elicitation_request']);

/**
 * @param {unknown} value
 * @returns {string|undefined}
 */
const text = (value) => (typeof value === 'string' && value ? value : undefined);

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
const record = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {});

/**
 * 一行日志 → 事件；不相关或格式不对返回 null（永远不抛）
 * @param {string} line
 * @returns {PetEvent|null}
 */
export function parseLogLine(line) {
  if (!RELEVANT.test(line)) return null;
  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const entry = record(raw);
  const event = text(entry.event);
  const sessionId = text(entry.sessionId);
  if (!event || !sessionId) return null;
  const context = record(entry.context);
  return {
    event,
    sessionId,
    toolCallId: text(entry.toolCallId),
    status: text(entry.status),
    agentId: text(context.agentId),
    querySource: text(context.querySource),
    requestId: text(context.requestId),
  };
}

/**
 * ZCode 的任务通知（packages/shared validation.ts `taskNotificationPayloadSchema`）：
 * `taskId` 是会话、`requestId` 是卡的交互 id。完成通知不算「等用户」，那种情况日志里有。
 * @param {unknown} payload
 * @returns {PetEvent|null}
 */
export function parsePromptNotification(payload) {
  const notice = record(payload);
  const sessionId = text(notice.taskId);
  if (!sessionId || !PROMPT_STATUSES.has(/** @type {string} */ (notice.status))) return null;
  return { event: PROMPT_SHOWN, sessionId, requestId: text(notice.requestId) ?? sessionId };
}

/**
 * 单个会话的跟踪状态
 * @typedef {object} PetSession
 * @property {boolean} open
 * @property {Set<string>} tools  正在跑的工具调用
 * @property {'done'|'error'|null} result
 * @property {number} at  最后一次事件的时间，或到达 result 的时间
 */

/**
 * 建一个跟踪器。`ingest` 吃事件，`mood` 给出当前情绪——两者都不抛异常。
 * @param {PetTiming} [timing]
 */
export function createPetTracker(timing = PET_TIMING) {
  /** @type {Map<string, PetSession>} */
  const sessions = new Map();
  /** 已显示、还没被答复的卡，按交互 id 索引 @type {Map<string, {sessionId: string, at: number}>} */
  const prompts = new Map();

  /**
   * @param {string} id
   * @param {number} now
   * @returns {PetSession}
   */
  function opened(id, now) {
    const session = sessions.get(id) ?? { open: true, tools: new Set(), result: null, at: now };
    session.open = true;
    session.result = null;
    session.at = now;
    sessions.set(id, session);
    return session;
  }

  /**
   * @param {string} id
   * @param {'done'|'error'|null} result
   * @param {number} now
   */
  function finish(id, result, now) {
    for (const [requestId, prompt] of prompts) if (prompt.sessionId === id) prompts.delete(requestId);
    if (result) sessions.set(id, { open: false, tools: new Set(), result, at: now });
    else sessions.delete(id);
  }

  /** 回合之外的活动只在它确实属于某个回合时才作数（桌宠是在回合中途打开的） */
  const opens = (event) => sessions.get(event.sessionId)?.open === true || TURN_SOURCES.has(event.querySource ?? '');

  /**
   * @param {PetEvent} event
   * @param {number} now
   */
  function ingest(event, now) {
    if (event.event === PROMPT_SHOWN) {
      // 每个显示该卡的窗口都会报一次，第一次算数
      if (event.requestId && !prompts.has(event.requestId)) prompts.set(event.requestId, { sessionId: event.sessionId, at: now });
      return;
    }
    // 不走权限流的卡（比如 MCP server 要输入）不会记 resolved；会话继续往下走就说明它被答复了
    for (const [requestId, prompt] of prompts) {
      if (prompt.sessionId === event.sessionId && !requestId.startsWith(PERMISSION_PREFIX)) prompts.delete(requestId);
    }
    switch (event.event) {
      case 'turn.started':
        opened(event.sessionId, now).tools.clear();
        break;
      case 'model.request.started':
        if (opens(event)) opened(event.sessionId, now);
        break;
      case 'tool.call.started':
        if (opens(event)) opened(event.sessionId, now).tools.add(event.toolCallId ?? '');
        break;
      case 'tool.call.completed':
      case 'tool.call.failed': {
        const session = sessions.get(event.sessionId);
        if (!session?.open) break;
        session.tools.delete(event.toolCallId ?? '');
        session.at = now;
        break;
      }
      // 批准、拒绝、改参数都算「答复完了」
      case 'tool.permission.resolved':
        if (event.requestId) prompts.delete(event.requestId);
        break;
      // 子代理自己的回合结束跟用户无关，结果由父会话的回合报
      case 'turn.completed':
        finish(event.sessionId, isSubagent(event.sessionId) ? null : 'done', now);
        break;
      case 'turn.failed':
        // 手动停止会记成 status "cancelled" 的失败：不算错误
        finish(event.sessionId, isSubagent(event.sessionId) || event.status === 'cancelled' ? null : 'error', now);
        break;
      default:
        // subagent.completed / subagent.background.*：由父会话记录，里面点名子代理
        if (event.event.startsWith('subagent.') && event.agentId) sessions.delete(`${SUBAGENT_PREFIX}${event.agentId}`);
    }
  }

  /**
   * @param {PetSession} session
   * @param {number} now
   * @returns {PetMood|null}  null 表示这个会话该被丢掉
   */
  function sessionMood(session, now) {
    const age = now - session.at;
    if (!session.open) return session.result && age < timing.resultMs ? session.result : null;
    if (age > timing.staleMs) return null;
    return session.tools.size ? 'working' : 'thinking';
  }

  /**
   * 当前情绪（多会话取最紧迫的）
   * @param {number} now
   * @returns {PetMood}
   */
  function mood(now) {
    for (const [requestId, prompt] of prompts) if (now - prompt.at > timing.promptStaleMs) prompts.delete(requestId);
    // 有卡在等用户 → 直接从最紧迫开始比
    let best = prompts.size ? 0 : URGENCY.length - 1;
    for (const [id, session] of sessions) {
      const own = sessionMood(session, now);
      if (own === null) sessions.delete(id);
      else best = Math.min(best, URGENCY.indexOf(own));
    }
    return URGENCY[best];
  }

  return { ingest, mood };
}

/**
 * 安静情绪（idle / thinking / working）在 agent 干活时一秒内会来回跳好几次，
 * 每个都要先显示 holdMs 才允许被另一个安静情绪顶掉；要人注意的情绪立刻显示。
 * @param {number} holdMs
 * @returns {(next: PetMood, now: number) => PetMood}
 */
export function createMoodStabilizer(holdMs) {
  /** @type {PetMood} */
  let shown = 'idle';
  let since = -Infinity;
  /** @param {PetMood} mood */
  const calm = (mood) => mood === 'idle' || mood === 'thinking' || mood === 'working';
  return (next, now) => {
    if (next !== shown && (!calm(next) || now - since >= holdMs)) {
      shown = next;
      since = now;
    }
    return shown;
  };
}
