/**
 * 本机人类投递（0.27）：发给人类的 send 直接落到本机 Team 日志。
 *
 * `human` 是保留 principal（见 `federation-address.ts`）。入站侧早已把它解析成
 * `resolution: 'human'` 并只写日志（`packages/serve/src/federation.ts`）；本模块补上
 * 本机侧的同一条路：不经过 allowlist、不发任何网络请求、不唤醒任何成员，只是把消息
 * 追加进本机 Team 日志，等人在 Web Team 面板里看到并回信。
 *
 * 写法与入站 side 保持一致（`teams.post({ mentions: [], to: ['human'] })`）：
 * `mentions` 为空 → 纯日志、零 dispatch，正是「异步委派、不阻塞 agent」的语义。
 *
 * 地址解析（含「是不是本机」）**不在这里**，由 `federation-address.ts` 的
 * `resolveAddress` 独家判断；本模块只负责写日志。
 *
 * 失败（Team 不存在 / 归档 / 正文超限 / 日志写失败）直接抛错，由 send port 映射为
 * `error` 结果；不吞错、不回落成跨节点发送。
 *
 * @module vessel/team-human-delivery
 */

import type { AgentTeamService } from '@vessel-agent/agent';

/**
 * 本机人类投递端口：追加一条面向人类的 Team 日志，不唤醒任何成员。
 */
export interface LocalHumanTarget {
  /** 追加一条面向人类的本机 Team 日志；返回该条日志的 `message_id`。失败抛错。 */
  deliver(input: {
    team_id: string;
    from: string;
    content: string;
    conversation_id?: string;
  }): Promise<{ message_id: string }>;
}

/**
 * 日志 `from` 用 principal（`<principal>@<node>:<team>` → `<principal>`）。
 *
 * 地址形如成员名时 Web 能按 roster 解析出成员标签与「查看 Body」入口；写成完整
 * 地址会让它退化成一段陌生字符串。本机投递不跨节点，node / team 段是冗余信息，
 * 形状不合（没有 `@`）时原样保留，不猜。
 */
function senderName(from: string): string {
  const at = from.lastIndexOf('@');
  if (at <= 0) return from;
  return from.slice(0, at);
}

/**
 * 构造本机人类投递端口。
 *
 * `team` 是装配层的 Team 服务（`AgentTeamService` 端口）；本机 Team 服务在本端口
 * 之后才构造，所以装配层用 `FederationSendPortOptions.localHuman` 的 getter 晚绑定。
 */
export function createTeamHumanDelivery(team: AgentTeamService): LocalHumanTarget {
  return {
    async deliver(input: {
      team_id: string;
      from: string;
      content: string;
      conversation_id?: string;
    }): Promise<{ message_id: string }> {
      const written = await team.post({
        team_id: input.team_id,
        content: input.content,
        from: senderName(input.from),
        // 空 mentions = 只写日志、绝不 dispatch（与入站 human 分支同形）。
        mentions: [],
        // `to` 只进日志，用于标注收件人；不会触发任何投递。
        to: ['human'],
        ...(input.conversation_id !== undefined ? { conversation_id: input.conversation_id } : {}),
      });
      return { message_id: written.message_id };
    },
  };
}
