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

  // 垂直三段渐变：浅蓝 → 中蓝 → 深蓝
  const gradientColors = ['#87CEFA', '#4169E1', '#00008B'];
  const segSize = Math.ceil(displayLines.length / 3);
  const segments = [
    displayLines.slice(0, segSize),
    displayLines.slice(segSize, segSize * 2),
    displayLines.slice(segSize * 2),
  ];

  return (
    <Box flexDirection="column">
      {segments.map((seg, segIndex) =>
        seg.map((line, lineIndex) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static logo
          <Text key={`${segIndex}-${lineIndex}`} color={gradientColors[segIndex]} bold>
            {line}
          </Text>
        )),
      )}
    </Box>
  );
};

export default AsciiArt;
