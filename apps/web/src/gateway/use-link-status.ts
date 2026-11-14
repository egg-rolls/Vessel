import { useEffect, useState } from 'react';

import { type ConnectionState, createLinkStatusMachine, type LinkSnapshot } from './link-status';

/**
 * 把「连接状态机」接到 React 上（0.52，S1d）。
 *
 * 只做三件接线，语义全在纯模块 `link-status` 里（探针直接测那份）：
 * 1. 建**一次**状态机（宽限期起点是它内部状态，不能每次渲染新建）；
 * 2. 每次 connectionState 变化喂给它；
 * 3. 按 `noticeAt()` 排一个宽限定时器 —— 到点才把「断开」变成可见提示。
 */
export function useLinkStatus(state: ConnectionState): LinkSnapshot {
  const [machine] = useState(() => createLinkStatusMachine());
  const [snapshot, setSnapshot] = useState<LinkSnapshot>(() => machine.snapshot());

  useEffect(() => {
    setSnapshot(machine.onConnectionState(state));
  }, [machine, state]);

  // 依赖里带 `snapshot` 是**故意的**：它是上一轮 effect 的输出，但只有它变化才能重新算出
  // `noticeAt()` 并重排定时器；漏掉它，宽限期到点后提示不会出现（这是最容易改回去的地方）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: snapshot 是输出，但必须触发重排
  useEffect(() => {
    const at = machine.noticeAt();
    if (at === null) return;
    const timer = setTimeout(
      () => {
        // 到点时若已重新连上，onWake 保持 connected —— 提示根本不会出现。
        setSnapshot(machine.onWake());
      },
      Math.max(0, at - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [machine, state, snapshot]);

  return snapshot;
}
