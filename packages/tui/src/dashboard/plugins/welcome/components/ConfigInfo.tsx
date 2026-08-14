import { Box, Text } from 'ink';
import type React from 'react';
import type { ConfigInfo as ConfigInfoType } from '../../../types';

interface ConfigInfoProps {
  config: ConfigInfoType;
}

/**
 * Configuration info display component
 */
export const ConfigInfo: React.FC<ConfigInfoProps> = ({ config }) => {
  return (
    <Box flexDirection="column">
      <Text color="blue" bold>
        ┌─ Configuration ──────────────────────────────────────┐
      </Text>
      <Text color="white">│ Model │ {config.model.padEnd(35)}│</Text>
      <Text color="white">│ Provider │ {config.provider.padEnd(35)}│</Text>
      <Text color="white">│ Session │ {config.baseUrl.padEnd(35)}│</Text>
      <Text color="white">│ Workspace │ {config.workspace.padEnd(35)}│</Text>
      <Text color="blue" bold>
        └───────────────────────────────────────────────────────┘
      </Text>
    </Box>
  );
};

export default ConfigInfo;
