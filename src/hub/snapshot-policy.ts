/**
 * Hub snapshot 新旧判定（S5 / S5.1）。
 *
 * 规则与 S5 `control-client.ts` 完全一致：
 * - `hello.incarnation` 变化 → 下一个 snapshot 无条件接受，并重置 revision 比较；
 * - 同一 incarnation 下 `revision <= lastRevision` 的 snapshot 丢弃；
 * - 空字符串 incarnation 不参与变化判定。
 *
 * 抽成纯策略，hub → node 的 client 与 node → hub 的 inbound receiver 共用，
 * 避免两个方向对旧包的处理出现漂移。
 *
 * @module vessel/hub/snapshot-policy
 */

export interface HubSnapshotPolicySeed {
  /** 已持久化的节点代际；缺省 undefined。 */
  incarnation?: string;
  /** 已接受的最大 revision；缺省 -1。 */
  revision?: number;
}

export interface HubSnapshotPolicy {
  /** 记录 acceptor hello 的代际；变化时强制接受下一个 snapshot。 */
  observeHello(incarnation: unknown): void;
  /** 判断 snapshot 是否应被接受；接受时推进内部状态。 */
  accept(incarnation: unknown, revision: number): boolean;
  currentIncarnation(): string | undefined;
  lastRevision(): number;
}

function incarnationOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 创建策略；seed 来自 registry 记录或上一个连接的已接受快照。 */
export function createHubSnapshotPolicy(seed: HubSnapshotPolicySeed = {}): HubSnapshotPolicy {
  let currentIncarnation = seed.incarnation;
  let lastRevision = seed.revision ?? -1;
  let forceAcceptNext = false;

  return {
    observeHello(incarnation: unknown): void {
      const value = incarnationOf(incarnation);
      if (value !== currentIncarnation) {
        currentIncarnation = value;
        forceAcceptNext = true;
      }
    },

    accept(incarnation: unknown, revision: number): boolean {
      const value = incarnationOf(incarnation);
      const changed = forceAcceptNext || (value !== '' && value !== currentIncarnation);
      if (!changed && revision <= lastRevision) return false;
      forceAcceptNext = false;
      if (value !== '') currentIncarnation = value;
      lastRevision = revision;
      return true;
    },

    currentIncarnation(): string | undefined {
      return currentIncarnation;
    },

    lastRevision(): number {
      return lastRevision;
    },
  };
}
