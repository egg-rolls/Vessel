import { Box, Text, useStdout } from 'ink';
import type React from 'react';

/**
 * ASCII art logo for Vessel
 * Hermes-style elegant design
 */
export const AsciiArt: React.FC = () => {
  const { stdout } = useStdout();
  const terminalWidth = stdout?.columns || 80;

  const lines = [
    '██╗   ██╗███████╗███████╗███████╗███████╗██╗       █████╗  ██████╗ ███████╗███╗   ██╗████████╗',
    '██║   ██║██╔════╝██╔════╝██╔════╝██╔════╝██║      ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝',
    '██║   ██║█████╗  ███████╗███████╗█████╗  ██║█████╗███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ',
    '╚██╗ ██╔╝██╔══╝  ╚════██║╚════██║██╔══╝  ██║╚════╝██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ',
    ' ╚████╔╝ ███████╗███████║███████║███████╗███████╗ ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ',
    '  ╚═══╝  ╚══════╝╚══════╝╚══════╝╚══════╝╚══════╝ ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ',
  ];

  // 小图标版本（终端宽度 < 100 时使用）
  const smallLines = [
    '██╗   ██╗███████╗██████╗',
    '██║   ██║██╔════╝██╔══██╗',
    '██║   ██║█████╗  ██████╔╝',
    '╚██╗ ██╔╝██╔══╝  ██╔══██╗',
    ' ╚████╔╝ ███████╗██║  ██║',
    '  ╚═══╝  ╚══════╝╚═╝  ╚═╝',
  ];

  // 根据终端宽度选择图标版本
  const useSmallIcon = terminalWidth < 100;
  const displayLines = useSmallIcon ? smallLines : lines;

  return (
    <Box flexDirection="column">
      {displayLines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static logo
        <Text key={i} color="blue" bold>
          {line}
        </Text>
      ))}
    </Box>
  );
};

export default AsciiArt;
