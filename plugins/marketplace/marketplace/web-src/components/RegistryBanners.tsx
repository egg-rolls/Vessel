import type { Translator } from '../i18n';
import type { RegistryMeta } from '../types';
import { Banner } from './States';

/** Custom-registry and stale-cache warnings shared by all three tabs. */
export function RegistryBanners({
  registry,
  t,
}: {
  registry: RegistryMeta | undefined;
  t: Translator;
}) {
  if (registry === undefined) return null;
  return (
    <>
      {registry.trusted === false ? (
        <Banner tone="danger">{t('registry.custom.banner', { url: registry.url })}</Banner>
      ) : null}
      {registry.stale ? <Banner tone="warn">{t('registry.stale')}</Banner> : null}
    </>
  );
}
