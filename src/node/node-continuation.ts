/**
 * 自重启续作投递（Option A 件 3，runlost-graceful-restart-audit §4.2）。
 *
 * 新进程启动扫 `resume_after_restart.continuation` 标记：触发者 run 已自然
 * completed ⇒ 把嘱托经 deliverStartupPrompt 同款通道（startup:true 首轮输入）
 * 投递 → 新 run 发起 → 续作开始，不依赖人类消息点火。投递成功后经单写口清标记。
 *
 * 诚实边界（审计 R5）：
 * - run 非 completed 终态（failed/cancelled/interrupted/记录缺失）⇒ 降级为普通
 *   shutdown 标记（去掉 continuation/intent），交给 node-resume 的有疤卡片路径；
 * - run 仍 running/queued（理论上启动 sweep 已对账，兜底）⇒ 不动标记，下次再判；
 * - 投递失败保持标记下次启动再试；attempts 上限（缺省 3）后降级卡片路径
 *   （崩溃循环防护，q-restart §5.5 同口径）；
 * - member 已关闭/退役/no_member ⇒ 清僵尸标记（续作已无意义，如实留日志）。
 *
 * 顺序：本扫描在 node-resume **之前**跑——无感续作先起跑；降级出来的普通标记
 * 恰好被随后的 node-resume 发卡。node-resume 自身跳过带 continuation 的标记。
 *
 * @module vessel/node-continuation
 */

import type { RestartCardKey } from '../../packages/core/src/runtime/resume-recovery.js';
import type {
  ResumeAfterRestart,
  SessionState,
  SessionStore,
} from '../../packages/core/src/types/session.js';

/** 启动扫描的读并发上限（与 node-resume 同口径）。 */
const CONTINUATION_SCAN_CONCURRENCY = 16;

/** 续作投递尝试上限（超限降级卡片路径）。 */
export const CONTINUATION_MAX_ATTEMPTS = 3;

export interface NodeContinuationSources {
  /** 会话状态仓库（只读扫描；标记的唯一权威是落盘 SessionState）。 */
  session: Pick<SessionStore, 'list' | 'load'>;
  /** 触发者 run 的 durable 状态；记录缺失 ⇒ undefined。 */
  runStatus(runId: string): Promise<string | undefined>;
  /** 续作投递（AgentService.deliverContinuationPrompt）。 */
  deliver(sessionId: string, prompt: string): Promise<{ delivered: boolean; reason?: string }>;
  /**
   * 标记单写口更新（装配层经 RunJournal 落盘）：
   * 只更新「还是同一份标记」（run_id + interrupted_at）的那一个；
   * transform 返回 undefined = 清除标记。返回是否真的更新了。
   */
  updateMarker(
    sessionId: string,
    key: RestartCardKey,
    transform: (marker: ResumeAfterRestart) => ResumeAfterRestart | undefined,
  ): Promise<boolean>;
  /** 尝试上限（缺省 CONTINUATION_MAX_ATTEMPTS）。 */
  maxAttempts?: number;
  warn?(event: string, meta?: Record<string, unknown>): void;
  info?(event: string, meta?: Record<string, unknown>): void;
}

export interface NodeContinuationReport {
  /** 扫到几个带 continuation 的会话 */
  found: number;
  /** 成功投递续作并清标记的会话 */
  delivered: string[];
  /** 降级为普通标记（有疤卡片路径）的会话 */
  downgraded: string[];
  /** 僵尸清理（member 已关闭/退役/不在册）的会话 */
  cleared: string[];
  /** 保持标记下次再试的会话（投递失败 / run 仍 live） */
  kept: string[];
}

/** 有界并发 map（与 node-resume 同形；不引依赖）。 */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index] as T);
      }
    }),
  );
  return results;
}

/** 降级：去掉 continuation/intent，保留普通 shutdown 标记（卡片路径）。 */
function downgradeMarker(marker: ResumeAfterRestart): ResumeAfterRestart {
  const { continuation: _c, intent: _i, resume_attempts: _a, ...rest } = marker;
  return rest;
}

/**
 * 执行一次启动续作扫描（每进程一次，由装配层在 node-resume 之前调用）。
 * 任何单会话失败不阻断其它会话，也不阻断启动。
 */
export async function resumeContinuations(
  sources: NodeContinuationSources,
): Promise<NodeContinuationReport> {
  const warn = sources.warn ?? (() => undefined);
  const info = sources.info ?? (() => undefined);
  const maxAttempts = Math.max(1, sources.maxAttempts ?? CONTINUATION_MAX_ATTEMPTS);
  const report: NodeContinuationReport = {
    found: 0,
    delivered: [],
    downgraded: [],
    cleared: [],
    kept: [],
  };

  // 1. 扫出带 continuation 的会话（只读落盘状态）。
  const ids = await sources.session.list();
  const loaded = await mapBounded(ids, CONTINUATION_SCAN_CONCURRENCY, async (id) => {
    try {
      return await sources.session.load(id);
    } catch (error) {
      warn('node.continuation.load_failed', {
        session_id: id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  });
  const candidates: Array<{ session_id: string; marker: ResumeAfterRestart }> = [];
  for (const state of loaded) {
    if (state === null) continue;
    const marker = state.resume_after_restart;
    if (marker === undefined || marker.continuation === undefined) continue;
    if (typeof marker.run_id !== 'string' || marker.run_id === '') continue;
    candidates.push({ session_id: state.session_id, marker });
  }
  report.found = candidates.length;
  if (candidates.length === 0) return report;

  // 2. 逐会话判定 + 投递（串行：续作投递本身会起 run，不制造 spawn 风暴）。
  for (const candidate of candidates) {
    const { session_id: sessionId, marker } = candidate;
    const key: RestartCardKey = { run_id: marker.run_id, interrupted_at: marker.interrupted_at };
    const continuation = marker.continuation;
    if (continuation === undefined) continue;
    try {
      const status = await sources.runStatus(marker.run_id);
      // run 仍 live（启动 sweep 未及收口等罕见情形）：不动，下次启动再判。
      if (status === 'running' || status === 'queued') {
        report.kept.push(sessionId);
        continue;
      }
      // 非 completed 终态 / 记录缺失 ⇒ 有疤降级（卡片路径）。
      if (status !== 'completed') {
        const ok = await sources.updateMarker(sessionId, key, downgradeMarker);
        if (ok) report.downgraded.push(sessionId);
        else report.kept.push(sessionId);
        info('node.continuation.downgraded', {
          session_id: sessionId,
          run_status: status ?? 'missing',
        });
        continue;
      }
      // 崩溃循环防护：attempts 超限 ⇒ 降级卡片路径。
      const attempts = marker.resume_attempts ?? 0;
      if (attempts >= maxAttempts) {
        const ok = await sources.updateMarker(sessionId, key, downgradeMarker);
        if (ok) report.downgraded.push(sessionId);
        else report.kept.push(sessionId);
        warn('node.continuation.attempts_exhausted', { session_id: sessionId, attempts });
        continue;
      }
      // 先递增 attempts（单写口、崩溃安全），再投递。
      await sources.updateMarker(sessionId, key, (current) => ({
        ...current,
        resume_attempts: (current.resume_attempts ?? 0) + 1,
      }));
      const outcome = await sources.deliver(sessionId, continuation.prompt);
      if (outcome.delivered) {
        await sources.updateMarker(sessionId, key, () => undefined);
        report.delivered.push(sessionId);
        info('node.continuation.delivered', { session_id: sessionId, run_id: marker.run_id });
        continue;
      }
      // member 已不在 / 关闭 / 退役：续作无意义，清僵尸标记（如实留日志）。
      if (
        outcome.reason === 'no_member' ||
        outcome.reason === 'closed' ||
        outcome.reason === 'left' ||
        outcome.reason === 'retired'
      ) {
        await sources.updateMarker(sessionId, key, () => undefined);
        report.cleared.push(sessionId);
        info('node.continuation.zombie_cleared', { session_id: sessionId, reason: outcome.reason });
        continue;
      }
      // 其它失败：保持标记（attempts 已递增），下次启动再试。
      report.kept.push(sessionId);
      warn('node.continuation.delivery_failed', {
        session_id: sessionId,
        reason: outcome.reason ?? 'unknown',
      });
    } catch (error) {
      report.kept.push(sessionId);
      warn('node.continuation.session_failed', {
        session_id: sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return report;
}

/** 供 node-resume 过滤：带 continuation 的标记归本模块管，不发有疤卡。 */
export function isContinuationMarker(state: SessionState): boolean {
  return state.resume_after_restart?.continuation !== undefined;
}
