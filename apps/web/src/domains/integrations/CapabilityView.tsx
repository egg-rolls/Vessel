/**
 * 能力域顶层页：Tools / MCP / Channels 各自独立路由。
 *
 * 0.45 从合并的 Integrations 页拆出；旧 `#/integrations/<tab>` 由 router 别名。
 * 页头只保留标题，不再放 AI 用途说明。
 */

import { PageScaffold } from '@vessel-agent/plugin-ui';
import { t, useLocale } from '../../i18n';
import { ChannelsPanel } from './ChannelsPanel';
import { McpPanel } from './McpPanel';
import { ToolsPanel } from './ToolsPanel';

export type CapabilityDomain = 'tools' | 'mcp' | 'channels';

const SUBTITLE_KEYS: Record<CapabilityDomain, string> = {
  tools: 'integrations.tools.subtitle',
  mcp: 'integrations.mcp.subtitle',
  channels: 'integrations.channels.subtitle',
};

export function CapabilityView({ domain }: { domain: CapabilityDomain }) {
  useLocale();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto overscroll-contain">
      <PageScaffold title={t(`nav.domain.${domain}`)} subtitle={t(SUBTITLE_KEYS[domain])}>
        {domain === 'tools' && <ToolsPanel />}
        {domain === 'mcp' && <McpPanel />}
        {domain === 'channels' && <ChannelsPanel />}
      </PageScaffold>
    </div>
  );
}
