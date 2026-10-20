/**
 * 权限确认挂起状态（DECISION-024 Addendum A）
 *
 * 权限请求**不再有 120s 超时**：弹窗一直等待，直到用户明确处理：
 * - 用户应答（allow / deny / always）；
 * - Esc / Ctrl+C 取消并 abort run；
 * - 当前工具失败或 run 终态；
 * - 组件卸载。
 *
 * 同一时刻只有一个 pending request；新请求替换旧的。这里没有任何计时器，
 * “长时间无应答”不会改变状态。
 */

/** 权限确认挂起控制器（纯状态，无计时器） */
export class PermissionPendingController {
  private currentRequestId: string | null = null;
  private readonly answeredRequests = new Set<string>();

  /** 开始等待某个 requestId 的确认；替换掉旧的挂起请求 */
  start(requestId: string): void {
    this.currentRequestId = requestId;
    // 防御：同 id 重新发起时视为未答（正常情况下 requestId 唯一）。
    this.answeredRequests.delete(requestId);
  }

  /** 记录该请求已答，并清除当前挂起 */
  answer(requestId: string): void {
    this.answeredRequests.add(requestId);
    if (this.currentRequestId === requestId) this.currentRequestId = null;
  }

  /** 放弃当前等待（Esc / Ctrl+C / abort / run 终态），不记为已答 */
  clear(): void {
    this.currentRequestId = null;
  }

  /** 组件卸载时清理 */
  dispose(): void {
    this.clear();
  }

  isAnswered(requestId: string): boolean {
    return this.answeredRequests.has(requestId);
  }

  current(): string | null {
    return this.currentRequestId;
  }
}
