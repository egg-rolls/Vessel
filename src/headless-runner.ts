/**
 * Headless 运行器
 *
 * 处理 --run 模式的单轮对话
 * 从 cli.ts 中提取，解决 #16 issue
 */

import type { AgentRuntime, Message, SessionBackend } from '../packages/core/src/index';
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

/**
 * 运行 headless 模式
 */
export async function runHeadless(
  runtime: AgentRuntime,
  session: SessionBackend,
  options: HeadlessOptions,
): Promise<void> {
  const { runArg, pipeMode, sessionId, provider } = options;

  const readStdin = runArg === '' || (runArg === null && pipeMode);
  let input: string;

  if (readStdin) {
    input = await Bun.stdin.text();
  } else if (runArg?.startsWith('@')) {
    const filePath = runArg.slice(1);
    if (filePath.endsWith('.json')) {
      input = await seedFromMessagesFile(filePath, sessionId, session);
    } else {
      input = await Bun.file(filePath).text();
    }
  } else {
    input = runArg ?? '';
  }

  input = input.trim();
  if (!input) {
    console.error('No input.');
    process.exit(1);
  }

  console.error(`[vessel] ${provider.name} | ${provider.model} | session ${sessionId}`);

  try {
    const branch = await getCurrentGitBranch();
    const resp = await runtime.run(input, sessionId, { branch });
    console.log(resp);
    runtime.dispose?.();
    process.exit(0);
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : e}`);
    runtime.dispose?.();
    process.exit(1);
  }
}

/**
 * 从 JSON 文件加载历史消息
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
    console.error(`Error: cannot read file "${filePath}".`);
    process.exit(1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(`Error: "${filePath}" is not valid JSON.`);
    process.exit(1);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    console.error(`Error: "${filePath}" must contain a non-empty JSON array of messages.`);
    process.exit(1);
  }

  const msgs = parsed as Message[];
  for (const m of msgs) {
    if (!m || typeof m.role !== 'string' || typeof m.content !== 'string') {
      console.error(`Error: each message in "${filePath}" needs {role, content} (both strings).`);
      process.exit(1);
    }
  }

  const last = msgs[msgs.length - 1];
  if (!last) {
    console.error(`Error: "${filePath}" contains no messages.`);
    process.exit(1);
  }

  if (last.role !== 'user') {
    console.error(`Error: last message in "${filePath}" must be role "user" (got "${last.role}").`);
    process.exit(1);
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
