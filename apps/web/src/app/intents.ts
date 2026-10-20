import { useEffect } from 'react';

/**
 * 跨视图的一次性意图（命令面板 → 工作流启动对话框）。
 * sessionStorage 兜底：哈希导航后视图才挂载，事件可能早于 listener。
 */
const START_WORKFLOW_EVENT = 'vessel:start-workflow';
const START_WORKFLOW_KEY = 'vessel.start-workflow';

export function requestStartWorkflow(): void {
  try {
    sessionStorage.setItem(START_WORKFLOW_KEY, '1');
  } catch {
    // 隐私模式：事件仍然可用（视图已挂载时）。
  }
  window.dispatchEvent(new Event(START_WORKFLOW_EVENT));
}

function consumeStartWorkflow(): boolean {
  try {
    if (sessionStorage.getItem(START_WORKFLOW_KEY) !== '1') return false;
    sessionStorage.removeItem(START_WORKFLOW_KEY);
    return true;
  } catch {
    return false;
  }
}

/** 视图挂载时消费积压的意图，并订阅后续事件。 */
export function useStartWorkflowSignal(onStart: () => void): void {
  useEffect(() => {
    if (consumeStartWorkflow()) onStart();
    const handler = () => {
      consumeStartWorkflow();
      onStart();
    };
    window.addEventListener(START_WORKFLOW_EVENT, handler);
    return () => window.removeEventListener(START_WORKFLOW_EVENT, handler);
  }, [onStart]);
}
