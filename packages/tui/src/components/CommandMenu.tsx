/**
 * 命令菜单组件
 * / 触发弹菜单 + autocomplete + 模糊过滤
 */

import { Box, Text, useInput } from 'ink';
import { useMemo, useState } from 'react';
import type { CommandRegistry } from '../commands/commands.js';

interface CommandMenuProps {
  commands: CommandRegistry;
  onSelect: (command: string) => void;
  onClose: () => void;
}

export function CommandMenu({ commands, onSelect, onClose }: CommandMenuProps) {
  const [filter, setFilter] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const allCommands = useMemo(() => {
    const entries = commands.list();
    const items: { name: string; description: string; usage?: string }[] = [];

    for (const entry of entries) {
      if (entry.subcommands && entry.subcommands.size > 0) {
        for (const sub of entry.subcommands.values()) {
          items.push({
            name: `/${entry.name} ${sub.name}`,
            description: sub.description,
            usage: sub.usage,
          });
        }
      } else {
        items.push({
          name: `/${entry.name}`,
          description: entry.description,
          usage: entry.usage,
        });
      }
    }

    return items;
  }, [commands]);

  const filteredCommands = useMemo(() => {
    if (!filter) return allCommands;
    const lowerFilter = filter.toLowerCase();
    return allCommands.filter(
      (cmd) =>
        cmd.name.toLowerCase().includes(lowerFilter) ||
        cmd.description.toLowerCase().includes(lowerFilter),
    );
  }, [allCommands, filter]);

  useInput((inputChar, key) => {
    if (key.escape) {
      onClose();
      return;
    }

    if (key.return) {
      if (filteredCommands.length > 0 && selectedIndex < filteredCommands.length) {
        const selected = filteredCommands[selectedIndex];
        if (selected) {
          onSelect(selected.name);
        }
      }
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(filteredCommands.length - 1, prev + 1));
      return;
    }

    if (key.backspace || key.delete) {
      setFilter((prev) => prev.slice(0, -1));
      setSelectedIndex(0);
      return;
    }

    if (inputChar && !key.ctrl && !key.meta) {
      setFilter((prev) => prev + inputChar);
      setSelectedIndex(0);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginY={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Commands
        </Text>
        {filter && <Text color="gray"> (filter: {filter})</Text>}
      </Box>

      {filteredCommands.length === 0 ? (
        <Text color="gray">No matching commands</Text>
      ) : (
        filteredCommands.map((cmd, i) => (
          <Box key={cmd.name}>
            <Text color={i === selectedIndex ? 'cyan' : 'white'} bold={i === selectedIndex}>
              {i === selectedIndex ? '❯ ' : '  '}
              {cmd.name}
            </Text>
            <Text color="gray"> - {cmd.description}</Text>
          </Box>
        ))
      )}

      <Box marginTop={1}>
        <Text color="gray">↑↓ Navigate · Enter Select · Esc Cancel</Text>
      </Box>
    </Box>
  );
}
