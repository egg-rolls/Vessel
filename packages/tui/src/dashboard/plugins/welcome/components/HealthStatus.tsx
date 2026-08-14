import { Box, Text } from 'ink';
import type React from 'react';
import type { HealthInfo as HealthInfoType } from '../../../types';

interface HealthStatusProps {
  health: HealthInfoType;
}

/**
 * Health status display component with border
 */
export const HealthStatus: React.FC<HealthStatusProps> = ({ health }) => {
  const formatUptime = (ms: number): string => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    }
    if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
  };

  const formatMemory = (bytes: number): string => {
    const mb = Math.round(bytes / 1024 / 1024);
    return `${mb} MB`;
  };

  const statusColor =
    health.status === 'healthy' ? 'green' : health.status === 'warning' ? 'yellow' : 'red';
  const statusText = health.status.charAt(0).toUpperCase() + health.status.slice(1);

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="blue"
      borderTitle="Health"
      paddingX={1}
    >
      <Text color="white">
        {'Status     │ '}
        <Text color={statusColor}>{statusText}</Text>
      </Text>
      <Text color="white">
        {'Uptime     │ '}
        <Text color="cyan">{formatUptime(health.uptime)}</Text>
      </Text>
      <Text color="white">
        {'Memory     │ '}
        <Text color="cyan">{formatMemory(health.memoryUsage)}</Text>
      </Text>
    </Box>
  );
};

export default HealthStatus;
