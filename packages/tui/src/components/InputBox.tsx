/**
 * 输入框组件
 * 带蓝色上下边框和 > 前缀的输入框
 */

import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';

interface InputBoxProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  argHint?: string | null;
  inputKey?: string | number;
}

export function InputBox({ value, onChange, onSubmit, placeholder, argHint, inputKey }: InputBoxProps) {
  return (
    <Box flexDirection="column">
      {/* 上边框 */}
      <Text color="blue">{'─'.repeat(80)}</Text>

      {/* 输入行 */}
      <Box>
        <Text color="blue" bold>{'>'} </Text>
        <TextInput
          key={inputKey}
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder={placeholder}
        />
        {argHint && <Text color="gray">{argHint}</Text>}
      </Box>

      {/* 下边框 */}
      <Text color="blue">{'─'.repeat(80)}</Text>
    </Box>
  );
}
