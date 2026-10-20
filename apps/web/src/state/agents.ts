/**
 * 子 agent 注册表（0.14 P0）：从 `subagent.*` 事件纯函数派生，无 React 依赖。
 *
 * delegate-task 插件把子 runtime 事件以 `subagent.` 前缀转发到父事件流，
 * 并在 data 里带 `agentId`（delegateId）。这里用的字段全部做运行时收敛；
 * 事件缺失时按剩余信息降级，不伪造节点。
 */
import type { RunEvent } from '../gateway/types';
import type { StoredEvent } from './events';

export interface AgentUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  total_cost?: number;
}

export interface AgentNode {
  id: string;
  role?: string;
  parentId?: string;
  depth: number;
  state: string;
  currentTool?: string;
  sessionId?: string;
  usage?: AgentUsage;
  task?: string;
  /** 子 run id；`?agent=` 深链用它取 transcript。 */
  runId?: string;
  startedAt?: number;
  completedAt?: number;
  lastError?: string;
}

type MutableNode = AgentNode;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberField(data: Record<string, unknown>, key: string): number | undefined {
  const value = data[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function usageOf(data: Record<string, unknown>): AgentUsage | undefined {
  const raw = data.usage;
  if (!isRecord(raw)) return undefined;
  const usage: AgentUsage = {};
  const prompt = numberField(raw, 'prompt_tokens');
  const completion = numberField(raw, 'completion_tokens');
  const total = numberField(raw, 'total_tokens');
  const cost = numberField(raw, 'total_cost');
  if (prompt !== undefined) usage.prompt_tokens = prompt;
  if (completion !== undefined) usage.completion_tokens = completion;
  if (total !== undefined) usage.total_tokens = total;
  if (cost !== undefined) usage.total_cost = cost;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function depthOf(data: Record<string, unknown>): number | undefined {
  const depth = numberField(data, 'depth');
  return depth !== undefined && depth >= 0 ? Math.floor(depth) : undefined;
}

/**
 * 把快照事件折叠成 agent 节点。返回顺序保持首次出现顺序；
 * 状态/工具/用量字段按后到事件覆盖（同 id 不会重复建节点）。
 */
export function reduceAgents(entries: readonly StoredEvent[]): AgentNode[] {
  const nodes = new Map<string, MutableNode>();
  const runToAgent = new Map<string, string>();
  const runSession = new Map<string, string>();

  function ensure(id: string, seed: Partial<AgentNode> = {}): MutableNode {
    let node = nodes.get(id);
    if (!node) {
      node = { id, depth: seed.depth ?? 0, state: seed.state ?? 'running' };
      nodes.set(id, node);
    }
    if (seed.role !== undefined && node.role === undefined) node.role = seed.role;
    if (seed.parentId !== undefined && node.parentId === undefined) node.parentId = seed.parentId;
    if (seed.depth !== undefined) node.depth = Math.max(node.depth, seed.depth);
    if (seed.state !== undefined) node.state = seed.state;
    if (seed.currentTool !== undefined) node.currentTool = seed.currentTool;
    if (seed.sessionId !== undefined) node.sessionId = seed.sessionId;
    if (seed.usage !== undefined) node.usage = seed.usage;
    if (seed.task !== undefined && node.task === undefined) node.task = seed.task;
    if (seed.runId !== undefined) node.runId = seed.runId;
    if (seed.startedAt !== undefined && node.startedAt === undefined) {
      node.startedAt = seed.startedAt;
    }
    if (seed.completedAt !== undefined) node.completedAt = seed.completedAt;
    if (seed.lastError !== undefined) node.lastError = seed.lastError;
    return node;
  }

  function ingest(event: RunEvent): void {
    const type = event.type;
    if (!type.startsWith('run.') && !type.startsWith('subagent.')) return;
    const data = isRecord(event.data) ? event.data : {};

    if (type === 'run.started' || type === 'run.completed' || type === 'run.failed') {
      const sessionId = stringField(data, 'session_id');
      if (event.run_id && sessionId) runSession.set(event.run_id, sessionId);
      return;
    }
    if (type === 'run.cancelled') return;
    if (!type.startsWith('subagent.')) return;

    if (type === 'subagent.delegate.started') {
      const delegateId = stringField(data, 'delegateId');
      if (!delegateId) return;
      const parentRun = event.run_id;
      const parentId = parentRun ? runToAgent.get(parentRun) : undefined;
      const sessionId = parentRun ? runSession.get(parentRun) : undefined;
      const task = stringField(data, 'task');
      ensure(delegateId, {
        role: 'subagent',
        ...(parentId !== undefined ? { parentId } : {}),
        depth: depthOf(data) ?? 0,
        state: 'running',
        ...(task !== undefined ? { task } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        startedAt: event.ts,
      });
      return;
    }

    if (type === 'subagent.delegate.completed' || type === 'subagent.delegate.failed') {
      const delegateId = stringField(data, 'delegateId');
      if (!delegateId) return;
      const failed = type === 'subagent.delegate.failed';
      const usage = usageOf(data);
      const failure = failed
        ? (stringField(data, 'error') ?? stringField(data, 'message'))
        : undefined;
      const node = ensure(delegateId, {
        role: 'subagent',
        state: failed ? 'failed' : 'completed',
        completedAt: event.ts,
        ...(usage !== undefined ? { usage } : {}),
        ...(failure !== undefined ? { lastError: failure } : {}),
      });
      node.currentTool = undefined;
      if (!failed) node.lastError = undefined;
      return;
    }

    const agentId = stringField(data, 'agentId');
    if (!agentId) return;
    const runId = event.run_id;

    if (type === 'subagent.run.started') {
      if (runId) runToAgent.set(runId, agentId);
      const sessionId =
        stringField(data, 'session_id') ?? (runId ? runSession.get(runId) : undefined);
      ensure(agentId, {
        role: 'subagent',
        state: 'running',
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(runId ? { runId } : {}),
      });
      return;
    }

    if (type === 'subagent.run.completed' || type === 'subagent.run.cancelled') {
      const sessionId =
        stringField(data, 'session_id') ?? (runId ? runSession.get(runId) : undefined);
      const usage = usageOf(data);
      const node = ensure(agentId, {
        role: 'subagent',
        state: type === 'subagent.run.completed' ? 'completed' : 'cancelled',
        completedAt: event.ts,
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(usage !== undefined ? { usage } : {}),
      });
      node.currentTool = undefined;
      if (type === 'subagent.run.completed') node.lastError = undefined;
      return;
    }

    if (type === 'subagent.run.failed') {
      const sessionId =
        stringField(data, 'session_id') ?? (runId ? runSession.get(runId) : undefined);
      const failure = stringField(data, 'error') ?? stringField(data, 'message');
      const node = ensure(agentId, {
        role: 'subagent',
        state: 'failed',
        completedAt: event.ts,
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(failure !== undefined ? { lastError: failure } : {}),
      });
      node.currentTool = undefined;
      return;
    }

    if (type === 'subagent.tool.call.started') {
      const toolName = stringField(data, 'tool_name');
      ensure(agentId, {
        state: 'running',
        ...(toolName !== undefined ? { currentTool: toolName } : {}),
      });
      return;
    }

    if (type === 'subagent.tool.call.completed' || type === 'subagent.tool.call.failed') {
      const node = nodes.get(agentId);
      const toolName = stringField(data, 'tool_name');
      if (node && (toolName === undefined || node.currentTool === toolName)) {
        node.currentTool = undefined;
      }
      if (type === 'subagent.tool.call.failed' && node) {
        node.lastError = stringField(data, 'error');
      }
    }
  }

  for (const entry of entries) ingest(entry.event);

  return [...nodes.values()]
    .sort(
      (a, b) =>
        (a.startedAt ?? 0) - (b.startedAt ?? 0) ||
        a.depth - b.depth ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .map((node) => ({ ...node }));
}

/**
 * 只保留属于某会话的节点。父节点在集合内时，孤儿子节点也一并保留
 * （子 run.started 缺失时仍能显示树，不丢节点）。
 */
export function agentsForSession(nodes: readonly AgentNode[], sessionId: string): AgentNode[] {
  const included = new Set(nodes.filter((node) => node.sessionId === sessionId).map((n) => n.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (included.has(node.id)) continue;
      if (node.parentId !== undefined && included.has(node.parentId)) {
        included.add(node.id);
        changed = true;
      }
    }
  }
  return nodes.filter((node) => included.has(node.id));
}

export interface AgentTreeEntry {
  node: AgentNode;
  children: AgentTreeEntry[];
}

/**
 * 按 parentId 组树。父节点不在集合内 / 成环时挂到 root，
 * 渲染不丢节点（用 visited 防止死循环）。
 */
export function agentTree(nodes: readonly AgentNode[]): AgentTreeEntry[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string, AgentNode[]>();
  const roots: AgentNode[] = [];
  for (const node of nodes) {
    if (node.parentId !== undefined && byId.has(node.parentId) && node.parentId !== node.id) {
      const list = children.get(node.parentId);
      if (list) list.push(node);
      else children.set(node.parentId, [node]);
    } else {
      roots.push(node);
    }
  }
  const seen = new Set<string>();
  function build(node: AgentNode): AgentTreeEntry {
    seen.add(node.id);
    const kids = (children.get(node.id) ?? []).filter((child) => !seen.has(child.id));
    return { node, children: kids.map(build) };
  }
  const result = roots.map(build);
  // 纯环（A→B→A）没有 root：按顺序补挂剩余节点，保证全部可见。
  for (const node of nodes) {
    if (!seen.has(node.id)) result.push(build(node));
  }
  return result;
}

/** root → active 的面包屑；父链缺失时只返回 active。 */
export function agentBreadcrumb(nodes: readonly AgentNode[], activeId: string): AgentNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const chain: AgentNode[] = [];
  const seen = new Set<string>();
  let current = byId.get(activeId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    const next = current.parentId ? byId.get(current.parentId) : undefined;
    // 纯环（A→B→A）没有 root：不再把起点当祖先重复加入。
    if (next?.id === activeId) break;
    current = next;
  }
  return chain;
}

export function findAgent(nodes: readonly AgentNode[], id: string): AgentNode | undefined {
  return nodes.find((node) => node.id === id);
}
