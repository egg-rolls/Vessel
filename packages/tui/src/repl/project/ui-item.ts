/**
 * UI item 投影（0.18 Track B 的唯一投影模块）
 * @module @vessel-agent/tui
 *
 * PLAN-0.17 §4.2 / §4.3 的冻结形状：`UiItem` 是 TUI history 的唯一类型，
 * `ToolCallView` 是工具卡的唯一模型。本模块是**纯函数**，数据源集中在
 * `projectUiItems(source)`：当前 `source.events`（EventStream / trace 回放）与
 * `source.messages`（resume 的 session messages）；Phase 1 事件日志合入后只改这一处。
 *
 * 显示字符串（title / subtitle / text / detail）在投影边界统一
 * `sanitizeTerminalText()`；原始事件载荷不被改写。
 */

import type { ErrorCategory, ErrorEnvelope, ErrorPhase } from '@vessel-agent/core';
import type { SessionMessageLike } from '../../commands/sessions-command.js';
import { toolDisplayRegistry } from '../../components/ToolDisplay.js';
import { t } from '../../i18n/index.js';
import {
  asTuiEvent,
  type RunEventLike,
  type TuiEvent,
  type TuiUnknownEvent,
} from '../../types/events.js';
import { formatTokenCount, shortSessionId } from '../../utils/display-labels.js';
import { sanitizeTerminalText } from '../../utils/sanitize-terminal-text.js';

export type ToolCallStatus = 'running' | 'completed' | 'failed';

/** 工具卡唯一模型（PLAN §4.2 字段冻结） */
export interface ToolCallView {
  id: string;
  name: string;
  args: unknown;
  status: ToolCallStatus;
  /** 由 ToolDisplayDefinition.toView() 产出 */
  title: string;
  /** bash command / read/edit path */
  subtitle?: string;
  /** 完整原文；渲染时裁剪（默认 3 行，Ctrl+O 取回全文） */
  result?: string;
  error?: string;
  errorEnvelope?: ErrorEnvelope;
  durationMs?: number;
  permission?: { requestId: string; decision: 'allow' | 'deny' | 'always'; at: number };
  truncated?: { chars: number; lines: number; fullRef: string };
}

/** 权限项的决定；pending 只存在于请求到应答之间的历史项 */
export type PermissionDecision = 'pending' | 'allow' | 'deny' | 'always';

export interface RunUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  total_cost?: number;
}

/** TUI history 的唯一类型（PLAN §4.3 字段冻结） */
export type UiItem =
  | { kind: 'user'; id: string; text: string; at: number }
  | { kind: 'assistant'; id: string; text: string; at: number; streaming?: boolean }
  | { kind: 'reasoning'; id: string; text: string; ms?: number }
  | { kind: 'tool'; id: string; view: ToolCallView }
  | {
      kind: 'permission';
      id: string;
      requestId: string;
      tool: string;
      decision: PermissionDecision;
      at: number;
      actor?: string;
    }
  | {
      kind: 'agent';
      id: string;
      agentId: string;
      state: string;
      task?: string;
      children?: UiItem[];
    }
  | {
      kind: 'notice';
      id: string;
      level: 'info' | 'warn' | 'danger';
      text: string;
      detail?: string;
    }
  | { kind: 'error'; id: string; envelope?: ErrorEnvelope; text: string }
  | {
      kind: 'run';
      id: string;
      runId: string;
      status: 'completed' | 'failed' | 'cancelled';
      usage?: RunUsage;
      durationMs?: number;
      toolCount: number;
    }
  | { kind: 'command'; id: string; text: string; output?: string; tone?: 'brand' | 'normal' };

/** 工具结果默认展示行数；超出时渲染折叠提示，Ctrl+O 取回全文 */
export const TOOL_RESULT_PREVIEW_LINES = 3;

/** 投影折叠状态（纯数据；`reduceUiProjection` 不可变推进） */
export interface UiProjectionState {
  items: UiItem[];
  seq: number;
  runId?: string;
  runStartedAt?: number;
  runToolCount: number;
  /** 正在流式追加的 assistant / reasoning item */
  assistantId?: string;
  reasoningId?: string;
  reasoningStartedAt?: number;
  /** tool_call_id -> UiItem.id */
  toolItemIds: Readonly<Record<string, string>>;
  /** requestId -> UiItem.id */
  permissionItemIds: Readonly<Record<string, string>>;
  /** agent_id -> UiItem.id */
  agentItemIds: Readonly<Record<string, string>>;
}

export function createUiProjection(): UiProjectionState {
  return {
    items: [],
    seq: 0,
    runToolCount: 0,
    toolItemIds: {},
    permissionItemIds: {},
    agentItemIds: {},
  };
}

/** 清空当前轮内容；保留 seq 让同一进程内 item id 单调 */
export function resetUiProjection(state: UiProjectionState): UiProjectionState {
  return { ...createUiProjection(), seq: state.seq };
}

function nextId(state: UiProjectionState, prefix: string): { id: string; seq: number } {
  const seq = state.seq + 1;
  return { id: `${prefix}_${seq}`, seq };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safe(value: unknown): string {
  return typeof value === 'string' ? sanitizeTerminalText(value) : '';
}

function readString(data: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function readNumber(data: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

const ERROR_CATEGORIES: ReadonlySet<string> = new Set([
  'provider',
  'tool',
  'permission',
  'config',
  'gateway',
  'internal',
]);

const ERROR_PHASES: ReadonlySet<string> = new Set([
  'input',
  'llm',
  'tool',
  'permission',
  'finalize',
  'checkpoint',
  'shutdown',
  'run',
]);

/** 从事件 payload 的 additive envelope 字段构造 ErrorEnvelope（缺 error_code 时返回 undefined） */
export function readErrorEnvelope(
  data: Record<string, unknown>,
  fallback: { category: ErrorCategory; phase: ErrorPhase },
): ErrorEnvelope | undefined {
  const code = readString(data, 'error_code');
  if (code === undefined) return undefined;
  const category = readString(data, 'category');
  const phase = readString(data, 'phase');
  const httpStatus = readNumber(data, 'http_status');
  const details = isRecord(data.details) ? data.details : undefined;
  return {
    error_code: code,
    category:
      category !== undefined && ERROR_CATEGORIES.has(category)
        ? (category as ErrorCategory)
        : fallback.category,
    phase: phase !== undefined && ERROR_PHASES.has(phase) ? (phase as ErrorPhase) : fallback.phase,
    retryable: data.retryable === true,
    ...(httpStatus !== undefined ? { http_status: httpStatus } : {}),
    ...(details !== undefined ? { details } : {}),
  };
}

function readUsage(data: Record<string, unknown>): RunUsage | undefined {
  const raw = data.usage;
  if (!isRecord(raw)) return undefined;
  const usage: RunUsage = {};
  const prompt = readNumber(raw, 'prompt_tokens', 'promptTokens');
  const completion = readNumber(raw, 'completion_tokens', 'completionTokens');
  const total = readNumber(raw, 'total_tokens', 'totalTokens');
  const cost = readNumber(raw, 'total_cost', 'totalCost');
  if (prompt !== undefined) usage.prompt_tokens = prompt;
  if (completion !== undefined) usage.completion_tokens = completion;
  if (total !== undefined) usage.total_tokens = total;
  if (cost !== undefined) usage.total_cost = cost;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** 工具结果超过预览行数时标记可展开（原文仍完整保存在 view.result） */
function withTruncation(view: ToolCallView): ToolCallView {
  if (view.result === undefined) return view;
  const lines = view.result.split('\n').length;
  if (lines <= TOOL_RESULT_PREVIEW_LINES) return view;
  return {
    ...view,
    truncated: { chars: view.result.length, lines, fullRef: `tool:${view.id}` },
  };
}

function makeToolView(
  name: string,
  id: string,
  args: unknown,
  result: string | undefined,
  status: ToolCallStatus,
): ToolCallView {
  const view = toolDisplayRegistry.view(name, args, result, status);
  return withTruncation({ ...view, id, name, args, status });
}

/** 回退视图用 core 的固定失败前缀判断 */
function toolStatusFromContent(content: string | undefined): ToolCallStatus {
  return content?.startsWith('Error: ') ? 'failed' : 'completed';
}

/**
 * 0.27：`run.*` 同时承载成员 body 的执行生命周期。`data.agent_id` 命中已建条的
 * agent item 时只更新该成员状态；主 agent 的 run 返回 undefined，继续走 run 摘要分支。
 */
function reduceAgentRunItem(
  state: UiProjectionState,
  data: Record<string, unknown>,
  next: string,
): UiProjectionState | undefined {
  const agentId = readString(data, 'agent_id', 'agentId');
  if (agentId === undefined) return undefined;
  const itemId = state.agentItemIds[agentId];
  if (itemId === undefined) return undefined;
  return updateItem(state, itemId, (item) =>
    item.kind === 'agent' ? { ...item, state: next } : item,
  );
}

function updateItem(
  state: UiProjectionState,
  id: string,
  update: (item: UiItem) => UiItem,
): UiProjectionState {
  const index = state.items.findIndex((item) => item.id === id);
  if (index < 0) return state;
  const current = state.items[index];
  if (current === undefined) return state;
  const next = [...state.items];
  next[index] = update(current);
  return { ...state, items: next };
}

/** 关闭流式 reasoning：补上耗时 */
function closeReasoning(state: UiProjectionState, ts: number): UiProjectionState {
  if (state.reasoningId === undefined) return state;
  const id = state.reasoningId;
  const started = state.reasoningStartedAt;
  const ms = started !== undefined && ts >= started ? ts - started : undefined;
  return {
    ...updateItem(state, id, (item) =>
      item.kind === 'reasoning' ? { ...item, ...(ms !== undefined ? { ms } : {}) } : item,
    ),
    reasoningId: undefined,
    reasoningStartedAt: undefined,
  };
}

/** 关闭流式 assistant：撤销 streaming 标记 */
function closeAssistant(state: UiProjectionState): UiProjectionState {
  if (state.assistantId === undefined) return state;
  const id = state.assistantId;
  return {
    ...updateItem(state, id, (item) =>
      item.kind === 'assistant' ? { ...item, streaming: false } : item,
    ),
    assistantId: undefined,
  };
}

/** 中断/失败终态携带的半截 assistant 文本（事件日志无 llm.stream.chunk） */
function appendPartialAssistant(
  state: UiProjectionState,
  ts: number,
  partial: string | undefined,
): UiProjectionState {
  if (partial === undefined) return state;
  const text = safe(partial);
  if (!text) return state;
  const { id, seq } = nextId(state, 'assistant');
  return {
    ...state,
    seq,
    items: [...state.items, { kind: 'assistant', id, text, at: ts }],
  };
}

/** 找到仍在运行、且工具名匹配的最新 tool item（permission.request 不带 tool_call_id） */
function findRunningToolId(state: UiProjectionState, toolName: string): string | undefined {
  for (let index = state.items.length - 1; index >= 0; index--) {
    const item = state.items[index];
    if (item?.kind === 'tool' && item.view.status === 'running' && item.view.name === toolName) {
      return item.id;
    }
  }
  return undefined;
}

/** budget 数值：显式 null 表示不限，缺失记 `?` */
function budgetLimit(value: unknown): number | string {
  if (value === null) return t('item.budgetUnlimited');
  return typeof value === 'number' && Number.isFinite(value) ? value : '?';
}

/** team.budget.* 未进 `TuiEvent` union，按原始 eventType 投影为 notice */
function budgetNotice(
  event: TuiUnknownEvent,
): Pick<Extract<UiItem, { kind: 'notice' }>, 'level' | 'text'> | undefined {
  const data = event.data;
  const conversation = shortSessionId(safe(readString(data, 'conversation_id') ?? ''), 12);
  const dimension = safe(data.dimension) || '?';
  const current = readNumber(data, 'current') ?? '?';
  switch (event.eventType) {
    case 'team.budget.warning':
      return {
        level: 'warn',
        text: t('item.budgetWarning', {
          dimension,
          current,
          max: budgetLimit(data.max),
          conversation,
        }),
      };
    case 'team.budget.blocked':
      return {
        level: 'danger',
        text: t('item.budgetBlocked', {
          dimension,
          current,
          max: budgetLimit(data.max),
          reason: safe(data.reason) || '?',
          conversation,
        }),
      };
    case 'team.budget.override':
      return {
        level: 'info',
        text: t('item.budgetOverride', {
          dimension,
          previous_max: budgetLimit(data.previous_max),
          max: budgetLimit(data.max),
          conversation,
        }),
      };
    default:
      return undefined;
  }
}

/** 纯 reducer：折叠单个事件（不可变） */
export function reduceUiProjection(
  state: UiProjectionState,
  event: TuiEvent | TuiUnknownEvent,
): UiProjectionState {
  switch (event.type) {
    case 'run.started':
    case 'run.resumed': {
      // 0.27：成员 body 的 run 生命周期也是 `run.*`，用 `agent_id` 归属到已建条的
      // agent item（主 agent 的 run 不属于任何成员 item，继续走下面的通用分支）。
      const memberItem = reduceAgentRunItem(state, event.data, 'running');
      if (memberItem !== undefined) return memberItem;
      return {
        ...state,
        runId: event.run_id,
        runStartedAt: event.ts > 0 ? event.ts : state.runStartedAt,
        runToolCount: 0,
        assistantId: undefined,
        reasoningId: undefined,
        reasoningStartedAt: undefined,
      };
    }

    case 'user.message': {
      const message = isRecord(event.data.message) ? event.data.message : undefined;
      if (message?.role !== 'user') return state;
      const text = safe(message.content);
      if (!text) return state;
      let next = closeReasoning(state, event.ts);
      next = closeAssistant(next);
      const { id, seq } = nextId(next, 'user');
      return {
        ...next,
        seq,
        items: [...next.items, { kind: 'user', id, text, at: event.ts }],
      };
    }

    case 'llm.response': {
      // 事件日志没有 llm.stream.chunk；assistant 文本来自持久化的 llm.response。
      // 已流式显示过的正文 / 思考不再追加，避免 live + 持久化各一份。
      const streamedText = state.assistantId !== undefined;
      const streamedReasoning = state.reasoningId !== undefined;
      let next = closeReasoning(state, event.ts);
      next = closeAssistant(next);
      const reasoning = readString(event.data, 'reasoning');
      if (reasoning !== undefined && !streamedReasoning) {
        const text = safe(reasoning);
        if (text) {
          const { id, seq } = nextId(next, 'reasoning');
          next = {
            ...next,
            seq,
            items: [...next.items, { kind: 'reasoning', id, text }],
          };
        }
      }
      const content = readString(event.data, 'content');
      if (content !== undefined && !streamedText) {
        const text = safe(content);
        if (text) {
          const { id, seq } = nextId(next, 'assistant');
          next = {
            ...next,
            seq,
            items: [...next.items, { kind: 'assistant', id, text, at: event.ts }],
          };
        }
      }
      return next;
    }

    case 'llm.stream.chunk': {
      const chunk = event.data.chunk as { type?: string; delta?: string };
      const delta = typeof chunk?.delta === 'string' ? chunk.delta : '';
      if (!delta) return state;

      if (chunk.type === 'reasoning_delta') {
        const text = sanitizeTerminalText(delta);
        if (state.reasoningId !== undefined) {
          return updateItem(state, state.reasoningId, (item) =>
            item.kind === 'reasoning' ? { ...item, text: item.text + text } : item,
          );
        }
        const { id, seq } = nextId(state, 'reasoning');
        return {
          ...state,
          seq,
          reasoningId: id,
          reasoningStartedAt: event.ts > 0 ? event.ts : undefined,
          items: [...state.items, { kind: 'reasoning', id, text }],
        };
      }

      if (chunk.type !== 'text_delta') return state;
      const text = sanitizeTerminalText(delta);
      let next = closeReasoning(state, event.ts);
      if (next.assistantId !== undefined) {
        return updateItem(next, next.assistantId, (item) =>
          item.kind === 'assistant' ? { ...item, text: item.text + text } : item,
        );
      }
      const { id, seq } = nextId(next, 'assistant');
      next = {
        ...next,
        seq,
        assistantId: id,
        items: [...next.items, { kind: 'assistant', id, text, at: event.ts, streaming: true }],
      };
      return next;
    }

    case 'tool.call.started': {
      const data = event.data;
      // closeAssistant 收尾流式 item（清 streaming 标记），不只是丢引用。
      const base = closeAssistant(state);
      const { id, seq } = nextId(base, 'tool');
      const view = makeToolView(
        data.tool_name,
        data.tool_call_id,
        data.arguments,
        undefined,
        'running',
      );
      return {
        ...base,
        seq,
        runToolCount: state.runToolCount + 1,
        toolItemIds: { ...state.toolItemIds, [data.tool_call_id]: id },
        items: [...base.items, { kind: 'tool', id, view }],
      };
    }

    case 'tool.call.completed': {
      const data = event.data;
      const itemId = state.toolItemIds[data.tool_call_id];
      if (itemId === undefined) {
        // 事件从中间开始（trace 裁剪）：仍然补一张完成卡，不丢结果。
        const { id, seq } = nextId(state, 'tool');
        const view = makeToolView(
          data.tool_name,
          data.tool_call_id,
          undefined,
          safe(data.result),
          'completed',
        );
        return {
          ...state,
          seq,
          runToolCount: state.runToolCount + 1,
          items: [
            ...state.items,
            {
              kind: 'tool',
              id,
              view: { ...view, durationMs: readNumber(data, 'duration_ms') },
            },
          ],
        };
      }
      return updateItem(state, itemId, (item) =>
        item.kind === 'tool'
          ? {
              ...item,
              view: withTruncation({
                ...item.view,
                status: 'completed',
                result: safe(data.result),
                durationMs: readNumber(data, 'duration_ms'),
              }),
            }
          : item,
      );
    }

    case 'tool.call.failed': {
      const data = event.data;
      const envelope = readErrorEnvelope(data, { category: 'tool', phase: 'tool' });
      const update = (item: UiItem): UiItem =>
        item.kind === 'tool'
          ? {
              ...item,
              view: {
                ...item.view,
                status: 'failed',
                error: safe(data.error),
                durationMs: readNumber(data, 'duration_ms'),
                ...(envelope !== undefined ? { errorEnvelope: envelope } : {}),
              },
            }
          : item;
      const itemId = state.toolItemIds[data.tool_call_id];
      if (itemId !== undefined) return updateItem(state, itemId, update);
      const { id, seq } = nextId(state, 'tool');
      const view = update({
        kind: 'tool',
        id,
        view: makeToolView(data.tool_name, data.tool_call_id, undefined, undefined, 'running'),
      });
      return {
        ...state,
        seq,
        runToolCount: state.runToolCount + 1,
        items: [...state.items, view as Extract<UiItem, { kind: 'tool' }>],
      };
    }

    case 'tool.permission.request': {
      const { id, seq } = nextId(state, 'permission');
      return {
        ...state,
        seq,
        permissionItemIds: {
          ...state.permissionItemIds,
          [event.data.requestId]: id,
        },
        items: [
          ...state.items,
          {
            kind: 'permission',
            id,
            requestId: event.data.requestId,
            tool: event.data.tool,
            decision: 'pending',
            at: event.ts,
          },
        ],
      };
    }

    case 'tool.permission.response': {
      const decision: 'allow' | 'deny' | 'always' =
        event.data.remember === true
          ? 'always'
          : event.data.decision === 'allow'
            ? 'allow'
            : 'deny';
      const itemId = state.permissionItemIds[event.data.requestId];
      let next = state;
      if (itemId !== undefined) {
        next = updateItem(state, itemId, (item) =>
          item.kind === 'permission' ? { ...item, decision } : item,
        );
      }
      const tool = next.items.find(
        (item) => item.kind === 'permission' && item.requestId === event.data.requestId,
      );
      if (tool?.kind === 'permission') {
        const runningId = findRunningToolId(next, tool.tool);
        if (runningId !== undefined) {
          next = updateItem(next, runningId, (item) =>
            item.kind === 'tool'
              ? {
                  ...item,
                  view: {
                    ...item.view,
                    permission: { requestId: event.data.requestId, decision, at: event.ts },
                  },
                }
              : item,
          );
        }
      }
      return next;
    }

    case 'guardrail.blocked': {
      const { id, seq } = nextId(state, 'notice');
      return {
        ...state,
        seq,
        items: [
          ...state.items,
          {
            kind: 'notice',
            id,
            level: 'warn',
            text: t('item.guardrail', {
              name: safe(event.data.guardrail_name),
              stage: safe(event.data.stage),
            }),
            detail: safe(event.data.reason),
          },
        ],
      };
    }

    case 'limit.blocked': {
      const { id, seq } = nextId(state, 'notice');
      const data = event.data;
      const detail = [readString(data, 'hint'), readString(data, 'source')]
        .filter((part): part is string => part !== undefined)
        .map(safe)
        .join(' · ');
      return {
        ...state,
        seq,
        items: [
          ...state.items,
          {
            kind: 'notice',
            id,
            level: 'danger',
            text: t('item.limitBlocked', {
              scope: safe(data.scope) || 'limit',
              key: safe(data.key) || safe(data.error_code) || 'limit',
              current: readNumber(data, 'current') ?? '?',
              max: readNumber(data, 'max') ?? '?',
            }),
            ...(detail ? { detail } : {}),
          },
        ],
      };
    }

    case 'context.pressure': {
      const { id, seq } = nextId(state, 'notice');
      const used = readNumber(event.data, 'used');
      const max = readNumber(event.data, 'max');
      const ratio = readNumber(event.data, 'ratio');
      const percent =
        ratio !== undefined
          ? Math.round(ratio * 100)
          : used !== undefined && max !== undefined && max > 0
            ? Math.round((used / max) * 100)
            : undefined;
      return {
        ...state,
        seq,
        items: [
          ...state.items,
          {
            kind: 'notice',
            id,
            level: 'warn',
            text: t('item.contextPressure', {
              percent: percent ?? '?',
              used: used !== undefined ? formatTokenCount(used) : '?',
              max: max !== undefined ? formatTokenCount(max) : '?',
            }),
          },
        ],
      };
    }

    case 'context.compacted': {
      const { id, seq } = nextId(state, 'notice');
      return {
        ...state,
        seq,
        items: [
          ...state.items,
          {
            kind: 'notice',
            id,
            level: 'info',
            text: t('item.compacted', {
              removed: readNumber(event.data, 'removed') ?? 0,
              remaining: readNumber(event.data, 'remaining') ?? 0,
              reason: safe(event.data.reason) || 'auto',
            }),
          },
        ],
      };
    }

    case 'agent.limit.warning': {
      const { id, seq } = nextId(state, 'notice');
      return {
        ...state,
        seq,
        items: [
          ...state.items,
          {
            kind: 'notice',
            id,
            level: 'warn',
            text: t('item.limitWarning', {
              key: safe(event.data.key) || 'limit',
              current: readNumber(event.data, 'current') ?? '?',
              max: readNumber(event.data, 'max') ?? '?',
            }),
          },
        ],
      };
    }

    case 'agent.rotating':
    case 'agent.rotated': {
      const { id, seq } = nextId(state, 'notice');
      const data = event.data;
      const from = shortSessionId(readString(data, 'from_session_id') ?? '', 12);
      const to = shortSessionId(readString(data, 'to_session_id') ?? '', 12);
      const epoch = readNumber(data, 'epoch');
      const text =
        event.type === 'agent.rotating'
          ? t('item.rotating', { from: from || '?', to: to || '?' })
          : t('item.rotated', { from: from || '?', to: to || '?', epoch: epoch ?? '?' });
      return {
        ...state,
        seq,
        items: [...state.items, { kind: 'notice', id, level: 'info', text }],
      };
    }

    case 'ask.user.requested': {
      const { id, seq } = nextId(state, 'notice');
      return {
        ...state,
        seq,
        items: [
          ...state.items,
          {
            kind: 'notice',
            id,
            level: 'info',
            text: t('item.ask', { count: event.data.questions.length }),
          },
        ],
      };
    }

    case 'agent.spawned':
    case 'agent.message.queued':
    case 'agent.message.sent':
    case 'agent.closed':
    case 'agent.stale':
    case 'agent.permission.requested':
    case 'agent.permission.responded':
    case 'agent.queue.entered':
    case 'agent.queue.left': {
      const data = event.data;
      const agentId =
        readString(data, 'agent_id', 'agentId', 'delegate_id', 'delegateId') ?? event.run_id;
      const stateOf = readString(data, 'state');
      const task = readString(data, 'task', 'prompt');
      const existingId = state.agentItemIds[agentId];
      const nextState: string =
        event.type === 'agent.closed'
          ? 'closed'
          : event.type === 'agent.stale'
            ? 'stale'
            : event.type === 'agent.permission.requested'
              ? 'waiting_permission'
              : (stateOf ?? 'idle');

      if (existingId !== undefined) {
        return updateItem(state, existingId, (item) =>
          item.kind === 'agent'
            ? {
                ...item,
                state: nextState,
                ...(task !== undefined && item.task === undefined ? { task: safe(task) } : {}),
              }
            : item,
        );
      }
      if (event.type !== 'agent.spawned') return state;
      const { id, seq } = nextId(state, 'agent');
      return {
        ...state,
        seq,
        agentItemIds: { ...state.agentItemIds, [agentId]: id },
        items: [
          ...state.items,
          {
            kind: 'agent',
            id,
            agentId,
            state: nextState,
            ...(task !== undefined ? { task: safe(task) } : {}),
          },
        ],
      };
    }

    case 'run.completed': {
      const member = reduceAgentRunItem(state, event.data, 'completed');
      if (member !== undefined) return member;
      let next = closeReasoning(state, event.ts);
      next = closeAssistant(next);
      const { id, seq } = nextId(next, 'run');
      const usage = readUsage(event.data);
      return {
        ...next,
        seq,
        runId: undefined,
        runStartedAt: undefined,
        items: [
          ...next.items,
          {
            kind: 'run',
            id,
            runId: event.run_id,
            status: 'completed',
            ...(usage !== undefined ? { usage } : {}),
            ...(readNumber(event.data, 'duration_ms') !== undefined
              ? { durationMs: readNumber(event.data, 'duration_ms') }
              : {}),
            toolCount: next.runToolCount,
          },
        ],
      };
    }

    case 'run.failed': {
      const member = reduceAgentRunItem(state, event.data, 'failed');
      if (member !== undefined) return member;
      // 已流出的半截正文不再用 partial_content 追加（否则重复）。
      const streamedText = state.assistantId !== undefined;
      let next = closeReasoning(state, event.ts);
      next = closeAssistant(next);
      if (!streamedText) {
        next = appendPartialAssistant(next, event.ts, readString(event.data, 'partial_content'));
      }
      const envelope = readErrorEnvelope(event.data, { category: 'internal', phase: 'run' });
      const { id: errorId, seq: errorSeq } = nextId(next, 'error');
      next = {
        ...next,
        seq: errorSeq,
        items: [
          ...next.items,
          {
            kind: 'error',
            id: errorId,
            text: safe(event.data.error) || t('item.errorUnknown'),
            ...(envelope !== undefined ? { envelope } : {}),
          },
        ],
      };
      const { id, seq } = nextId(next, 'run');
      const usage = readUsage(event.data);
      return {
        ...next,
        seq,
        runId: undefined,
        runStartedAt: undefined,
        items: [
          ...next.items,
          {
            kind: 'run',
            id,
            runId: event.run_id,
            status: 'failed',
            ...(usage !== undefined ? { usage } : {}),
            ...(readNumber(event.data, 'duration_ms') !== undefined
              ? { durationMs: readNumber(event.data, 'duration_ms') }
              : {}),
            toolCount: next.runToolCount,
          },
        ],
      };
    }

    case 'run.cancelled': {
      const member = reduceAgentRunItem(state, event.data, 'cancelled');
      if (member !== undefined) return member;
      // 已流出的半截正文不再用 partial_content 追加（否则重复）。
      const streamedText = state.assistantId !== undefined;
      let next = closeReasoning(state, event.ts);
      next = closeAssistant(next);
      if (!streamedText) {
        next = appendPartialAssistant(next, event.ts, readString(event.data, 'partial_content'));
      }
      const { id, seq } = nextId(next, 'run');
      return {
        ...next,
        seq,
        runId: undefined,
        runStartedAt: undefined,
        items: [
          ...next.items,
          {
            kind: 'run',
            id,
            runId: event.run_id,
            status: 'cancelled',
            ...(readNumber(event.data, 'duration_ms') !== undefined
              ? { durationMs: readNumber(event.data, 'duration_ms') }
              : {}),
            toolCount: next.runToolCount,
          },
        ],
      };
    }

    case 'update.available':
    case 'ask.user.answered':
      return state;

    case 'unknown': {
      const notice = budgetNotice(event);
      if (notice === undefined) return state;
      const { id, seq } = nextId(state, 'notice');
      return { ...state, seq, items: [...state.items, { kind: 'notice', id, ...notice }] };
    }
  }
}

// ── resume：session messages -> UiItem ─────────────

function parseToolArguments(raw: string | undefined): unknown {
  if (raw === undefined || raw.trim() === '') return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/**
 * 纯函数：把 session messages 投影为 UiItem（resume / 旧数据）。
 * assistant.tool_calls 与后续 tool 消息配对成完整工具卡；找不到结果时仍保留调用。
 */
export function projectMessagesToUiItems(
  messages: readonly SessionMessageLike[],
  options: { showReasoning?: boolean } = {},
): UiItem[] {
  const items: UiItem[] = [];
  let seq = 0;
  const next = (prefix: string): string => {
    seq += 1;
    return `${prefix}_${seq}`;
  };
  const toolResults = new Map<string, { content: string; name?: string }>();
  const pairedToolCalls = new Set<string>();
  for (const message of messages) {
    if (message.role === 'tool' && message.tool_call_id) {
      toolResults.set(message.tool_call_id, {
        content: message.content,
        ...(message.name !== undefined ? { name: message.name } : {}),
      });
    }
    if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) {
        if (call.id !== undefined) pairedToolCalls.add(call.id);
      }
    }
  }

  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      // 已被 assistant.tool_calls 配对的消息不再单独成项
      if (message.tool_call_id !== undefined && pairedToolCalls.has(message.tool_call_id)) continue;
      const name = message.name ?? 'tool';
      const view = makeToolView(
        name,
        message.tool_call_id ?? next('tool'),
        undefined,
        safe(message.content),
        toolStatusFromContent(message.content),
      );
      items.push({ kind: 'tool', id: next('tool'), view });
      continue;
    }
    if (message.role === 'user') {
      items.push({
        kind: 'user',
        id: next('user'),
        text: sanitizeTerminalText(message.content),
        at: 0,
      });
      continue;
    }

    if (options.showReasoning === true && message.reasoning_content?.trim()) {
      items.push({
        kind: 'reasoning',
        id: next('reasoning'),
        text: sanitizeTerminalText(message.reasoning_content),
      });
    }
    if (message.content) {
      items.push({
        kind: 'assistant',
        id: next('assistant'),
        text: sanitizeTerminalText(message.content),
        at: 0,
      });
    }
    for (const call of message.tool_calls ?? []) {
      const name = call.function?.name ?? 'tool';
      const result = call.id !== undefined ? toolResults.get(call.id) : undefined;
      const view = makeToolView(
        result?.name ?? name,
        call.id ?? next('tool'),
        parseToolArguments(call.function?.arguments),
        result !== undefined ? safe(result.content) : undefined,
        toolStatusFromContent(result?.content),
      );
      items.push({ kind: 'tool', id: next('tool'), view });
    }
  }
  return items;
}

export interface UiProjectionSource {
  /** 当前数据源：EventStream / trace 回放 / 会话事件日志记录 */
  events?: readonly RunEventLike[];
  /** 当前数据源：resume 的 session messages */
  messages?: readonly SessionMessageLike[];
  showReasoning?: boolean;
}

/**
 * 纯函数：投影入口。数据源切换只改这里（事件日志 / EventStream / messages）。
 */
export function projectUiItems(source: UiProjectionSource): UiItem[] {
  let state = createUiProjection();
  for (const raw of source.events ?? []) {
    state = reduceUiProjection(state, asTuiEvent(raw));
  }
  // reasoning 只在显式开启时进入历史（事件日志的 llm.response 总是带 reasoning）。
  const items =
    source.showReasoning === true
      ? [...state.items]
      : state.items.filter((item) => item.kind !== 'reasoning');
  if (source.messages !== undefined && source.messages.length > 0) {
    items.push(
      ...projectMessagesToUiItems(source.messages, {
        showReasoning: source.showReasoning === true,
      }),
    );
  }
  return items;
}

// ── 完整载荷（Ctrl+O pager） ─────────────────────

/** 纯函数：取出某个 item 的完整载荷文本（不截断）；未知类型返回 undefined。 */
export function fullTextOfItem(item: UiItem): string | undefined {
  switch (item.kind) {
    case 'user':
    case 'assistant':
    case 'reasoning':
    case 'notice':
      return [item.text, item.kind === 'notice' ? item.detail : undefined]
        .filter((part): part is string => part !== undefined && part.length > 0)
        .join('\n');
    case 'tool': {
      const view = item.view;
      const args =
        view.args === undefined
          ? ''
          : typeof view.args === 'string'
            ? view.args
            : JSON.stringify(view.args, null, 2);
      return [
        `${view.title}${view.subtitle !== undefined ? ` · ${view.subtitle}` : ''}`,
        args ? `args: ${args}` : '',
        view.result ?? '',
        view.error ?? '',
        ...(view.errorEnvelope !== undefined
          ? [
              `■ ${view.errorEnvelope.error_code} · ${view.errorEnvelope.category} · ${view.errorEnvelope.phase}`,
            ]
          : []),
      ]
        .filter((part) => part.length > 0)
        .join('\n');
    }
    case 'permission':
      return [
        `${item.tool} · ${item.decision} · ${new Date(item.at).toISOString()}`,
        `request: ${item.requestId}`,
        ...(item.actor !== undefined ? [`actor: ${item.actor}`] : []),
      ].join('\n');
    case 'agent':
      return [
        `agent ${item.agentId} · ${item.state}`,
        ...(item.task !== undefined ? [item.task] : []),
        ...(item.children ?? []).map((child) => fullTextOfItem(child) ?? ''),
      ]
        .filter((part) => part.length > 0)
        .join('\n');
    case 'error':
      return [
        item.text,
        ...(item.envelope !== undefined
          ? [
              `■ ${item.envelope.error_code} · ${item.envelope.category} · ${item.envelope.phase} · retryable=${item.envelope.retryable}`,
            ]
          : []),
      ].join('\n');
    case 'run':
      return [
        `${item.status} · ${item.runId}`,
        `tools: ${item.toolCount}`,
        ...(item.durationMs !== undefined ? [`duration: ${item.durationMs}ms`] : []),
        ...(item.usage?.total_tokens !== undefined ? [`tokens: ${item.usage.total_tokens}`] : []),
      ].join('\n');
    case 'command':
      return [item.text, item.output ?? ''].filter((part) => part.length > 0).join('\n');
  }
}
