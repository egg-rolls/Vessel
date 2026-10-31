import { useCallback } from 'react';
import type { ToastApi } from '../components/ToastProvider';
import { useInteractionStore } from '../stores/interactionStore';
import type { GatewayClient } from './client';
import { errorMessage } from './connection-utils';
import {
  interactionExpiredMessage,
  interactionRunEndedMessage,
  isExpiredError,
  isNotFoundError,
  isRunEndedError,
  type SubmitGuard,
} from './interactions';
import type { AskUserAnswer, PermissionScope } from './types';

interface Current<T> {
  current: T;
}

export interface InteractionResponsesDeps {
  client: GatewayClient;
  hydrateInteractions: () => Promise<void>;
  recordSettled: (requestId: string) => void;
  toast: ToastApi;
  submitGuard: Current<SubmitGuard>;
}

/** 权限 / 提问应答：同一 requestId 单次在途，失败按服务端 pending 收敛。 */
export function useInteractionResponses({
  client,
  hydrateInteractions,
  recordSettled,
  toast,
  submitGuard,
}: InteractionResponsesDeps): {
  respondPermission: (
    requestId: string,
    decision: 'allow' | 'deny',
    scope?: PermissionScope,
  ) => Promise<void>;
  respondAsk: (requestId: string, answers: AskUserAnswer[]) => Promise<void>;
} {
  const updateResponding = useCallback((requestId: string, active: boolean) => {
    useInteractionStore.getState().setResponding(requestId, active);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: submitGuard 与 useRef 一样稳定
  const respondPermission = useCallback(
    async (requestId: string, decision: 'allow' | 'deny', scope: PermissionScope = 'once') => {
      // 同一 requestId 只允许一次在途提交（双击/连点）。
      if (!submitGuard.current.begin(requestId)) return;
      updateResponding(requestId, true);
      try {
        await client.respondPermission(requestId, decision, scope);
        recordSettled(requestId);
        useInteractionStore.getState().dispatch({ type: 'settle', requestId });
      } catch (error) {
        if (isRunEndedError(error)) {
          // 点击允许时 run 已结束：明确提示，不显示“未允许”。
          recordSettled(requestId);
          useInteractionStore.getState().dispatch({ type: 'settle', requestId });
          toast.info(interactionRunEndedMessage());
          return;
        }
        if (isNotFoundError(error) || isExpiredError(error)) {
          // 服务端已丢弃 / 已过期：移除卡片并提示，不重试。
          recordSettled(requestId);
          useInteractionStore.getState().dispatch({ type: 'settle', requestId });
          toast.info(interactionExpiredMessage());
          return;
        }
        // 应答结果不确定（超时 / 连接抖动）：可能服务端已经收下并广播了 response，
        // 但本端没看到。用服务端 pending 列表收敛一次，避免卡片永久留在顶部栏。
        void hydrateInteractions();
        toast.error(errorMessage(error));
      } finally {
        submitGuard.current.end(requestId);
        updateResponding(requestId, false);
      }
    },
    [client, hydrateInteractions, recordSettled, toast, updateResponding],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: submitGuard 与 useRef 一样稳定
  const respondAsk = useCallback(
    async (requestId: string, answers: AskUserAnswer[]) => {
      if (!submitGuard.current.begin(requestId)) return;
      updateResponding(requestId, true);
      try {
        await client.respondAsk(requestId, answers);
        recordSettled(requestId);
        useInteractionStore.getState().dispatch({ type: 'settle', requestId });
      } catch (error) {
        if (isRunEndedError(error)) {
          // run 已结束：卡片失效，明确语义而不是“未作答”。
          recordSettled(requestId);
          useInteractionStore.getState().dispatch({ type: 'settle', requestId });
          toast.info(interactionRunEndedMessage());
          return;
        }
        if (isNotFoundError(error) || isExpiredError(error)) {
          recordSettled(requestId);
          useInteractionStore.getState().dispatch({ type: 'settle', requestId });
          toast.info(interactionExpiredMessage());
          return;
        }
        // 同 respondPermission：结果不确定时以服务端 pending 列表为准收敛。
        void hydrateInteractions();
        toast.error(errorMessage(error));
      } finally {
        submitGuard.current.end(requestId);
        updateResponding(requestId, false);
      }
    },
    [client, hydrateInteractions, recordSettled, toast, updateResponding],
  );

  return { respondPermission, respondAsk };
}
