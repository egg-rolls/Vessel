/**
 * agent 调度队列快照（0.15 E4）。
 * @module @vessel-agent/tui
 *
 * 只读 reducer：`agent.queue.entered` 加入，`agent.queue.left` 移除。
 * 缺字段保持 undefined，由展示层显示 unknown；不从其它事件推断位置。
 */

import type { RunEvent } from '@vessel-agent/core';

export interface AgentQueueEntry {
  id: string;
  runId?: string;
  /** 队首为 0（canonical 语义） */
  position?: number;
  /** capacity | per_agent_serial | paused | dependency | quota */
  waitReason?: string;
  since?: number;
}

export interface AgentQueueSnapshot {
  queued: number;
  running: number;
  entries: AgentQueueEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dataOf(event: RunEvent): Record<string, unknown> {
  return isRecord(event.data) ? event.data : {};
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

function baseType(type: string): string {
  let value = type;
  while (value.startsWith('subagent.')) value = value.slice('subagent.'.length);
  return value;
}

function agentIdOf(data: Record<string, unknown>): string | undefined {
  return readString(data, 'agent_id', 'agentId', 'delegate_id', 'delegateId');
}

/** 纯函数：折叠事件历史为当前队列；`running` 由调用方提供的 agent 注册表计数。 */
export function readAgentQueue(events: RunEvent[], running = 0): AgentQueueSnapshot {
  const entries = new Map<string, AgentQueueEntry>();

  for (const event of events) {
    const type = baseType(event.type);
    const data = dataOf(event);
    const agentId = agentIdOf(data);

    if (type === 'agent.queue.entered') {
      if (agentId === undefined) continue;
      const runId = readString(data, 'run_id', 'runId') ?? event.run_id;
      const position = readNumber(data, 'position', 'queue_position', 'queuePosition');
      const waitReason = readString(data, 'wait_reason', 'waitReason');
      const since = readNumber(data, 'since');
      entries.set(agentId, {
        id: agentId,
        ...(runId !== undefined ? { runId } : {}),
        ...(position !== undefined ? { position } : {}),
        ...(waitReason !== undefined ? { waitReason } : {}),
        ...(since !== undefined ? { since } : {}),
      });
      continue;
    }

    if (type === 'agent.queue.left') {
      if (agentId !== undefined) {
        entries.delete(agentId);
        continue;
      }
      const runId = readString(data, 'run_id', 'runId') ?? event.run_id;
      for (const [id, entry] of entries) {
        if (entry.runId === runId) entries.delete(id);
      }
    }
  }

  const list = [...entries.values()].sort((a, b) => {
    const aPosition = a.position ?? Number.MAX_SAFE_INTEGER;
    const bPosition = b.position ?? Number.MAX_SAFE_INTEGER;
    if (aPosition !== bPosition) return aPosition - bPosition;
    const aSince = a.since ?? Number.MAX_SAFE_INTEGER;
    const bSince = b.since ?? Number.MAX_SAFE_INTEGER;
    if (aSince !== bSince) return aSince - bSince;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return { queued: list.length, running, entries: list };
}
