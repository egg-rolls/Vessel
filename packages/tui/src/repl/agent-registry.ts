/**
 * 子 agent 注册表：从事件流纯 reducer 派生（0.14 P0）。
 * @module @vessel-agent/tui
 *
 * 数据源只有 `EventStream.getHistory()` 中的开放字符串事件；字段全部按
 * snake_case / camelCase 双拼读取，缺字段时降级，不推断父子关系。
 * 节点字段与 canonical `agents.list` 对齐：
 * `id / role / parent_id / depth / state / current_tool / session_id`（+ 展示用扩展字段）。
 */

import type { RunEvent } from '@vessel-agent/core';

export type AgentState = 'running' | 'completed' | 'failed' | 'cancelled';

export interface AgentUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  total_cost?: number;
}

export interface AgentNode {
  /** delegateId；旧事件缺失时使用确定性合成 id，并置 degraded */
  id: string;
  role: string;
  /** 父子 agent id（嵌套 delegate）；根子 agent 无此字段 */
  parentId?: string;
  /** 创建该子 agent 的父 run */
  parentRunId: string;
  /** 事件声明的层级（根 delegate 为 0） */
  depth: number;
  task?: string;
  state: AgentState;
  currentTool?: string;
  childRunId?: string;
  sessionId?: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  usage?: AgentUsage;
  error?: string;
  /** true = 事件缺 delegateId，只能展示摘要 */
  degraded?: boolean;
}

/** 注册表保留上限：长会话只留最近的节点 */
export const MAX_AGENT_NODES = 50;

/** canonical agents.list 形状（展示层不直接用，便于与 web / RPC 对齐） */
export interface AgentSummary {
  id: string;
  role: string;
  parent_id?: string;
  depth: number;
  state: AgentState;
  current_tool?: string;
  session_id?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function readUsage(data: Record<string, unknown>): AgentUsage | undefined {
  const raw = data.usage;
  if (!isRecord(raw)) return undefined;
  const usage: AgentUsage = {};
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

/** 去掉重复的 `subagent.` 前缀（嵌套转发可能出现 subagent.subagent.*） */
function baseType(type: string): string {
  let value = type;
  while (value.startsWith('subagent.')) value = value.slice('subagent.'.length);
  return value;
}

function isSubagentEvent(type: string): boolean {
  return type.startsWith('subagent.');
}

function dataOf(event: RunEvent): Record<string, unknown> {
  return isRecord(event.data) ? event.data : {};
}

function findNode(nodes: AgentNode[], id: string): AgentNode | undefined {
  return nodes.find((node) => node.id === id);
}

function replaceNode(nodes: AgentNode[], next: AgentNode): AgentNode[] {
  return nodes.map((node) => (node.id === next.id ? next : node));
}

function updateNode(
  nodes: AgentNode[],
  id: string,
  update: (node: AgentNode) => AgentNode,
): AgentNode[] {
  const index = nodes.findIndex((node) => node.id === id);
  if (index < 0) return nodes;
  const current = nodes[index];
  if (!current) return nodes;
  const next = [...nodes];
  next[index] = update(current);
  return next;
}

/** 截断到最近 MAX_AGENT_NODES 个（按 startedAt 升序保留尾部） */
function trimNodes(nodes: AgentNode[]): AgentNode[] {
  if (nodes.length <= MAX_AGENT_NODES) return nodes;
  return [...nodes].sort((a, b) => a.startedAt - b.startedAt).slice(-MAX_AGENT_NODES);
}

function delegateIdOf(data: Record<string, unknown>): string | undefined {
  return readString(data, 'delegateId', 'delegate_id', 'agentId', 'agent_id');
}

function errorTextOf(data: Record<string, unknown>): string | undefined {
  const raw = data.error ?? data.message ?? data.reason;
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  if (raw instanceof Error && raw.message) return raw.message;
  return undefined;
}

/**
 * 纯 reducer：折叠单个事件。
 * 顶层 `run.*` 只用于收敛父 run 结束时仍在运行的子 agent。
 */
export function reduceAgentRegistry(nodes: AgentNode[], event: RunEvent): AgentNode[] {
  const data = dataOf(event);
  const type = event.type;
  const base = baseType(type);
  const subagent = isSubagentEvent(type) || delegateIdOf(data) !== undefined;
  const delegateId = delegateIdOf(data);

  switch (base) {
    case 'delegate.started':
    case 'delegate_task.started': {
      const parentRunId = readString(data, 'run_id', 'parent_run_id') ?? event.run_id;
      const id =
        delegateId ??
        `delegate:${parentRunId}:${nodes.filter((node) => node.parentRunId === parentRunId).length}`;
      const parentId = readString(data, 'parent_delegate_id', 'parentDelegateId');
      const existing = findNode(nodes, id);
      const node: AgentNode = {
        id,
        role: readString(data, 'role', 'agent_role') ?? 'subagent',
        ...(parentId !== undefined ? { parentId } : {}),
        parentRunId,
        depth: readNumber(data, 'depth') ?? 0,
        ...(readString(data, 'task') !== undefined ? { task: readString(data, 'task') } : {}),
        state: 'running',
        ...(readString(data, 'session_id', 'parent_session_id', 'parentSessionId') !== undefined
          ? {
              sessionId: readString(data, 'session_id', 'parent_session_id', 'parentSessionId'),
            }
          : {}),
        startedAt: event.ts,
        ...(delegateId === undefined ? { degraded: true } : {}),
      };
      return trimNodes(
        existing
          ? replaceNode(nodes, { ...node, startedAt: existing.startedAt })
          : [...nodes, node],
      );
    }

    case 'run.started': {
      if (!subagent || delegateId === undefined) return nodes;
      const childRunId = readString(data, 'run_id') ?? event.run_id;
      return updateNode(nodes, delegateId, (node) => ({
        ...node,
        state: 'running',
        childRunId,
        ...(readString(data, 'session_id') !== undefined
          ? { sessionId: readString(data, 'session_id') }
          : {}),
      }));
    }

    case 'tool.call.started': {
      if (!subagent || delegateId === undefined) return nodes;
      const toolName = readString(data, 'tool_name', 'toolName');
      if (toolName === undefined) return nodes;
      return updateNode(nodes, delegateId, (node) => ({ ...node, currentTool: toolName }));
    }

    case 'tool.call.completed':
    case 'tool.call.failed': {
      if (!subagent || delegateId === undefined) return nodes;
      return updateNode(nodes, delegateId, (node) => {
        if (node.currentTool === undefined) return node;
        const { currentTool: _currentTool, ...rest } = node;
        return rest;
      });
    }

    case 'run.completed': {
      if (!subagent || delegateId === undefined) return nodes;
      return updateNode(nodes, delegateId, (node) => ({
        ...node,
        state: 'completed',
        endedAt: event.ts,
      }));
    }

    case 'run.failed': {
      if (subagent && delegateId !== undefined) {
        const error = errorTextOf(data);
        return updateNode(nodes, delegateId, (node) => ({
          ...node,
          state: 'failed',
          endedAt: event.ts,
          ...(error !== undefined ? { error } : {}),
        }));
      }
      // 顶层父 run 失败：仍在运行的子 agent 不会再有终态事件。
      return markParentRunEnded(nodes, event.run_id, 'failed', errorTextOf(data), event.ts);
    }

    case 'run.cancelled': {
      if (subagent && delegateId !== undefined) {
        return updateNode(nodes, delegateId, (node) => ({
          ...node,
          state: 'cancelled',
          endedAt: event.ts,
        }));
      }
      return markParentRunEnded(nodes, event.run_id, 'cancelled', undefined, event.ts);
    }

    case 'delegate.completed': {
      if (delegateId === undefined) return nodes;
      const duration = readNumber(data, 'duration_ms', 'durationMs');
      const usage = readUsage(data);
      return updateNode(nodes, delegateId, (node) => ({
        ...node,
        state: 'completed',
        endedAt: event.ts,
        ...(duration !== undefined ? { durationMs: duration } : {}),
        ...(usage !== undefined ? { usage } : {}),
      }));
    }

    case 'delegate.failed': {
      if (delegateId === undefined) return nodes;
      const duration = readNumber(data, 'duration_ms', 'durationMs');
      const error = errorTextOf(data);
      return updateNode(nodes, delegateId, (node) => ({
        ...node,
        state: 'failed',
        endedAt: event.ts,
        ...(duration !== undefined ? { durationMs: duration } : {}),
        ...(error !== undefined ? { error } : {}),
      }));
    }

    default:
      return nodes;
  }
}

function markParentRunEnded(
  nodes: AgentNode[],
  parentRunId: string,
  state: AgentState,
  error: string | undefined,
  ts: number,
): AgentNode[] {
  let changed = false;
  const next = nodes.map((node) => {
    if (node.parentRunId !== parentRunId || node.state !== 'running') return node;
    changed = true;
    return {
      ...node,
      state,
      endedAt: ts,
      ...(error !== undefined ? { error } : {}),
    };
  });
  return changed ? next : nodes;
}

/** 纯函数：从完整事件历史构建注册表（按事件顺序折叠） */
export function buildAgentRegistry(events: RunEvent[]): AgentNode[] {
  return events.reduce<AgentNode[]>(reduceAgentRegistry, []);
}

/** 展示顺序：新节点在前，同 startedAt 按 id 稳定排序 */
export function sortAgentNodes(nodes: AgentNode[]): AgentNode[] {
  return [...nodes].sort((a, b) => {
    if (a.startedAt !== b.startedAt) return b.startedAt - a.startedAt;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });
}

export interface AgentMatch {
  exact: AgentNode[];
  prefix: AgentNode[];
}

/** 精确 id 优先；否则返回全部前缀匹配（调用方判断歧义） */
export function matchAgents(nodes: AgentNode[], query: string): AgentMatch {
  const exact = nodes.filter((node) => node.id === query);
  if (exact.length > 0) return { exact, prefix: [] };
  return { exact: [], prefix: nodes.filter((node) => node.id.startsWith(query)) };
}

/** 与 canonical agents.list 对齐的摘要（parent_id/current_tool/session_id 为 snake_case） */
export function toAgentSummary(node: AgentNode): AgentSummary {
  return {
    id: node.id,
    role: node.role,
    ...(node.parentId !== undefined ? { parent_id: node.parentId } : {}),
    depth: node.depth,
    state: node.state,
    ...(node.currentTool !== undefined ? { current_tool: node.currentTool } : {}),
    ...(node.sessionId !== undefined ? { session_id: node.sessionId } : {}),
  };
}
