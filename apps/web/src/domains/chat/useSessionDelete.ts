import { useCallback, useEffect, useState } from 'react';
import type { Route } from '../../app/router';
import { useToast } from '../../components/ToastProvider';
import type { GatewayClient } from '../../gateway/client';
import type { SessionInfo } from '../../gateway/types';
import { t } from '../../i18n';
import { selectionAfterDelete } from '../../state/sessions';
import type { SessionLoadOptions } from '../../stores/sessionStore';
import { useSessionStore } from '../../stores/sessionStore';
import { errorMessage } from './errors';
import { browserSessionStorage, clearLastSession, readLastSession } from './session-selection';

export interface DeleteCounts {
  live: number;
  durable: number;
  active: number;
  loading: boolean;
  error: string | null;
}

export interface UseSessionDeleteOptions {
  client: GatewayClient;
  durableFeature: boolean;
  connected: boolean;
  epoch: number;
  tenantId: string | null;
  selectedId: string | null;
  loadSessions: (client: GatewayClient, options?: SessionLoadOptions) => Promise<void>;
  navigate: (route: Route) => void;
}

/**
 * 删除会话：确认框状态、关联数据统计与提交。
 * 服务端仍会做活动 run 冲突检查；这里的计数只用于禁用主按钮与提示。
 */
export function useSessionDelete({
  client,
  durableFeature,
  connected,
  epoch,
  tenantId,
  selectedId,
  loadSessions,
  navigate,
}: UseSessionDeleteOptions) {
  const toast = useToast();
  const [deleteTarget, setDeleteTarget] = useState<SessionInfo | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteCounts, setDeleteCounts] = useState<DeleteCounts | null>(null);
  const removeSessionLocal = useSessionStore((state) => state.removeSession);

  // 删除确认前统计关联数据：消息数、live/durable runs、活动 run（服务端会拒绝删除活动会话）。
  useEffect(() => {
    if (!deleteTarget) {
      setDeleteCounts(null);
      return;
    }
    let cancelled = false;
    const sessionId = deleteTarget.session_id;
    setDeleteCounts({ live: 0, durable: 0, active: 0, loading: true, error: null });
    void (async () => {
      let live = 0;
      let active = 0;
      let durable = 0;
      let error: string | null = null;
      try {
        const runs = await client.listRuns({ session_id: sessionId });
        live = runs.length;
        active = runs.filter((run) => run.status === 'queued' || run.status === 'running').length;
      } catch (caught) {
        error = errorMessage(caught);
      }
      if (durableFeature) {
        try {
          const checkpoints = await client.listDurableRuns({ session_id: sessionId, limit: 200 });
          durable = checkpoints.length;
          active += checkpoints.filter(
            (run) => run.status === 'running' || run.status === 'interrupted',
          ).length;
        } catch {
          // durable 计数不可用不影响删除确认；服务端仍会做冲突检查。
        }
      }
      if (!cancelled) setDeleteCounts({ live, durable, active, loading: false, error });
    })();
    return () => {
      cancelled = true;
    };
  }, [deleteTarget, client, durableFeature]);

  const openDelete = useCallback((session: SessionInfo) => {
    setDeleteError(null);
    setDeleteTarget(session);
  }, []);

  const closeDelete = useCallback(() => setDeleteTarget(null), []);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    if (!connected) {
      setDeleteError(t('chat.toast.disconnectedDelete'));
      return;
    }
    if ((deleteCounts?.active ?? 0) > 0) {
      setDeleteError(t('chat.toast.activeRuns'));
      return;
    }
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const result = await client.deleteSession(deleteTarget.session_id);
      // 草稿态没有本地 session id（0.27），删除只可能在真实会话行上发生。
      const next = selectionAfterDelete(selectedId, null, deleteTarget.session_id);
      const storage = browserSessionStorage();
      if (readLastSession(storage, tenantId) === deleteTarget.session_id) {
        clearLastSession(storage, tenantId);
      }
      removeSessionLocal(deleteTarget.session_id);
      setDeleteTarget(null);
      if (next.selectedId === null && next.draftId === null) {
        navigate({ domain: 'chat', sessionId: 'new' });
      }
      toast.success(
        t('chat.toast.deleted', {
          runs: result.runs_deleted,
          events: result.events_deleted,
        }),
      );
      void loadSessions(client, { epoch, force: true });
    } catch (error) {
      const code = (error as { code?: string }).code;
      setDeleteError(code === 'conflict' ? t('chat.toast.activeRuns') : errorMessage(error));
    } finally {
      setDeleteBusy(false);
    }
  };

  return {
    deleteTarget,
    deleteBusy,
    deleteError,
    deleteCounts,
    openDelete,
    closeDelete,
    handleDelete,
  };
}
