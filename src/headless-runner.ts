/**
 * Headless 运行器
 *
 * 处理 --run 模式的单轮对话
 * 从 cli.ts 中提取，解决 #16 issue
 */

import type {
  EventStream,
  Message,
  RunEvent,
  RunnableAgent,
  SessionBackend,
  Unsubscribe,
} from '../packages/core/src/index';
import { asTuiEvent } from '../packages/tui/src/types/events.js';
import { getCurrentGitBranch } from '../packages/tui/src/utils/git.js';
import { askRequestFromEvent, persistAskRequest } from './ask-channel';
import { t } from './i18n';

/** headless 下 ask 的人类通道（0.33 A）。 */
export interface HeadlessAskChannel {
  /** interactions 文件目录（与 attention 离线模式同源） */
  dir: string;
  tenantId: string;
  /** false 时不中断（显式诊断用）；headless 默认 true */
  suspend?: boolean;
  /** false 时由同进程 gateway registry 落盘（`--serve --run`），避免双写同一文件 */
  persist?: boolean;
}

export interface HeadlessOptions {
  /** 运行参数 */
  runArg: string | null;
  /** 是否为 pipe 模式 */
  pipeMode: boolean;
  /** 当前会话 ID */
  sessionId: string;
  /** Provider 信息 */
  provider: { name: string; model: string };
  /** 0.33 A：ask 落盘 + 挂起；缺省 = 不启用（embedded 调用方保持旧行为） */
  askChannel?: HeadlessAskChannel;
}

/** ask 挂起时的退出码：请求已持久化，run 可 resume。 */
export const HEADLESS_ASK_SUSPENDED_EXIT_CODE = 3;

export interface SuspendedAsk {
  requestId: string;
  runId: string;
  sessionId?: string;
}

/**
 * headless 的 ask 收口：请求落盘 → `ask.user.timeout` → 中断 run。
 *
 * 不等待人类（headless 没有进程内应答者）；`timeout` 是 core 的
 * `RunInterruptReason`，checkpoint 落 `interrupted`，`--resume-run` 可恢复。
 * 返回 `flush()`，调用方在 run 收口后 await，确保退出前文件已落盘。
 */
export function installHeadlessAskSuspend(
  events: EventStream,
  channel: HeadlessAskChannel,
  controller: AbortController,
): {
  unsubscribe: Unsubscribe;
  flush: () => Promise<void>;
  last: () => SuspendedAsk | undefined;
  suspended: () => boolean;
  /** 所有已收到的 ask 是否都成功落盘（persist:false 视为成功）。 */
  persisted: () => boolean;
} {
  const tasks: Promise<void>[] = [];
  let lastAsk: SuspendedAsk | undefined;
  let suspended = false;
  let persistFailed = false;

  const unsubscribe = events.subscribe((rawEvent: RunEvent) => {
    const request = askRequestFromEvent(rawEvent);
    if (request === undefined) return;
    lastAsk = request;
    const task = (async (): Promise<void> => {
      if (channel.persist !== false) {
        try {
          await persistAskRequest({
            dir: channel.dir,
            tenantId: channel.tenantId,
            requestId: request.requestId,
            runId: request.runId,
            ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
            ...(request.questions !== undefined ? { questions: request.questions } : {}),
            suspended: channel.suspend !== false,
          });
        } catch (error) {
          persistFailed = true;
          console.error(
            `[vessel] failed to persist ask request ${request.requestId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      // 明确的事件（不静默）：网关/观测可区分“等不到人类”与普通失败。
      events.publish({
        type: 'ask.user.timeout',
        run_id: request.runId,
        data: {
          requestId: request.requestId,
          ...(request.sessionId !== undefined ? { session_id: request.sessionId } : {}),
          reason: 'no_human',
        },
        ts: Date.now(),
      });
      if (channel.suspend !== false && !controller.signal.aborted) {
        suspended = true;
        controller.abort('timeout');
      }
    })();
    tasks.push(task);
  });

  return {
    unsubscribe,
    flush: async () => {
      await Promise.allSettled(tasks);
    },
    last: () => lastAsk,
    suspended: () => suspended,
    persisted: () => !persistFailed,
  };
}

/** ask 挂起后的 stderr 指引（stdout 留结果）。 */
export function printSuspendedAsk(ask: SuspendedAsk, dir: string, tenantId?: string): void {
  const tenantFlag =
    tenantId !== undefined && tenantId !== '' && tenantId !== 'default'
      ? ` --tenant ${tenantId}`
      : '';
  console.error(`[vessel] ask_user request ${ask.requestId} is waiting for a human.`);
  console.error(`[vessel] run ${ask.runId} is suspended (checkpoint: interrupted).`);
  console.error(
    `[vessel] answer: vessel attention${tenantFlag} respond ${ask.requestId} ` +
      `--answers '[{"header":"...","question":"...","answer":"..."}]'`,
  );
  console.error(`[vessel] resume: vessel --resume-run ${ask.runId}${tenantFlag}`);
  console.error(`[vessel] interaction records: ${dir}`);
}

/** 输入校验/读取错误--runHeadless 顶层捕获后以 exit 1 退出 */
class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

/**
 * headless 应答策略（ADR-029）：无 TUI 订阅者时，权限请求自动允许，
 * 避免 permission policy 无限等待。返回退订函数（runHeadless 进程内可忽略，
 * `--resume-run` 等需要显式收口订阅的入口必须调用）。
 */
export function installHeadlessPermissionAutoAllow(events: EventStream): Unsubscribe {
  return events.subscribe((rawEvent) => {
    const event = asTuiEvent(rawEvent);
    if (event.type === 'tool.permission.request') {
      events.publish({
        type: 'tool.permission.response',
        run_id: event.run_id,
        data: {
          requestId: event.data.requestId,
          decision: 'allow',
          answered_by: 'policy',
          answered_via: 'policy',
          policy: 'auto_allow',
        },
        ts: Date.now(),
      });
    }
  });
}

/**
 * 运行 headless 模式。
 * @returns 退出码（0 成功 / 1 失败）；清理与 process.exit 由 cli 统一处理。
 */
export async function runHeadless(
  runtime: RunnableAgent,
  session: SessionBackend,
  options: HeadlessOptions,
): Promise<number> {
  const { sessionId, provider } = options;

  // headless 无 TUI 订阅者：权限请求自动允许。
  installHeadlessPermissionAutoAllow(runtime.events);

  // 0.33 A：ask 不再无限等待——落盘后中断当前 run（interrupted，可 resume）。
  const controller = new AbortController();
  const askControl =
    options.askChannel !== undefined
      ? installHeadlessAskSuspend(runtime.events, options.askChannel, controller)
      : undefined;

  try {
    const input = (await readInput(options, session)).trim();
    if (!input) {
      throw new CliError(t('common.noInput'));
    }

    console.error(`[vessel] ${provider.name} | ${provider.model} | session ${sessionId}`);

    const branch = await getCurrentGitBranch();
    const resp = await runtime.run(input, sessionId, { branch, signal: controller.signal });
    console.log(resp);
    return 0;
  } catch (e) {
    if (askControl !== undefined) {
      await askControl.flush();
      const suspendedAsk = askControl.suspended() ? askControl.last() : undefined;
      if (suspendedAsk !== undefined && options.askChannel !== undefined) {
        if (!askControl.persisted()) {
          console.error(
            `[vessel] ask_user request ${suspendedAsk.requestId} could not be persisted; ` +
              'the run is interrupted but there is no answerable record.',
          );
          return 1;
        }
        printSuspendedAsk(suspendedAsk, options.askChannel.dir, options.askChannel.tenantId);
        return HEADLESS_ASK_SUSPENDED_EXIT_CODE;
      }
    }
    const msg = e instanceof CliError ? e.message : `Error: ${e instanceof Error ? e.message : e}`;
    console.error(msg);
    return 1;
  } finally {
    askControl?.unsubscribe();
    await askControl?.flush();
  }
}

/**
 * 读取 headless 输入：无参=stdin，@file=文件内容（.json=多轮 seeding），其余=文本 prompt
 */
async function readInput(options: HeadlessOptions, session: SessionBackend): Promise<string> {
  const { runArg, pipeMode, sessionId } = options;
  const readStdin = runArg === '' || (runArg === null && pipeMode);

  if (readStdin) {
    return Bun.stdin.text();
  }
  if (runArg?.startsWith('@')) {
    const filePath = runArg.slice(1);
    if (filePath.endsWith('.json')) {
      return seedFromMessagesFile(filePath, sessionId, session);
    }
    try {
      return await Bun.file(filePath).text();
    } catch {
      throw new CliError(`Error: cannot read file "${filePath}".`);
    }
  }
  return runArg ?? '';
}

/**
 * 从 JSON 文件加载历史消息，返回末条 user 消息作为本次输入
 */
async function seedFromMessagesFile(
  filePath: string,
  sessionId: string,
  session: SessionBackend,
): Promise<string> {
  let raw: string;
  try {
    raw = await Bun.file(filePath).text();
  } catch {
    throw new CliError(`Error: cannot read file "${filePath}".`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(`Error: "${filePath}" is not valid JSON.`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new CliError(`Error: "${filePath}" must contain a non-empty JSON array of messages.`);
  }

  const msgs = parsed as Message[];
  for (const m of msgs) {
    if (!m || typeof m.role !== 'string' || typeof m.content !== 'string') {
      throw new CliError(
        `Error: each message in "${filePath}" needs {role, content} (both strings).`,
      );
    }
  }

  const last = msgs[msgs.length - 1];
  if (!last) {
    throw new CliError(`Error: "${filePath}" contains no messages.`);
  }

  if (last.role !== 'user') {
    throw new CliError(
      `Error: last message in "${filePath}" must be role "user" (got "${last.role}").`,
    );
  }

  const history = msgs.slice(0, -1);
  if (history.length > 0) {
    await session.save({
      run_id: crypto.randomUUID(),
      session_id: sessionId,
      messages: history,
      started_at: Date.now(),
      status: 'completed',
    });
  }

  return last.content;
}
