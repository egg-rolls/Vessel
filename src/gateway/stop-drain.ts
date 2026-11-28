/**
 * 优雅停止的共享等待 / 进度 / 快照接缝（cli-topology-design §5.3 / §5.4）。
 *
 * 设计口径（用户裁定 #5）：
 * - **默认不限时 drain**：停止方等进程自死，无硬 deadline；显式 `--timeout` 才是
 *   可选上限，到点**不自动强杀**（如实报告阻塞者，提示升级阶梯）。
 * - **不限时间 ≠ 无反馈**：等待期间每 5s 拉一次 node 的 live run 快照
 *   （`runs.list` 的 queued/running），经 `onProgress` 回调渲染进度行。
 * - **force = 非正常退出**：终止前先快照在跑 run（`snapshotActiveRuns`），
 *   供停止方代打 `stop.forced` 审计（abnormal_exit / runs_cut）。
 *
 * 本模块只做「等死 + 采样」，不做终止、不做归属复核、不打印 —— 那些归各组件
 * stop 接缝（stopGateway / nodeStopCommand / stopSpawnedChildren）。等待预算恒在
 * 停止方（K5）；RPC 采样失败一律退化为「快照不可用」，绝不让等待卡住或假成功。
 *
 * @module vessel/stop-drain
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHttpRpcClient, isRpcConnectionRefused } from '../rpc/http-client';
import { type GatewayPidRecord, isProcessAlive } from './pid';
import { gatewayBaseUrl } from './reload';

/**
 * DR15-1：等死段有界兜底预算（quiesce 之后等进程自死）。
 * scope A 修复后正常退出链 <1-2s；病态但有界的清理最坏 ~15-20s（child terminate
 * 并行 ≤8s + server.stop 5s + flush），30s 留足裕量防误杀。quiesce 后已无 live run，
 * 兜底强杀 runs_cut 恒 0 —— 代价只是等待时长，不是切断工作。
 */
export const POST_QUIESCE_EXIT_TIMEOUT_MS = 30_000;

/** drain 进度 / force 审计里的一条在跑 run（不含 token）。 */
export interface DrainRun {
  run_id: string;
  session_id: string;
  status: string;
  started_at?: number;
}

/** 一次进度回调的载荷（停止方据此渲染「哪些 run/session 还在跑」）。 */
export interface DrainProgressInfo {
  /** 已等待毫秒（停止方渲染 waited Xs）。 */
  waitedMs: number;
  /** 当前 live run（queued + running）；采样失败 = 空数组。 */
  runs: DrainRun[];
  /** true = 本次采样失败（监听已关 / 网络），进度行如实标注「快照不可用」。 */
  snapshotUnavailable: boolean;
}

export interface WaitForProcessExitOptions {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /**
   * 可选显式上限（毫秒）。**缺省 undefined = 不限时**（默认优雅路径）。
   * 到点返回 `{ dead:false, timedOut:true }`，调用方如实报告，不自动强杀。
   */
  timeoutMs?: number;
  /**
   * DR15-1：等死段有界兜底（毫秒，缺省 undefined = 不启用，兼容旧调用）。
   *
   * 红线（用户裁定 #5）：**候 run 段不限时语义不动** —— 采样到 live run > 0 时
   * 时钟重置，继续不限时等 run 自然跑完。本预算只约束「quiesce 之后等进程自死」
   * 这一段：node 退出序列硬顺序 beginDrain → gateway.stop，quiesce 后进程应秒退；
   * 退出链挂死（ISSUE-DR15-1）时不该让停止方无限干等。
   *
   * quiesce 证据（停止方读不到 node 的 drain.done，用采样推断）——**要求阳性**
   * （SD-4：任何采样失败都当「drain 必已完成」会在 401 / 事件循环过载 / 网络抖动
   * 时把仍在跑的 run 误判成已 drain → 30s 强杀）：
   * - 采样成功且 live run = 0（fence 已关闸，live 集合只减不增）；
   * - 采样失败且**专属连接拒绝**（ECONNREFUSED / Bun ConnectionRefused）：本地
   *   stop 回环连接被拒 = 监听已闭，而监听只在 beginDrain 完成**之后**才关
   *   （gateway.stop）⇒ drain 必已完成。
   * - 401 / 超时 / 其它失败**不是**证据：不计入强杀时钟（时钟重置，等下一次阳性）。
   * 证据持续满本预算进程仍活 → 返回 `quiesceTimedOut:true`，调用方 force-kill
   * 兜底 + stop.forced 审计（此时已无 live run，runs_cut 恒 0）。
   */
  postQuiesceTimeoutMs?: number;
  /** 进度回调（缺省不渲染）；约每 progressIntervalMs 触发一次。 */
  onProgress?: (info: DrainProgressInfo) => void;
  /** live run 采样器（调用方用 nodeRunSampler 接线）；缺省 = 无进度数据。 */
  sampleRuns?: () => Promise<DrainRun[]>;
  /** 进度间隔（缺省 5000ms = 5s 一行）。 */
  progressIntervalMs?: number;
  /** 探活轮询间隔（缺省 100ms，与既有等死循环同口径）。 */
  pollMs?: number;
}

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 等一个进程自死（优雅 drain 的停止方等待段）。
 *
 * 缺省不限时；显式 timeoutMs 到点返回 timedOut（不强杀）。等待期间按
 * progressIntervalMs 采样 live run 并回调 onProgress（采样失败标注不可用）。
 * 进程死亡立即返回 `{ dead:true }`。
 *
 * DR15-1：启用 postQuiesceTimeoutMs 后，quiesce **阳性**证据（成功采样 0 live run /
 * 专属连接拒绝 = 监听已闭）持续满预算进程仍活 → 返回 quiesceTimedOut（调用方 force
 * 兜底 + 审计）；采样到 live run > 0 重置时钟 —— 候 run 段不限时红线不动。
 * SD-4：401 / 超时 / 其它采样失败不是证据，不计入强杀时钟（重置，等下一次阳性）。
 */
export async function waitForProcessExit(
  pid: number,
  options: WaitForProcessExitOptions = {},
): Promise<{ dead: boolean; timedOut: boolean; quiesceTimedOut: boolean }> {
  const sleep = options.sleep ?? sleepDefault;
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? 100;
  const interval = options.progressIntervalMs ?? 5_000;
  const start = now();
  const deadline = options.timeoutMs !== undefined ? start + options.timeoutMs : undefined;
  const postQuiesceMs = options.postQuiesceTimeoutMs;
  let nextProgressAt = start + interval;
  /** quiesce 证据首次出现时刻；live run > 0 时重置（候 run 段不限时）。 */
  let quiesceSince: number | undefined;

  for (;;) {
    if (!isProcessAlive(pid)) return { dead: true, timedOut: false, quiesceTimedOut: false };
    const at = now();
    if (deadline !== undefined && at >= deadline) {
      return { dead: false, timedOut: true, quiesceTimedOut: false };
    }
    // 有界兜底启用时采样不依赖 onProgress（supervisor.stop 无进度回调也要能判定 quiesce）。
    const wantSample = options.onProgress !== undefined || postQuiesceMs !== undefined;
    if (wantSample && at >= nextProgressAt) {
      nextProgressAt = at + interval;
      let runs: DrainRun[] = [];
      let unavailable = false;
      /** SD-4：失败是否专属连接拒绝（监听已闭）—— 唯一可作阳性证据的失败。 */
      let listenerClosed = false;
      if (options.sampleRuns !== undefined) {
        try {
          runs = await options.sampleRuns();
        } catch (error) {
          unavailable = true;
          listenerClosed = isRpcConnectionRefused(error);
        }
      } else {
        unavailable = true;
      }
      if (postQuiesceMs !== undefined) {
        if (!unavailable && runs.length > 0) {
          // 候 run 段：还有活就重置时钟，继续不限时等（用户裁定 #5 红线）。
          quiesceSince = undefined;
        } else if (!unavailable || listenerClosed) {
          // quiesce 阳性证据：成功采样 0 live run，或专属连接拒绝（监听闭 ⟹ drain 毕）。
          quiesceSince ??= at;
          if (at - quiesceSince >= postQuiesceMs) {
            return { dead: false, timedOut: false, quiesceTimedOut: true };
          }
        } else {
          // SD-4：401 / 超时 / 其它失败不是证据 —— 不计入强杀时钟，重置等下一次阳性。
          // （无采样器时同口径：没有阳性证据就不推断 drain 完成，宁可不强杀。）
          quiesceSince = undefined;
        }
      }
      if (options.onProgress !== undefined) {
        try {
          options.onProgress({ waitedMs: at - start, runs, snapshotUnavailable: unavailable });
        } catch {
          // 进度渲染异常不影响等待。
        }
      }
    }
    await sleep(pollMs);
  }
}

/** runs.list 结果里挑出 live（queued/running）run，归一成 DrainRun。 */
function activeRunsOf(raw: unknown): DrainRun[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const runs = (raw as { runs?: unknown }).runs;
  if (!Array.isArray(runs)) return [];
  const out: DrainRun[] = [];
  for (const item of runs) {
    if (typeof item !== 'object' || item === null) continue;
    const run = item as Record<string, unknown>;
    const status = typeof run.status === 'string' ? run.status : '';
    if (status !== 'queued' && status !== 'running') continue;
    const runId = typeof run.run_id === 'string' ? run.run_id : '';
    const sessionId = typeof run.session_id === 'string' ? run.session_id : '';
    if (runId === '') continue;
    out.push({
      run_id: runId,
      session_id: sessionId,
      status,
      ...(typeof run.started_at === 'number' ? { started_at: run.started_at } : {}),
    });
  }
  return out;
}

/**
 * 一次性采样 node 的 live run（force 终止前的审计快照用）。
 * 失败抛错由调用方兜底（记「快照不可用」）；不打印、不终止。
 */
export async function snapshotActiveRuns(
  record: GatewayPidRecord,
  token: string,
  tls?: boolean,
): Promise<DrainRun[]> {
  const client = createHttpRpcClient({
    baseUrl: gatewayBaseUrl(record, tls === true),
    token,
    subscribe: false,
    requestTimeoutMs: 2_000,
  });
  try {
    const raw = await client.request('runs.list', {});
    return activeRunsOf(raw);
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * 造一个进度采样器（waitForProcessExit 的 sampleRuns 接缝）。
 * 每次调用开一个短命 RPC 客户端拉 runs.list；drain 期间 node 读面仍在
 * （fence 只拒新 run），监听关闭后采样失败 → 进度行标注「快照不可用」。
 */
export function nodeRunSampler(
  record: GatewayPidRecord,
  token: string,
  tls?: boolean,
): () => Promise<DrainRun[]> {
  return () => snapshotActiveRuns(record, token, tls);
}

/**
 * q-error-e2（§3.5）：drain 失败按 reason 的可操作指引。
 * hintKey 已在 core 注册表登记（node_drain_*）；四段 i18n 全文属 E3，
 * 本期 hint 字段 + hintKey 就位。token 值绝不进指引文本。
 */
export function drainSkippedHint(reason: string): { hint_key: string; hint: string } | undefined {
  switch (reason) {
    case 'no_record':
      return {
        hint_key: 'error.hint.node_drain_no_record',
        hint: 'gateway.pid missing or pid mismatch; the node may have crashed or been started outside the supervisor. Check the node log.',
      };
    case 'unauthorized':
      return {
        hint_key: 'error.hint.node_drain_unauthorized',
        hint: 'Stop credential rejected (401) and anonymous loopback fallback failed. Verify gateway.token / VESSEL_NODE_TOKEN matches the target node config.',
      };
    case 'method_not_found':
      return {
        hint_key: 'error.hint.node_drain_method_not_found',
        hint: 'Target gateway build does not expose gateway.shutdown; upgrade the node or stop it manually.',
      };
    case 'network':
      return {
        hint_key: 'error.hint.node_drain_network',
        hint: 'Cannot reach the node gateway (connection refused / timeout). Check the process and gateway.pid host:port.',
      };
    case 'timeout':
      return {
        hint_key: 'error.hint.node_drain_timeout',
        hint: 'Node did not exit within the stop timeout; active runs may still be draining. Inspect runs.list or force-stop.',
      };
    case 'quiesce_timeout':
      return {
        hint_key: 'error.hint.node_drain_quiesce_timeout',
        hint: 'Node quiesced but did not exit within the post-quiesce window; force-killed. Check shutdown hooks.',
      };
    default:
      return undefined;
  }
}

/** 把等待毫秒渲染成人类时长（进度行用：35s / 4m12s）。 */
export function formatWaited(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

/**
 * DR15-1/O7：停止方代打的审计持久化到目标实例日志文件（best-effort）。
 *
 * 为什么需要：停止方是独立短命 CLI 进程，它的 stdout/stderr 不进 node/gateway
 * 日志文件 —— stop.forced 审计只打终端会随终端丢失（O7 盲点）。这里把结构化
 * 审计行追加进目标自己的日志（与进程内日志同文件，事后可按时间线对账）。
 * 日志路径由调用方给：platform / 独立 node daemon → gatewayLogPath(dataDir, instance)；
 * 平台托管 node 子进程 → nodeLogPath(gatewayDataDir, name)。失败绝不阻断停止。
 */
export async function persistStopAuditLine(logPath: string, line: string): Promise<void> {
  try {
    await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
    await appendFile(logPath, line.endsWith('\n') ? line : `${line}\n`, { mode: 0o600 });
  } catch {
    // best-effort：审计持久化失败不阻断停止。
  }
}
