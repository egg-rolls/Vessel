import { Box, Text, useInput } from 'ink';
import type React from 'react';
import { useEffect, useState } from 'react';
import { DashboardService } from '../dashboard/dashboard-service.js';
import type { AssetInfo } from '../dashboard/types.js';
import type { ReplContext } from '../repl-context.js';

export type AssetBrowserKind = 'assets' | 'plugins' | 'mcp' | 'skills' | 'tools';

interface AssetBrowserProps { kind: AssetBrowserKind; ctx: ReplContext; onClose: () => void }
const titles: Record<AssetBrowserKind, string> = { assets: 'Assets', plugins: 'Plugins', mcp: 'MCP Servers', skills: 'Skills', tools: 'Tools' };

function getRows(kind: AssetBrowserKind, assets: AssetInfo): Array<{ name: string; detail: string }> {
  if (kind === 'assets') return [
    { name: 'Plugins', detail: String(assets.plugins.length) },
    { name: 'MCP Servers', detail: String(assets.mcpServers.length) },
    { name: 'Skills', detail: String(assets.skills.length) },
    { name: 'Tools', detail: String(assets.tools.length) },
  ];
  if (kind === 'plugins') return assets.plugins.map((item) => ({ name: item.name, detail: item.enabled ? 'enabled' : 'disabled' }));
  if (kind === 'mcp') return assets.mcpServers.map((item) => ({ name: item.name, detail: `${item.status} · tools: ${item.tools}` }));
  if (kind === 'skills') return assets.skills.map((item) => ({ name: item.name, detail: item.description }));
  return assets.tools.map((item) => ({ name: item.name, detail: item.description }));
}

export const AssetBrowser: React.FC<AssetBrowserProps> = ({ kind, ctx, onClose }) => {
  const [assets, setAssets] = useState<AssetInfo | null>(null);
  const [selected, setSelected] = useState(0);
  const [detail, setDetail] = useState(false);
  const refresh = () => new DashboardService(ctx).getAssets().then(setAssets);
  useEffect(() => { void refresh(); }, [ctx, ctx.mcpServers]);
  const items = assets ? getRows(kind, assets) : [];
  useInput((input, key) => {
    if (key.escape) return onClose();
    if (key.return) return setDetail((value) => !value);
    if (input.toLowerCase() === 'r') return void refresh();
    if (key.upArrow) return setSelected((value) => Math.max(0, value - 1));
    if (key.downArrow) return setSelected((value) => Math.min(Math.max(0, items.length - 1), value + 1));
  });
  const selectedItem = items[selected];
  return <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1}>
    <Text bold color="blue">{titles[kind]}</Text>
    {!assets && <Text color="gray">Loading...</Text>}
    {assets && items.length === 0 && <Text color="gray">No assets available.</Text>}
    {items.map((item, index) => <Text key={item.name} color={index === selected ? 'cyan' : undefined}>{index === selected ? '❯ ' : '  '}{item.name}{detail && index === selected ? ` — ${item.detail}` : ''}</Text>)}
    <Text color="gray">↑↓ Navigate  Enter Details  R Refresh  Esc Back</Text>
    {detail && selectedItem && <Text color="gray">{selectedItem.detail}</Text>}
  </Box>;
};
