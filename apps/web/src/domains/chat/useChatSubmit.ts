import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Route } from '../../app/router';
import { useToast } from '../../components/ToastProvider';
import type { GatewayClient } from '../../gateway/client';
import type { NodeView } from '../../gateway/NodeProvider';
import type { TeamControl } from '../../gateway/team-control';
import { t } from '../../i18n';
import type { EventStoreSnapshot } from '../../state/event-store';
import type { SessionLoadOptions } from '../../stores/sessionStore';
import { errorMessage } from './errors';
import { type StartInNewAgentResult, startInNewAgent } from './new-session';
import type { QueuedSubmission } from './StreamItems';

const QUEUE_POLL_MS = 2000;

export interface UseChatSubmitOptions {
  client: GatewayClient;
  connected: boolean;
  selectedId: string | null;
  epoch: number;
  navigate: (route: Route) => void;
  snapshot: EventStoreSnapshot;
  loadSessions: (client: GatewayClient, options?: SessionLoadOptions) => Promise<void>;
  loadRoster: (
    nodes: readonly NodeView[],
    teamControl: (node: NodeView) => TeamControl,
  ) => Promise<void>;
  nodes: readonly NodeView[];
  teamControl: (node: NodeView) => TeamControl;
  pendingNewSessions: { current: Set<string> };
}

/**
 * 提交 / 中断 / 排队：输入框状态、queued 占位卡片轮询、取消与终态清理。
 * 事件流接管后移除占位卡片；轮询节奏与取消语义与原 ChatView 一致。
 */
export function useChatSubmit({
  client,
  connected,
  selectedId,
  epoch,
  navigate,
  snapshot,
  loadSessions,
  loadRoster,
  nodes,
  teamControl,
  pendingNewSessions,
}: UseChatSubmitOptions) {
  const toast = useToast();
  const [input, setInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [queuedRuns, setQueuedRuns] = useState<QueuedSubmission[]>([]);
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());
  const [cancelledJobs, setCancelledJobs] = useState<Set<string>>(new Set());
  const queuedRef = useRef(queuedRuns);
  queuedRef.current = queuedRuns;

  const seenJobIds = useMemo(
    () =>
      new Set(
        snapshot.entries
          .map((entry) => entry.jobId)
          .filter((jobId): jobId is string => Boolean(jobId)),
      ),
    [snapshot.entries],
  );

  // 排队位置没有推送事件：只轮询未取消的排队卡片。
  useEffect(() => {
    if (!queuedRuns.some((item) => !item.cancelled)) return;
    const id = window.setInterval(() => {
      for (const item of queuedRef.current) {
        if (item.cancelled) continue;
        client
          .getRunStatus(item.runId)
          .then((runStatus) => {
            setQueuedRuns((prev) => {
              const current = prev.find((entry) => entry.runId === item.runId);
              if (!current || current.cancelled) return prev;
              if (runStatus.status === 'queued') {
                const sessionId = current.sessionId ?? runStatus.session_id;
                if (
                  current.queuePosition === runStatus.queue_position &&
                  current.sessionId === sessionId
                ) {
                  return prev;
                }
                return prev.map((entry) =>
                  entry.runId === item.runId
                    ? {
                        ...entry,
                        ...(runStatus.queue_position !== undefined
                          ? { queuePosition: runStatus.queue_position }
                          : {}),
                        ...(sessionId ? { sessionId } : {}),
                      }
                    : entry,
                );
              }
              if (runStatus.status === 'cancelled') {
                return prev.map((entry) =>
                  entry.runId === item.runId
                    ? { ...entry, cancelling: false, cancelled: true }
                    : entry,
                );
              }
              return prev.filter((entry) => entry.runId !== item.runId);
            });
          })
          .catch(() => {
            // 位置未知时保留卡片，不把轮询失败升级成全局错误。
          });
      }
    }, QUEUE_POLL_MS);
    return () => window.clearInterval(id);
  }, [queuedRuns, client]);

  // 事件流接管后移除排队占位卡片。
  useEffect(() => {
    setQueuedRuns((prev) => prev.filter((item) => !seenJobIds.has(item.runId)));
  }, [seenJobIds]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || submitting || !connected) return;
    // 0.28（CONTRACT §3）：草稿态 = 一个新 agent。先 `agents.create`（只给客户端生成的
    // 唯一名）拿 `{id, session_id}`，再 `runs.start{agent_id}`；`runs.start` 失败时
    // best-effort 回收，不留空 agent。选中已有会话时按 session 投递，行为不变。
    const targetSessionId = selectedId;
    setSubmitting(true);
    try {
      let nextSessionId: string | undefined;
      let run: StartInNewAgentResult['run'];
      if (targetSessionId) {
        run = await client.submitRun(text, targetSessionId);
        nextSessionId = targetSessionId;
      } else {
        const started = await startInNewAgent(
          {
            createAgent: (agentInput) => client.createAgent(agentInput),
            closeAgent: (agentId) => client.closeAgent(agentId),
          },
          (agentInput, sessionId, agentId) => client.submitRun(agentInput, sessionId, agentId),
          text,
        );
        run = started.run;
        nextSessionId = started.sessionId;
      }
      if (!nextSessionId) {
        // 契约要求 runs.start 回填 session_id；缺失时停下，不本地兜底。
        throw new Error('runs.start returned no session_id');
      }
      // 新会话可能尚未落盘：标记后 detail 404 可容忍（会话出现在列表即失效）。
      if (!targetSessionId) pendingNewSessions.current.add(nextSessionId);
      setInput('');
      if (!targetSessionId) navigate({ domain: 'chat', sessionId: nextSessionId });
      if (run.status === 'queued' && !seenJobIds.has(run.run_id)) {
        const queuedSessionId = run.session_id ?? nextSessionId;
        setQueuedRuns((prev) => [
          ...prev.filter((item) => item.runId !== run.run_id),
          {
            runId: run.run_id,
            ...(queuedSessionId ? { sessionId: queuedSessionId } : {}),
            input: text,
            ...(run.queue_position !== undefined ? { queuePosition: run.queue_position } : {}),
            submittedAt: Date.now(),
            cancelling: false,
            cancelled: false,
          },
        ]);
        toast.info(t('chat.toast.queued'));
      }
      void loadSessions(client, { epoch, force: true });
      // 新会话建了新 agent：roster（会话行的 agent 地址）要立刻反映它。
      if (!targetSessionId) void loadRoster(nodes, teamControl);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  // 引用保持稳定：memo(RunItems) 依赖这几个回调，避免每个 token 让全部实时项重渲染。
  const handleCancel = useCallback(
    async (group: { jobId?: string }) => {
      const jobId = group.jobId;
      if (!jobId) return;
      setCancelling((prev) => new Set(prev).add(jobId));
      try {
        const result = await client.cancelRun(jobId);
        if (result.cancelled) {
          setCancelledJobs((prev) => new Set(prev).add(jobId));
          toast.success(t('chat.toast.cancelRequested'));
        }
      } catch (error) {
        toast.error(errorMessage(error));
      } finally {
        setCancelling((prev) => {
          const next = new Set(prev);
          next.delete(jobId);
          return next;
        });
      }
    },
    [client, toast],
  );

  const handleCancelQueued = async (runId: string) => {
    setQueuedRuns((prev) =>
      prev.map((item) => (item.runId === runId ? { ...item, cancelling: true } : item)),
    );
    try {
      const result = await client.cancelRun(runId);
      if (result.cancelled) {
        setQueuedRuns((prev) =>
          prev.map((item) =>
            item.runId === runId ? { ...item, cancelling: false, cancelled: true } : item,
          ),
        );
        toast.success(t('chat.toast.queueCancelled'));
        window.setTimeout(() => {
          setQueuedRuns((prev) => prev.filter((item) => item.runId !== runId));
        }, 4000);
      } else {
        setQueuedRuns((prev) =>
          prev.map((item) => (item.runId === runId ? { ...item, cancelling: false } : item)),
        );
        toast.error(t('chat.toast.cancelNotAccepted'));
      }
    } catch (error) {
      setQueuedRuns((prev) =>
        prev.map((item) => (item.runId === runId ? { ...item, cancelling: false } : item)),
      );
      toast.error(errorMessage(error));
    }
  };

  return {
    input,
    setInput,
    submitting,
    queuedRuns,
    cancelling,
    cancelledJobs,
    handleSend,
    handleCancel,
    handleCancelQueued,
  };
}
