import { Box, Text } from 'ink';
import type React from 'react';
import type { McpAsset } from '../../../types';

interface McpListProps {
  mcpServers: McpAsset[];
}

/**
 * MCP server list display component
 */
export const McpList: React.FC<McpListProps> = ({ mcpServers }) => {
  if (mcpServers.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="gray">No MCP servers connected</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color="blue" bold>
        MCP Servers ({mcpServers.length})
      </Text>
      {mcpServers.map((server) => (
        <Text key={server.name} color="white">
          {server.status === 'connected' ? '🟢' : '🔴'} {server.name} {server.status} (tools:{' '}
          {server.tools}
          {server.latency ? `, latency: ${server.latency}ms` : ''})
        </Text>
      ))}
    </Box>
  );
};

export default McpList;
