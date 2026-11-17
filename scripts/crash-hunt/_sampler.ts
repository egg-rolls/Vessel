/**
 * 压力脚本共用的「周期性资源采样」。
 *
 * 为什么要有它：0.54 gateway 崩在 102 分钟处，**崩溃前一条资源读数都没有** ——
 * 事后只能看 Bun 自己的 panic 头（RSS/Peak/Commit/Faults），那是「死后的尸检」，
 * 不是「活着时的曲线」。这里按固定节拍往 stdout 打一行，让「崩之前」有痕迹。
 *
 * 口径刻意与 Bun panic 头对齐：rss（WorkingSet 量级）/ heap / external / arrayBuffers。
 * Windows 的 Commit（Private Bytes）进程内拿不到，由 `run-stress.ts` 从外面用 PowerShell 补。
 */

const MB = 1048576;

/** 一行 `SAMPLE`：字段固定，方便 grep / 贴表。 */
export function sampleLine(elapsedMs: number, extra: Record<string, number | string> = {}): string {
  const usage = process.memoryUsage();
  const fields: Record<string, number | string> = {
    t: `${(elapsedMs / 1000).toFixed(0)}s`,
    rss: `${(usage.rss / MB).toFixed(1)}MB`,
    heap: `${(usage.heapUsed / MB).toFixed(1)}MB`,
    ext: `${(usage.external / MB).toFixed(1)}MB`,
    ab: `${(usage.arrayBuffers / MB).toFixed(1)}MB`,
    ...extra,
  };
  return `SAMPLE ${Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ')}`;
}

/**
 * 起一个采样定时器：每 `intervalMs` 打一行。
 *
 * 返回一个 `stop()`；脚本本身结束时不需要调用（定时器已 unref，不会吊住进程）。
 */
export function startSampler(
  render: () => Record<string, number | string> = () => ({}),
  intervalMs = 5000,
): () => void {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    process.stdout.write(`${sampleLine(Date.now() - startedAt, render())}\n`);
  }, intervalMs);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}

/** 当前 RSS（MB），用于「起止差值」这种一行结论。 */
export function rssMb(): number {
  return process.memoryUsage().rss / MB;
}
