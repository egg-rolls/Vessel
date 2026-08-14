import { Box, Text } from 'ink';
import type React from 'react';
import type { McpAsset } from '../../../types';

interface McpListProps {
  mcpServers: McpAsset[];
}

/**
 * MCP server list display component (compact version)
 */
export const McpList: React.FC<McpListProps> = ({ mcpServers }) => {
  // 没有 MCP 服务器时不显示任何内容
  if (mcpServers.length === 0) {
    return null;
  }

  const serverNames = mcpServers.map((s) => s.name).join(', ');

  return (
    <Box flexDirection="column">
      <Text color="blue" bold>
        MCP ({mcpServers.length})
      </Text>
      <Text color="white">{serverNames}</Text>
    </Box>
  );
};

export default McpList;
