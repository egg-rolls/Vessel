/**
 * node 监听地址解析与 /health 探活（q-health-subscription 从 gateway-command 抽出）。
 *
 * 为什么单独一个叶模块：这些 helper 原先住在 CLI 命令模块里，运行时侧的
 * node-health-watch（订阅健康探测）也要用同一套「活进程记录优先于配置」的口径；
 * 让 runtime import CLI 命令模块会把整条 CLI 依赖图拉进运行时（且易成环）。
 * 抽到只依赖 config / pid / reload / core 的叶模块，两侧共用**同一份实现**
 * （不复制第二套）；gateway-command 原样 re-export，既有消费者零变化。
 *
 * @module vessel/gateway/node-listen
 */

import { withDeadline } from '@vessel-agent/core';
import {
  DEFAULT_SERVE_OPTIONS,
  resolveGatewayNodePorts,
  type VesselConfig,
} from '../../packages/config/src/index';
import { type GatewayPidRecord, isProcessAlive, readGatewayPidRecord } from './pid';
import { gatewayBaseUrl } from './reload';

/** node 监听描述（0.49 G1：`serve.port` 显式值，否则 8644）。 */
export interface NodeListenInfo {
  host: string;
  port: number;
  url: string;
}

export function nodeListenFromConfig(config: VesselConfig): NodeListenInfo {
  const host = (config.node?.hostname ?? DEFAULT_SERVE_OPTIONS.hostname).trim();
  const { nodePort } = resolveGatewayNodePorts(config, 'gateway');
  const url = gatewayBaseUrl(
    {
      pid: 0,
      started_at: new Date(0).toISOString(),
      host,
      port: nodePort,
      version: '0',
    },
    config.node?.tls !== undefined,
  );
  return { host, port: nodePort, url };
}

/**
 * 「活进程自己写的地址」优先于「配置推出来的地址」。
 *
 * 依据：`<nodeDataDir>/gateway.pid` 是那个**正在跑的进程自己**落的监听地址。
 * adopt 探活、`gateway status` 的节点投影、平台代理的 `api_url` 都必须打「实际在跑的
 * 那一个」，否则配置与记录不一致时（换过 `node.port`、换过 cwd/project 配置重启、
 * 端口被系统分配过）会出现两个后果：
 * - 探活打到**别人的进程**上，健康回包里的 `node_id` 不是本节点 ⇒ supervisor 把活着
 *   的节点标 `node_identity_mismatch` / `failed`，平台在却没有任何可用节点（用户看到
 *   的就是「进程还在，但什么都不动」）；
 * - 状态页把别人的 node 显示成「自己的 node up」。
 *
 * 只在记录**活着**且 `node_id` 不冲突时采用；其余一律回落到配置（不猜、不改记录）。
 */
export async function preferLiveNodeListen(
  nodeDataDir: string,
  fallback: NodeListenInfo,
  options: { nodeId?: string; tls?: boolean } = {},
): Promise<{ listen: NodeListenInfo; source: 'record' | 'config'; pid?: number }> {
  // benign: pid record 探针——读不出/进程不活回落 config（source 标注）。
  const record = await readGatewayPidRecord(nodeDataDir).catch(() => null);
  if (record === null || !isProcessAlive(record.pid)) {
    return { listen: fallback, source: 'config' };
  }
  if (
    options.nodeId !== undefined &&
    record.node_id !== undefined &&
    record.node_id !== options.nodeId
  ) {
    // 记录属于另一个 node（身份冲突）：不采用，留给既有 node_identity_mismatch 判据。
    return { listen: fallback, source: 'config' };
  }
  if (!Number.isInteger(record.port) || record.port <= 0) {
    return { listen: fallback, source: 'config' };
  }
  const host = record.host.trim() === '' ? fallback.host : record.host;
  return {
    listen: {
      host,
      port: record.port,
      url: gatewayBaseUrl(
        { pid: record.pid, started_at: record.started_at, host, port: record.port, version: '0' },
        options.tls === true,
      ),
    },
    source: 'record',
    pid: record.pid,
  };
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 读取任意 PID 记录指向端口的 `/health`（GET，不发送 token）。
 * 0.49 G1：gateway 拆分模式的记录 host/port 是 **platform** 监听。
 */
export async function probeHttpHealth(
  record: GatewayPidRecord,
  timeoutMs = 800,
  tls = false,
): Promise<Record<string, unknown> | undefined> {
  try {
    // 0.64：探活/停服的 CLI 路径没有别的定时器陪着，`AbortSignal.timeout` 在 bun 1.3.9
    // 上可能不触发 ⇒ 换会真正触发的截止时间。
    const response = await withDeadline(timeoutMs, async (signal) =>
      fetch(`${gatewayBaseUrl(record, tls)}/health`, { signal }),
    );
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    return isRecordValue(body) ? body : undefined;
  } catch {
    return undefined;
  }
}
