/**
 * Session 类型定义
 * @module @vessel-agent/core/session
 */

import type { CompactionIndexEntry } from '../context/compaction-index.js';
import type { ContextAnchor, PromptContextFingerprint } from './context.js';
import type { ContextProjectionAudit, ProjectionDeclaration } from './projection.js';
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
 * `messages` / `projection_cache_seq`（旧名 `derived_upto_seq`）/ `status` / `last_run_id`
 * 都是派生数据，唯一真相源是 `SessionEventLog`；`legacy_run` 仅用于一版旧数据兼容。
 * 0.54 B3 起 `messages` 与那个 seq 都只是**缓存**：投影不读它们做判定。
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
  /**
   * 派生投影缓存（原文视图）；真相是 `SessionEventLog`。
   *
   * **语义（0.54）：原文视图 —— 这里不允许出现清集替换的占位正文
   * （`isClearedToolResult(content)` 为真的 tool 消息）。** 它由事件日志重建
   * （`projectMessages(events, { applyClearedReplacements: false })`）或按
   * 「缓存 + 增量」拼出来，是**事实**的一份可重建快照；占位是「模型这一轮看到什么」的
   * **视图**，只存在于请求视图（`withClearedToolResults`）与 UI 的派生投影
   * （`sessions.get.session.messages[i].projection`）里。
   *
   * 为什么写进类型注释：0.54 之前满投影会在这里落成占位（`projectMessages` 默认行为），
   * 一旦落盘就**粘住** —— `derived_upto_seq` 越过压缩事件，之后每次重启走增量、增量里
   * 就是占位，原文只剩事件日志（实测 `docs/dev/reports/0.54/proj-readback-15.md` §1.7）。
   * 想省 token 就改请求视图，**不要**改这个字段的正文。
   */
  messages?: Message[];
  /**
   * **缓存覆盖到哪**的提示（0.54 B3 改名自 `derived_upto_seq`）。
   *
   * 语义只有一条：`messages` 这份缓存大概覆盖到 `seq ≤ projection_cache_seq`。
   * 它**不是**事实水位、**不表示**「事实已重建到这个 seq」，**不许**参与任何
   * 可见性 / 发布 / 覆盖判定（ADR-105 R2）。投影的真输入恒为事件日志整份
   * （`loadStoredHistory` ⇒ `projectMessages` + `reconcileCachedProjection`），
   * 所以删掉这个字段、或者把它写成一个错的值，投影输出必须**逐字节不变**
   * （门禁：`scripts/check-projection-cache-agnostic.ts`）。
   */
  projection_cache_seq?: number;
  /**
   * @deprecated 0.54 B3：旧名字，读侧当 `projection_cache_seq` 的**别名**；写侧仍然镜像
   * 一份（值相同），让只认旧名字的读者（wire / migrate / 旧版本的 core）继续能读到。
   * 新代码请写 `projection_cache_seq`。
   */
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
  /**
   * 会话级上下文投射**声明**（0.53 U1，additive；ADR-104 §4.6）。
   *
   * 会话创建时写一次、之后不可变（同一 `mode` 重复声明幂等，不同 `mode` 抛
   * `projection_mode_immutable`）。缺省 = 旧会话 / 还没声明 ⇒ 读侧按
   * `{ mode: 'placeholder', source: 'legacy' }` 解析（`resolveProjection`）。
   *
   * 0.53 U1 **只声明不改行为**：没有任何运行路径读它去裁剪窗口，所以缺省与有值
   * 的会话行为完全一致（都是现在的 `placeholder` 行为）。接线是 U2 的事。
   */
  context_projection?: ProjectionDeclaration;
  /**
   * 最近一次投射决策的审计行（0.53 U1 只声明字段与落盘位置；ADR-104 §5.1）。
   *
   * 写入者是 U2 的运行时（每次重新解析 / 降级时覆盖成最新一条）。本单元不产生
   * 审计行 ⇒ 缺省 = 还没有任何决策记录。
   */
  context_projection_audit?: ContextProjectionAudit | null;
  /**
   * 压缩索引（0.56 ctx-recall，additive）：这条会话每一段压缩各一条，按
   * `compaction_id` 升序累积，**不覆盖历史**。
   *
   * 与事件的 `context.compacted.data.compaction` **同一份内容**（事件是事实源，这里是
   * 缓存：重启后运行时不扫日志也知道 stub 里该列哪几段、下一个 id 是几）。缺省 = 老会话 /
   * 还没压缩过 —— 读侧据此说「这段会话没有压缩索引」，不编。
   */
  compactions?: CompactionIndexEntry[];
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
  /**
   * 会话**存在**吗？（可选；0.56：存在性校验别再 `load()` 整份会话壳）
   *
   * 只需要「在 / 不在」的调用方（`sessions.events` / `sessions.compact` 这类先确认会话
   * 存在再按会话 id 干活的路径）用它。文件后端实现成**一次 `stat`**：1.8 MB 的壳 parse
   * 一次在长寿进程里实测 ~230 ms，而存在性只值一次 stat。
   *
   * 口径与 {@link load} 的 `null` 分支一致（主路径与 legacy 路径都不在 ⇒ false）。没实现
   * 的后端由调用方退回 `load() !== null`。
   *
   * **已知差别**：壳存在但内容损坏时，`load()` 抛 `SessionCorruptError`，而 `exists()`
   * 只说「在」。所以需要壳的路径**必须**继续走 `load()`（别为了快改成 exists），
   * 只有「不读壳也要干活」的路径才该用它。
   */
  exists?(sessionId: string): Promise<boolean>;
  /**
   * 读一侧的会话壳快照（可选；0.56：`sessions.get` 的固定开销别再每次 parse 1.8 MB）
   *
   * 与 {@link load} 的返回**逐字段相同**（同一个 `toSessionState`、同一份 tenant 判定、
   * 同样的 `SessionCorruptError`），区别只在**生命周期**：实现方可以按
   * (路径, size, mtime) 短路复用上一次 parse 出来的对象，于是「同一份壳被读 N 次」
   * 只 parse 一次。mtime/size 变了就自然重读，没有 TTL、没有手工失效。
   *
   * **契约**：返回给调用方的是**共享只读快照** —— 不许改字段、不许 push/splice
   * `messages`、不许给 message 挂属性。要写（rename / compact / fork 之后 save 之类）
   * **必须**走 `load()` 拿独占对象。实现方应当把它冻结，让误写当场炸而不是悄悄污染缓存。
   */
  loadForRead?(sessionId: string): Promise<SessionState | null>;
  close?(): void;
}
