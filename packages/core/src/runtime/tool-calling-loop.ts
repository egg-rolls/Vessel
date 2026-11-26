/**
 * Tool-calling loop
 *
 * Loop 只做算法编排：LLM 请求 → tool_calls 解析 → 工具执行 → 结果写回 → 循环。
 * 所有协作者（provider / 窗口 / 工具 / 事件 / run 控制）都经 `LoopContext` 注入；
 * 本模块不感知 durable 存储实现，也不从任何 barrel 导出。
 *
 * 唯一的例外是**工具结果出口闸**（0.56 上移）：工具结果写回上下文之前统一过
 * `boundToolResult`（≤ 16k token，超了先落盘全文再头 30% / 尾 70% 裁切，
 * 见 `tool-result-gate.ts`）。闸放在这里而不是各个插件里，是为了让 web_fetch / MCP /
 * 未来插件的返回值也受同一条约束；落盘路径仍由同一个 `toolOutputRoot()` 决定。
 *
 * @module @vessel-agent/core/runtime
 */

import { LimitExceededError } from '../limits/index.js';
import type { ContextCompactedReason } from '../types/context.js';
import type { RunEvent } from '../types/event.js';
import { GuardrailStage } from '../types/guardrail.js';
import { type HookContext, HookType } from '../types/hook.js';
import type {
  LimitBlock,
  LimitChecker,
  TerminationPolicy,
  UsageLimits,
  UsagePricing,
  UsageStats,
} from '../types/limits.js';
import {
  type ChatRequest,
  type EmptyResponsePolicy,
  type LLMResponse,
  MESSAGE_REFS_MAX,
  type Message,
  type MessageRef,
} from '../types/provider.js';
import type { Run } from '../types/run.js';
import type { ToolCall } from '../types/tool.js';
import type { GuardrailRunner } from './guardrail-runner.js';
import type { HookRunner } from './hook-runner.js';
import type { PrefixChangeReason, PromptPrefixGuard } from './prompt-prefix-guard.js';
import type { RunTiming } from './run-timing.js';
import { isToolCall } from './tool-pipeline.js';
import { isBridgeCall } from './tool-provenance.js';
import { boundToolResult, writeToolOutput } from './tool-result-gate.js';

/** Loop 的最终结果；usage/facts 已通过 Run 拥有的 execution/context 原地写回。 */
export type LoopResult = string;

/** 空响应重试上限缺省（不含首次响应；seamless 重调 / nudge 共用；q-empty-response）。 */
export const DEFAULT_EMPTY_RESPONSE_MAX_RETRIES = 2;

/** 空响应 nudge 缺省文案（以 `vessel:notice` user 消息追加；可经配置覆盖）。 */
export const DEFAULT_EMPTY_RESPONSE_NUDGE =
  '你上一条回复为空（没有内容也没有工具调用）。请继续你的任务：给出完整的最终答复，或调用工具继续推进。';

/** 重试上限净化：非有限数 / 负数 ⇒ 缺省；否则向下取整（配置 validator 另有 0–10 界）。 */
function sanitizeEmptyResponseRetries(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return DEFAULT_EMPTY_RESPONSE_MAX_RETRIES;
  }
  return Math.floor(value);
}

/** Run 内一次 loop 的完整依赖面；每 run 构造一次，无跨 run 状态。 */
export interface LoopContext {
  readonly execution: Run;
  /** 本次请求的模型标识；计价按它查价格表。 */
  readonly model: string;
  /** provider 身份（additive，q-thinking-plugin；来自 provider 实例事实）；缺省 = 身份未知。 */
  readonly providerName?: string;
  /** 成员实际 cwd（additive，P1 origin 填充；EU member-cwd 事实 toolCwd）；缺省 = 装配未填。 */
  readonly cwd?: string;
  /** 成员 id（additive，P1 origin 填充；EU 身份事实 boundAgentId，跨 body 稳定）；缺省 = 装配未填。 */
  readonly agent_id?: string;
  /** opt-in 计价；缺省不累计 `totalCost`。 */
  readonly pricing?: UsagePricing;
  /**
   * 本轮输入的附件引用（0.52）：只透传给 BeforeLlm 的 `HookContext.refs`，
   * loop 自己不读、不改、不进请求体。缺省（无引用）= 旧行为。
   */
  readonly inputRefs?: readonly MessageRef[];
  readonly window: MessageWindowPort;
  readonly provider: ProviderPort;
  readonly tools: ToolExecutor;
  readonly events: EventSink;
  readonly controls: RunControls;
  /**
   * 0.57：本轮 run 的分段耗时账本（可缺省 —— 缺省 = 不打 `run.llm.gap`）。
   *
   * loop 只负责把「模型耗时 / 两轮之间的间隔 / 上一轮工具耗时」交上去；输出格式与
   * 开关在 `run-timing.ts` 一处定义（宪法第十四条：格式只有一处真相）。
   */
  readonly timing?: RunTiming;
  /**
   * 空响应兜底策略（q-empty-response；additive 可缺省）。
   * 缺省 = 启用、无感重试（seamless）2 次 + 耗尽升级一次 nudge（库用户不注入也拿到
   * 兜底）；seamless=false 走一期 nudge 路径；见 `EmptyResponsePolicy`。
   */
  readonly emptyResponse?: EmptyResponsePolicy;
}

/** WorkingContext / MessageWindowPort：只读写本次 run 的内存窗口。 */
export interface MessageWindowPort {
  addMessage(message: Message, runId: string): void;
  buildRequestMessages(systemOverride: unknown): Message[];
  /**
   * 0.52：请求 messages 只许 append ⇒ 句柄失效/容量耗尽这种「面上的」事件，
   * 只能在发请求前**追加一张 env 卡**（不许回改历史）。缺省实现 = 不追加。
   */
  appendPiiDeadNotice?(): Promise<void>;
  /**
   * tools-body-snapshot：请求 tools[] 是会话起点快照；会话中途宿主工具面变化只以
   * **追加一张 env 卡**（scope `tools`）表达。必须在 buildRequestMessages 之前调用
   * （卡要进本次请求）；首请求同时完成懒 pin（pin=live ⇒ 无卡）。缺省实现 = 不追加。
   */
  appendToolSurfaceNotice?(): void;
  appendInjectedMessages(runId: string, messages: readonly Message[] | undefined): void;
  updateRealTokens(total: number): void;
  /**
   * 段起点压缩入口（`context.autoCompactAsync?.()`）；实现缺省时返回 undefined。
   *
   * 0.52 V2：**loop 不再调用**它。压缩 = 删中段 + 插新摘要 = 就地改写历史，只允许在
   * 段边界发生；调用点只剩 `ExecutionUnit` 的段起点（seed 之后、第一条请求之前）。
   * 接口保留是为了实现方（ExecutionUnit / 探针 mock）契约稳定。
   */
  autoCompact(): Promise<number | undefined>;
}

/** Provider：一次 chat 调用（含 context-overflow 压缩重试）。 */
export interface ProviderPort {
  chat(args: {
    messages: Message[];
    tools: NonNullable<ChatRequest['tools']>;
    sessionId: string;
    signal?: AbortSignal;
    rebuildMessages: () => Message[];
    /** BeforeLlm hook 注入的额外头/参数（additive，q-thinking-plugin）；缺省 = 请求形状不变。 */
    requestExtras?: {
      headers?: Record<string, string>;
      params?: Record<string, unknown>;
    };
  }): Promise<LLMResponse>;
}

/** ToolExecutor：工具 schema、并发判定、单调用执行。 */
export interface ToolExecutor {
  listToolSchemas(): NonNullable<ChatRequest['tools']>;
  isConcurrencySafe(entry: PreparedToolCall): boolean;
  runToolCall(entry: PreparedToolCall, signal?: AbortSignal): Promise<ToolExecutionOutcome>;
}

/** EventSink：Loop 的唯一事件出口；持久化由 Run 的实现决定，Loop 不感知。 */
export interface EventSink {
  emit(event: RunEvent, options?: { persistData?: unknown }): void;
}

/** RunControls：abort / limits / termination / 每 run 策略与安全点。 */
export interface RunControls {
  readonly signal?: AbortSignal;
  readonly limits: UsageLimits;
  readonly termination: TerminationPolicy;
  readonly hooks: HookRunner;
  readonly guardrails: GuardrailRunner;
  readonly prefixGuard: PromptPrefixGuard;
  readonly limitChecker: LimitChecker;
  getPausedMs(): number;
  evaluateTermination(stats: UsageStats): LimitBlock | null;
  evaluateUsageLimits(stats: UsageStats): LimitBlock | null;
  publishLimitWarnings(): void;
  publishContextPressureWarning(): void;
  publishCompacted(removed: number, reason: ContextCompactedReason): void;
  ensurePrefixReason(reason: PrefixChangeReason): void;
  takePrefixReason(): PrefixChangeReason | undefined;
  getBaseSystemPrompt(): string | undefined;
  /** 已报告过返回 false；否则置位并返回 true。 */
  markSystemPromptIgnored(): boolean;
  markAdditionalContextDeprecated(): boolean;
  hasSeenLegacyContext(content: string): boolean;
  markLegacyContextSeen(content: string): void;
  /** 每轮工具结果写回后的 durable 安全点；由 Run 实现。 */
  onSafePoint(): Promise<void>;
}

/** 预处理后的工具调用（0.6.1 P1：安全批次并发） */
export interface PreparedToolCall {
  toolCall: ToolCall;
  toolName: string;
  args: unknown;
  startedAt: number;
  /** 已定性的失败（guardrail 阻断 / 非法 JSON）；不执行工具，直接折回 */
  failureMessage?: string;
}

/** 单个工具调用的执行结果（上下文按原顺序写回） */
export interface ToolExecutionOutcome {
  toolCall: ToolCall;
  /** 实际使用的输入（BeforeTool hook 改写后）；供 AfterTool 读取 */
  input: unknown;
  ok: boolean;
  content: string;
  /**
   * 结果**已过出口闸**（≤ 16k token，头部 30% / 尾部 70%，中间带落盘路径的省略标注）。
   *
   * 唯一的来源是 handler 自己裁完后登记的回执（`markToolResultBounded`，经
   * `ToolPipelineResult.bounded` 传到这里）—— 例如 basic-tools 作为第二道闸先裁了一遍。
   * loop 见到就原样写回：**已经裁过的结果不能再裁第二次**，否则第二轮会把
   * 「… 省略 N 行 / M 字符 · 完整输出：<path>」那一行自己裁掉，落盘路径就丢了。
   */
  bounded?: true;
  /** 裁剪前字符数（与 `bounded` 同时出现） */
  original_chars?: number;
  /**
   * 工具结果附带的图片引用（q-media-view additive；来自 `attachToolImages` 回执）。
   * loop 在本批工具结果全部写回后，以一条带 refs 的 user 消息 surfaced（既有注入通道），
   * 请求期由视觉基座（`vision/plan.ts`）内联给多模态主模型。缺省 = 旧行为。
   */
  refs?: MessageRef[];
}

/**
 * 工具结果出口闸（0.56 上移）：**所有**插件工具的返回值都在这里收口。
 *
 * 上移前闸是 `basic-tools` 的私有函数，于是只有 bash / read / edit 在闸内，
 * web_fetch / MCP / 未来插件的返回值原样进上下文（一条 100k 字符就能挤爆窗口）。
 * 现在统一在 loop 写回上下文之前过闸：裁切 + 落盘路径引用（见 `tool-result-gate.ts`）。
 *
 * 幂等：`outcome.bounded === true`（handler 自己裁过）直接原样返回，不再裁。
 */
async function gateToolResult(outcome: ToolExecutionOutcome, sessionId: string): Promise<string> {
  if (outcome.bounded === true) return outcome.content;
  const gated = await boundToolResult(outcome.content, {
    // 落盘仍写在原来的 tool-output 目录（`toolOutputRoot()`），实现只有一份。
    persist: () =>
      writeToolOutput({
        tool: outcome.toolCall.function.name,
        body: outcome.content,
        sessionId,
      }),
  });
  return gated.content;
}

/**
 * 工具结果附图的注入文案（q-media-view）：告诉模型这条 user 消息带着工具读出的图。
 *
 * 与 `[refs]` 尾注同一口径（英文、只列前 3 条路径）；明说「内联取决于模型视觉能力」，
 * 不声称一定发出去了 —— 投递事实由 `image.sent` / `context.image_dropped` 事件表达。
 */
function toolImageAttachmentNote(
  refs: readonly MessageRef[],
  tools: readonly string[],
  omitted: number,
): string {
  const shown = refs.slice(0, 3).map((ref) => ref.path);
  if (refs.length > 3) shown.push(`+${String(refs.length - 3)} more`);
  const noun = refs.length === 1 ? 'image' : 'images';
  const from = tools.length > 0 ? ` from tool ${[...new Set(tools)].join(' / ')}` : '';
  const cap = omitted > 0 ? ` (${String(omitted)} more omitted: over per-message ref cap)` : '';
  return (
    `[tool image] ${String(refs.length)} ${noun}${from}: ${shown.join(', ')}${cap}. ` +
    'Attached to this message for direct viewing (inlined when the model supports vision; ' +
    'delivery facts: image.sent / context.image_dropped).'
  );
}

/**
 * 「工具结果里疑似有 base64 图片」的信号（0.56 P0；**只报警、不修**）。
 *
 * 现状（今天就在流血）：MCP 的 `{type:'image', data:'<base64>'}` 块被
 * `JSON.stringify` 成**文本**塞进工具结果（`plugins/mcp/client/src/server-connection.ts:543`），
 * 于是 1 MiB 图 = 1,398,104 个 base64 字符，被字符级估算器按 ≈432k token 计
 * （provider 只收 ≤1024 —— 420 倍）。P0 的边界很清楚：**把它从「静默」变成「有信号」**，
 * 真正的修法（MCP image 块并入 `attach`）是 P1。
 *
 * 判据（刻意保守，宁可漏报也不误报）：出现 `"type":"image"` 附近的 `"data":"<长 base64>"`
 * 或 `data:image/...;base64,` 前缀，且那一段 ≥ 4096 个 base64 字符。只回一个类名 + 长度，
 * **不回内容**（事件里永远不出现 base64 本身，否则 8 KiB 裁剪会把它切成垃圾 —— P0-07）。
 */
export function detectBase64ImagePayload(
  text: string,
): { kind: string; bytes: number } | undefined {
  const marker = text.indexOf('data:image/');
  if (marker >= 0) {
    const end = text.indexOf('base64,', marker);
    if (end >= 0) {
      let length = 0;
      for (let index = end + 7; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        const isBase64 =
          (code >= 0x41 && code <= 0x5a) ||
          (code >= 0x61 && code <= 0x7a) ||
          (code >= 0x30 && code <= 0x39) ||
          code === 0x2b ||
          code === 0x2f ||
          code === 0x3d;
        if (!isBase64) break;
        length += 1;
      }
      if (length >= 4096) return { kind: 'data_url', bytes: length };
    }
  }
  if (text.includes('"type":"image"') || text.includes('"type": "image"')) {
    const dataAt = text.search(/"data"\s*:\s*"/);
    if (dataAt >= 0) {
      const quote = text.indexOf('"', text.indexOf(':', dataAt) + 1);
      let length = 0;
      for (let index = quote + 1; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        const isBase64 =
          (code >= 0x41 && code <= 0x5a) ||
          (code >= 0x61 && code <= 0x7a) ||
          (code >= 0x30 && code <= 0x39) ||
          code === 0x2b ||
          code === 0x2f ||
          code === 0x3d;
        if (!isBase64) break;
        length += 1;
      }
      if (length >= 4096) return { kind: 'mcp_image_block', bytes: length };
    }
  }
  return undefined;
}

/**
 * Tool-calling loop
 * 核心循环：调用 LLM -> 解析 tool_calls -> 执行工具 -> 注入结果 -> 循环
 * @param ctx 本次 run 的完整依赖面（run/session/usage 的唯一来源）
 */
export async function runToolCallingLoop(ctx: LoopContext): Promise<LoopResult> {
  const { runId, sessionId, stats } = ctx.execution;
  // 0.57 分段耗时：轮次从 1 起；`previous*` 是**上一轮**的读数（gap 那一行要用它把
  // 「模型慢」和「我们中间那一小段慢」分开）。
  let round = 0;
  // 空响应兜底（q-empty-response）：本 run 已用的兜底动作次数（seamless/nudge 累计，
  // 供事件 attempt）；限次防死循环。seamlessRetries 单独记无感重调预算；
  // nudgeEscalated = 无感耗尽后已升级过一次 nudge（打破空模式的最后一击）。
  let emptyRetries = 0;
  let seamlessRetries = 0;
  let nudgeEscalated = false;
  let previousResponseAt: number | undefined;
  let previousToolCalls: number | undefined;
  let previousToolsMs: number | undefined;
  while (true) {
    round += 1;
    // AbortSignal 中断（Hermes/Claude Code 模式——外部 Esc）
    if (ctx.controls.signal?.aborted) {
      throw new Error(ctx.controls.signal.reason ?? 'Run cancelled');
    }

    // 权限等待不计入 max_runtime（ADR-084 Errata）：每轮同步累计暂停时长。
    stats.pausedMs = ctx.controls.getPausedMs();

    // 0.15 E2：90% 预警（每 run 每 key 一次，不改变执行）
    ctx.controls.publishLimitWarnings();

    // 检查终止条件
    const terminationBlock = ctx.controls.evaluateTermination(stats);
    if (terminationBlock) {
      ctx.events.emit({
        type: 'limit.blocked',
        run_id: runId,
        data: {
          error_code: 'limit_blocked',
          ...terminationBlock,
          run_id: runId,
          session_id: sessionId,
        },
        ts: Date.now(),
      });
      throw new LimitExceededError(terminationBlock);
    }

    // 检查使用量限制。request / token / cost 都是硬上限；循环由
    // max_iterations / max_runtime_seconds 兜底，不再有工具调用次数预算。
    const limitBlock = ctx.controls.evaluateUsageLimits(stats);
    if (limitBlock) {
      ctx.events.emit({
        type: 'limit.blocked',
        run_id: runId,
        data: {
          error_code: 'limit_blocked',
          ...limitBlock,
          run_id: runId,
          session_id: sessionId,
        },
        ts: Date.now(),
      });
      throw new LimitExceededError(limitBlock);
    }

    // 压力预警线（默认 50%）–压缩阈值（默认 85%）：不压缩，只提示换 ExecutionUnit；
    // 超过压缩阈值交给段起点压缩。
    // 自动压缩关闭时没有后续压缩降水位，提示不设上界（见 publishContextPressureWarning）。
    ctx.controls.publishContextPressureWarning();

    // 0.52 V2：**run 内不许压缩**。压缩 = 删中段 + 插新摘要 = 就地改写历史，历史一旦
    // 在某一轮改形，本轮之前与之后的请求前缀就对不上（append-only 不变量破、prefix
    // cache 全丢）。压缩因此只在段边界发生：`ExecutionUnit` 在 run 起点（seed 之后、
    // 第一条请求之前）调 `autoCompactAsync()`，压缩成功后那段视图就是新段的基准
    // （`new(compaction)`），段内不再改写。撑爆上下文时也不在这里补救 —— core 追加一张
    // 「超限」卡并以失败收尾，下一次 run 的段起点压缩后开新段。

    // CONTRACT-prefix-invariant §2：system 冻结。hook 可以读基底 system，
    // 但写入被忽略（首次写入发一次事件），system 始终是会话级基底 + Self Card。
    // 附件引用（0.52）：只告诉 hook「本轮带哪些引用」（路径与种类），正文永不在此出现。
    const inputRefs = ctx.inputRefs;
    const hookCtx: HookContext = {
      run_id: runId,
      session_id: sessionId,
      request_index: round - 1,
      model: ctx.model,
      ...(ctx.providerName !== undefined ? { providerName: ctx.providerName } : {}),
      ...(ctx.cwd !== undefined ? { cwd: ctx.cwd } : {}),
      ...(ctx.agent_id !== undefined ? { agent_id: ctx.agent_id } : {}),
      ...(inputRefs !== undefined && inputRefs.length > 0 ? { refs: inputRefs } : {}),
    };
    const baseSystemPrompt = ctx.controls.getBaseSystemPrompt();
    Object.defineProperty(hookCtx, 'systemPrompt', {
      enumerable: true,
      // 不可重定义：hook 只能读，写入被忽略并记一次事件。
      configurable: false,
      get: () => baseSystemPrompt,
      set: () => {
        if (!ctx.controls.markSystemPromptIgnored()) return;
        ctx.events.emit({
          type: 'hook.system_prompt_ignored',
          run_id: runId,
          data: { run_id: runId, session_id: sessionId },
          ts: Date.now(),
        });
      },
    });
    const beforeLlm = await ctx.controls.hooks.run(HookType.BeforeLlm, hookCtx);

    // §3：旧 additionalContext 不再拼进 system，改为一条尾消息（每 run 去重）。
    const legacyContext = beforeLlm.additionalContext;
    if (typeof legacyContext === 'string' && legacyContext.length > 0) {
      if (ctx.controls.markAdditionalContextDeprecated()) {
        ctx.events.emit({
          type: 'hook.additional_context_deprecated',
          run_id: runId,
          data: { run_id: runId, session_id: sessionId },
          ts: Date.now(),
        });
      }
      if (!ctx.controls.hasSeenLegacyContext(legacyContext)) {
        ctx.controls.markLegacyContextSeen(legacyContext);
        hookCtx.messages = [
          ...(hookCtx.messages ?? []),
          {
            role: 'user',
            name: 'vessel:hook',
            content: legacyContext,
            timestamp: Date.now(),
          },
        ];
      }
    }

    // 0.16 E5：BeforeLlm 注入的消息按返回顺序写入上下文一次（进入本次请求，
    // 后续轮次直接从上下文可见；重复返回同一批消息不重复写入）。
    ctx.window.appendInjectedMessages(runId, hookCtx.messages);

    // 0.52：句柄失效 / 容量耗尽以**追加一张 env 卡**表达（append-only，不回改历史）。
    // 必须在组装请求**之前**：卡要进本次请求，UI 也读同一份 store（可见性对等）。
    await ctx.window.appendPiiDeadNotice?.();

    // tools-body-snapshot：工具面变化同样以追加一张 env 卡表达（scope `tools`）；
    // 请求 tools[] 本身保持会话快照不变。也在组装请求之前（卡进本次请求）。
    ctx.window.appendToolSurfaceNotice?.();

    // 组装本次请求的消息：system 只来自会话级基底（含 Self Card），
    // 不接受每轮拼接的 additionalContext（CONTRACT-prefix-invariant §2）。
    const messages = ctx.window.buildRequestMessages(baseSystemPrompt);

    // 工具来源：会话起点快照（ExecutionUnit.ensureToolPin；注册表仍是执行唯一真相）。
    const toolSchemas = ctx.tools.listToolSchemas();

    // §4：请求前检查 system / tools / messages 是否保持前缀；显式 reason 消费后清空。
    const requestSystem =
      messages.find((message) => message.role === 'system' && !message.compaction_summary)
        ?.content ?? '';
    const prefixReason = ctx.controls.takePrefixReason();
    ctx.controls.prefixGuard.check({
      sessionId,
      runId,
      system: requestSystem,
      tools: JSON.stringify(toolSchemas),
      messages,
      ...(prefixReason !== undefined ? { reason: prefixReason } : {}),
    });

    // 调用 LLM（context-overflow 时强制压缩一次并重试一次，0.10 R2-17）
    //
    // 0.57：请求发出的**这一刻**是 gap 的右端点 —— `gap` = 上一轮响应结束 → 这一次
    // 请求发出，正好是「用户感觉请求间隔变长」的那段时间。
    const requestStartedAt = Date.now();
    const gapMs =
      previousResponseAt !== undefined
        ? Math.max(0, requestStartedAt - previousResponseAt)
        : undefined;
    const response = await ctx.provider.chat({
      messages,
      tools: toolSchemas,
      sessionId,
      ...(ctx.controls.signal !== undefined ? { signal: ctx.controls.signal } : {}),
      rebuildMessages: () => ctx.window.buildRequestMessages(baseSystemPrompt),
      ...(beforeLlm.requestExtras !== undefined ? { requestExtras: beforeLlm.requestExtras } : {}),
    });
    const responseAt = Date.now();
    previousResponseAt = responseAt;
    // 一轮一条账：模型耗时（本次请求）+ 与上一轮之间的间隔（含上一轮工具耗时）。
    ctx.timing?.round({
      round,
      modelMs: responseAt - requestStartedAt,
      ...(gapMs !== undefined ? { gapMs } : {}),
      ...(previousToolCalls !== undefined ? { toolCalls: previousToolCalls } : {}),
      ...(previousToolsMs !== undefined ? { toolsMs: previousToolsMs } : {}),
    });
    ctx.timing?.note('llm_total', responseAt - requestStartedAt);

    // 更新 token 使用量
    let requestCost: number | undefined;
    if (response.usage) {
      ctx.controls.limitChecker.addTokens(
        stats,
        response.usage.prompt_tokens ?? 0,
        response.usage.completion_tokens ?? 0,
      );
      // CONTRACT-0.29 B1：缓存两项绕过 `addTokens`（`types/limits.ts` 的公开端口，
      // 签名不变）在这里直接累加；它们是 `prompt_tokens` 的**子集**，只做计数，
      // 不进 `inputTokens` / `totalTokens`（§1.2 禁止相加）。
      // 「未上报」用 `undefined` 保持缺省，一旦某轮上报过就持续累加。
      const cacheRead = response.usage.cache_read_input_tokens;
      if (cacheRead !== undefined) {
        stats.cacheReadTokens = (stats.cacheReadTokens ?? 0) + cacheRead;
      }
      const cacheCreation = response.usage.cache_creation_input_tokens;
      if (cacheCreation !== undefined) {
        stats.cacheCreationTokens = (stats.cacheCreationTokens ?? 0) + cacheCreation;
      }
      // Auto Compact：用**本次请求**的真实 token 数替代字符估算。
      // 不能用累计 stats.totalTokens——多轮会线性放大，第二轮就误触发 compact（C-04）。
      // 0.29 U1：`prompt_tokens` 已由 adapter 统一为「含缓存的全部输入」
      // （CONTRACT-0.29 §1），因此这里**不得**再加 cache_read / cache_creation
      // ——它们是 prompt_tokens 的子集，再加会重复计数（§5.1）。
      ctx.window.updateRealTokens(
        (response.usage.prompt_tokens ?? 0) + (response.usage.completion_tokens ?? 0),
      );
      // 0.51：按分项费率累计成本；无价格表 / 该模型未配置时不产生金额。
      requestCost = ctx.pricing?.costOf(ctx.model, response.usage);
      if (requestCost !== undefined) ctx.controls.limitChecker.addCost(stats, requestCost);
    }

    // 完成原因判定提前到 llm.response 发布之前：无感重试（seamless）丢弃的空轮
    // 不得落 durable transcript——投影会从 llm.response 重建空 assistant 轮（留疤）。
    // 0.6.1 P1：finish_reason 不可靠——存在实际 tool_calls 时优先继续工具轮，
    // 只有「无 tool_calls 且 stop」才视为终稿（对齐 Claude Code query.ts 的 tool_use 判定）。
    const toolCalls = response.tool_calls;
    const hasToolCalls = toolCalls !== undefined && toolCalls.length > 0;
    const blankResponse = !hasToolCalls && (response.content ?? '').trim().length === 0;

    // 无感重试（q-empty-response 二期，缺省开）：空响应时**丢弃空轮**——不发
    // llm.response、不写窗口，用已有一致 transcript（含上一个工具结果）原样重调
    // 模型（与无感 resume 同源：重入边界 = 事件投影一致，零注入零疤痕）。
    // 限次复用 max_retries；连续空耗尽后升级**一次** nudge 打破空模式（纯重调可能
    // 采样再吐空，nudge 是可靠性兜底；maxRetries=0 不升级，守「0=不重试」语义）；
    // 再空则 exhausted 回落原始终止。usage/timing 已在上方记账（请求真实发生）；
    // AfterLlm 照跑保持 Before/After 配对（hookCtx 不含响应对象，无内容泄漏）。
    if (blankResponse) {
      const policy = ctx.emptyResponse;
      const enabled = policy?.enabled !== false;
      const seamless = policy?.seamless !== false;
      const maxRetries = sanitizeEmptyResponseRetries(policy?.maxRetries);
      if (enabled && seamless) {
        if (seamlessRetries < maxRetries) {
          seamlessRetries += 1;
          emptyRetries += 1;
          ctx.events.emit({
            type: 'llm.empty_response',
            run_id: runId,
            data: {
              run_id: runId,
              session_id: sessionId,
              attempt: emptyRetries,
              max_retries: maxRetries,
              finish_reason: response.finish_reason,
              action: 'seamless',
            },
            ts: Date.now(),
          });
          await ctx.controls.hooks.run(HookType.AfterLlm, hookCtx);
          continue;
        }
        if (!nudgeEscalated && maxRetries > 0) {
          nudgeEscalated = true;
          emptyRetries += 1;
          ctx.events.emit({
            type: 'llm.empty_response',
            run_id: runId,
            data: {
              run_id: runId,
              session_id: sessionId,
              attempt: emptyRetries,
              max_retries: maxRetries,
              finish_reason: response.finish_reason,
              action: 'nudge',
              escalated: true,
            },
            ts: Date.now(),
          });
          // 升级 nudge 同样丢弃空轮（零疤痕）：只注入一条继续消息。走注入通道
          // （message.injected 落盘、resume 可重建、用户可见）；timestamp 保证
          // 每次注入的去重键不同。
          const nudge =
            typeof policy?.nudge === 'string' && policy.nudge.trim().length > 0
              ? policy.nudge
              : DEFAULT_EMPTY_RESPONSE_NUDGE;
          ctx.window.appendInjectedMessages(runId, [
            { role: 'user', name: 'vessel:notice', content: nudge, timestamp: Date.now() },
          ]);
          await ctx.controls.hooks.run(HookType.AfterLlm, hookCtx);
          continue;
        }
      }
    }

    // 0.18：reasoning 只写入会话事件日志（resume 需要），**不进入对外发布的事件**。
    // ADR-077：默认不把思维链发给 UI / trace；TUI 仅在 includeReasoning=true 时
    // 通过 `llm.stream.chunk` 的 reasoning_delta 展示。
    const publishedLlmData = {
      run_id: runId,
      session_id: sessionId,
      content: response.content,
      tool_calls: response.tool_calls,
      finish_reason: response.finish_reason,
      usage: response.usage,
      ...(requestCost !== undefined ? { cost: requestCost } : {}),
    };
    ctx.events.emit(
      {
        type: 'llm.response',
        run_id: runId,
        data: publishedLlmData,
        ts: Date.now(),
      },
      {
        persistData:
          response.reasoning_content !== undefined
            ? { ...publishedLlmData, reasoning: response.reasoning_content }
            : publishedLlmData,
      },
    );

    // 执行 AfterLlm 钩子
    await ctx.controls.hooks.run(HookType.AfterLlm, hookCtx);

    // 空响应兜底（q-empty-response）：走到这里的空响应 = 无感模式预算耗尽（含升级
    // nudge 后仍空），或非无感模式（seamless=false，一期 nudge 路径）。无感模式的
    // 丢弃/升级已在 llm.response 发布**前**处理（空轮不落 durable transcript）；
    // 此处空轮已落盘（llm.response 已发），nudge 路径须写回空 assistant 轮保持
    // live 窗口 ≡ 事件投影。工具调用路径与非空终稿不进本分支；finish_reason 语义
    // 不变。判定用模型原始输出（guardrail replacement 之前）。
    if (blankResponse) {
      const policy = ctx.emptyResponse;
      const enabled = policy?.enabled !== false;
      const seamless = policy?.seamless !== false;
      const maxRetries = sanitizeEmptyResponseRetries(policy?.maxRetries);
      if (enabled && !seamless && emptyRetries < maxRetries) {
        emptyRetries += 1;
        ctx.events.emit({
          type: 'llm.empty_response',
          run_id: runId,
          data: {
            run_id: runId,
            session_id: sessionId,
            attempt: emptyRetries,
            max_retries: maxRetries,
            finish_reason: response.finish_reason,
            action: 'nudge',
          },
          ts: Date.now(),
        });
        // 空 assistant 轮已是落盘事实（上方 llm.response 已持久化）：原样写回窗口，
        // 保持 live 窗口 ≡ 事件投影（resume 会从 llm.response 重建出同一空轮）；
        // thinking 模式同样需要 reasoning_content 供下一轮回传。
        ctx.window.addMessage(
          {
            role: 'assistant',
            content: response.content,
            ...(response.reasoning_content
              ? { reasoning_content: response.reasoning_content }
              : {}),
          },
          runId,
        );
        // nudge 走注入通道（message.injected 事件 + 上下文写）：用户可见、resume 可重建，
        // 不是只活在 live 窗口的私有消息。timestamp 保证每次 nudge 的注入去重键不同。
        const nudge =
          typeof policy?.nudge === 'string' && policy.nudge.trim().length > 0
            ? policy.nudge
            : DEFAULT_EMPTY_RESPONSE_NUDGE;
        ctx.window.appendInjectedMessages(runId, [
          { role: 'user', name: 'vessel:notice', content: nudge, timestamp: Date.now() },
        ]);
        continue;
      }
      if (enabled) {
        // 限次耗尽（或 maxRetries=0）：留痕后回落现行行为——空串仍按原路径返回，
        // 但不再静默（事件落盘，观察面 / 日志可见）。
        ctx.events.emit({
          type: 'llm.empty_response',
          run_id: runId,
          data: {
            run_id: runId,
            session_id: sessionId,
            attempt: emptyRetries,
            max_retries: maxRetries,
            finish_reason: response.finish_reason,
            action: 'exhausted',
          },
          ts: Date.now(),
        });
      }
      // enabled=false 或重试耗尽：落到下方原始终止路径（行为与修复前一致）。
    }

    if (!hasToolCalls && response.finish_reason === 'stop') {
      // 应用输出 Guardrail
      const outputResult = await ctx.controls.guardrails.apply(
        response.content,
        GuardrailStage.Output,
        runId,
        sessionId,
      );
      if (!outputResult.allowed) {
        throw new Error(`Output blocked by guardrail: ${outputResult.reason}`);
      }
      // replacement 生效：改写返回给调用方并持久化的助手文本（C-05）
      const finalContent =
        typeof outputResult.replacement === 'string' ? outputResult.replacement : response.content;

      // 添加助手消息到上下文（thinking 模式需保存 reasoning_content 供下一轮回传）
      ctx.window.addMessage(
        {
          role: 'assistant',
          content: finalContent,
          ...(response.reasoning_content ? { reasoning_content: response.reasoning_content } : {}),
        },
        runId,
      );

      return finalContent;
    }

    if (toolCalls && toolCalls.length > 0) {
      // 先对全部 tool_call 过 Guardrail，得到实际要执行的调用（replacement 可改写，C-05）。
      // 放在写 assistant 消息之前，保证上下文里的 tool_calls 与后续 role:tool 结果严格配对。
      // 阻断不再 throw（0.6.1 P1）：保留调用并折回 role:tool 错误，模型可改道。
      const effectiveCalls: ToolCall[] = [];
      const blockedCalls = new Map<string, string>();
      for (const toolCall of toolCalls) {
        ctx.controls.limitChecker.incrementToolCall(stats);
        const toolCallResult = await ctx.controls.guardrails.apply(
          toolCall,
          GuardrailStage.ToolCall,
          runId,
          sessionId,
        );
        if (!toolCallResult.allowed) {
          blockedCalls.set(
            toolCall.id,
            `Tool call blocked by guardrail: ${toolCallResult.reason ?? 'blocked'}`,
          );
          effectiveCalls.push(toolCall);
          continue;
        }
        effectiveCalls.push(
          isToolCall(toolCallResult.replacement) ? toolCallResult.replacement : toolCall,
        );
      }

      // 添加助手消息（包含实际执行的 tool_calls）到上下文；
      // thinking 模式必须带上 reasoning_content，下一次请求要原样回传
      ctx.window.addMessage(
        {
          role: 'assistant',
          content: response.content ?? '',
          tool_calls: effectiveCalls,
          ...(response.reasoning_content ? { reasoning_content: response.reasoning_content } : {}),
        },
        runId,
      );

      // 预处理工具调用：参数只解析一次（C-01）；guardrail 阻断/非法 JSON 走折回路径。
      const prepared: PreparedToolCall[] = effectiveCalls.map((toolCall) => {
        const toolName = toolCall.function.name;
        const blockedReason = blockedCalls.get(toolCall.id);
        let args: unknown = {};
        let failureMessage = blockedReason;
        if (blockedReason === undefined) {
          try {
            args = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {};
          } catch (error) {
            failureMessage = `Invalid JSON in tool arguments: ${
              error instanceof Error ? error.message : String(error)
            }`;
          }
        }

        // 发布工具调用开始事件
        ctx.events.emit({
          type: 'tool.call.started',
          run_id: runId,
          data: {
            run_id: runId,
            session_id: sessionId,
            tool_call_id: toolCall.id,
            tool_name: toolName,
            arguments: failureMessage !== undefined ? toolCall.function.arguments : args,
            // O4 additive：桥改写溯源（guardrail replacement 对象打标）；started 在 handler
            // 前发，transport 缺省（= in_process 旧语义），completed/failed 才带全量。
            ...(isBridgeCall(toolCall) ? { via_bridge: true } : {}),
          },
          ts: Date.now(),
        });

        return {
          toolCall,
          toolName,
          args,
          startedAt: Date.now(),
          ...(failureMessage !== undefined ? { failureMessage } : {}),
        };
      });

      // 执行工具调用：连续的 concurrencySafe 只读工具并批发车（0.6.1 P1），
      // 其余按原顺序串行；结果始终按原调用顺序写回上下文。
      // 0.14 P0：工具阶段的失败（含管道错误）按 tool 归类。
      ctx.execution.phase = 'tool';
      // 0.57：工具总耗时（含 BeforeTool/AfterTool hook 与结果闸）——它是 gap 的主要成分，
      // 单独记一笔才能把 gap 拆成「工具真在跑」与「我们中间那一段」。
      const toolsStartedAt = Date.now();
      let cursor = 0;
      while (cursor < prepared.length) {
        const first = prepared[cursor];
        if (!first) break;

        const batch: PreparedToolCall[] = [first];
        if (ctx.tools.isConcurrencySafe(first)) {
          let candidate = prepared[cursor + batch.length];
          while (candidate && ctx.tools.isConcurrencySafe(candidate)) {
            batch.push(candidate);
            candidate = prepared[cursor + batch.length];
          }
        }

        // BeforeTool 钩子逐调用串行执行，避免并行批次共享 hookCtx 的竞态。
        // 0.6.1 P2：hook 可读取 tool/input；block 折回 tool 错误，updatedInput 改写入参。
        for (const entry of batch) {
          if (entry.failureMessage !== undefined) continue;
          const hookResult = await ctx.controls.hooks.run(HookType.BeforeTool, {
            ...hookCtx,
            tool: entry.toolName,
            input: entry.args,
          });
          if (hookResult.block) {
            entry.failureMessage = `Tool call blocked by hook: ${hookResult.reason ?? 'blocked'}`;
            continue;
          }
          if (hookResult.updatedInput !== undefined) {
            entry.args = hookResult.updatedInput;
          }
        }

        const outcomes = await Promise.all(
          batch.map((entry) => ctx.tools.runToolCall(entry, ctx.controls.signal)),
        );

        // 上下文严格按原调用顺序写回（并行完成顺序不影响历史顺序）
        // q-media-view：本批工具结果附带的图片引用（已入池、带 sha256 的才算）。
        const attachedImages: MessageRef[] = [];
        const attachedFrom: string[] = [];
        for (const outcome of outcomes) {
          if (outcome.ok) {
            // 执行 AfterTool 钩子（0.6.1 P2：携带 tool/input）
            await ctx.controls.hooks.run(HookType.AfterTool, {
              ...hookCtx,
              tool: outcome.toolCall.function.name,
              input: outcome.input,
            });
          }
          // 0.56 P0：工具结果里疑似带 base64 图片 ⇒ 记一条信号（**只报警，不修**）。
          //
          // 位置在闸**之前**、用**原始**正文判：闸会按 token 裁切，把中间的 base64 切掉之后
          // 就检测不到了；而「这条结果里有 1.4 MB base64」正是要留证的事实。
          // 事件里只有类名与长度 —— base64 本身上下文字节数都不进事件（P0-07）。
          const suspect = detectBase64ImagePayload(outcome.content);
          if (suspect !== undefined) {
            ctx.events.emit({
              type: 'tool_result.base64_suspected',
              run_id: runId,
              data: {
                run_id: runId,
                session_id: sessionId,
                tool: outcome.toolCall.function.name,
                kind: suspect.kind,
                base64_chars: suspect.bytes,
                // 本地会把这段按字符计价（≈0.3/字符），而 provider 按图收 ≤1024 —— 差值留证。
                estimated_chars: outcome.content.length,
              },
              ts: Date.now(),
            });
          }
          ctx.window.addMessage(
            {
              role: 'tool',
              tool_call_id: outcome.toolCall.id,
              // 出口闸：所有插件工具的返回值都在这里收口（≤ 16k token；超了先落盘再
              // 头 30% / 尾 70% 裁切）。handler 自己裁过的（bounded）原样放行。
              //
              // 0.56：**图片 part 永不经过这道闸** —— 它不是文本，也不在 `content` 里
              // （图只在 `refs` / `attachment_plan`，到适配器才变成请求块）。闸的分母
              // （字符 / token）因此与图无关；这里也不需要「跳过图片」的特殊分支，
              // 因为「图变成字符串」这条路径本身被设计禁止（§6.3 禁止项 2）。
              content: await gateToolResult(outcome, sessionId),
            },
            runId,
          );
          // 注：不再注入假 assistant 消息（见 ADR-005 / Phase 1 review #3）
          // Provider 负责正确解释 role: tool 消息
          // q-media-view：收集附图引用。只 surfaced 已入池（带 sha256）的图 ——
          // 没入池的图一定不内联（plan 记 not_ingested），不为它注入一条撒谎的消息。
          for (const ref of outcome.refs ?? []) {
            if (ref.kind === 'image' && typeof ref.sha256 === 'string' && ref.sha256 !== '') {
              attachedImages.push(ref);
              attachedFrom.push(outcome.toolCall.function.name);
            }
          }
        }

        // q-media-view：本批工具结果全部写回后，追加一条带 refs 的 user 消息（既有注入
        // 通道：身份盖章 / message.injected 事件 / 落盘全复用）。为什么不挂在 role:'tool'
        // 消息上：OpenAI 兼容传输的 tool 消息 content 只能是字符串；user 消息附图是
        // 三家传输都支持的既有通路。为什么在整批之后：assistant(tool_calls) 与它的 tool
        // 响应之间不插别的角色消息。追加在末尾 ⇒ 前缀守卫天然满足。
        if (attachedImages.length > 0) {
          const refs = attachedImages.slice(0, MESSAGE_REFS_MAX);
          ctx.window.appendInjectedMessages(runId, [
            {
              role: 'user',
              content: toolImageAttachmentNote(
                refs,
                attachedFrom,
                attachedImages.length - refs.length,
              ),
              refs,
            },
          ]);
        }

        cursor += batch.length;
      }

      // durable 安全点：本轮 tool-call 结果已全部写入上下文
      await ctx.controls.onSafePoint();
      // 0.57：本轮的「工具账」留给下一轮的 gap 行（gap 覆盖的正是这段时间）。
      previousToolsMs = Date.now() - toolsStartedAt;
      previousToolCalls = effectiveCalls.length;
      ctx.timing?.note('tools', previousToolsMs);
    } else {
      // 其他完成原因（如 length），直接返回当前内容
      ctx.window.addMessage(
        {
          role: 'assistant',
          content: response.content,
          ...(response.reasoning_content ? { reasoning_content: response.reasoning_content } : {}),
        },
        runId,
      );
      return response.content;
    }
  }
}
