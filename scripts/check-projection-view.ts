#!/usr/bin/env bun
/**
 * 探针：`sessions.get` 的投影 wire（0.54 投影卡，服务端 additive）。
 *
 * 判的是**服务端那一趟两分支判定**（`docs/dev/handoff/projection-card-spec.md` §1.7），
 * 不是前端：这里直调 `sessions.get` handler，逐字节看它发出去什么。
 *
 *   T1 无投影 ⇒ wire 与今天**逐字节相同**：不带 `projection` / `truncated` / `projection_summary`；
 *   T2 正文已是占位（分支 A）⇒ `readback` + `placeholder_text` === 落盘正文（逐字），
 *      且**不靠**段级冻结集合（集合是空的也能靠正文自证认出来）；
 *   T3 正文是原文且 id 在冻结集合里（分支 B）⇒ `inline`，`placeholder_text` === core
 *      `formatClearedToolResult` 的输出（逐字相等）；反向断言：对已是占位的正文**不**再跑一遍
 *      （该函数不幂等：`4 lines` → `1 lines`，护在 `isClearedToolResult`）；
 *   T4 大正文（> 8 KiB）⇒ `inline_truncated`，`original_bytes` === **全文** UTF-8 字节数
 *      （不是裁剪后字节数），且占位文本用完整原文算（行数 / exit code 不许按 8 KiB 前缀算）；
 *   T5 切片窗口切掉 owning assistant ⇒ 工具名与首参摘要**不丢**（证明判定在 `all` 上跑），
 *      且 `projection_summary` 是**整会话**口径（含窗口外的条目）；
 *   T6 `mode:'passthrough'` 的条目**不出** `projection`（没被投射 = 与今天逐字节相同）；
 *   T7 `sessions.events` 的 `tool_call_id` 参数（readback 句柄的落点）仍在 params 里登记。
 *
 * 另外全程对齐两件事：
 *  - 每个响应都过一遍 `runStateSchema` 的结果校验（`validateResult`）—— 新字段登记了才算数；
 *  - **additive 兼容**：把新键（`projection` / `truncated` / `projection_summary`）剥掉之后，
 *    结果与今天逐字节相同（老客户端忽略未知键照旧工作）。
 *
 * 不接 gates（由 main 串）。用法：`bun run scripts/check-projection-view.ts`
 * 退出码：0 = 全过，1 = 有 FAIL。
 */

import {
  formatClearedToolResult,
  isClearedToolResult,
  type Message,
  type SessionState,
} from '../packages/core/src/index';
import { runStateSchema } from '../packages/serve/src/gateway/methods/schemas';
import { createSessionMethods } from '../packages/serve/src/gateway/methods/sessions';
import { validateResult } from '../packages/serve/src/rpc';
import {
  capToolMessages,
  TOOL_EVENT_PAYLOAD_LIMIT,
  TRUNCATED_MARKER,
} from '../packages/serve/src/tool-events';

const SESSION = 's-projection';
const encoder = new TextEncoder();

const failures: string[] = [];
let passed = 0;

function ok(label: string): void {
  passed += 1;
  console.log(`  ok  ${label}`);
}

function fail(label: string, detail: string): void {
  failures.push(`${label}：${detail}`);
  console.log(`  FAIL ${label}：${detail}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

function expect(label: string, actual: unknown, want: unknown): void {
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a === w) ok(label);
  else fail(label, `want ${w} got ${a}`);
}

function assertTrue(label: string, condition: boolean, detail: string): void {
  if (condition) ok(label);
  else fail(label, detail);
}

/** 逐字相等（不 JSON 序列化：占位文本里的换行 / 空格必须一个不差）。 */
function expectText(label: string, actual: unknown, want: string): void {
  if (typeof actual !== 'string') {
    fail(label, `want string, got ${JSON.stringify(actual)}`);
    return;
  }
  if (actual === want) {
    ok(label);
    return;
  }
  let at = 0;
  while (at < actual.length && at < want.length && actual[at] === want[at]) at += 1;
  fail(
    label,
    '逐字不等：差异起点 index=' +
      String(at) +
      ' got=' +
      JSON.stringify(actual.slice(Math.max(0, at - 12), at + 24)) +
      ' want=' +
      JSON.stringify(want.slice(Math.max(0, at - 12), at + 24)) +
      ' (got ' +
      String(actual.length) +
      ' chars / want ' +
      String(want.length) +
      ')',
  );
}

function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

function msg(role: Message['role'], content: string, extra: Partial<Message> = {}): Message {
  return { role, content, timestamp: 1_760_000_000_000, ...extra } as Message;
}

/** 一轮工具调用：assistant(tool_calls) + tool(正文)。 */
function round(id: string, name: string, args: string, result: string): Message[] {
  return [
    msg('assistant', '', {
      tool_calls: [{ id, type: 'function', function: { name, arguments: args } }],
    }),
    msg('tool', result, { tool_call_id: id }),
  ];
}

interface ProjectionWire {
  mode: string;
  tool_call_id: string;
  placeholder_text: string;
  placeholder_hash: string;
  original_bytes: number | null;
  original_lines: number | null;
  original_available: string;
  readback?: { kind: string; tool_call_id?: string; since_seq?: number };
  since_event_seq?: number;
  declaration_id: string | null;
}

interface MessageWire extends Message {
  projection?: ProjectionWire;
  truncated?: {
    content?: { bytes: number; limit: number; marker: string };
    arguments?: { bytes: number; limit: number; marker: string };
    arguments_calls?: number;
  };
}

interface SessionWire {
  messages: MessageWire[];
  messages_total?: number;
  projection_summary?: {
    total: number;
    bytes_saved: number;
    modes: Record<string, number>;
    unknown_original_count?: number;
  };
  [key: string]: unknown;
}

interface GetResult {
  session: SessionWire;
}

type Method = ReturnType<typeof createSessionMethods>[number];

/** 每场测试换一份「落盘状态」：handler 是同一份方法表，状态由 `sessionFor` 取。 */
let currentState: SessionState = {
  session_id: SESSION,
  created_at: 1_760_000_000_000,
  updated_at: 1_760_000_001_000,
  status: 'completed',
  messages: [],
};

const methods = createSessionMethods({
  sessionFor: () =>
    ({
      load: async (sessionId: string) => (sessionId === SESSION ? currentState : undefined),
    }) as never,
});

function findMethod(name: string): Method {
  const method = methods.find((item) => item.name === name);
  if (method === undefined) throw new Error(`找不到 RPC 方法 ${name}`);
  return method;
}

/** 调一次 `sessions.get`（直调 handler，与 gateway 同一份方法表）。 */
async function get(params: Record<string, unknown> = {}): Promise<SessionWire> {
  const result = (await findMethod('sessions.get').handler(
    { session_id: SESSION, ...params },
    {} as never,
  )) as GetResult;
  const session = result.session;
  // 每个响应都要能过登记过的 result_schema（否则「新字段登记了」是空话）。
  const violation = validateResult(runStateSchema, session);
  if (violation !== null) {
    failures.push(`schema：${violation.path} ${violation.message}`);
    console.log(`  FAIL schema：${violation.path} ${violation.message}`);
  }
  return session;
}

/** 剥掉 0.54 新增的键（= 老客户端看到的形状）。 */
function strip(message: MessageWire): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(message)) {
    if (key === 'projection' || key === 'truncated') continue;
    out[key] = value;
  }
  return out;
}

/** 一条工具消息上的投影（没有 = undefined）。 */
function projectionAt(session: SessionWire, toolCallId: string): ProjectionWire | undefined {
  return session.messages.find((message) => message.tool_call_id === toolCallId)?.projection;
}

/** 0.54 的新键是否出现过（= wire 不再与今天逐字节相同）。 */
function hasWireOnlyKeys(session: SessionWire): boolean {
  if ('projection_summary' in session) return true;
  return session.messages.some((message) => 'projection' in message || 'truncated' in message);
}

// ── T1：无投影 ⇒ wire 与今天逐字节相同 ─────────────────────────────────────

section('T1 无投影：不新增任何字段（sparse 生效，老客户端一字不改）');

{
  const stored: Message[] = [
    msg('system', '你是 Vessel 的具身成员。'),
    msg('user', '把这份文件读一遍。'),
    ...round('call_a', 'read', '{"path":"a.txt"}', 'A 文件正文（没被清）'),
  ];
  currentState = { ...currentState, messages: stored };

  const session = await get();
  expect('T1.1 messages_total 不变', session.messages_total, stored.length);
  expect(
    'T1.2 messages 与今天的 capToolMessages 输出逐字节相同',
    JSON.stringify(session.messages.map(strip)),
    JSON.stringify(capToolMessages(stored)),
  );
  assertTrue(
    'T1.3 没有任何 projection / truncated / projection_summary',
    !hasWireOnlyKeys(session),
    `出现了 0.54 的新键：${JSON.stringify(session.messages.map((m) => Object.keys(m)))}`,
  );
  assertTrue(
    'T1.4 序列化后与落盘逐字节相同',
    JSON.stringify(session.messages) === JSON.stringify(stored),
    `wire 与落盘不等：${JSON.stringify(session.messages)}`,
  );
}

// ── T2：分支 A（正文已是占位） ─────────────────────────────────────────────

section('T2 分支 A：正文已是占位 ⇒ readback，占位文本逐字搬（不看冻结集合）');

{
  // 段级冻结集合是**空**的（被覆盖写 / 归一成 undefined）：分支 A 只能靠正文自证。
  const storedPlaceholder = '[cleared bash: pnpm test --filter core -> exit 2, 4 lines]';
  const stored: Message[] = [
    msg('system', 'sys'),
    msg('user', '跑测试。'),
    ...round('call_b', 'bash', '{"command":"pnpm test --filter core"}', storedPlaceholder),
  ];
  currentState = { ...currentState, messages: stored, cleared_tool_call_ids: undefined };

  const session = await get();
  const projection = projectionAt(session, 'call_b');
  assertTrue(
    'T2.1 有投影（集合空也能认出来）',
    projection !== undefined,
    '这条占位正文没有拿到 projection',
  );
  if (projection !== undefined) {
    expect('T2.2 mode', projection.mode, 'placeholder');
    expect('T2.3 tool_call_id', projection.tool_call_id, 'call_b');
    expectText(
      'T2.4 placeholder_text === 落盘正文（逐字）',
      projection.placeholder_text,
      storedPlaceholder,
    );
    expect('T2.5 original_available', projection.original_available, 'readback');
    expect('T2.6 readback.kind', projection.readback?.kind, 'events');
    expect('T2.7 readback.tool_call_id', projection.readback?.tool_call_id, 'call_b');
    expect(
      'T2.8 readback.since_seq = 0（sessions.events 的排他游标默认值：从日志头找）',
      projection.readback?.since_seq,
      0,
    );
    expect(
      'T2.8b 不出现 from_seq（wire 上只留一个词）',
      projection.readback === undefined ? 'no-readback' : 'from_seq' in projection.readback,
      false,
    );
    expect('T2.9 original_bytes 未知就是 null（不写 0）', projection.original_bytes, null);
    expect('T2.10 original_lines 同上', projection.original_lines, null);
    expect(
      'T2.11 since_event_seq 缺省（本次没读事件日志，不写 0）',
      'since_event_seq' in projection,
      false,
    );
    expect('T2.12 declaration_id = null（没有声明）', projection.declaration_id, null);
    assertTrue(
      'T2.13 placeholder_hash 非空',
      typeof projection.placeholder_hash === 'string' && projection.placeholder_hash.length > 0,
      'placeholder_hash 缺失',
    );
  }
  // 落盘一个字都不改（投影是 wire-only 派生）。
  expect(
    'T2.14 落盘那条消息没被就地加键',
    Object.keys(currentState.messages?.[3] ?? {}).includes('projection'),
    false,
  );
  expect('T2.15 汇总口径（未知原文体量 ⇒ bytes_saved 不算它）', session.projection_summary, {
    total: 1,
    bytes_saved: 0,
    modes: { placeholder: 1 },
    unknown_original_count: 1,
  });
}

// ── T3：分支 B（正文原文 + 冻结集合命中），以及幂等护 ──────────────────────

section('T3 分支 B：用 core 同一个函数现算（逐字相等）；已是占位的不许再跑一遍');

{
  const original = 'Tests: 3 failed, 12 passed\nexit code: 2\n第三种失败原因\n最后一行';
  const stored: Message[] = [
    msg('system', 'sys'),
    msg('user', '跑测试。'),
    ...round('call_c', 'bash', '{"command":"pnpm test --filter core"}', original),
  ];
  currentState = { ...currentState, messages: stored, cleared_tool_call_ids: ['call_c'] };

  const session = await get();
  const projection = projectionAt(session, 'call_c');
  const expected = formatClearedToolResult(stored, 'call_c', original);
  assertTrue('T3.1 有投影', projection !== undefined, '冻结集合命中的原文没有拿到 projection');
  if (projection !== undefined) {
    expect('T3.2 mode', projection.mode, 'placeholder');
    expectText(
      'T3.3 placeholder_text === core 的输出（逐字）',
      projection.placeholder_text,
      expected,
    );
    expect('T3.4 original_available', projection.original_available, 'inline');
    expect('T3.5 original_bytes', projection.original_bytes, utf8Bytes(original));
    expect('T3.6 original_lines', projection.original_lines, original.split('\n').length);
    expect('T3.7 原文可用 ⇒ 不给 readback', 'readback' in projection, false);
    expectText(
      'T3.8 占位形状 = [cleared bash: pnpm test --filter core -> exit 2, 4 lines]',
      projection.placeholder_text,
      '[cleared bash: pnpm test --filter core -> exit 2, 4 lines]',
    );
  }
  expect('T3.9 落盘正文一个字不改', currentState.messages?.[3]?.content, original);

  // 反证：core 的 formatter 不幂等 —— 对已是占位的正文再跑一遍，行数会自降级。
  const again = formatClearedToolResult(stored, 'call_c', expected);
  assertTrue(
    `T3.10 反证：对占位正文再跑一遍会变（${again}）`,
    again !== expected,
    'core 已幂等，这条判别失效',
  );
  assertTrue('T3.11 isClearedToolResult 认得出占位', isClearedToolResult(expected), '护失效');

  // 反向断言：同一条正文，若落盘已经是占位、且 id 仍在冻结集合里，服务端必须走分支 A
  // （原样搬），不许重算成 `1 lines`。
  const repersisted: Message[] = [
    msg('system', 'sys'),
    msg('user', '跑测试。'),
    ...round('call_c', 'bash', '{"command":"pnpm test --filter core"}', expected),
  ];
  currentState = { ...currentState, messages: repersisted, cleared_tool_call_ids: ['call_c'] };
  const second = await get();
  const secondProjection = projectionAt(second, 'call_c');
  if (secondProjection === undefined) {
    fail('T3.12 已是占位的正文必须仍有投影', '拿不到 projection');
  } else {
    expectText('T3.12 已是占位 ⇒ 逐字搬，不重算', secondProjection.placeholder_text, expected);
    assertTrue(
      'T3.13 不许出现 1 lines（重算的指纹）',
      !secondProjection.placeholder_text.includes('1 lines'),
      `占位被重算了：${secondProjection.placeholder_text}`,
    );
    expect('T3.14 这种条目走 readback 分支', secondProjection.original_available, 'readback');
  }
}

// ── T4：大正文（> 8 KiB） ──────────────────────────────────────────────────

section('T4 大正文 > 8 KiB：inline_truncated + 原始体量按全文算 + 占位按全文算');

{
  // 4000 行 + exit code：行数与 exit 只可能来自**完整落盘原文**（8 KiB 前缀里没有它们）。
  const lines: string[] = [];
  for (let index = 0; index < 4000; index += 1) {
    lines.push(`log line ${String(index)} ${'x'.repeat(8)}`);
  }
  lines.push('exit code: 1');
  const original = lines.join('\n');
  const originalBytes = utf8Bytes(original);
  assertTrue(
    `T4.0 原文确实超过 8 KiB（${String(originalBytes)} B）`,
    originalBytes > TOOL_EVENT_PAYLOAD_LIMIT,
    '样本没有超过上限，这条测不到东西',
  );

  const stored: Message[] = [
    msg('system', 'sys'),
    msg('user', '跑构建。'),
    ...round('call_d', 'bash', '{"command":"pnpm build"}', original),
  ];
  currentState = { ...currentState, messages: stored, cleared_tool_call_ids: ['call_d'] };

  const session = await get();
  const projection = projectionAt(session, 'call_d');
  if (projection === undefined) {
    fail('T4.1 大正文没有拿到 projection', '');
  } else {
    expect('T4.1 original_available', projection.original_available, 'inline_truncated');
    expect(
      'T4.2 original_bytes === 全文 UTF-8 字节数（不是裁剪后）',
      projection.original_bytes,
      originalBytes,
    );
    expect('T4.3 original_lines === 全文行数', projection.original_lines, 4001);
    expectText(
      'T4.4 占位文本用完整原文算（含 exit 1 与 4001 lines）',
      projection.placeholder_text,
      '[cleared bash: pnpm build -> exit 1, 4001 lines]',
    );

    // 反证：拿 8 KiB 前缀算，行数与 exit code 都会算错 ⇒ 服务端不许用窗口正文算。
    const wire = session.messages.find((message) => message.tool_call_id === 'call_d');
    const wireContent = typeof wire?.content === 'string' ? wire.content : '';
    const degraded = formatClearedToolResult(stored, 'call_d', wireContent);
    assertTrue(
      `T4.5 反证：用裁剪后的正文算会错（${degraded}）`,
      degraded !== projection.placeholder_text,
      '用裁剪正文算出了同样的占位，这条判别失效',
    );
    assertTrue(
      'T4.6 正文仍按 8 KiB 裁（既有行为不变，标记照旧拼）',
      wireContent.endsWith(TRUNCATED_MARKER),
      `出站正文没有截断标记：${JSON.stringify(wireContent.slice(-40))}`,
    );
    expect('T4.7 truncated.content 结构化下发（bytes = 原文全量）', wire?.truncated?.content, {
      bytes: originalBytes,
      limit: TOOL_EVENT_PAYLOAD_LIMIT,
      marker: TRUNCATED_MARKER,
    });
    assertTrue(
      'T4.8 出站正文比原文短（真被裁了）',
      utf8Bytes(wireContent) < originalBytes,
      '出站正文没有被裁',
    );
  }
  const summary = session.projection_summary;
  assertTrue(
    'T4.9 汇总把这条计入 bytes_saved（下界 = 原字节 - 占位字节）',
    summary !== undefined && summary.bytes_saved > originalBytes - 200,
    `bytes_saved = ${JSON.stringify(summary?.bytes_saved)}`,
  );
  expect('T4.10 unknown_original_count = 0（体量已知）', summary?.unknown_original_count, 0);
}

// ── T5：窗口切掉 owning assistant ─────────────────────────────────────────

section('T5 窗口切掉 owning assistant：工具名与首参摘要不丢（判定在 all 上跑）');

{
  const stored: Message[] = [
    msg('system', 'sys'),
    msg('user', '先读 a，再构建。'),
    // 窗口外（更早）的一条：证明 summary 是整会话口径。
    ...round(
      'call_e_old',
      'read',
      '{"path":"a.txt"}',
      `A 的旧结果（${'x'.repeat(200)}）\nexit code: 0\n两行`,
    ),
    // 窗口内这条的 owning assistant 会被 `message_limit` 切掉。
    ...round(
      'call_e',
      'bash',
      '{"command":"pnpm build --filter core"}',
      `build 输出（${'y'.repeat(200)}）\nexit code: 2\n第三行`,
    ),
    msg('user', '继续。'),
  ];
  currentState = {
    ...currentState,
    messages: stored,
    cleared_tool_call_ids: ['call_e_old', 'call_e'],
  };

  // message_limit=2 ⇒ 窗口 = [tool(call_e), user]，owning assistant 在窗口外。
  const session = await get({ message_limit: 2 });
  expect('T5.1 窗口里没有 owning assistant', session.messages.length, 2);
  assertTrue(
    'T5.2 窗口里确实没有 owning assistant',
    !session.messages.some((message) =>
      (message.tool_calls ?? []).some((call) => call.id === 'call_e'),
    ),
    '窗口里还有那条 assistant',
  );
  assertTrue(
    'T5.3 窗口里没有那条旧工具结果',
    !session.messages.some((message) => message.tool_call_id === 'call_e_old'),
    '窗口里还有旧工具结果',
  );

  const projection = projectionAt(session, 'call_e');
  if (projection === undefined) {
    fail('T5.4 窗口里的工具消息没有投影', '窗口内拿不到 projection');
  } else {
    expectText(
      'T5.4 工具名与首参摘要没丢（在 all 上算）',
      projection.placeholder_text,
      '[cleared bash: pnpm build --filter core -> exit 2, 3 lines]',
    );
    // 反证：只在窗口上算会退化（spec §1.4 陷阱 3）。
    const degraded = formatClearedToolResult(
      session.messages,
      'call_e',
      `build 输出（${'y'.repeat(200)}）\nexit code: 2\n第三行`,
    );
    assertTrue(
      `T5.5 反证：只在窗口上算会丢（${degraded}）`,
      degraded !== projection.placeholder_text,
      '窗口上算也拿到了工具名，这条判别失效',
    );
  }
  const summary = session.projection_summary;
  expect(
    'T5.6 projection_summary 是整会话口径（含窗口外的条目）',
    { total: summary?.total, modes: summary?.modes, unknown: summary?.unknown_original_count },
    { total: 2, modes: { placeholder: 2 }, unknown: 0 },
  );
  assertTrue(
    'T5.7 两条的节省都算进了 bytes_saved（> 0）',
    (summary?.bytes_saved ?? 0) > 0,
    `bytes_saved = ${JSON.stringify(summary?.bytes_saved)}`,
  );
}

// ── T6：passthrough 条目不出 projection ───────────────────────────────────

section("T6 mode:'passthrough' 的条目不出 projection");

{
  const stored: Message[] = [
    msg('system', 'sys'),
    msg('user', '读一份没被清的文件，再列目录。'),
    ...round('call_f', 'read', '{"path":"b.txt"}', 'B 文件正文（没被清）'),
    ...round('call_g', 'bash', '{"command":"ls"}', 'a.txt\nb.txt\nexit code: 0\n四行'),
  ];
  currentState = { ...currentState, messages: stored, cleared_tool_call_ids: ['call_g'] };

  const session = await get();
  expect(
    'T6.1 没被清的条目没有 projection（passthrough 不发字段）',
    'projection' in (session.messages[3] ?? {}),
    false,
  );
  expect('T6.2 那条的正文原样出站', session.messages[3]?.content, 'B 文件正文（没被清）');
  expect('T6.3 被清的条目照常发', projectionAt(session, 'call_g')?.mode, 'placeholder');
  const modes = session.messages
    .map((message) => message.projection?.mode)
    .filter((mode): mode is string => mode !== undefined);
  expect("T6.4 出站里不出现 'passthrough'（没被投射 = 没有字段）", modes, ['placeholder']);
  expect('T6.5 汇总只登记出现过的 mode', session.projection_summary?.modes, {
    placeholder: 1,
  });
  const tiny = projectionAt(session, 'call_g');
  if (tiny === undefined || tiny.original_bytes === null) {
    fail('T6.6 bytes_saved 记净值', '拿不到 projection / original_bytes');
  } else {
    const net = tiny.original_bytes - utf8Bytes(tiny.placeholder_text);
    assertTrue(
      `T6.6 样本里占位比原文还长（净值为负：${String(net)} B）`,
      net < 0,
      '样本没能造出负净值，这条测不到 clamp',
    );
    expect(
      'T6.7 bytes_saved 记**净值**（负数照记，不 clamp 到 0）',
      session.projection_summary?.bytes_saved,
      net,
    );
  }
}

// ── T7：sessions.events 的 tool_call_id（readback 的落点） ────────────────

section('T7 readback 句柄对得上 sessions.events 的参数');

{
  const method = findMethod('sessions.events');
  const properties = ((method.params_schema ?? {}) as { properties?: Record<string, unknown> })
    .properties;
  assertTrue(
    'T7.1 sessions.events 登记 tool_call_id（按 id 读回原文）',
    properties !== undefined && 'tool_call_id' in properties,
    'params_schema 里没有 tool_call_id',
  );
  assertTrue(
    'T7.2 与 since_seq / types / limit 共存（分页语义不变）',
    properties !== undefined &&
      'since_seq' in properties &&
      'types' in properties &&
      'limit' in properties,
    'params_schema 少了既有分页参数',
  );
  assertTrue(
    'T7.3 sessions.events 没有 from_seq（线上只留一个词）',
    properties !== undefined && !('from_seq' in properties),
    'params_schema 里出现了 from_seq',
  );

  // 句柄的键名必须**就是**对端认的那个参数名：wire 上不该有两个词指同一个游标。
  currentState = {
    ...currentState,
    messages: [
      msg('system', 'sys'),
      msg('user', '跑测试。'),
      ...round(
        'call_h',
        'bash',
        '{"command":"pnpm test"}',
        '[cleared bash: pnpm test -> exit 2, 4 lines]',
      ),
    ],
    cleared_tool_call_ids: undefined,
  };
  const projection = projectionAt(await get(), 'call_h');
  if (projection?.readback === undefined) {
    fail('T7.4 readback 句柄存在', '拿不到 readback');
  } else {
    assertTrue(
      'T7.4 since_seq 就是 sessions.events 认得的那把钥匙（0 = 从日志头）',
      properties !== undefined && projection.readback.since_seq === 0 && 'since_seq' in properties,
      `readback.since_seq = ${JSON.stringify(projection.readback.since_seq)}`,
    );
    expect('T7.5 句柄里没有 from_seq', 'from_seq' in projection.readback, false);
  }
}

// ── 收口 ──────────────────────────────────────────────────────────────────

console.log('');
if (failures.length === 0) {
  console.log(`投影 wire 探针：全部通过（${String(passed)} 条断言）`);
  process.exit(0);
}
console.log(`投影 wire 探针：${String(failures.length)} 条失败 / ${String(passed)} 条通过`);
for (const failure of failures) console.log(`  - ${failure}`);
process.exit(1);
