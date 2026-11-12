/**
 * 0.51：插件的宿主端口面（成员身体）。
 *
 * 这里只放**契约**：core 不 import 任何具体插件，也不 import `AgentInboxStore` 的条目类型
 * —— 端口自己的最小 DTO 写在下面，换存储实现不换边界。
 *
 * 三条边界（ADR-099 §2 / §5，报告 `inbox-plugin-design.md` §2.2–§2.6）：
 * 1. **agentId 绑死在端口上**：`MemberInboxPort` 的方法都没有 agentId 参数，插件读不到
 *    别人的收件箱（对照 `AgentInboxPort.list(agentId, …)` —— 那个签名交给插件，任何插件
 *    都能读全部成员的收件箱）。
 * 2. **没有投递状态机**：hold / unhold / releaseHeldFor / markConsumed / findByIds 全部留在
 *    宿主 —— 那些是调度不变量（谁能变成下一轮 run input、谁在抢在途队列），不是插件能力。
 * 3. **未申请的端口在类型上不存在**（`MemberBodyPorts<P>` = `Pick<…, P>`，不是值为
 *    `undefined` 的同名键）：越权访问是编译错误，不是运行期惊喜。
 *
 * @module @vessel-agent/core/types
 */

import type { Hook } from './hook.js';
import type { ToolDefinition } from './tool.js';

/**
 * 0.51：插件的宿主作用域。缺省 `'node'`（0.51 之前的全部插件都是这个）。
 *
 * - `'node'`：装在节点宿主上（今天唯一的形态），贡献工具 / provider / guardrail / hook；
 * - `'member'`：可以申请成员身体端口，且只能 in-process —— child 没有 body 宿主，
 *   给它端口等于开一条反向 RPC 通道（报告 §2.7）。
 */
export type PluginScope = 'node' | 'member';

/**
 * 插件可申请的端口名白名单（闭集）。
 *
 * 加一个名字 = 改契约（ADR-099 §2）：清单校验、宿主类型、装配校验三处必须同时改，
 * 所以这里刻意是字面量联合而不是 `string`。
 */
export type PluginPortName = 'inbox';

/**
 * 一条消息在端口视图里的三态。
 *
 * 比存储少一维：`held`（已被某个 body 接管、尚未成为 run input）在存储里是**独立于**
 * `status` 的内存标记，端口把它折叠进三态 —— 插件只需要知道「现在读不到 / 读得到 /
 * 已经没了」，不需要（也不该）知道 held 的记账细节。
 */
export type MemberInboxEntryStatus = 'unread' | 'held' | 'consumed';

/**
 * 端口自己的最小条目 DTO。
 *
 * 刻意不复用存储层的条目类型（`StoredInboxMessage` / `AgentInboxEntryInput`）：那两个带
 * `session_id` / `consumed_by_session` / `refs` 这类归属与恢复字段，一旦被插件依赖，
 * 换存储就等于换契约。**加字段是改契约，不是顺手补全。**
 */
export interface MemberInboxEntry {
  id: string;
  ts: number;
  source: string;
  /** `list`（宿主算好的摘要）与 `read`（正文）共用这一个字段：语义随方法，见方法注释。 */
  text: string;
  status: MemberInboxEntryStatus;
}

/**
 * 一具成员 body 专属的收件箱端口（agentId / sessionId 已绑进闭包）。
 *
 * 与 `AgentInboxPort`（`packages/agent/src/inbox.ts`）的差别只有两点，但两点都是要害：
 * 没有 agentId 参数、没有投递状态机（见模块头）。
 */
export interface MemberInboxPort {
  /**
   * 队列视图：`unread` 只计可读，`pending` 只计「已被某个 body 持有、尚未成为 run input」。
   * `includeHeld` 缺省 false（messages 只含可读条目）；true 时连 held 一起列出。
   *
   * messages 的 `text` 是摘要，不是正文 —— 与工具 `list` 同一口径（列表不该把整段正文
   * 塞进下一次请求）。
   */
  list(options?: { includeHeld?: boolean }): {
    unread: number;
    pending: number;
    messages: readonly MemberInboxEntry[];
  };
  /**
   * 取正文。缺省（不给 `ids`）取最旧的 `limit` 条（缺省 20）；`includeHeld` 同 `list`。
   *
   * **沿用存储的 I2 消费语义**：未被持有的条目读完即 consumed（held 的条目只读正文，
   * 不消费、不取消投递）。端口因此不提供 `markConsumed` —— 插件不能凭 id 把一条消息
   * 标成已消费却不读它，那等于「吞掉一次投递」。
   */
  read(selection?: {
    ids?: readonly string[];
    limit?: number;
    includeHeld?: boolean;
  }): Promise<readonly MemberInboxEntry[]>;
  /**
   * 只删「未读且未被持有」的条目（= 工具 `delete` 的 `onlyUnheld` 口径）。
   * held / consumed / 未知 id 一律进 `skipped`：插件的删除永远抢不走在途队列。
   */
  discard(ids: readonly string[]): {
    deleted: readonly string[];
    skipped: readonly { id: string; reason: 'held' | 'not_found' | 'consumed' }[];
  };
  /**
   * 只落档：等价 `append(…, { delivery: 'quiet', rejectWhenFull: true })`。
   *
   * 端口**没有** delivery 参数：插件不能制造 run input、不能唤醒 run、不能驱逐待送达的
   * unread（队列满就显式 `full`，让调用方说清楚，而不是悄悄顶掉别人一条消息）。
   * `id` / `ts` 缺省由宿主生成（与工具 `insert` 一致）。
   */
  appendOwn(input: { text: string; id?: string; ts?: number }): {
    accepted: boolean;
    reason?: 'unavailable' | 'full';
  };
  /** 落盘等待（写端口本身是异步排队，不阻塞调用方）。 */
  flush(): Promise<void>;
}

/** 端口名 → 端口实例。不是插件能拿到的形状，只是 `MemberBodyPorts` 的查表源。 */
interface MemberPortTable {
  inbox: MemberInboxPort;
}

/**
 * 插件实际拿到的端口集合：**只含 `permissions.ports` 声明过的键**。
 *
 * 未声明的键在类型上不存在（编译错误），不是 `undefined` —— 这条是「不过度打开」的
 * 类型级落实。
 */
export type MemberBodyPorts<P extends PluginPortName> = Pick<MemberPortTable, P>;

/**
 * 端口能发的唯一一条事件（`publish` 的参数）。
 *
 * 单独起个名字而不是内联：宿主实现与贡献侧都要写这个形状，两处各写一遍必然漂移；
 * 而且**只有这一个成员**（见 `publish` 的注释）这件事，写成类型比写成约定更难绕过。
 *
 * 用 type alias 而不是 interface：`data` 要能赋给 `Record<string, unknown>`
 * （`RunEvent.data` 的联合成员）—— 对象字面量类型带隐式索引签名，interface 没有。
 */
export type MemberBodyNoticeEvent = {
  type: 'runtime.notice';
  run_id: string;
  data: { scope: string; summary: string; ok?: boolean };
  ts: number;
};

/**
 * 「这具 body 的端口」交到插件手里的载体：一具 body 一个实例，只在 spawn 时存在。
 *
 * `agentId` / `sessionId` / `isActive` / `publish` 都不是装饰，每一个对应一处现存的
 * per-body 状态（报告 §2.6）：同一进程里一个 agent 可以有多具 live body（rotate 窗口 /
 * 退役中），held 是按 bodyId 记的、notice 必须写进那具 body 的事件流，否则 rotate 期间
 * 新旧 body 的提示会串台。
 */
export interface MemberBodyPort<P extends PluginPortName = PluginPortName> {
  /** 哪个插件申请的（日志 / 去重 / 回滚都按它匹配）。 */
  readonly pluginId: string;
  /** 这具 body 属于哪个成员（端口已按它收窄，见 `MemberInboxPort`）。 */
  readonly agentId: string;
  readonly sessionId: string;
  readonly ports: MemberBodyPorts<P>;
  /** 这具 body 还是它身份的唯一持有者吗（rotate / retire 之后 false）。 */
  isActive(): boolean;
  /**
   * 往**这具 body** 的事件流发一条人类可见提示。
   *
   * 白名单只有 `runtime.notice`：放开成任意 `RunEvent` 就能伪造 `tool.call` / `llm.*` /
   * `run.completed`，污染 trace、团队日志与 Web 时间线（body 事件无条件并入父流）。
   */
  publish(event: MemberBodyNoticeEvent): void;
}

/**
 * 一个插件对「成员身体」的贡献：把这具 body 该有的工具面 / hook 交出来。
 *
 * 两条纪律（报告 §2.4）：
 * - `tools()` **可能被重复调用**（`tools.list{agent_id}` 的 derived 路径、工具热刷新都要它），
 *   因此必须是纯函数、不许有外部副作用 —— 恰好对应今天 `createInboxTool` 的纯度；
 * - `hooks()` 一具 body **只调用一次**（只在真 spawn 时），因为它内部持有 per-body 状态。
 *   若让它在推导路径也跑，rotate 期间就会多出一批不该存在的 hook。
 *
 * `ports` 必须是清单 `permissions.ports` 的子集（安装期由装配层二次校验，不是「贡献说
 * 要什么就给什么」）：贡献说的是「我要什么」，清单说的是「我被允许要什么」。
 */
export interface MemberBodyContribution<P extends PluginPortName = PluginPortName> {
  /** 稳定名：日志 / 去重 / 回滚都按它匹配；通常 = plugin id。 */
  name: string;
  /** 本贡献申请哪些端口。 */
  ports: readonly P[];
  /** 纯函数：端口 → 这具 body 应有的工具面（宿主追加在 `selectTools` 交集之后）。 */
  tools(port: MemberBodyPort<P>): readonly ToolDefinition[];
  /** 一次性：这具 body 的 hook，只在真 spawn 时调用。 */
  hooks?(port: MemberBodyPort<P>): readonly Hook[];
}
