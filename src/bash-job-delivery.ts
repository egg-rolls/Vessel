/**
 * bash 后台作业的「唤醒投递」（0.55）—— 补异步 bash 的唯一缺口。
 *
 * 缺口：`plugins/tools/basic-tools` 的完成通知走 BeforeLlm hook，只在该会话**下一次模型
 * 请求前**注入。回合先结束、之后没人再说话时，那份结果永远送不到；而那正是异步最该覆盖的
 * 场景（长作业 + 回合先结束）。这里补的就是那一步：作业收口时把**同一份**已过出口闸的通知
 * 正文（job id / exit / 时长 / 日志路径 / 头尾预览 ≤1200 token，全文在文件里）当一条消息投进
 * 该会话并**起一轮 run**。与 `src/ask-answer-delivery.ts` 同一条准入链
 * （`AgentService.admit` → body mailbox → scheduler），不新造 RPC。
 *
 * 二选一，绝不两个都送：插件在收口那一刻先问这个出口，返回 true 就自己标 `announced`
 * （hook 永不再注入）；返回 false 则不标，hook 兜底（结果不丢，退回「等下一次 run」）。
 * 所以这里的每一次失败都必须**返回 false**、不许抛、不许重试 —— 重试会变成第二条投递。
 *
 * 为什么 `from` 是「成员自己」，退化时才是「它的归属者」：
 * `admit` 第 2 步是 `registry.canView(record, from)` —— private 成员只放行 `owner`。
 * 运行期没有自己的 principal：`system` 会被 `isHumanPrincipal` 认成人类（0.55 的硬错误闸
 * 会被它自动解开，正是那次事故的形状），`human` 同理，都不能借。于是按两档试：
 * - 自己（`record.id`）：最诚实的来源（成员自己的作业回报自己），且不是 human principal，
 *   不碰硬错误闸、不受停机 fence 影响；team 可见的成员都放行。
 * - 归属者（`record.owner`）：private 成员唯一放行的 principal，兜 private 的底。
 * 两档都不行就返回 false 交给 hook，并留一条 warn 证据。
 * 要一个真正的运行期身份，需要 `packages/agent` 把 `AdmitInput.origin` 的闭集合加一个
 * `bash_job`（并让它像 `ask_answer` 一样跳过 canView）—— 那是另一个包的改动，不在本次范围。
 */

import type { AgentService } from '../packages/agent/src/index';
import type { Logger } from '../packages/core/src/index';
import {
  type AsyncBashCompletion,
  registerAsyncBashCompletionSink,
} from '../plugins/tools/basic-tools/src/index';

/**
 * 同时在途的投递上限：与插件侧的 `MAX_ASYNC_JOBS`（4）对齐。
 *
 * 为什么要有：admit 会起 run，run 有预算。超限时直接返回 false（交给 hook 兜底），
 * 而不是排队 —— 排队会让「作业完成」和「模型看到结果」之间的延迟无上界。
 */
const MAX_INFLIGHT_DELIVERIES = 4;

/** 装配依赖：只要 admit + identify 两个口（不把整个 AgentService 契约绑进来）。 */
export type BashJobDeliveryDeps = {
  service: Pick<AgentService, 'admit' | 'identify'>;
  logger?: Logger;
};

/**
 * 注册唤醒投递。返回注销函数（宿主收口时调；进程级单槽，重复注册后者取代前者）。
 */
export function registerBashJobDelivery(deps: BashJobDeliveryDeps): () => void {
  let inflight = 0;
  return registerAsyncBashCompletionSink(async (completion: AsyncBashCompletion) => {
    if (inflight >= MAX_INFLIGHT_DELIVERIES) {
      deps.logger?.warn('agent.bash_job.delivery_skipped', {
        job_id: completion.jobId,
        reason: 'inflight_limit',
      });
      return false;
    }
    inflight += 1;
    try {
      return await deliver(deps, completion);
    } catch (error) {
      // 任何意外都收敛成 false：出口失败只是退回 hook，绝不影响作业本身。
      deps.logger?.warn('agent.bash_job.delivery_failed', {
        job_id: completion.jobId,
        session_id: completion.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      inflight -= 1;
    }
  });
}

/**
 * 真正投一次：先按「自己」投，被可见性闸门拦下时退到「归属者」。
 *
 * `member_not_visible` 是 canView 抛的、抛在**任何副作用之前**（admit 的第 2 步，早于 body /
 * mailbox），所以这一档失败后重投不会留下半条消息。其余错误（预算 / 停机 / 成员已关）
 * 直接收口返回 false —— 换一个发送者不解决这些问题，重投只会刷一堆必然失败。
 */
async function deliver(
  deps: BashJobDeliveryDeps,
  completion: AsyncBashCompletion,
): Promise<boolean> {
  const startedAt = Date.now();
  const member = await deps.service.identify(completion.sessionId);
  if (member === undefined) return false;

  const senders: string[] = [member.id];
  if (member.owner !== undefined && member.owner !== member.id) senders.push(member.owner);

  for (const from of senders) {
    try {
      deps.logger?.info('agent.bash_job.delivering', {
        job_id: completion.jobId,
        session_id: completion.sessionId,
        from,
        waited_ms: Date.now() - startedAt,
      });
      const result = await deps.service.admit({
        content: completion.content,
        agent_id: member.id,
        session_id: completion.sessionId,
        from,
        channel: 'direct',
      });
      deps.logger?.info('agent.bash_job.delivered', {
        job_id: completion.jobId,
        session_id: completion.sessionId,
        agent_id: member.id,
        from,
        run_id: result.run_id,
        status: result.status,
        exit_code: completion.exitCode,
        timed_out: completion.timedOut,
        elapsed_ms: completion.elapsedMs,
        waited_ms: Date.now() - startedAt,
      });
      return true;
    } catch (error) {
      const code = errorCodeOf(error);
      if (code === 'member_not_visible') continue;
      deps.logger?.warn('agent.bash_job.delivery_failed', {
        job_id: completion.jobId,
        session_id: completion.sessionId,
        from,
        code,
        waited_ms: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
  deps.logger?.warn('agent.bash_job.delivery_failed', {
    job_id: completion.jobId,
    session_id: completion.sessionId,
    from: senders.join(','),
    code: 'member_not_visible',
    waited_ms: Date.now() - startedAt,
  });
  return false;
}

/** `AgentError.code`（不 import 类：只读一个字符串字段，避免把错误类型绑进装配层）。 */
function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
