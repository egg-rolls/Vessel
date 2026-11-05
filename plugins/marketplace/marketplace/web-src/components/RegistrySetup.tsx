import { Button, Section } from '@vessel-agent/plugin-ui';
import { DEFAULT_REGISTRY_URL } from '../../src/settings';
import type { Translator } from '../i18n';
import { Banner } from './States';

const CONFIG_SNIPPET = `plugins:
  - name: marketplace
    config:
      registry_url: ${DEFAULT_REGISTRY_URL}`;

/**
 * The child answers `registry_url_missing` until the user configures a
 * registry; the page must stay usable and show the exact config entry.
 */
export function RegistrySetup({ t, onRetry }: { t: Translator; onRetry: () => void }) {
  return (
    <Section title={t('setup.title')} description={t('setup.missing')}>
      <pre className="mt-1 overflow-x-auto rounded-sm bg-sunken p-3 font-mono text-xs leading-relaxed text-ink">
        <code>{CONFIG_SNIPPET}</code>
      </pre>
      <p className="mt-2 text-sm text-muted">
        {t('setup.hint', { path: '~/.vessel/config.yaml' })}
      </p>
      <Button className="mt-3" onClick={onRetry}>
        {t('button.retry')}
      </Button>
    </Section>
  );
}

/** Registry configured but unreachable: keep the URL and the fix visible. */
export function RegistryUnreachable({
  message,
  url,
  t,
  onRetry,
}: {
  message: string;
  url: string | undefined;
  t: Translator;
  onRetry: () => void;
}) {
  return (
    <Section
      title={t('setup.unreachable')}
      description={
        url !== undefined
          ? t('setup.url', { url })
          : t('setup.defaultNote', { url: DEFAULT_REGISTRY_URL })
      }
    >
      <p className="text-sm text-muted wrap-anywhere">{message}</p>
      <p className="mt-2 text-sm text-muted">{t('setup.customHint')}</p>
      <Button className="mt-3" onClick={onRetry}>
        {t('button.retry')}
      </Button>
    </Section>
  );
}

/** Inline note for tabs that still list data when the registry is down. */
export function RegistryErrorNote({ message, t }: { message: string; t: Translator }) {
  return (
    <div className="flex flex-col gap-1">
      <Banner tone="warn">{t('registry.unavailable', { message })}</Banner>
      <p className="text-sm text-muted">{t('setup.customHint')}</p>
    </div>
  );
}
