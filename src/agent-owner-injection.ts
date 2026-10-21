/**
 * owner 消息队列 → 父 turn 的 BeforeLlm 注入（0.17 A3c）。
 *
 * AgentService 把成员回复排进 owner 队列；`takeMessages(ownerId)` 由 agent 轨
 * （packages/agent）提供。本模块只依赖结构类型，agent 包尚未合并该方法时
 * hook 保持空转（返回 `[]`），不改变请求形状。
 *
 * 约束：
 * - 注入消息固定 `role:'user'`、`name:'agent:<id>'`、`timestamp:<原消息 ts>`，
 *   content 原样（core E5 用 name+timestamp+content 去重）；
 * - `takeMessages` 是排空语义；同一消息跨轮不重复；
 * - 成员 runtime 继承父 PluginHost 的 hooks，成员 turn 不得消费 owner 队列，
 *   由 `isMemberSession` 拦截。
 *
 * @module vessel/agent-owner-injection
 */

import type { EventStream, Hook, Message } from '../packages/core/src/index';
import { HookType } from '../packages/core/src/index';

/** BeforeLlm hook 名（幂等注册用） */
export const AGENT_OWNER_INJECTION_HOOK = 'agent-owner-injection';

/** agent 轨 A3c `AgentService.takeMessages` 返回的消息形状（AgentMessage） */
export interface OwnerQueueMessage {
  id: string;
  from: string;
  to?: string;
  content: string;
  ts: number;
}

/**
 * `AgentService.takeMessages` 的结构依赖。
 * 合并后 `AgentService` 直接满足；未合并时由入口层探测方法是否存在。
 */
export interface OwnerMessageSource {
  takeMessages(
    memberId: string,
  ): Promise<readonly OwnerQueueMessage[]> | readonly OwnerQueueMessage[];
}

export interface AgentOwnerInjectionOptions {
  source: OwnerMessageSource;
  /** owner 成员 id（REPL 主 agent，缺省 `main`） */
  ownerId: string;
  /**
   * 当前 BeforeLlm 是否来自成员 runtime。成员继承父 hooks，
   * 只有父 turn 才允许排空 owner 队列。
   */
  isMemberSession?: (sessionId: string | undefined) => boolean | Promise<boolean>;
  events?: EventStream;
  tenantId?: string;
  now?: () => number;
}

export interface AgentOwnerInjector {
  /** 注册到 PluginHost 的 BeforeLlm hook */
  hook: Hook;
  /** 停止注入（owner 端点 / 服务关闭）；幂等 */
  dispose(): void;
}

/**
 * owner 消息 → 模型消息：角色固定 user，名称标注来源成员。
 * `timestamp` 取原消息时间，保证 core E5 的稳定去重键不变。
 */
export function ownerMessageToMessage(message: OwnerQueueMessage): Message {
  return {
    role: 'user',
    name: `agent:${message.from}`,
    content: message.content,
    timestamp: message.ts,
  };
}

/**
 * 把 AgentService 包成 `OwnerMessageSource`。
 * agent 轨未合并 `takeMessages` 时返回空数组（hook 不改请求）。
 */
export function createOwnerMessageSource(service: object): OwnerMessageSource {
  return {
    takeMessages(memberId) {
      const take = (service as Partial<OwnerMessageSource>).takeMessages;
      if (typeof take !== 'function') return [];
      return take.call(service, memberId);
    },
  };
}

export function createAgentOwnerInjector(options: AgentOwnerInjectionOptions): AgentOwnerInjector {
  let active = true;
  const now = options.now ?? Date.now;

  const publish = (type: string, runId: string, data: Record<string, unknown>): void => {
    if (!options.events) return;
    try {
      options.events.publish({
        type,
        run_id: runId,
        data,
        ts: now(),
        ...(options.tenantId !== undefined ? { tenant_id: options.tenantId } : {}),
      });
    } catch {
      // 事件订阅者异常不影响父 turn
    }
  };

  const hook: Hook = {
    name: AGENT_OWNER_INJECTION_HOOK,
    type: HookType.BeforeLlm,
    async run(ctx) {
      if (!active) return;

      // 成员 turn 与父 turn 共用 PluginHost；成员不得排空 owner 队列。
      if (options.isMemberSession) {
        try {
          if (await options.isMemberSession(ctx.session_id)) return;
        } catch {
          // 判定失败时按父 turn 处理（不因诊断失败丢消息）
        }
      }

      let messages: readonly OwnerQueueMessage[];
      try {
        messages = await options.source.takeMessages(options.ownerId);
      } catch (error) {
        publish('agent.reply.inject_failed', ctx.run_id, {
          owner_id: options.ownerId,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (!Array.isArray(messages) || messages.length === 0) return;

      // 同一条消息不得跨轮重复：takeMessages 已排空；core E5 再做 run 内去重。
      ctx.messages = [
        ...(ctx.messages ?? []),
        ...messages.map((message) => ownerMessageToMessage(message)),
      ];
      publish('agent.reply.injected', ctx.run_id, {
        owner_id: options.ownerId,
        count: messages.length,
        message_ids: messages.map((message) => message.id),
        source: 'owner_queue',
      });
    },
  };

  return {
    hook,
    dispose() {
      active = false;
    },
  };
}
