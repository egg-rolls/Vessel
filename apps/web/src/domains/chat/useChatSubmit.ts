import { type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Route } from '../../app/router';
import { useToast } from '../../components/ToastProvider';
import type { GatewayClient } from '../../gateway/client';
import type { NodeView } from '../../gateway/NodeProvider';
import type { TeamControl } from '../../gateway/team-control';
import { t } from '../../i18n';
import type { EventStoreSnapshot } from '../../state/event-store';
import { startedRunIds } from '../../state/events';
import {
  chatDraftKey,
  useComposerDraftStore,
  useComposerDraftText,
} from '../../stores/composerDraftStore';
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
  /** 草稿按会话分槽（`chat:new` = 草稿态）：切到别的会话再回来，正文还在。 */
  const draftKey = chatDraftKey(selectedId);
  const input = useComposerDraftText(draftKey);
  const writeDraft = useComposerDraftStore((state) => state.setText);
  // 读和写共用 `chatDraftKey`：key 只由「当前会话」决定，不再看 `window.location.hash`。
  // 早先写入按实时 hash 定位（为了 edit / 重发回填），于是 `navigate()` 与 `hashchange`
  // 之间那一拍写下的字会落到另一个槽，用户看到的输入框与真实存的槽不是同一个。
  // 需要「写到即将切换过去的会话」的调用方（sessions.create 的 edit / 重发）显式用
  // `setInputForSession`，key 依旧只由 `chatDraftKey` 决定。
  const setInputForSession = useCallback(
    (sessionId: string | null, value: SetStateAction<string>) => {
      writeDraft(chatDraftKey(sessionId), value);
    },
    [writeDraft],
  );
  const setInput = useCallback(
    (value: SetStateAction<string>) => writeDraft(draftKey, value),
    [writeDraft, draftKey],
  );
  const [submitting, setSubmitting] = useState(false);
  const [queuedRuns, setQueuedRuns] = useState<QueuedSubmission[]>([]);
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());
  const [cancelledJobs, setCancelledJobs] = useState<Set<string>>(new Set());
  const queuedRef = useRef(queuedRuns);
  queuedRef.current = queuedRuns;

  // 只有 `run.started` 表示事件流已接管；`agent.queue.entered` 在排队时就会到，
  // 把它当成接管信号会让占位卡片只闪一下（0.30 回归 F3）。
  const startedRuns = useMemo(() => startedRunIds(snapshot.entries), [snapshot.entries]);

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

  // 事件流接管（run 真正开始）后移除排队占位卡片。
  // 快照每 50ms 变一次，但队列通常是空的：没有要移除的卡片时返回同一个引用，
  // 避免每帧都提交一次渲染（流式时聊天子树会因此 20–40 次/秒重渲）。
  useEffect(() => {
    setQueuedRuns((prev) => {
      const next = prev.filter((item) => !startedRuns.has(item.runId));
      return next.length === prev.length ? prev : next;
    });
  }, [startedRuns]);

  /**
   * 提交一段文本（发送与重试共用）：草稿态建新 agent，已有会话按 session 投递。
   * `sessionIdOverride` 用于 edit / retry：新 session 已由 `sessions.create` 建好，
   * 但当前路由还没切过去，不能依赖 `selectedId`。
   * 返回是否成功发起，供调用方决定是否给出「已重新发起」之类反馈。
   */
  const submitText = async (raw: string, sessionIdOverride?: string): Promise<boolean> => {
    const text = raw.trim();
    if (!text || submitting || !connected) return false;
    // 源槽在 await 之前取：发送期间用户可能已经切走会话。
    // key 与读取同源（`chatDraftKey`）：普通发送 = 当前会话；edit / 重试的正文是
    // `setInputForSession(nextSessionId, …)` 回填到目标会话槽的，清空的也是那一槽。
    const sourceKey = chatDraftKey(sessionIdOverride ?? selectedId);
    // 0.28（CONTRACT §3）：草稿态 = 一个新 agent。先 `agents.create`（只给客户端生成的
    // 唯一名）拿 `{id, session_id}`，再 `runs.start{agent_id}`；`runs.start` 失败时
    // best-effort 回收，不留空 agent。选中已有会话时按 session 投递，行为不变。
    const targetSessionId = sessionIdOverride ?? selectedId;
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
      // 只在源草稿仍是被提交的文本时清空：重试不应吞掉用户新写的草稿。
      writeDraft(sourceKey, (current) => (current.trim() === text ? '' : current));
      if (!targetSessionId) navigate({ domain: 'chat', sessionId: nextSessionId });
      if (run.status === 'queued' && !startedRuns.has(run.run_id)) {
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
      return true;
    } catch (error) {
      toast.error(errorMessage(error));
      return false;
    } finally {
      setSubmitting(false);
    }
  };

  const handleSend = async () => {
    await submitText(input);
  };

  /** 重试：把用户内容提交到指定 session（默认当前会话）。 */
  const handleRetry = async (text: string, sessionId?: string) => {
    await submitText(text, sessionId);
  };

  // 引用保持稳定：memo(RunItems) 依赖这几个回调，避免每个 token 让全部实时项重渲染。
  const handleCancel = useCallback(
    async (group: { runId: string }) => {
      // 取消只认真实 run id。`jobId` 是事件帧的 run_id，成员事件上它是成员 id，
      // 对新会话恰好等于 session id —— 用它取消会得到 not_found（F2）。
      const runId = group.runId;
      if (!runId) return;
      setCancelling((prev) => new Set(prev).add(runId));
      try {
        const result = await client.cancelRun(runId);
        if (result.cancelled) {
          setCancelledJobs((prev) => new Set(prev).add(runId));
          toast.success(t('chat.toast.cancelRequested'));
        }
      } catch (error) {
        toast.error(errorMessage(error));
      } finally {
        setCancelling((prev) => {
          const next = new Set(prev);
          next.delete(runId);
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
    /** 回填到指定会话的草稿槽（sessions.create 的 edit / 重发在 navigate 之后立刻用）。 */
    setInputForSession,
    submitting,
    queuedRuns,
    cancelling,
    cancelledJobs,
    handleSend,
    handleRetry,
    handleCancel,
    handleCancelQueued,
  };
}
