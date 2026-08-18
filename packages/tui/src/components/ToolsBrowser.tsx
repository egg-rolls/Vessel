import { Box, Text, useInput } from 'ink';
import type React from 'react';
import { useEffect, useState } from 'react';
import { DashboardService } from '../dashboard/dashboard-service.js';
import type { ToolAsset } from '../dashboard/types.js';
import type { ReplContext } from '../repl-context.js';

export const ToolsBrowser: React.FC<{ ctx: ReplContext; onClose: () => void }> = ({ ctx, onClose }) => {
  const [items, setItems] = useState<ToolAsset[]>([]);
  const [selected, setSelected] = useState(0);
  const [details, setDetails] = useState(false);
  useEffect(() => { void new DashboardService(ctx).getAssets().then((data) => setItems(data.tools)); }, [ctx]);
  useInput((input, key) => {
    if (key.escape) return details ? setDetails(false) : onClose();
    if (key.upArrow) return setSelected((value) => Math.max(0, value - 1));
    if (key.downArrow) return setSelected((value) => Math.min(items.length - 1, value + 1));
    if (key.return) setDetails((value) => !value);
  });
  const item = items[selected];
  return <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1} flexGrow={1}>
    <Text bold color="blue">Tools</Text>
    {items.map((tool, index) => <Text key={tool.name} color={index === selected ? 'cyan' : undefined}>
      {index === selected ? '❯ ' : '  '}{tool.name}
    </Text>)}
    {details && item && <Box flexDirection="column" marginTop={1}>
      <Text color="blue">Tool: {item.name}</Text><Text color="gray">{item.description}</Text>
      <Text color="gray">Input schema │ {item.inputSchema ?? '{}'}</Text>
      <Text color="gray">Tool testing requires an input payload and permission confirmation.</Text>
    </Box>}
    <Text color="gray">↑↓ Navigate · Enter Details · R Refresh · Esc Back</Text>
  </Box>;
};
