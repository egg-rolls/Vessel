/** Gateway 状态页的纯函数：节点显示名与启动时长。 */

export interface UptimeText {
  key:
    | 'duration.seconds'
    | 'duration.minutes'
    | 'duration.hours'
    | 'duration.hoursMinutes'
    | 'duration.daysHours';
  params: Record<string, number>;
}

/** 只读 `health.get.node.name`（0.25 additive）；缺失时回退 node_id，再回退 `—`。 */
export function gatewayNodeName(node: { name?: string; node_id?: string } | undefined): string {
  const name = node?.name?.trim();
  if (name) return name;
  const id = node?.node_id?.trim();
  return id || '—';
}

/** 启动时间 → 本地化时长 key/params；非法或未来时间返回 null。 */
export function uptimeParts(
  startedAt: number | undefined,
  now: number = Date.now(),
): UptimeText | null {
  if (startedAt === undefined || !Number.isFinite(startedAt)) return null;
  const elapsed = now - startedAt;
  if (elapsed < 0) return null;

  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) return { key: 'duration.seconds', params: { seconds } };

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { key: 'duration.minutes', params: { minutes } };

  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) {
    return restMinutes === 0
      ? { key: 'duration.hours', params: { hours } }
      : { key: 'duration.hoursMinutes', params: { hours, minutes: restMinutes } };
  }

  const days = Math.floor(hours / 24);
  return { key: 'duration.daysHours', params: { days, hours: hours % 24 } };
}
