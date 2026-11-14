/**
 * `pii.reveal`：审批解锁工具（0.52）。
 *
 * 为什么是工具而不是新 RPC：
 * - 工具自带的 `checkPermission()` 就是**现有 ask / permission 链**（
 *   `tool.permission.request` → 人在前端批 → 管道放行才进 handler），
 *   不需要新造机制，也不需要改 RPC 契约；
 * - 反过来，**没有人批就进不了 handler**，这正是「真值必须人工审批」的落点。
 *
 * 三条硬性行为：
 * 1. 没有审批证据 ⇒ 直接拒（不是静默允许）。「审批证据」= 事件流里存在与本
 *    `tool_call_id` 配对的 `tool.permission.request`。没有它说明这条调用是被
 *    自动放行策略（如 `autoApprove`）喂进来的，不算人工批准。
 * 2. 解锁出的真值只回给模型这一轮（tool result），**不落审计**；
 *    审计只落 `{session, category, handle, approval_id, revealed_at}`（无值）。
 * 3. 句柄解不开时按三档原因抛错（含下一步），不返回占位符。
 */

import type { EventStream, RunEvent } from '../types/event.js';
import type { ToolContext, ToolDefinition } from '../types/tool.js';
import { PiiHandleUnresolvedError, isHandleId } from './rules.js';
import { getPiiVault, type PiiVault } from './vault.js';
import { findHandles, piiHandlePattern } from './rules.js';

/** 工具名（唯一注册入口是 PluginHost，见 `plugins/security/guardrail-pii`）。 */
export const PII_REVEAL_TOOL_NAME = 'pii.reveal';

/** 审批审计事件名（append-only 事件流；payload 无真值）。 */
export const PII_REVEAL_AUDIT_EVENT = 'pii.reveal.audit';
/** 拒绝解锁的错误码（`error-envelope` 的 CODE_META 里登记）。 */
export const PII_REVEAL_DENIED_CODE = 'pii_reveal_denied';

/** 未获人工批准就解锁时抛的错。 */
export class PiiRevealNotApprovedError extends Error {
  readonly code = PII_REVEAL_DENIED_CODE;
  readonly details: Record<string, unknown>;

  constructor(sessionId: string | undefined, toolCallId: string | undefined) {
    super(
      'pii.reveal requires human approval and this call has none. ' +
        'Nothing was revealed. Next: ask the user (the runtime shows a permission card for pii.reveal) — ' +
        'do not retry the same call expecting a different result, and never paste the placeholder to a user as if it were the value.',
    );
    this.name = 'PiiRevealNotApprovedError';
    this.details = {
      reason: 'not_approved',
      ...(sessionId !== undefined ? { session: sessionId } : {}),
      ...(toolCallId !== undefined ? { tool_call_id: toolCallId } : {}),
    };
  }
}

/** `pii.reveal` 的入参（宽进：接受完整占位符或裸 id）。 */
interface RevealInput {
  handle?: unknown;
  reason?: unknown;
}

function readHandleId(input: unknown): string | undefined {
  if (input === null || typeof input !== 'object') return undefined;
  const raw = (input as RevealInput).handle;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (isHandleId(trimmed)) return trimmed;
  const occurrences = findHandles(trimmed);
  if (occurrences.length === 1) return occurrences[0]!.id;
  return undefined;
}

/**
 * 找「这条工具调用的审批 id」。
 *
 * 权限请求事件的 `data.requestId` 就是人看到并点「允许」的那张卡的 id，
 * 与 `tool.permission.request` / `tool.permission.response` 双向对得上；
 * 这里只认与本 `tool_call_id` 配对的那一条，避免同 run 内多次 ask 串台。
 */
export function findApprovalId(
  events: Pick<EventStream, 'getHistory'>,
  runId: string | undefined,
  toolCallId: string | undefined,
): string | undefined {
  if (toolCallId === undefined) return undefined;
  const history: RunEvent[] = events.getHistory(runId);
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const event = history[i]!;
    if (event.type !== 'tool.permission.request') continue;
    const data = event.data as Record<string, unknown> | undefined;
    if (data === undefined) continue;
    if (data.tool_call_id !== toolCallId) continue;
    const requestId = data.requestId ?? data.request_id;
    if (typeof requestId === 'string' && requestId.length > 0) return requestId;
  }
  return undefined;
}

/** 构造 `pii.reveal` 工具。`vault` 缺省用进程单例（与请求 / 工具边界同源）。 */
export function createPiiRevealTool(options: { vault?: PiiVault } = {}): ToolDefinition {
  const vaultOf = (): PiiVault => options.vault ?? getPiiVault();

  return {
    name: PII_REVEAL_TOOL_NAME,
    description:
      'Reveal the real value behind a redacted PII placeholder (for example «pii:K3M7QX2A»). ' +
      'Use it only when the actual value is required to finish the task — for instance to read or write a ' +
      'credential that the user asked you to place somewhere. Every call needs human approval; without it the ' +
      'call is rejected. The returned value is visible to you for this step only; it is re-redacted afterwards. ' +
      'Never guess or fabricate the value.',
    inputSchema: {
      type: 'object',
      properties: {
        handle: {
          type: 'string',
          description: 'The placeholder to reveal, e.g. «pii:K3M7QX2A» (the bare 8-character id also works).',
        },
        reason: {
          type: 'string',
          description: 'One short sentence: why the real value is needed. Shown to the human approver.',
        },
      },
      required: ['handle'],
      additionalProperties: false,
    },
    display: { label: 'Reveal PII', kind: 'generic' },
    concurrencySafe: false,
    // 复用现有 ask 链：管道会发 tool.permission.request 并等人批。
    checkPermission: async () => 'ask',
    handler: async (args: unknown, ctx: ToolContext): Promise<string> => {
      const vault = vaultOf();
      const sessionId = ctx.session_id;
      const handleId = readHandleId(args);
      if (handleId === undefined) {
        throw new PiiHandleUnresolvedError(
          [typeof (args as RevealInput | undefined)?.handle === 'string' ? String((args as RevealInput).handle) : '<missing>'],
          'unknown_handle',
          sessionId,
        );
      }
      if (sessionId === undefined) {
        throw new PiiHandleUnresolvedError([`«pii:${handleId}»`], 'unknown_handle', undefined);
      }

      // 1) 审批证据（没有人批 ⇒ 直接拒）
      const approvalId = findApprovalId(ctx.events, ctx.run_id, ctx.tool_call_id);
      if (approvalId === undefined) {
        throw new PiiRevealNotApprovedError(sessionId, ctx.tool_call_id);
      }

      // 2) 解锁（三档失败原因照原样抛）
      const result = vault.reveal(sessionId, handleId);
      if (!result.ok) {
        throw new PiiHandleUnresolvedError([`«pii:${handleId}»`], result.reason, sessionId);
      }

      // 3) 审计（**无真值**）。事件名用字面量：`check:event-visibility` 只扫字面量生产点，
      //    常量转发会被判成「非字面量」而 FAIL。
      const audit: RunEvent = {
        type: 'pii.reveal.audit',
        run_id: ctx.run_id,
        ts: Date.now(),
        data: {
          session: sessionId,
          category: result.category,
          handle: `«pii:${handleId}»`,
          approval_id: approvalId,
          tool_call_id: ctx.tool_call_id,
          revealed_at: Date.now(),
          outcome: 'revealed',
        },
      };
      ctx.events.publish(audit);

      return result.value;
    },
  };
}

/** 占位符正则的直接导出，方便前端 / 探针对齐形状。 */
export { piiHandlePattern };
