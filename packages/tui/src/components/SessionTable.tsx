/**
 * 交互式会话选择器组件
 * 全屏交互式界面，支持搜索过滤、键盘导航、会话元数据展示
 */

import type { SessionInfo } from '@vessel/core';
import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { theme } from '../theme.js';
import { formatRelativeTime } from '../utils/time.js';

interface SessionTableProps {
  sessions: SessionInfo[];
  currentSessionId?: string;
  /** picker 数据加载状态；默认 ready，保持外部调用兼容 */
  status?: 'loading' | 'ready' | 'error';
  error?: string | null;
  /** 矮终端下可见会话行数上限；缺省不封顶 */
  maxRows?: number;
  onRetry?: () => void;
  onSelect: (id: string) => void;
  onClose: () => void;
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return `${str.slice(0, max - 3)}...`;
}

export function SessionTable({
  sessions,
  currentSessionId,
  status = 'ready',
  error = null,
  maxRows,
  onRetry,
  onSelect,
  onClose,
}: SessionTableProps) {
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

  // 矮终端：围绕选中项滚动，避免 picker 溢出压掉状态栏。
  const visibleWindow = useMemo(() => {
    if (maxRows === undefined || maxRows <= 0 || filteredSessions.length <= maxRows) {
      return { start: 0, items: filteredSessions };
    }
    const maxStart = filteredSessions.length - maxRows;
    const start = Math.min(Math.max(0, selectedIndex - Math.floor(maxRows / 2)), maxStart);
    return { start, items: filteredSessions.slice(start, start + maxRows) };
  }, [filteredSessions, maxRows, selectedIndex]);

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

    // loading 时除 Esc 外不响应；error 时 r 重试。
    if (status === 'loading') return;
    if (status === 'error') {
      if (inputChar === 'r' && onRetry) onRetry();
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

  if (status === 'loading') {
    return (
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor={theme.line}
        paddingX={1}
        marginY={1}
      >
        <Text color={theme.muted}>Loading sessions…</Text>
        <Box marginTop={1}>
          <Text color={theme.faint}>Esc to close</Text>
        </Box>
      </Box>
    );
  }

  if (status === 'error') {
    return (
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor={theme.line}
        paddingX={1}
        marginY={1}
      >
        <Text bold color={theme.danger}>
          Failed to load sessions
        </Text>
        <Box marginTop={1}>
          <Text color={theme.muted}>{error ?? 'Unknown error.'}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={theme.faint}>r retry · Esc to close</Text>
        </Box>
      </Box>
    );
  }

  if (sessions.length === 0) {
    return (
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor={theme.line}
        paddingX={1}
        marginY={1}
      >
        <Text color={theme.muted}>No sessions to resume.</Text>
        <Box marginTop={1}>
          <Text color={theme.faint}>Esc to close</Text>
        </Box>
      </Box>
    );
  }

  const maxIdWidth = 28;
  const maxPreviewWidth = 32;
  const maxBranchWidth = 14;

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.line}
      paddingX={1}
      marginY={1}
    >
      {/* Title */}
      <Box marginBottom={1}>
        <Text bold color={theme.brand}>
          Resume session
        </Text>
        {filterMode && (
          <Text color={theme.warn}>
            {' '}
            · filter: {filterText}
            <Text color={theme.faint}>_</Text>
          </Text>
        )}
        {filterText && !filterMode && <Text color={theme.warn}> · filtered: "{filterText}"</Text>}
      </Box>

      {/* Header */}
      <Box>
        <Text color={theme.faint} bold>
          {'#  '}
        </Text>
        <Text color={theme.faint} bold>
          {'ID'.padEnd(maxIdWidth, ' ')}
        </Text>
        <Text color={theme.faint} bold>
          {'Msgs '}
        </Text>
        <Text color={theme.faint} bold>
          {'Time'.padEnd(12, ' ')}
        </Text>
        <Text color={theme.faint} bold>
          {'Branch'.padEnd(maxBranchWidth, ' ')}
        </Text>
        <Text color={theme.faint} bold>
          Preview
        </Text>
      </Box>

      {/* Session list */}
      {visibleWindow.items.map((s, offset) => {
        const i = visibleWindow.start + offset;
        const isCurrent = s.session_id === currentSessionId;
        const isSelected = i === selectedIndex;
        const color = isSelected ? theme.brand : isCurrent ? theme.ok : theme.muted;
        const timeColor = isSelected ? theme.brand : theme.faint;
        const branchColor = isSelected ? theme.brand : theme.faint;

        return (
          <Box key={s.session_id}>
            <Text color={color} bold={isSelected}>
              {isSelected ? '› ' : '  '}
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

      {/* Window indicator */}
      {filteredSessions.length > visibleWindow.items.length && (
        <Box marginTop={1}>
          <Text color={theme.faint}>
            showing {visibleWindow.start + 1}-{visibleWindow.start + visibleWindow.items.length} of{' '}
            {filteredSessions.length}
          </Text>
        </Box>
      )}

      {/* Footer hints */}
      <Box marginTop={1}>
        <Text color={theme.faint}>
          {filterMode
            ? 'type to filter · enter confirm · esc clear'
            : '↑↓ navigate · enter resume · / filter · 1-9 select · esc cancel'}
        </Text>
      </Box>
    </Box>
  );
}
