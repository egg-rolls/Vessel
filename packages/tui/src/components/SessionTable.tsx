/**
 * 交互式会话选择器组件
 * 全屏交互式界面，支持搜索过滤、键盘导航、会话元数据展示
 */

import type { SessionInfo } from '@vessel/core';
import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';

interface SessionTableProps {
  sessions: SessionInfo[];
  currentSessionId?: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}

/** 相对时间格式化（如 "2h ago", "3d ago"） */
function formatRelativeTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  if (diff < 0) return 'just now';

  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const date = new Date(ts);
  return date.toLocaleDateString();
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return `${str.slice(0, max - 3)}...`;
}

export function SessionTable({ sessions, currentSessionId, onSelect, onClose }: SessionTableProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [filterMode, setFilterMode] = useState(false);
  const [filterText, setFilterText] = useState('');

  const filteredSessions = useMemo(() => {
    if (!filterText) return sessions;
    const lower = filterText.toLowerCase();
    return sessions.filter(
      (s) =>
        s.title?.toLowerCase().includes(lower) ||
        s.preview?.toLowerCase().includes(lower) ||
        s.branch?.toLowerCase().includes(lower) ||
        s.session_id.toLowerCase().includes(lower),
    );
  }, [sessions, filterText]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset selection when filter changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [filterText]);

  useInput((inputChar, key) => {
    // Filter mode: type to filter
    if (filterMode) {
      if (key.escape) {
        setFilterMode(false);
        setFilterText('');
        return;
      }
      if (key.return) {
        setFilterMode(false);
        return;
      }
      if (key.backspace || key.delete) {
        setFilterText((prev) => prev.slice(0, -1));
        return;
      }
      if (inputChar && !key.ctrl && !key.meta) {
        setFilterText((prev) => prev + inputChar);
        return;
      }
      return;
    }

    // Normal mode
    if (key.escape) {
      onClose();
      return;
    }

    if (key.return) {
      if (filteredSessions.length > 0 && selectedIndex < filteredSessions.length) {
        const selected = filteredSessions[selectedIndex];
        if (selected) {
          onSelect(selected.session_id);
        }
      }
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(filteredSessions.length - 1, prev + 1));
      return;
    }

    // Enter filter mode with / or f
    if (inputChar === '/' || inputChar === 'f') {
      setFilterMode(true);
      setFilterText('');
      return;
    }

    // Number quick-select (1-9)
    const num = Number.parseInt(inputChar, 10);
    if (!Number.isNaN(num) && num >= 1 && num <= filteredSessions.length) {
      const selected = filteredSessions[num - 1];
      if (selected) {
        onSelect(selected.session_id);
      }
    }
  });

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1} marginY={1}>
        <Text color="gray">No sessions to resume.</Text>
        <Box marginTop={1}>
          <Text color="gray">Esc to close</Text>
        </Box>
      </Box>
    );
  }

  const maxIdWidth = 28;
  const maxPreviewWidth = 32;
  const maxBranchWidth = 14;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1} marginY={1}>
      {/* Title */}
      <Box marginBottom={1}>
        <Text bold color="blue">
          Resume Session
        </Text>
        {filterMode && (
          <Text color="yellow">
            {' '}
            | Filter: {filterText}
            <Text color="gray">_</Text>
          </Text>
        )}
        {filterText && !filterMode && <Text color="yellow"> | Filtered: "{filterText}"</Text>}
      </Box>

      {/* Header */}
      <Box>
        <Text color="gray" bold>
          {'#  '}
        </Text>
        <Text color="gray" bold>
          {'ID'.padEnd(maxIdWidth, ' ')}
        </Text>
        <Text color="gray" bold>
          {'Msgs '}
        </Text>
        <Text color="gray" bold>
          {'Time'.padEnd(12, ' ')}
        </Text>
        <Text color="gray" bold>
          {'Branch'.padEnd(maxBranchWidth, ' ')}
        </Text>
        <Text color="gray" bold>
          Preview
        </Text>
      </Box>

      {/* Session list */}
      {filteredSessions.map((s, i) => {
        const isCurrent = s.session_id === currentSessionId;
        const isSelected = i === selectedIndex;
        const color = isSelected ? 'cyan' : isCurrent ? 'green' : 'white';
        const timeColor = isSelected ? 'cyan' : 'gray';
        const branchColor = isSelected ? 'cyan' : 'yellow';

        return (
          <Box key={s.session_id}>
            <Text color={color} bold={isSelected}>
              {isSelected ? '> ' : '  '}
              {String(i + 1).padStart(2, '0')}
            </Text>
            <Text color={color} bold={isSelected}>
              {' '}
              {truncate(s.session_id, maxIdWidth).padEnd(maxIdWidth, ' ')}
            </Text>
            <Text color={timeColor}>{String(s.message_count).padStart(4, ' ')} </Text>
            <Text color={timeColor}>{formatRelativeTime(s.updated_at).padEnd(12, ' ')}</Text>
            <Text color={branchColor}>
              {truncate(s.branch || '-', maxBranchWidth).padEnd(maxBranchWidth, ' ')}
            </Text>
            <Text color={timeColor}>
              {' '}
              {truncate(s.preview || s.title || '', maxPreviewWidth)}
              {isCurrent ? ' (active)' : ''}
            </Text>
          </Box>
        );
      })}

      {/* Footer hints */}
      <Box marginTop={1}>
        <Text color="gray">
          {filterMode
            ? 'Type to filter · Enter confirm · Esc clear filter'
            : '↑↓ Navigate · Enter Resume · / or f Filter · 1-9 Quick Select · Esc Cancel'}
        </Text>
      </Box>
    </Box>
  );
}
