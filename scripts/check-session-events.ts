#!/usr/bin/env bun
/**
 * `sessions.events` + `sessions.get.event_cursor` 探针（0.53 磁盘回填：design §3 方案 B + §7.1/§7.2）。
 *
 * 只跑不判产品口径，判的是**能不能拿它当回填依据**：
 *
 *   F1 空日志：`events: []` / `has_more: false` / 游标原样回传，不抛；
 *   F2 `since_seq` 排他：返回的第一条 `seq > since_seq`（等于 `since_seq` 的不回）；
 *   F3 分页连贯：`limit` 逐页 + `next_seq` 传回，拼起来**不重不漏**、`seq` 严格递增；
 *   F4 `types` 过滤：精确 + `*` 前缀，别的类型一条都不回，且游标照常前进；
 *   F5 坏行 / 截断行：日志里塞半行 JSON 与坏 JSON，RPC 不抛、跳过坏行、好行照常回；
 *   F6 `seq` 单调不重：整段扫描逐条 `+1`，与 `latest_seq` / `event_cursor` 自洽；
 *   F7 参数闸门：`limit` 默认 100 / 硬顶 500（501 → invalid_params）；端口未注入 → not_supported；
 *   F8 `sessions.get.event_cursor`：`last_seq` 来自文件尾、`derived_upto_seq` 来自 index，
 *      「派生落后」时两个数不同；index 坏了只丢派生数，`last_seq` 仍然给；
 *      没落过事件的会话**不带**这个字段（旧字段语义一字不改）。
 *
 * 用完即弃：日志写在系统临时目录，跑完删掉。退出码 0 = 全过。
 */

import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionEventLog, sessionIndexFilePath } from '../packages/core/src/index';
import { createSessionMethods } from '../packages/serve/src/gateway/methods/sessions';
import { createSessionEventsSource } from '../src/session-events';

interface Failure {
  case: string;
  detail: string;
}

const failures: Failure[] = [];
let checks = 0;

function expect(condition: boolean, testCase: string, detail: string): void {
  checks += 1;
  if (!condition) failures.push({ case: testCase, detail });
}

const SESSION = 's-events';
const EMPTY_SESSION = 's-empty';
const NOW = 1_760_000_000_000;

/** 12 条事件，类型交错，正文大小不一（模拟真实会话）。 */
const APPENDED: { type: string; data: unknown }[] = [
  { type: 'run.started', data: { run: 1 } },
  { type: 'user.message', data: { text: 'hi' } },
  { type: 'tool.call.started', data: { tool: 'bash' } },
  { type: 'tool.call.completed', data: { tool: 'bash', output: 'ok' } },
  { type: 'llm.request', data: { model: 'x' } },
  { type: 'assistant.message', data: { text: 'done 1' } },
  { type: 'run.completed', data: { run: 1 } },
  { type: 'run.started', data: { run: 2 } },
  { type: 'tool.call.started', data: { tool: 'read' } },
  { type: 'tool.call.completed', data: { tool: 'read', output: 'x'.repeat(64) } },
  { type: 'assistant.message', data: { text: 'done 2' } },
  { type: 'run.completed', data: { run: 2 } },
];

type Methods = ReturnType<typeof createSessionMethods>;

interface RpcFailure {
  code: string;
  message: string;
}

function findMethod(methods: Methods, name: string) {
  const method = methods.find((item) => item.name === name);
  if (!method) throw new Error(`找不到 RPC 方法 ${name}`);
  return method;
}

/** 调一次 `sessions.events`；失败时把 `RpcError.code` 带回（探针要判闸门）。 */
async function callEvents(
  methods: Methods,
  params: Record<string, unknown>,
): Promise<{ ok: true; result: SessionEventsResult } | { ok: false; error: RpcFailure }> {
  try {
    const result = (await findMethod(methods, 'sessions.events').handler(
      { session_id: SESSION, ...params },
      {} as never,
    )) as SessionEventsResult;
    return { ok: true, result };
  } catch (error) {
    const failure = error as { code?: unknown; message?: unknown };
    return {
      ok: false,
      error: {
        code: typeof failure.code === 'string' ? failure.code : 'unknown',
        message: typeof failure.message === 'string' ? failure.message : String(error),
      },
    };
  }
}

interface SessionEventView {
  seq: number;
  type: string;
  ts: number;
  run_id?: string;
  data?: unknown;
}

interface SessionEventsResult {
  events: SessionEventView[];
  next_seq: number;
  latest_seq: number;
  has_more: boolean;
}

const workDir = await mkdtemp(join(tmpdir(), 'vessel-session-events-probe-'));
const sessionsDir = join(workDir, 'sessions');

try {
  const log = new SessionEventLog({ dir: sessionsDir, durable: false });
  const eventsFile = (sessionId: string) =>
    join(sessionsDir, encodeURIComponent(sessionId), 'events.ndjson');

  for (const [index, item] of APPENDED.entries()) {
    await log.append({
      session_id: SESSION,
      run_id: item.type.startsWith('run.') ? `run-${String(index)}` : 'run-0',
      type: item.type,
      ts: NOW + index,
      data: item.data,
    });
  }

  const source = createSessionEventsSource({ log, eventsFile });
  // 真实会话的 `index.json` 由派生层写（append 本身不写）：探针照实模拟一次「派生追平」。
  await log.updateIndex(SESSION, {});
  const sessions = [{ session_id: SESSION }, { session_id: EMPTY_SESSION }];

  const buildMethods = (withEvents: boolean): Methods =>
    createSessionMethods({
      sessionFor: () =>
        ({
          // `sessions.events` / `sessions.get` 走同一条存在性口径。
          load: async (sessionId: string) => sessions.find((item) => item.session_id === sessionId),
        }) as never,
      ...(withEvents ? { sessionEvents: source } : {}),
    });

  const methods = buildMethods(true);
  const total = APPENDED.length;

  // ── F1 空日志 ────────────────────────────────────────────────────────────
  const empty = await findMethod(methods, 'sessions.events').handler(
    { session_id: EMPTY_SESSION },
    {} as never,
  );
  const emptyResult = empty as SessionEventsResult;
  expect(
    Array.isArray(emptyResult.events) && emptyResult.events.length === 0,
    'F1',
    '空日志必须回 events: []',
  );
  expect(emptyResult.has_more === false, 'F1', '空日志不能 has_more');
  expect(
    emptyResult.next_seq === 0,
    'F1',
    `空日志 next_seq 应为 0，实际 ${String(emptyResult.next_seq)}`,
  );
  expect(
    emptyResult.latest_seq === 0,
    'F1',
    `空日志 latest_seq 应为 0，实际 ${String(emptyResult.latest_seq)}`,
  );

  // ── F2 since_seq 排他 ────────────────────────────────────────────────────
  const afterThree = await callEvents(methods, { since_seq: 3 });
  if (!afterThree.ok) {
    expect(
      false,
      'F2',
      `since_seq=3 调用失败：${afterThree.error.code} ${afterThree.error.message}`,
    );
  } else {
    const first = afterThree.result.events[0];
    expect(
      first !== undefined && first.seq === 4,
      'F2',
      `since_seq=3 的第一条应为 seq=4，实际 ${String(first?.seq)}`,
    );
    expect(
      afterThree.result.events.every((event) => event.seq > 3),
      'F2',
      'since_seq 必须是排他游标：不能回 seq <= since_seq 的事件',
    );
  }

  const atEnd = await callEvents(methods, { since_seq: total });
  if (!atEnd.ok) {
    expect(false, 'F2', `since_seq=末条 调用失败：${atEnd.error.code}`);
  } else {
    expect(
      atEnd.result.events.length === 0 && atEnd.result.has_more === false,
      'F2',
      '追平之后必须回空页',
    );
    expect(atEnd.result.next_seq === total, 'F2', '追平之后 next_seq 必须原样停在游标上');
  }

  // ── F3 分页连贯 / F6 seq 单调不重 / F4 types 过滤 ────────────────────────
  const pageSize = 3;
  const seen: number[] = [];
  let cursor = 0;
  let pages = 0;
  let monotone = true;
  let pageOk = true;
  for (;;) {
    const page = await callEvents(methods, { since_seq: cursor, limit: pageSize });
    pages += 1;
    if (!page.ok) {
      pageOk = false;
      expect(
        false,
        'F3',
        `第 ${String(pages)} 页调用失败：${page.error.code} ${page.error.message}`,
      );
      break;
    }
    if (page.result.events.length > pageSize) {
      expect(
        false,
        'F3',
        `第 ${String(pages)} 页超过 limit：${String(page.result.events.length)} > ${String(pageSize)}`,
      );
    }
    for (const event of page.result.events) {
      const previous = seen[seen.length - 1];
      if (previous !== undefined && event.seq <= previous) monotone = false;
      seen.push(event.seq);
    }
    if (!page.result.has_more) break;
    if (page.result.next_seq <= cursor) {
      expect(false, 'F3', 'has_more=true 但 next_seq 没前进（会死循环）');
      break;
    }
    cursor = page.result.next_seq;
    if (pages > total + 2) {
      expect(false, 'F3', '分页停不下来（游标没推进）');
      break;
    }
  }
  expect(pages > 1, 'F3', `limit=${String(pageSize)} 时应该翻多页，实际 ${String(pages)} 页`);
  expect(
    seen.length === total,
    'F3',
    `分页拼起来应正好 ${String(total)} 条，实际 ${String(seen.length)} 条（重或漏）`,
  );
  expect(new Set(seen).size === seen.length, 'F3', '分页出现重复 seq');
  expect(
    seen.every((seq, index) => seq === index + 1),
    'F3',
    `分页 seq 必须是 1..${String(total)} 的连续序列，实际 ${seen.join(',')}`,
  );
  expect(monotone, 'F6', 'seq 必须严格单调递增（否则前端无法按 seq 幂等合并）');
  expect(pageOk, 'F3', '分页过程中出现调用失败');

  // 硬顶：limit=500 不报错、limit=501 拒绝（与 sessions.get.message_limit 同风格）。
  const maxPage = await callEvents(methods, { since_seq: 0, limit: 500 });
  expect(maxPage.ok, 'F7', 'limit=500 是硬顶，不应被拒');
  const overPage = await callEvents(methods, { since_seq: 0, limit: 501 });
  expect(
    !overPage.ok && overPage.error.code === 'invalid_params',
    'F7',
    'limit=501 必须 invalid_params',
  );
  const zeroPage = await callEvents(methods, { since_seq: 0, limit: 0 });
  expect(
    !zeroPage.ok && zeroPage.error.code === 'invalid_params',
    'F7',
    'limit=0 必须 invalid_params',
  );
  const defaultPage = await callEvents(methods, {});
  expect(
    defaultPage.ok && defaultPage.result.events.length === Math.min(100, total),
    'F7',
    '缺省 limit 应为 100（这里是全量 100 条以内 ⇒ 一次回完）',
  );
  expect(
    defaultPage.ok && defaultPage.result.latest_seq === total,
    'F7',
    `latest_seq 应等于日志尾 seq=${String(total)}`,
  );

  // F4：`*` 前缀与精确两种写法，回的都是同一批事件；游标照常前进。
  const toolOnly = await callEvents(methods, { types: ['tool.*'], limit: 500 });
  if (!toolOnly.ok) {
    expect(false, 'F4', `types 过滤调用失败：${toolOnly.error.code}`);
  } else {
    const toolSeqs = APPENDED.flatMap((item, index) =>
      item.type.startsWith('tool.') ? [index + 1] : [],
    );
    expect(
      toolOnly.result.events.map((event) => event.seq).join(',') === toolSeqs.join(','),
      'F4',
      `types=['tool.*'] 应只回 seq=${toolSeqs.join(',')}，实际 ${toolOnly.result.events.map((event) => event.seq).join(',')}`,
    );
    expect(
      toolOnly.result.events.every((event) => event.type.startsWith('tool.')),
      'F4',
      'types 过滤漏了别的类型',
    );
    expect(
      toolOnly.result.next_seq === total,
      'F4',
      `过滤后游标仍应推到扫到的位置（${String(total)}），实际 ${String(toolOnly.result.next_seq)}`,
    );
  }

  const exact = await callEvents(methods, { types: ['run.completed'], limit: 500 });
  expect(
    exact.ok && exact.result.events.length === 2,
    'F4',
    `types=['run.completed'] 应回 2 条，实际 ${String(exact.ok ? exact.result.events.length : -1)}`,
  );

  const filteredEmpty = await callEvents(methods, { types: ['nope.nothing'], limit: 5 });
  expect(
    filteredEmpty.ok &&
      filteredEmpty.result.events.length === 0 &&
      filteredEmpty.result.has_more === false,
    'F4',
    '不匹配的类型必须回空页且 has_more=false',
  );

  // 过滤 + 分页：溢出时游标必须停在「已返回的最后一条」，否则翻页会丢事件。
  const filteredFirst = await callEvents(methods, { types: ['run.started'], limit: 1 });
  const filteredFirstSeqs = filteredFirst.ok
    ? filteredFirst.result.events.map((event) => event.seq).join(',')
    : 'ERR';
  expect(
    filteredFirstSeqs === '1' &&
      filteredFirst.ok &&
      filteredFirst.result.next_seq === 1 &&
      filteredFirst.result.has_more,
    'F4',
    `types+limit=1 第一页应为 seq=1 / next_seq=1 / has_more，实际 ${filteredFirstSeqs} / ${String(filteredFirst.ok ? filteredFirst.result.next_seq : -1)} / ${String(filteredFirst.ok ? filteredFirst.result.has_more : false)}`,
  );
  const filteredSecond = await callEvents(methods, {
    types: ['run.started'],
    limit: 1,
    since_seq: 1,
  });
  const filteredSecondSeqs = filteredSecond.ok
    ? filteredSecond.result.events.map((event) => event.seq).join(',')
    : 'ERR';
  expect(
    filteredSecondSeqs === '8' &&
      filteredSecond.ok &&
      filteredSecond.result.next_seq === total &&
      filteredSecond.result.has_more === false,
    'F4',
    `types+limit=1 第二页应为 seq=8 且游标推到扫到的位置 ${String(total)}（被过滤掉的不必再扫）/ 无下一页，实际 ${filteredSecondSeqs} / ${String(filteredSecond.ok ? filteredSecond.result.next_seq : -1)} / ${String(filteredSecond.ok ? filteredSecond.result.has_more : false)}`,
  );

  // ── F8 sessions.get.event_cursor ────────────────────────────────────────
  const get = async (sessionId: string) =>
    (await findMethod(methods, 'sessions.get').handler({ session_id: sessionId }, {} as never)) as {
      session: {
        event_cursor?: { last_seq: number; derived_upto_seq?: number; event_count?: number };
      };
    };

  const withCursor = await get(SESSION);
  const eventCursor = withCursor.session.event_cursor;
  expect(eventCursor !== undefined, 'F8', 'sessions.get 应带 event_cursor');
  expect(
    eventCursor?.last_seq === total,
    'F8',
    `event_cursor.last_seq 应为 ${String(total)}，实际 ${String(eventCursor?.last_seq)}`,
  );
  expect(
    typeof eventCursor?.derived_upto_seq === 'number' &&
      typeof eventCursor?.event_count === 'number',
    'F8',
    'index 正常时 derived_upto_seq / event_count 都该在',
  );

  const emptyCursor = await get(EMPTY_SESSION);
  expect(
    emptyCursor.session.event_cursor === undefined,
    'F8',
    '没落过事件的会话不能带 event_cursor（缺省 = 没有日志，不是 0）',
  );

  // 派生落后（崩在派生中间）：把 index 的 derived_upto_seq 改小，last_seq 必须仍然来自文件尾。
  await log.updateIndex(SESSION, { derived_upto_seq: 5, event_count: total });
  // 换一个实例绕开写入进程内的缓存（真实场景是 gateway 重启后第一次读）。
  const freshSource = createSessionEventsSource({ log, eventsFile });
  const freshMethods = createSessionMethods({
    sessionFor: () =>
      ({
        load: async (sessionId: string) => sessions.find((item) => item.session_id === sessionId),
      }) as never,
    sessionEvents: freshSource,
  });
  const lagging = (await findMethod(freshMethods, 'sessions.get').handler(
    { session_id: SESSION },
    {} as never,
  )) as { session: { event_cursor?: { last_seq: number; derived_upto_seq?: number } } };
  expect(
    lagging.session.event_cursor?.last_seq === total,
    'F8',
    `index 里 derived 落后时 last_seq 仍必须来自文件尾（${String(total)}），实际 ${String(lagging.session.event_cursor?.last_seq)}`,
  );
  expect(
    lagging.session.event_cursor?.derived_upto_seq === 5,
    'F8',
    `derived_upto_seq 应原样透出 index 里的 5，实际 ${String(lagging.session.event_cursor?.derived_upto_seq)}`,
  );

  // index 坏掉：只丢派生数，last_seq 仍然给（否则前端会以为「没有日志」而丢掉整段历史）。
  await writeFile(sessionIndexFilePath(sessionsDir, SESSION), '{ 这不是 JSON', 'utf8');
  const brokenIndexSource = createSessionEventsSource({ log, eventsFile });
  const brokenIndexMethods = createSessionMethods({
    sessionFor: () =>
      ({
        load: async (sessionId: string) => sessions.find((item) => item.session_id === sessionId),
      }) as never,
    sessionEvents: brokenIndexSource,
  });
  const brokenCursor = (await findMethod(brokenIndexMethods, 'sessions.get').handler(
    { session_id: SESSION },
    {} as never,
  )) as {
    session: {
      event_cursor?: { last_seq: number; derived_upto_seq?: number; event_count?: number };
    };
  };
  expect(
    brokenCursor.session.event_cursor?.last_seq === total,
    'F8',
    'index 坏了路径也必须回 last_seq（从文件尾定边界，不依赖索引）',
  );
  expect(
    brokenCursor.session.event_cursor?.derived_upto_seq === undefined,
    'F8',
    'index 坏了不能编一个 derived_upto_seq',
  );

  // ── F5 坏行 / 截断行 ────────────────────────────────────────────────────
  // 半行（进程被杀）+ 坏 JSON（旧版本/错写）都必须跳过，好行照常回，且整体不抛。
  const target = eventsFile(SESSION);
  await appendFile(target, '{"v":1,"session_id":"s-events","run_id":"r","se', 'utf8');
  await appendFile(target, '\n{ 坏 JSON 不是事件 }\n', 'utf8');
  await appendFile(
    target,
    `${JSON.stringify({ v: 1, session_id: SESSION, run_id: 'run-9', type: 'run.completed', ts: NOW + 99, data: { run: 9 }, seq: total + 1 })}\n`,
    'utf8',
  );

  const afterCorruption = await callEvents(methods, { since_seq: 0, limit: 500 });
  expect(
    afterCorruption.ok,
    'F5',
    `日志有坏行时不能抛：${afterCorruption.ok ? '' : afterCorruption.error.message}`,
  );
  if (afterCorruption.ok) {
    const seqs = afterCorruption.result.events.map((event) => event.seq);
    expect(
      seqs.length === total + 1,
      'F5',
      `坏行应被跳过、好行照常回（预期 ${String(total + 1)} 条，实际 ${String(seqs.length)}）`,
    );
    expect(
      seqs.every((seq, index) => index === 0 || seq > (seqs[index - 1] ?? 0)),
      'F5',
      '坏行之后 seq 仍然必须严格递增',
    );
    expect(afterCorruption.result.latest_seq === total + 1, 'F5', '坏行不能把 latest_seq 带偏');
  }

  // ── F7 端口未注入 ───────────────────────────────────────────────────────
  const bare = buildMethods(false);
  const bareEvents = await (async () => {
    try {
      await findMethod(bare, 'sessions.events').handler({ session_id: SESSION }, {} as never);
      return undefined;
    } catch (error) {
      return error as { code?: unknown };
    }
  })();
  expect(
    bareEvents?.code === 'not_supported',
    'F7',
    '端口未注入时 sessions.events 必须 not_supported（不能假装空日志）',
  );
  const bareGet = (await findMethod(bare, 'sessions.get').handler(
    { session_id: SESSION },
    {} as never,
  )) as { session: { event_cursor?: unknown } };
  expect(
    bareGet.session.event_cursor === undefined,
    'F7',
    '端口未注入时 sessions.get 不能带 event_cursor',
  );

  // ── 收尾 ────────────────────────────────────────────────────────────────
  if (failures.length > 0) {
    console.error(
      `✗ check-session-events: ${String(failures.length)} 项失败（共 ${String(checks)} 项断言）`,
    );
    for (const failure of failures) {
      console.error(`  [${failure.case}] ${failure.detail}`);
    }
    process.exitCode = 1;
  } else {
    console.log(
      `✓ check-session-events: ${String(checks)} 项断言通过（空日志 / 排他游标 / 分页不重不漏 / types 过滤 / 坏行降级 / seq 单调 / 参数闸门 / event_cursor）`,
    );
  }
} finally {
  await rm(workDir, { recursive: true, force: true });
}
