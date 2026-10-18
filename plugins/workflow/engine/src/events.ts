/**
 * workflow.* 事件发布。事件名是开放字符串，不建常量/枚举。
 */

import type { EventStream } from '@vessel/core';

export function publishWorkflowEvent(
  events: EventStream,
  type: string,
  workflowRunId: string,
  data: Record<string, unknown>,
): void {
  events.publish({
    type,
    run_id: workflowRunId,
    data: { workflow_run_id: workflowRunId, ...data },
    ts: Date.now(),
  });
}
