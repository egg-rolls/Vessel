/**
 * agent 源读侧（q-sub-unify-p1 M2 起步：键空间 + 目标校验；M4b 补快照读侧）。
 *
 * 照抄 health.ts 范式：插件拥有订阅语义，宿主 agent-activity-watch 落活动快照，
 * 插件 observe 读快照取签名 rev。目标语法与 health 同族（字面量副本，
 * 生产侧真相在 src/federation/federation-address.ts 与 node-registry NODE_ID_RE，
 * 改任一侧人工对拍）：
 * - 本机 agent_id：`[A-Za-z0-9_-]{1,64}`（覆盖 UUID）；
 * - 远程联邦地址：`<principal>@<node_id>:<team_id>`（三段；P1 只收语法，远端探测 P3）。
 */

/** 本机 agent_id 语法（node_id 同族字面量副本） */
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** 联邦地址三段语法（federation-address.ts 的字面量副本） */
const FEDERATION_ADDRESS_RE = /^[A-Za-z0-9_-]{1,64}@[A-Za-z0-9_-]{1,64}:[a-z0-9][a-z0-9-]{0,63}$/;

/** 目标是否合法（本机 agent_id 或三段联邦地址） */
export function isValidAgentTarget(target: string): boolean {
  return AGENT_ID_RE.test(target) || FEDERATION_ADDRESS_RE.test(target);
}

/** agent 条目的状态键（与文件/health/script 键空间隔离） */
export function agentSubscriptionKey(target: string): string {
  return `agent:${target}`;
}
