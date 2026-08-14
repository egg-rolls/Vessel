import { Box, Text } from 'ink';
import type React from 'react';
import type { PluginAsset } from '../../../types';

interface PluginListProps {
  plugins: PluginAsset[];
}

/**
 * Plugin list display component
 */
export const PluginList: React.FC<PluginListProps> = ({ plugins }) => {
  if (plugins.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="gray">No plugins loaded</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color="blue" bold>
        Plugins ({plugins.length})
      </Text>
      {plugins.map((plugin) => (
        <Text key={plugin.name} color="white">
          {plugin.enabled ? '🟢' : '🔴'} {plugin.name} v{plugin.version}
        </Text>
      ))}
    </Box>
  );
};

export default PluginList;
