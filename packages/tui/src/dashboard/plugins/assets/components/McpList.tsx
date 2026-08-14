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
  if (mcpServers.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="gray">No MCP servers connected</Text>
      </Box>
    );
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
