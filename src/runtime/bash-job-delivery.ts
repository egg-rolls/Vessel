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
 * 为什么 `from` 是「成员自己」，而且能投进 private 成员：
 * `admit` 第 2 步是 `registry.canView(record, from)` —— private 成员只放行 `owner`，
 * 而运行期**没有自己的 principal**：`system` / `human` 会被 `isHumanPrincipal` 认成人类，
 * 顺手解开 0.55 的硬错误闸（正是那次事故的形状），一个都不能借。
 * 0.55 的做法是给 `AdmitInput.origin` 加一个 `bash_job`（与 `ask_answer` 同级）：
 * **跳过 canView**（这不是「谁能驱动这个成员」，而是它自己的作业回报它自己），
 * 但**不是人类**（不落 `unblockBodies`、不受停机 fence 的人类分支约束），
 * 消息照常进目标 body 的 inbox / mailbox、照常走预算闸（自投递也可能成环，闸要留）。
 * 于是 `from` 可以用真正的运行期身份 —— 起这条作业的那个成员 —— 不再借归属者。
 */

import type { AgentService } from '../../packages/agent/src/index';
import type { Logger } from '../../packages/core/src/index';
import {
  type AsyncBashCompletion,
  registerAsyncBashCompletionSink,
} from '../../plugins/tools/basic-tools/src/index';

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

  // `from` = 真正起这条作业的那个成员（它就是这条会话的持有者）：
  // 「它自己的后台作业回报它自己」。不借 `human` / `system`（那会被 isHumanPrincipal
  // 认成人类，顺手解开 0.55 的硬错误闸）；也不借归属者 —— 有了 `origin: 'bash_job'`
  // 之后 admit 会跳过 canView，所以不需要谁来「代表」它。
  const from = member.id;
  try {
    deps.logger?.debug('agent.bash_job.delivering', {
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
      origin: 'bash_job',
    });
    deps.logger?.debug('agent.bash_job.delivered', {
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
    // 一次投递、一次判定：不换发送者重试（重试 = 可能出现第二条投递）。
    // 失败就返回 false 交给插件侧的 notice hook 兜底（结果不丢，只是退回「等下一次 run」）。
    deps.logger?.warn('agent.bash_job.delivery_failed', {
      job_id: completion.jobId,
      session_id: completion.sessionId,
      from,
      code: errorCodeOf(error),
      waited_ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** `AgentError.code`（不 import 类：只读一个字符串字段，避免把错误类型绑进装配层）。 */
function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
