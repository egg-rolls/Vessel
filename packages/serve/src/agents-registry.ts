/**
 * agents 注册表（0.14 P0，DECISION-025 §1.4）。
 *
 * 从 `subagent.*` / `run.*` 事件派生子 agent 视图，供 canonical
 * `agents.list` / `agents.get` 使用。纯内存、无 IO：事件由 gateway 的
 * 实时订阅喂入；Host 成员与 active/queued run 由方法层在读取时合并。
 *
 * 事件名是开放字符串，所有 payload 字段都做运行时收敛，缺字段时跳过，
 * 不伪造节点。
 *
 * @module @vessel-agent/serve
 */

import type { RunEvent } from '@vessel-agent/core';

export interface AgentUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  total_cost?: number;
}

/** 注册表内部条目；公共输出由方法层裁剪。 */
export interface AgentRegistryEntry {
  id: string;
  role?: string;
  parent_id?: string;
  depth: number;
  state: string;
  current_tool?: string;
  session_id?: string;
  usage?: AgentUsage;
  task?: string;
  started_at?: number;
  completed_at?: number;
  last_error?: string;
  tenant_id?: string;
}

export interface AgentRegistryFilter {
  session_id?: string;
  state?: string;
}

export interface AgentRegistry {
  ingest(event: RunEvent): void;
  list(filter?: AgentRegistryFilter): AgentRegistryEntry[];
  get(id: string): AgentRegistryEntry | undefined;
}

interface MutableEntry extends AgentRegistryEntry {
  seq: number;
}

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
  const value = numberField(data, 'depth');
  return value !== undefined && value >= 0 ? Math.floor(value) : undefined;
}

/**
 * 创建注册表。`runToAgent` 记录子 run → delegate id，用于嵌套 delegate 的
 * `parent_id` 解析；`runSession` 记录 run → session，用于会话过滤。
 */
export function createAgentRegistry(): AgentRegistry {
  const entries = new Map<string, MutableEntry>();
  const runToAgent = new Map<string, string>();
  const runSession = new Map<string, string>();
  let seq = 0;

  function ensure(id: string, seed: Partial<AgentRegistryEntry> = {}): MutableEntry {
    let entry = entries.get(id);
    if (!entry) {
      entry = {
        id,
        depth: seed.depth ?? 0,
        state: seed.state ?? 'running',
        seq: ++seq,
      };
      entries.set(id, entry);
    }
    if (seed.role !== undefined && entry.role === undefined) entry.role = seed.role;
    if (seed.parent_id !== undefined && entry.parent_id === undefined) {
      entry.parent_id = seed.parent_id;
    }
    if (seed.depth !== undefined) entry.depth = Math.max(entry.depth, seed.depth);
    if (seed.state !== undefined) entry.state = seed.state;
    if (seed.current_tool !== undefined) entry.current_tool = seed.current_tool;
    if (seed.session_id !== undefined) entry.session_id = seed.session_id;
    if (seed.usage !== undefined) entry.usage = seed.usage;
    if (seed.task !== undefined && entry.task === undefined) entry.task = seed.task;
    if (seed.started_at !== undefined && entry.started_at === undefined) {
      entry.started_at = seed.started_at;
    }
    if (seed.completed_at !== undefined) entry.completed_at = seed.completed_at;
    if (seed.last_error !== undefined) entry.last_error = seed.last_error;
    if (seed.tenant_id !== undefined && entry.tenant_id === undefined) {
      entry.tenant_id = seed.tenant_id;
    }
    return entry;
  }

  function ingest(event: RunEvent): void {
    const type = event.type;
    if (!type.startsWith('run.') && !type.startsWith('subagent.')) return;
    const data = isRecord(event.data) ? event.data : {};
    const tenantId = event.tenant_id;

    // 父流 run 事件：只维护 run → session 映射；根 agent 由方法层按 run 记录补齐。
    if (type === 'run.started') {
      const runId = event.run_id;
      const session = stringField(data, 'session_id');
      if (runId && session) runSession.set(runId, session);
      return;
    }
    if (type === 'run.completed' || type === 'run.failed' || type === 'run.cancelled') {
      const session = stringField(data, 'session_id');
      if (event.run_id && session) runSession.set(event.run_id, session);
      return;
    }

    if (!type.startsWith('subagent.')) return;

    if (type === 'subagent.delegate.started') {
      const delegateId = stringField(data, 'delegateId');
      if (!delegateId) return;
      const parentRun = event.run_id;
      const parent = parentRun ? runToAgent.get(parentRun) : undefined;
      const depth = depthOf(data) ?? 0;
      const task = stringField(data, 'task');
      ensure(delegateId, {
        role: 'subagent',
        ...(parent !== undefined ? { parent_id: parent } : {}),
        depth,
        state: 'running',
        ...(task !== undefined ? { task } : {}),
        started_at: event.ts,
        ...(tenantId !== undefined ? { tenant_id: tenantId } : {}),
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
      const entry = ensure(delegateId, {
        role: 'subagent',
        state: failed ? 'failed' : 'completed',
        completed_at: event.ts,
        ...(failure !== undefined ? { last_error: failure } : {}),
        ...(usage !== undefined ? { usage } : {}),
        ...(tenantId !== undefined ? { tenant_id: tenantId } : {}),
      });
      // 终态清理：不留运行中的工具与成功前的旧错误。
      entry.current_tool = undefined;
      if (!failed) entry.last_error = undefined;
      return;
    }

    // 其余子事件都带 agentId（Host 转发时由 delegate-task 注入）。
    const agentId = stringField(data, 'agentId');
    if (!agentId) return;
    const runId = event.run_id;

    if (type === 'subagent.run.started') {
      if (runId) runToAgent.set(runId, agentId);
      const session =
        stringField(data, 'session_id') ?? (runId ? runSession.get(runId) : undefined);
      ensure(agentId, {
        role: 'subagent',
        state: 'running',
        ...(session !== undefined ? { session_id: session } : {}),
        ...(tenantId !== undefined ? { tenant_id: tenantId } : {}),
      });
      return;
    }

    if (type === 'subagent.run.completed' || type === 'subagent.run.cancelled') {
      const session =
        stringField(data, 'session_id') ?? (runId ? runSession.get(runId) : undefined);
      const usage = usageOf(data);
      const entry = ensure(agentId, {
        role: 'subagent',
        state: type === 'subagent.run.completed' ? 'completed' : 'cancelled',
        completed_at: event.ts,
        ...(session !== undefined ? { session_id: session } : {}),
        ...(usage !== undefined ? { usage } : {}),
        ...(tenantId !== undefined ? { tenant_id: tenantId } : {}),
      });
      entry.current_tool = undefined;
      if (type === 'subagent.run.completed') entry.last_error = undefined;
      return;
    }

    if (type === 'subagent.run.failed') {
      const session =
        stringField(data, 'session_id') ?? (runId ? runSession.get(runId) : undefined);
      const failure = stringField(data, 'error') ?? stringField(data, 'message');
      const entry = ensure(agentId, {
        role: 'subagent',
        state: 'failed',
        completed_at: event.ts,
        ...(failure !== undefined ? { last_error: failure } : {}),
        ...(session !== undefined ? { session_id: session } : {}),
        ...(tenantId !== undefined ? { tenant_id: tenantId } : {}),
      });
      entry.current_tool = undefined;
      return;
    }

    if (type === 'subagent.tool.call.started') {
      const toolName = stringField(data, 'tool_name');
      ensure(agentId, {
        state: 'running',
        ...(toolName !== undefined ? { current_tool: toolName } : {}),
        ...(tenantId !== undefined ? { tenant_id: tenantId } : {}),
      });
      return;
    }

    if (type === 'subagent.tool.call.completed' || type === 'subagent.tool.call.failed') {
      const entry = entries.get(agentId);
      const toolName = stringField(data, 'tool_name');
      if (entry && (toolName === undefined || entry.current_tool === toolName)) {
        entry.current_tool = undefined;
      }
      if (type === 'subagent.tool.call.failed' && entry) {
        entry.last_error = stringField(data, 'error');
      }
      return;
    }
  }

  function list(filter: AgentRegistryFilter = {}): AgentRegistryEntry[] {
    const result: AgentRegistryEntry[] = [];
    for (const entry of entries.values()) {
      if (filter.session_id !== undefined && entry.session_id !== filter.session_id) continue;
      if (filter.state !== undefined && entry.state !== filter.state) continue;
      result.push({ ...entry });
    }
    result.sort(
      (a, b) =>
        (a.started_at ?? 0) - (b.started_at ?? 0) ||
        a.depth - b.depth ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    return result;
  }

  function get(id: string): AgentRegistryEntry | undefined {
    const entry = entries.get(id);
    return entry ? { ...entry } : undefined;
  }

  return { ingest, list, get };
}
