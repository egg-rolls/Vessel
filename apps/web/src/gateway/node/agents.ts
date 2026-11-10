/**
 * Agent 域方法：agents.tree / agents.list / canonical CRUD。
 *
 * 从 `client.ts` 拆出（S1）；行为与原单文件一致。
 */

import { unwrapAgentResult } from '../agent-result';
import type {
  AgentBatchResponse,
  AgentCreateInput,
  AgentInboxResponse,
  AgentSendEntry,
  AgentSendResponse,
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

  /**
   * 只读 inbox 视图（0.52 待处理条带）。`messageIds` 非空时结果带 `text`
   * （一次 ≤10 条；服务端不改任何状态）。
   */
  inbox(params: {
    agent_id: string;
    include_held?: boolean;
    message_ids?: string[];
  }): Promise<AgentInboxResponse> {
    return this.rpc<AgentInboxResponse>('agents.inbox', params);
  }

  /**
   * 置顶：把既有 inbox 消息按 urgent 重投（`message_id` + `interrupt`）。
   *
   * 语义是「打断当前 run 并把这条排到队首」——服务端 `sendInterrupt` 会取消该 body
   * 的 active / queued run 后按「这条 → 旧队列」重排。失败 code 由调用方映射文案。
   */
  async pinInboxMessage(agentId: string, messageId: string): Promise<AgentSendEntry> {
    const body = await this.rpc<AgentSendResponse>('agents.send', {
      messages: [{ to: agentId, message_id: messageId, interrupt: true }],
    });
    const entry = body?.results?.[0];
    return entry ?? { ok: false, code: 'internal', error: 'empty result' };
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
}
