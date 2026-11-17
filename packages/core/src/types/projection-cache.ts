/**
 * 会话投影续算的持久化端口（0.56 send-first）。
 *
 * 存在理由：`ExecutionUnit.projectionCursors` 是**进程内** Map。进程一重启（换 body /
 * 网关重启 / body rotate），游标就没了，`loadStoredHistory` 只能对时间线做**整份读**——
 * 58k 事件的会话实测 6.98–7.44 s，就落在「用户点发送 → 消息回显」这条路上，于是
 * 「重启后第一条消息」要等半分钟才出现。把游标**落盘**之后，重启后的第一次发送只需要
 * 补读尾部（~120 ms）。
 *
 * **它只是缓存，不是事实源**：读侧必须能从「日志 + 本快照」重建出与整份投影**逐条相同**
 * 的结果；任何一条判据不成立（seq 对不上 / 日志头倒退 / 尾部不连续 / 块大小读满）就丢掉
 * 快照、退回整份读并留痕。缺失 / 损坏 / 旧版本一律等价于「没有快照」。
 *
 * @module @vessel-agent/core/types
 */

import type { Message } from './provider.js';

/** 快照格式版本；不认的版本 = 没有快照。 */
export const PROJECTION_CACHE_VERSION = 1;

/**
 * 一条已折到 `seq` 的投影快照。
 *
 * 字段与 `ProjectionCursor` 一一对应（**只有** `applyClearedReplacements = false` 这一种
 * 口径会被落盘：恢复路径恒取原文，占位不许物化 —— 见 `SessionState.messages` 的注释）。
 */
export interface ProjectionCacheSnapshot {
  /** 快照格式版本（必须是 `PROJECTION_CACHE_VERSION`）。 */
  v: number;
  /** 归属会话；与请求的 session 不一致 ⇒ 不认（防止文件被挪 / id 复用）。 */
  session_id: string;
  /** 已折叠的最后一条事件的 seq（日志尾游标）。 */
  seq: number;
  /** 已折叠的事件条数。 */
  count: number;
  /** 「最后一条 assistant 正文」在 `messages` 里的下标（-1 = 没有）。 */
  last_assistant: number;
  /** 最近一次 `llm.response.usage` 的 per-request 总量。 */
  last_request_tokens?: number;
  /** 事件里出现过 `session.rewound`。 */
  rewound_seen: boolean;
  /** 折出的消息（= `projectMessages` 的产物，原文口径）。 */
  messages: Message[];
  /**
   * 与 `messages` 逐位对齐的「这条消息由哪条事件产出」的 seq（0.56 ctx-recall，additive）。
   *
   * 缺省 = 旧快照 / 老版本写的：读回来的消息**没有** seq 映射，压缩索引的
   * `unmapped_messages` 会如实计 0 段区间而不是猜一个号（宁可说「这段读不回来」）。
   * 只存数字，体积与 `messages` 同阶（真实会话 1175 条 ⇒ 十几 KB），换掉一次整份读。
   */
  message_seqs?: Array<number | null>;
  /** `tool_call_id` → `tool.call.started` 的实际 name/arguments（跨段回填要用）。 */
  tool_starts: Array<[string, { name: string; arguments: string }]>;
}

/**
 * 投影快照的读写端口（装配层按 tenant 注入；缺省 = 不持久化，行为与 0.55 相同）。
 *
 * 三条实现约束（写在类型上，实现必须自证）：
 * 1. **永不抛**：读失败返回 `undefined`，写失败只记日志 —— 它在 run 路径上，任何异常
 *    都不许影响 run（缓存丢了的代价只是下一次整份读）；
 * 2. **不参与事实判定**：读侧拿到快照后仍要用 `isContiguousTail` 那一组判据自证；
 * 3. **只存本条会话**：`clear()` 是删除会话时的收尾（孤儿文件不会被读到，但也不留渣）。
 */
export interface ProjectionCachePort {
  /** 读快照；不存在 / 损坏 / 版本不认 ⇒ `undefined`。 */
  load(sessionId: string): Promise<ProjectionCacheSnapshot | undefined>;
  /**
   * 写快照（覆盖；`payload` 是**已序列化**的 JSON）。
   *
   * 为什么收字符串而不是对象：游标里的消息对象与活动窗口**共享**（见 `ProjectionCursor`
   * 的注释），所以序列化必须在调用方**同步**完成；把一个还在被就地修改的对象图交给异步
   * 写者，会在正好下一轮 `extendProjection` 时序列化出半截视图。实现只负责「写到哪」，
   * 不解释内容（除了解析回来时校验一次）。
   */
  save(sessionId: string, payload: string): Promise<void>;
  /** 删除快照（会话被删除时）；不存在 ⇒ no-op。 */
  clear(sessionId: string): Promise<void>;
}
