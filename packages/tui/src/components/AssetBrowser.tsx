import { Box, Text, useInput } from 'ink';
import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { DashboardService } from '../dashboard/dashboard-service.js';
import type { AssetInfo, DashboardData } from '../dashboard/types.js';
import type { ReplContext } from '../repl-context.js';

export type AssetBrowserKind = 'assets' | 'plugins' | 'mcp' | 'skills' | 'tools';

interface AssetBrowserProps {
  kind: AssetBrowserKind;
  ctx: ReplContext;
  onClose: () => void;
}
const titles: Record<AssetBrowserKind, string> = {
  assets: 'Assets',
  plugins: 'Plugins',
  mcp: 'MCP Servers',
  skills: 'Skills',
  tools: 'Tools',
};

function getRows(
  kind: AssetBrowserKind,
  assets: AssetInfo,
): Array<{ name: string; detail: string }> {
  if (kind === 'assets')
    return [
      { name: 'Plugins', detail: String(assets.plugins.length) },
      { name: 'MCP Servers', detail: String(assets.mcpServers.length) },
      { name: 'Skills', detail: String(assets.skills.length) },
      { name: 'Tools', detail: String(assets.tools.length) },
    ];
  if (kind === 'plugins')
    return assets.plugins.map((item) => ({
      name: item.name,
      detail: item.enabled ? 'enabled' : 'disabled',
    }));
  if (kind === 'mcp')
    return assets.mcpServers.map((item) => ({
      name: item.name,
      detail: `${item.status} · tools: ${item.tools}${item.error ? ` · ${item.error}` : ''}`,
    }));
  if (kind === 'skills')
    return assets.skills.map((item) => ({ name: item.name, detail: item.description }));
  return assets.tools.map((item) => ({
    name: item.name,
    detail: item.inputSchema ? `${item.description} · input: ${item.inputSchema}` : item.description,
  }));
}

export const AssetBrowser: React.FC<AssetBrowserProps> = ({ kind, ctx, onClose }) => {
  const [assets, setAssets] = useState<AssetInfo | null>(null);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [selected, setSelected] = useState(0);
  const [detail, setDetail] = useState(false);
  const [filter, setFilter] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  const refresh = useCallback(async () => {
    const service = new DashboardService(ctx);
    if (kind === 'assets') setDashboard(await service.getFullData());
    setAssets(await service.getAssets());
  }, [ctx, kind]);
  useEffect(() => {
    void refresh();
    if (kind !== 'mcp' && kind !== 'assets') return;
    const timer = setInterval(() => {
      void refresh();
    }, 500);
    return () => clearInterval(timer);
  }, [refresh]);
  const items = assets ? getRows(kind, assets) : [];
  useInput((input, key) => {
    if (key.escape) return onClose();
    if (input === '?') return setShowHelp((value) => !value);
    if (key.backspace || key.delete) return setFilter((value) => value.slice(0, -1));
    if (key.return) return setDetail((value) => !value);
    if (input.toLowerCase() === 'r') return void refresh();
    if (kind === 'mcp' && selectedItem && input.toLowerCase() === 'd') {
      ctx.mcpController?.disconnect(selectedItem.name);
      return void refresh();
    }
    if (kind === 'mcp' && selectedItem && input.toLowerCase() === 'c') {
      void ctx.mcpController?.reconnect(selectedItem.name).then(refresh);
      return;
    }
    if (kind === 'mcp' && selectedItem && input.toLowerCase() === 't') {
      void ctx.mcpController?.test(selectedItem.name).then(refresh);
      return;
    }
    if (!key.ctrl && !key.meta && input.length === 1 && /[\w- ]/.test(input)) {
      setFilter((value) => `${value}${input}`);
      setSelected(0);
      return;
    }
    if (key.upArrow) return setSelected((value) => Math.max(0, value - 1));
    if (key.downArrow)
      return setSelected((value) => Math.min(Math.max(0, filteredItems.length - 1), value + 1));
  });
  const filteredItems = items.filter((item) =>
    `${item.name} ${item.detail}`.toLowerCase().includes(filter.toLowerCase()),
  );
  const selectedItem = filteredItems[selected];
  if (kind === 'assets' && dashboard)
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1}>
        <Text bold color="blue">
          Vessel Assets
        </Text>
        <Text color="gray">Provider │ {dashboard.config.provider}</Text>
        <Text color="gray">Model │ {dashboard.config.model}</Text>
        <Text color="gray">Workspace │ {dashboard.config.workspace}</Text>
        <Text color="gray">Plugins │ {dashboard.assets.plugins.length}</Text>
        <Text color="gray">MCP │ {dashboard.assets.mcpServers.length}</Text>
        <Text color="gray">Skills │ {dashboard.assets.skills.length}</Text>
        <Text color="gray">Tools │ {dashboard.assets.tools.length}</Text>
        <Text color="gray">Health │ {dashboard.health.status}</Text>
        <Text color="gray">
          Memory │ {Math.round(dashboard.health.memoryUsage / 1024 / 1024)} MB
        </Text>
        <Text color="gray">R Refresh ? Help Esc Back</Text>
        {showHelp && (
          <Text color="yellow">R Refresh · ? Help · Esc Back</Text>
        )}
      </Box>
    );
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1}>
      <Text bold color="blue">
        {titles[kind]}
      </Text>
      {filter && <Text color="gray">Filter: {filter}</Text>}
      {!assets && <Text color="gray">Loading...</Text>}
      {assets && filteredItems.length === 0 && <Text color="gray">No matching assets.</Text>}
      {filteredItems.map((item, index) => (
        <Text key={item.name} color={index === selected ? 'cyan' : undefined}>
          {index === selected ? '❯ ' : '  '}
          {item.name}
          {detail && index === selected ? ` — ${item.detail}` : ''}
        </Text>
      ))}
      <Text color="gray">
        Type to filter ↑↓ Navigate Enter Details R Refresh C Reconnect T Test D Disconnect Esc Back
      </Text>
      {showHelp && (
        <Text color="yellow">
          ↑↓ Navigate · Enter Details · R Refresh · ? Help · Esc Back
          {kind === 'mcp' ? ' · C Reconnect · T Test · D Disconnect' : ''}
        </Text>
      )}
      {detail && selectedItem && <Text color="gray">{selectedItem.detail}</Text>}
    </Box>
  );
};
