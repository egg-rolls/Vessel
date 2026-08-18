import { Box, Text, useInput } from 'ink';
import type React from 'react';
import { useEffect, useState } from 'react';
import { DashboardService } from '../dashboard/dashboard-service.js';
import type { McpAsset } from '../dashboard/types.js';
import type { ReplContext } from '../repl-context.js';

export const McpBrowser: React.FC<{ ctx: ReplContext; onClose: () => void }> = ({ ctx, onClose }) => {
  const [items, setItems] = useState<McpAsset[]>([]);
  const [selected, setSelected] = useState(0);
  const [details, setDetails] = useState(false);
  const [testResult, setTestResult] = useState<string>();
  const [testing, setTesting] = useState(false);
  const refresh = () => void new DashboardService(ctx).getAssets().then((data) => setItems(data.mcpServers));
  useEffect(() => { refresh(); const timer = setInterval(refresh, 500); return () => clearInterval(timer); }, [ctx]);
  useInput((input, key) => {
    const item = items[selected];
    if (key.escape) return details ? setDetails(false) : onClose();
    if (key.upArrow) return setSelected((value) => Math.max(0, value - 1));
    if (key.downArrow) return setSelected((value) => Math.min(items.length - 1, value + 1));
    if (key.return) return setDetails((value) => !value);
    if (!item) return;
    if (input.toLowerCase() === 'r' || input.toLowerCase() === 'c') void ctx.mcpController?.reconnect(item.name).then(refresh);
    if (input.toLowerCase() === 't' && !testing) {
      setDetails(true);
      if (!ctx.mcpController) {
        setTestResult('Error · MCP controller is unavailable');
        return;
      }
      setTesting(true);
      setTestResult('Testing...');
      void ctx.mcpController.test(item.name)
        .then((result) => setTestResult(`OK · ${result.status} · tools: ${result.tools}`))
        .catch((error: unknown) => setTestResult(`Error · ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => {
          setTesting(false);
          void refresh();
        });
    }
    if (input.toLowerCase() === 'd') ctx.mcpController?.disconnect(item.name);
  });
  const item = items[selected];
  const serverTools = item ? ctx.tools.list().filter((tool) => tool.name.startsWith(`mcp__${item.name}__`)) : [];
  return <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1} flexGrow={1}>
    <Text bold color="blue">{details && item ? `MCP: ${item.name}` : 'MCP Servers'}</Text>
    {!details && items.map((server, index) => <Text key={server.name} color={index === selected ? 'cyan' : undefined}>
      {index === selected ? '❯ ' : '  '}{server.status === 'connected' ? '🟢' : '🔴'} {server.name}  {server.status}  tools: {server.tools}
    </Text>)}
    {details && item && <Box flexDirection="column">
      <Text color="gray">Status      │ {item.status}</Text>
      <Text color="gray">Tools       │ {item.tools} registered</Text>
      {item.latency !== undefined && <Text color="gray">Latency     │ {item.latency}ms</Text>}
      {item.error && <Text color="red">Error       │ {item.error}</Text>}
      {testResult && <Text color={testResult.startsWith('Error') ? 'red' : 'yellow'} wrap="truncate">Test        │ {testResult}</Text>}
      <Text color="blue">Tools</Text>
      {serverTools.map((tool) => <Text key={tool.name} color="gray" wrap="truncate">  - {tool.name.split(`mcp__${item.name}__`)[1]}  {tool.description}</Text>)}
    </Box>}
    <Text color="gray">↑↓ Navigate · Enter Details · R Reconnect · T Test · D Disconnect · Esc Back</Text>
  </Box>;
};
