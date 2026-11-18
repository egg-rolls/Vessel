/**
 * 账号浮层的数据：**先问汇总接口，拿不到就交给调用方降级**。
 *
 * 取数时机刻意放在「第一次打开浮层」——头部栏每页都在，启动时不该多打一路 RPC；
 * `/auth/status` 也只在汇总接口确实回了策略列表时才读写（否则用 `useAuth()` 的
 * 首个后端当唯一登录动作）。
 *
 * 失败一律吞掉（不 toast、不 console.error）：降级是**预期路径**，不是错误。
 *
 * @module web/domains/auth/useAccountData
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchAuthStatus } from '../../auth/auth-client';
import { useConnection } from '../../gateway/ConnectionProvider';
import {
  type AuthSummary,
  fetchAuthSummary,
  joinLoginStrategies,
  type LoginStrategy,
  type StatusBackend,
  type SummaryFailure,
} from './auth-summary';

export type AccountDataStatus = 'idle' | 'loading' | 'ok' | 'degraded';

export interface AccountData {
  status: AccountDataStatus;
  /** 只有 `status === 'ok'` 时才可能非空；原因仅用于本地判断，不呈现给用户。 */
  failure: SummaryFailure | null;
  summary: AuthSummary | null;
  /** 汇总接口给出的策略（已补齐起步地址）；`status !== 'ok'` 时恒为空。 */
  strategies: LoginStrategy[];
  retry: () => void;
}

/** `/auth/status` 的后端清单；失败就是空数组（不重试，浮层不需要这块也能用）。 */
async function readStatusBackends(): Promise<StatusBackend[]> {
  try {
    const status = await fetchAuthStatus();
    return status.loginBackends.map((backend) => ({
      id: backend.id,
      kind: backend.kind,
      label: backend.label,
      startPath: backend.startPath,
    }));
  } catch {
    return [];
  }
}

export function useAccountData(open: boolean): AccountData {
  const { client, hasToken } = useConnection();
  const [status, setStatus] = useState<AccountDataStatus>('idle');
  const [failure, setFailure] = useState<SummaryFailure | null>(null);
  const [summary, setSummary] = useState<AuthSummary | null>(null);
  const [strategies, setStrategies] = useState<LoginStrategy[]>([]);
  const [attempt, setAttempt] = useState(0);
  /** 每次打开只取一次：关掉再开不重打（`retry` 是唯一的强制重取）。 */
  const requested = useRef(false);
  /** 世代号：切页 / 重试 / 卸载时旧请求不许落地。 */
  const generation = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt 是 retry() 的显式重取触发器（effect 内部不读它）
  useEffect(() => {
    if (!open || requested.current) return;
    requested.current = true;
    const mine = generation.current + 1;
    generation.current = mine;
    setStatus('loading');

    void (async () => {
      // 没有数据面就不可能问出汇总：直接降级，不发注定失败的请求。
      const result = hasToken
        ? await fetchAuthSummary((method, params) => client.rpc(method, params))
        : ({ kind: 'degraded', failure: 'unreachable' } as const);
      if (generation.current !== mine) return;

      if (result.kind === 'degraded') {
        setFailure(result.failure);
        setSummary(null);
        setStrategies([]);
        setStatus('degraded');
        return;
      }

      const backends: StatusBackend[] =
        result.summary.backends.length === 0 ? [] : await readStatusBackends();
      if (generation.current !== mine) return;
      setFailure(null);
      setSummary(result.summary);
      setStrategies(joinLoginStrategies(result.summary.backends, backends));
      setStatus('ok');
    })();
  }, [open, hasToken, client, attempt]);

  useEffect(() => {
    return () => {
      // 卸载后落地就是「在已消失的组件上 setState」。
      generation.current += 1;
    };
  }, []);

  const retry = useCallback(() => {
    requested.current = false;
    setAttempt((value) => value + 1);
  }, []);

  return { status, failure, summary, strategies, retry };
}
