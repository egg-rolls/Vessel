/**
 * node 启动恢复（0.52 S1c）。
 *
 * 目标只有一条：**进程重启后，被打断的那段工作对用户和 agent 都说得清**。
 * 顺序是硬要求，不能换：
 *
 *   1. 读标记 —— 枚举落盘 SessionState 里的 `resume_after_restart`（唯一权威）；
 *   2. 发卡   —— 每个带标记的会话一张「重启恢复」环境信息卡：一次 `runtime.notice`，
 *                由既有环境信息通道在**下一次请求、用户输入之前**注入 ⇒ 同一份文本
 *                既进模型上下文、也在聊天流里渲染成 EnvCard（用户裁定：一张卡，两边同源）；
 *   3. 重放   —— 卡之后再走既有 `recoverPendingInputs()`（只认 human 源、按最早 ts FIFO）；
 *   4. 等准入 —— 卡片落成消息且随请求进了模型上下文（`message.injected` 之后有
 *                `llm.request`）之后才清标记；没准入就留着，下次启动再判。
 *
 * 边界（S1c 不做，别在这里顺手加）：
 * - 不续 run、不重放工具调用（已否决）；不碰 S1a 的 fence / interrupt；不碰 restart 工具（S2）；
 * - 不碰 gateway / handoff / lease / UI 样式：卡片只用现有的 EnvCard 渲染族；
 * - 标记的读写只经 RunJournal 单写口（清标记由装配层注入 `clearMarker`）。
 *
 * 幂等：
 * - 清完标记 ⇒ 同一会话第二次启动扫不到，不会重复发卡；
 * - 没清（刚恢复又崩）⇒ 去重键（run_id + interrupted_at 出现在卡文本里）
 *   让下一次启动认出「这张卡已经发过」，只补判定、不发第二张。
 *
 * @module vessel/node-resume
 */

import { formatEnvInfo } from '../packages/agent/src/env-info-scope.js';
import {
  findRestartCardRecord,
  type RestartCandidate,
  type RestartCardKey,
  restartCandidates,
  restartCardAdmitted,
  restartInterruptedIso,
} from '../packages/core/src/index.js';
import type { SessionEventRecord } from '../packages/core/src/types/event.js';
import type { SessionState, SessionStore } from '../packages/core/src/types/session.js';
import { getLocale, type Locale, tIn } from './i18n/index.js';

/** 等「准入」的预算（毫秒）：启动阶段不该为此久等，超时就留标记给下次启动。 */
export const NODE_RESUME_SETTLE_MS = 10_000;

/** 准入轮询间隔（毫秒）：只读事件日志尾部，不起任何 run。 */
const RESUME_POLL_MS = 20;

/** 重放结果（沿用既有 `recoverPendingInputs()` 的回报）。 */
export interface NodeResumeReplay {
  /** 真的被重放的输入条数 */
  recovered: number;
  /** 有输入被重放的会话数 */
  sessions: number;
}

/**
 * 启动恢复要的最小契约。
 *
 * 故意用结构类型而不是直接吃 bundle / service：探针可以拿替身顶上来，
 * 装配层也只需要这四个动作（读标记 / 发卡 / 清标记 / 重放）。
 */
export interface NodeResumeSources {
  /** 会话状态仓库；只读（标记的唯一权威是落盘的 SessionState） */
  session: Pick<SessionStore, 'list' | 'load'>;
  /** 会话事件日志；只读（卡片发没发过 / 有没有进过请求，都看它） */
  eventLog: {
    read(
      sessionId: string,
      opts?: { sinceSeq?: number; limit?: number },
    ): Promise<SessionEventRecord[]>;
  };
  /**
   * 发卡：把这条文本排进该会话的下一次请求（用户输入之前）。
   * 返回 false = 这具 body 现在收不了卡（没在册 / 已退役 / 已关闭）。
   */
  announce(sessionId: string, text: string): boolean | Promise<boolean>;
  /**
   * 清标记：走 RunJournal 单写口，且**只清还是同一份标记**的那一个。
   *
   * 返回 true = 这份标记已经解决（被这里清掉，或者恢复期间的那一轮 run 落盘时
   * 已经把它带走了 —— 两种都算「该会话不再需要恢复」）；
   * 返回 false = 标记已经换成另一份（恢复途中又崩了一次，那是新的标记，留着）。
   */
  clearMarker(sessionId: string, marker: RestartCardKey): Promise<boolean>;
  /** 既有 FIFO 重放：卡之后才调，别自己造一条输入 */
  replay(): Promise<NodeResumeReplay>;
  /** 卡片文案的语言（缺省＝进程当前语言）；文案本身两边同源，不在这里分叉 */
  locale?: Locale;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  settleBudgetMs?: number;
  warn?: (event: string, meta?: Record<string, unknown>) => void;
}

/** 一个会话的恢复进度（回报用，便于真机看日志）。 */
export interface NodeResumeMark {
  session_id: string;
  run_id: string;
  interrupted_at: number;
  /** announced＝这次发了新卡；deduped＝上一轮已经发过（不重复发）；skipped＝没有可收卡的 body */
  card: 'announced' | 'deduped' | 'skipped';
  /** 卡后面排着的已接受输入条数（标记里记的那一份） */
  pending_inputs: number;
  /** pending＝还在等准入；cleared＝准入后已清；kept＝准入不了/标记已变，留给下次启动 */
  marker: 'pending' | 'cleared' | 'kept';
}

export interface NodeResumeReport {
  /** 扫到几个带标记的会话 */
  marked: number;
  announced: number;
  deduped: number;
  skipped: number;
  /** 重放了多少条**已接受**的输入 */
  replayed_inputs: number;
  /** 有输入被重放的会话数 */
  replayed_sessions: number;
  /** 这次真清掉标记的会话 */
  cleared: string[];
  marks: NodeResumeMark[];
  settle: 'idle' | 'settled' | 'timeout';
}

export interface NodeResumer {
  /** 1-3 步：读标记 → 发卡 → 重放（不等待准入） */
  beginResume(): Promise<NodeResumeReport>;
  /** 4 步：等本轮的卡被准入，然后清标记；返回最终报告 */
  whenSettled(): Promise<NodeResumeReport>;
}

/**
 * 生成「重启恢复」环境信息卡（i18n，两侧同一份文本）。
 *
 * 文案要同时满足两件事：
 * - 对用户：说清「网关在你工作时重启了、被打断的是哪个 run、当时排着几条输入」；
 * - 对模型：这是**指令**——先核对现状再继续，别盲目重做已被保住的工作。
 *
 * 形状直接走既有环境信息族的 `formatEnvInfo`（首行 `<scope>: <summary>`，明细行
 * 用 `ENV_INFO_DETAIL_MARK` 前缀）：scope 用已登记的 `restart`（web `env-notice.ts`
 * 用它选卡头标签、渲染成 EnvCard ⇒ 一张卡，两边同源），明细里固定带 run_id 与
 * ISO 时刻 —— 既是给模型看的事实，也是启动幂等的去重键。
 */
export function restartCardText(
  marker: RestartCandidate['marker'],
  ctx: { pending_inputs: number; background_stopped?: boolean },
  locale: Locale = getLocale(),
): string {
  const time = restartInterruptedIso(marker);
  const details = [
    tIn(locale, 'resume.card.run_line', { run_id: marker.run_id, reason: marker.reason }),
    tIn(locale, 'resume.card.interrupted_at', { time }),
    tIn(locale, 'resume.card.verify_first'),
  ];
  if (marker.background_stopped === true || ctx.background_stopped === true) {
    details.push(tIn(locale, 'resume.card.background_stopped'));
  }
  details.push(
    ctx.pending_inputs > 0
      ? tIn(locale, 'resume.card.pending_inputs', { count: String(ctx.pending_inputs) })
      : tIn(locale, 'resume.card.no_pending_inputs'),
  );
  return formatEnvInfo({
    scope: 'restart',
    summary: tIn(locale, 'resume.card.summary', {
      run_id: marker.run_id,
      time,
      reason: marker.reason,
    }),
    details,
  });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 造一个启动恢复执行器。
 *
 * 只依赖注入进来的四件事（会话仓库 / 事件日志 / 发卡 / 清标记 + 重放），自己不做 IO。
 */
export function createNodeResumer(sources: NodeResumeSources): NodeResumer {
  const now = sources.now ?? (() => Date.now());
  const sleep = sources.sleep ?? defaultSleep;
  const settleBudget = Math.max(0, sources.settleBudgetMs ?? NODE_RESUME_SETTLE_MS);
  const warn = sources.warn ?? (() => undefined);
  /** 首次 `beginResume()` 的即时报告（重复调只回这一份，不重复发卡）。 */
  let first: { report: NodeResumeReport } | undefined;
  let settled: Promise<NodeResumeReport> | undefined;

  /** 1 步：扫出带标记的会话（只读落盘状态，不猜）。 */
  async function scan(): Promise<RestartCandidate[]> {
    const ids = await sources.session.list();
    const states: SessionState[] = [];
    for (const id of ids) {
      try {
        const state = await sources.session.load(id);
        if (state !== null) states.push(state);
      } catch (error) {
        warn('node.resume.load_failed', {
          session_id: id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return restartCandidates(states);
  }

  /** 这张卡在事件日志里发过没有（发过就不发第二张）。 */
  async function readEvents(sessionId: string): Promise<SessionEventRecord[]> {
    try {
      return await sources.eventLog.read(sessionId);
    } catch (error) {
      warn('node.resume.events_failed', {
        session_id: sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /** 2-3 步：发卡 + 重放。 */
  async function announceAndReplay(candidates: RestartCandidate[]): Promise<NodeResumeReport> {
    const marks: NodeResumeMark[] = [];
    for (const candidate of candidates) {
      const marker = candidate.marker;
      const key: RestartCardKey = { run_id: marker.run_id, interrupted_at: marker.interrupted_at };
      const pendingInputs = Array.isArray(marker.pending_input_ids)
        ? marker.pending_input_ids.length
        : 0;
      const mark: NodeResumeMark = {
        session_id: candidate.session_id,
        run_id: marker.run_id,
        interrupted_at: marker.interrupted_at,
        card: 'skipped',
        pending_inputs: pendingInputs,
        marker: 'pending',
      };
      marks.push(mark);

      const existing = findRestartCardRecord(await readEvents(candidate.session_id), key);
      if (existing !== undefined) {
        // 上一轮发过、但没等到准入（或准入后没来得及清）：只补判定，不发第二张。
        mark.card = 'deduped';
        continue;
      }
      const text = restartCardText(marker, { pending_inputs: pendingInputs }, sources.locale);
      let announced = false;
      try {
        announced = (await sources.announce(candidate.session_id, text)) === true;
      } catch (error) {
        warn('node.resume.announce_failed', {
          session_id: candidate.session_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      mark.card = announced ? 'announced' : 'skipped';
    }

    // 卡排在前面，重放排在后面：既有 FIFO 重放（只认 human 源、按最早 ts）。
    let replay: NodeResumeReplay = { recovered: 0, sessions: 0 };
    try {
      replay = await sources.replay();
    } catch (error) {
      warn('node.resume.replay_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return {
      marked: candidates.length,
      announced: marks.filter((mark) => mark.card === 'announced').length,
      deduped: marks.filter((mark) => mark.card === 'deduped').length,
      skipped: marks.filter((mark) => mark.card === 'skipped').length,
      replayed_inputs: replay.recovered,
      replayed_sessions: replay.sessions,
      cleared: [],
      marks,
      settle: 'idle',
    };
  }

  /** 4 步：等到准入，然后清标记（准入不了就留着，下次启动再判）。 */
  async function awaitAdmission(report: NodeResumeReport): Promise<NodeResumeReport> {
    // 没有 body 收卡的（skipped）等不到准入：直接记 kept，留着标记给下次启动。
    for (const mark of report.marks) {
      if (mark.marker === 'pending' && mark.card === 'skipped') mark.marker = 'kept';
    }
    const waiting = report.marks.filter((mark) => mark.marker === 'pending');
    if (waiting.length === 0) {
      return {
        ...report,
        cleared: report.marks
          .filter((mark) => mark.marker === 'cleared')
          .map((mark) => mark.session_id),
        settle: 'idle',
      };
    }

    const deadline = now() + settleBudget;
    let pending = waiting;
    let outcome: NodeResumeReport['settle'] = 'timeout';
    for (;;) {
      const still: NodeResumeMark[] = [];
      for (const mark of pending) {
        const key: RestartCardKey = { run_id: mark.run_id, interrupted_at: mark.interrupted_at };
        const events = await readEvents(mark.session_id);
        if (!restartCardAdmitted(events, key)) {
          still.push(mark);
          continue;
        }
        let cleared = false;
        try {
          cleared = await sources.clearMarker(mark.session_id, key);
        } catch (error) {
          warn('node.resume.clear_failed', {
            session_id: mark.session_id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        mark.marker = cleared ? 'cleared' : 'kept';
      }
      pending = still;
      if (pending.length === 0) {
        outcome = 'settled';
        break;
      }
      if (now() >= deadline) break;
      await sleep(Math.min(RESUME_POLL_MS, Math.max(1, deadline - now())));
    }
    // 超时还挂着的：留着标记（不删），把状态记成 kept 便于真机看日志。
    for (const mark of pending) mark.marker = 'kept';
    return {
      ...report,
      cleared: report.marks
        .filter((mark) => mark.marker === 'cleared')
        .map((mark) => mark.session_id),
      settle: outcome,
    };
  }

  return {
    async beginResume(): Promise<NodeResumeReport> {
      // 幂等：启动路径只该调一次；重复调就返回首次的报告，不重复发卡/重放。
      if (first !== undefined) return first.report;
      const report = await announceAndReplay(await scan());
      first = { report };
      // 准入判定放到后台：启动不该为了等卡片进请求而卡住（gateway 要先能收 RPC）。
      settled = awaitAdmission(report);
      settled.catch((error: unknown) => {
        warn('node.resume.settle_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return report;
    },
    async whenSettled(): Promise<NodeResumeReport> {
      if (settled === undefined) return { ...emptyReport(), settle: 'idle' };
      return settled;
    },
  };
}

function emptyReport(): NodeResumeReport {
  return {
    marked: 0,
    announced: 0,
    deduped: 0,
    skipped: 0,
    replayed_inputs: 0,
    replayed_sessions: 0,
    cleared: [],
    marks: [],
    settle: 'idle',
  };
}
