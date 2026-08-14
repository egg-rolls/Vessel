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
    <Box flexDirection="column" marginTop={1}>
      <Text color="gray" bold>
        {config.provider} | {config.model}
      </Text>
      <Text color="gray">{config.workspace}</Text>
    </Box>
  );
};

export default ConfigInfo;
