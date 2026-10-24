/**
 * 0.21 S8.2：`FederationSendPort` 的 app 层实现。
 *
 * `packages/agent` 只判断地址形式并填 `from`；本模块负责：
 * - 解析 `from` / `to`，`from.node_id` 必须是本机（零请求失败）；
 * - 归一化 federation 配置（token 只留在运行时对象里）；
 * - 调用出站 client 并把结果映射为 port 的三种状态。
 *
 * token 绝不进入 reason / 返回值 / 日志。
 *
 * @module vessel/federation-send-port
 */

import type {
  FederationSendPort,
  FederationSendRequest,
  FederationSendResult,
} from '@vessel-agent/agent';
import type { FederationConfig } from '../packages/config/src/index';
import { parseFederationAddress } from './federation-address';
import {
  FederationClientError,
  type FederationClientIo,
  type FederationPostInput,
  postFederation,
} from './federation-client';
import { resolveFederationOptions } from './federation-config';

export interface FederationSendPortOptions {
  federation: FederationConfig;
  /** 本机节点身份（`resolveNodeId()` 的结果） */
  nodeId: string;
  /** token env 来源；缺省 `process.env`（测试传显式 map） */
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  generateId?: () => string;
}

/**
 * 构造跨节点发送端口。
 *
 * `federation.enabled !== true` 时不抛错：client 会对每次发送返回
 * `federation_disabled` rejected（装配层只在 enabled 时注入，这里是纵深防御）。
 */
export function createFederationSendPort(options: FederationSendPortOptions): FederationSendPort {
  const { options: runtime } = resolveFederationOptions({
    federation: options.federation,
    nodeId: options.nodeId,
    ...(options.env !== undefined ? { env: options.env } : {}),
  });

  const io: FederationClientIo = {
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.generateId !== undefined ? { generateId: options.generateId } : {}),
  };

  return {
    nodeId: options.nodeId,
    async send(input: FederationSendRequest): Promise<FederationSendResult> {
      const from = parseFederationAddress(input.from);
      if (!from.ok) {
        return {
          status: 'rejected',
          code: from.code,
          reason: `federation from address is invalid: ${from.message}`,
        };
      }
      const to = parseFederationAddress(input.to);
      if (!to.ok) {
        return {
          status: 'rejected',
          code: to.code,
          reason: `federation to address is invalid: ${to.message}`,
        };
      }
      // 本机身份只由 options.nodeId 决定；agent 层已按此构造 from，这里再守一次。
      if (from.address.node_id !== options.nodeId) {
        return {
          status: 'rejected',
          code: 'federation_invalid',
          reason: 'federation from node_id does not match this node',
        };
      }

      const request: FederationPostInput = {
        from: from.address,
        to: to.address,
        content: input.content,
        ...(input.conversation_id !== undefined ? { conversation_id: input.conversation_id } : {}),
      };

      try {
        const result = await postFederation(runtime, request, io);
        if (result.status !== 'rejected') {
          return { status: 'queued', message_id: result.message_id };
        }
        return {
          status: 'rejected',
          code: result.remote_code ?? result.code,
          reason: result.reason,
        };
      } catch (error) {
        if (error instanceof FederationClientError) {
          return { status: 'error', code: error.code, reason: error.message };
        }
        return {
          status: 'error',
          code: 'federation_error',
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
