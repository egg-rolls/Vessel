/**
 * Headless 运行器
 *
 * 处理 --run 模式的单轮对话
 * 从 cli.ts 中提取，解决 #16 issue
 */

import type { AgentRuntime, Message, SessionBackend } from '../packages/core/src/index';
import { asTuiEvent } from '../packages/tui/src/types/events.js';
import { getCurrentGitBranch } from '../packages/tui/src/utils/git.js';

export interface HeadlessOptions {
  /** 运行参数 */
  runArg: string | null;
  /** 是否为 pipe 模式 */
  pipeMode: boolean;
  /** 当前会话 ID */
  sessionId: string;
  /** Provider 信息 */
  provider: { name: string; model: string };
}

/** 输入校验/读取错误--runHeadless 顶层捕获后以 exit 1 退出 */
class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

/**
 * 运行 headless 模式
 */
export async function runHeadless(
  runtime: AgentRuntime,
  session: SessionBackend,
  options: HeadlessOptions,
): Promise<void> {
  const { sessionId, provider } = options;

  // headless 应答策略（ADR-029）：无 TUI 订阅者时，权限请求自动允许，
  // 避免 waitFor 超时挂起；ask_user 仅交互模式注册（见 bootstrap），靠超时返回错误兜底。
  runtime.events.subscribe((rawEvent) => {
    const event = asTuiEvent(rawEvent);
    if (event.type === 'tool.permission.request') {
      runtime.events.publish({
        type: 'tool.permission.response',
        run_id: event.run_id,
        data: { requestId: event.data.requestId, decision: 'allow' },
        ts: Date.now(),
      });
    }
  });

  try {
    const input = (await readInput(options, session)).trim();
    if (!input) {
      throw new CliError('No input.');
    }

    console.error(`[vessel] ${provider.name} | ${provider.model} | session ${sessionId}`);

    const branch = await getCurrentGitBranch();
    const resp = await runtime.run(input, sessionId, { branch });
    console.log(resp);
    runtime.dispose?.();
    process.exit(0);
  } catch (e) {
    const msg = e instanceof CliError ? e.message : `Error: ${e instanceof Error ? e.message : e}`;
    console.error(msg);
    runtime.dispose?.();
    process.exit(1);
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
    return Bun.file(filePath).text();
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
