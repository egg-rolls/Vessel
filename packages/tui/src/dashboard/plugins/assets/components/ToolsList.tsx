import { Box, Text } from 'ink';
import type React from 'react';
import type { ToolAsset } from '../../../types';

interface ToolsListProps {
  tools: ToolAsset[];
}

/**
 * Tools list display component (compact version)
 */
export const ToolsList: React.FC<ToolsListProps> = ({ tools }) => {
  if (tools.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="gray">No tools registered</Text>
      </Box>
    );
  }

  // 只显示工具名称，用逗号分隔
  const toolNames = tools.map((t) => t.name).join(', ');

  return (
    <Box flexDirection="column">
      <Text color="blue" bold>
        Tools ({tools.length})
      </Text>
      <Text color="white">{toolNames}</Text>
    </Box>
  );
};

export default ToolsList;
