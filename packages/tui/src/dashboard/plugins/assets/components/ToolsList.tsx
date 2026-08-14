import { Box, Text } from 'ink';
import type React from 'react';
import type { ToolAsset } from '../../../types';

interface ToolsListProps {
  tools: ToolAsset[];
}

/**
 * Tools list display component
 */
export const ToolsList: React.FC<ToolsListProps> = ({ tools }) => {
  if (tools.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="gray">No tools registered</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color="blue" bold>
        Tools ({tools.length})
      </Text>
      {tools.map((tool) => (
        <Text key={tool.name} color="white">
          🔧 {tool.name}: {tool.description}
        </Text>
      ))}
    </Box>
  );
};

export default ToolsList;
