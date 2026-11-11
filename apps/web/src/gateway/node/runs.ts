/**
 * 运行域方法：runs.*、事件读取与 durable run 访问。
 *
 * 从 `client.ts` 拆出（S1）；行为与原单文件一致。
 */

import type {
  DurableRunSummary,
  DurableRunsResponse,
  EventsResponse,
  MessageRef,
  ResumeRunResponse,
  RunEvent,
  RunResponse,
  RunStartResult,
  RunStatus,
  RunsResponse,
} from '../types';
import { canFallbackToLegacyRuns } from './rpc';
import { SessionsClient } from './sessions';

export abstract class RunsClient extends SessionsClient {
  /**
   * 提交 run：优先 0.5 canonical RPC `runs.start`（带 tenant + quota），
   * 旧 gateway 不支持时回退 WS legacy `run.submit`。
   */
  /**
   * 0.27：`runs.start` 解析 session → agent/body 后回填 `agent_id` / `session_id`。
   *
   * 0.28（CONTRACT §3 / §3.1）：`agentId` 表达「这一次投给哪个 agent」。
   * 新会话必须先 `agents.create` 再带 `agentId` 调这里 —— 只传 `session_id`
   * 会让未绑定的 session 落到 `main` 上长出第二具 body。
   * `agentId` 缺省时保持 0.27 行为（`/resume` 等按 session 的路径不受影响）。
   *
   * 0.52：`refs` 是这一轮的附件引用（只有路径）。服务端在准入前判边界，
   * 越界 / deny 目录直接 `invalid_params`（`details.reason` 是稳定码）。
   * 空数组与不传等价（旧 gateway 会忽略多余字段前的行为不变）。
   */
  async submitRun(
    input: string,
    sessionId?: string,
    agentId?: string,
    refs?: readonly MessageRef[],
  ): Promise<RunStartResult> {
    const params = {
      input,
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(agentId ? { agent_id: agentId } : {}),
      ...(refs !== undefined && refs.length > 0 ? { refs } : {}),
    };
    try {
      return await this.rpc<RunStartResult>('runs.start', params);
    } catch (error) {
      // 带 `agentId` 时**不能**回退：legacy `run.submit` 没有 agent 维度，丢掉了
      // `agent_id` 就会落到 `main` 上长出第二具 body（契约 §3 明禁，且是静默的）。
      // 带 `refs` 时同理：legacy 没有 refs 字段，回退等于把附件悄悄丢了（用户以为
      // 附上了，模型却看不到）。两种情况都让用户看到真实原因。
      if (agentId) throw error;
      if (refs !== undefined && refs.length > 0) throw error;
      if (!canFallbackToLegacyRuns(error)) throw error;
      return this.request<RunStartResult>('run.submit', {
        input,
        ...(sessionId ? { session_id: sessionId } : {}),
      });
    }
  }

  async cancelRun(runId: string): Promise<{ cancelled: boolean }> {
    try {
      return await this.rpc<{ cancelled: boolean }>('runs.cancel', { run_id: runId });
    } catch (error) {
      if (!canFallbackToLegacyRuns(error)) throw error;
      return this.request('run.cancel', { run_id: runId });
    }
  }

  getRun(runId: string): Promise<RunStatus> {
    return this.request('run.get', { run_id: runId });
  }

  /**
   * 查询 run 状态：canonical `runs.get` 优先，旧 gateway 回退 WS legacy `run.get`。
   * 排队卡片用它轮询 queue_position；不新增服务端方法。
   */
  async getRunStatus(runId: string): Promise<RunStatus> {
    try {
      const body = await this.rpc<{ run: RunStatus }>('runs.get', { run_id: runId });
      return body.run;
    } catch (error) {
      if (!canFallbackToLegacyRuns(error)) throw error;
      return this.request<RunStatus>('run.get', { run_id: runId });
    }
  }

  /** 当前 gateway 进程内的 live runs（内存，无分页）。 */
  /** 0.27：`runs.list` 支持 agent / session 维度过滤（agent_id 为 additive 参数）。 */
  async listRuns(
    params: { session_id?: string; agent_id?: string; status?: string } = {},
  ): Promise<RunStatus[]> {
    const body = await this.rpc<RunsResponse>('runs.list', params);
    return body.runs ?? [];
  }

  /** canonical runs.get；失败时回退 legacy WS run.get（旧 gateway）。 */
  async getRunCanonical(runId: string): Promise<RunStatus> {
    try {
      const body = await this.rpc<RunResponse>('runs.get', { run_id: runId });
      return body.run;
    } catch (error) {
      if (!canFallbackToLegacyRuns(error)) throw error;
      return this.request<RunStatus>('run.get', { run_id: runId });
    }
  }

  /**
   * 恢复可恢复运行：canonical `runs.resume` 优先；旧 gateway 回退 durable REST。
   * `conflict`（含 legacy_code=run_already_running）视为已在恢复，由调用方处理。
   */
  async resumeRun(runId: string): Promise<ResumeRunResponse> {
    try {
      return await this.rpc<ResumeRunResponse>('runs.resume', { run_id: runId });
    } catch (error) {
      if (!canFallbackToLegacyRuns(error)) throw error;
      return this.resumeDurableRun(runId);
    }
  }

  /** 读取事件记录（trace）；limit ≤500，升序返回。 */
  async readEvents(params: {
    run_id?: string;
    since_seq?: number;
    since_ts?: number;
    types?: string[];
    type_prefix?: string;
    limit?: number;
  }): Promise<RunEvent[]> {
    const body = await this.rpc<EventsResponse>('events.list', params);
    return body.events ?? [];
  }

  /** interrupted/其它状态的 durable run 摘要 */
  async listDurableRuns(
    params: { status?: string; session_id?: string; agent_id?: string; limit?: number } = {},
  ): Promise<DurableRunSummary[]> {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.session_id) query.set('session_id', params.session_id);
    if (params.agent_id) query.set('agent_id', params.agent_id);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    const suffix = query.toString();
    const body = await this.httpJson<DurableRunsResponse>(
      `/v1/durable/runs${suffix ? `?${suffix}` : ''}`,
    );
    return body.runs ?? [];
  }

  /** 恢复一个 durable run；gateway 受理后返回 queued */
  resumeDurableRun(runId: string): Promise<{ run_id: string; status: 'queued' }> {
    return this.httpJson(`/v1/durable/runs/${encodeURIComponent(runId)}/resume`, {
      method: 'POST',
    });
  }
}
