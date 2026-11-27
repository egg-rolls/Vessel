#!/usr/bin/env bun
/**
 * 会话壳（`<sessionId>.json`）**无 id 旧双写残留**的一次性迁移工具。
 *
 * ## 它治什么（probe-message-dedup 建议 A）
 *
 * 0.56 之前 `coverageCut` 的旧缺陷（已修 `0703072c`）会把「A2A 带 name 输入 + 初始保存后
 * 硬杀 + 下一 run 对账」形状的会话落盘成两份：`[来源行, 输入, 来源行(副本), 输入(副本)]`。
 * 那些消息**没有 `message_id`**，落盘守卫 `dropDuplicateMessageIds` 与渲染层 id 去重对
 * 它们永久失效。本工具把残留清掉：
 * - **丢弃第二份**：只裁「同 run + 同 role:user + 同 name + 正文**逐字节相同** + 相邻
 *   （下标差 ≤ 2）+ 时间戳差 ≤ 1ms」的后者 —— 与 `dropDuplicateMessageIds` 的「同内容
 *   才丢」口径一致，不同正文一律不动（宁可重复，绝不吞消息）；
 * - **给第一份补确定式 id**：仅当它是该 run 的唯一人类输入（name 为空 / `agent:*` /
 *   `tool:*`，且该 run 没有第二条非 `vessel:*` 的 user 消息）时补 `userMessageIdOf(runId)`
 *   （`${runId}:user`，与当前写入点 `execution-unit.ts` 同一个确定式字符串）。来源行
 *   （`vessel:source`）只丢副本、不补 id（它的注入下标已不可复算，不伪造身份）。
 *
 * ## 它不改什么
 *
 * - `timeline.ndjson` / `wal.log`：事件层干净（同一条输入只发射一次），不碰。
 * - `<id>.projection.json`：投影缓存由干净事件折叠而来，本就没有重复；只读审计、不写。
 * - 摘要侧车：按 (size, mtime) 自校验，壳变了它自动作废重算（读侧自愈），不碰。
 * - 不动任何别的会话：目标只来自 `--file`，**不扫全库**（误触爆炸半径 = 一个会话）。
 *
 * ## 安全范式（参照 scripts/timeline-dedup-archive.ts）
 *
 * - **默认 dry-run**：只打印计划，一个字节都不写；`--apply` 才写回。
 * - **写前备份**：原始字节整份复制到 `<file>.dedup-bak-<时间戳>`（已存在则拒写）。
 * - **写者守卫**：读后 / 写前两次 stat，size/mtime 变了 ⇒ 拒写（gateway 可能正开着它）；
 *   壳 `status === 'running'` 同样拒写。
 * - **写后复核**：重读文件再跑一遍检测，残留必须为 0。
 *
 * ## 用法
 *
 *   bun run scripts/session-message-dedup.ts --file "C:/Users/x/.vessel/data/sessions/<id>.json"
 *   bun run scripts/session-message-dedup.ts --file "<同上>" --apply
 *
 * 退出码：0 = 收敛（无残留 / 迁移后复核通过）；1 = 写回后仍有残留（不该发生）；
 * 2 = 参数 / 前置条件不成立（没写任何东西）。
 *
 * @module scripts/session-message-dedup
 */

import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { atomicWrite } from '../packages/core/src/session/atomic-write';
import { userMessageIdOf } from '../packages/core/src/session/message-identity';
import type { Message } from '../packages/core/src/types/provider';

/** 相邻口径：两份之间最多隔一条来源行（实测残留形状下标差恒 2）。 */
const MAX_GAP = 2;
/** 时间戳闸：实测残留两份 ts 相同或仅差 1ms（事件时间 vs 上下文写入时间）。 */
const MAX_TS_DELTA = 1;

interface Options {
  file: string;
  apply: boolean;
}

function usage(message: string): never {
  console.error(JSON.stringify({ ok: false, reason: 'usage', message }));
  console.error(
    '用法: bun run scripts/session-message-dedup.ts --file "<sessions>/<id>.json" [--apply]' +
      '（默认 dry-run；--apply 才写回，一次一个会话）',
  );
  process.exit(2);
}

/** 只认 `--file <path>` 与可选 `--apply`；别的一律拒绝（这个工具不该有批量口）。 */
function parseArgs(argv: readonly string[]): Options {
  let file: string | undefined;
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--apply') {
      apply = true;
      continue;
    }
    if (flag === '--file') {
      const value = argv[index + 1];
      if (value === undefined || value.trim() === '') usage('--file needs a path');
      file = resolve(value);
      index += 1;
      continue;
    }
    usage(`unexpected argument: ${String(flag)}`);
  }
  if (file === undefined) usage('missing --file <sessionShellJson>');
  if (!file.endsWith('.json') || file.endsWith('.projection.json')) {
    usage('--file must be the session shell <id>.json (not the projection cache)');
  }
  return { file, apply };
}

/** 两条消息的**内容**是否逐字节相同（身份字段不参与；与 sameMessageContent 同口径）。 */
function sameContent(left: Message, right: Message): boolean {
  if (left.role !== right.role) return false;
  if (left.content !== right.content) return false;
  if ((left.name ?? '') !== (right.name ?? '')) return false;
  if ((left.tool_call_id ?? '') !== (right.tool_call_id ?? '')) return false;
  const callsOf = (value: Message): string =>
    (value.tool_calls ?? [])
      .map((call) => `${call.id}:${call.function.name}:${call.function.arguments}`)
      .join('|');
  if (callsOf(left) !== callsOf(right)) return false;
  const refsOf = (value: Message): string =>
    (value.refs ?? []).map((ref) => `${ref.kind}:${ref.path}`).join('|');
  return refsOf(left) === refsOf(right);
}

function hasId(message: Message): boolean {
  return typeof message.message_id === 'string' && message.message_id.length > 0;
}

function runIdOf(message: Message): string | undefined {
  const runId = message.run_id;
  return typeof runId === 'string' && runId.length > 0 ? runId : undefined;
}

/** 一个被确认的残留组：保留 first、丢弃 second。 */
interface DuplicateGroup {
  runId: string;
  name: string;
  first: number;
  second: number;
  head: string;
  /** 给第一份补的确定式 id（缺省 = 只丢副本、不补 id）。 */
  assignId?: string;
}

/** 检测残留组（纯函数，dry-run 与写后复核共用同一个口径）。 */
function detectGroups(messages: readonly Message[]): {
  groups: DuplicateGroup[];
  skipped: Array<{ first: number; second: number; reason: string }>;
} {
  const groups: DuplicateGroup[] = [];
  const skipped: Array<{ first: number; second: number; reason: string }> = [];
  const dropped = new Set<number>();
  /** 该 run 里非 vessel:* 的 user 消息下标（补 id 的唯一性判据）。 */
  const humanInputsByRun = new Map<string, number[]>();
  messages.forEach((message, index) => {
    if (message.role !== 'user') return;
    const runId = runIdOf(message);
    if (runId === undefined) return;
    if ((message.name ?? '').startsWith('vessel:')) return;
    const list = humanInputsByRun.get(runId) ?? [];
    list.push(index);
    humanInputsByRun.set(runId, list);
  });
  const existingIds = new Set(
    messages
      .map((message) => message.message_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message === undefined || dropped.has(index)) continue;
    // 只治 role:user 的无 id 残留：tool 结果同文案是合法的（重试/重复编辑），assistant
    // 正文段有 run_segment 身份 —— 都不在本工具的口径里（渲染层回退去重另兜底）。
    if (message.role !== 'user' || hasId(message)) continue;
    const runId = runIdOf(message);
    if (runId === undefined) continue;
    if (message.content.trim().length === 0) continue;
    // 向后看 MAX_GAP 格找副本（中间只允许隔来源行那一条）。
    for (
      let ahead = index + 1;
      ahead <= Math.min(index + MAX_GAP, messages.length - 1);
      ahead += 1
    ) {
      const other = messages[ahead];
      if (other === undefined || dropped.has(ahead)) continue;
      if (other.role !== 'user' || hasId(other)) continue;
      if (runIdOf(other) !== runId) continue;
      if (!sameContent(message, other)) continue;
      const leftTs = message.timestamp;
      const rightTs = other.timestamp;
      if (
        typeof leftTs !== 'number' ||
        typeof rightTs !== 'number' ||
        Math.abs(leftTs - rightTs) > MAX_TS_DELTA
      ) {
        skipped.push({ first: index, second: ahead, reason: 'timestamp_delta_too_large' });
        continue;
      }
      const group: DuplicateGroup = {
        runId,
        name: message.name ?? '',
        first: index,
        second: ahead,
        head: message.content.trim().slice(0, 40),
      };
      // 补 id 的闸：name 形状（空 / agent:* / tool:*）+ 该 run 唯一人类输入 + 无撞号。
      const name = message.name ?? '';
      const nameOk = name === '' || name.startsWith('agent:') || name.startsWith('tool:');
      const humans = (humanInputsByRun.get(runId) ?? []).filter(
        (i) => !dropped.has(i) && i !== ahead,
      );
      const candidate = userMessageIdOf(runId);
      if (nameOk && humans.length === 1 && humans[0] === index && !existingIds.has(candidate)) {
        group.assignId = candidate;
        existingIds.add(candidate);
      }
      groups.push(group);
      dropped.add(ahead);
      break;
    }
  }
  return { groups, skipped };
}

/** 应用计划：丢第二份、给第一份补 id（返回新数组，不动入参）。 */
function applyPlan(messages: readonly Message[], groups: readonly DuplicateGroup[]): Message[] {
  const dropIndexes = new Set(groups.map((group) => group.second));
  const assignByIndex = new Map<number, string>();
  for (const group of groups) {
    if (group.assignId !== undefined) assignByIndex.set(group.first, group.assignId);
  }
  const kept: Message[] = [];
  messages.forEach((message, index) => {
    if (dropIndexes.has(index)) return;
    const assignId = assignByIndex.get(index);
    kept.push(assignId === undefined ? message : { ...message, message_id: assignId });
  });
  return kept;
}

/** 只读审计投影缓存里的同 run user 重复（预期 0：事件层干净）。 */
function auditProjectionCache(file: string): Record<string, unknown> {
  const path = file.replace(/\.json$/, '.projection.json');
  if (!existsSync(path)) return { present: false };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { messages?: Message[] };
    const messages = Array.isArray(raw.messages) ? raw.messages : [];
    const { groups } = detectGroups(messages);
    return { present: true, messages: messages.length, legacy_dup_groups: groups.length };
  } catch {
    return { present: true, unreadable: true };
  }
}

async function main(): Promise<number> {
  const { file, apply } = parseArgs(process.argv.slice(2));
  if (!existsSync(file)) {
    console.error(JSON.stringify({ ok: false, reason: 'missing_file', path: file }));
    return 2;
  }
  const statBefore = statSync(file);
  const raw = readFileSync(file);
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
  } catch {
    console.error(JSON.stringify({ ok: false, reason: 'unreadable_shell', path: file }));
    return 2;
  }
  const messages = doc.messages;
  if (!Array.isArray(messages)) {
    console.error(JSON.stringify({ ok: false, reason: 'no_messages_array', path: file }));
    return 2;
  }
  if (doc.status === 'running') {
    console.error(
      JSON.stringify({ ok: false, reason: 'session_running', hint: '会话还在跑，等写者停下再修' }),
    );
    return 2;
  }

  const { groups, skipped } = detectGroups(messages as Message[]);
  const plan = {
    phase: 'plan',
    path: file,
    session_id: doc.session_id,
    messages: messages.length,
    dup_groups: groups.length,
    skipped,
    projection_cache: auditProjectionCache(file),
    groups: groups.map((group) => ({
      run_id: group.runId,
      name: group.name,
      keep_index: group.first,
      drop_index: group.second,
      assign_id: group.assignId ?? null,
      head: group.head,
    })),
  };
  console.log(JSON.stringify(plan));

  if (groups.length === 0) {
    console.log(JSON.stringify({ ok: true, phase: 'noop', message: 'no legacy duplicate' }));
    return 0;
  }
  if (!apply) {
    console.log(
      JSON.stringify({ ok: true, phase: 'dry-run', message: '未写任何字节；--apply 才写回' }),
    );
    return 0;
  }

  // 写者守卫：读后文件变了 ⇒ 不敢修。
  const statNow = statSync(file);
  if (statNow.size !== statBefore.size || statNow.mtimeMs !== statBefore.mtimeMs) {
    console.error(
      JSON.stringify({
        ok: false,
        reason: 'file_changing',
        hint: '会话正在被写（gateway 在跑？），等写者停下再修',
      }),
    );
    return 2;
  }
  // 备份：原始字节整份复制（已存在 ⇒ 拒写，不覆盖旧备份）。
  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, '')
    .slice(0, 14);
  const backup = `${file}.dedup-bak-${stamp}`;
  if (existsSync(backup)) {
    console.error(JSON.stringify({ ok: false, reason: 'backup_exists', path: backup }));
    return 2;
  }
  copyFileSync(file, backup);

  const next = applyPlan(messages as Message[], groups);
  const out = { ...doc, messages: next };
  await atomicWrite(file, JSON.stringify(out, null, 2), { durable: true });

  // 写后复核：重读再检测，残留必须为 0。
  const after = JSON.parse(readFileSync(file, 'utf8')) as { messages?: Message[] };
  const recheck = detectGroups(after.messages ?? []);
  console.log(
    JSON.stringify({
      ok: recheck.groups.length === 0,
      phase: 'repair',
      path: file,
      backup,
      before_messages: messages.length,
      after_messages: next.length,
      dropped: groups.length,
      assigned_ids: groups
        .filter((group) => group.assignId !== undefined)
        .map((group) => group.assignId),
      remaining_groups: recheck.groups.length,
    }),
  );
  return recheck.groups.length === 0 ? 0 : 1;
}

process.exit(await main());
