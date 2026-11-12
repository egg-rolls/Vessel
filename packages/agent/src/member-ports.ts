import { randomUUID } from 'node:crypto';
import type {
  MemberBodyContribution,
  MemberBodyPorts,
  MemberInboxEntry,
  MemberInboxPort,
  PluginPortName,
} from '@vessel-agent/core';
import type { AgentInboxPort } from './inbox.js';

/**
 * 0.51 期 0：成员身体端口面在宿主侧的实现 —— 把存储适配成端口，再加一个空壳贡献。
 *
 * 这里刻意只做两件事：绑 agentId / sessionId 并压成最小 DTO、把投递模式钉成 `quiet`。
 * 投递状态机（hold / releaseHeldFor / markConsumed）**不在**这里，也不在端口类型里：
 * 那些是调度不变量，留在 `AgentService`（报告 §2.5 第 4 条）。
 *
 * @module @vessel-agent/agent
 */

/**
 * 把宿主侧收件箱存储适配成**一具 body 的端口**。
 *
 * 这是「端口」与「存储」之间唯一的缝，也是回退线：只要 `AgentInboxStore` 还是宿主侧
 * 唯一实现，任何时候都能把插件摘掉而不丢数据（报告 §5）。
 *
 * @param inbox 宿主侧收件箱（未 attach 时不调用本函数，见 `buildMemberBodyPorts`）
 * @param agentId 这具 body 属于哪个成员；绑进闭包，端口方法不再接受它
 * @param sessionId 这具 body 的会话 id；read 的消费归属（`consumed_by_session`）要它
 */
export function bindMemberInboxPort(
  inbox: AgentInboxPort,
  agentId: string,
  sessionId: string,
): MemberInboxPort {
  const toEntry = (
    message: { id: string; ts: number; source: string; text?: string; summary?: string },
    status: MemberInboxEntry['status'],
  ): MemberInboxEntry => ({
    id: message.id,
    ts: message.ts,
    source: message.source,
    // list 走 summary、read 走 text：调用方各自只传其中一个，缺哪个都算调用方接错。
    text: message.text ?? message.summary ?? '',
    status,
  });

  /**
   * 存储的两维状态 → 端口的一维三态：held 优先（在途比「已消费」更该让调用方看见）。
   */
  const entryStatus = (
    held: boolean,
    status: 'unread' | 'consumed',
  ): MemberInboxEntry['status'] => {
    if (held) return 'held';
    return status === 'consumed' ? 'consumed' : 'unread';
  };

  return {
    list(options) {
      const { unread, pending, messages } = inbox.list(
        agentId,
        options?.includeHeld === true ? { includeHeld: true } : {},
      );
      return {
        unread,
        pending,
        messages: messages.map((message) =>
          // 存储里 held 是独立的内存标记；端口把它折叠进三态（见 core 的 MemberInboxEntryStatus）。
          // list 条目只有 summary，没有正文 —— 摘要本来就是宿主算好的。
          toEntry(message, message.held ? 'held' : 'unread'),
        ),
      };
    },
    async read(selection) {
      const messages = await inbox.read(
        agentId,
        {
          ...(selection?.ids !== undefined ? { ids: selection.ids } : {}),
          ...(selection?.limit !== undefined ? { limit: selection.limit } : {}),
          ...(selection?.includeHeld !== undefined ? { includeHeld: selection.includeHeld } : {}),
        },
        sessionId,
      );
      return messages.map((message) => toEntry(message, entryStatus(message.held, message.status)));
    },
    discard(ids) {
      // onlyUnheld 与工具 `delete` 同一口径：插件删不动在途队列（held / consumed 进 skipped）。
      const { deleted, skipped } = inbox.discard(agentId, ids, { onlyUnheld: true });
      return { deleted, skipped };
    },
    appendOwn(input) {
      const result = inbox.append(
        agentId,
        {
          id: input.id ?? randomUUID(),
          ts: input.ts ?? Date.now(),
          // 与工具 `insert` 同源：自己写给自己，来源就是自己。
          source: agentId,
          text: input.text,
        },
        // quiet + rejectWhenFull：只落档，不唤醒 run、不成为 run input、不驱逐待送达的 unread。
        { delivery: 'quiet', rejectWhenFull: true },
      );
      return {
        accepted: result.accepted,
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
      };
    },
    async flush() {
      await inbox.flush();
    },
  };
}

/**
 * 按贡献声明的端口名构造端口表；**只要有一样宿主现在给不出来，就返回 undefined**。
 *
 * 为什么整条 fail-closed 而不是给个缺方法的壳：`MemberBodyPorts` 的语义是「未申请的键
 * 在类型上不存在」，运行期给一个 `inbox: undefined` 只会把编译期错误换成一个更晚、
 * 更难查的 TypeError。缺端口 = 缺能力，让贡献整条不生效，行为退回 0.50。
 *
 * @returns 端口表；有任一声明的端口无法提供时 undefined
 */
export function buildMemberBodyPorts(options: {
  requested: readonly PluginPortName[];
  inbox: AgentInboxPort | undefined;
  agentId: string;
  sessionId: string;
}): MemberBodyPorts<PluginPortName> | undefined {
  const ports: Partial<MemberBodyPorts<PluginPortName>> = {};
  for (const name of options.requested) {
    if (name === 'inbox') {
      if (options.inbox === undefined) return undefined;
      ports.inbox = bindMemberInboxPort(options.inbox, options.agentId, options.sessionId);
    }
  }
  // 逐个端口都已按契约绑定，这里的断言只是把「运行期拼出来的表」对回编译期的白名单类型。
  return ports as MemberBodyPorts<PluginPortName>;
}

/** 内置 `inbox` 成员面贡献的稳定名（= 未来那个插件包的 id）。 */
export const INBOX_MEMBER_CONTRIBUTION_NAME = 'inbox';

/**
 * 0.51 期 0：`inbox` 的成员面贡献 —— **空壳**。
 *
 * 它此刻唯一的作用是把通路跑通：清单声明 `scope: 'member'` + `permissions.ports: ['inbox']`、
 * 宿主按 body 造端口、`tools()` 与 `selectTools` 的产物合并。工具面故意返回空数组，
 * 于是 `listTools()` / `tools.list` 的输出与 0.50 逐字相同 —— 期 0 的验收就是「什么都没变」。
 *
 * 期 1 把 `createInboxTool` / `createInboxNoticeHook` 搬进来（工具面 + notice hook），
 * 这个函数随之挪到 `plugins/inbox/inbox`；在 `packages/agent` 里不再留第二份实现。
 */
export function createInboxMemberBodyContribution(): MemberBodyContribution<'inbox'> {
  return {
    name: INBOX_MEMBER_CONTRIBUTION_NAME,
    ports: ['inbox'],
    // 纯函数、可重复调用（derived 路径每次都调）；期 0 还没有工具，先返回空。
    tools: () => [],
  };
}
