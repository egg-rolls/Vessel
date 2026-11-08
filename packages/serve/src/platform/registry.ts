/**
 * 0.49 G1：node registry 投影。
 *
 * 只做 `GET ${apiUrl}/health` 的短超时探测与内存 last_seen；不持久化、
 * 不 import node runtime、不读取 token。探测失败只影响 status，不影响启动。
 *
 * @module @vessel-agent/serve/platform/registry
 */

import type { PlatformNodeDescriptor, PlatformNodeStatus, PlatformNodeSummary } from './types.js';

/** 单次健康探测上限（契约 §4：≤1s）。 */
const PROBE_TIMEOUT_MS = 1000;

/** `platform.nodes.get` 无匹配；RPC 层映射为 `node_not_found` 404。 */
export class PlatformNodeNotFoundError extends Error {
  constructor() {
    super('Node not found');
    this.name = 'PlatformNodeNotFoundError';
  }
}

export interface PlatformRegistry {
  /** 探测全部 node 并返回投影；顺序与注入的 descriptor 一致。 */
  list(): Promise<PlatformNodeSummary[]>;
  /** 按 node_id 探测单个 node；缺省且只有一个 node 时返回它。 */
  get(nodeId?: string): Promise<PlatformNodeSummary>;
  /** 注入的 descriptor 数量（`platform.health.get` 用，不做探测）。 */
  count(): number;
}

interface ProbeResult {
  status: PlatformNodeStatus;
  version?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function healthUrl(apiUrl: string): string | null {
  try {
    const base = apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`;
    return new URL('health', base).toString();
  } catch {
    return null;
  }
}

async function probeHealth(descriptor: PlatformNodeDescriptor): Promise<ProbeResult> {
  const url = healthUrl(descriptor.apiUrl);
  if (url === null) return { status: 'down' };
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (response.status < 200 || response.status >= 300) return { status: 'down' };
    // `/health` 不保证返回 JSON 或 version；解析失败不影响 up。
    let version = descriptor.version;
    try {
      const body: unknown = await response.json();
      // CONTRACT §4.5：平台监听也可能落在该端口；带 `role:"platform"` 的不是 node。
      if (isRecord(body) && body.role === 'platform') return { status: 'down' };
      if (isRecord(body) && typeof body.version === 'string') {
        version = body.version;
      }
    } catch {
      // 忽略非 JSON 响应；descriptor.version 作为回退。
    }
    return version === undefined ? { status: 'up' } : { status: 'up', version };
  } catch {
    // 连接失败 / 超时 / abort 统一视为 down；错误体不回显凭据。
    return { status: 'down' };
  }
}

export function createPlatformRegistry(nodes: PlatformNodeDescriptor[]): PlatformRegistry {
  const lastSeen = new Map<string, number>();

  async function summaryOf(descriptor: PlatformNodeDescriptor): Promise<PlatformNodeSummary> {
    const probe = await probeHealth(descriptor);
    if (probe.status === 'up') lastSeen.set(descriptor.nodeId, Date.now());
    const summary: PlatformNodeSummary = {
      node_id: descriptor.nodeId,
      name: descriptor.name,
      api_url: descriptor.apiUrl,
      status: probe.status,
    };
    const seen = lastSeen.get(descriptor.nodeId);
    if (seen !== undefined) summary.last_seen = seen;
    const version = probe.version ?? descriptor.version;
    if (version !== undefined) summary.version = version;
    return summary;
  }

  return {
    async list(): Promise<PlatformNodeSummary[]> {
      return Promise.all(nodes.map((node) => summaryOf(node)));
    },
    async get(nodeId?: string): Promise<PlatformNodeSummary> {
      if (nodeId === undefined) {
        if (nodes.length !== 1) throw new PlatformNodeNotFoundError();
        return summaryOf(nodes[0] as PlatformNodeDescriptor);
      }
      const match = nodes.find((node) => node.nodeId === nodeId);
      if (match === undefined) throw new PlatformNodeNotFoundError();
      return summaryOf(match);
    },
    count(): number {
      return nodes.length;
    },
  };
}
