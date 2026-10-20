/**
 * 静态节点注册表（0.6 F5 / DECISION-014 B2）
 *
 * - 节点来自 `transport.nodes[]`；不共享文件系统，不做 mDNS/自动发现。
 * - token：显式 token > token_env；非回环节点 token 为空则拒绝。
 * - CA：ca_file 读取为 PEM，供 HTTP/WS 客户端显式信任。
 * - 心跳：GET `/v1/team/agents`（失败回退 `/health`）；`healthy|unreachable`。
 *
 * token 永不打印、不写入 PeerInfo。
 *
 * @module vessel/node-registry
 */

import { isLoopbackHostname, type TransportNodeConfig } from '../packages/config/src/index';
import type { AgentState, AgentStatus, PeerInfo } from '../packages/core/src/index';

/** 节点健康状态（与 core PeerInfo.status 对齐） */
export type NodeStatus = 'healthy' | 'unreachable';

const NODE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const AGENT_STATES = new Set<AgentState>(['idle', 'running', 'cancelled', 'error', 'closed']);
const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_PEER_TTL_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** 解析后的节点；token/ca 敏感字段只在传输层使用 */
export interface ResolvedNode {
  id: string;
  url: string;
  token: string;
  ca?: string;
  status: NodeStatus;
  lastSeen?: number;
  agents: AgentStatus[];
  /** 对端进程代际（0.9；由 WS hello 学习）；未知时省略 */
  incarnation?: string;
}

/** PeerInfo + 0.9 additive 代际字段（旧消费方按 `-` 处理缺失） */
export interface PeerInfoWithIncarnation extends PeerInfo {
  incarnation?: string;
}

export interface NodeRegistryOptions {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  /** 心跳间隔（默认 5000ms；0 = 不启动自动心跳） */
  heartbeatMs?: number;
  /** 节点失效 TTL（默认 15000ms；仅用于展示，不主动清除） */
  peerTtlMs?: number;
  /** 单次探测超时（默认 10000ms） */
  requestTimeoutMs?: number;
  /** 测试注入 CA 读取（默认 Bun.file） */
  readFile?: (path: string) => Promise<string>;
}

type FetchInit = RequestInit & { tls?: { ca: string } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 校验并归一化节点 URL；非回环必须 https，禁止 path/query/hash/userinfo。 */
export function normalizeNodeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid node url "${raw}": expected an absolute http(s) URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`invalid node url "${raw}": must use http or https`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(`invalid node url "${raw}": must not contain userinfo`);
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error(`invalid node url "${raw}": must not contain a path`);
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error(`invalid node url "${raw}": must not contain query or hash`);
  }
  if (!isLoopbackHostname(url.hostname) && url.protocol !== 'https:') {
    throw new Error(`invalid node url "${raw}": non-loopback nodes must use https`);
  }
  return url.origin;
}

/** gateway wire AgentStatus（snake_case）→ core AgentStatus */
export function wireToAgentStatus(raw: unknown): AgentStatus | undefined {
  if (!isRecord(raw)) return undefined;
  const id = raw.id;
  const state = raw.state;
  if (typeof id !== 'string' || id === '') return undefined;
  if (typeof state !== 'string' || !AGENT_STATES.has(state as AgentState)) return undefined;
  const toolNames = Array.isArray(raw.tool_names)
    ? raw.tool_names.filter((name): name is string => typeof name === 'string')
    : [];
  return {
    id,
    ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
    state: state as AgentState,
    ...(typeof raw.current_run_id === 'string' ? { currentRunId: raw.current_run_id } : {}),
    toolNames,
    ...(typeof raw.last_error === 'string' ? { lastError: raw.last_error } : {}),
  };
}

/** 从 `/v1/team/agents` 响应提取 AgentStatus[] */
function parseAgents(body: unknown): AgentStatus[] {
  if (!isRecord(body) || !Array.isArray(body.agents)) return [];
  const agents: AgentStatus[] = [];
  for (const item of body.agents) {
    const agent = wireToAgentStatus(item);
    if (agent) agents.push(agent);
  }
  return agents;
}

/** 静态节点注册表 */
export class NodeRegistry {
  private readonly entries = new Map<string, ResolvedNode>();
  private readonly fetchImpl: typeof fetch;
  private readonly heartbeatMs: number;
  private readonly peerTtlMs: number;
  private readonly requestTimeoutMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private probing: Promise<void> | undefined;
  private stopped = false;

  private constructor(entries: ResolvedNode[], options: NodeRegistryOptions) {
    for (const entry of entries) this.entries.set(entry.id, entry);
    this.fetchImpl = options.fetch ?? fetch;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.peerTtlMs = options.peerTtlMs ?? DEFAULT_PEER_TTL_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /**
   * 校验配置、解析 token/CA，返回注册表。
   * 非法节点（重复 id/URL/缺 token）直接抛错；错误信息不含 token。
   */
  static async create(
    nodes: TransportNodeConfig[],
    options: NodeRegistryOptions = {},
  ): Promise<NodeRegistry> {
    if (!Array.isArray(nodes) || nodes.length === 0) {
      throw new Error('transport.kind=remote requires at least one transport.nodes entry');
    }
    const env = options.env ?? process.env;
    const readFile = options.readFile ?? ((path: string) => Bun.file(path).text());
    const entries: ResolvedNode[] = [];
    const seen = new Set<string>();

    for (const raw of nodes) {
      if (!isRecord(raw)) throw new Error('transport.nodes entries must be objects');
      const id = raw.id;
      if (typeof id !== 'string' || !NODE_ID_RE.test(id)) {
        throw new Error(`invalid transport node id: ${String(id)}`);
      }
      if (seen.has(id)) throw new Error(`duplicate transport node id: ${id}`);
      seen.add(id);

      if (typeof raw.url !== 'string' || raw.url === '') {
        throw new Error(`transport node "${id}" requires url`);
      }
      const url = normalizeNodeUrl(raw.url);

      const token =
        (typeof raw.token === 'string' && raw.token !== '' ? raw.token : undefined) ??
        (typeof raw.tokenEnv === 'string' && raw.tokenEnv !== '' ? env[raw.tokenEnv] : undefined) ??
        '';
      if (!isLoopbackHostname(new URL(url).hostname) && token === '') {
        throw new Error(
          `transport node "${id}" requires a token for non-loopback access (token or token_env)`,
        );
      }

      let ca: string | undefined;
      if (raw.caFile !== undefined) {
        if (typeof raw.caFile !== 'string' || raw.caFile.trim() === '') {
          throw new Error(`transport node "${id}" ca_file must be a non-empty string`);
        }
        try {
          ca = await readFile(raw.caFile);
        } catch {
          throw new Error(`cannot read CA file for node "${id}": ${raw.caFile}`);
        }
        if (ca.trim() === '') {
          throw new Error(`CA file for node "${id}" is empty: ${raw.caFile}`);
        }
      }

      entries.push({
        id,
        url,
        token,
        ...(ca !== undefined ? { ca } : {}),
        status: 'unreachable',
        agents: [],
      });
    }

    return new NodeRegistry(entries, options);
  }

  /** 全部节点（快照） */
  list(): ResolvedNode[] {
    return [...this.entries.values()].map((entry) => ({
      ...entry,
      ...(entry.ca !== undefined ? { ca: entry.ca } : {}),
      agents: [...entry.agents],
    }));
  }

  /** 节点 id 列表（不含本机由调用方过滤） */
  ids(): string[] {
    return [...this.entries.keys()];
  }

  get(id: string): ResolvedNode | undefined {
    return this.entries.get(id);
  }

  /** core Transport.peers() 形状；不暴露 token/ca。0.9：附带已学习的对端代际。 */
  peers(): PeerInfoWithIncarnation[] {
    return [...this.entries.values()].map((entry) => ({
      nodeId: entry.id,
      endpoint: entry.url,
      agents: entry.agents,
      protocol: 1,
      status: entry.status,
      ...(entry.lastSeen !== undefined ? { lastSeen: entry.lastSeen } : {}),
      ...(entry.incarnation !== undefined ? { incarnation: entry.incarnation } : {}),
    }));
  }

  /** 0.9：记录 WS hello 学到的对端代际；`-` 表示旧对端未知，不覆盖已知值。 */
  markIncarnation(id: string, incarnation: string): void {
    const entry = this.entries.get(id);
    if (!entry || incarnation === '' || incarnation === '-') return;
    entry.incarnation = incarnation;
  }

  markHealthy(id: string, agents?: AgentStatus[]): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.status = 'healthy';
    entry.lastSeen = Date.now();
    if (agents !== undefined) entry.agents = agents;
  }

  markUnreachable(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.status = 'unreachable';
  }

  /** 探测单个节点；失败只更新状态，不抛错 */
  async probe(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || this.stopped) return;
    const agents = await this.probeAgents(entry);
    if (agents !== undefined) {
      this.markHealthy(id, agents);
      return;
    }
    const healthy = await this.probeHealth(entry);
    if (healthy) {
      this.markHealthy(id);
      return;
    }
    this.markUnreachable(id);
  }

  /** 立即探测全部节点（并发） */
  async refresh(): Promise<void> {
    await Promise.all(this.ids().map((id) => this.probe(id)));
  }

  /** 启动心跳；重复调用无副作用 */
  start(): void {
    if (this.timer !== undefined || this.stopped || this.heartbeatMs <= 0) return;
    void this.refresh();
    this.timer = setInterval(() => {
      if (this.probing) return;
      this.probing = this.refresh().finally(() => {
        this.probing = undefined;
      });
    }, this.heartbeatMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** 停止心跳；不影响已在途请求 */
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 展示用 TTL：超过 peerTtlMs 未成功的节点标记为 unreachable */
  isStale(entry: ResolvedNode): boolean {
    return entry.lastSeen !== undefined && Date.now() - entry.lastSeen > this.peerTtlMs;
  }

  private async probeAgents(entry: ResolvedNode): Promise<AgentStatus[] | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const init: FetchInit = {
        method: 'GET',
        headers: entry.token !== '' ? { Authorization: `Bearer ${entry.token}` } : {},
        signal: controller.signal,
      };
      if (entry.ca !== undefined) init.tls = { ca: entry.ca };
      const response = await this.fetchImpl(`${entry.url}/v1/team/agents`, init as RequestInit);
      if (response.status !== 200) return undefined;
      return parseAgents(await response.json());
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  private async probeHealth(entry: ResolvedNode): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const init: FetchInit = { method: 'GET', signal: controller.signal };
      if (entry.ca !== undefined) init.tls = { ca: entry.ca };
      const response = await this.fetchImpl(`${entry.url}/health`, init as RequestInit);
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
