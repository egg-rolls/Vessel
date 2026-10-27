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
  FederationAddressPlacement,
  FederationAgentCandidate,
  FederationLookupResult,
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
  FEDERATION_TEAM_INFO_MAX_LIMIT,
  FederationClientError,
  type FederationClientIo,
  type FederationPostInput,
  postFederation,
  postFederationTeamInfo,
} from './federation-client';
import { resolveFederationOptions } from './federation-config';
import type { LocalHumanTarget, LocalMemberTarget } from './team-human-delivery';

export interface FederationSendPortOptions {
  federation: FederationConfig;
  /** 本机节点身份（`resolveNodeId()` 的结果） */
  nodeId: string;
  /** token env 来源；缺省 `process.env`（测试传显式 map） */
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 裸名跨节点查找的**总**预算（缺省 2000ms）；不是每个 peer 各等一次。 */
  lookupTimeoutMs?: number;
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
   * 本机成员投递（0.27）：node 段命中本机的地址直接交给本机 Team 层。
   *
   * 与 `localHuman` 同形的晚绑定 getter，理由也一样：Team 服务在本端口之后才
   * 构造。**不 import Team 层** —— port 只声明「怎么投」，不依赖谁实现。
   */
  localMember?: () => LocalMemberTarget | undefined;
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

/** 本机成员投递失败时的兜底 code（底层没有 code 才用）。 */
const LOCAL_MEMBER_DELIVERY_FAILED = 'local_member_delivery_failed';

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
    resolve(to: string): FederationAddressPlacement {
      const placement = resolveAddress(to, {
        nodeId: options.nodeId,
        ...(options.nodeName !== undefined ? { name: options.nodeName } : {}),
      });
      switch (placement.kind) {
        case 'local_human':
          return placement.team_id === undefined
            ? { kind: 'local_human' }
            : { kind: 'local_human', team_id: placement.team_id };
        case 'local_agent':
          // 裸 agent 不是地址；Team 层在段数 1 时不会走到这里，防御性归为非法。
          return {
            kind: 'invalid',
            code: 'federation_invalid_address',
            reason: 'a bare agent name is not an address',
          };
        case 'local_member':
          return {
            kind: 'local_member',
            principal: placement.principal,
            team_id: placement.team_id,
          };
        case 'remote':
          return { kind: 'remote' };
        case 'invalid':
          return { kind: 'invalid', code: placement.code, reason: placement.message };
      }
    },
    async lookup(principal: string): Promise<FederationLookupResult> {
      // 只查开了 out 方向且配了 url 的 peer；收件方向的对端不提供目录。
      const peers = runtime.peers.filter(
        (peer) =>
          (peer.direction === 'out' || peer.direction === 'both') &&
          peer.url !== undefined &&
          peer.allowDirectory === true,
      );
      if (peers.length === 0) return { candidates: [], timedOut: false };

      // **一个总预算打所有 peer**：不是每个 peer 各等一次超时。
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), options.lookupTimeoutMs ?? 2000);
      // 预算到点后仍要回收已完成的候选，所以用 allSettled 而不是 race。
      try {
        const settled = await Promise.allSettled(
          peers.map((peer) =>
            postFederationTeamInfo(
              runtime,
              {
                to: { principal, node_id: peer.nodeId, team_id: peer.teamId },
                members_limit: FEDERATION_TEAM_INFO_MAX_LIMIT,
              },
              { ...io, signal: controller.signal },
            ),
          ),
        );

        const candidates: FederationAgentCandidate[] = [];
        const seen = new Set<string>();
        let timedOut = false;
        for (const [index, result] of settled.entries()) {
          const peer = peers[index];
          if (peer === undefined) continue;
          if (result.status === 'rejected') {
            timedOut = true;
            continue;
          }
          if (result.value.status !== 'ok') {
            // `federation_peer_unreachable` / 限流等：没查完，不是「不存在」。
            if (result.value.code === 'federation_peer_unreachable') timedOut = true;
            continue;
          }
          for (const member of result.value.team.members) {
            if (member.name !== principal) continue;
            // 用 peer 的 `teamId` 而不是响应里的 `team_id`：两者在配了 `localTeamId`
            // 时不等，而发出去要能命中同一个 peer 配置，否则候选地址自己发不回去。
            const address = `${principal}@${peer.nodeId}:${peer.teamId}`;
            if (seen.has(address)) continue;
            seen.add(address);
            candidates.push({
              address,
              name: principal,
              node_id: peer.nodeId,
              team_id: peer.teamId,
            });
          }
        }
        return { candidates, timedOut };
      } finally {
        clearTimeout(deadline);
      }
    },
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

      // 本机成员地址（2 段，或 3 段但 node 段命中本机）：就地投递，绝不出网。
      // 走回调而不是 import Team 层，注入边界与 `localHuman` 同形。
      if (to.kind === 'local_member') {
        const localMember = options.localMember?.();
        if (localMember === undefined) {
          return {
            status: 'error',
            code: LOCAL_MEMBER_DELIVERY_FAILED,
            reason: 'local member delivery is not available on this node',
          };
        }
        try {
          const { message_id } = await localMember.deliver({
            team_id: to.team_id,
            to: to.principal,
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
            code: errorCodeOf(error) ?? LOCAL_MEMBER_DELIVERY_FAILED,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      }

      // 裸 agent 名不是可投递地址；`resolve()` 不会把它交到这里。
      if (to.kind === 'local_agent') {
        return {
          status: 'rejected',
          code: 'federation_invalid_address',
          reason: 'a bare agent name is not an address; use <agent>@<team>',
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
