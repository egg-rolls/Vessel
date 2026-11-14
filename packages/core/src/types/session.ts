/**
 * Session 类型定义
 * @module @vessel-agent/core/session
 */

import type { ContextAnchor, PromptContextFingerprint } from './context.js';
import type { Message } from './provider.js';
import type { RunUsage } from './run-record-store.js';

/** 会话状态（最近一次 RunRecord 的派生快照；真相源是 SessionEventLog） */
export type SessionStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

/**
 * How the stored title came to be (additive; see docs/architecture/gateway-rpc.md).
 *
 * - manual: a human (or the rotate title parameter) named it on purpose;
 *   automatic naming must never overwrite it.
 * - generated: the AI titler wrote it; later automatic passes may still update it.
 * - missing: 0.x data with no marker. Falls back to the legacy heuristic
 *   ("title differs from deriveSessionMeta"), so old sessions never need a migration.
 */
export type SessionTitleSource = 'manual' | 'generated';

/** @internal 一版兼容：旧 session JSON/sqlite 顶层 run 字段的合成投影。 */
export interface LegacyRunSnapshot {
  completed_at?: number;
  usage?: RunUsage;
  error?: string;
}

/**
 * 会话壳（元数据 + messages 投影缓存）。
 *
 * `messages` / `derived_upto_seq` / `status` / `last_run_id` 都是派生数据，
 * 唯一真相源是 `SessionEventLog`；`legacy_run` 仅用于一版旧数据兼容。
 */
export interface SessionState {
  session_id: string;
  title?: string;
  /**
   * Source marker for title (additive; optional so old JSON / rows stay valid).
   * Missing = legacy session: readers keep the pre-0.x heuristic.
   */
  title_source?: SessionTitleSource;
  preview?: string;
  created_at: number;
  updated_at: number;
  created_on_branch?: string;
  /** Projection cache only; truth is SessionEventLog. */
  messages?: Message[];
  derived_upto_seq?: number;
  /** Derived snapshot of the latest RunRecord; NOT truth. */
  status?: SessionStatus;
  /** Derived pointer to the latest run; NOT truth. */
  last_run_id?: string;
  /** @internal one-release legacy compatibility snapshot (dual-write/read). */
  legacy_run?: LegacyRunSnapshot;
  /**
   * 真实 token 锚点（additive，0.52 C）。
   *
   * 缺省 = 旧会话 / 还没拿到过 provider 的 `prompt_tokens`，行为与 0.51 一致（裸估算）。
   * 它只校正**估算**（展示与阈值判断）；provider 的真实用量到达后仍然真实值优先。
   */
  context_anchor?: ContextAnchor;
  /**
   * 环境快照（上下文卡）的发布指纹（0.52，additive）。
   *
   * 存在的理由：`ExecutionUnit.lastSystemContext` 是纯内存去重，重启就没了 ⇒ 每次重启后
   * 下一条消息必然重发一张全量「上下文」卡。把指纹随 session 落盘，重启后 seed 恢复，
   * 才能做到「没有实质变化就不发」（用户 2026-11-13 报的问题）。
   */
  prompt_context?: PromptContextFingerprint;
  /**
   * 「下次启动续跑」标记（0.52 S1a，additive）。
   *
   * 缺省 = 没有被优雅打断过 / 旧数据，行为与 0.51 一致（启动不续跑任何东西）。
   * 只在**该会话此刻有在跑 run**时由 node 退出路径写入；写完何时清空是 S1c 的事。
   */
  resume_after_restart?: ResumeAfterRestart;
  /**
   * 本段冻结的「工具结果占位」集合（0.52 V1，additive）。
   *
   * 存在的理由：请求视图要把旧工具结果换成占位符省 token（落盘历史一个字不改），而
   * **清哪些**一旦按当前 messages 每轮重算，窗口就整体右移一条 ⇒ 同一段内每轮多清一条，
   * 请求前缀每轮变一次。所以集合在**段起点**算一次、随 session 落盘，请求期只读；
   * `pop`（回退 / 分支切换）之后基准重置，下一个段起点按新基准重算并覆盖本字段。
   *
   * 缺省 = 旧会话 / 这一段还没做过占位决策，行为与 0.51 一致（请求视图与落盘逐字一致）。
   */
  cleared_tool_call_ids?: string[];
}

/**
 * 「上次是进程优雅退出、下次启动要接着跑」的续跑标记（0.52 S1a，additive）。
 *
 * 什么时候写：只有**这条会话此刻确实有在跑 run**时，node 退出路径才写一条；
 * 没有在跑 run 的会话一条都不写（S1a 不为静止会话预打标记）。
 *
 * 谁读：启动侧恢复（S1c）。S1a 只负责把它写进 SessionState 并落盘——走
 * RunJournal 单写口（SessionState 的硬规则：状态写入只经 journal）。
 *
 * reason 是封闭联合：目前只有 shutdown（进程退出）。gateway restart **不写**标记
 * （handoff 已合：重启保留 node/hub，run 根本不中断）。
 */
export interface ResumeAfterRestart {
  /** 被打断的那次 run（Run.runId，与 RunRecord / 事件日志同一口径）。 */
  run_id: string;
  /** 打断时刻（epoch ms）。 */
  interrupted_at: number;
  reason: 'shutdown';
  /**
   * 该会话名下仍在 durable inbox 里、尚未被消费的条目 id（unread + held）。
   *
   * 只是**清单**：S1a 不改动这些条目（不删、不推进），S1c 用它对账
   * recoverPendingInputs() 找到的输入。取不到时为 []，此时以 inbox 自身为准。
   */
  pending_input_ids: string[];
  /**
   * 退出时是否**强制停掉**了后台进程（长命令 / 后台任务）。
   *
   * S1a **不**做后台清理（退出路径不许 await 它们）⇒ 一律 false。
   * 留这个字段是为了让 S1c 能区分「标记真的完整」与「后台被砍过」。
   */
  background_stopped: boolean;
}

/**
 * 进程内「已武装的续跑标记」注册表（0.52 S1a）。
 *
 * 存在的理由是一个真实竞态：drain 先写标记，随后被打断的 run 落**终态**会话状态时
 * 会用自己那份投影重建整份 SessionState（可能读于标记之前），于是标记被覆盖。
 * 把标记留在这里，任何一次 journal.saveSessionState() 都把它合并回去。
 *
 * 进程内、只增：只由退出路径武装，进程随后就没了，不需要（也不该）跨进程持久化。
 */
export interface ResumeMarkerRegistry {
  get(sessionId: string): ResumeAfterRestart | undefined;
  /** 已武装的会话数（探针 / 日志用）。 */
  size(): number;
  /** 已武装的 [session_id, marker] 快照（只读语义）。 */
  entries(): ReadonlyArray<readonly [string, ResumeAfterRestart]>;
}

/** 会话摘要（listRich 返回，照搬 Hermes list_sessions_rich 的字段集，简化） */
export interface SessionInfo {
  session_id: string;
  title: string;
  preview: string;
  status: string;
  started_at: number;
  updated_at: number;
  message_count: number;
  /** 会话创建时的 git branch */
  branch?: string;
  /**
   * Source marker for the stored title (additive). 缺失 = 旧数据 / AI 尚未命名，
   * 读取方按「无标记」处理，不做派生猜测。
   */
  title_source?: SessionTitleSource;
}

/** Session 元数据存储 port（只收发 SessionState；不含事件日志） */
export interface SessionStore {
  load(sessionId: string): Promise<SessionState | null>;
  save(state: SessionState): Promise<void>;
  delete(sessionId: string): Promise<void>;
  list(): Promise<string[]>;
  /** 列出会话摘要（含 title/preview/updated_at/message_count），按 recency 倒序，过滤空会话 */
  listRich(): Promise<SessionInfo[]>;
  close?(): void;
}
