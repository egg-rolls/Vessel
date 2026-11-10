/**
 * `gap` 之后「权威快照已过期」的数据层信号（CONTRACT-msg-system §3 / §4.2）。
 *
 * 实时流缺了一段就无法补；恢复只能走 RPC 快照（sessions.get / teams.get /
 * runs.list / interactions.list）。数据层不知道当前路由，页面在 S3 用
 * `onRouteSnapshotInvalidated` 注册重新拉取即可；连接层负责发信号。
 */

export type SnapshotInvalidationListener = () => void;

const listeners = new Set<SnapshotInvalidationListener>();

/** 注册页面级快照失效回调；返回注销函数。 */
export function onRouteSnapshotInvalidated(listener: SnapshotInvalidationListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 广播：当前路由需要重新拉取权威快照（不重连）。 */
export function invalidateRouteSnapshots(): void {
  for (const listener of [...listeners]) listener();
}
