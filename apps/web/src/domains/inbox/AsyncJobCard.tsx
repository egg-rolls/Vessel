/**
 * 异步作业的 inbox 占位回调卡（q-async-bash-viz，复用 inbox，**kind 无关通用渲染**）。
 *
 * 灵魂出窍复原：起作业时插一条 running 占位（不可消费、沉底），完成时服务端**按 jobId
 * 原位更新同一条目**（done/failed + 填结果正文）—— 不是另插一条。本组件只读
 * `entry.async_job` 元数据 + 那次 `agents.inbox` 读到的正文，不发轮询：
 * - 已耗时是**客户端计时器**（running 每秒跳一下，零 RPC）；done/failed 用 ended_at-started_at。
 * - 渲染层**按 kind 分派**专属卡体：`bash`→输入（命令）/输出（结果）两块；
 *   其余 kind→通用输出块兜底。inbox 核心通用，kind 细节只在渲染层。
 *
 * q-bash-card-blocks：展开体借工具卡家族 tool-section 分块（输入/输出），
 * **不再重复 JobHeader 首行**（状态/jobId/耗时/exit 收缩条已有），log tail 点读移除。
 *
 * 身份 / 状态 / 归属全部来自服务端那一次读；写操作（消费）由模型 inbox read 完成，
 * 本卡不给「取消 / 我已处理」（running 占位不可消费；done/failed 结果由模型读走）。
 */
import { type ReactNode, useEffect, useState } from 'react';
import { CopyButton } from '../../components/CopyButton';
import { t } from '../../i18n';
import { shortSenderId } from '../chat/pending-strip';
import { StreamCard } from '../chat/StreamCard';

/** 异步作业占位元数据（与服务端 inbox async_job / web AgentInboxEntry.async_job 同形）。 */
export interface AsyncJobMeta {
  job_id: string;
  kind: string;
  status: 'running' | 'done' | 'failed';
  payload?: Record<string, unknown>;
  started_at: number;
  ended_at?: number;
  session_id?: string;
}

/** 本卡只读 async_job 元数据 + 摘要正文（收件箱 / 条带两种条目形状都满足）。 */
export interface AsyncJobCardEntry {
  async_job?: AsyncJobMeta;
  summary?: string;
}

/** 状态 → Badge tone：running 科技蓝（info）/ done 绿（success）/ failed 红（danger）。 */
function toneOf(status: AsyncJobMeta['status']): 'info' | 'success' | 'danger' {
  return status === 'running' ? 'info' : status === 'done' ? 'success' : 'danger';
}

/** 状态点底色（复用 toneOf 口径）：running 科技蓝 / done 绿 / failed 红；脉冲另挂。 */
const DOT_CLASS: Record<ReturnType<typeof toneOf>, string> = {
  info: 'bg-info',
  success: 'bg-success',
  danger: 'bg-danger',
};

/** 毫秒 → 紧凑时长（`12s` / `3m05s` / `1h02m`）。 */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/**
 * running 占位的客户端跳秒计时器（零 RPC）：每秒重算一次 now-started_at。
 * done/failed 不调用（时长由 ended_at-started_at 定死）。
 */
function useLiveElapsed(startedAt: number, running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  return now - startedAt;
}

/**
 * 展开体内容块（借工具卡家族 tool-section 样式，与 ToolCard 输入/输出分区同形）：
 * 小标 + 可选复制键 + 块体。不做二级折叠 —— 卡本身已是折叠壳，展开即见全文。
 */
function JobSection({
  label,
  copyText,
  children,
}: {
  label: string;
  copyText?: string;
  children: ReactNode;
}) {
  return (
    <section className="tool-section">
      <div className="tool-section-head">
        <span className="tool-section-label">{label}</span>
        {copyText !== undefined && copyText !== '' && (
          <CopyButton text={copyText} className="tool-section-copy" />
        )}
      </div>
      {children}
    </section>
  );
}

/** done/failed 的结果正文（服务端原位填充的那一份，单一真相源；kind 无关）。 */
function ResultBody({ summary }: { summary?: string }) {
  if (!summary) return null;
  return (
    <p className="m-0 whitespace-pre-wrap break-words text-sm leading-relaxed text-ink">
      {summary}
    </p>
  );
}

/** running 态输出块的占位文案（结果未回，跳秒在收缩条上）。 */
function RunningHint() {
  return <span className="text-xs text-faint">{t('inbox.asyncJob.running')}…</span>;
}

/**
 * bash 专属卡体（首个消费者）：输入块 = 完整命令（等宽 + 复制）；
 * 输出块 = exit code + 结果摘要（ResultBody 现有逻辑）。kind 专属字段从 payload 读
 * （机制层不解释）。状态/jobId/耗时/exit 收缩条已有，展开不再重复头部。
 */
function BashJobBody({ job, entry }: { job: AsyncJobMeta; entry: AsyncJobCardEntry }) {
  const running = job.status === 'running';
  const payload = job.payload ?? {};
  const command = typeof payload.command === 'string' ? payload.command : undefined;
  const exitCode =
    typeof payload.exit_code === 'number' || payload.exit_code === null
      ? (payload.exit_code as number | null)
      : undefined;

  return (
    <div className="flex flex-col gap-2">
      {command !== undefined && (
        <JobSection label={t('inbox.asyncJob.input')} copyText={command}>
          <pre className="tool-section-body">{command}</pre>
        </JobSection>
      )}
      <JobSection label={t('inbox.asyncJob.output')} copyText={entry.summary}>
        <div className="tool-section-body flex flex-col gap-1">
          {exitCode !== undefined && exitCode !== null && (
            <span className="font-mono text-xs text-faint">exit {exitCode}</span>
          )}
          {running ? <RunningHint /> : <ResultBody summary={entry.summary} />}
        </div>
      </JobSection>
    </div>
  );
}

/**
 * 通用卡体（未知 / 未来 kind 的兜底，如 ask 问题卡尚未实现时）：输出块 = 结果摘要，
 * 与 bash 卡同口径（无输入块）。新 kind 落地时在此按 kind 增专属卡体（扩展点），
 * inbox 核心无需改动。
 */
function GenericJobBody({ job, entry }: { job: AsyncJobMeta; entry: AsyncJobCardEntry }) {
  return (
    <JobSection label={t('inbox.asyncJob.output')} copyText={entry.summary}>
      <div className="tool-section-body">
        {job.status === 'running' ? <RunningHint /> : <ResultBody summary={entry.summary} />}
      </div>
    </JobSection>
  );
}

/**
 * 通用异步作业卡入口：按 `async_job.kind` 分派专属卡体。bash→输入/输出两块（BashJobBody）；
 * 其余 kind→通用输出块（GenericJobBody，ask 问题卡未来在此接入）。
 *
 * 表面 = StreamCard 折叠壳（与 agent 排队黄条 QueuedNotice 同一基座，同形同高）：
 * **默认收缩**（running/done/failed 皆然），卡头单行 = 状态点（running 脉冲）+ kind
 * 身份槽 + 短 jobId + 耗时（running 跳秒零 RPC）+ exit code + 命令预览 ellipsis + chevron；
 * 展开直接进输入/输出内容块（q-bash-card-blocks：头部信息与收缩条重合，不再重复）。
 * 色调走 notice-block 家族中性档（照 agent 条口径 tone neutral），状态色只留在状态点上；
 * 家族身份圆点不叠（状态点已画在 title 槽，见 chat.css `.stream-card-job`）。
 */
export function AsyncJobCard({ entry }: { entry: AsyncJobCardEntry }) {
  const job = entry.async_job as AsyncJobMeta;
  const running = job.status === 'running';
  const liveElapsed = useLiveElapsed(job.started_at, running);
  const elapsed = running ? liveElapsed : (job.ended_at ?? Date.now()) - job.started_at;

  const payload = job.payload ?? {};
  const command = typeof payload.command === 'string' ? payload.command : undefined;
  const exitCode =
    typeof payload.exit_code === 'number' || payload.exit_code === null
      ? (payload.exit_code as number | null)
      : undefined;

  return (
    <StreamCard
      // 卡宽跟列一致（照 QueuedNotice 口径）；notice-block 家族卡面 + 作业卡 scoped 类。
      className="notice-block stream-card-job w-full min-w-0 max-w-full"
      defaultOpen={false}
      ariaLabel={`${job.kind} ${shortSenderId(job.job_id)}`}
      // 状态点 + kind 身份槽：点色复用 toneOf，running 加脉冲（与收缩条同一口径）。
      title={
        <>
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${DOT_CLASS[toneOf(job.status)]}${
              running ? ' animate-pulse' : ''
            }`}
          />
          {job.kind}
        </>
      }
      // 短 jobId + 耗时 + exit code（meta 槽天生等宽小字 + 弱化色）。
      meta={
        <span className="inline-flex items-center gap-2">
          <span title={`${job.kind}:${job.job_id}`}>{shortSenderId(job.job_id)}</span>
          <span>{formatElapsed(elapsed)}</span>
          {exitCode !== undefined && exitCode !== null && <span>exit {exitCode}</span>}
        </span>
      }
      // 单行预览：bash 给命令（等宽小字，与展开体命令行同款），其余 kind 给结果摘要；
      // 长内容由 .event-block-preview ellipsis 截断，展开看全文。
      summary={
        job.kind === 'bash' && command !== undefined ? (
          <span className="font-mono text-xs">$ {command}</span>
        ) : (
          entry.summary
        )
      }
    >
      {job.kind === 'bash' ? (
        <BashJobBody job={job} entry={entry} />
      ) : (
        <GenericJobBody job={job} entry={entry} />
      )}
    </StreamCard>
  );
}
