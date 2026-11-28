/**
 * 异步作业的 inbox 占位回调卡（q-async-bash-viz，复用 inbox，**kind 无关通用渲染**）。
 *
 * 灵魂出窍复原：起作业时插一条 running 占位（不可消费、沉底），完成时服务端**按 jobId
 * 原位更新同一条目**（done/failed + 填结果正文）—— 不是另插一条。本组件只读
 * `entry.async_job` 元数据 + 那次 `agents.inbox` 读到的正文，不发轮询：
 * - 已耗时是**客户端计时器**（running 每秒跳一下，零 RPC）；done/failed 用 ended_at-started_at。
 * - 渲染层**按 kind 分派**专属卡：`bash`→科技蓝命令卡 + log tail（按需 jobs.log）；
 *   `ask`→未来问题卡；其余 kind→通用状态卡。inbox 核心通用，kind 细节只在渲染层。
 *
 * 身份 / 状态 / 归属全部来自服务端那一次读；模型侧消费仍由 inbox read 完成。
 * 用户侧收口（q-bash-inbox-integrate）：done/failed 卡给「我已处理」认领键
 * （调用方接 `agents.claim`，与 inbox 消息卡同语义）；running 占位不可消费 ⇒ 无键。
 * 键放展开体末尾（QueuedNotice 同款先例）：折叠态 `<details>` 只渲染 `<summary>`，
 * `actions` 槽同样不可见，所以不走那个槽 —— 与条带消息卡「展开才见处置键」同口径。
 */
import { useEffect, useState } from 'react';
import { Badge, Button } from '../../components/ui';
import type { GatewayClient } from '../../gateway/client';
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

/** 状态文案（kind 无关）。 */
function statusLabel(status: AsyncJobMeta['status']): string {
  if (status === 'running') return t('inbox.asyncJob.running');
  if (status === 'done') return t('inbox.asyncJob.done');
  return t('inbox.asyncJob.failed');
}

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

/** 状态点 + 状态文案 + 短 jobId + 已耗时 + 归属会话（kind 无关公共头部）。 */
function JobHeader({ job, elapsed }: { job: AsyncJobMeta; elapsed: number }) {
  const running = job.status === 'running';
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge tone={toneOf(job.status)}>
        <span className="inline-flex items-center gap-1.5">
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              running ? 'animate-pulse bg-info' : job.status === 'done' ? 'bg-success' : 'bg-danger'
            }`}
          />
          {statusLabel(job.status)}
        </span>
      </Badge>
      <span className="font-mono text-xs text-faint" title={`${job.kind}:${job.job_id}`}>
        {shortSenderId(job.job_id)}
      </span>
      <span className="text-xs text-faint tabular-nums">{formatElapsed(elapsed)}</span>
      <span className="flex-1" />
      {job.session_id !== undefined && (
        <span className="font-mono text-xs text-faint" title={job.session_id}>
          {shortSenderId(job.session_id)}
        </span>
      )}
    </div>
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

/**
 * bash 专属卡体（首个消费者）：科技蓝命令片段 + exit code + log tail（按需 jobs.log，
 * 点一次读一次，不轮询）。kind 专属字段从 payload 读（机制层不解释）。
 */
function BashJobBody({
  job,
  entry,
  client,
  elapsed,
}: {
  job: AsyncJobMeta;
  entry: AsyncJobCardEntry;
  client: GatewayClient;
  elapsed: number;
}) {
  const running = job.status === 'running';
  const payload = job.payload ?? {};
  const command = typeof payload.command === 'string' ? payload.command : undefined;
  const exitCode =
    typeof payload.exit_code === 'number' || payload.exit_code === null
      ? (payload.exit_code as number | null)
      : undefined;

  const [logOpen, setLogOpen] = useState(false);
  const [logTail, setLogTail] = useState<string | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);

  const toggleLog = () => {
    const opening = !logOpen;
    setLogOpen(opening);
    if (!opening || logTail !== null || logLoading) return;
    setLogLoading(true);
    setLogError(null);
    void (async () => {
      try {
        const body = await client.rpc<{ job_id: string; tail: string }>('jobs.log', {
          job_id: job.job_id,
          max_bytes: 8192,
        });
        setLogTail(typeof body?.tail === 'string' ? body.tail : '');
      } catch (error) {
        setLogError(error instanceof Error ? error.message : String(error));
      } finally {
        setLogLoading(false);
      }
    })();
  };

  return (
    <>
      <JobHeader job={job} elapsed={elapsed} />
      {exitCode !== undefined && exitCode !== null && (
        <span className="font-mono text-xs text-faint">exit {exitCode}</span>
      )}
      {command !== undefined && (
        <p className="m-0 truncate font-mono text-xs leading-relaxed text-muted" title={command}>
          $ {command}
        </p>
      )}
      {!running && <ResultBody summary={entry.summary} />}
      {logOpen && (
        <div className="rounded-sm bg-sunken px-3 py-2">
          {logLoading ? (
            <p className="m-0 text-xs text-faint">{t('inbox.asyncJob.logLoading')}</p>
          ) : logError !== null ? (
            <p className="m-0 text-xs text-danger">{logError}</p>
          ) : logTail !== null ? (
            <pre className="m-0 max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-muted">
              {logTail === '' ? t('inbox.asyncJob.logEmpty') : logTail}
            </pre>
          ) : null}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="link" className="text-xs" aria-expanded={logOpen} onClick={toggleLog}>
          {logOpen ? t('inbox.asyncJob.logHide') : t('inbox.asyncJob.logShow')}
        </Button>
      </div>
    </>
  );
}

/**
 * 通用卡体（未知 / 未来 kind 的兜底，如 ask 问题卡尚未实现时）：状态头部 + 结果正文。
 * 新 kind 落地时在此按 kind 增专属卡体（扩展点），inbox 核心无需改动。
 */
function GenericJobBody({
  job,
  entry,
  elapsed,
}: {
  job: AsyncJobMeta;
  entry: AsyncJobCardEntry;
  elapsed: number;
}) {
  return (
    <>
      <JobHeader job={job} elapsed={elapsed} />
      <span className="font-mono text-xs text-faint">{job.kind}</span>
      {job.status !== 'running' && <ResultBody summary={entry.summary} />}
    </>
  );
}

/**
 * 通用异步作业卡入口：按 `async_job.kind` 分派专属卡体。bash→命令卡（BashJobBody）；
 * 其余 kind→通用卡（GenericJobBody，ask 问题卡未来在此接入）。
 *
 * 表面 = StreamCard 折叠壳（与 agent 排队黄条 QueuedNotice 同一基座，同形同高）：
 * **默认收缩**（running/done/failed 皆然），卡头单行 = 状态点（running 脉冲）+ kind
 * 身份槽 + 短 jobId + 耗时（running 跳秒零 RPC）+ exit code + 命令预览 ellipsis + chevron；
 * 展开才显完整 JobHeader / 命令 / ResultBody / log tail（原有卡体整体进 children，逻辑不动）。
 * 色调走 notice-block 家族中性档（照 agent 条口径 tone neutral），状态色只留在状态点上；
 * 家族身份圆点不叠（状态点已画在 title 槽，见 chat.css `.stream-card-job`）。
 */
export function AsyncJobCard({
  entry,
  client,
  onClaim,
  claimBusy = false,
}: {
  entry: AsyncJobCardEntry;
  client: GatewayClient;
  /** 「我已处理」（q-bash-inbox-integrate）：调用方接 `agents.claim`；缺省 = 不渲染认领键。
   *  只对 done/failed 生效 —— running 占位不可消费（服务端 claim 同口径跳过 `pending`）。 */
  onClaim?: () => void;
  /** 认领在途：键禁用 + 文案换「标记中…」（同一条同时只允许一次写操作）。 */
  claimBusy?: boolean;
}) {
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
      // 状态点 + kind 身份槽：点色复用 toneOf，running 加脉冲（与 JobHeader 同一口径）。
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
        <BashJobBody job={job} entry={entry} client={client} elapsed={elapsed} />
      ) : (
        <GenericJobBody job={job} entry={entry} elapsed={elapsed} />
      )}
      {/* 用户侧收口键（done/failed 才给）：展开体末尾，QueuedNotice 处置键同款位置。
          文案 / 在途态复用 inbox 消息卡同一组键（chat.pending.claim / claimInFlight）。 */}
      {!running && onClaim !== undefined && (
        <div className="flex items-center justify-end gap-2 pt-1.5">
          <Button variant="plain" size="small" disabled={claimBusy} onClick={onClaim}>
            {claimBusy ? t('chat.pending.claimInFlight') : t('chat.pending.claim')}
          </Button>
        </div>
      )}
    </StreamCard>
  );
}
