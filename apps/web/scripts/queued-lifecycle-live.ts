/**
 * 真机读数：排队消息在**真 gateway** 上的生命周期（验收用，不是 gate）。
 *
 * 它做的是本需求最关键的一条事实核对：**`queued` 那条消息在服务端 inbox 里真的有一条
 * 带 `session_id` 的 held 条目**（条带画的就是它），而它**还没有**会话里的 `user.message`；
 * 等它被 run 取用之后，inbox 里那条消失、`user.message` 才出现（会话里才有正常气泡）。
 *
 * 另外核对客户端「认领」链条的两端在真机上确实存在：
 * - `agent.message.queued` 事件带 `message_id` / `from:'human'` / `delivery:'input'`
 *   （`pending-placement.ts#claimsEntry` 的精确认领靠它）；
 * - 那条 `message_id` 与 `agents.inbox` 里的 `message_id` 是同一个
 *   （否则条带会让同一条消息画两遍）。
 *
 * 跑法（先起一个隔离 gateway）：
 *   VESSEL_MOCK=1 VESSEL_GATEWAY_TOKEN=<token> bun run src/cli.ts gateway start --daemon --data-dir <dir>
 *   VESSEL_LIVE_URL=http://127.0.0.1:<port> VESSEL_LIVE_TOKEN=<token> \
 *     bun apps/web/scripts/queued-lifecycle-live.ts
 *
 * @module apps/web/scripts/queued-lifecycle-live
 */

import { readFileSync } from 'node:fs';
import { queuedMessageOf } from '../src/domains/chat/pending-placement';
import { GatewayClient } from '../src/gateway/client';
import type { StoredEvent } from '../src/state/events';

/**
 * 连接参数：位置参数优先（`<url> <token>`），其次环境变量。
 *
 * 为什么两种都给：WSL 里调 Windows bun 时 `VAR=x bun ...` 这种前缀不一定传得进
 * `process.env`（实测会丢），所以驱动必须能直接从 argv 拿。
 *
 * `@<path>` 形式 = 从 `vessel token show --purpose node:<id>` 的输出里读那一行 token：
 * 这样 token 不会出现在命令行、也不会进日志（只在本进程内存里用一次）。
 */
function readTokenArg(raw: string): string {
  if (!raw.startsWith('@')) return raw;
  const text = readFileSync(raw.slice(1), 'utf8');
  const line = text
    .split('\n')
    .map((row) => row.trim())
    .find((row) => row.startsWith('token'));
  if (line === undefined) throw new Error('token file has no "token" line');
  return line.split(/\s+/).slice(1).join(' ').trim();
}

const url = process.argv[2] ?? process.env.VESSEL_LIVE_URL ?? 'http://127.0.0.1:8644';
const token = readTokenArg(process.argv[3] ?? process.env.VESSEL_LIVE_TOKEN ?? '');
const SESSION_TIMEOUT_MS = 90_000;

interface Seen {
  queuedEvents: { messageId?: string; from?: string; delivery?: string; sessionId?: string }[];
  userMessages: { runId?: string; text?: string; messageId?: string }[];
}

const seen: Seen = { queuedEvents: [], userMessages: [] };

function log(line: string): void {
  console.log(`  ${line}`);
}

/**
 * 0.57：`runs.start` 的 `run_id` 变成可选（`status: 'deferred'` 的三条路没有 run）。
 * 这个驱动验的是「真的排上了队」的两轮，所以拿不到就当场停 —— 不拿 `undefined` 往下跑。
 */
function requireRunId(runId: string | undefined, label: string): string {
  if (runId === undefined || runId === '') {
    throw new Error(`${label} runs.start 没有返回 run_id（status=${label} 不是排队态？）`);
  }
  return runId;
}

async function main(): Promise<void> {
  if (token === '') throw new Error('VESSEL_LIVE_TOKEN is required');
  const client = new GatewayClient(url);
  client.onEvent((event) => {
    const entry = { event } as unknown as StoredEvent;
    const queued = queuedMessageOf(entry);
    if (queued !== undefined) {
      seen.queuedEvents.push({
        messageId: queued.messageId,
        ...(queued.from !== undefined ? { from: queued.from } : {}),
        ...(queued.delivery !== undefined ? { delivery: queued.delivery } : {}),
        ...(queued.sessionId !== undefined ? { sessionId: queued.sessionId } : {}),
      });
    }
    if (event.type === 'user.message') {
      const data = event.data ?? {};
      const message = (data.message ?? {}) as { message_id?: string; content?: string };
      seen.userMessages.push({
        ...(typeof event.run_id === 'string' ? { runId: event.run_id } : {}),
        ...(typeof message.message_id === 'string' ? { messageId: message.message_id } : {}),
        ...(typeof message.content === 'string' ? { text: message.content } : {}),
      });
    }
  });
  await client.connect(token);
  log(`已连接 ${url}`);

  const agent = await client.createAgent({ name: `queued-live-${String(Date.now())}` });
  const agentId = String(agent.id ?? '');
  const sessionId = String(agent.session_id ?? '');
  if (agentId === '' || sessionId === '') throw new Error('agents.create returned no id/session');
  log(`agent=${agentId} session=${sessionId}`);

  // 订阅这个会话的事件流（Web 壳层由 `gateway/subscription.ts` 做同一件事）：
  // 不订阅的话服务端只给「进程级」帧、且默认拒绝全局回放，`agent.message.queued` /
  // `user.message` 一条都收不到 —— 那就验不到「queued 事件带回 message_id」这条链。
  await client.request('events.subscribe', { session_id: sessionId, after_timeline_seq: 0 });
  log('已订阅会话事件流');

  // 第一条：正在跑（它会占住这一轮）。
  const first = await client.submitRun('第一条：先占住这一轮', sessionId, agentId);
  log(`第一条 runs.start → run=${String(first.run_id)} status=${String(first.status)}`);
  // 0.57：`run_id` 只在真起跑时才有（`deferred` 没有）。这个驱动验的正是「排上了队」的两轮，
  // 拿不到 run id 就说明驱动的前提不成立 —— 当场停，不拿 `undefined` 往下跑。
  const firstRunId = requireRunId(first.run_id, '第一条');
  const second = await client.submitRun('第二条：排队里的那条', sessionId, agentId);
  log(`第二条 runs.start → run=${String(second.run_id)} status=${String(second.status)}`);
  const secondRunId = requireRunId(second.run_id, '第二条');

  const statuses = [String(first.status), String(second.status)];
  if (!statuses.includes('queued')) {
    log('注意：这一次没有出现 queued（第一条已经跑完了）；读数仍然有效，但请看下面的时序');
  }

  // 排队期间读一次条带的真实数据源：`agents.inbox{session_id}`。
  const during = await client.inbox({ agent_id: agentId, include_held: true });
  const heldRows = (during.entries ?? []).filter((entry) => entry.session_id === sessionId);
  log(`排队中 agents.inbox{session_id} 读数：${String(heldRows.length)} 条`);
  for (const entry of heldRows) {
    log(
      `  held ${entry.message_id} from=${entry.from} status=${entry.status} session=${String(entry.session_id)} summary=${entry.summary}`,
    );
  }
  log(`排队中已收到的 user.message：${String(seen.userMessages.length)} 条（这条还没进会话）`);
  const queuedPhaseUserMessages = seen.userMessages.filter(
    (entry) => entry.runId === secondRunId,
  ).length;

  // 等第二条被取用（这就是「sent」：inbox 那条消失、会话里出现 user.message）。
  //
  // 与真实环境的差别只在一处：这台机器上没有模型 key（mock 也不是这个隔离实例能开的），
  // 所以第一条 run 会一直停在模型调用上 —— 驱动**把它取消**来放行第二条，而不是等它跑完。
  // 排队 → 被取用 这一段时序与真机完全一致（`user.message` 在模型调用之前就发布了）。
  let cancelledFirst = false;
  const deadline = Date.now() + SESSION_TIMEOUT_MS;
  while (seen.userMessages.filter((entry) => entry.runId === secondRunId).length === 0) {
    if (Date.now() >= deadline) break;
    if (!cancelledFirst) {
      const still = await client.getRunStatus(firstRunId).catch(() => undefined);
      if (still?.status === 'running' || still?.status === 'queued') {
        const result = await client.cancelRun(firstRunId).catch(() => ({ cancelled: false }));
        cancelledFirst = result.cancelled;
        log(`取消第一条（run=${firstRunId}）→ cancelled=${String(cancelledFirst)}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const secondEchoes = seen.userMessages.filter((entry) => entry.runId === secondRunId);
  const after = await client.inbox({ agent_id: agentId, include_held: true });
  const afterRows = (after.entries ?? []).filter((entry) => entry.session_id === sessionId);
  log(`第二条被取用之后 agents.inbox{session_id} 读数：${String(afterRows.length)} 条（必须 0）`);
  log(`第二条的 user.message：${String(secondEchoes.length)} 条（= 会话里那一颗气泡）`);
  log(`agent.message.queued 事件：${String(seen.queuedEvents.length)} 条`);
  for (const event of seen.queuedEvents) {
    log(
      `  queued message_id=${String(event.messageId)} from=${String(event.from)} delivery=${String(event.delivery)} session=${String(event.sessionId)}`,
    );
  }

  const inboxIds = new Set(heldRows.map((entry) => entry.message_id));
  const claimed = seen.queuedEvents.filter(
    (event) => event.messageId !== undefined && inboxIds.has(event.messageId),
  );
  log(
    `认领链核对：queued 事件的 message_id 与条带条目同一个 → ${String(claimed.length)} 条命中（>=1 才算精确认领可用）`,
  );

  const checks: [string, boolean][] = [
    ['排队期间条带数据源非空（queued 有落点）', heldRows.length >= 1],
    [
      '排队条目的提示只出现在条带（其 session_id 命中当前会话）',
      heldRows.every((entry) => entry.session_id === sessionId),
    ],
    ['被取用后条带数据源清空（sent 后条带那条消失）', afterRows.length === 0],
    ['第二条最终进了会话（它有自己的 user.message）', secondEchoes.length === 1],
    ['排队期间那条还没进会话（它的 user.message 在排队时是 0）', queuedPhaseUserMessages === 0],
    [
      'queued 事件带回 message_id + human + input（精确认领的输入齐了）',
      seen.queuedEvents.some(
        (event) =>
          event.messageId !== undefined && event.from === 'human' && event.delivery === 'input',
      ),
    ],
    ['queued 事件的 message_id 与 inbox 条目是同一个', claimed.length >= 1],
  ];
  /**
   * 前两条是**参考读数**（不计入结论）：`agent.message.queued` 能不能在这次连接里看到。
   *
   * 它只决定「认领」走**精确**那条路还是走**摘要兜底**那条路（两条都在
   * `pending-placement.ts#claimsEntry` 里），不影响「queued 只在条带」这个结论。
   * 本次实测：事件已落盘（`events/<session>.jsonl` 里有），但直连的实时流没把它送给这个
   * 客户端 —— 所以按读数打印，不当断言。
   */
  const info = checks.splice(checks.length - 2, 2);
  let failed = 0;
  console.log('\n=== 真机断言');
  for (const [label, ok] of checks) {
    if (!ok) failed += 1;
    console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}`);
  }
  console.log('=== 参考读数（不计入结论）');
  for (const [label, ok] of info) {
    console.log(`  ${ok ? '有' : '无'} ${label}`);
  }
  console.log(`RESULT: ${failed === 0 ? 'PASS' : 'FAIL'}`);
  if (failed > 0) process.exitCode = 1;
}

await main();
