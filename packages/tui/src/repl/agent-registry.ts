/**
 * 子 agent 注册表：从事件流纯 reducer 派生（0.14 P0 / 0.17 成员事件）。
 * @module @vessel-agent/tui
 *
 * 数据源只有 `EventStream.getHistory()` 中的开放字符串事件；字段全部按
 * snake_case / camelCase 双拼读取，缺字段时降级，不推断父子关系。
 * 同时兼容 0.17 AgentService 的 `agent.*` 事件与 0.15 转发的 `subagent.*`。
 * 节点字段与 canonical `agents.list` 对齐：
 * `id / role / parent_id / depth / state / visibility / current_tool / session_id`
 * （+ 展示用扩展字段）。
 */

import type { EventStream, RunEvent } from '@vessel-agent/core';
import { useEffect, useState } from 'react';

export type AgentState =
  | 'created'
  | 'idle'
  | 'running'
  | 'waiting_permission'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'closed'
  | 'stale';

export type AgentVisibility = 'private' | 'team' | 'tenant';

export interface AgentUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  total_cost?: number;
}

export interface AgentNode {
  /** delegateId / agent_id；旧事件缺失时使用确定性合成 id，并置 degraded */
  id: string;
  role: string;
  /** 成员名（0.17 `agent.*` 事件可选字段） */
  name?: string;
  /** 父子 agent id（嵌套 delegate / 成员 parent_id）；根子 agent 无此字段 */
  parentId?: string;
  /** 创建该子 agent 的父 run；成员事件缺失时退到事件 run_id */
  parentRunId: string;
  /** 事件声明的层级（根 delegate 为 0） */
  depth: number;
  task?: string;
  state: AgentState;
  /** 成员可见性（0.17）；事件未带时为 undefined，不推测 */
  visibility?: AgentVisibility;
  currentTool?: string;
  childRunId?: string;
  sessionId?: string;
  /** canonical node_id（E3）；事件未带时为 undefined */
  nodeId?: string;
  /** 调度队列位置（E3/E4）；不在队列时为 undefined */
  queuePosition?: number;
  /** 等待原因（E3/E4）；不在队列时为 undefined */
  waitReason?: string;
  /** 产出引用（E8）；未提供时为 undefined */
  resultRef?: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  usage?: AgentUsage;
  error?: string;
  /** true = 事件缺 delegateId，只能展示摘要 */
  degraded?: boolean;
}

/** 树形展示行（children 数由注册表父子关系派生） */
export interface AgentTreeRow {
  node: AgentNode;
  depth: number;
  childrenCount: number;
}

/** 注册表保留上限：长会话只留最近的节点 */
export const MAX_AGENT_NODES = 50;

/** canonical agents.list 形状（展示层不直接用，便于与 web / RPC 对齐） */
export interface AgentSummary {
  id: string;
  node_id?: string;
  role: string;
  parent_id?: string;
  depth: number;
  state: AgentState;
  visibility?: AgentVisibility;
  current_tool?: string;
  session_id?: string;
  result_ref?: string;
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

const MEMBER_STATES: ReadonlySet<string> = new Set([
  'created',
  'idle',
  'running',
  'waiting_permission',
  'completed',
  'failed',
  'cancelled',
  'closed',
  'stale',
]);

const MEMBER_VISIBILITIES: ReadonlySet<string> = new Set(['private', 'team', 'tenant']);

function memberStateOf(data: Record<string, unknown>): AgentState | undefined {
  const state = readString(data, 'state');
  return state !== undefined && MEMBER_STATES.has(state) ? (state as AgentState) : undefined;
}

function memberVisibilityOf(data: Record<string, unknown>): AgentVisibility | undefined {
  const visibility = readString(data, 'visibility', 'member_visibility', 'memberVisibility');
  return visibility !== undefined && MEMBER_VISIBILITIES.has(visibility)
    ? (visibility as AgentVisibility)
    : undefined;
}

/** closed / stale 是成员终态；后到的 turn 事件不得覆盖 */
function isFrozenMemberState(state: AgentState): boolean {
  return state === 'closed' || state === 'stale';
}

function applyMemberIdentity(node: AgentNode, data: Record<string, unknown>): AgentNode {
  const name = readString(data, 'name', 'member_name', 'memberName');
  const parentId = readString(data, 'parent_id', 'parentId');
  const sessionId = readString(data, 'session_id', 'sessionId');
  const visibility = memberVisibilityOf(data);
  return {
    ...node,
    ...(name !== undefined ? { name } : {}),
    ...(parentId !== undefined ? { parentId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(visibility !== undefined ? { visibility } : {}),
  };
}

function memberNodeFromEvent(
  event: RunEvent,
  data: Record<string, unknown>,
  id: string,
): AgentNode {
  const task = readString(data, 'task', 'prompt');
  return applyMemberIdentity(
    {
      id,
      role: readString(data, 'role', 'agent_role') ?? 'agent',
      // 成员事件的 run_id 是成员 id，不是父 run；没有父时留空，不伪造。
      parentRunId: readString(data, 'parent_run_id', 'parentRunId') ?? '',
      depth: readNumber(data, 'depth') ?? 0,
      ...(task !== undefined ? { task } : {}),
      state: memberStateOf(data) ?? 'created',
      startedAt: event.ts,
    },
    data,
  );
}

/** 更新已有节点（可选从事件补建）；终态默认不被 turn/permission 事件改写。 */
function updateMemberNode(
  nodes: AgentNode[],
  event: RunEvent,
  data: Record<string, unknown>,
  id: string,
  update: (node: AgentNode) => AgentNode,
  opts: { create?: boolean; allowFrozen?: boolean } = {},
): AgentNode[] {
  const existing = findNode(nodes, id);
  if (existing) {
    if (!opts.allowFrozen && isFrozenMemberState(existing.state)) return nodes;
    return replaceNode(nodes, update(applyMemberIdentity(existing, data)));
  }
  if (opts.create !== true) return nodes;
  return trimNodes([...nodes, update(memberNodeFromEvent(event, data, id))]);
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
    case 'agent.spawned': {
      if (delegateId === undefined) return nodes;
      const usage = readUsage(data);
      return updateMemberNode(
        nodes,
        event,
        data,
        delegateId,
        (node) => ({
          ...node,
          state: memberStateOf(data) ?? 'idle',
          ...(usage !== undefined ? { usage } : {}),
        }),
        { create: true, allowFrozen: true },
      );
    }

    case 'agent.turn.started': {
      if (delegateId === undefined) return nodes;
      return updateMemberNode(
        nodes,
        event,
        data,
        delegateId,
        (node) => {
          const {
            endedAt: _endedAt,
            durationMs: _durationMs,
            error: _error,
            currentTool: _currentTool,
            ...rest
          } = node;
          return { ...rest, state: 'running' };
        },
        { create: true },
      );
    }

    case 'agent.turn.completed':
    case 'agent.turn.failed':
    case 'agent.turn.cancelled': {
      if (delegateId === undefined) return nodes;
      const fallback: AgentState =
        base === 'agent.turn.failed'
          ? 'failed'
          : base === 'agent.turn.cancelled'
            ? 'cancelled'
            : 'completed';
      const usage = readUsage(data);
      const error = base === 'agent.turn.failed' ? errorTextOf(data) : undefined;
      return updateMemberNode(
        nodes,
        event,
        data,
        delegateId,
        (node) => {
          const { currentTool: _currentTool, ...rest } = node;
          return {
            ...rest,
            state: memberStateOf(data) ?? fallback,
            endedAt: event.ts,
            ...(usage !== undefined ? { usage } : {}),
            ...(error !== undefined ? { error } : {}),
          };
        },
        { create: true },
      );
    }

    case 'agent.permission.requested': {
      if (delegateId === undefined) return nodes;
      const tool = readString(data, 'tool', 'tool_name', 'toolName');
      return updateMemberNode(
        nodes,
        event,
        data,
        delegateId,
        (node) => ({
          ...node,
          state: 'waiting_permission',
          ...(tool !== undefined ? { currentTool: tool } : {}),
        }),
        { create: true },
      );
    }

    case 'agent.permission.responded': {
      if (delegateId === undefined) return nodes;
      return updateMemberNode(nodes, event, data, delegateId, (node) => {
        const { currentTool: _currentTool, ...rest } = node;
        return { ...rest, state: memberStateOf(data) ?? 'running' };
      });
    }

    case 'agent.closed': {
      if (delegateId === undefined) return nodes;
      return updateMemberNode(
        nodes,
        event,
        data,
        delegateId,
        (node) => {
          const { currentTool: _currentTool, ...rest } = node;
          return { ...rest, state: 'closed', endedAt: event.ts };
        },
        { create: true, allowFrozen: true },
      );
    }

    case 'agent.stale': {
      if (delegateId === undefined) return nodes;
      // 快照恢复的 stale 早于任何 spawned；closed 仍是更高优先级的终态。
      const existing = findNode(nodes, delegateId);
      if (existing?.state === 'closed') return nodes;
      return updateMemberNode(
        nodes,
        event,
        data,
        delegateId,
        (node) => {
          const { currentTool: _currentTool, ...rest } = node;
          return { ...rest, state: 'stale', endedAt: event.ts };
        },
        { create: true, allowFrozen: true },
      );
    }

    case 'agent.message.queued': {
      if (delegateId === undefined) return nodes;
      const state = memberStateOf(data);
      return updateMemberNode(nodes, event, data, delegateId, (node) => ({
        ...node,
        ...(state !== undefined ? { state } : {}),
      }));
    }

    case 'agent.queue.entered': {
      if (delegateId === undefined) return nodes;
      const position = readNumber(data, 'position', 'queue_position', 'queuePosition');
      const waitReason = readString(data, 'wait_reason', 'waitReason');
      const nodeId = readString(data, 'node_id', 'nodeId');
      return updateNode(nodes, delegateId, (node) => ({
        ...node,
        ...(position !== undefined ? { queuePosition: position } : {}),
        ...(waitReason !== undefined ? { waitReason } : {}),
        ...(nodeId !== undefined ? { nodeId } : {}),
      }));
    }

    case 'agent.queue.left': {
      if (delegateId === undefined) return nodes;
      return updateNode(nodes, delegateId, (node) => {
        const { queuePosition: _position, waitReason: _reason, ...rest } = node;
        return rest;
      });
    }

    case 'delegate.started':
    case 'delegate_task.started': {
      const parentRunId = readString(data, 'run_id', 'parent_run_id') ?? event.run_id;
      const id =
        delegateId ??
        `delegate:${parentRunId}:${nodes.filter((node) => node.parentRunId === parentRunId).length}`;
      const parentId = readString(data, 'parent_delegate_id', 'parentDelegateId');
      const nodeId = readString(data, 'node_id', 'nodeId');
      const queuePosition = readNumber(data, 'queue_position', 'queuePosition');
      const waitReason = readString(data, 'wait_reason', 'waitReason');
      const existing = findNode(nodes, id);
      const node: AgentNode = {
        id,
        role: readString(data, 'role', 'agent_role') ?? 'subagent',
        ...(parentId !== undefined ? { parentId } : {}),
        parentRunId,
        depth: readNumber(data, 'depth') ?? 0,
        ...(readString(data, 'task') !== undefined ? { task: readString(data, 'task') } : {}),
        state: 'running',
        ...(nodeId !== undefined ? { nodeId } : {}),
        ...(queuePosition !== undefined ? { queuePosition } : {}),
        ...(waitReason !== undefined ? { waitReason } : {}),
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
      const nodeId = readString(data, 'node_id', 'nodeId');
      return updateNode(nodes, delegateId, (node) => ({
        ...node,
        state: 'running',
        childRunId,
        ...(nodeId !== undefined ? { nodeId } : {}),
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
      if (subagent && delegateId !== undefined) {
        return updateNode(nodes, delegateId, (node) => ({
          ...node,
          state: 'completed',
          endedAt: event.ts,
        }));
      }
      // 顶层父 run 完成：仍在运行的成员不会再有终态事件，避免下栏 sub N 卡住。
      return markParentRunEnded(nodes, event.run_id, 'completed', undefined, event.ts);
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
      const resultRef = readString(data, 'result_ref', 'resultRef');
      return updateNode(nodes, delegateId, (node) => ({
        ...node,
        state: 'completed',
        endedAt: event.ts,
        ...(duration !== undefined ? { durationMs: duration } : {}),
        ...(usage !== undefined ? { usage } : {}),
        ...(resultRef !== undefined ? { resultRef } : {}),
      }));
    }

    case 'delegate.failed': {
      if (delegateId === undefined) return nodes;
      const duration = readNumber(data, 'duration_ms', 'durationMs');
      const error = errorTextOf(data);
      const resultRef = readString(data, 'result_ref', 'resultRef');
      return updateNode(nodes, delegateId, (node) => ({
        ...node,
        state: 'failed',
        endedAt: event.ts,
        ...(duration !== undefined ? { durationMs: duration } : {}),
        ...(error !== undefined ? { error } : {}),
        ...(resultRef !== undefined ? { resultRef } : {}),
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

/**
 * 纯函数：按 parentId 组装树（父节点缺失的子节点提升为根）。
 * 同级按 startedAt 升序；缩进取事件 depth 与结构深度的较大者，缺 depth 时不塌缩。
 */
export function buildAgentTree(nodes: AgentNode[]): AgentTreeRow[] {
  const ids = new Set(nodes.map((node) => node.id));
  const children = new Map<string, AgentNode[]>();
  const roots: AgentNode[] = [];

  for (const node of nodes) {
    if (node.parentId !== undefined && node.parentId !== node.id && ids.has(node.parentId)) {
      const list = children.get(node.parentId) ?? [];
      list.push(node);
      children.set(node.parentId, list);
    } else {
      roots.push(node);
    }
  }

  const byStarted = (a: AgentNode, b: AgentNode): number => {
    if (a.startedAt !== b.startedAt) return a.startedAt - b.startedAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
  roots.sort(byStarted);
  for (const list of children.values()) list.sort(byStarted);

  const rows: AgentTreeRow[] = [];
  const visited = new Set<string>();
  const visit = (node: AgentNode, structuralDepth: number): void => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    const kids = children.get(node.id) ?? [];
    rows.push({
      node,
      depth: Math.max(0, node.depth, structuralDepth),
      childrenCount: kids.length,
    });
    for (const child of kids) visit(child, structuralDepth + 1);
  };

  for (const root of roots) visit(root, 0);
  for (const node of nodes) visit(node, 0);
  return rows;
}

/** 正在运行的成员数（running / waiting_permission） */
export function countActiveAgents(nodes: readonly AgentNode[]): number {
  return nodes.filter((node) => node.state === 'running' || node.state === 'waiting_permission')
    .length;
}

/**
 * 订阅事件流并增量维护注册表。
 * `SubagentActivity` 与下栏 `sub N` 必须共用这一份派生，避免两套计数口径。
 */
export function useAgentRegistry(events: EventStream): AgentNode[] {
  const [nodes, setNodes] = useState<AgentNode[]>([]);
  useEffect(() => {
    const unsubscribe = events.subscribe((rawEvent) => {
      setNodes((prev) => reduceAgentRegistry(prev, rawEvent));
    });
    return unsubscribe;
  }, [events]);
  return nodes;
}

/** 与 canonical agents.list 对齐的摘要（parent_id/current_tool/session_id 为 snake_case） */
export function toAgentSummary(node: AgentNode): AgentSummary {
  return {
    id: node.id,
    ...(node.nodeId !== undefined ? { node_id: node.nodeId } : {}),
    role: node.role,
    ...(node.parentId !== undefined ? { parent_id: node.parentId } : {}),
    depth: node.depth,
    state: node.state,
    ...(node.visibility !== undefined ? { visibility: node.visibility } : {}),
    ...(node.currentTool !== undefined ? { current_tool: node.currentTool } : {}),
    ...(node.sessionId !== undefined ? { session_id: node.sessionId } : {}),
    ...(node.resultRef !== undefined ? { result_ref: node.resultRef } : {}),
  };
}
