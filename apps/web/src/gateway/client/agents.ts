/**
 * Agent 域方法：agents.tree / agents.list / canonical CRUD。
 *
 * 从 `client.ts` 拆出（S1）；行为与原单文件一致。
 */

import { unwrapAgentResult, unwrapAgentRotate } from '../agent-result';
import type {
  AgentBatchResponse,
  AgentCreateInput,
  AgentRotateInput,
  AgentRotateResponse,
  AgentRotateSuccess,
  AgentSummary,
  AgentsTreeResponse,
  AgentUpdateInput,
} from '../types';
import { RunsClient } from './runs';

export abstract class AgentsClient extends RunsClient {
  listAgentsTree(
    params: { session_id?: string; state?: string } = {},
  ): Promise<AgentsTreeResponse> {
    return this.rpc<AgentsTreeResponse>('agents.tree', params);
  }

  /** canonical `agents.list`；管理面 token 会额外返回成员记录。 */
  async listAgents(): Promise<AgentSummary[]> {
    const body = await this.rpc<{ agents?: AgentSummary[] }>('agents.list', {});
    return Array.isArray(body?.agents) ? body.agents : [];
  }

  // ── Agent CRUD（0.25；canonical `agents.create|update|close`）──
  // update 的 model / system_prompt 从下一个 Body 生效，name 立即生效。

  async createAgent(input: AgentCreateInput): Promise<AgentSummary> {
    return unwrapAgentResult(
      await this.rpc<AgentBatchResponse>('agents.create', { agents: [input] }),
    );
  }

  async updateAgent(input: AgentUpdateInput): Promise<AgentSummary> {
    return unwrapAgentResult(
      await this.rpc<AgentBatchResponse>('agents.update', { agents: [input] }),
    );
  }

  async closeAgent(agentId: string): Promise<AgentSummary> {
    return unwrapAgentResult(
      await this.rpc<AgentBatchResponse>('agents.close', { agents: [{ agent_id: agentId }] }),
    );
  }

  /**
   * canonical `agents.rotate`（0.26）：为成员换一具新 Body。
   *
   * 批量形状但 UI 每次只发一条；失败条目必须按错误处理并保留 code
   * （`body_not_live` / `member_stale` / `active_run` 等），交给调用方做可读映射。
   */
  async rotateAgent(input: AgentRotateInput): Promise<AgentRotateSuccess> {
    return unwrapAgentRotate(
      await this.rpc<AgentRotateResponse>('agents.rotate', { agents: [input] }),
    );
  }
}
