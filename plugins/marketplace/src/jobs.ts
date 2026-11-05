/**
 * In-memory install/update jobs (CONTRACT-0.44 §3, async install).
 *
 * `install` / `update` create a job, return `{job_id}` immediately, and run the
 * download/verify/extract/config work in the background. This keeps the host's
 * 10s `plugin.rpc` timeout away from a 50 MiB install. The UI polls `job` every
 * ~500ms; `jobs` lists everything from the last 24 hours.
 *
 * Jobs are process-local: the plugin child restarting loses them, which is
 * acceptable because a killed install has already rolled back its target.
 *
 * @module @vessel-agent/plugin-marketplace/jobs
 */

import { randomUUID } from 'node:crypto';
import { MarketplaceError, messageOf } from './errors.js';

export const JOB_TTL_MS = 24 * 60 * 60 * 1000;

export type JobKind = 'install' | 'update';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';
export type JobPhase =
  | 'queued'
  | 'resolving'
  | 'downloading'
  | 'verifying'
  | 'extracting'
  | 'installing'
  | 'configuring'
  | 'done'
  | 'failed';

export interface JobProgress {
  phase: JobPhase;
  bytesDone?: number;
  bytesTotal?: number;
}

export interface JobError {
  code: string;
  message: string;
}

export interface JobRecord {
  jobId: string;
  kind: JobKind;
  pluginId: string;
  version?: string;
  status: JobStatus;
  phase: JobPhase;
  bytesDone: number;
  bytesTotal: number;
  createdAt: number;
  updatedAt: number;
  error?: JobError;
  result?: unknown;
}

const jobs = new Map<string, JobRecord>();

function prune(now = Date.now()): void {
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) jobs.delete(id);
  }
}

/** Create a queued job. The caller starts it with {@link runJob}. */
export function createJob(kind: JobKind, pluginId: string, version?: string): JobRecord {
  prune();
  const now = Date.now();
  const job: JobRecord = {
    jobId: randomUUID(),
    kind,
    pluginId,
    ...(version !== undefined ? { version } : {}),
    status: 'queued',
    phase: 'queued',
    bytesDone: 0,
    bytesTotal: 0,
    createdAt: now,
    updatedAt: now,
  };
  jobs.set(job.jobId, job);
  return job;
}

function report(job: JobRecord, progress: JobProgress): void {
  job.status = 'running';
  job.phase = progress.phase;
  if (progress.bytesDone !== undefined) job.bytesDone = progress.bytesDone;
  if (progress.bytesTotal !== undefined) job.bytesTotal = progress.bytesTotal;
  job.updatedAt = Date.now();
}

/**
 * Run a job in the background. Errors are captured into the job so the poller
 * sees `status: failed` instead of an unhandled rejection.
 */
export function runJob(
  job: JobRecord,
  task: (reportProgress: (progress: JobProgress) => void) => Promise<unknown>,
  hooks: { onDone?(result: unknown): void } = {},
): void {
  job.status = 'running';
  job.phase = 'resolving';
  job.updatedAt = Date.now();
  void task((progress) => report(job, progress))
    .then((result) => {
      job.status = 'done';
      job.phase = 'done';
      job.result = result;
      if (job.bytesTotal > 0 && job.bytesDone < job.bytesTotal && job.phase === 'done') {
        job.bytesDone = job.bytesTotal;
      }
      job.updatedAt = Date.now();
      hooks.onDone?.(result);
    })
    .catch((error: unknown) => {
      job.status = 'failed';
      job.phase = 'failed';
      job.error =
        error instanceof MarketplaceError
          ? { code: error.code, message: error.message }
          : { code: 'internal', message: messageOf(error) };
      job.updatedAt = Date.now();
    });
}

export function getJob(jobId: string, now = Date.now()): JobRecord | undefined {
  prune(now);
  return jobs.get(jobId);
}

export function listJobs(now = Date.now()): JobRecord[] {
  prune(now);
  return [...jobs.values()].sort((left, right) => right.createdAt - left.createdAt);
}

/** Wire DTO: `{status, phase, bytes_done, bytes_total, error?}` plus identity. */
export function jobDto(job: JobRecord): Record<string, unknown> {
  return {
    job_id: job.jobId,
    kind: job.kind,
    plugin_id: job.pluginId,
    ...(job.version !== undefined ? { version: job.version } : {}),
    status: job.status,
    phase: job.phase,
    bytes_done: job.bytesDone,
    bytes_total: job.bytesTotal,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    ...(job.error !== undefined ? { error: job.error } : {}),
    ...(job.result !== undefined ? { result: job.result } : {}),
  };
}
