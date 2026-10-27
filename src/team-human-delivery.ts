/**
 * 本机人类投递（0.27）：`human@<本机 node>:<team>` 的 send 直接落到本机 Team 日志。
 *
 * `human` 是 federation 地址的保留 principal（见 `federation-address.ts`）。入站侧
 * 早已把它解析成 `resolution: 'human'` 并只写日志（`packages/serve/src/federation.ts`）；
 * 本模块补上出站 / 本机侧的同一条短路：不经过 allowlist、不发任何网络请求、不唤醒
 * 任何成员，只是把消息追加进本机 Team 日志，等人在 Web Team 面板里看到并回信。
 *
 * 写法与入站 side 保持一致（`teams.post({ mentions: [], to: ['human'] })`）：
 * `mentions` 为空 → 纯日志、零 dispatch，正是「异步委派、不阻塞 agent」的语义。
 *
 * 本机判定用的 node 段由调用方给（`nodeNames`）：agent 是从 `[Message source]` 里
 * 照抄地址的，那里的小节点段是 `os.hostname()` 派生的展示名，而本机真实身份是
 * `node.json` 的 `node_id`（UUID），两个都得认。本模块**不**自己算 hostname。
 *
 * 失败（Team 不存在 / 归档 / 正文超限 / 日志写失败）直接抛错，由 send port 映射为
 * `error` 结果；不吞错、不回落成跨节点发送。
 *
 * @module vessel/team-human-delivery
 */

import type { AgentTeamService } from '@vessel-agent/agent';

/**
 * 本机人类投递端口。字段可读：`nodeNames` 由装配层给出，`deliver` 只写日志。
 */
export interface LocalHumanTarget {
  /** 视为「本机」的 node 段：`node_id`（UUID）与展示名（hostname 派生）。 */
  nodeNames: readonly string[];
  /** 追加一条面向人类的本机 Team 日志；返回该条日志的 `message_id`。失败抛错。 */
  deliver(input: {
    team_id: string;
    from: string;
    content: string;
    conversation_id?: string;
  }): Promise<{ message_id: string }>;
}

/** 空白 / 空串 name 不参与本机判定；去重但保持调用方给出的顺序。 */
function normalizeNodeNames(nodeNames: readonly string[]): string[] {
  const names: string[] = [];
  for (const raw of nodeNames) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim();
    if (name === '' || names.includes(name)) continue;
    names.push(name);
  }
  return names;
}

/**
 * node 段是否指向本机。
 *
 * 大小写不敏感：主机名的比较本来就与大小写无关（Windows 的 `os.hostname()` 常给
 * 全大写，而 `node.json` 的展示名可能是用户配置的混合大小写），两边不同源。
 */
export function isLocalNodeName(candidates: readonly string[], nodeSegment: string): boolean {
  const needle = nodeSegment.toLowerCase();
  return candidates.some((name) => name.toLowerCase() === needle);
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
export function createTeamHumanDelivery(
  team: AgentTeamService,
  nodeNames: readonly string[],
): LocalHumanTarget {
  return {
    nodeNames: normalizeNodeNames(nodeNames),
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
