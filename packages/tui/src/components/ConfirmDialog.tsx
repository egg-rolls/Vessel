/**
 * 确认弹窗组件
 * 图形弹窗替换 readline confirm()
 */

import { Box, Text, useInput } from 'ink';
import { useState } from 'react';

interface ConfirmDialogProps {
  question: string;
  onConfirm: (answer: string) => void;
}

export function ConfirmDialog({ question, onConfirm }: ConfirmDialogProps) {
  const [selected, setSelected] = useState<'y' | 'n' | 'always'>('y');

  useInput((inputChar, key) => {
    if (key.leftArrow) {
      setSelected((prev) => {
        if (prev === 'n') return 'y';
        if (prev === 'always') return 'n';
        return prev;
      });
      return;
    }

    if (key.rightArrow) {
      setSelected((prev) => {
        if (prev === 'y') return 'n';
        if (prev === 'n') return 'always';
        return prev;
      });
      return;
    }

    if (key.return) {
      onConfirm(selected);
      return;
    }

    if (inputChar === 'y' || inputChar === 'Y') {
      setSelected('y');
      onConfirm('y');
      return;
    }

    if (inputChar === 'n' || inputChar === 'N') {
      setSelected('n');
      onConfirm('n');
      return;
    }

    if (inputChar === 'a' || inputChar === 'A') {
      setSelected('always');
      onConfirm('always');
      return;
    }
  });

  return (
    <Box flexDirection="column" borderStyle="double" borderColor="yellow" paddingX={1} marginY={1}>
      <Box marginBottom={1}>
        <Text bold color="yellow">
          ⚠ Permission Required
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text>{question}</Text>
      </Box>

      <Box>
        <Text
          backgroundColor={selected === 'y' ? 'green' : undefined}
          color={selected === 'y' ? 'white' : 'green'}
          bold={selected === 'y'}
        >
          {' [Y]es '}
        </Text>
        <Text
          backgroundColor={selected === 'n' ? 'red' : undefined}
          color={selected === 'n' ? 'white' : 'red'}
          bold={selected === 'n'}
        >
          {' [N]o '}
        </Text>
        <Text
          backgroundColor={selected === 'always' ? 'blue' : undefined}
          color={selected === 'always' ? 'white' : 'blue'}
          bold={selected === 'always'}
        >
          {' [A]lways '}
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text color="gray">←→ Select · Enter Confirm · y/n/a Quick Select</Text>
      </Box>
    </Box>
  );
}
