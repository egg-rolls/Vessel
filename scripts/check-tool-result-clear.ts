#!/usr/bin/env bun

/**
 * 门禁：工具结果占位（context trim）必须「一次到位」，不许每轮右移（0.52 V1）。
 *
 * 背景：旧实现每次请求按当前 messages 重算窗口（K = min(10, 5% 预算)）⇒ 第 11 条工具
 * 结果之后每轮多清一条，同一段内请求前缀每轮变一次。现在集合在**段起点**算一次并冻结。
 *
 * 本探针查语义层（`check-request-append-only` 的 R4 / R5② 查请求序列层，两者互补）：
 *
 * - T1 一次冻结：段内追加多少条工具结果，两次请求的占位 call id 集合**完全相同**；
 *   同时自检探针能抓到旧行为（按当前 messages 重算确实会多清）。
 * - T2 视图层改写是真改：冻结集合里的 call id 必须是占位符、占位符不含工具输出正文，
 *   落盘消息一个字不改（不是「一条都不清」冒充冻结）。
 * - T3 pop 之后基准重置：按新基准重算允许变化，且不残留已从窗口消失的 call id。
 * - T4 卡可见且不泄露：`renderContextTrimNotice` 首行是 `trim:` / `trim：`，说清条数与
 *   call id，en / zh-CN 两侧都**不含任何工具输出正文**。
 * - T5 落盘：`SessionState.cleared_tool_call_ids` 在 File / SQLite 两后端往返一致；
 *   旧快照 / 旧库缺字段照常加载（undefined = 这一段没决策）；旧库打开自动补列；
 *   脏数据不许把会话读崩。
 *
 * 用法：bun run scripts/check-tool-result-clear.ts（退出码 0 = 全过，1 = 有 FAIL）
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileSessionStore,
  isClearedToolResult,
  type Message,
  normalizeClearedToolCallIds,
  planClearedToolResults,
  renderContextTrimNotice,
  type SessionState,
  SQLiteSessionStore,
  withClearedToolResults,
} from '../packages/core/src/index';

/** 5% 预算 = 50 tokens ⇒ 只留最近一条工具结果，其余全该被占位。 */
const MAX_TOKENS = 1_000;
/** 工具输出正文哨兵：占位符与 env 卡里都不许出现。 */
const BODY_SENTINEL = 'TOOL-OUTPUT-SENTINEL';

const failures: string[] = [];
let passed = 0;

function ok(label: string): void {
  passed += 1;
  console.log('  ok  ' + label);
}

function fail(label: string, detail: string): void {
  failures.push(label + '：' + detail);
  console.log('  FAIL ' + label + '：' + detail);
}

function expect(label: string, actual: unknown, want: unknown): void {
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a === w) ok(label);
  else fail(label, 'want ' + w + ' got ' + a);
}

function section(title: string): void {
  console.log('\n' + title);
}

function msg(role: Message['role'], content: string, extra: Partial<Message> = {}): Message {
  return { role, content, timestamp: 1, run_id: 'run-1', run_segment: 0, ...extra } as Message;
}

function toolBody(index: number): string {
  return BODY_SENTINEL + '-' + String(index) + ' ' + 'x'.repeat(400);
}

/** 一轮工具调用：assistant(tool_calls) + tool(正文)。 */
function round(index: number): Message[] {
  const id = 'call_' + String(index);
  return [
    msg('assistant', '', {
      tool_calls: [{ id, type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }],
    }),
    msg('tool', toolBody(index), { tool_call_id: id }),
  ];
}

/** 段基准：SYSTEM + USER + count 轮工具结果（= 上一段留下的历史）。 */
function segmentBase(count: number): Message[] {
  const messages: Message[] = [
    msg('system', '你是 Vessel 的具身成员。'),
    msg('user', '把这几份文件都读一遍。'),
  ];
  for (let index = 0; index < count; index += 1) messages.push(...round(index));
  return messages;
}

/** 请求视图里被占位的 call id（顺序 = 窗口顺序）。 */
function clearedIdsOf(view: readonly Message[]): string[] {
  return view
    .filter(
      (message) =>
        message.role === 'tool' &&
        typeof message.tool_call_id === 'string' &&
        isClearedToolResult(String(message.content)),
    )
    .map((message) => String(message.tool_call_id));
}

// ── T1：一次冻结（同段内两次请求的占位集合完全相同） ───────────────────────

section('T1 段起点冻结一次：段内追加工具结果不改占位集合');

{
  const history = segmentBase(6);
  // 段起点：旧的工具结果 6 条，预算只留最近 1 条 ⇒ 清 call_0..call_4。
  const frozen = planClearedToolResults(history, MAX_TOKENS);
  expect('T1.1 段起点的冻结集合', frozen, ['call_0', 'call_1', 'call_2', 'call_3', 'call_4']);

  const firstView = withClearedToolResults(history, frozen);
  expect('T1.2 第一次请求的占位集合', clearedIdsOf(firstView), frozen);

  // 段内又跑了两轮工具调用（窗口 append 4 条）。
  const grown = [...history, ...round(6), ...round(7)];
  const secondView = withClearedToolResults(grown, frozen);
  expect('T1.3 段内第二次请求的占位集合**完全相同**', clearedIdsOf(secondView), frozen);

  // 本段新产生的工具结果一律是原文（旧集合里没有它们的 id）。
  const freshToolContent = secondView.filter((message) => message.role === 'tool').slice(-2);
  expect(
    'T1.4 本段新工具结果保留原文',
    freshToolContent.map((message) => isClearedToolResult(String(message.content))),
    [false, false],
  );

  // 自检：按当前 messages 重算窗口（旧行为）确实会多清 —— 探针能抓到回归。
  const recomputed = planClearedToolResults(grown, MAX_TOKENS);
  if (recomputed.length > frozen.length) {
    ok(
      'T1.5 回归自检：按当前 messages 重算会多清 ' +
        String(recomputed.length) +
        ' 条（旧行为的形状）',
    );
  } else {
    fail('T1.5', '重算窗口没有多清，探针失去判别力：' + JSON.stringify(recomputed));
  }
  // 传预算（没有冻结决策）时请求视图必须与落盘逐字一致。
  const undecided = withClearedToolResults(grown, MAX_TOKENS);
  expect('T1.6 没有决策 ⇒ 一条都不清', clearedIdsOf(undecided), []);
}

// ── T2：视图改写是真改，落盘一个字不改 ─────────────────────────────────────

section('T2 请求视图被改写、落盘不变、占位符不泄正文');

{
  const history = segmentBase(6);
  const frozen = planClearedToolResults(history, MAX_TOKENS);
  const before = JSON.stringify(history);
  const view = withClearedToolResults(history, frozen);

  expect('T2.1 落盘历史一个字不改', JSON.stringify(history), before);
  if (view !== history) ok('T2.2 返回的是新数组（视图层，不是就地改）');
  else fail('T2.2', '请求视图与落盘是同一个数组引用');

  const leaked = view.filter(
    (message) => message.role === 'tool' && String(message.content).includes(BODY_SENTINEL),
  );
  expect('T2.3 占位符不含工具输出正文', leaked.length, 1);

  const keptTool = view.filter(
    (message) => message.role === 'tool' && !isClearedToolResult(String(message.content)),
  );
  expect('T2.4 最近一条工具结果保留原文', keptTool.length, 1);
  expect('T2.4b 保留的是最新那条', keptTool[0]?.tool_call_id, 'call_5');
}

// ── T3：pop 之后基准重置（允许变化，不残留已丢的 id） ──────────────────────

section('T3 pop（丢尾）= 新段基准：允许重算，不许残留');

{
  const history = segmentBase(6);
  const frozenOld = planClearedToolResults(history, MAX_TOKENS);
  // pop 丢掉尾部 6 条消息（3 轮工具结果）⇒ 新基准只剩 call_0..call_2 的数。
  const popped = history.slice(0, history.length - 6);
  const frozenNew = planClearedToolResults(popped, MAX_TOKENS);

  if (frozenNew.length !== frozenOld.length) {
    ok('T3.1 pop 之后按新基准重算（集合允许变化）');
  } else {
    fail('T3.1', '新基准重算结果与旧集合一样长，pop 用例失去判别力：' + JSON.stringify(frozenNew));
  }

  const view = withClearedToolResults(popped, frozenNew);
  expect('T3.2 新基准下占位条数与基准一致', clearedIdsOf(view), frozenNew);
  const windowIds = popped
    .filter((message) => message.role === 'tool')
    .map((message) => String(message.tool_call_id));
  expect(
    'T3.3 不残留已从窗口消失的 call id',
    clearedIdsOf(view).filter((id) => !windowIds.includes(id)),
    [],
  );

  // 旧集合套到新窗口上也不会「复活」已丢的消息 —— 只是不再覆盖新基准的决策。
  const stale = withClearedToolResults(popped, frozenOld);
  expect(
    'T3.4 旧集合对新窗口只作用于仍在窗口内的 id',
    clearedIdsOf(stale).filter((id) => !windowIds.includes(id)),
    [],
  );
}

// ── T4：env 卡可见且不泄露 ─────────────────────────────────────────────────

section('T4 占位卡可见（trim scope）且不含工具输出正文');

{
  const ids = ['call_0', 'call_1', 'call_2', 'call_3', 'call_4'];
  const en = renderContextTrimNotice({ cleared: 5, kept: 1, tool_call_ids: ids });
  const zh = renderContextTrimNotice({ cleared: 5, kept: 1, tool_call_ids: ids }, 'zh-CN');
  const lines = en.split('\n');

  if (en.startsWith('trim: ')) ok('T4.1 en 卡首行是 trim: 摘要');
  else fail('T4.1', 'en 卡首行不是 trim: …… ' + lines[0]);
  if (zh.startsWith('trim：')) ok('T4.2 zh-CN 卡首行是 trim：摘要');
  else fail('T4.2', 'zh-CN 卡首行不是 trim：…… ' + zh.split('\n')[0]);
  if (lines.length >= 3 && (lines[1] ?? '').startsWith('  · ')) ok('T4.3 明细行走 env 卡同一格式');
  else fail('T4.3', '明细行格式不是「两个空格 + · 」：' + JSON.stringify(lines[1]));
  if (en.includes('5') && en.includes('call_0') && en.includes('call_4'))
    ok('T4.4 卡里说清条数与被清的 call id');
  else fail('T4.4', '卡里缺条数或 call id：' + en);
  if (!en.includes(BODY_SENTINEL) && !zh.includes(BODY_SENTINEL)) ok('T4.5 卡不泄露工具输出正文');
  else fail('T4.5', '卡里出现了工具输出正文');

  const many = renderContextTrimNotice({
    cleared: 12,
    kept: 1,
    tool_call_ids: Array.from({ length: 12 }, (_unused, index) => 'call_' + String(index)),
  });
  if (many.includes('+4')) ok('T4.6 长列表折叠成 +N，卡不会自己撑大上下文');
  else fail('T4.6', '长列表没有折叠：' + many);
}

// ── T5：additive 字段落盘（两 backend + 旧数据） ──────────────────────────

section('T5 SessionState.cleared_tool_call_ids 落盘（File / SQLite / 旧数据）');

function baseState(sessionId: string): SessionState {
  return {
    session_id: sessionId,
    messages: [msg('user', '旧会话内容（没有占位字段）')],
    title: 'legacy',
    title_source: 'user',
    preview: '旧会话内容',
    created_at: 1,
    updated_at: 2,
    status: 'completed',
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    derived_upto_seq: 3,
  } as unknown as SessionState;
}

{
  const dir = mkdtempSync(join(tmpdir(), 'vessel-trim-'));
  try {
    const fileStore = new FileSessionStore(dir);
    await fileStore.save({
      ...baseState('s-file'),
      cleared_tool_call_ids: ['call_0', 'call_1'],
    } as SessionState);
    const loaded = await fileStore.load('s-file');
    expect('T5.1 File 后端读回占位集合', loaded?.cleared_tool_call_ids, ['call_0', 'call_1']);
    const onDisk = readFileSync(join(dir, 's-file.json'), 'utf8');
    if (onDisk.includes('cleared_tool_call_ids')) ok('T5.2 File 后端把字段写进 JSON');
    else fail('T5.2', 'JSON 里没有 cleared_tool_call_ids');

    await fileStore.save(baseState('s-old-file'));
    const oldLoaded = await fileStore.load('s-old-file');
    expect(
      'T5.3 旧快照缺字段 ⇒ undefined（这一段没决策）',
      oldLoaded?.cleared_tool_call_ids,
      undefined,
    );

    const dbStore = new SQLiteSessionStore(':memory:');
    await dbStore.save({
      ...baseState('s-sql'),
      cleared_tool_call_ids: ['call_2', 'call_3'],
    } as SessionState);
    const sqlLoaded = await dbStore.load('s-sql');
    expect('T5.4 SQLite 后端读回占位集合', sqlLoaded?.cleared_tool_call_ids, ['call_2', 'call_3']);
    await dbStore.save(baseState('s-sql-old'));
    expect(
      'T5.5 SQLite 旧行（NULL）⇒ undefined',
      (await dbStore.load('s-sql-old'))?.cleared_tool_call_ids,
      undefined,
    );
    dbStore.close?.();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 旧库补列：手建一张没有 cleared_tool_call_ids 的 sessions 表，打开后必须能读能写。
{
  const dir = mkdtempSync(join(tmpdir(), 'vessel-trim-mig-'));
  const dbPath = join(dir, 'sessions.db');
  try {
    const { Database } = await import('bun:sqlite');
    const legacy = new Database(dbPath);
    legacy.run(
      'CREATE TABLE sessions (session_id TEXT PRIMARY KEY, run_id TEXT, messages TEXT NOT NULL, started_at INTEGER NOT NULL, completed_at INTEGER, status TEXT NOT NULL, usage TEXT, error TEXT, title TEXT, title_source TEXT, preview TEXT, updated_at INTEGER NOT NULL, branch TEXT, tenant_id TEXT, derived_upto_seq INTEGER)',
    );
    legacy.run(
      'INSERT INTO sessions (session_id, run_id, messages, started_at, completed_at, status, usage, error, title, title_source, preview, updated_at, branch, tenant_id, derived_upto_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        's-legacy',
        null,
        JSON.stringify([msg('user', '旧库会话')]),
        1,
        2,
        'completed',
        null,
        null,
        'legacy',
        'user',
        '旧库会话',
        2,
        null,
        null,
        null,
      ],
    );
    legacy.close();

    const migrated = new SQLiteSessionStore(dbPath);
    expect(
      'T5.6 旧库补列后照常加载（字段缺省）',
      (await migrated.load('s-legacy'))?.cleared_tool_call_ids,
      undefined,
    );
    await migrated.save({
      ...baseState('s-after-mig'),
      cleared_tool_call_ids: ['call_9'],
    } as SessionState);
    expect('T5.7 补列后字段能落盘', (await migrated.load('s-after-mig'))?.cleared_tool_call_ids, [
      'call_9',
    ]);
    migrated.close?.();
  } catch (error) {
    fail('T5.6', '旧库补列失败：' + String(error));
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 上 sqlite 句柄未完全释放时 rm 会 EBUSY：清理失败不影响判据
    }
  }
}

// 归一：脏数据不许把会话读崩，也不许被当成「全清」。
{
  expect('T5.8 undefined ⇒ undefined', normalizeClearedToolCallIds(undefined), undefined);
  expect('T5.9 空数组 ⇒ undefined', normalizeClearedToolCallIds([]), undefined);
  expect('T5.10 非数组 ⇒ undefined', normalizeClearedToolCallIds('call_0'), undefined);
  expect(
    'T5.11 去重 + 丢掉非字符串',
    normalizeClearedToolCallIds(['call_0', 'call_0', 7, '', 'call_1']),
    ['call_0', 'call_1'],
  );
}

// ── 汇总 ───────────────────────────────────────────────────────────────────

console.log('');
if (failures.length === 0) {
  console.log('工具结果占位判据：通过 ' + String(passed) + ' 项，0 项红。');
} else {
  console.log(
    '工具结果占位判据：通过 ' + String(passed) + ' 项，红 ' + String(failures.length) + ' 项：',
  );
  for (const failure of failures) console.log('  - ' + failure);
}
process.exit(failures.length === 0 ? 0 : 1);
