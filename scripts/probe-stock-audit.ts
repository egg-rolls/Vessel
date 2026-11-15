#!/usr/bin/env bun
/**
 * probe-stock-audit.ts — 存量体检（只读探针；不属于 gates，不接 package.json）
 *
 * 问题：真实会话里「工具结果正文已经是 `[cleared ...]` 占位」的规模有多大？能救多少？
 * 与撤回（`session.rewound`）有多相关？
 *
 * 口径（与 `docs/dev/reports/0.54/stock-audit.md` 同一份定义）：
 *
 * - **占位**：`SessionState.messages`（= `sessions.get` 的取数来源）里 `role === 'tool'`
 *   且 `isClearedToolResult(content)` 为真 —— 用产品自己的判定函数，不自己写前缀比较。
 * - **清集（clearset）**：日志里 `message.compaction` 事件的 `data.cleared_tool_call_ids`
 *   （0.34 S1 起由 runtime 写入；旧事件没有这个字段）。这是**规格口径**。
 *   探针另外统计 `context.cleared_tool_result` 事件的 `data.tool_call_ids`（0.52 起的
 *   trim 审计事件），只作为**加宽口径**单独列字段，不混进 `rescuable`。
 * - **全文**：日志里该 `tool_call_id` 的 `tool.call.completed.data.result`（最后一条胜出）。
 *
 * 四象限（有清集 × 有全文）：
 *
 * |            | 有全文                | 无全文                       |
 * | ---------- | --------------------- | ---------------------------- |
 * | **有清集** | `rescuable`（规格口径） | `unrescuable_no_original` 之一 |
 * | **无清集** | `unrescuable_no_clearset` 之一 | `both_missing` 之一     |
 *
 * `unrescuable_no_clearset` / `unrescuable_no_original` 按规格是**单边谓词**，
 * 会在「两者都没有」那一格重叠；所以另给 `both_missing`，四格相加 == 参与判定的占位条数。
 *
 * 只读：只调 `FileSessionStore.load()`（纯读）、`SessionEventLog.read()` / `readIndex()`
 * （纯读）、`readdir` / `stat` / `open(...,'r')`；**不调 `list()`**（内部 `ensureDir()`
 * 会 mkdir）、不 append、不 updateIndex、不 touch 任何文件。数据目录一个字节都不写。
 *
 * 用法：
 *   bun run scripts/probe-stock-audit.ts --sessions <data 目录下的 sessions 目录>
 *
 * stdout = 每会话一行 JSON；stderr = 聚合摘要（四象限 / Top 10 / 异常分类）。
 */

import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  FileSessionStore,
  isClearedToolResult,
  type Message,
  SessionEventLog,
  type SessionEventRecord,
} from '../packages/core/src/index';

/** 事件分页大小：单次 `read()` 最多拿这么多条，处理完即丢，累计状态只留聚合量。 */
const PAGE = 2000;

/** 单会话一行的输出形状。 */
interface Row {
  session: string;
  status: 'ok' | 'shell_missing' | 'shell_corrupt' | 'shell_no_messages';
  messages_total: number;
  tool_messages: number;
  /** 占位消息里没有 `tool_call_id`（无法与日志关联）的条数。 */
  placeholder_without_id: number;
  placeholder_tool_messages: number;
  rescuable: number;
  unrescuable_no_clearset: number;
  unrescuable_no_original: number;
  both_missing: number;
  /** 加宽口径下可救（`context.cleared_tool_result` 也算清集）+ 有全文。 */
  rescuable_wide: number;
  /** 只按 tool_call_id 关联日志、不看清集（= 修复脚本真正的回收上限）。 */
  salvageable: number;
  rewound: number;
  compactions: number;
  /** `rescuable` 集合的原文字节总和（规格口径；本仓存量上通常为 0）。 */
  recoverable_bytes: number;
  /** `salvageable` 集合的原文字节总和（修复脚本真正能拿回的字节）。 */
  salvageable_bytes: number;
  clearset_ids_compaction: number;
  clearset_ids_trim_events: number;
  /** 会话壳里冻结的 `SessionState.cleared_tool_call_ids` 条数（本段占位集合）。 */
  shell_frozen_clearset_ids: number;
  events_total: number;
  max_seq: number;
  derived_upto_seq: number | null;
  /** 异常计数；全部显式列出，不静默丢弃。 */
  anomalies: {
    /** 日志末尾没有换行（写崩溃留下的残行）。 */
    partial_tail: number;
    /** seq 空洞（`max_seq - events_total`；中间有坏行 / 丢行）。 */
    seq_gaps: number;
    /** `index.json` 缺失。 */
    index_missing: number;
    /** `index.event_count` 与实测条数不一致。 */
    index_count_mismatch: number;
    /** 占位 id 在日志里只有 started、没有 completed/failed。 */
    started_only: number;
    /** 占位 id 只有 `tool.call.failed`（按规格不算「全文」，单列不混）。 */
    failed_only: number;
    /** 占位 id 在日志里连 started 都没有（完全无迹）。 */
    no_trace: number;
  };
}

function dataOf(event: SessionEventRecord): Record<string, unknown> {
  const value = event.data;
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** 日志文件最后一字节是不是 `\n`（不读全文：只 stat + 读尾 1 字节）。 */
async function hasTrailingNewline(path: string): Promise<boolean> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    // 没有 events.ndjson：不是「残行」问题，由 index_missing / 空日志另行体现。
    return true;
  }
  if (size === 0) return true;
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(1);
    await handle.read(buffer, 0, 1, size - 1);
    return buffer[0] === 0x0a;
  } finally {
    await handle.close();
  }
}

/** 日志聚合：一页一页读，只保留与占位 id 有关的少量状态。 */
interface EventScan {
  eventsTotal: number;
  maxSeq: number;
  compactions: number;
  rewound: number;
  compactionIds: Set<string>;
  trimIds: Set<string>;
  originalBytes: Map<string, number>;
  failedIds: Set<string>;
  startedIds: Set<string>;
}

async function scanEvents(
  log: SessionEventLog,
  sessionId: string,
  placeholderIds: ReadonlySet<string>,
): Promise<EventScan> {
  const scan: EventScan = {
    eventsTotal: 0,
    maxSeq: 0,
    compactions: 0,
    rewound: 0,
    compactionIds: new Set<string>(),
    trimIds: new Set<string>(),
    originalBytes: new Map<string, number>(),
    failedIds: new Set<string>(),
    startedIds: new Set<string>(),
  };

  let cursor = 0;
  for (;;) {
    // 分页读：`sinceSeq` 是排他游标 + limit，处理完这一页就丢，不把整份日志攒在手里。
    const batch = await log.read(sessionId, { sinceSeq: cursor, limit: PAGE });
    if (batch.length === 0) break;
    for (const event of batch) {
      scan.eventsTotal += 1;
      if (event.seq > scan.maxSeq) scan.maxSeq = event.seq;
      if (event.seq > cursor) cursor = event.seq;

      const data = dataOf(event);
      switch (event.type) {
        case 'message.compaction': {
          scan.compactions += 1;
          for (const id of stringArray(data.cleared_tool_call_ids)) scan.compactionIds.add(id);
          break;
        }
        case 'session.rewound': {
          scan.rewound += 1;
          break;
        }
        case 'context.cleared_tool_result': {
          for (const id of stringArray(data.tool_call_ids)) scan.trimIds.add(id);
          break;
        }
        case 'tool.call.completed': {
          const id = stringField(data.tool_call_id);
          if (id === undefined || !placeholderIds.has(id)) break;
          const text = stringField(data.result);
          // 同一 id 多条 completed（重放 / 重试）：后写的胜出，与「日志只追加」一致。
          scan.originalBytes.set(id, Buffer.byteLength(text ?? '', 'utf8'));
          break;
        }
        case 'tool.call.failed': {
          const id = stringField(data.tool_call_id);
          if (id !== undefined && placeholderIds.has(id)) scan.failedIds.add(id);
          break;
        }
        case 'tool.call.started': {
          const id = stringField(data.tool_call_id);
          if (id !== undefined && placeholderIds.has(id)) scan.startedIds.add(id);
          break;
        }
        default:
          break;
      }
    }
    if (batch.length < PAGE) break;
  }
  return scan;
}

function emptyRow(session: string, status: Row['status']): Row {
  return {
    session,
    status,
    messages_total: 0,
    tool_messages: 0,
    placeholder_without_id: 0,
    placeholder_tool_messages: 0,
    rescuable: 0,
    unrescuable_no_clearset: 0,
    unrescuable_no_original: 0,
    both_missing: 0,
    rescuable_wide: 0,
    salvageable: 0,
    rewound: 0,
    compactions: 0,
    recoverable_bytes: 0,
    salvageable_bytes: 0,
    clearset_ids_compaction: 0,
    clearset_ids_trim_events: 0,
    shell_frozen_clearset_ids: 0,
    events_total: 0,
    max_seq: 0,
    derived_upto_seq: null,
    anomalies: {
      partial_tail: 0,
      seq_gaps: 0,
      index_missing: 0,
      index_count_mismatch: 0,
      started_only: 0,
      failed_only: 0,
      no_trace: 0,
    },
  };
}

async function auditSession(
  store: FileSessionStore,
  log: SessionEventLog,
  sessionsDir: string,
  sessionId: string,
): Promise<Row> {
  let state: Awaited<ReturnType<FileSessionStore['load']>>;
  try {
    state = await store.load(sessionId);
  } catch {
    // `SessionCorruptError`：文件在、但读不出 / 不是合法 JSON。不猜内容，单独计数。
    return emptyRow(sessionId, 'shell_corrupt');
  }
  if (state === null) return emptyRow(sessionId, 'shell_missing');

  const messages: Message[] = state.messages ?? [];
  const toolMessages = messages.filter((message) => message.role === 'tool');
  const placeholderMessages = toolMessages.filter((message) =>
    isClearedToolResult(message.content),
  );
  const placeholderIds = new Set<string>();
  let placeholderWithoutId = 0;
  for (const message of placeholderMessages) {
    const id = message.tool_call_id;
    if (id === undefined || id.length === 0) placeholderWithoutId += 1;
    else placeholderIds.add(id);
  }

  const scan = await scanEvents(log, sessionId, placeholderIds);

  const row = emptyRow(sessionId, messages.length === 0 ? 'shell_no_messages' : 'ok');
  row.derived_upto_seq = state.derived_upto_seq ?? null;
  row.messages_total = messages.length;
  row.tool_messages = toolMessages.length;
  row.placeholder_tool_messages = placeholderMessages.length;
  row.placeholder_without_id = placeholderWithoutId;
  row.rewound = scan.rewound;
  row.compactions = scan.compactions;
  row.clearset_ids_compaction = scan.compactionIds.size;
  row.clearset_ids_trim_events = scan.trimIds.size;
  row.shell_frozen_clearset_ids = state.cleared_tool_call_ids?.length ?? 0;
  row.events_total = scan.eventsTotal;
  row.max_seq = scan.maxSeq;
  row.anomalies.seq_gaps = Math.max(0, scan.maxSeq - scan.eventsTotal);

  for (const id of placeholderIds) {
    const originalBytes = scan.originalBytes.get(id);
    const hasOriginal = originalBytes !== undefined;
    const bytes = originalBytes ?? 0;
    const hasClearset = scan.compactionIds.has(id);
    const hasClearsetWide = hasClearset || scan.trimIds.has(id);

    if (hasClearset && hasOriginal) {
      row.rescuable += 1;
      row.recoverable_bytes += bytes;
    }
    if (!hasClearset) row.unrescuable_no_clearset += 1;
    if (!hasOriginal) row.unrescuable_no_original += 1;
    if (!hasClearset && !hasOriginal) row.both_missing += 1;
    if (hasClearsetWide && hasOriginal) row.rescuable_wide += 1;
    if (hasOriginal) {
      row.salvageable += 1;
      row.salvageable_bytes += bytes;
    } else if (scan.failedIds.has(id)) {
      // 失败调用的正文在 `tool.call.failed` 里；本探针按规格只认 `tool.call.completed`，
      // 所以这里不进 `salvageable`，但显式记一笔，不静默当无迹。
      row.anomalies.failed_only += 1;
    } else if (scan.startedIds.has(id)) {
      row.anomalies.started_only += 1;
    } else {
      row.anomalies.no_trace += 1;
    }
  }

  const eventsPath = join(sessionsDir, encodeURIComponent(sessionId), 'events.ndjson');
  if (!(await hasTrailingNewline(eventsPath))) row.anomalies.partial_tail = 1;

  const index = await log.readIndex(sessionId);
  if (index === null) row.anomalies.index_missing = 1;
  else if (index.event_count !== scan.eventsTotal) row.anomalies.index_count_mismatch = 1;

  return row;
}

function sum(rows: readonly Row[], pick: (row: Row) => number): number {
  let total = 0;
  for (const row of rows) total += pick(row);
  return total;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = args.indexOf('--sessions');
  const sessionsDir = flag >= 0 ? args[flag + 1] : undefined;
  if (sessionsDir === undefined) {
    console.error('用法：bun run scripts/probe-stock-audit.ts --sessions <sessions 目录>');
    process.exit(2);
  }

  // 只读：`load()` / `read()` / `readIndex()` 都是纯读；不用 `list()`（内部 ensureDir 会 mkdir）。
  const store = new FileSessionStore(sessionsDir);
  const log = new SessionEventLog({ dir: sessionsDir, durable: false });

  const entries = await readdir(sessionsDir, { withFileTypes: true });
  const sessionIds: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      sessionIds.push(decodeURIComponent(entry.name));
    } catch {
      sessionIds.push(entry.name);
    }
  }
  sessionIds.sort();

  const rows: Row[] = [];
  for (const id of sessionIds) {
    rows.push(await auditSession(store, log, sessionsDir, id));
  }

  for (const row of rows) console.log(JSON.stringify(row));

  // ---- stderr：聚合摘要（stdout 保持纯 JSONL） ----
  const damaged = rows.filter((row) => row.placeholder_tool_messages > 0);
  const statuses = new Map<string, number>();
  for (const row of rows) statuses.set(row.status, (statuses.get(row.status) ?? 0) + 1);
  const statusLine = [...statuses.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');

  const q1 = sum(rows, (r) => r.rescuable);
  const bothMissing = sum(rows, (r) => r.both_missing);
  const q2 = sum(rows, (r) => r.unrescuable_no_clearset) - bothMissing;
  const q3 = sum(rows, (r) => r.unrescuable_no_original) - bothMissing;

  console.error('#aggregate');
  console.error(`会话目录 = ${String(rows.length)}`);
  console.error(`status 分布 = ${statusLine}`);
  console.error(`messages_total = ${String(sum(rows, (r) => r.messages_total))}`);
  console.error(`tool_messages = ${String(sum(rows, (r) => r.tool_messages))}`);
  console.error(
    `placeholder_tool_messages = ${String(sum(rows, (r) => r.placeholder_tool_messages))}`,
  );
  console.error(`占位 > 0 的会话 = ${String(damaged.length)}`);
  console.error(`  其中 rewound > 0 = ${String(damaged.filter((r) => r.rewound > 0).length)}`);
  console.error(
    `  其中 compactions > 0 = ${String(damaged.filter((r) => r.compactions > 0).length)}`,
  );
  console.error(`四象限 Q1 有清集+有全文（rescuable） = ${String(q1)}`);
  console.error(`四象限 Q2 无清集+有全文 = ${String(q2)}`);
  console.error(`四象限 Q3 有清集+无全文 = ${String(q3)}`);
  console.error(`四象限 Q4 两者都无 = ${String(bothMissing)}`);
  console.error(`rescuable_wide（清集加宽口径）= ${String(sum(rows, (r) => r.rescuable_wide))}`);
  console.error(`salvageable（只按 tool_call_id）= ${String(sum(rows, (r) => r.salvageable))}`);
  console.error(`recoverable_bytes = ${String(sum(rows, (r) => r.recoverable_bytes))}`);
  console.error(`salvageable_bytes = ${String(sum(rows, (r) => r.salvageable_bytes))}`);
  console.error(`rewound 事件总数 = ${String(sum(rows, (r) => r.rewound))}`);
  console.error(`message.compaction 总数 = ${String(sum(rows, (r) => r.compactions))}`);
  console.error(
    `壳里冻结的 cleared_tool_call_ids 总数 = ${String(sum(rows, (r) => r.shell_frozen_clearset_ids))}`,
  );
  console.error(
    `有冻结集合的会话 = ${String(rows.filter((r) => r.shell_frozen_clearset_ids > 0).length)}`,
  );
  console.error(`异常：partial_tail = ${String(sum(rows, (r) => r.anomalies.partial_tail))}`);
  console.error(`异常：seq_gaps = ${String(sum(rows, (r) => r.anomalies.seq_gaps))}`);
  console.error(`异常：index_missing = ${String(sum(rows, (r) => r.anomalies.index_missing))}`);
  console.error(
    `异常：index_count_mismatch = ${String(sum(rows, (r) => r.anomalies.index_count_mismatch))}`,
  );
  console.error(`异常：started_only = ${String(sum(rows, (r) => r.anomalies.started_only))}`);
  console.error(`异常：failed_only = ${String(sum(rows, (r) => r.anomalies.failed_only))}`);
  console.error(`异常：no_trace = ${String(sum(rows, (r) => r.anomalies.no_trace))}`);
  console.error(
    `异常：placeholder_without_id = ${String(sum(rows, (r) => r.placeholder_without_id))}`,
  );

  const top = [...damaged].sort(
    (a, b) => b.placeholder_tool_messages - a.placeholder_tool_messages,
  );
  console.error('#top10');
  for (const row of top.slice(0, 10)) {
    console.error(
      `  ${row.session} ${String(row.placeholder_tool_messages)} / ${String(row.tool_messages)}`,
    );
  }
}

await main();
