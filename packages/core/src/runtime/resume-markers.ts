/**
 * 「已武装的续跑标记」注册表（0.52 S1a，进程优雅退出）。
 *
 * 纯内存、零 IO：退出路径的预算是 2s，这里不许有任何 await / 磁盘访问。
 * 真正的落盘在 RunJournal.saveSessionState（单写口），本模块只提供
 * 「哪个会话要续跑」这一层去重与快照。
 *
 * 为什么不直接写进 SessionState 了事：settle 期间被打断的 run 会落终态会话状态，
 * 它用自己那份投影重建整份 state（读点可能早于标记），会把标记覆盖掉。所以标记
 * 额外挂在 journal 侧合并，保证任何一次状态保存都带着它。
 *
 * @module @vessel-agent/core/runtime
 */

import type { ResumeAfterRestart, ResumeMarkerRegistry } from '../types/session.js';

/** 注册表本体：只读契约（ResumeMarkerRegistry）+ 退出路径专用的武装入口。 */
export interface ResumeMarkerRegistryState extends ResumeMarkerRegistry {
  /**
   * 武装一条标记。
   *
   * **可重入**：同会话重复武装保留第一次的 run_id / interrupted_at（首告即真），
   * 只把 pending_input_ids / background_stopped 更新成最新观测。
   * 返回最终生效的那条（不是本次传入的那条）。
   */
  arm(sessionId: string, marker: ResumeAfterRestart): ResumeAfterRestart;
  /** 卸掉一条（探针 / 失败回退用；退出路径本身不需要）。 */
  clear(sessionId: string): boolean;
}

/** 拷贝一条标记，防止调用方后续改动污染注册表 / 落盘内容。 */
function copyMarker(marker: ResumeAfterRestart): ResumeAfterRestart {
  return {
    run_id: marker.run_id,
    interrupted_at: marker.interrupted_at,
    reason: marker.reason,
    pending_input_ids: [...marker.pending_input_ids],
    background_stopped: marker.background_stopped,
  };
}

/**
 * 建一个注册表。
 *
 * 每个 tenant runtime 一份（与 RunJournalFactory 同寿命），进程退出即丢。
 */
export function createResumeMarkerRegistry(): ResumeMarkerRegistryState {
  const markers = new Map<string, ResumeAfterRestart>();
  return {
    get(sessionId) {
      return markers.get(sessionId);
    },
    size() {
      return markers.size;
    },
    entries() {
      return [...markers.entries()];
    },
    arm(sessionId, marker) {
      const current = markers.get(sessionId);
      const next =
        current === undefined
          ? copyMarker(marker)
          : {
              ...current,
              pending_input_ids: [...marker.pending_input_ids],
              background_stopped: marker.background_stopped && current.background_stopped,
            };
      markers.set(sessionId, next);
      return next;
    },
    clear(sessionId) {
      return markers.delete(sessionId);
    },
  };
}

/**
 * 把已武装的标记合并进一份会话状态。
 *
 * 就地修改传入的状态对象（journal 侧就是这么用的：state 马上就要落盘）。
 * 没武装 ⇒ 原样返回，行为与 0.51 一致。
 */
export function applyArmedResumeMarker(
  state: { session_id: string; resume_after_restart?: ResumeAfterRestart },
  registry: ResumeMarkerRegistry | undefined,
): void {
  if (registry === undefined) return;
  const marker = registry.get(state.session_id);
  if (marker === undefined) return;
  state.resume_after_restart = copyMarker(marker);
}
