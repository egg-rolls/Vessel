/**
 * 地址段数（0.27）：`<agent>` / `<agent>@<team>` / `<agent>@<node>:<team>`。
 *
 * **段数定义语义**，不看「有没有 `@`」：
 *
 * | 段数 | 形态 | 含义 |
 * |---|---|---|
 * | 1 | `alice` | 本机 agent（name 或 id），按查找阶梯解析 |
 * | 2 | `alice@vessel` | 本机 Team 内的 agent（**node 恒为本机**） |
 * | 3 | `alice@node-b:vessel` | 跨节点（node 段决定是否出网） |
 *
 * **node 段没有默认值**：跨节点必须显式写三段，两段永远只在本机。这是「本机不
 * 冒充远端」的唯一依据，所以放在 `packages/agent` 里，让 `team-service`（判断是否
 * 走地址路）与 app 层 `resolveAddress`（判断是不是本机）共用同一份实现 —— 两处各写
 * 一套 `includes('@')` 就会分叉。
 *
 * 纯函数，无 I/O，不校验字符集（字符集由调用方按需要再校验）。
 *
 * @module @vessel-agent/agent
 */

/** 地址段数。 */
export type AddressSegmentCount = 1 | 2 | 3;

/** 三段最长情形（principal + `@` + node + `:` + team）；超过直接不是地址。 */
export const MAX_ADDRESS_LENGTH = 64 + 1 + 64 + 1 + 64;

// ── 保留 principal 词典 ──────────────────────────────
//
// 这些字符串在寻址 / 消息来源判定里有固定含义，**不能被成员名或成员 id 占用**。
// 占用后的故障都是静默的：名字形状合法，成员建得出来，但
//
// - `human`：`resolveAddress` 把它短路成本机人类，于是这个成员的出站 `from` 被
//   读成人类（跨节点身份丢失），`dispatch({to:'human'})` 也会投给它而不是人类；
// - `system`：`messageSource` / `inferMessageSource` 把它读成系统消息，同理。
//
// **新增保留名的唯一入口是本区块**：加常量 → 进 `RESERVED_PRINCIPALS` → 创建路径
// 的 `assertMemberName` / 显式 id 校验自动生效。别在消费侧再写字面量比较。

/** 人类 principal 的保留值：`human` / `human@<team>` / `human@<node>:<team>`。 */
export const HUMAN_PRINCIPAL = 'human' as const;

/** 系统消息发送者的保留值：不是成员，只是 `AgentMessageSource` 的 `system`。 */
export const SYSTEM_PRINCIPAL = 'system' as const;

/**
 * 全部保留 principal：既不是成员名，也不是成员 id。
 *
 * 只读集合（`ReadonlySet`）而不是数组：消费侧 `conversation-budget` 要按值查表，
 * 一份清单两处用，避免又分叉出第二份字符串列表。
 */
export const RESERVED_PRINCIPALS: ReadonlySet<string> = new Set([
  HUMAN_PRINCIPAL,
  SYSTEM_PRINCIPAL,
]);

/** 是否是保留 principal（不能当成员名 / 成员 id）。 */
export function isReservedPrincipal(value: string): boolean {
  return RESERVED_PRINCIPALS.has(value);
}

/**
 * 数一个 `send` 目标的段数；形状不合法返回 `undefined`。
 *
 * - `alice` → 1
 * - `alice@vessel` → 2
 * - `alice@node-b:vessel` → 3
 *
 * 反例（一律 `undefined`，不是地址）：`node-b:vessel`（带 `:` 无 `@`）、`a@b@c`、
 * `a@b:c:d`、空段（`a@` / `@vessel` / `a@:b`）、空串、超长。
 */
export function addressSegmentCount(raw: string): AddressSegmentCount | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_ADDRESS_LENGTH) {
    return undefined;
  }
  const at = raw.indexOf('@');
  if (at === -1) {
    // 没有 `@` 却带 `:`：`node:team` 只是地址的一部分，不能单独寻址。
    return raw.includes(':') ? undefined : 1;
  }
  if (at === 0 || at === raw.length - 1) return undefined;
  if (raw.indexOf('@', at + 1) !== -1) return undefined;

  const rest = raw.slice(at + 1);
  const colon = rest.indexOf(':');
  if (colon === -1) return 2;
  // 恰好一个 `:` 且两侧非空 → 三段；多于一个 / 有空侧都不是地址。
  if (colon === 0 || colon === rest.length - 1) return undefined;
  if (rest.indexOf(':', colon + 1) !== -1) return undefined;
  return 3;
}

/** 是否是地址形式（1/2/3 段之一）。 */
export function isAddressTarget(raw: string): boolean {
  return addressSegmentCount(raw) !== undefined;
}
