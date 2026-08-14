import { Box, Text } from 'ink';
import type React from 'react';
import type { HealthInfo as HealthInfoType } from '../../../types';

interface HealthStatusProps {
  health: HealthInfoType;
}

/**
 * Health status display component
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

  const statusIcon = health.status === 'healthy' ? '✅' : health.status === 'warning' ? '⚠️' : '❌';

  return (
    <Box marginTop={1}>
      <Text color="gray">
        {`${statusIcon} ${health.status} · ${formatUptime(health.uptime)} · ${formatMemory(health.memoryUsage)}`}
      </Text>
    </Box>
  );
};

export default HealthStatus;
