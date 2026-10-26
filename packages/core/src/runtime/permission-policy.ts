/**
 * 权限策略（ADR-026/029）——工具执行前的权限判定。
 * 从 AgentRuntime 抽出（ADR-033 编排逻辑外推），保持单一职责。
 * @module @vessel-agent/core/runtime
 */

import { randomUUID } from 'node:crypto';
import type { EventStream, RunEvent } from '../types/event.js';
import type { RuntimePermissionConfig } from '../types/plugin.js';
import type { ToolContext, ToolDefinition } from '../types/tool.js';

/**
 * 权限请求超时（0.11.1，DECISION-022 §2.2）。
 *
 * 超时是致命的：调用方必须终止 run，不得把它当作普通工具错误回给模型重试。
 * 0.13（DECISION-024 Addendum A）：默认无限等待，只有显式正数 `timeoutMs` 才产生该错误。
 */
export class PermissionTimeoutError extends Error {
  /** 稳定错误码，供事件 / 调用方判定 */
  readonly code = 'permission_timeout' as const;

  constructor(message = 'Permission request timed out') {
    super(message);
    this.name = 'PermissionTimeoutError';
  }
}

/**
 * 权限等待被取消（0.13，DECISION-024 §2.3）。
 *
 * 与 `PermissionTimeoutError` 区分：取消不是 `permission_timeout`，run 按取消收尾；
 * 错误名沿用原生 abort 语义（`AbortError`），message 取 `signal.reason`。
 */
export class PermissionAbortedError extends Error {
  /** 稳定错误码：取消（非超时） */
  readonly code = 'permission_cancelled' as const;

  constructor(reason?: unknown) {
    const message =
      reason instanceof Error
        ? reason.message
        : typeof reason === 'string' && reason.length > 0
          ? reason
          : 'Permission request cancelled';
    super(message);
    this.name = 'AbortError';
  }
}

/**
 * 工具执行前的权限判定器。持有 remember-always 状态（跨 run，与运行时生命周期一致）。
 */
export class PermissionPolicy {
  private defaultDecision: 'allow' | 'ask';
  private autoApprove: Set<string>;
  /**
   * 自动放行的例外键（工具名或 `${tool.name}.${action}`）。exact 工具名把任何 allow
   * 降级为 ask；scoped 键只降级 auto 来源的 allow（显式工具 allow 保持）。
   */
  private neverAutoApprove: Set<string>;
  private approved: Set<string>;
  /** 显式正数超时；undefined = 无限等待（Addendum A） */
  private readonly timeoutMs?: number;
  /** 事件发布出口（0.18：AgentRuntime 注入以先落盘再发布；缺省直接发布） */
  private readonly emit: (event: RunEvent) => void;
  /** 累计等待用户授权的时长（毫秒）；终止判定把它从 elapsed 中扣除。 */
  private pausedMsTotal = 0;

  constructor(
    private events: EventStream,
    config?: RuntimePermissionConfig,
    private readonly tenantId?: string,
    emit?: (event: RunEvent) => void,
  ) {
    this.emit = emit ?? ((event) => this.events.publish(event));
    this.defaultDecision = config?.default ?? 'allow';
    this.autoApprove = new Set(config?.autoApprove ?? []);
    this.neverAutoApprove = new Set(config?.neverAutoApprove ?? []);
    this.approved = new Set();
    const timeoutMs = config?.timeoutMs;
    this.timeoutMs =
      typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : undefined;
  }

  /** 累计等待用户授权的时长（毫秒），供终止判定从 `max_runtime` 中扣除。 */
  get pausedMs(): number {
    return this.pausedMsTotal;
  }

  /** 每次 run 开始时重置等待统计；策略实例跨 run 复用，不能把上一次的等待带入下一次。 */
  resetPausedMs(): void {
    this.pausedMsTotal = 0;
  }

  /**
   * 就地替换规则（热应用）。策略实例跨 run 存活，配置变更后无需重建 runtime：
   * 下一轮工具调用即按新规则判定。`default` 缺省时保持当前判定。
   * 已记住的 "always"（`approved`）不受影响——那是用户在本进程里做出的决定。
   */
  replaceRules(
    config: Pick<RuntimePermissionConfig, 'default' | 'autoApprove' | 'neverAutoApprove'>,
  ): void {
    if (config.default !== undefined) this.defaultDecision = config.default;
    this.autoApprove = new Set(config.autoApprove ?? []);
    this.neverAutoApprove = new Set(config.neverAutoApprove ?? []);
  }

  /** 当前规则快照（诊断 / 通知用）。 */
  snapshotRules(): {
    default: 'allow' | 'ask';
    autoApprove: string[];
    neverAutoApprove: string[];
  } {
    return {
      default: this.defaultDecision,
      autoApprove: [...this.autoApprove],
      neverAutoApprove: [...this.neverAutoApprove],
    };
  }

  /**
   * 判定并放行/拒绝工具执行。允许则正常返回；拒绝则抛错。
   * - 工具自带 checkPermission → 用工具的判定；若返回 `ask`，仍受 autoApprove /
   *   已记住（always）约束，命中则放行，否则由本策略统一发一次请求；
   * - 未声明 → 默认策略：default='ask'（且非 autoApprove/已记住）走事件流确认。
   *   库默认 'allow'（不确认），交互模式由 app 层传 permission.default='ask' 开启。
   */
  async authorize(tool: ToolDefinition, args: unknown, ctx: ToolContext): Promise<void> {
    let decision: 'allow' | 'deny' | 'ask';
    // 判定来源：'tool' = 工具 checkPermission 的显式判定；'auto' = autoApprove / default / remember。
    let source: 'tool' | 'auto';
    if (tool.checkPermission) {
      decision = await tool.checkPermission(args, ctx);
      source = 'tool';
      // 工具要求确认时，autoApprove / remember-always 仍是用户已表达过的意图。
      if (decision === 'ask' && (this.autoApprove.has(tool.name) || this.approved.has(tool.name))) {
        decision = 'allow';
        source = 'auto';
      }
    } else if (
      this.defaultDecision === 'allow' ||
      this.autoApprove.has(tool.name) ||
      this.approved.has(tool.name)
    ) {
      decision = 'allow';
      source = 'auto';
    } else {
      decision = 'ask';
      source = 'auto';
    }

    // 0.27 / CONTRACT-tool-policy-ui §1：neverAutoApprove 的 exact 与 scoped 语义不同。
    // - exact 工具名（`read` / `agent`）：把**任何** allow 降级为 ask，强制确认才生效；
    // - scoped `${tool.name}.${action}`（`agent.close`）：只降级 auto 来源的 allow，
    //   工具 checkPermission 的显式 allow 保持——例如关自己的 contractor 不需要批准，
    //   而 peer close 经 autoApprove 升级来的 allow 仍需确认。
    // `deny` 不受影响。
    if (decision === 'allow') {
      if (this.hitsNeverExact(tool)) {
        decision = 'ask';
      } else if (source === 'auto' && this.hitsNeverScoped(tool, args)) {
        decision = 'ask';
      }
    }

    if (decision === 'deny') {
      throw new Error(`Tool "${tool.name}" execution denied by permission policy`);
    }
    if (decision === 'ask') {
      const requestId = randomUUID();
      const ts = Date.now();
      this.emit({
        type: 'tool.permission.request',
        run_id: ctx.run_id,
        data: {
          requestId,
          tool: tool.name,
          input: args,
          // 0.13（DECISION-024 §2.1）：交互事件与 run / session / tool call 关联，additive。
          ...(ctx.session_id !== undefined ? { session_id: ctx.session_id } : {}),
          ...(ctx.tool_call_id !== undefined ? { tool_call_id: ctx.tool_call_id } : {}),
          // 只有显式正数超时才承诺 deadline；默认无限等待时不写（Addendum A）。
          ...(this.timeoutMs !== undefined ? { deadline_at: ts + this.timeoutMs } : {}),
          source: ctx.source ?? 'runtime',
        },
        ts,
        ...(this.tenantId !== undefined ? { tenant_id: this.tenantId } : {}),
      });
      const decided = (await this.waitForDecision(tool, requestId, ctx)) as
        | { decision?: 'allow' | 'deny' | 'ask'; allowed?: boolean; remember?: boolean }
        | undefined;
      const userDecision = decided?.decision ?? (decided?.allowed === false ? 'deny' : 'allow');
      if (userDecision !== 'allow') {
        throw new Error(`Tool "${tool.name}" execution denied by user`);
      }
      // 用户选 "always" → 记住，后续同工具不再确认
      if (decided?.remember) {
        this.approved.add(tool.name);
      }
    }
  }

  /** exact 工具名命中：降级任何 allow。未配置时零开销。 */
  private hitsNeverExact(tool: ToolDefinition): boolean {
    if (this.neverAutoApprove.size === 0) return false;
    return this.neverAutoApprove.has(tool.name);
  }

  /**
   * scoped `${tool.name}.${action}` 命中：只降级 auto 来源的 allow。
   * args 必须是对象且 `action` 为字符串。未配置时零开销。
   */
  private hitsNeverScoped(tool: ToolDefinition, args: unknown): boolean {
    if (this.neverAutoApprove.size === 0) return false;
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return false;
    const action = (args as Record<string, unknown>).action;
    return typeof action === 'string' && this.neverAutoApprove.has(`${tool.name}.${action}`);
  }

  /**
   * 等待用户决定。默认无限等待，直到应答或 abort（Addendum A）；
   * 只有显式正数 `timeoutMs` 才在超时后抛 `PermissionTimeoutError`（0.11.1）。
   * 0.13（DECISION-024 §2.3）：等待绑定 `ctx.signal`；abort 时立即结束并把取消错误
   * 原样抛出，不得误报 `permission_timeout`。
   */
  private async waitForDecision(
    tool: ToolDefinition,
    requestId: string,
    ctx: ToolContext,
  ): Promise<unknown> {
    const waitStartedAt = Date.now();
    try {
      return await this.events.waitFor('tool.permission.response', {
        requestId,
        // 不传 timeout = 不设 timer；显式正数才计时。
        ...(this.timeoutMs !== undefined ? { timeout: this.timeoutMs } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch (error) {
      // 取消优先于超时：run 已被中止时保留取消语义，不转换成权限超时。
      if (ctx.signal?.aborted) {
        throw new PermissionAbortedError(ctx.signal.reason ?? error);
      }
      // 未配置超时时不存在“超时”语义，原样抛出（不伪造 permission_timeout）。
      if (this.timeoutMs === undefined) throw error;
      throw new PermissionTimeoutError(
        `Permission request for tool "${tool.name}" timed out after ${this.timeoutMs}ms`,
      );
    } finally {
      // 人工确认不是机器执行时间：累计后由终止判定从 elapsed 中扣除。
      this.pausedMsTotal += Date.now() - waitStartedAt;
    }
  }
}
