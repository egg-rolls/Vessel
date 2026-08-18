import { Box, Text, useInput } from 'ink';
import type React from 'react';
import { useEffect, useState } from 'react';
import { DashboardService } from '../dashboard/dashboard-service.js';
import type { DashboardData } from '../dashboard/types.js';
import type { ReplContext } from '../repl-context.js';

export const AssetsBrowser: React.FC<{ ctx: ReplContext; onClose: () => void }> = ({ ctx, onClose }) => {
  const [data, setData] = useState<DashboardData | null>(null);
  const refresh = () => void new DashboardService(ctx).getFullData().then(setData);
  useEffect(() => { refresh(); }, [ctx]);
  useInput((input, key) => { if (key.escape) onClose(); if (input.toLowerCase() === 'r') refresh(); });
  return <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1} flexGrow={1}>
    <Text bold color="blue">Vessel Assets</Text>
    <Text color="gray">🚀 Self-organizing Agent Harness</Text>
    {!data && <Text color="gray">Loading...</Text>}
    {data && <>
      <Text color="blue">⚙ Configuration</Text>
      <Text color="gray">Model       │ {data.config.model}</Text>
      <Text color="gray">Provider    │ {data.config.provider}</Text>
      <Text color="gray">Session     │ {data.session.sessionId}</Text>
      <Text color="gray">Workspace   │ {data.config.workspace}</Text>
      <Text color="blue">📦 Assets</Text>
      <Text color="gray">Plugins     │ {data.assets.plugins.length} loaded</Text>
      <Text color="gray">MCP Servers │ {data.assets.mcpServers.length} connected</Text>
      <Text color="gray">Skills      │ {data.assets.skills.length} available</Text>
      <Text color="gray">Tools       │ {data.assets.tools.length} registered</Text>
      <Text color="blue">💚 Health</Text>
      <Text color="gray">Status      │ {data.health.status}</Text>
      <Text color="gray">Memory      │ {Math.round(data.health.memoryUsage / 1024 / 1024)} MB</Text>
    </>}
    <Text color="gray">R Refresh · ? Help · Esc Back</Text>
  </Box>;
};
