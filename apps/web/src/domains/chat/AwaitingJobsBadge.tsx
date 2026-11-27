/**
 * 「等待异步任务」徽标（q-async-bash-viz C）：会话 idle 但还有 running 的异步 bash 作业时
 * 显示「⏳ 等待异步任务 X」—— 解决「链路是停了还是在等 bash」的判断。
 *
 * 纯展示：count 由 {@link useAwaitingJobs} 派生（jobs.list 初始 + bash.job.* 事件 live）。
 * count 为 0 不渲染。idle 判据由宿主给（无在飞 run 时才挂这张徽标）。
 */
import { t } from '../../i18n';
import { shortSenderId } from './pending-strip';

export function AwaitingJobsBadge({ count, jobIds }: { count: number; jobIds: readonly string[] }) {
  if (count <= 0) return null;
  const title = jobIds.map((id) => shortSenderId(id)).join(', ');
  return (
    <div className="px-[var(--content-pad-inline)] pb-1">
      <div className="mx-auto max-w-[var(--chat-content-w,860px)]">
        <span
          className="inline-flex items-center gap-1.5 rounded-full bg-info-soft px-2.5 py-0.5 font-mono text-2xs text-info"
          title={title}
        >
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-info" />
          {t('chat.awaitingJobs', { count })}
        </span>
      </div>
    </div>
  );
}
