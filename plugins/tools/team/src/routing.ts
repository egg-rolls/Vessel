/**
 * 跨进程寻址与消息路由（R4-4）。
 *
 * - 地址：`nodeId:agentId`（canonical），本机可简写 `agentId`；`*` 仅本机。
 * - 本机优先；简写找不到本机成员时通过 `Transport.peers()` 发现远端。
 * - 跨节点 task/result/cancel 经 `Transport.send`；inbox/status 0.2 仅本机。
 * - 跨进程取消是 `kind='cancel'` 的尽力取消（不等待 ack）。
 *
 * 本文件只依赖 core 公开类型与插件内部 TeamHostPort；不改 core、不改 team 工具面。
 */

import { randomUUID } from 'node:crypto';
import type { AgentMessage, PeerInfo, Transport } from '@vessel/core';
import { type TeamHostPort, toCoreMessage, toLegacyMessage } from './core-adapter.js';
import type { AgentSpec, AgentStatus, InboxPage, TeamMessage } from './host.js';
import {
  requestRemote,
  TEAM_REMOTE_METHODS,
  toRemoteInbox,
  toRemoteStatus,
  toRemoteStatusList,
} from './remote.js';

/** 地址段字符集（DECISION-005 U1） */
const ADDRESS_PART = /^[A-Za-z0-9_-]{1,64}$/;

/** 解析后的地址 */
export interface ParsedAgentAddress {
  /** 显式给出的 nodeId；本机简写时为 undefined */
  nodeId?: string;
  agentId: string;
  /** 是否含 node 前缀 */
  canonical: boolean;
}

/** 解析地址；非法时抛稳定错误 */
export function parseAgentAddress(value: string): ParsedAgentAddress {
  const parts = value.split(':');
  if (parts.length === 1) {
    if (!ADDRESS_PART.test(value)) {
      throw new Error(`invalid agent address: ${value} (expected nodeId:agentId)`);
    }
    return { agentId: value, canonical: false };
  }
  if (parts.length !== 2) {
    throw new Error(`invalid agent address: ${value} (expected nodeId:agentId)`);
  }
  const nodeId = parts[0] ?? '';
  const agentId = parts[1] ?? '';
  if (!ADDRESS_PART.test(nodeId) || !ADDRESS_PART.test(agentId)) {
    throw new Error(`invalid agent address: ${value} (expected nodeId:agentId)`);
  }
  return { nodeId, agentId, canonical: true };
}

/** 路由选项 */
export interface RoutingTeamHostOptions {
  /** 本机 Host 适配器 */
  local: TeamHostPort;
  /** 跨进程传输 */
  transport: Transport;
  /** 本机 nodeId（来自 host.node_id，由 asm 注入） */
  nodeId: string;
  /** owner 的本地 id（默认 'owner'） */
  ownerId: string;
  /** owner 的 canonical 地址（可选；缺省用 `${nodeId}:${ownerId}`） */
  ownerRef?: string;
}

/** 解析结果 */
type ResolvedTarget =
  | { kind: 'local'; agentId: string }
  | { kind: 'remote'; ref: string; agentId: string };

/** 错误文本 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * TeamHostPort 的路由装饰器：
 * 本机消息交给 local；远端消息交给 transport；入站消息解包后回到 local。
 */
export class RoutingTeamHost implements TeamHostPort {
  private readonly local: TeamHostPort;
  private readonly transport: Transport;
  private readonly nodeId: string;
  private readonly ownerId: string;
  private readonly ownerRef: string;
  private readonly unsubscribe: () => void;

  constructor(options: RoutingTeamHostOptions) {
    if (!ADDRESS_PART.test(options.nodeId)) {
      throw new Error(`invalid nodeId: ${options.nodeId} (must match [A-Za-z0-9_-]{1,64})`);
    }
    this.local = options.local;
    this.transport = options.transport;
    this.nodeId = options.nodeId;
    this.ownerId = options.ownerId;
    this.ownerRef = options.ownerRef ?? `${options.nodeId}:${options.ownerId}`;
    this.unsubscribe = this.transport.receive((message) => {
      void this.handleInbound(message).catch(() => {
        // 入站坏消息/本地失败不影响后续消息
      });
    });
  }

  async spawn(spec: AgentSpec, node?: string): Promise<AgentStatus> {
    if (node === undefined || node === this.nodeId) {
      return this.local.spawn(spec);
    }
    this.assertNodeId(node);
    const result = await requestRemote<{ agent?: unknown }>(
      this.transport,
      node,
      TEAM_REMOTE_METHODS.spawn,
      {
        ...(spec.name !== undefined ? { name: spec.name } : {}),
        model: spec.model,
        ...(spec.systemPrompt !== undefined ? { systemPrompt: spec.systemPrompt } : {}),
      },
    );
    return toRemoteStatus(result.agent, node);
  }

  async send(message: TeamMessage): Promise<void> {
    // `*` 仅本机广播：不走 transport，避免跨节点扇出
    if (message.to === '*') {
      await this.local.send(message);
      return;
    }

    const target = await this.resolve(message.to);
    if (target.kind === 'local') {
      await this.local.send({ ...message, to: target.agentId });
      return;
    }

    try {
      await this.transport.send(this.toWire(message, target.ref));
    } catch (error) {
      throw new Error(`transport send failed: ${errorText(error)}`);
    }
  }

  async inbox(id: string, cursor?: string): Promise<InboxPage> {
    const parsed = parseAgentAddress(id);
    if (parsed.nodeId !== undefined && parsed.nodeId !== this.nodeId) {
      this.assertNodeId(parsed.nodeId);
      const result = await requestRemote<unknown>(
        this.transport,
        parsed.nodeId,
        TEAM_REMOTE_METHODS.inbox,
        {
          agentId: parsed.agentId,
          ...(cursor !== undefined && cursor !== '' ? { cursor } : {}),
        },
        { retryOnce: true },
      );
      return toRemoteInbox(result, parsed.nodeId);
    }
    return this.local.inbox(parsed.agentId, cursor);
  }

  async cancel(id: string): Promise<void> {
    const target = await this.resolve(id);
    if (target.kind === 'local') {
      await this.local.cancel(target.agentId);
      return;
    }
    try {
      // 尽力取消：不等待 ack
      await this.transport.send({
        id: randomUUID(),
        from: this.ownerRef,
        to: target.ref,
        kind: 'cancel',
        content: '',
        ts: Date.now(),
      });
    } catch (error) {
      throw new Error(`transport send failed: ${errorText(error)}`);
    }
  }

  async status(id?: string, node?: string): Promise<AgentStatus | AgentStatus[]> {
    if (id === undefined) {
      if (node === undefined || node === this.nodeId) return this.local.status();
      this.assertNodeId(node);
      const result = await requestRemote<unknown>(
        this.transport,
        node,
        TEAM_REMOTE_METHODS.statusList,
        undefined,
        { retryOnce: true },
      );
      return toRemoteStatusList(result, node);
    }

    const parsed = parseAgentAddress(id);
    if (node !== undefined && parsed.nodeId !== undefined && node !== parsed.nodeId) {
      throw new Error(`conflicting node for member ${id}: ${node}`);
    }
    const targetNode = parsed.nodeId ?? node;
    if (targetNode === undefined || targetNode === this.nodeId) {
      return this.local.status(parsed.agentId);
    }
    this.assertNodeId(targetNode);
    const result = await requestRemote<{ agent?: unknown }>(
      this.transport,
      targetNode,
      TEAM_REMOTE_METHODS.status,
      { agentId: parsed.agentId },
      { retryOnce: true },
    );
    return toRemoteStatus(result.agent, targetNode);
  }

  async close(): Promise<void> {
    this.unsubscribe();
    // transport 归 asm 所有，这里不关闭
    await this.local.close();
  }

  /** TeamHostPort.deliver：直接投递（结果/外部消息），本地邮箱不触发 task */
  deliver(message: TeamMessage): Promise<void> {
    return this.deliverResult(message);
  }

  /** 本地成员结果的投递钩子：远端发给 transport，本机交给 local 邮箱 */
  async deliverResult(message: TeamMessage): Promise<void> {
    if (message.to === '*') {
      await this.local.deliver(message);
      return;
    }
    const parsed = parseAgentAddress(message.to);
    if (parsed.nodeId === undefined || parsed.nodeId === this.nodeId) {
      await this.local.deliver({ ...message, to: parsed.agentId });
      return;
    }
    await this.transport.send({
      ...toCoreMessage(message),
      from: this.remoteFrom(message.from),
    });
  }

  /** 入站消息：剥离本机 nodeId 后交给 local */
  private async handleInbound(message: AgentMessage): Promise<void> {
    // 0.2 不支持跨节点广播
    if (message.to === '*') return;
    const parsed = parseAgentAddress(message.to);
    if (parsed.nodeId !== undefined && parsed.nodeId !== this.nodeId) return;

    const target = parsed.agentId;
    if (message.kind === 'cancel') {
      try {
        await this.local.cancel(target);
      } catch {
        // 目标不存在/已结束：尽力取消，忽略
      }
      return;
    }
    const legacy = toLegacyMessage(message);
    legacy.to = target;
    // task 需要触发成员执行；message/result 只投邮箱（owner 可以不是成员）
    if (message.kind === 'task') {
      await this.local.send(legacy);
    } else {
      await this.local.deliver(legacy);
    }
  }

  /** nodeId 校验（canonical 地址段字符集） */
  private assertNodeId(nodeId: string): void {
    if (!ADDRESS_PART.test(nodeId)) {
      throw new Error(`invalid nodeId: ${nodeId} (must match [A-Za-z0-9_-]{1,64})`);
    }
  }

  /** 地址解析：本机优先，再查 peers；歧义/未知返回稳定错误 */
  private async resolve(value: string): Promise<ResolvedTarget> {
    const parsed = parseAgentAddress(value);

    if (parsed.nodeId !== undefined) {
      if (parsed.nodeId === this.nodeId) {
        return { kind: 'local', agentId: parsed.agentId };
      }
      return {
        kind: 'remote',
        ref: `${parsed.nodeId}:${parsed.agentId}`,
        agentId: parsed.agentId,
      };
    }

    if (parsed.agentId === this.ownerId) {
      return { kind: 'local', agentId: parsed.agentId };
    }
    const localStatus = await this.local.status();
    const localMembers = Array.isArray(localStatus) ? localStatus : [localStatus];
    if (localMembers.some((member) => member.id === parsed.agentId)) {
      return { kind: 'local', agentId: parsed.agentId };
    }

    let peers: PeerInfo[] = [];
    try {
      peers = await this.transport.peers();
    } catch {
      // peers 失败只影响远端发现；本机路径已在上方返回
      peers = [];
    }
    const byNode = new Map<string, PeerInfo>();
    for (const peer of peers) {
      if (peer.agents.some((agent) => agent.id === parsed.agentId)) {
        byNode.set(peer.nodeId, peer);
      }
    }
    const matches = [...byNode.values()];
    if (matches.length === 0) {
      throw new Error(`unknown team member: ${value}`);
    }
    if (matches.length > 1) {
      throw new Error(
        `ambiguous team member: ${value} (nodes: ${matches.map((peer) => peer.nodeId).join(', ')})`,
      );
    }
    const nodeId = matches[0]?.nodeId;
    if (nodeId === undefined) throw new Error(`unknown team member: ${value}`);
    return { kind: 'remote', ref: `${nodeId}:${parsed.agentId}`, agentId: parsed.agentId };
  }

  /** 远端消息的 from：本机简写补成 canonical */
  private remoteFrom(from: string): string {
    if (from.includes(':')) return from;
    if (from === this.ownerId) return this.ownerRef;
    return `${this.nodeId}:${from}`;
  }

  /** 远端发送的 wire 形状 */
  private toWire(message: TeamMessage, ref: string): AgentMessage {
    return {
      ...toCoreMessage(message),
      to: ref,
      from: this.remoteFrom(message.from),
    };
  }
}
