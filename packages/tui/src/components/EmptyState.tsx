/**
 * 空态：一行标题 + 一行提示
 * @module @vessel/tui
 *
 * 不渲染空表头；调用方负责边框。
 */

import { Box, Text } from 'ink';
import { theme } from '../theme.js';

export interface EmptyStateProps {
  title: string;
  hint?: string;
}

export function EmptyState({ title, hint }: EmptyStateProps) {
  return (
    <Box flexDirection="column">
      <Text color={theme.muted}>{title}</Text>
      {hint ? (
        <Box marginTop={1}>
          <Text color={theme.faint}>{hint}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
