/** Plugin Host（E10）的纯状态/校验函数，便于探针与页面共用。 */
import type { PluginListItem } from '../../gateway/types';

export interface RegistryRpcClient {
  rpc<T>(method: string, params?: Record<string, unknown>): Promise<T>;
}

/** `plugins.list` 里的 marketplace 条目；禁用时仍返回（用于展示状态）。 */
export function marketplaceOf(plugins: readonly PluginListItem[]): PluginListItem | undefined {
  return plugins.find((plugin) => plugin.name === 'marketplace');
}

/** `plugins[].config.registry_url`（仅接受字符串）。 */
export function registryUrlOf(plugin: PluginListItem | undefined): string {
  const value = plugin?.config?.registry_url;
  return typeof value === 'string' ? value : '';
}

/** 仅 HTTPS；localhost / 127.0.0.1 / ::1 允许 http。空串无效。 */
export function isValidRegistryUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '') return false;
  try {
    const url = new URL(trimmed);
    if (url.protocol === 'https:') return true;
    if (url.protocol !== 'http:') return false;
    return (
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '[::1]' ||
      url.hostname === '::1'
    );
  } catch {
    return false;
  }
}

/** 表单只在已连接且 marketplace 启用时可编辑。 */
export function canEditRegistry(
  marketplace: PluginListItem | undefined,
  connected: boolean,
): boolean {
  return connected && marketplace?.enabled === true;
}

/** E10 write RPC；成功由调用方 revalidate plugins/config。 */
export async function configureMarketplace(
  client: RegistryRpcClient,
  registryUrl: string,
): Promise<void> {
  await client.rpc('plugin.marketplace.configure', { registry_url: registryUrl.trim() });
}
