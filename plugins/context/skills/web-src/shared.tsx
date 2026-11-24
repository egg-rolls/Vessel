import { Button, Section } from '@vessel-agent/plugin-ui';
import type { Translator } from './i18n';

/**
 * Minimal RPC surface the views need: the iframe tier's PluginRpcClient and
 * the embed tier's host.rpc adapter both satisfy it (one set of display
 * components, two tiers).
 */
export interface RpcCaller {
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
}

export interface ViewProps {
  client: RpcCaller;
  /** iframe tier is driven by vessel.plugin.refresh; embed tier refetches after writes. */
  refreshKey: number;
  t: Translator;
}

export type LoadState<T> =
  | { status: 'loading' }
  | { status: 'error'; error: Error }
  | { status: 'ready'; data: T };

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function LoadingState({ label }: { label: string }) {
  return (
    <p className="py-6 text-md text-muted" aria-live="polite">
      {label}
    </p>
  );
}

export function EmptyState({ title, description }: { title: string; description: string }) {
  return <Section title={title} description={description} />;
}

export function ErrorState({
  error,
  onRetry,
  title,
  retryLabel,
}: {
  error: Error;
  onRetry: () => void;
  title: string;
  retryLabel: string;
}) {
  return (
    <Section
      title={title}
      description={error.message}
      actions={
        <Button variant="primary" onClick={onRetry}>
          {retryLabel}
        </Button>
      }
    />
  );
}
