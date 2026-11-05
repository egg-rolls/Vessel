import { type KeyValueItem, KeyValueList } from '@vessel-agent/plugin-ui';
import type { Translator } from '../i18n';
import type { RegistryPermissions } from '../types';

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
