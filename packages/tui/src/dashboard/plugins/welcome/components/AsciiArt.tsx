import { Box, Text } from 'ink';
import type React from 'react';

/**
 * ASCII art logo for Vessel
 * Hermes-style elegant design
 */
export const AsciiArt: React.FC = () => {
  const logo = [
    '██╗   ██╗███████╗███████╗███████╗███████╗██╗',
    '██║   ██║██╔════╝██╔════╝██╔════╝██╔════╝██║',
    '██║   ██║█████╗  ███████╗███████╗█████╗  ██║',
    '╚██╗ ██╔╝██╔══╝  ╚════██║╚════██║██╔══╝  ██║',
    ' ╚████╔╝ ███████╗███████║███████║███████╗███████╗',
    '  ╚═══╝  ╚══════╝╚══════╝╚══════╝╚══════╝╚══════╝',
  ];

  const tagline = '🚀 Self-organizing Agent Harness';

  return (
    <Box flexDirection="column" alignItems="center">
      {logo.map((line) => (
        <Text key={line} color="blue" bold>
          {line}
        </Text>
      ))}
      <Box marginTop={1}>
        <Text color="gray">{tagline}</Text>
      </Box>
    </Box>
  );
};

export default AsciiArt;
