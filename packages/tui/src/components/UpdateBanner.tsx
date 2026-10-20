/**
 * 更新提示（纯消费侧）
 *
 * asm 完成每日一次的后台检查后发布 `update.available`；TUI 只渲染一行提示。
 * 不实现网络、不写缓存、不决定通道——无事件时零输出、零行为。
 */

import type { EventStream } from '@vessel/core';
import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import { theme } from '../theme.js';
import { asTuiEvent, type TuiEvent, type UpdateAvailableData } from '../types/events.js';

export interface UpdateBannerState {
  info: UpdateAvailableData | null;
}

export function reduceUpdateState(prev: UpdateBannerState, event: TuiEvent): UpdateBannerState {
  if (event.type !== 'update.available') return prev;
  // 同一版本重复发布不重复渲染
  if (prev.info?.latest === event.data.latest && prev.info.channel === event.data.channel) {
    return prev;
  }
  return { info: event.data };
}

export function UpdateBanner({ events }: { events: EventStream }) {
  const [state, setState] = useState<UpdateBannerState>({ info: null });

  useEffect(() => {
    const unsubscribe = events.subscribe((rawEvent) => {
      setState((prev) => reduceUpdateState(prev, asTuiEvent(rawEvent)));
    });
    return unsubscribe;
  }, [events]);

  const info = state.info;
  if (!info) return null;

  return (
    <Box paddingX={1}>
      <Text color={theme.warn} wrap="truncate">
        ↑ Vessel v{info.latest} available ({info.channel}) · {info.installHint}
        {info.notesUrl ? ` · ${info.notesUrl}` : ''}
      </Text>
    </Box>
  );
}
