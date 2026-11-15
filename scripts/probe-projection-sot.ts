#!/usr/bin/env bun
/**
 * probe-projection-sot.ts — 只读探针（不属于 gates，不接 package.json）
 *
 * 问题：压缩（开新段）之后，`sessions.get` 读回来的工具消息正文是**原文**还是 `[cleared ...]` **占位**？
 *
 * 三个模式（互不影响，可叠加）：
 *   1) `--data-dir <dir>`  扫描真实 data 目录（**只读**）：找 events.ndjson 里有 `message.compaction`
 *      事件、且压缩之后还有 run 的会话，逐条比对 `<sid>.json`（= `sessions.get` 的取数来源）
 *      里的 tool 消息 vs 事件里 `tool.call.completed.data.result` 原文。
 *   2) `--construct`       在 os.tmpdir() 里造隔离样本（真实 file backend + 真实工具执行）。
 *      绝不写默认 data 目录。子场景见 SCENARIOS。
 *   3) `--idempotency`     把 `formatClearedToolResult` 对「已是占位」的正文再跑一次，比对前/后。
 *
 * 用法：
 *   bun scripts/probe-projection-sot.ts --construct
 *   bun scripts/probe-projection-sot.ts --idempotency
 *   bun scripts/probe-projection-sot.ts --data-dir "C:/Users/<you>/.vessel/data"
 *   bun scripts/probe-projection-sot.ts --all --data-dir "<...>"
 */

import { mkdtemp, readdir, readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type ChatRequest,
  createRunJournalFactory,
  ExecutionUnit,
  FileSessionStore,
  formatClearedToolResult,
  isClearedToolResult,
  type LLMProvider,
  type LLMResponse,
  MemoryEventStream,
  MemoryWorkingContext,
  type Message,
  type Plugin,
  type PluginHost,
  planClearedToolResults,
  projectMessages,
  SessionEventLog,
  type ToolDefinition,
  withClearedToolResults,
} from '../packages/core/src/index';
import { capToolMessages } from '../packages/serve/src/tool-events';

/**
 * 真的走一遍 `sessions.get` 的 handler（`createSessionMethods` 里那条），
 * 这样「读回来的正文」不是探针自己拼的，而是产品读路径给的。
 * 注意：packages/serve 里有 `@vessel-agent/core` 裸包名，脚本直跑可能解析不了；
 * 失败时退回 `capToolMessages(SessionState.messages)`（= handler 里同样三行，见 doc）。
 */
let sessionsGetHandlerUsed = false;
let sessionsGetHandlerError: string | undefined;
let sessionMethodsCache: unknown;
async function sessionsGetMessages(
  store: FileSessionStore,
  sessionId: string,
  messageLimit: number,
): Promise<Message[] | undefined> {
  try {
    if (sessionMethodsCache === undefined) {
      const mod = (await import('../packages/serve/src/gateway/methods/sessions')) as {
        createSessionMethods: (
          deps: unknown,
        ) => Array<{ name: string; handler: (params: unknown, ctx: unknown) => unknown }>;
      };
      sessionMethodsCache = mod.createSessionMethods;
    }
    const factory = sessionMethodsCache as (deps: unknown) => Array<{
      name: string;
      handler: (params: unknown, ctx: unknown) => unknown;
    }>;
    const methods = factory({ sessionFor: () => store });
    const method = methods.find((m) => m.name === 'sessions.get');
    if (method === undefined) return undefined;
    const result = (await method.handler(
      { session_id: sessionId, message_limit: Math.min(messageLimit, 500) },
      undefined,
    )) as { session?: { messages?: Message[] } };
    sessionsGetHandlerUsed = true;
    return result.session?.messages;
  } catch (error) {
    const message = String(error).split('\n')[0] ?? String(error);
    if (sessionsGetHandlerError !== message) {
      sessionsGetHandlerError = message;
      console.log(
        `  [diag] sessions.get handler 直调不可用，改用 capToolMessages(state.messages)：${message.slice(0, 140)}`,
      );
    }
    return undefined;
  }
}

async function getViewOf(
  store: FileSessionStore,
  sessionId: string,
  fallback: readonly Message[],
): Promise<Message[]> {
  const view = await sessionsGetMessages(store, sessionId, 500);
  if (view !== undefined) return view;
  return capToolMessages([...fallback] as Message[]);
}

// ---------------------------------------------------------------------------
// 样本正文（确定性：两侧可比对，肉眼可定位）
// ---------------------------------------------------------------------------

const TOOL_NAME = 'probe_echo';

/** 第 n 条工具结果：带唯一标记 + 多行，长度 ~300 字符（够触发 5% 预算的清理）。 */
function rawToolResult(n: number): string {
  const lines: string[] = [`RAWTOOL#${String(n).padStart(2, '0')} 这是第 ${n} 条工具结果的原文`];
  for (let i = 1; i <= 12; i += 1) {
    lines.push(
      `  line ${i}: rawwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww ${n}-${i}`,
    );
  }
  return lines.join('\n');
}

function toolCallTurn(ids: number[]): LLMResponse {
  return {
    content: '',
    finish_reason: 'tool_calls',
    tool_calls: ids.map((n) => ({
      id: `call_${n}`,
      type: 'function' as const,
      function: { name: TOOL_NAME, arguments: JSON.stringify({ n }) },
    })),
  };
}

function textTurn(text: string): LLMResponse {
  return { content: text, finish_reason: 'stop' };
}

// ---------------------------------------------------------------------------
// 记录型 provider / 工具插件
// ---------------------------------------------------------------------------

class ScriptedProvider implements LLMProvider {
  readonly queue: LLMResponse[] = [];
  readonly requests: ChatRequest[] = [];
  push(...responses: LLMResponse[]): void {
    this.queue.push(...responses);
  }
  async chat(request: ChatRequest): Promise<LLMResponse> {
    // 只留一份消息快照（request 里有不可克隆的句柄，别 whole-object clone）
    this.requests.push({ ...request, messages: request.messages.map((m) => ({ ...m })) });
    const next = this.queue.shift();
    if (next === undefined) throw new Error('ScriptedProvider: 脚本已用完');
    return next;
  }
}

function echoPlugin(): Plugin {
  return {
    name: 'probe-projection-sot-tools',
    version: '0.0.0',
    install(host: PluginHost): void {
      const echo: ToolDefinition = {
        name: TOOL_NAME,
        description: 'return a deterministic multi-line text (probe)',
        inputSchema: {
          type: 'object',
          properties: { n: { type: 'number' } },
          required: ['n'],
          additionalProperties: false,
        },
        handler: async (args: unknown): Promise<string> =>
          rawToolResult(Number((args as { n: number }).n)),
      };
      host.registerTool(echo);
    },
  };
}

// ---------------------------------------------------------------------------
// 度量：落盘（= sessions.get 取数来源）逐条比对
// ---------------------------------------------------------------------------

type Kind = 'raw' | 'placeholder' | 'other';

interface Row {
  toolCallId: string;
  kind: Kind;
  persistedChars: number;
  rawChars: number;
  note: string;
}

interface Measurement {
  scenario: string;
  sessionId: string;
  stateMessages: number;
  toolMessages: number;
  raw: number;
  placeholder: number;
  other: number;
  /** `sessions.get` 视图：capToolMessages(SessionState.messages) 里占位条数。 */
  getViewPlaceholder: number;
  /** 最近一次 LLM 请求（= 真正送进模型的窗口）里占位条数。 */
  requestPlaceholder: number;
  stateClearedIds: number;
  rows: Row[];
}

function classify(messages: readonly Message[], rawById: Map<string, string>): Row[] {
  const rows: Row[] = [];
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    const id = typeof message.tool_call_id === 'string' ? message.tool_call_id : '(none)';
    const content = message.content ?? '';
    const raw = rawById.get(id);
    if (raw === undefined) continue;
    const placeholder = formatClearedToolResult(messages, id, raw);
    if (content === raw) {
      rows.push({
        toolCallId: id,
        kind: 'raw',
        persistedChars: content.length,
        rawChars: raw.length,
        note: '',
      });
      continue;
    }
    if (content === placeholder) {
      rows.push({
        toolCallId: id,
        kind: 'placeholder',
        persistedChars: content.length,
        rawChars: raw.length,
        note: '',
      });
      continue;
    }
    if (isClearedToolResult(content)) {
      rows.push({
        toolCallId: id,
        kind: 'placeholder',
        persistedChars: content.length,
        rawChars: raw.length,
        note: '占位但与本仓 formatClearedToolResult 输出不同（旧版本写的？）',
      });
      continue;
    }
    rows.push({
      toolCallId: id,
      kind: 'other',
      persistedChars: content.length,
      rawChars: raw.length,
      note: `persisted[0..60]=${JSON.stringify(content.slice(0, 60))} raw[0..60]=${JSON.stringify(raw.slice(0, 60))}`,
    });
  }
  return rows;
}

function summarize(
  scenario: string,
  sessionId: string,
  stateMessages: readonly Message[],
  rawById: Map<string, string>,
  stateClearedIds: number,
  requestPlaceholder: number,
  getViewMessages?: readonly Message[],
): Measurement {
  const rows = classify(stateMessages, rawById);
  const getView = capToolMessages([...(getViewMessages ?? stateMessages)] as Message[]);
  const getViewPlaceholder = getView.filter(
    (m) => m.role === 'tool' && isClearedToolResult(m.content ?? ''),
  ).length;
  return {
    scenario,
    sessionId,
    stateMessages: stateMessages.length,
    toolMessages: rows.length,
    raw: rows.filter((r) => r.kind === 'raw').length,
    placeholder: rows.filter((r) => r.kind === 'placeholder').length,
    other: rows.filter((r) => r.kind === 'other').length,
    getViewPlaceholder,
    requestPlaceholder,
    stateClearedIds,
    rows,
  };
}

function printMeasurement(m: Measurement): void {
  const total = m.toolMessages;
  const pct = total === 0 ? 'n/a' : `${Math.round((m.placeholder / total) * 1000) / 10}%`;
  console.log(`\n--- ${m.scenario} (session=${m.sessionId.slice(0, 12)}) ---`);
  console.log(
    `  SessionState.messages=${m.stateMessages}  工具消息=${total}  原文=${m.raw}  占位=${m.placeholder} (${pct})  其他=${m.other}`,
  );
  console.log(
    `  SessionState.cleared_tool_call_ids=${m.stateClearedIds}  sessions.get 视图里占位=${m.getViewPlaceholder}` +
      `  最近一次请求里占位=${m.scenario.startsWith('real:') ? 'n/a（只读扫描不跑 run）' : String(m.requestPlaceholder)}`,
  );
  for (const row of m.rows.slice(0, 100)) {
    if (row.kind === 'raw') continue;
    console.log(
      `   [${row.kind}] ${row.toolCallId} raw=${row.rawChars}B persisted=${row.persistedChars}B ${row.note}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 真实数据扫描（只读）
// ---------------------------------------------------------------------------

function parseNdjson(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      out.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      // 半行（正在写的尾部）跳过
    }
  }
  return out;
}

async function scanRealData(dataDir: string): Promise<void> {
  const sessionsDir = join(dataDir, 'sessions');
  const entries = await readdir(sessionsDir, { withFileTypes: true });
  const stateFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name);
  let scanned = 0;
  let compacted = 0;
  const results: Measurement[] = [];
  for (const stateFile of stateFiles) {
    const sessionId = stateFile.slice(0, -'.json'.length);
    const eventsPath = join(sessionsDir, sessionId, 'events.ndjson');
    let text: string;
    try {
      text = await readFile(eventsPath, 'utf8');
    } catch {
      continue;
    }
    scanned += 1;
    const events = parseNdjson(text);
    const compactions = events.filter((e) => e['type'] === 'message.compaction');
    if (compactions.length === 0) continue;
    const lastCompactionSeq = Math.max(...compactions.map((e) => Number(e['seq'])));
    const after = events.filter((e) => Number(e['seq']) > lastCompactionSeq);
    const runsAfter = after.filter((e) => e['type'] === 'run.started').length;
    compacted += 1;
    console.log(
      `[real] ${sessionId}: compaction=${compactions.length} lastCompactionSeq=${lastCompactionSeq} runsAfter=${runsAfter} ` +
        `lastSeq=${Math.max(...events.map((e) => Number(e['seq'])))} ` +
        `compaction.cleared_tool_call_ids=${JSON.stringify((compactions.at(-1)?.['data'] as Record<string, unknown> | undefined)?.['cleared_tool_call_ids'] ?? null)}`,
    );
    if (runsAfter === 0) {
      console.log('[real]   压缩之后没有再跑 run —— 不是本问题的样本，跳过比对');
      continue;
    }
    const rawById = new Map<string, string>();
    for (const event of events) {
      if (event['type'] !== 'tool.call.completed') continue;
      const data = event['data'] as Record<string, unknown> | undefined;
      if (data === undefined) continue;
      const id = data['tool_call_id'];
      const result = data['result'];
      if (typeof id === 'string' && typeof result === 'string') rawById.set(id, result);
    }
    const state = JSON.parse(await readFile(join(sessionsDir, stateFile), 'utf8')) as {
      messages?: Message[];
      cleared_tool_call_ids?: string[];
    };
    const messages = state.messages ?? [];
    const realStore = new FileSessionStore(sessionsDir);
    const getView = await getViewOf(realStore, sessionId, messages);
    results.push(
      summarize(
        `real:${sessionId}`,
        sessionId,
        messages,
        rawById,
        (state.cleared_tool_call_ids ?? []).length,
        Number.NaN,
        getView,
      ),
    );
  }
  console.log(
    `\n[real] 扫描 state 文件=${scanned} 有 compaction 的会话=${compacted} 其中压缩后又跑过 run=${results.length}`,
  );
  console.log(
    `[real] 读路径 = ${sessionsGetHandlerUsed ? 'sessions.get handler 直调' : 'capToolMessages(SessionState.messages)'}`,
  );
  for (const m of results) printMeasurement(m);
}

// ---------------------------------------------------------------------------
// 构造样本（隔离临时 data 目录）
// ---------------------------------------------------------------------------

interface Stack {
  eu: ExecutionUnit;
  store: FileSessionStore;
  log: SessionEventLog;
  provider: ScriptedProvider;
}

const SESSION_ID = 'probe-session';

function rawByIdOfAll(ns: number[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const n of ns) map.set(`call_${n}`, rawToolResult(n));
  return map;
}

async function makeStack(
  sessionsDir: string,
  maxTokens: number,
  compactThreshold: number,
): Promise<Stack> {
  const provider = new ScriptedProvider();
  const store = new FileSessionStore(sessionsDir);
  const log = new SessionEventLog({ dir: sessionsDir });
  const events = new MemoryEventStream();
  const eu = await ExecutionUnit.create({
    provider,
    model: 'probe-model',
    events,
    limits: {},
    termination: {},
    retry: { maxRetries: 0 },
    session: store,
    eventLog: log,
    journalFactory: createRunJournalFactory({ session: store, eventLog: log }),
    contextFactory: () => new MemoryWorkingContext({ maxTokens, compactThreshold }),
    systemPrompt: 'projection-sot probe system prompt',
    plugins: [echoPlugin()],
  });
  return { eu, store, log, provider };
}

/** 一轮 run：4 个 tool 回合 × 3 条工具结果 = 13 条工具消息（>12），再收一句文本。 */
async function runToolHeavyTurn(stack: Stack, from: number, label: string): Promise<void> {
  const turns: number[][] = [];
  for (let t = 0; t < 4; t += 1) {
    turns.push([from + t * 3, from + t * 3 + 1, from + t * 3 + 2]);
  }
  stack.provider.push(...turns.map((ids) => toolCallTurn(ids)), textTurn(`${label} 完成`));
  const answer = await stack.eu.run(`${label} 开始`, SESSION_ID);
  // journal 的 SessionState 写是排队的，等它落地再读盘
  await new Promise((resolve) => setTimeout(resolve, 400));
  console.log(`  run(${label}) -> ${JSON.stringify(answer.slice(0, 40))}`);
}

/** 最近一次请求里被换成占位的工具结果条数（请求侧）。 */
function requestPlaceholders(stack: Stack): number {
  const last = stack.provider.requests.at(-1);
  if (last === undefined) return 0;
  return last.messages.filter((m) => m.role === 'tool' && isClearedToolResult(m.content ?? ''))
    .length;
}

/** 本轮第一个请求里被换成占位的工具结果条数：反映「历史种子」本身是否已是占位。 */
function firstRequestPlaceholders(stack: Stack): number {
  const first = stack.provider.requests[0];
  if (first === undefined) return 0;
  return first.messages.filter((m) => m.role === 'tool' && isClearedToolResult(m.content ?? ''))
    .length;
}

async function sessionStateOf(stack: Stack): Promise<{ messages: Message[]; cleared: number }> {
  // journal 的写是排队的：等事件日志与 state 落稳
  for (let tick = 0; tick < 400; tick += 1) {
    const state = await stack.store.load(SESSION_ID);
    const msgs = state?.messages;
    if (msgs !== undefined && msgs.length > 0) {
      return { messages: msgs, cleared: (state?.cleared_tool_call_ids ?? []).length };
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return { messages: [], cleared: 0 };
}

async function measure(
  scenario: string,
  stack: Stack,
  state: { messages: Message[]; cleared: number },
  rawById: Map<string, string>,
): Promise<Measurement> {
  const getView = await getViewOf(stack.store, SESSION_ID, state.messages);
  return summarize(
    scenario,
    SESSION_ID,
    state.messages,
    rawById,
    state.cleared,
    requestPlaceholders(stack),
    getView,
  );
}

/** 打印「历史种子」诊断：本轮第一个请求里占位条数（>0 说明种子已经是占位）。 */
function seedDiagnostics(label: string, stack: Stack): void {
  console.log(
    `  [diag:${label}] 请求数=${stack.provider.requests.length} 首个请求工具消息=${
      stack.provider.requests[0]?.messages.filter((m) => m.role === 'tool').length ?? 0
    } 其中占位=${firstRequestPlaceholders(stack)}`,
  );
}

async function dropStateCache(sessionsDir: string): Promise<void> {
  // 删掉 SessionState 缓存（state json），事件日志保持完整 —— 模拟「缓存缺失 ⇒ 走全投影」
  for (const file of await readdir(sessionsDir)) {
    if (file === `${SESSION_ID}.json`) await unlink(join(sessionsDir, file));
  }
  const fresh = new FileSessionStore(sessionsDir);
  const after = await fresh.load(SESSION_ID);
  console.log(
    `  [diag] 删缓存后 store.load() = ${after === null ? 'null（全投影路径）' : '非空（缓存仍在）'}`,
  );
}

/** 从事件日志直接跑一遍 projectMessages，报出投影里的占位条数（= 全投影 ground truth）。 */
async function projectionDiagnostics(sessionsDir: string, label: string): Promise<void> {
  const events = parseNdjson(
    await readFile(join(sessionsDir, SESSION_ID, 'events.ndjson'), 'utf8'),
  );
  const projected = projectMessages(events as never);
  const toolMsgs = projected.filter((m) => m.role === 'tool');
  const placeholders = toolMsgs.filter((m) => isClearedToolResult(m.content ?? ''));
  console.log(
    `  [diag:${label}] projectMessages(events) → 消息 ${projected.length} / 工具 ${toolMsgs.length} / 占位 ${placeholders.length}`,
  );
  for (const m of placeholders.slice(0, 3)) {
    console.log(
      `    proj 占位 ${m.tool_call_id}: ${JSON.stringify((m.content ?? '').slice(0, 90))}`,
    );
  }
}

async function constructScenarios(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'vessel-projection-sot-'));
  console.log(`\n[construct] 隔离 data 目录：${root}（默认 data 目录未触碰）`);
  // 5 轮 run × 12 条 = 60 条工具结果的上界
  const ns = Array.from({ length: 60 }, (_, i) => i + 1);
  const rawById = rawByIdOfAll(ns);

  // --- 场景 A：run1 → 手动 compact（idle 路径）→ 重建 EU（≈ 换进程）→ run2 ---
  {
    const dir = join(root, 'A', 'sessions');
    const stack1 = await makeStack(dir, 200_000, 0.9);
    await runToolHeavyTurn(stack1, 1, 'A-run1');
    printMeasurement(
      await measure('A0: run1 之后（未压缩）', stack1, await sessionStateOf(stack1), rawById),
    );

    await stack1.eu.compactContext(SESSION_ID);
    await new Promise((resolve) => setTimeout(resolve, 400));
    printMeasurement(
      await measure(
        'A1: 手动压缩刚做完（同一 EU，未再跑 run）',
        stack1,
        await sessionStateOf(stack1),
        rawById,
      ),
    );

    const stack2 = await makeStack(dir, 200_000, 0.9);
    await runToolHeavyTurn(stack2, 13, 'A-run2');
    printMeasurement(
      await measure(
        'A2: 压缩后再跑一次 run（state 命中缓存）',
        stack2,
        await sessionStateOf(stack2),
        rawById,
      ),
    );
  }

  // --- 场景 B：同 A，但 run2 之前删掉 state json（缓存缺失 ⇒ 全投影） ---
  {
    const dir = join(root, 'B', 'sessions');
    const stack1 = await makeStack(dir, 200_000, 0.9);
    await runToolHeavyTurn(stack1, 1, 'B-run1');
    await stack1.eu.compactContext(SESSION_ID);
    await new Promise((resolve) => setTimeout(resolve, 400));
    printMeasurement(
      await measure(
        'B1: 手动压缩刚做完（该段没有清理决策）',
        stack1,
        await sessionStateOf(stack1),
        rawById,
      ),
    );

    await dropStateCache(dir);
    await projectionDiagnostics(dir, 'B-全投影');
    const stack2 = await makeStack(dir, 200_000, 0.9);
    await runToolHeavyTurn(stack2, 13, 'B-run2');
    seedDiagnostics('B-run2 种子', stack2);
    printMeasurement(
      await measure(
        'B2: 删 state 缓存（全投影路径）后再跑一次 run',
        stack2,
        await sessionStateOf(stack2),
        rawById,
      ),
    );
  }

  // --- 场景 C：自动压缩（阈值压到很小）在段起点触发 ---
  {
    const dir = join(root, 'C', 'sessions');
    const stack1 = await makeStack(dir, 1_500, 0.3);
    await runToolHeavyTurn(stack1, 1, 'C-run1');
    printMeasurement(await measure('C0: run1 之后', stack1, await sessionStateOf(stack1), rawById));

    const stack2 = await makeStack(dir, 1_500, 0.3);
    await runToolHeavyTurn(stack2, 13, 'C-run2');
    printMeasurement(
      await measure(
        'C1: 自动压缩（run2 段起点）+ run2 落盘',
        stack2,
        await sessionStateOf(stack2),
        rawById,
      ),
    );

    const stack3 = await makeStack(dir, 1_500, 0.3);
    await runToolHeavyTurn(stack3, 25, 'C-run3');
    printMeasurement(
      await measure('C2: run3 之后（上一段已压缩）', stack3, await sessionStateOf(stack3), rawById),
    );
  }

  // --- 场景 D：自动压缩产生 cleared 集合后，再删 state 缓存 → 下一次 run ---
  {
    const dir = join(root, 'D', 'sessions');
    const stack1 = await makeStack(dir, 1_500, 0.3);
    await runToolHeavyTurn(stack1, 1, 'D-run1');
    const stack2 = await makeStack(dir, 1_500, 0.3);
    await runToolHeavyTurn(stack2, 13, 'D-run2');
    printMeasurement(
      await measure(
        'D1: 自动压缩 + run2 落盘（缓存命中）',
        stack2,
        await sessionStateOf(stack2),
        rawById,
      ),
    );

    await dropStateCache(dir);
    await projectionDiagnostics(dir, 'D-全投影');
    const stack3 = await makeStack(dir, 1_500, 0.3);
    await runToolHeavyTurn(stack3, 25, 'D-run3');
    seedDiagnostics('D-run3 种子', stack3);
    printMeasurement(
      await measure(
        'D2: 删 state 缓存后 run3（压缩事件带 cleared ids ⇒ 全投影）',
        stack3,
        await sessionStateOf(stack3),
        rawById,
      ),
    );
  }

  // --- 场景 E（决定性）：压缩事件带 cleared ids → 删缓存 → 再跑一次「不压缩」的 run ---
  // 这一场把「全投影占位」与「段起点清理占位」彻底分开：run3 用大预算，
  // 5% 清理预算足够大 ⇒ 段起点清理集合为空 ⇒ 请求/落盘里若出现占位，只能是全投影给的。
  {
    const dir = join(root, 'E', 'sessions');
    const stack1 = await makeStack(dir, 1_500, 0.3);
    await runToolHeavyTurn(stack1, 1, 'E-run1');
    const stack2 = await makeStack(dir, 1_500, 0.3);
    await runToolHeavyTurn(stack2, 13, 'E-run2');
    printMeasurement(
      await measure(
        'E1: 自动压缩产生 cleared ids（run2 落盘，缓存命中）',
        stack2,
        await sessionStateOf(stack2),
        rawById,
      ),
    );

    await dropStateCache(dir);
    await projectionDiagnostics(dir, 'E-全投影');
    const stack3 = await makeStack(dir, 200_000, 0.9);
    await runToolHeavyTurn(stack3, 25, 'E-run3');
    seedDiagnostics('E-run3 种子', stack3);
    printMeasurement(
      await measure(
        'E2: 删缓存 + 不压缩的 run3（占位只可能来自全投影）',
        stack3,
        await sessionStateOf(stack3),
        rawById,
      ),
    );
  }

  // 事件侧留证：compaction 事件是否带 cleared_tool_call_ids；事件里的原文与造样本时的原文是否逐字相同
  for (const label of ['A', 'B', 'C', 'D', 'E']) {
    const eventsPath = join(root, label, 'sessions', SESSION_ID, 'events.ndjson');
    const events = parseNdjson(await readFile(eventsPath, 'utf8'));
    const compactions = events.filter((e) => e['type'] === 'message.compaction');
    const completions = events.filter((e) => e['type'] === 'tool.call.completed');
    let eventRawMatches = 0;
    let eventRawMismatch = 0;
    for (const event of completions) {
      const data = event['data'] as Record<string, unknown> | undefined;
      const id = data?.['tool_call_id'];
      const result = data?.['result'];
      if (typeof id !== 'string' || typeof result !== 'string') continue;
      const n = Number(id.startsWith('call_') ? id.slice('call_'.length) : Number.NaN);
      if (Number.isFinite(n) && result === rawToolResult(n)) eventRawMatches += 1;
      else eventRawMismatch += 1;
    }
    console.log(
      `[construct:${label}] events.ndjson: tool.call.completed=${completions.length}（正文与造样本原文逐字相同 ${eventRawMatches}，不同 ${eventRawMismatch}）` +
        ` message.compaction=${compactions.length} ` +
        `每个 compaction 的 cleared_tool_call_ids 条数=${JSON.stringify(
          compactions.map(
            (e) =>
              (
                (e['data'] as Record<string, unknown>)['cleared_tool_call_ids'] as
                  | string[]
                  | undefined
              )?.length ?? 0,
          ),
        )}`,
    );
  }
  console.log(
    `\n[construct] 原始 events.ndjson 与 state json 保留在 ${root}（便于人工复核；--keep 之外的清理交给系统临时目录）`,
  );
}

// ---------------------------------------------------------------------------
// 幂等性：对「已是占位」的正文再跑一次 formatClearedToolResult
// ---------------------------------------------------------------------------

function idempotencyCheck(): void {
  const raw = rawToolResult(1);
  const base: Message[] = [
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: TOOL_NAME, arguments: '{"n":1}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', name: TOOL_NAME, content: raw },
  ];
  const once = formatClearedToolResult(base, 'call_1', raw);
  const twice = formatClearedToolResult(base, 'call_1', once);
  console.log('\n--- 幂等性 ---');
  console.log(`  原文   : ${JSON.stringify(raw.slice(0, 80))} … (${raw.length}B)`);
  console.log(`  第一次 : ${JSON.stringify(once)}`);
  console.log(`  第二次 : ${JSON.stringify(twice)}`);
  console.log(
    `  isClearedToolResult(once)=${isClearedToolResult(once)}  once===twice? ${once === twice}`,
  );
  if (once !== twice) {
    let at = 0;
    while (at < once.length && at < twice.length && once[at] === twice[at]) at += 1;
    console.log(`  差异起点 index=${at}`);
    console.log(`    once : …${JSON.stringify(once.slice(Math.max(0, at - 30)))}`);
    console.log(`    twice: …${JSON.stringify(twice.slice(Math.max(0, at - 30)))}`);
  }
}

/**
 * 顺带复算 `check-append-only-context.ts:665` 那行「请求视图改写」判据是否空转：
 * 它把 `maxTokens`（number）当第二个实参传给 `withClearedToolResults`，
 * 而该函数第二个参数现在是「cleared id 数组」，传数字会直接原样返回拷贝。
 */
function c1gRequestViewDiagnostic(): void {
  const messages: Message[] = [{ role: 'system', content: 'sys' }];
  for (let i = 1; i <= 12; i += 1) {
    messages.push({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: `call_${i}`,
          type: 'function',
          function: { name: TOOL_NAME, arguments: JSON.stringify({ n: i }) },
        },
      ],
    });
    messages.push({
      role: 'tool',
      tool_call_id: `call_${i}`,
      name: TOOL_NAME,
      content: rawToolResult(i),
    });
  }
  const planned = planClearedToolResults(messages, 2_000);
  const withIds = withClearedToolResults(messages, planned);
  const rewritesWithIds = withIds.filter(
    (m, index) => m.content !== messages[index]!.content,
  ).length;
  const withNumber = withClearedToolResults(messages, 2_000);
  const rewritesWithNumber = withNumber.filter(
    (m, index) => m.content !== messages[index]!.content,
  ).length;
  console.log(
    '\n--- check-append-only-context C1g:665 复核（withClearedToolResults 第二实参） ---',
  );
  console.log(`  planClearedToolResults(messages, 2000) 点名 ${planned.length} 条`);
  console.log(
    `  withClearedToolResults(messages, <ids>)   改写 ${rewritesWithIds} 条  ← 真实请求视图口径`,
  );
  console.log(
    `  withClearedToolResults(messages, 2000)    改写 ${rewritesWithNumber} 条  ← C1g:665 实际调用`,
  );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

const has = (name: string): boolean => process.argv.includes(name);

async function main(): Promise<void> {
  const doAll = has('--all');
  const doConstruct = doAll || has('--construct');
  const doIdempotency = doAll || has('--idempotency');
  const dataDir = argValue('--data-dir');

  if (!doConstruct && !doIdempotency && dataDir === undefined) {
    console.log(
      '用法：bun scripts/probe-projection-sot.ts [--construct] [--idempotency] [--data-dir <dir>] [--all]',
    );
    return;
  }
  if (doIdempotency) {
    idempotencyCheck();
    c1gRequestViewDiagnostic();
  }
  if (doConstruct) await constructScenarios();
  if (dataDir !== undefined) await scanRealData(dataDir);
}

await main();
