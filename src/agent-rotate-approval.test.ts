/**
 * `agent` 工具的 rotate 批准等待：**超时兜底**与**取消语义**（0.59）。
 *
 * 这一单要钉的三条，全部来自同一个真事故：浏览器 401 时权限卡到不了人，rotate 的
 * `waitFor` 没有时限 ⇒ 这一轮永远不返回，用户只看到「卡住」然后按停止；而按停止之后
 * 模型读到的结论是 `Error: invalid_input: user` —— 它会以为自己的参数写错了。
 *
 * 1. **超时**：没人在时限内应答 ⇒ 结果与「人类拒绝」同一种形状（`rotate_not_needed`），
 *    reason 是 `approval_timeout`，并带 `timeout_ms`（能分辨「人点了拒绝」与「没人答」）；
 * 2. **取消**：`signal` 被 abort（reason `'user'`）⇒ 兜底包装必须给出 `cancelled` 码，
 *    绝不能是 `invalid_input`；
 * 3. **反向**：真正的参数错误仍然必须是 `invalid_input`（别把这条兜底改没了）；
 *    人类真的点了拒绝，仍然是 `denied_by_human`。
 *
 * 直接跑：`bun run src/agent-rotate-approval.test.ts`（看输出文本判定；本机 bun 是
 * Windows 版，退出码不可信）。
 */

import { createAgentTool } from '../packages/agent/src/tool';
import type { AgentService } from '../packages/agent/src/types';
import { MemoryEventStream } from '../packages/core/src/index';
import type { ToolContext } from '../packages/core/src/types/tool';

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, got?: string): void {
  if (ok) {
    passed += 1;
    return;
  }
  failures.push(got === undefined ? name : `${name} | got: ${got}`);
}

/**
 * 只实现 rotate 分支真正会碰的那几个方法；`createSession` 一律抛错 —— 这几条用例都
 * 走不到「批准了」那条路，真被调到说明逻辑错了。
 */
function stubService(): AgentService {
  const service = {
    contextRatio: () => 0.42,
    canConfirm: () => true,
    noteAgentEvent: () => {},
    identify: async () => undefined,
    createSession: async () => {
      throw new Error('createSession must not be reached in these cases');
    },
  };
  return service as unknown as AgentService;
}

function makeContext(signal?: AbortSignal): { ctx: ToolContext; events: MemoryEventStream } {
  const events = new MemoryEventStream();
  const ctx: ToolContext = {
    session_id: 's-owner',
    run_id: 'run-1',
    messages: [],
    events,
    ...(signal !== undefined ? { signal } : {}),
  };
  return { ctx, events };
}

/** 订阅一次 `tool.permission.request`，拿到 requestId（同时证明请求真的发出去了）。 */
function watchRequests(events: MemoryEventStream): { requestIds: string[] } {
  const requestIds: string[] = [];
  events.subscribe((event) => {
    if (event.type !== 'tool.permission.request') return;
    const data = event.data as { requestId?: unknown };
    if (typeof data.requestId === 'string') requestIds.push(data.requestId);
  });
  return { requestIds };
}

/**
 * 「请求一出现就应答」：订阅 `tool.permission.request`，收到后推迟一个宏任务再 publish
 * 应答 —— 那个时刻 `waitFor` 已经注册好订阅了（工具分支是 publish → waitFor 同步相连）。
 */
function answerWhenRequested(
  events: MemoryEventStream,
  data: Record<string, unknown>,
  delayMs = 0,
): void {
  events.subscribe((event) => {
    if (event.type !== 'tool.permission.request') return;
    const requestId = (event.data as { requestId?: unknown }).requestId;
    if (typeof requestId !== 'string') return;
    setTimeout(() => {
      events.publish({
        type: 'tool.permission.response',
        run_id: 'run-1',
        data: { requestId, ...data },
        ts: Date.now(),
      });
    }, delayMs);
  });
}

interface RotateOutcome {
  text: string;
  elapsedMs: number;
}

async function runRotate(
  tool: { handler: (args: unknown, ctx: ToolContext) => Promise<string> },
  ctx: ToolContext,
): Promise<RotateOutcome> {
  const startedAt = Date.now();
  const text = await tool.handler({ action: 'rotate', startup_prompt: 'handoff' }, ctx);
  return { text, elapsedMs: Date.now() - startedAt };
}

function parseRotateResult(text: string): Record<string, unknown> | null {
  const line = text.split('\n')[0] ?? '';
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  // ---- 1. 超时兜底：没人应答也要有结论，而且不能无限挂 ----
  {
    const tool = createAgentTool(stubService(), {
      ownerSessionId: 's-owner',
      humanApproval: true,
      // 40ms：真机上缺省是 2 分钟，这里只验证「有没有兜底」。
      rotateApprovalTimeoutMs: 40,
    });
    const { ctx, events } = makeContext();
    const watch = watchRequests(events);
    const { text, elapsedMs } = await runRotate(tool, ctx);
    const result = parseRotateResult(text);
    check('超时：请求真的发出去了（同一条 401 事故形状）', watch.requestIds.length === 1);
    check(
      '超时：返回 rotate_not_needed 形状',
      result?.code === 'rotate_not_needed',
      JSON.stringify(result),
    );
    check(
      '超时：status 是 failed（不是 rotated）',
      result?.status === 'failed',
      String(result?.status),
    );
    check('超时：reason 明说是超时', result?.reason === 'approval_timeout', String(result?.reason));
    check('超时：带上等过的时限', result?.timeout_ms === 40, String(result?.timeout_ms));
    check('超时：真的没有挂（< 2s 返回）', elapsedMs < 2_000, `${String(elapsedMs)}ms`);
    check('超时：不带 warning 以外的假授权信息', typeof result?.warning === 'string');
  }

  // ---- 2. 取消：abort('user') ⇒ cancelled 码，不是 invalid_input ----
  {
    const tool = createAgentTool(stubService(), {
      ownerSessionId: 's-owner',
      humanApproval: true,
      // 故意给很大：证明这一条是被 abort 结束的，不是超时。
      rotateApprovalTimeoutMs: 60_000,
    });
    const controller = new AbortController();
    const { ctx, events } = makeContext(controller.signal);
    const watch = watchRequests(events);
    const pending = runRotate(tool, ctx);
    // 让 handler 走到 waitFor 再 abort（模拟人类点「停止」）。
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort('user');
    const { text, elapsedMs } = await pending;
    check('取消：请求已发出', watch.requestIds.length === 1);
    check('取消：从等待中醒来（没等到 60s 超时）', elapsedMs < 1_000, `${String(elapsedMs)}ms`);
    check('取消：错误码是 cancelled', text.startsWith('Error: cancelled:'), text.slice(0, 60));
    check('取消：带上中断原因 user', text.includes('user'), text.slice(0, 60));
    check('取消：**不是**假输入错误', !text.includes('invalid_input'), text.slice(0, 60));
  }

  // ---- 3. 反向：真参数错误仍然 invalid_input ----
  {
    const tool = createAgentTool(stubService(), {
      ownerSessionId: 's-owner',
      humanApproval: true,
      rotateApprovalTimeoutMs: 40,
    });
    const { ctx } = makeContext();
    const text = await tool.handler({ action: 'rotate' }, ctx);
    check(
      '参数错误仍是 invalid_input',
      text.startsWith('Error: invalid_input:') && text.includes('startup_prompt'),
      text.slice(0, 80),
    );
  }

  // ---- 4. 人类真的拒绝：denied_by_human（不被超时逻辑顺手改掉） ----
  {
    const tool = createAgentTool(stubService(), {
      ownerSessionId: 's-owner',
      humanApproval: true,
      rotateApprovalTimeoutMs: 60_000,
    });
    const { ctx, events } = makeContext();
    answerWhenRequested(events, { decision: 'deny', answered_by: 'human' });
    const { text } = await runRotate(tool, ctx);
    const result = parseRotateResult(text);
    check(
      '人类拒绝：reason denied_by_human',
      result?.reason === 'denied_by_human',
      String(result?.reason),
    );
    check('人类拒绝：不带 timeout_ms', result?.timeout_ms === undefined);
  }

  // ---- 4b. 人类拒绝后 signal 随即 abort：仍报 denied_by_human（取消不许遮住业务结论） ----
  {
    const tool = createAgentTool(stubService(), {
      ownerSessionId: 's-owner',
      humanApproval: true,
      rotateApprovalTimeoutMs: 60_000,
    });
    const controller = new AbortController();
    const { ctx, events } = makeContext(controller.signal);
    // 拒绝应答一到就 abort：这一步必须**不**把结论改写成 cancelled。
    events.subscribe((event) => {
      if (event.type !== 'tool.permission.request') return;
      const requestId = (event.data as { requestId?: unknown }).requestId;
      if (typeof requestId !== 'string') return;
      setTimeout(() => {
        events.publish({
          type: 'tool.permission.response',
          run_id: 'run-1',
          data: { requestId, decision: 'deny', answered_by: 'human' },
          ts: Date.now(),
        });
        controller.abort('user');
      }, 0);
    });
    const { text } = await runRotate(tool, ctx);
    const result = parseRotateResult(text);
    check(
      '拒绝后紧接 abort：仍是 denied_by_human（取消优先只对异常路径生效）',
      result?.reason === 'denied_by_human',
      `${text.slice(0, 80)}`,
    );
    check('拒绝后紧接 abort：不变成 cancelled', !text.includes('cancelled'));
  }

  // ---- 5. 人类允许：仍然走 createSession（超时逻辑不误伤正常路径） ----
  {
    let created = 0;
    const service = {
      ...(stubService() as unknown as Record<string, unknown>),
      identify: async () => ({ id: 'a-1', epoch: 2 }),
      createSession: async () => {
        created += 1;
        return { agent_id: 'a-1', session_id: 's-new' };
      },
    } as unknown as AgentService;
    const tool = createAgentTool(service, {
      ownerSessionId: 's-owner',
      humanApproval: true,
      rotateApprovalTimeoutMs: 60_000,
    });
    const { ctx, events } = makeContext();
    answerWhenRequested(events, { decision: 'allow', answered_by: 'human' });
    const { text } = await runRotate(tool, ctx);
    const result = parseRotateResult(text);
    check('人类允许：rotate 真的执行了', created === 1, String(created));
    check('人类允许：结果 status rotated', result?.status === 'rotated', String(result?.status));
  }

  const total = passed + failures.length;
  if (failures.length === 0) {
    console.log(`OK agent-rotate-approval: passed ${String(passed)} / ${String(total)} checks`);
    return;
  }
  for (const failure of failures) console.log(`FAIL ${failure}`);
  console.log(`FAILED agent-rotate-approval: passed ${String(passed)} / ${String(total)}`);
  process.exitCode = 1;
}

await main();
