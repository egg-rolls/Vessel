import { Button, cn } from '@vessel-agent/plugin-ui';
import type { ReactNode } from 'react';

export type BannerTone = 'danger' | 'warn' | 'info' | 'success';

const BANNER_TONE: Record<BannerTone, string> = {
  danger: 'bg-danger-soft text-danger',
  warn: 'bg-warn-soft text-warn',
  info: 'bg-info-soft text-info',
  success: 'bg-success-soft text-success',
};

export function Banner({ tone = 'info', children }: { tone?: BannerTone; children: ReactNode }) {
  return (
    <p className={cn('rounded-sm px-3 py-2 text-sm wrap-anywhere', BANNER_TONE[tone])}>
      {children}
    </p>
  );
}

export function LoadingState({ label }: { label: string }) {
  return (
    <p role="status" className="py-10 text-center text-sm text-muted">
      {label}
    </p>
  );
}

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-md bg-raised px-6 py-10 text-center shadow-elev-1">
      <p className="text-md font-semibold text-ink">{title}</p>
      <p className="mx-auto mt-1.5 max-w-prose text-sm text-muted">{detail}</p>
    </div>
  );
}

export function ErrorState({
  message,
  retryLabel,
  onRetry,
}: {
  message: string;
  retryLabel: string;
  onRetry: () => void;
}) {
  return (
    <div role="alert" className="rounded-md bg-danger-soft px-4 py-4">
      <p className="text-md text-danger wrap-anywhere">{message}</p>
      <Button className="mt-3" onClick={onRetry}>
        {retryLabel}
      </Button>
    </div>
  );
}
