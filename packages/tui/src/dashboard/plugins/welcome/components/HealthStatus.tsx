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
    <Box flexDirection="column">
      <Text color="blue" bold>
        ┌─ Health ──────────────────────────────────────────────┐
      </Text>
      <Text color="white">
        │ Status │ {statusIcon} {health.status.padEnd(33)}│
      </Text>
      <Text color="white">│ Uptime │ {formatUptime(health.uptime).padEnd(35)}│</Text>
      <Text color="white">│ Memory │ {formatMemory(health.memoryUsage).padEnd(35)}│</Text>
      <Text color="blue" bold>
        └───────────────────────────────────────────────────────┘
      </Text>
    </Box>
  );
};

export default HealthStatus;
