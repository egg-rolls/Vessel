import { Box, Text } from 'ink';
import type React from 'react';
import type { ConfigInfo as ConfigInfoType } from '../../../types';

interface ConfigInfoProps {
  config: ConfigInfoType;
}

/**
 * Configuration info display component with border
 */
export const ConfigInfo: React.FC<ConfigInfoProps> = ({ config }) => {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="blue" paddingX={1}>
      <Text color="blue" bold>
        Configuration
      </Text>
      <Text color="white">
        {'Model      │ '}
        <Text color="cyan">{config.model}</Text>
      </Text>
      <Text color="white">
        {'Provider   │ '}
        <Text color="cyan">{config.provider}</Text>
      </Text>
      <Text color="white">
        {'Workspace  │ '}
        <Text color="cyan">{config.workspace}</Text>
      </Text>
    </Box>
  );
};

export default ConfigInfo;
