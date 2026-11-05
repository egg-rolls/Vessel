/**
 * 能力域顶层页：Tools / MCP / Channels 各自独立路由。
 *
 * 0.45 从合并的 Integrations 页拆出；旧 `#/integrations/<tab>` 由 router 别名。
 * 页头只保留标题，不再放 AI 用途说明。
 */

import { PageHeader } from '../../components/PageHeader';
import { useConnection } from '../../gateway/ConnectionProvider';
import { t, useLocale } from '../../i18n';
import { ChannelsPanel } from './ChannelsPanel';
import { McpPanel } from './McpPanel';
import { ToolsPanel } from './ToolsPanel';

export type CapabilityDomain = 'tools' | 'mcp' | 'channels';

export function CapabilityView({ domain }: { domain: CapabilityDomain }) {
  useLocale();
  const { tenantId } = useConnection();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto overscroll-contain p-6 pb-10 max-compact:px-3 max-compact:pt-4 max-compact:pb-7 [&>*]:mx-auto [&>*]:w-full [&>*]:max-w-[var(--content-max)]">
      <PageHeader title={t(`nav.domain.${domain}`)} tenantId={tenantId} />
      <div className="mt-5 flex flex-col gap-4">
        {domain === 'tools' && <ToolsPanel />}
        {domain === 'mcp' && <McpPanel />}
        {domain === 'channels' && <ChannelsPanel />}
      </div>
    </div>
  );
}
