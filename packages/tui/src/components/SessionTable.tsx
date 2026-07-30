/**
 * 会话表格组件
 * 显示会话列表，支持选择
 */

import type { SessionBackend, SessionInfo } from '@vessel/core';
import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';

interface SessionTableProps {
  session: SessionBackend;
  onSelect: (id: string) => void;
  onClose: () => void;
}

export function SessionTable({ session, onSelect, onClose }: SessionTableProps) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadSessions = async () => {
      try {
        const list = await session.listRich();
        setSessions(list);
      } catch (error) {
        console.error('Failed to load sessions:', error);
      } finally {
        setLoading(false);
      }
    };
    loadSessions();
  }, [session]);

  const formatDate = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleString();
  };

  const truncate = (str: string, max: number) => {
    if (str.length <= max) return str;
    return `${str.slice(0, max - 3)}...`;
  };

  useInput((inputChar, key) => {
    if (key.escape) {
      onClose();
      return;
    }

    if (key.return) {
      if (sessions.length > 0 && selectedIndex < sessions.length) {
        const selected = sessions[selectedIndex];
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
      setSelectedIndex((prev) => Math.min(sessions.length - 1, prev + 1));
      return;
    }

    // 数字快捷键
    const num = Number.parseInt(inputChar, 10);
    if (!Number.isNaN(num) && num >= 1 && num <= sessions.length) {
      const selected = sessions[num - 1];
      if (selected) {
        onSelect(selected.session_id);
      }
    }
  });

  if (loading) {
    return (
      <Box>
        <Text color="gray">Loading sessions...</Text>
      </Box>
    );
  }

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1} marginY={1}>
        <Text color="gray">No sessions found</Text>
        <Box marginTop={1}>
          <Text color="gray">Esc to close</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1} marginY={1}>
      <Box marginBottom={1}>
        <Text bold color="blue">
          Sessions
        </Text>
      </Box>

      {/* 表头 */}
      <Box>
        <Text color="gray" bold>
          {'#  '}
        </Text>
        <Text color="gray" bold>
          {'ID                          '}
        </Text>
        <Text color="gray" bold>
          {'Updated                 '}
        </Text>
        <Text color="gray" bold>
          Preview
        </Text>
      </Box>

      {/* 会话列表 */}
      {sessions.map((s, i) => (
        <Box key={s.session_id}>
          <Text color={i === selectedIndex ? 'cyan' : 'white'} bold={i === selectedIndex}>
            {i === selectedIndex ? '❯ ' : '  '}
            {String(i + 1).padStart(2, '0')}
          </Text>
          <Text color={i === selectedIndex ? 'cyan' : 'white'} bold={i === selectedIndex}>
            {' '}
            {truncate(s.session_id, 26).padEnd(26, ' ')}
          </Text>
          <Text color={i === selectedIndex ? 'cyan' : 'gray'}>
            {' '}
            {formatDate(s.updated_at).padEnd(22, ' ')}
          </Text>
          <Text color={i === selectedIndex ? 'cyan' : 'gray'}>
            {' '}
            {truncate(s.preview || '', 30)}
          </Text>
        </Box>
      ))}

      <Box marginTop={1}>
        <Text color="gray">↑↓ Navigate · Enter Select · 1-9 Quick Select · Esc Cancel</Text>
      </Box>
    </Box>
  );
}
