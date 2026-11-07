import { type KeyValueItem, KeyValueList } from '@vessel-agent/plugin-ui';
import type { Translator } from '../i18n';
import type { CatalogSurfaceSummary, RegistryPermissions } from '../types';

/** fs / net / process / secrets / events / rpc — the trust disclosure surface. */
export function permissionItems(
  permissions: RegistryPermissions | undefined,
  t: Translator,
): KeyValueItem[] {
  const perms = permissions ?? {};
  const list = (values: string[] | undefined) =>
    Array.isArray(values) && values.length > 0 ? values.join(', ') : t('permissions.none');
  const flag = (value: boolean | undefined) =>
    value === true ? t('permissions.allowed') : t('permissions.no');

  return [
    { key: 'fs', label: 'fs', value: list(perms.fs) },
    { key: 'net', label: 'net', value: list(perms.net) },
    { key: 'process', label: 'process', value: flag(perms.process) },
    { key: 'secrets', label: 'secrets', value: flag(perms.secrets) },
    { key: 'events', label: 'events', value: list(perms.events) },
    { key: 'rpc', label: 'rpc', value: list(perms.rpc) },
  ];
}

export function PermissionList({
  permissions,
  t,
}: {
  permissions: RegistryPermissions | undefined;
  t: Translator;
}) {
  return <KeyValueList items={permissionItems(permissions, t)} />;
}

/** HTTP route / CLI command summary; declared and effective share this layout. */
export function surfaceItems(
  summary: CatalogSurfaceSummary | undefined,
  t: Translator,
): KeyValueItem[] {
  const none = <span className="text-muted">{t('surface.none')}</span>;
  return [
    {
      key: 'http',
      label: t('surface.http'),
      value:
        summary !== undefined && summary.http.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {summary.http.map((route) => (
              <li key={route.id} className="font-mono text-xs">
                <span className="text-ink">{route.id}</span>{' '}
                <span className="text-muted">
                  {route.method} {route.path}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          none
        ),
    },
    {
      key: 'cli',
      label: t('surface.cli'),
      value:
        summary !== undefined && summary.cli.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {summary.cli.map((command) => (
              <li key={command.path.join(' ')} className="font-mono text-xs">
                <span className="text-ink">{command.path.join(' ')}</span>
                {command.description !== undefined ? (
                  <span className="text-muted"> — {command.description}</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          none
        ),
    },
  ];
}

/**
 * Read-only declared vs effective surfaces (CONTRACT-0.48 §8.3 / R3).
 * Never writes config and never adds RPCs; external plugins only receive the
 * ids listed under `expose`.
 */
export function SurfaceList({
  declared,
  effective,
  builtin,
  t,
}: {
  declared: CatalogSurfaceSummary;
  effective: CatalogSurfaceSummary | undefined;
  builtin: boolean;
  t: Translator;
}) {
  const heading = 'font-mono text-2xs tracking-widest text-faint uppercase';
  return (
    <div className="flex flex-col gap-2">
      <div>
        <h4 className={heading}>{t('surface.declared')}</h4>
        <KeyValueList items={surfaceItems(declared, t)} />
      </div>
      <div>
        <h4 className={heading}>{t('surface.effective')}</h4>
        <KeyValueList items={surfaceItems(effective, t)} />
      </div>
      <p className="text-xs text-muted">
        {builtin ? t('surface.builtinHint') : t('surface.exposeHint')}
      </p>
    </div>
  );
}
