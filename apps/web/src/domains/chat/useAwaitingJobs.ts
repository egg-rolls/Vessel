/**
 * 会话「等待异步任务」徽标的数据源（q-async-bash-viz C）。
 *
 * 回答「链路是停了还是在等 bash」：会话 idle（无在飞 run）但还有 running 的异步 bash
 * 作业时，徽标显示「⏳ 等待异步任务 X」。
 *
 * 零轮询：初始态读一次 `jobs.list{session_id}`（切会话 / 重连），live 更新靠时间线
 * `bash.job.started/completed/failed` 事实事件（事件只当触发器，状态由事件迁移派生）。
 * 注册表唯一真相源是服务端 basic-tools 作业表；前端只做派生视图。
 */
import { useEffect, useMemo, useState } from 'react';
import type { GatewayClient } from '../../gateway/client';
import type { StoredEvent } from '../../state/events';

interface JobSnapshotWire {
  job_id: string;
  status: 'running' | 'done' | 'failed';
  session_id?: string;
}

const JOB_EVENT_TYPES = new Set(['bash.job.started', 'bash.job.completed', 'bash.job.failed']);

export function useAwaitingJobs(opts: {
  sessionId: string | null;
  client: GatewayClient;
  epoch: number;
  entries: readonly StoredEvent[];
  enabled: boolean;
}): { count: number; jobIds: string[] } {
  const { sessionId, client, epoch, entries, enabled } = opts;
  /** 初始 running 集（jobs.list 那一次读）；带归属会话，切会话旧读数不串台。 */
  const [initial, setInitial] = useState<{
    session: string | null;
    running: ReadonlySet<string>;
  }>({ session: null, running: new Set() });

  // biome-ignore lint/correctness/useExhaustiveDependencies: epoch 是有意的重读触发器（重连补读在跑作业），不参与 effect  body
  useEffect(() => {
    if (!enabled || sessionId === null) {
      setInitial({ session: null, running: new Set() });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const body = await client.rpc<{ jobs: JobSnapshotWire[] }>('jobs.list', {
          session_id: sessionId,
        });
        if (cancelled) return;
        const running = new Set(
          (Array.isArray(body?.jobs) ? body.jobs : [])
            .filter((job) => job.status === 'running')
            .map((job) => job.job_id),
        );
        setInitial({ session: sessionId, running });
      } catch {
        // 读失败：初始态空（live 事件仍会补上在跑作业），不弹错。
        if (!cancelled) setInitial({ session: sessionId, running: new Set() });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, epoch, enabled, client]);

  return useMemo(() => {
    if (sessionId === null) return { count: 0, jobIds: [] };
    // 种子 = 初始读数（覆盖 started 事件已滚出窗口的旧作业）；再按时间线事件迁移。
    const running = new Set(initial.session === sessionId ? initial.running : []);
    for (const stored of entries) {
      const event = stored.event;
      if (!JOB_EVENT_TYPES.has(event.type)) continue;
      const data = event.data as { session_id?: unknown; job_id?: unknown };
      if (data.session_id !== sessionId || typeof data.job_id !== 'string') continue;
      if (event.type === 'bash.job.started') running.add(data.job_id);
      else running.delete(data.job_id);
    }
    const jobIds = [...running];
    return { count: jobIds.length, jobIds };
  }, [sessionId, initial, entries]);
}
