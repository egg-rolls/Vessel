/**
 * Typed marketplace RPC facade over the host bridge.
 *
 * `install` / `update` return `{job_id}` immediately (CONTRACT-0.44 §3); the UI
 * polls `job` so a large download never sits on the host's RPC timeout.
 */
import { PluginRpcClient } from '@vessel-agent/plugin-ui';
import type { Translator } from './i18n';
import type {
  DetailResult,
  InstalledItem,
  InstalledResult,
  JobDto,
  SearchResult,
  StartJobResult,
} from './types';

const READ_TIMEOUT_MS = 15_000;
const MUTATION_TIMEOUT_MS = 120_000;
const JOB_POLL_MS = 500;
const JOB_MAX_MS = 30 * 60 * 1000;

export type UiErrorKind = 'timeout' | 'job_failed' | 'job_timeout' | 'missing_job_id';

/** UI-level failures that need copy the child process cannot know about. */
export class MarketplaceUiError extends Error {
  readonly kind: UiErrorKind;

  constructor(kind: UiErrorKind, message: string) {
    super(message);
    this.name = 'MarketplaceUiError';
    this.kind = kind;
  }
}

export function describeError(error: unknown, t: Translator): string {
  if (error instanceof MarketplaceUiError) {
    if (error.kind === 'timeout') return t('rpc.timeout');
    if (error.kind === 'job_timeout') return t('job.timeout');
    if (error.kind === 'missing_job_id') return t('job.noId');
    return error.message || t('job.failed');
  }
  return error instanceof Error ? error.message : String(error);
}

export type RegistryFailure = 'missing' | 'unreachable';

/**
 * The host bridge forwards only the child's error message (the stable
 * `data.code` is dropped), so classify on the wording the child emits.
 * `registry_url_missing` is a setup state, everything else registry-shaped
 * means the configured index could not be reached.
 */
export function registryFailureOf(message: string): RegistryFailure | null {
  if (/registry_url is not configured|registry_url_missing/i.test(message)) return 'missing';
  if (/registry|could not fetch|http \d{3}/i.test(message)) return 'unreachable';
  return null;
}

/** Show the configured URL when the fetch error happens to carry it. */
export function urlInMessage(message: string): string | undefined {
  return message.match(/https?:\/\/[^\s"'<>]+/)?.[0];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MarketplaceApi {
  private readonly client: PluginRpcClient;

  constructor(client: PluginRpcClient = new PluginRpcClient()) {
    this.client = client;
  }

  /** Host → page refresh (`vessel.plugin.refresh`). */
  onRefresh(listener: () => void): () => void {
    return this.client.onRefresh(listener);
  }

  dispose(): void {
    this.client.dispose();
  }

  search(params: { query?: string; category?: string }): Promise<SearchResult> {
    return this.call('search', params, READ_TIMEOUT_MS);
  }

  detail(id: string): Promise<DetailResult> {
    return this.call('detail', { id }, READ_TIMEOUT_MS);
  }

  install(id: string, version: string): Promise<StartJobResult> {
    return this.call('install', { id, version }, MUTATION_TIMEOUT_MS);
  }

  remove(id: string): Promise<unknown> {
    return this.call('remove', { id }, MUTATION_TIMEOUT_MS);
  }

  update(id: string): Promise<StartJobResult> {
    return this.call('update', { id }, MUTATION_TIMEOUT_MS);
  }

  installed(force = false): Promise<InstalledResult> {
    return this.call('installed', force ? { force: true } : {}, READ_TIMEOUT_MS);
  }

  job(jobId: string): Promise<JobDto> {
    return this.call('job', { job_id: jobId }, READ_TIMEOUT_MS);
  }

  /** Poll until the job settles; `onProgress` runs once per poll. */
  async waitForJob(jobId: string, onProgress: (job: JobDto) => void): Promise<JobDto> {
    const started = Date.now();
    for (;;) {
      const job = await this.job(jobId);
      onProgress(job);
      if (job.status === 'done') return job;
      if (job.status === 'failed') {
        throw new MarketplaceUiError('job_failed', job.error?.message ?? '');
      }
      if (Date.now() - started > JOB_MAX_MS) {
        throw new MarketplaceUiError('job_timeout', '');
      }
      await delay(JOB_POLL_MS);
    }
  }

  private call<T>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new MarketplaceUiError('timeout', `rpc "${method}" timed out`));
      }, timeoutMs);
      this.client.call<T>(method, params).then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
}

/** Narrow an installed row for the update action. */
export function canUpdate(item: InstalledItem): boolean {
  return item.update_available === true;
}
