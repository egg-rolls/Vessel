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
 * - T6（0.53 主题1②）体积阈值：保留结果原文体积 / 窗口预算 > N% ⇒ 该压缩/开新段。
 *   钉死常量默认值（5% / 10 条 / 20%）、阈值边界（恰好等于不触发、+1 token 触发）、
 *   可清 0 条、整个窗口超阈值、默认配置与旧行为逐字节等价，并锁住「体积判据不参与
 *   清几条的决策」——它只决定还要不要在同一段里继续塞。
 * - T7（0.53 主题3）卡的**分层口径**：折叠态首行只说本轮新增，总数与保留条数进展开明细
 *   （中/英双语）；事件 `data` 同时带 `cleared`（总数）与 `added`（增量），`summary` 与
 *   卡正文逐字一致；同一会话里「总数 + 新增条数 + 新增 id 列表」全等的载荷**不再发卡、
 *   不再发事件**（附反证：换一个新实例就照旧发，说明去重断言不是「什么都不发」的假绿）。
 *
 * 用法：bun run scripts/check-tool-result-clear.ts（退出码 0 = 全过，1 = 有 FAIL）
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRunJournalFactory,
  ExecutionUnit,
  FileSessionStore,
  isClearedToolResult,
  KEEP_RECENT_MAX,
  KEEP_RECENT_TOKEN_RATIO,
  type LLMProvider,
  MemoryEventStream,
  MemoryWorkingContext,
  type Message,
  measureRetainedToolResultVolume,
  measureToolResultPressure,
  normalizeClearedToolCallIds,
  type Plugin,
  planClearedToolResults,
  projectionVolumeDimensionApplies,
  renderContextTrimNotice,
  type SessionEventInput,
  type SessionEventLogPort,
  type SessionEventRecord,
  type SessionState,
  SQLiteSessionStore,
  setWindowProjectionMode,
  shouldCompactForToolResultVolume,
  TOOL_RESULT_VOLUME_THRESHOLD_RATIO,
  trimNoticeSignature,
  windowProjectionMode,
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

// ── T6：体积阈值（0.53 主题1②，只增不删） ─────────────────────────────────

section('T6 体积阈值：保留结果原文体积超窗口 N% ⇒ 触发压缩/开新段');

{
  // T6.0 常量回归锁：把 10 / 5% 抽成命名常量 + 体积阈值，不许顺手改默认值。
  expect(
    'T6.0 默认常量冻结（保留 5% / 10 条；体积阈值 20%）',
    [KEEP_RECENT_TOKEN_RATIO, KEEP_RECENT_MAX, TOOL_RESULT_VOLUME_THRESHOLD_RATIO],
    [0.05, 10, 0.2],
  );

  // 估算口径：'x'.repeat(N) ⇒ ceil(N × 0.25)。窗口 1000 ⇒ 20% = 200 tokens。
  const loneTool = (chars: number): Message[] => [
    msg('tool', 'x'.repeat(chars), { tool_call_id: 'call_edge' }),
  ];
  const boundaryRatio = 0.2;

  // 阈值边界：恰好等于（200/1000 = 0.2）不触发；阈值 +1 token（201/1000）触发。
  expect(
    'T6.1 恰好等于阈值：保留 200 tokens / 窗口 1000 = 20% ⇒ 不触发',
    measureRetainedToolResultVolume(loneTool(800), 1_000, { thresholdRatio: boundaryRatio }),
    {
      maxTokens: 1_000,
      thresholdRatio: boundaryRatio,
      retainedCount: 1,
      retainedTokens: 200,
      ratio: 0.2,
      exceeds: false,
    },
  );
  expect(
    'T6.2 阈值 +1 token：201/1000 ⇒ 触发',
    shouldCompactForToolResultVolume(loneTool(801), 1_000, { thresholdRatio: boundaryRatio }),
    true,
  );

  // 可清 0 条：窗口里只有 1 条小结果 ⇒ 没有可清的，体积也远低于阈值。
  const singleSmall = segmentBase(1);
  expect(
    'T6.3 可清 0 条：只有 1 条工具结果',
    [
      planClearedToolResults(singleSmall, MAX_TOKENS),
      shouldCompactForToolResultVolume(singleSmall, MAX_TOKENS),
    ],
    [[], false],
  );

  // 整个窗口都超阈值：20 条工具结果、每条自身就吃满窗口 ⇒ 保留下来的那条也超。
  const flooded: Message[] = [];
  for (let index = 0; index < 20; index += 1) {
    flooded.push(msg('tool', 'x'.repeat(4_000), { tool_call_id: 'call_' + String(index) }));
  }
  const floodedMeasured = measureRetainedToolResultVolume(flooded, 1_000);
  expect(
    'T6.4 整个窗口都被工具结果占满 ⇒ 保留条数仍受「最新 1 条必留」约束',
    [floodedMeasured.retainedCount, floodedMeasured.retainedTokens, floodedMeasured.exceeds],
    [1, 1_000, true],
  );

  // 默认阈值下的不触发 / 触发各一例（正常会话 vs 单条巨型结果）。
  const normal = segmentBase(6);
  const normalMeasured = measureRetainedToolResultVolume(normal, MAX_TOKENS);
  expect(
    'T6.5 默认阈值不触发：正常段（6 条 × 106 tokens，保留 1 条 = 10.6%）',
    [normalMeasured.retainedCount, normalMeasured.retainedTokens, normalMeasured.exceeds],
    [1, 106, false],
  );
  const giant = [...segmentBase(1), msg('tool', 'x'.repeat(1_200), { tool_call_id: 'call_giant' })];
  expect(
    'T6.6 默认阈值触发：单条 300 tokens 结果 / 窗口 1000 = 30% ⇒ 该开新段',
    shouldCompactForToolResultVolume(giant, MAX_TOKENS),
    true,
  );

  // 回归锁：默认配置与旧行为逐字节等价（不传参 ≡ 传默认值 ≡ 冻结期望集合）。
  const capBound: Message[] = [msg('system', 's'), msg('user', 'u')];
  for (let index = 0; index < 12; index += 1) {
    capBound.push(msg('tool', 'xx', { tool_call_id: 'call_' + String(index) }));
  }
  expect(
    'T6.7 默认配置 ≡ 显式默认值 ≡ 旧行为（5% 预算维度）',
    [
      planClearedToolResults(normal, MAX_TOKENS),
      planClearedToolResults(normal, MAX_TOKENS, {}),
      planClearedToolResults(normal, MAX_TOKENS, { keepRecentTokenRatio: 0.05, keepRecentMax: 10 }),
    ],
    [
      ['call_0', 'call_1', 'call_2', 'call_3', 'call_4'],
      ['call_0', 'call_1', 'call_2', 'call_3', 'call_4'],
      ['call_0', 'call_1', 'call_2', 'call_3', 'call_4'],
    ],
  );
  expect(
    'T6.8 默认配置 ≡ 显式默认值（10 条上限维度生效）',
    [
      planClearedToolResults(capBound, MAX_TOKENS),
      planClearedToolResults(capBound, MAX_TOKENS, { keepRecentMax: 10 }),
    ],
    [
      ['call_0', 'call_1'],
      ['call_0', 'call_1'],
    ],
  );
  // 体积判据不许改变清除集合：判据只看保留体积，不参与「清几条」的决策。
  expect(
    'T6.9 体积阈值不参与清除集合决策（同一段触发前后清除集合不变）',
    [
      planClearedToolResults(giant, MAX_TOKENS),
      shouldCompactForToolResultVolume(giant, MAX_TOKENS),
    ],
    [['call_0'], true],
  );
  expect(
    'T6.10 保留条数 + 清除条数 = 窗口内工具结果总条数（不重复计费）',
    [normalMeasured.retainedCount + planClearedToolResults(normal, MAX_TOKENS).length, 6],
    [6, 6],
  );
}

// ── T6-B：体积阈值**按 mode 分层**（0.53 U2，只增不删） ────────────────────
//
// 为什么 T6 要分层：0.20 体积维度**只属于 `placeholder`**。`passthrough` 的字面语义是
// 「与完全没有投射机制时逐字节相同」，而「体积一到就压缩」会改变请求消息序列 ——
// 在 passthrough 下让它参与判据 = 偷偷开机制。
//
// **T6.1~T6.10 一条都没删、也没放宽**：它们量的是纯函数口径（`measureRetainedToolResultVolume`
// / `shouldCompactForToolResultVolume` / `planClearedToolResults`），这些函数本身与 mode
// 无关，是判据的**零件**。分层发生在装配处（`ContextManager.shouldCompact()`），所以
// 新增断言在这里钉装配：同一条超 20% 的窗口，`placeholder` 该压、`passthrough` 不许压；
// 0.85 主阈值与条数上限对两种 mode 一样生效（硬兜底）。

section('T6-B 体积阈值按 mode 分层：0.20 只对 placeholder 参与判据（U2）');

await (async function checkToolResultVolumeByMode(): Promise<void> {
  // 夹具 A（**只有**体积维度越线）：单条 1200 字符 ≈ 300 tokens / 窗口 1000 = 30% > 20%。
  // 4 条非 system：token 合计 ≈ 312 远低于 0.85 主阈值（850），条数上限（100）也够远
  // ⇒ 两个用例的**唯一**差异就是 mode，能干净地指向「体积维度有没有参与判据」。
  const giantToolWindow = (): MemoryWorkingContext => {
    const context = new MemoryWorkingContext({ maxTokens: 1_000, autoCompact: true });
    context.setSessionId('s-t6b-' + String(Math.random()).slice(2, 8));
    context.add(msg('user', '读一下这份大文件。'));
    context.add(
      msg('assistant', '', {
        tool_calls: [
          {
            id: 'call_giant',
            type: 'function',
            function: { name: 'read', arguments: '{"p":"a"}' },
          },
        ],
      }),
    );
    context.add(msg('tool', 'x'.repeat(1_200), { tool_call_id: 'call_giant' }));
    context.add(msg('user', '好。'));
    return context;
  };

  expect(
    'T6-B.1 体积维度只对 placeholder 生效（常量判据）',
    [
      projectionVolumeDimensionApplies('placeholder'),
      projectionVolumeDimensionApplies('passthrough'),
    ],
    [true, false],
  );

  const placeholderWindow = giantToolWindow();
  // 缺省（没写过槽位）= placeholder：U2 之前的调用方行为一字不变。
  expect(
    'T6-B.2 未设置模式时缺省 placeholder（向后兼容）',
    windowProjectionMode(placeholderWindow),
    'placeholder',
  );
  setWindowProjectionMode(placeholderWindow, 'placeholder');
  const placeholderRemoved = await placeholderWindow.autoCompactAsync();
  expect(
    'T6-B.3 placeholder 下 30% > 20% ⇒ 段起点压缩（`shouldCompact()` 吃体积维度）',
    placeholderRemoved > 0,
    true,
  );

  const passthroughWindow = giantToolWindow();
  setWindowProjectionMode(passthroughWindow, 'passthrough');
  const passthroughRemoved = await passthroughWindow.autoCompactAsync();
  expect('T6-B.4 passthrough 下同一条 30% 窗口 ⇒ 不压缩（0.20 不参与判据）', passthroughRemoved, 0);
  // 反证：它确实越过了 20% 那条线 —— 否则 T6-B.4 可能只是「没到阈值」的假绿。
  expect(
    'T6-B.5 反证：这条窗口真的越过了 20%（pressure 报 exceeded，ratio 30%）',
    (() => {
      const pressure = measureToolResultPressure(passthroughWindow.messages, 1_000);
      return [pressure.exceeded, pressure.ratio, pressure.basis];
    })(),
    [true, 0.3, 'all_tool_results'],
  );

  // 夹具 B（**只有** token 主阈值越线）：窗口 200，token 合计 ≈ 190 > 0.85 × 200 = 170。
  // 体积维度在这里是 190/200 = 95%（也越线了），但结论必须由 0.85 决定 ——
  // 这条断言钉的就是「passthrough 不因 0.20 压缩，但硬兜底照压」。
  const overBudgetWindow = new MemoryWorkingContext({ maxTokens: 200, autoCompact: true });
  overBudgetWindow.setSessionId('s-t6b-floor');
  overBudgetWindow.add(msg('user', 'a'.repeat(480)));
  overBudgetWindow.add(
    msg('assistant', '', {
      tool_calls: [
        { id: 'call_b', type: 'function', function: { name: 'read', arguments: '{"p":"b"}' } },
      ],
    }),
  );
  overBudgetWindow.add(msg('tool', 'b'.repeat(200), { tool_call_id: 'call_b' }));
  overBudgetWindow.add(msg('user', 'c'.repeat(80)));
  setWindowProjectionMode(overBudgetWindow, 'passthrough');
  const overBudgetRemoved = await overBudgetWindow.autoCompactAsync();
  expect('T6-B.6 passthrough 下 0.85 主阈值仍是硬兜底（超预算照压）', overBudgetRemoved > 0, true);

  // passthrough 不许产生任何占位：请求视图与落盘历史**逐条同对象**（逐字节相同）。
  const raw = segmentBase(3);
  const passthroughView = withClearedToolResults(raw, []);
  expect(
    'T6-B.7 passthrough 口径（空集合）不产生任何占位，且视图逐条同对象',
    [
      clearedIdsOf(passthroughView),
      passthroughView.length === raw.length &&
        passthroughView.every((message, index) => message === raw[index]),
    ],
    [[], true],
  );
})();

// ── T7：分层口径（折叠=增量 / 展开=总数）+ 同载荷去重（0.53 主题3） ─────────
//
// 用户原话：「这个 trim 数量是总的对吧，是每一轮都要计算这 231 个，还是增量的」——
// 旧卡标题写总数（231 = 这一段一共清了几条），列出的 id 却只有本轮新增的 6 条，
// 一句话里两个口径，读起来像自相矛盾。用户裁定（2026-02）的口径是**分两层**：
// 折叠态标题只说增量，总数挪到展开后的明细里。T7 钉两件事：
//   ① 首行（折叠态）= 本轮新增，明细行（展开区）= 总数 + 保留条数 + 新增 id（中/英），
//      且 id 列表仍只有新增（不炸大）；
//   ② 同一会话里「总数 + 新增条数 + 新增 id 列表」全等 ⇒ 卡片与事件都不再 append。
// ② 为什么必须跑真 runtime：重复发送是**跨 run** 的行为（段起点每轮重算一次），
// 纯函数测不出「有没有 append」。

section('T7 分层口径（折叠态=增量 / 展开=总数）与同载荷去重');

// ①.1 纯函数：首行只有增量，总数在明细行。
{
  const fresh = ['call_a', 'call_b', 'call_c', 'call_d', 'call_e', 'call_f'];
  const en = renderContextTrimNotice({ cleared: 231, kept: 10, tool_call_ids: fresh });
  const zh = renderContextTrimNotice({ cleared: 231, kept: 10, tool_call_ids: fresh }, 'zh-CN');
  const enLines = en.split('\n');
  const zhLines = zh.split('\n');
  const enHead = enLines[0] ?? '';
  const zhHead = zhLines[0] ?? '';
  if (
    enHead.includes('6 older tool result(s) turned into placeholders this run') &&
    !enHead.includes('231')
  )
    ok('T8.1 en 折叠态首行只说本轮新增 6 条（不带总数 231）');
  else fail('T8.1', 'en 首行口径不对：' + enHead);
  if (zhHead.includes('本轮新增 6 条旧工具结果换为占位符') && !zhHead.includes('231'))
    ok('T8.2 zh-CN 折叠态首行只说本轮新增 6 条（不带总数 231）');
  else fail('T8.2', 'zh-CN 首行口径不对：' + zhHead);
  // 明细行（展开区）才给总数，且原有明细（保留条数 / call id）不变形。
  if (
    (enLines[1] ?? '').startsWith('  · ') &&
    (enLines[1] ?? '').includes('231 cleared in this session') &&
    (zhLines[1] ?? '').includes('会话内已累计 231 条被占位')
  )
    ok('T8.3 展开明细第一行给出总数 231（en / zh-CN 都有）');
  else fail('T8.3', '明细行没有总数：' + JSON.stringify([enLines[1], zhLines[1]]));
  if (
    enLines.length === 4 &&
    enLines.slice(1).every((line) => line.startsWith('  · ')) &&
    (enLines[2] ?? '').includes('kept the 10 most recent') &&
    (enLines[3] ?? '').includes('call_f') &&
    (enLines[3] ?? '').includes('call_a')
  )
    ok('T8.4 明细行仍是「env 卡同一格式」，kept / 新增 call id 未变、id 列表没改回全量');
  else fail('T8.4', '明细行形状变了：' + JSON.stringify(enLines.slice(1)));
  // 反证：两个口径各在一层 —— 总数只出现在明细、增量只出现在首行。
  if (!enHead.includes('231') && en.includes('231 cleared in this session'))
    ok('T8.5 总数只在展开明细、增量只在折叠首行（不再一句话两个口径）');
  else fail('T8.5', '两个口径的层次没分开：' + en);
  // 缩略照旧：新增溢出折成 `+N`，不许把 id 全量摊开把卡炸大。
  const flooded = renderContextTrimNotice({
    cleared: 231,
    kept: 10,
    tool_call_ids: Array.from({ length: 210 }, (_unused, index) => 'call_' + String(index)),
  });
  if (flooded.includes(', +202') && !flooded.includes('call_9,'))
    ok('T8.6 新增 id 溢出仍折成 +N（卡不会因 210 条新增被撑大）');
  else fail('T8.6', '溢出缩略坏了：' + (flooded.split('\n')[3] ?? ''));

  // 去重键：三元组全等才相等，任一项不同就不同（JSON 编码，id 里带分隔符也不撞）。
  const sig = trimNoticeSignature;
  expect(
    'T8.7 去重键：三元组全等 ⇒ 同一个键',
    sig({ cleared: 5, added: 2, tool_call_ids: ['call_0', 'call_1'] }),
    sig({ cleared: 5, added: 2, tool_call_ids: ['call_0', 'call_1'] }),
  );
  expect(
    'T8.8 去重键：总数 / 新增条数 / id 列表任一项变了 ⇒ 键不同',
    new Set([
      sig({ cleared: 5, added: 2, tool_call_ids: ['call_0', 'call_1'] }),
      sig({ cleared: 6, added: 2, tool_call_ids: ['call_0', 'call_1'] }),
      sig({ cleared: 5, added: 3, tool_call_ids: ['call_0', 'call_1'] }),
      sig({ cleared: 5, added: 2, tool_call_ids: ['call_1', 'call_0'] }),
    ]).size,
    4,
  );
  if (
    sig({ cleared: 5, added: 1, tool_call_ids: ['a|b'] }) !==
    sig({ cleared: 5, added: 2, tool_call_ids: ['a', 'b'] })
  )
    ok('T8.9 去重键不会把不同载荷撞成同一张卡（id 里带分隔符）');
  else fail('T8.9', '不同载荷拼出了同一个去重键');
}

/**
 * T7 的真 run 夹具：6 条工具结果（每条 ≈106 tokens）+ 窗口 1500 tokens。
 *
 * 5% 保留预算 = 75 tokens ⇒ 只留最近 1 条原文、清掉最旧 5 条（`call_0`..`call_4`）；
 * 20% 体积线 = 300 tokens，保留的 1 条只有 106 ⇒ 不会先被段起点压缩抢走判据。
 */
const TRIM_RUN_WINDOW = 1_500;
const TRIM_RUN_SESSION = 's-trim-run';

/** 内存事件日志（journal 需要它；本探针只看内存事件流）。 */
class TrimProbeEventLog implements SessionEventLogPort {
  private readonly rows: SessionEventRecord[] = [];

  async append(input: SessionEventInput): Promise<SessionEventRecord> {
    const record = { ...input, seq: this.rows.length + 1 } as unknown as SessionEventRecord;
    this.rows.push(record);
    return record;
  }

  async read(
    sessionId: string,
    opts?: { sinceSeq?: number; limit?: number },
  ): Promise<SessionEventRecord[]> {
    const since = opts?.sinceSeq ?? 0;
    const rows = this.rows.filter(
      (row) => (row as unknown as { session_id: string }).session_id === sessionId,
    );
    const tail = rows.filter((row) => (row as unknown as { seq: number }).seq > since);
    return opts?.limit === undefined ? tail : tail.slice(0, opts.limit);
  }

  lastPersistedSeq(sessionId: string): number | undefined {
    const rows = this.rows.filter(
      (row) => (row as unknown as { session_id: string }).session_id === sessionId,
    );
    const last = rows[rows.length - 1] as unknown as { seq: number } | undefined;
    return last?.seq;
  }

  async flush(): Promise<void> {}

  async sync(): Promise<void> {}

  async release(): Promise<void> {}
}

/**
 * 「不持久化 `cleared_tool_call_ids`」的 store —— 复现重复发卡的真实成因。
 *
 * 旧卡去重只靠这个落盘字段取差集（`fresh = ids - stored.cleared_tool_call_ids`）。
 * 后端不存这个 additive 字段时（旧 store / 只搬 messages 的宿主），每个段起点
 * `known` 都恒空 ⇒ `fresh` 恒等于全量 ⇒ 同一张卡一轮一轮重发。这个 store 就是那样
 * 一个后端：**只丢这一个字段**，其余照旧，保证 T7 的差异只来自去重逻辑本身。
 */
class ForgetfulStore extends FileSessionStore {
  override async save(state: SessionState): Promise<void> {
    const copy: SessionState = { ...state };
    delete copy.cleared_tool_call_ids;
    await super.save(copy);
  }
}

/** 一次就收尾的假 provider（本节不关心请求内容，只关心段起点发了什么卡）。 */
const DONE_PROVIDER: LLMProvider = {
  chat: async () => ({
    content: 'done',
    finish_reason: 'stop',
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }),
};

/** 一支 `read` 工具：种好的历史里有它的 tool_calls，注册上才算合法上下文。 */
function trimToolPlugin(): Plugin {
  return {
    name: 'probe-trim-tools',
    install(host): void {
      host.registerTool({
        name: 'read',
        description: 'probe tool（T7 不真的调用它）',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => 'probe',
      });
    },
  };
}

interface TrimRuntime {
  eu: ExecutionUnit;
  /** 本实例发布过的事件（按会话过滤见 `trimEventsOf`）。 */
  seen: { type?: string; data?: Record<string, unknown> }[];
  stop(): void;
}

async function startTrimRuntime(store: FileSessionStore): Promise<TrimRuntime> {
  const events = new MemoryEventStream();
  const log = new TrimProbeEventLog();
  const eu = await ExecutionUnit.create({
    provider: DONE_PROVIDER,
    model: 'probe/trim',
    contextFactory: () => {
      const context = new MemoryWorkingContext({
        maxTokens: TRIM_RUN_WINDOW,
        autoCompact: true,
      });
      // 不给 sessionId 会让 token 计数是 NaN（本节的判据与数量无关，但不该留 NaN）。
      context.setSessionId(TRIM_RUN_SESSION);
      return context;
    },
    events,
    limits: {},
    termination: {},
    journalFactory: createRunJournalFactory({ session: store as never, eventLog: log }),
    session: store as never,
    eventLog: log,
    plugins: [trimToolPlugin()],
    systemPrompt: 'probe system prompt for trim notice',
    retry: { maxRetries: 0 },
  });
  const seen: { type?: string; data?: Record<string, unknown> }[] = [];
  events.subscribe((event: unknown) => {
    seen.push(event as { type?: string; data?: Record<string, unknown> });
  });
  return { eu, seen, stop: () => eu.dispose?.() };
}

/** 落盘的 trim 卡（`vessel:notice` + 首行 scope `trim`，中英冒号都认）。 */
function trimCardsIn(state: SessionState | null | undefined): Message[] {
  return (state?.messages ?? []).filter(
    (message) => message.name === 'vessel:notice' && /^trim[：:]/.test(String(message.content)),
  );
}

function trimEventsOf(
  seen: readonly { type?: string; data?: Record<string, unknown> }[],
): { type?: string; data?: Record<string, unknown> }[] {
  return seen.filter((event) => event.type === 'context.cleared_tool_result');
}

/** 一轮跑完并把盘上的 SessionState 读回来（journal 的写是异步排队的）。 */
async function runAndWait(runtime: TrimRuntime, dir: string, input: string): Promise<SessionState> {
  await runtime.eu.run(input, TRIM_RUN_SESSION);
  for (let tick = 0; tick < 800; tick += 1) {
    const fresh = await new FileSessionStore(dir).load(TRIM_RUN_SESSION);
    if (fresh !== undefined && fresh !== null && fresh.status !== 'running') return fresh;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('session state 没有落盘');
}

await (async function checkDualScaleAndDedupe(): Promise<void> {
  // ① 事件载荷的两个口径：种好的会话里已有 call_0 / call_1 被清过（上一张卡讲过），
  //    本段起点规划清 call_0..call_4 ⇒ 总数 5、本轮新增 3（只讲没讲过的）。
  await (async function checkEventPayload(): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'vessel-trim-evt-'));
    try {
      const store = new FileSessionStore(dir);
      await store.save({
        ...baseState(TRIM_RUN_SESSION),
        messages: segmentBase(6),
        derived_upto_seq: 0,
        cleared_tool_call_ids: ['call_0', 'call_1'],
      } as SessionState);
      const runtime = await startTrimRuntime(store);
      try {
        const state = await runAndWait(runtime, dir, '继续读');
        const events = trimEventsOf(runtime.seen);
        expect('T8.10 一次段起点只发一条 trim 事件', events.length, 1);
        expect(
          'T8.11 事件 data：cleared = 总数 5、added = 本轮新增 3、kept = 1',
          [events[0]?.data?.['cleared'], events[0]?.data?.['added'], events[0]?.data?.['kept']],
          [5, 3, 1],
        );
        expect(
          'T8.12 事件 data.tool_call_ids 只有本轮新增的 3 条',
          events[0]?.data?.['tool_call_ids'],
          ['call_2', 'call_3', 'call_4'],
        );
        const summary = String(events[0]?.data?.['summary'] ?? '');
        const summaryLines = summary.split('\n');
        // 分层：首行（折叠态）= 增量 3，明细行（展开区）= 总数 5。
        if (
          (summaryLines[0] ?? '').includes(
            '3 older tool result(s) turned into placeholders this run',
          ) &&
          (summaryLines[1] ?? '').includes('5 cleared in this session')
        )
          ok('T8.13 事件 summary 分层：首行是增量 3，明细行是总数 5');
        else fail('T8.13', 'summary 层次不对：' + JSON.stringify(summaryLines));
        const cards = trimCardsIn(state);
        expect('T8.14 落盘里就一张 trim 卡', cards.length, 1);
        if (cards[0] !== undefined && String(cards[0].content) === summary)
          ok('T8.15 卡正文与事件 summary 逐字一致');
        else fail('T8.15', '卡正文与 summary 不一致：' + String(cards[0]?.content));
      } finally {
        runtime.stop();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();

  // ② 去重：后端不存 `cleared_tool_call_ids`（`fresh` 每轮都等于全量）⇒ 同样的卡
  //    第二轮必须**不再** append；换一个新实例（去重记忆为空）则照旧发 —— 反证
  //    这条断言抓得到「去重被删掉」，而不是「什么都不发」的假绿。
  await (async function checkDedupe(): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'vessel-trim-dedupe-'));
    try {
      const store = new ForgetfulStore(dir);
      await store.save({
        ...baseState(TRIM_RUN_SESSION),
        messages: segmentBase(6),
        derived_upto_seq: 0,
      } as SessionState);
      const first = await startTrimRuntime(store);
      let afterFirst: SessionState;
      try {
        afterFirst = await runAndWait(first, dir, '继续读');
        expect('T8.16 第一轮：发一条 trim 事件', trimEventsOf(first.seen).length, 1);
        expect('T8.17 第一轮：落盘一张 trim 卡', trimCardsIn(afterFirst).length, 1);
        expect(
          'T8.18 第一轮 added = cleared（上一张卡没讲过的全算新增）',
          [
            trimEventsOf(first.seen)[0]?.data?.['cleared'],
            trimEventsOf(first.seen)[0]?.data?.['added'],
          ],
          [5, 5],
        );

        // 第二轮：同一个实例、同样的窗口 ⇒ 同样的载荷（总数 5 / 新增 5 / 同样 5 个 id）。
        const afterSecond = await runAndWait(first, dir, '再继续');
        expect(
          'T8.19 第二轮同样的载荷 ⇒ 不再发 trim 事件（去重）',
          trimEventsOf(first.seen).length,
          1,
        );
        expect('T8.20 第二轮落盘里仍然只有那一张 trim 卡', trimCardsIn(afterSecond).length, 1);
      } finally {
        first.stop();
      }

      // 反证：新实例（去重记忆为空）对同一份状态、同一个窗口跑 ⇒ 又发了一张。
      const second = await startTrimRuntime(store);
      try {
        const afterThird = await runAndWait(second, dir, '再来一次');
        expect(
          'T8.21 反证：新实例（去重记忆为空）会再发一张卡',
          trimEventsOf(second.seen).length,
          1,
        );
        expect('T8.22 反证：盘上因此有两张 trim 卡', trimCardsIn(afterThird).length, 2);
      } finally {
        second.stop();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();
})();

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
