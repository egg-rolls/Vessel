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

import { createHttpRpcClient } from '../rpc/http-client';
import { type GatewayPidRecord, isProcessAlive } from './pid';
import { gatewayBaseUrl } from './reload';

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
 */
export async function waitForProcessExit(
  pid: number,
  options: WaitForProcessExitOptions = {},
): Promise<{ dead: boolean; timedOut: boolean }> {
  const sleep = options.sleep ?? sleepDefault;
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? 100;
  const interval = options.progressIntervalMs ?? 5_000;
  const start = now();
  const deadline = options.timeoutMs !== undefined ? start + options.timeoutMs : undefined;
  let nextProgressAt = start + interval;

  for (;;) {
    if (!isProcessAlive(pid)) return { dead: true, timedOut: false };
    const at = now();
    if (deadline !== undefined && at >= deadline) return { dead: false, timedOut: true };
    if (options.onProgress !== undefined && at >= nextProgressAt) {
      nextProgressAt = at + interval;
      let runs: DrainRun[] = [];
      let unavailable = false;
      if (options.sampleRuns !== undefined) {
        try {
          runs = await options.sampleRuns();
        } catch {
          unavailable = true;
        }
      } else {
        unavailable = true;
      }
      try {
        options.onProgress({ waitedMs: at - start, runs, snapshotUnavailable: unavailable });
      } catch {
        // 进度渲染异常不影响等待。
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

/** 把等待毫秒渲染成人类时长（进度行用：35s / 4m12s）。 */
export function formatWaited(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}
