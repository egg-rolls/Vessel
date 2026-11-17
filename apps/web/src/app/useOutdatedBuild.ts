import { useEffect, useState } from 'react';
import {
  fetchServedBuild,
  type OutdatedReason,
  outdatedReason,
  parseServedBuildText,
  type ServedBuildInfo,
} from '../build-info';

/**
 * 「页面已过期」的发现通道（0.37 轮询 → 0.57 **推送 + 轮询兜底**）。
 *
 * 背景：`dist` 不入 git，gateway 在产物落后于源码时**后台重建**。重建完成后，
 * 已经打开的标签页仍然是旧 bundle（它自己的 JS 不会变），只有重新加载才会拿到新的。
 *
 * 两种「该刷新了」的证据（见 `outdatedReason`）：
 * 1. `builtAt` 变了 ⇒ 网关已经重建过，刷新即可；
 * 2. `stale === true` ⇒ **源码比产物新、还没人重建**。没有这一条时，前端永远发现不了
 *    「我跑的是昨天的 bundle」—— 磁盘上的 `build.json` 与自己那份 bundle 是同一次
 *    构建，比对必然一致，屏幕上一声不响。
 *
 * 为什么改成推送：轮询是「每个标签页每 10 秒一次」，一天 8,640 次请求、延迟最多 10s，
 * 而这些请求几乎永远是「没变化」。平台侧 `/web/build/events`（SSE）把同一份
 * `/build.json` 内容在**变化时**推过来：空闲时是一条长连接、零请求、毫秒级送达。
 *
 * 推送是加速通道，不是事实源：连不上 / 被反代缓冲 / 503（连接数满）时自动退回
 * 自适应轮询（10s → 30s → 60s），连续失败到上限就彻底安静（无法判断 ≠ 过期）。
 *
 * 只提示、**绝不自动 reload**：用户可能正在输入，刷新由他自己点。
 */
/** SSE 端点（平台的产物推送）。 */
const EVENTS_PATH = '/web/build/events';
/** 轮询兜底的自适应退避：成功后回到 10s。 */
const POLL_STEPS_MS = [10_000, 30_000, 60_000] as const;
/** 连续失败上限（推送与轮询各自计）：到顶就停，别无限重连。 */
const MAX_SSE_ERRORS = 5;
const MAX_POLL_FAILURES = 10;
/** 首帧超时：反代缓冲住 SSE 时连接「开着但没内容」，一样算不可用。 */
const FIRST_FRAME_TIMEOUT_MS = 15_000;

export function useOutdatedBuild(): OutdatedReason | undefined {
  const [outdated, setOutdated] = useState<OutdatedReason | undefined>(undefined);

  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    const apply = (served: ServedBuildInfo | undefined): void => {
      if (!disposed) setOutdated(outdatedReason(served));
    };

    // ── 轮询兜底（自适应退避，有上限） ──
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let pollStep = 0;
    let pollFailures = 0;
    let polling = false;

    const stopPolling = (): void => {
      polling = false;
      if (pollTimer !== undefined) {
        clearTimeout(pollTimer);
        pollTimer = undefined;
      }
    };

    const schedulePoll = (): void => {
      if (disposed || !polling) return;
      if (pollTimer !== undefined) clearTimeout(pollTimer);
      const delay = POLL_STEPS_MS[Math.min(pollStep, POLL_STEPS_MS.length - 1)] ?? 60_000;
      pollTimer = setTimeout(() => void check(), delay);
    };

    const check = async (): Promise<void> => {
      if (disposed || !polling) return;
      const served = await fetchServedBuild(controller.signal);
      if (disposed) return;
      if (served === undefined) {
        pollFailures += 1;
        if (pollFailures >= MAX_POLL_FAILURES) {
          stopPolling();
          return;
        }
        pollStep += 1;
      } else {
        pollFailures = 0;
        pollStep = 0;
        apply(served);
      }
      schedulePoll();
    };

    const startPolling = (): void => {
      if (disposed || polling) return;
      polling = true;
      pollStep = 0;
      void check();
    };

    // ── 推送（SSE） ──
    let source: EventSource | undefined;
    let sseErrors = 0;
    let sseStopped = false;
    let firstFrameTimer: ReturnType<typeof setTimeout> | undefined;

    const clearFirstFrameTimer = (): void => {
      if (firstFrameTimer !== undefined) {
        clearTimeout(firstFrameTimer);
        firstFrameTimer = undefined;
      }
    };

    const stopSource = (): void => {
      clearFirstFrameTimer();
      if (source !== undefined) {
        source.close();
        source = undefined;
      }
    };

    /** 推送不可用：记一次失败，到上限就永久停掉；期间退回轮询。 */
    const degrade = (): void => {
      sseErrors += 1;
      if (sseErrors >= MAX_SSE_ERRORS) {
        sseStopped = true;
        stopSource();
      }
      startPolling();
    };

    const connect = (): void => {
      if (disposed || sseStopped) return;
      if (typeof EventSource === 'undefined') {
        startPolling();
        return;
      }
      // 同源 + cookie：**不把 token 放进 URL**（会落进反代日志与浏览器历史）。
      const es = new EventSource(EVENTS_PATH, { withCredentials: true });
      source = es;
      firstFrameTimer = setTimeout(() => {
        // 连上了却一帧没到：多半被中间层缓冲 ⇒ 按不可用处理（不关连接，等它自己好）。
        if (es.readyState !== EventSource.CLOSED) {
          sseErrors += 1;
          startPolling();
        }
      }, FIRST_FRAME_TIMEOUT_MS);
      es.onmessage = (event: MessageEvent<string>): void => {
        sseErrors = 0;
        clearFirstFrameTimer();
        const served = parseServedBuildText(event.data);
        if (served !== undefined) {
          apply(served);
          // 推送是事实源：它活着就不必再轮询。
          stopPolling();
        }
      };
      es.onerror = (): void => {
        // EventSource 会自己重连；我们只在连续失败到上限时关掉它，其余交给它。
        if (es.readyState === EventSource.CLOSED) sseStopped = true;
        degrade();
      };
    };

    connect();
    // 首帧快照：连上就有当前真相（也覆盖「推送根本没起来」的情况）。
    startPolling();

    // 标签页从后台回来时立刻查一次：切走期间很可能错过了重建（推送也可能被浏览器挂起）。
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return;
      if (source === undefined && !sseStopped) connect();
      if (source !== undefined && source.readyState === EventSource.OPEN) return;
      startPolling();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      disposed = true;
      controller.abort();
      stopPolling();
      stopSource();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return outdated;
}
