/**
 * InProcessTransport —— 0.2 R3a-core
 *
 * 进程内 Transport：`send` 把消息扇出给所有 `receive` 订阅者；不实现 Host 的
 * inbox / 地址路由语义（那是 Host 的职责）。`peers()` 返回本节点信息。
 *
 * @module @vessel-agent/core/transport
 */

import type { AgentMessage, AgentStatus, PeerInfo, Transport } from '../kernel/types.js';
import type { Unsubscribe } from '../types/event.js';

/** 节点 id 合法字符集（U1/A11） */
const NODE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** InProcessTransport 选项 */
export interface InProcessTransportOptions {
  /** 本节点 id；缺省 'local'；必须匹配 [A-Za-z0-9_-]{1,64} */
  nodeId?: string;
  /** 可选的公开 endpoint（in-process 通常不设置） */
  endpoint?: string;
  /** 本节点当前 agent 视图；缺省 []（由装配层注入） */
  agents?: () => AgentStatus[];
}

/** 进程内 Transport 实现 */
export class InProcessTransport implements Transport {
  readonly kind = 'in-process' as const;
  readonly nodeId: string;

  private readonly endpoint?: string;
  private readonly agentsProvider?: () => AgentStatus[];
  private readonly handlers = new Set<(message: AgentMessage) => void>();
  private closed = false;

  constructor(options: InProcessTransportOptions = {}) {
    const nodeId = options.nodeId ?? 'local';
    if (!NODE_ID_PATTERN.test(nodeId)) {
      throw new Error(`invalid node id "${nodeId}": must match [A-Za-z0-9_-]{1,64}`);
    }
    this.nodeId = nodeId;
    this.endpoint = options.endpoint;
    this.agentsProvider = options.agents;
  }

  async send(message: AgentMessage): Promise<void> {
    if (this.closed) throw new Error('transport is closed');

    for (const handler of [...this.handlers]) {
      try {
        const result: unknown = handler(message);
        // 异步订阅者失败只影响它自己；避免未处理拒绝
        if (result instanceof Promise) {
          void result.catch(() => {});
        }
      } catch {
        // 错误隔离：单个订阅者失败不影响其它订阅者
      }
    }
  }

  receive(handler: (message: AgentMessage) => void): Unsubscribe {
    if (this.closed) throw new Error('transport is closed');
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async peers(): Promise<PeerInfo[]> {
    if (this.closed) return [];
    return [
      {
        nodeId: this.nodeId,
        ...(this.endpoint !== undefined ? { endpoint: this.endpoint } : {}),
        agents: this.agentsProvider?.() ?? [],
        protocol: 1,
      },
    ];
  }

  async close(): Promise<void> {
    this.closed = true;
    this.handlers.clear();
  }
}
