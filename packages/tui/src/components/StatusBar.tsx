/**
 * 状态栏组件
 * 显示 provider、model、session、plugins 信息
 */

import { Box, Text } from 'ink';

interface StatusBarProps {
  provider: {
    name: string;
    model: string;
    baseUrl: string;
  };
  session: string;
  plugins: string[];
}

export function StatusBar({ provider, session, plugins }: StatusBarProps) {
  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} justifyContent="space-between">
      <Box>
        <Text color="cyan" bold>
          Vessel
        </Text>
        <Text color="gray"> · </Text>
        <Text color="yellow">{provider.name}</Text>
        <Text color="gray"> | </Text>
        <Text color="green">{provider.model}</Text>
      </Box>

      <Box>
        <Text color="gray">session: </Text>
        <Text color="blue">{session}</Text>
      </Box>

      {plugins.length > 0 && (
        <Box>
          <Text color="gray">plugins: </Text>
          <Text color="magenta">{plugins.length}</Text>
        </Box>
      )}
    </Box>
  );
}
