import { Box, Text } from 'ink';
import type React from 'react';
import type { PluginAsset } from '../../../types';

interface PluginListProps {
  plugins: PluginAsset[];
}

/**
 * Plugin list display component (compact version)
 */
export const PluginList: React.FC<PluginListProps> = ({ plugins }) => {
  if (plugins.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="gray">No plugins loaded</Text>
      </Box>
    );
  }

  // 只显示插件名称，用逗号分隔
  const pluginNames = plugins.map((p) => p.name).join(', ');

  return (
    <Box flexDirection="column">
      <Text color="blue" bold>
        Plugins ({plugins.length})
      </Text>
      <Text color="white">{pluginNames}</Text>
    </Box>
  );
};

export default PluginList;
