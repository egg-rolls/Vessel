/**
 * 本机 peer 文件注册表（R3）
 *
 * 每个节点在 `<peersDir>/<nodeId>.json` 写一份记录；原子写 + 心跳 + TTL。
 * 只服务 loopback（127.0.0.1）；不依赖 Unix socket/named pipe，Windows 同样可用。
 * 目录不可写时降级为 local-only（kind 仍是 loopback，peers 为空），不抛异常。
 *
 * 注册表**不写 token**（DECISION-005 U7）。
 *
 * @module @vessel/serve/transport
 */

import { chmod, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentStatus, PeerInfo } from '@vessel/core';
import { PROTOCOL_VERSION } from '../protocol.js';
import { toWireAgentStatus, type WireAgentStatus } from '../team.js';

/** 注册表文件记录（snake_case，内部格式） */
export interface PeerFileRecord {
  protocol: typeof PROTOCOL_VERSION;
  node_id: string;
  pid: number;
  endpoint: string;
  started_at: number;
  heartbeat_at: number;
  agents: WireAgentStatus[];
}

export interface PeerRegistryOptions {
  nodeId: string;
  endpoint: string;
  peersDir: string;
  heartbeatMs?: number;
  peerTtlMs?: number;
  /** 本节点成员快照（写入注册表） */
  agents?: () => AgentStatus[];
  /** @internal 测试注入：真正落盘前等待；生产不使用 */
  beforeWrite?: () => void | Promise<void>;
}

const NODE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_PEER_TTL_MS = 15_000;

/** endpoint 必须是回环 HTTP(S) */
export function isLoopbackEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

/** PID 是否存活；ESRCH = 不存在，EPERM = 存在但无权限 */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 把 wire 状态转回 core 结构 */
function fromWireAgentStatus(status: WireAgentStatus): AgentStatus {
  return {
    id: status.id,
    ...(status.name !== undefined ? { name: status.name } : {}),
    state: status.state,
    ...(status.current_run_id !== undefined ? { currentRunId: status.current_run_id } : {}),
    toolNames: status.tool_names,
    ...(status.last_error !== undefined ? { lastError: status.last_error } : {}),
  };
}

/** 原子写：temp + rename（Windows 失败时回退为直接覆盖） */
async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, 'utf8');
  try {
    await rename(tmp, path);
    return;
  } catch {
    // Windows 某些文件系统不允许 rename 覆盖；退化为直接写。
    try {
      await writeFile(path, content, 'utf8');
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }
}

/** 本机 peer 注册表 */
export class PeerRegistry {
  private readonly options: PeerRegistryOptions;
  private readonly startedAt = Date.now();
  private readonly heartbeatMs: number;
  private readonly peerTtlMs: number;
  private readonly ownPath: string;
  private remote = new Map<string, PeerInfo>();
  private timer: ReturnType<typeof setInterval> | undefined;
  /** 正在执行的 tick；stop() 必须等它结束再删自己的记录 */
  private inFlight: Promise<void> | undefined;
  private closed = false;
  private _degraded = false;
  private _lastError: string | undefined;

  private constructor(options: PeerRegistryOptions) {
    this.options = options;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.peerTtlMs = options.peerTtlMs ?? DEFAULT_PEER_TTL_MS;
    this.ownPath = join(options.peersDir, `${options.nodeId}.json`);
  }

  /** 创建实例；目录不可写不抛（R7） */
  static async create(options: PeerRegistryOptions): Promise<PeerRegistry> {
    const registry = new PeerRegistry(options);
    await registry.prepare();
    return registry;
  }

  get degraded(): boolean {
    return this._degraded;
  }

  get lastError(): string | undefined {
    return this._lastError;
  }

  private async prepare(): Promise<void> {
    if (!NODE_ID_PATTERN.test(this.options.nodeId)) {
      this.markDegraded(`invalid node_id: ${this.options.nodeId}`);
      return;
    }
    if (!isLoopbackEndpoint(this.options.endpoint)) {
      this.markDegraded(`endpoint is not loopback: ${this.options.endpoint}`);
      return;
    }
    try {
      await mkdir(this.options.peersDir, { recursive: true, mode: 0o700 });
      await chmod(this.options.peersDir, 0o700).catch(() => {});
    } catch (error) {
      this.markDegraded(`cannot create peers dir: ${this.errorMessage(error)}`);
    }
  }

  /** 写自己的记录、开始心跳与扫描 */
  async start(): Promise<void> {
    if (this.closed || this._degraded) return;
    await this.runTick();
    if (this.closed || this._degraded) return;
    this.timer = setInterval(() => {
      void this.runTick();
    }, this.heartbeatMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /**
   * 停止心跳并删除自己的注册文件；不抛。
   * 先等 in-flight tick 结束，避免已进入 writeSelf 的 tick 在 unlink 之后把文件写回来。
   */
  async stop(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const pending = this.inFlight;
    if (pending) await pending.catch(() => {});
    await unlink(this.ownPath).catch(() => {});
  }

  /** 本节点 + 存活 peer（含自己） */
  peers(): PeerInfo[] {
    return [this.selfPeerInfo(), ...this.remote.values()];
  }

  /** 按 nodeId 查 peer（含自己） */
  get(nodeId: string): PeerInfo | undefined {
    if (nodeId === this.options.nodeId) return this.selfPeerInfo();
    return this.remote.get(nodeId);
  }

  /**
   * 立即重扫注册表（P1-2）。
   * 发送前缓存未命中时调用，避免「对方文件已存在但本地还没扫到」的启动竞态。
   * 失败只记录，不抛；调用方仍按正常路径处理 peer_not_found。
   */
  async refresh(): Promise<void> {
    if (this.closed || this._degraded) return;
    try {
      await this.scan();
    } catch (error) {
      this._lastError = this.errorMessage(error);
    }
  }

  private selfPeerInfo(): PeerInfo {
    return {
      nodeId: this.options.nodeId,
      endpoint: this.options.endpoint,
      agents: this.safeAgents(),
      protocol: PROTOCOL_VERSION,
    };
  }

  private safeAgents(): AgentStatus[] {
    try {
      return this.options.agents?.() ?? [];
    } catch {
      return [];
    }
  }

  /** 同一时刻只允许一个 tick；返回的 promise 在 tick 与清理都完成后才 resolve */
  private runTick(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    let tracked: Promise<void>;
    const base = this.tick();
    tracked = base.finally(() => {
      if (this.inFlight === tracked) this.inFlight = undefined;
    });
    this.inFlight = tracked;
    return tracked;
  }

  private async tick(): Promise<void> {
    if (this.closed || this._degraded) return;
    try {
      await this.writeSelf();
      await this.scan();
    } catch (error) {
      // 单次心跳失败不终止；连续失败由 degraded 标记（写失败时写入）。
      this._lastError = this.errorMessage(error);
    }
  }

  private async writeSelf(): Promise<void> {
    // 写前二次检查：tick 排队后 stop() 可能已经执行。
    if (this.closed) return;
    const record: PeerFileRecord = {
      protocol: PROTOCOL_VERSION,
      node_id: this.options.nodeId,
      pid: process.pid,
      endpoint: this.options.endpoint,
      started_at: this.startedAt,
      heartbeat_at: Date.now(),
      agents: this.safeAgents().map(toWireAgentStatus),
    };
    try {
      await this.options.beforeWrite?.();
      await atomicWrite(this.ownPath, `${JSON.stringify(record)}\n`);
      await chmod(this.ownPath, 0o600).catch(() => {});
    } catch (error) {
      this.markDegraded(`cannot write peer record: ${this.errorMessage(error)}`);
    }
  }

  private async scan(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.options.peersDir);
    } catch (error) {
      this.markDegraded(`cannot read peers dir: ${this.errorMessage(error)}`);
      return;
    }

    const now = Date.now();
    const next = new Map<string, PeerInfo>();
    for (const name of entries) {
      if (!name.endsWith('.json') || name === `${this.options.nodeId}.json`) continue;
      const path = join(this.options.peersDir, name);
      const peer = await this.readPeer(path);
      if (!peer) continue;
      const heartbeatAt = peer.heartbeatAt;
      if (now - heartbeatAt > this.peerTtlMs || !pidAlive(peer.pid)) {
        // 同机 stale 记录：尽力清理，失败不影响扫描。
        await unlink(path).catch(() => {});
        continue;
      }
      next.set(peer.info.nodeId, peer.info);
    }
    this.remote = next;
  }

  private async readPeer(
    path: string,
  ): Promise<{ info: PeerInfo; pid: number; heartbeatAt: number } | null> {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      return null;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!value || typeof value !== 'object') return null;
    const record = value as Partial<PeerFileRecord>;
    if (record.protocol !== 1) return null;
    if (typeof record.node_id !== 'string' || !NODE_ID_PATTERN.test(record.node_id)) return null;
    if (typeof record.endpoint !== 'string' || !isLoopbackEndpoint(record.endpoint)) return null;
    if (typeof record.pid !== 'number' || typeof record.heartbeat_at !== 'number') return null;
    const agents = Array.isArray(record.agents)
      ? record.agents.filter(isWireAgentStatus).map(fromWireAgentStatus)
      : [];
    return {
      info: {
        nodeId: record.node_id,
        endpoint: record.endpoint,
        agents,
        protocol: PROTOCOL_VERSION,
      },
      pid: record.pid,
      heartbeatAt: record.heartbeat_at,
    };
  }

  private markDegraded(message: string): void {
    this._degraded = true;
    this._lastError = message;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

/** wire 状态结构检查 */
function isWireAgentStatus(value: unknown): value is WireAgentStatus {
  if (!value || typeof value !== 'object') return false;
  const status = value as Partial<WireAgentStatus>;
  return (
    typeof status.id === 'string' &&
    typeof status.state === 'string' &&
    Array.isArray(status.tool_names)
  );
}

/** 确保 peers 目录存在（供 asm 预检；不作为启动门禁） */
export async function ensurePeersDir(peersDir: string): Promise<boolean> {
  try {
    await mkdir(peersDir, { recursive: true, mode: 0o700 });
    return true;
  } catch {
    return false;
  }
}
