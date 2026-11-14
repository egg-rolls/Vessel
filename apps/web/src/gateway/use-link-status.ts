/**
 * React 接线层（S1d）：把 `gateway/link-status.ts` 的状态机接到组件树上。
 *
 * 这里**只做接线的三件事**：建一次状态机、把 `connectionState` 喂进去、按 `noticeAt()`
 * 排一个宽限期定时器。所有判断逻辑在纯模块里，探针直接打那边，不碰 React/DOM。
 *
 * 抖动为什么不会被看到：宽限期内 `noticeAt()` 有值、`visible` 恒 false；0.6s 断-连
 * 在 UI 上连一次 setState 的「断开」都不会产生 —— 只多一次无效的定时器排/清。
 */
import { useEffect, useState } from 'react';
import type { ConnectionState } from './client';
import { createLinkStatusMachine, type LinkSnapshot } from './link-status';

export function useLinkStatus(state: ConnectionState): LinkSnapshot {
  // 状态机要跨渲染稳定（宽限期起点是它内部的状态），用 lazy state 而不是每次渲染新建。
  const [machine] = useState(() => createLinkStatusMachine());
  const [snapshot, setSnapshot] = useState<LinkSnapshot>(() => machine.snapshot());

  useEffect(() => {
    setSnapshot(machine.onConnectionState(state));
  }, [machine, state]);

  useEffect(() => {
    const at = machine.noticeAt();
    if (at === null) return;
    const timer = setTimeout(() => {
      // 到点时若已重新连上，onWake 保持 connected —— 提示根本不会出现。
      setSnapshot(machine.onWake());
    }, Math.max(0, at - Date.now()));
    return () => clearTimeout(timer);
  }, [machine, snapshot]);

  return snapshot;
}

