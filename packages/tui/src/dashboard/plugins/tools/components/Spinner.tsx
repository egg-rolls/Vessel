import { Box, Text } from 'ink';
import type React from 'react';

export type SpinnerMode = 'thinking' | 'tool' | 'idle';

export interface SpinnerProps {
  mode: SpinnerMode;
  toolName?: string;
  activityDescription?: string;
  elapsed: number;
  tokenCount?: number;
  nextTask?: string;
  budgetText?: string;
}

/**
 * Spinner status display component
 * Shows thinking/tool execution status
 */
export const Spinner: React.FC<SpinnerProps> = ({
  mode,
  toolName,
  activityDescription,
  elapsed,
  tokenCount,
  nextTask,
  budgetText,
}) => {
  const formatElapsed = (ms: number): string => {
    if (ms < 1000) {
      return `${ms}ms`;
    }
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const getModeIcon = (): string => {
    switch (mode) {
      case 'thinking':
        return '✻';
      case 'tool':
        return '✻';
      case 'idle':
        return '✻';
    }
  };

  const getModeText = (): string => {
    switch (mode) {
      case 'thinking':
        return 'Thinking...';
      case 'tool':
        return toolName ? `${activityDescription || toolName}...` : 'Working...';
      case 'idle':
        return 'Completed';
    }
  };

  return (
    <Box flexDirection="column">
      <Text color="blue">
        {getModeIcon()} {getModeText()}
        {' '.repeat(Math.max(0, 40 - getModeText().length))}
        {formatElapsed(elapsed)}
      </Text>
      {tokenCount && (
        <Text color="gray">
          {' '.repeat(3)}Token count: {tokenCount}
        </Text>
      )}
      {nextTask && (
        <Text color="gray">
          {' '.repeat(3)}Next: {nextTask}
        </Text>
      )}
      {budgetText && (
        <Text color="gray">
          {' '.repeat(3)}
          {budgetText}
        </Text>
      )}
    </Box>
  );
};

export default Spinner;
