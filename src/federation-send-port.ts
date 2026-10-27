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
import {
  parseFederationAddress,
  type ResolveNodeAliases,
  resolveAddress,
} from './federation-address';
import {
  FederationClientError,
  type FederationClientIo,
  type FederationPostInput,
  postFederation,
} from './federation-client';
import { resolveFederationOptions } from './federation-config';
import type { LocalHumanTarget } from './team-human-delivery';

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
  /**
   * 本机人类投递（0.27）：`human@<本机 node>:<team>` 直接写本机 Team 日志。
   *
   * 晚绑定 getter：本机 Team 服务在本端口之后才构造。缺省 / 返回 `undefined` 时
   * 一切行为与没有这个特判完全一致（fail-safe）。
   */
  localHuman?: () => LocalHumanTarget | undefined;
  /**
   * 本机展示名（`node.json` / `host.node_name` / hostname 派生）。
   *
   * 只用于把指向本机的 `to` 地址归一化 —— 展示名不是全局唯一标识，不能用来指向
   * 别的节点。缺省时不认展示名别名，只认 `nodeId`。
   */
  nodeName?: string;
}

/** 从全形 `from` 地址取发送者所属 Team（本机人类地址省略 team 段时的兜底）。 */
function callerTeamId(from: string): string | undefined {
  const parsed = parseFederationAddress(from);
  return parsed.ok ? parsed.address.team_id : undefined;
}

/** 错误对象上的稳定 code（TeamError / Node 错误都有）。 */
function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code !== '' ? code : undefined;
}

/** 本机人类投递失败时的兜底 code（底层没有 code 才用）。 */
const LOCAL_HUMAN_DELIVERY_FAILED = 'local_human_delivery_failed';

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
      const localHuman = options.localHuman?.();
      /**
       * 「是不是本机」只在这里判断一次（`resolveAddress` 是唯一实现）。
       *
       * `from` 由 agent 层构造，恒为 `<name>@<本机 nodeId>:<team>`；`node` 别名只
       * 用于解析 `to`，不放大到 `from` —— 否则一个节点可以借展示名冒充别人。
       */
      const local: ResolveNodeAliases = {
        nodeId: options.nodeId,
        ...(options.nodeName !== undefined ? { name: options.nodeName } : {}),
      };

      const from = parseFederationAddress(input.from);
      if (!from.ok) {
        return {
          status: 'rejected',
          code: from.code,
          reason: `federation from address is invalid: ${from.message}`,
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

      const to = resolveAddress(input.to, local);
      if (to.kind === 'invalid') {
        return {
          status: 'rejected',
          code: to.code,
          reason: `federation to address is invalid: ${to.message}`,
        };
      }

      // 本机人类：简化地址（`human` / `human@<team>`）或 node 段指向本机的全形地址。
      // 直接写本机 Team 日志，不查 allowlist、不发网络请求、不唤醒任何成员。
      if (to.kind === 'local_human') {
        // 没有 team 段时退回调用者自己的 Team（agent 层只会对自己 Team 的成员这么发）。
        const teamId = to.team_id ?? callerTeamId(input.from);
        if (teamId === undefined) {
          return {
            status: 'rejected',
            code: 'no_team',
            reason: 'local human address needs a team segment or a team-bound sender',
          };
        }
        if (localHuman === undefined) {
          return {
            status: 'rejected',
            code: 'human_unreachable',
            reason: 'local human delivery is not available on this node',
          };
        }
        try {
          const { message_id } = await localHuman.deliver({
            team_id: teamId,
            from: input.from,
            content: input.content,
            ...(input.conversation_id !== undefined
              ? { conversation_id: input.conversation_id }
              : {}),
          });
          return { status: 'queued', message_id };
        } catch (error) {
          return {
            status: 'error',
            code: errorCodeOf(error) ?? LOCAL_HUMAN_DELIVERY_FAILED,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      }

      // 全形地址且 node 段指向本机的成员：这是本机投递，跨节点发出去会回环。
      // 明确拒绝并给出可用形式，而不是交给 allowlist 谎报「没有 outbound peer」。
      if (to.kind === 'local_member') {
        return {
          status: 'rejected',
          code: 'local_member_address',
          reason:
            `cannot federate to this node; send to "${to.principal}" directly ` +
            '(members are addressed by id or name on the local node)',
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
