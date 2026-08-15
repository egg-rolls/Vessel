import { Box, Text } from 'ink';
import type React from 'react';

export interface ToolCardProps {
  toolName: string;
  status: 'running' | 'completed' | 'failed';
  startTime?: number;
  endTime?: number;
  error?: string;
}

/**
 * Tool call card component
 */
export const ToolCard: React.FC<ToolCardProps> = ({
  toolName,
  status,
  startTime,
  endTime,
  error,
}) => {
  const formatDuration = (start: number, end: number): string => {
    const duration = end - start;
    if (duration < 1000) {
      return `${duration}ms`;
    }
    return `${(duration / 1000).toFixed(1)}s`;
  };

  const statusIcon = status === 'running' ? '⏳' : status === 'completed' ? '✓' : '✗';

  const statusColor = status === 'running' ? 'yellow' : status === 'completed' ? 'green' : 'red';

  return (
    <Box flexDirection="column">
      <Text color={statusColor}>
        {statusIcon} {toolName}
        {startTime && endTime && ` (${formatDuration(startTime, endTime)})`}
        {status === 'running' && '...'}
      </Text>
      {error && <Text color="red"> Error: {error}</Text>}
    </Box>
  );
};

export default ToolCard;
