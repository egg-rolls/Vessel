import { PHASE_MESSAGE_KEY, type Translator } from '../i18n';
import type { JobDto } from '../types';
import { Banner } from './States';

export type JobState =
  | { label: string; status: 'running'; job?: JobDto }
  | { label: string; status: 'done' }
  | { label: string; status: 'failed'; error: string };

function fmtBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Install/update job readout: phase, bytes, and a token-colored bar. */
export function JobStatus({ state, t }: { state: JobState | null; t: Translator }) {
  if (state === null) return <div aria-live="polite" />;

  if (state.status === 'done') {
    return (
      <div aria-live="polite">
        <Banner tone="success">{t('state.done')}</Banner>
      </div>
    );
  }

  if (state.status === 'failed') {
    return (
      <div aria-live="polite">
        <Banner tone="danger">{state.error}</Banner>
      </div>
    );
  }

  const job = state.job;
  if (job === undefined) {
    return (
      <p aria-live="polite" role="status" className="text-sm text-muted">
        {state.label}…
      </p>
    );
  }

  const total = job.bytes_total;
  const done = job.bytes_done;
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const phaseKey = PHASE_MESSAGE_KEY[job.phase];
  const phase = phaseKey === undefined ? job.phase : t(phaseKey);

  return (
    <div aria-live="polite" className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p role="status" className="text-sm text-ink">
          {t('job.running', { label: state.label, phase })}
        </p>
        <span className="font-mono text-xs text-muted">
          {total > 0 ? `${fmtBytes(done)} / ${fmtBytes(total)}` : ''}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-sunken">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-200"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
