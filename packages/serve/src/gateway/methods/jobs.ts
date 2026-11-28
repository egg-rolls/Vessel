/**
 * jobs.* 方法（list / log）—— 异步 bash 作业的只读观察面（q-async-bash-viz）。
 *
 * 注册表唯一真相源是 basic-tools 的进程级作业表（会话绑定经 job.sessionId 过滤）；serve
 * 只出形状与稳定码，不持有第二份状态。缺省（装配未注入 jobs 端口）= handler 返回
 * `not_supported`（与 kanban/teams 同一先例），旧装配零回归。
 *
 * 用途：WebUI 会话视图的 run 徽标「等待异步任务 X」初始态（jobs.list）+ inbox 作业卡的
 * log tail 按钮（jobs.log）。live 更新走时间线 bash.job.* 事实事件，零轮询。
 *
 * @module @vessel-agent/serve
 */

import { RpcError, type RpcMethodDefinition } from '../../rpc.js';
import { stringParam } from './common.js';

/** 一条作业快照（镜像 basic-tools `AsyncBashJobSnapshot`，只读）。 */
export interface JobSnapshotLike {
  jobId: string;
  sessionId?: string;
  runId?: string;
  command: string;
  pid?: number;
  status: 'running' | 'done' | 'failed';
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  logPath: string;
  timedOut: boolean;
  detached: boolean;
}

/** 装配注入的只读作业端口（缺省 = jobs.* 返回 not_supported）。 */
export interface JobsPort {
  list(sessionId?: string): JobSnapshotLike[];
  logTail(jobId: string, maxBytes?: number): string | null;
}

export interface JobMethodsDeps {
  jobs?: JobsPort;
}

const jobSnapshotSchema = {
  type: 'object',
  required: ['job_id', 'command', 'status', 'started_at', 'log_path'],
  properties: {
    job_id: { type: 'string' },
    session_id: { type: 'string' },
    run_id: { type: 'string' },
    command: { type: 'string' },
    pid: { type: 'number' },
    status: { type: 'string', enum: ['running', 'done', 'failed'] },
    started_at: { type: 'number' },
    ended_at: { type: 'number' },
    exit_code: { type: ['number', 'null'] },
    log_path: { type: 'string' },
    timed_out: { type: 'boolean' },
    detached: { type: 'boolean' },
  },
} as const;

/** 快照 → wire 形状（snake_case，与 RPC 口径一致）。 */
function wireJob(job: JobSnapshotLike): Record<string, unknown> {
  return {
    job_id: job.jobId,
    command: job.command,
    status: job.status,
    started_at: job.startedAt,
    log_path: job.logPath,
    timed_out: job.timedOut,
    detached: job.detached,
    ...(job.sessionId !== undefined ? { session_id: job.sessionId } : {}),
    ...(job.runId !== undefined ? { run_id: job.runId } : {}),
    ...(job.pid !== undefined ? { pid: job.pid } : {}),
    ...(job.endedAt !== undefined ? { ended_at: job.endedAt } : {}),
    ...(job.exitCode !== undefined ? { exit_code: job.exitCode } : {}),
  };
}

export function createJobMethods(deps: JobMethodsDeps): RpcMethodDefinition[] {
  const requireJobs = (): JobsPort => {
    if (deps.jobs === undefined) {
      throw new RpcError('not_supported', 'jobs port is not wired');
    }
    return deps.jobs;
  };

  return [
    {
      name: 'jobs.list',
      permission: 'read',
      params_schema: {
        type: 'object',
        properties: { session_id: { type: 'string' } },
      },
      result_schema: {
        type: 'object',
        required: ['jobs'],
        properties: { jobs: { type: 'array', items: jobSnapshotSchema } },
      },
      handler: (params) => {
        const jobs = requireJobs();
        const sessionId = typeof params.session_id === 'string' ? params.session_id : undefined;
        return { jobs: jobs.list(sessionId).map(wireJob) };
      },
    },
    {
      name: 'jobs.log',
      permission: 'read',
      params_schema: {
        type: 'object',
        required: ['job_id'],
        properties: {
          job_id: { type: 'string', minLength: 1 },
          max_bytes: { type: 'integer', minimum: 1, maximum: 65536 },
        },
      },
      result_schema: {
        type: 'object',
        required: ['job_id', 'tail'],
        properties: { job_id: { type: 'string' }, tail: { type: 'string' } },
      },
      handler: (params) => {
        const jobs = requireJobs();
        const jobId = stringParam(params, 'job_id');
        const maxBytes =
          typeof params.max_bytes === 'number' && Number.isFinite(params.max_bytes)
            ? Math.min(65536, Math.max(1, Math.floor(params.max_bytes)))
            : 8192;
        const tail = jobs.logTail(jobId, maxBytes);
        if (tail === null) {
          throw new RpcError('not_found', `Job not found or log unavailable: ${jobId}`, {
            resource: 'job',
            id: jobId,
          });
        }
        return { job_id: jobId, tail };
      },
    },
  ];
}
