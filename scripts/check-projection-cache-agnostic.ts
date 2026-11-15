#!/usr/bin/env bun
/**
 * 门禁：投影**不依赖**会话壳里的缓存水位（0.54 B3；ADR-105 D2 / 计划书判据 B-2）。
 *
 * 判据（唯一，别用「跑通了」代替）：
 *
 *   把会话壳里的 `derived_upto_seq` / `projection_cache_seq` 这个字段**删掉**、或者**灌毒**
 *   （负数 / 天文数字 / 字符串）之后，同一条会话的投影输出**逐字节相同**。
 *
 * 为什么这条能当判据：ADR-105 R2 写死「不让任何读侧派生成为审计依据」，P7（刷新只剩 4 条）
 * 的根因就是写侧水位被读侧当成覆盖证明（`run-journal.ts:204-209` + 旧
 * `loadStoredHistory` 的「有水位 ⇒ 只读增量」）。只要投影的产物随这个数字变化，它就还是
 * 事实判定的一部分；不随它变化，它才降级成**纯粹的缓存提示**。
 *
 * 量的是**投影本身**（`loadStoredHistory` 的产物 = 播种窗口 / 落盘会话壳的来源），不是 wire：
 *
 * - A `keep`：原样（字段在、值正常）；
 * - B `drop`：两个名字都删掉（= 旧数据口径 / 「完全忽略该字段」）；
 * - C `poison-low`：`-7`（反向、会让 `sinceSeq` 变成负数）；
 * - D `poison-high`：`1e7`（远超日志尾，旧实现会读到空增量 ⇒ 「只剩几条」的另一种造法）；
 * - E `poison-string`：`"n/a"`（类型被破坏；旧实现的 `typeof derived === 'number'` 会走满投影）。
 *
 * 夹具（每条都造真落盘目录：真 `SessionEventLog` + 真 `FileSessionStore`）：
 *
 * 1. `real-simple` / `real-tool`：真 `ExecutionUnit` 跑出来的会话（不手写事件）；
 * 2. `syn-compact-current`：压缩事件在日志里、壳是最新的（含压缩摘要）；
 * 3. `syn-compact-stale`：压缩已落盘、壳停在压缩之前（增量必须补出压缩摘要 —— P7 形态）；
 * 4. `syn-notice-tail`：壳尾部有一条 `vessel:notice`（**只存在于壳**、日志里没有的正文）；
 * 5. `syn-rewind-tail`：`session.rewound` 在尾部（壳还在撤回之前）；
 * 6. `syn-cleared-frozen`：壳里的工具正文已被写成占位（0.54 之前的粘住形态）、日志里是原文；
 * 7. `syn-empty-cache`：壳里只有基底 system（没有可比的历史缓存）；
 * 8. `syn-legacy-no-field`：旧壳（两个名字都没有）。
 *
 * 另外两段（向后兼容）：
 *
 * - **旧壳 + 新代码**：只写 `derived_upto_seq` 的壳、只写 `projection_cache_seq` 的壳、
 *   两个都写的壳，三者的投影输出必须逐字节相同（别名语义）；
 * - **新壳 + 旧代码**：读侧只认旧名字时也能拿到覆盖提示 ⇒ 断言落盘 JSON 里旧键仍在
 *   且与新键同值（additive 迁移，不靠「旧代码恰好忽略未知键」）。
 *
 * 不接 gates（`package.json` 属别人的单，main 串）；用法：`bun run scripts/check-projection-cache-agnostic.ts`
 * 退出码：0 = 全过，1 = 有 FAIL。
 */

import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type ChatRequest,
  createRunJournalFactory,
  ExecutionUnit,
  FileSessionStore,
  type LLMProvider,
  type LLMResponse,
  MemoryEventStream,
  MemoryWorkingContext,
  type Message,
  type Plugin,
  projectMessages,
  SessionEventLog,
  type SessionEventRecord,
  type SessionState,
  type ToolDefinition,
} from '../packages/core/src/index';
import { createSessionMethods } from '../packages/serve/src/gateway/methods/sessions';

const SESSION_ID = 's-cache-agnostic';
const SYSTEM_PROMPT = 'probe system prompt for projection cache agnosticism';
const TOOL_NAME = 'bash';
/** 缓存水位的两个名字：旧壳只会有前者，新壳两个都写。 */
const CURSOR_KEYS = ['derived_upto_seq', 'projection_cache_seq'] as const;

// ── 断言与逐字节比较 ─────────────────────────────────────────────────────────

const failures: string[] = [];
let passed = 0;

function ok(label: string, detail?: string): void {
  passed += 1;
  console.log(`  ok   ${label}${detail === undefined ? '' : ` — ${detail}`}`);
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
  if (a === w) ok(label, a);
  else fail(label, `want ${w} got ${a}`);
}

/** 键序无关的规范化 JSON（同一份内容必须给同一个串；`undefined` 键一律丢弃）。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, inner]) => inner !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** 投影输出的「结构清单」：order / ids / 正文 / ts 全在里面（逐字节比较的第一现场）。 */
function digestOf(messages: readonly Message[]): string {
  return messages
    .map((message, index) =>
      [
        String(index),
        message.role,
        message.tool_call_id ?? '',
        message.compaction_summary === true ? 'summary' : '',
        String(message.timestamp ?? ''),
        sha256(String(message.content ?? '')),
      ].join('|'),
    )
    .join('\n');
}

interface Projection {
  readonly messages: readonly Message[];
  readonly cursor: number | undefined;
  readonly eventCount: number;
  /** 投影输出的逐字节指纹（规范化 JSON 的 sha256）。 */
  readonly hash: string;
}

function projectionOf(
  messages: readonly Message[],
  cursor: number | undefined,
  eventCount: number,
): Projection {
  return { messages, cursor, eventCount, hash: sha256(canonical(messages)) };
}

// ── 装配：真存储 + 真事件日志 + 真 ExecutionUnit（只借它的读路径） ──────────────

/** 探针只需 provider 存在（投影读路径一次模型都不调）。 */
const idleProvider: LLMProvider = {
  async chat(_request: ChatRequest): Promise<LLMResponse> {
    throw new Error('probe: 投影读路径不该调用 provider');
  },
};

async function newUnit(dir: string): Promise<ExecutionUnit> {
  const store = new FileSessionStore(dir);
  const log = new SessionEventLog({ dir, durable: false });
  return await ExecutionUnit.create({
    provider: idleProvider,
    model: 'probe/cache-agnostic',
    contextFactory: () => new MemoryWorkingContext({ maxTokens: 200_000 }),
    events: new MemoryEventStream(),
    limits: {},
    termination: {},
    journalFactory: createRunJournalFactory({ session: store as never, eventLog: log }),
    session: store as never,
    eventLog: log,
    systemPrompt: SYSTEM_PROMPT,
    retry: { maxRetries: 0 },
  });
}

/**
 * 读路径的形状：`loadStoredHistory` 是私有的，但判据要量的**正是它** ——
 * 它才是「壳 + 日志 → 播种窗口 / 落盘会话壳」的那一趟投影。
 */
interface ProjectionReadPath {
  loadStoredHistory(
    sessionId: string,
  ): Promise<{ messages: Message[]; cursor?: number; eventCount: number }>;
}

async function readProjection(dir: string): Promise<Projection> {
  const unit = await newUnit(dir);
  try {
    const path = unit as unknown as ProjectionReadPath;
    const history = await path.loadStoredHistory(SESSION_ID);
    return projectionOf(
      history.messages.map((message) => structuredClone(message)),
      history.cursor,
      history.eventCount,
    );
  } finally {
    unit.dispose?.();
  }
}

/** 会话壳文件路径（与 `FileSessionStore` 同一口径：`<dir>/<encodeURIComponent(id)>.json`）。 */
function shellPath(dir: string): string {
  return join(dir, `${encodeURIComponent(SESSION_ID)}.json`);
}

function readShell(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(shellPath(dir), 'utf8')) as Record<string, unknown>;
}

function writeShell(dir: string, shell: Record<string, unknown>): void {
  writeFileSync(shellPath(dir), `${JSON.stringify(shell, null, 2)}\n`, 'utf8');
}

/** 一种壳变体：对落盘的会话壳做一次确定性改写（**只动缓存水位这一个字段**）。 */
interface Variant {
  readonly name: string;
  readonly apply: (shell: Record<string, unknown>) => void;
}

const VARIANTS: readonly Variant[] = [
  { name: 'keep', apply: () => {} },
  {
    name: 'drop',
    apply: (shell) => {
      for (const key of CURSOR_KEYS) delete shell[key];
    },
  },
  {
    name: 'poison-low',
    apply: (shell) => {
      for (const key of CURSOR_KEYS) if (key in shell) shell[key] = -7;
    },
  },
  {
    name: 'poison-high',
    apply: (shell) => {
      for (const key of CURSOR_KEYS) if (key in shell) shell[key] = 10_000_000;
    },
  },
  {
    name: 'poison-string',
    apply: (shell) => {
      for (const key of CURSOR_KEYS) if (key in shell) shell[key] = 'n/a';
    },
  },
];

/** 复制一份落盘目录并施加壳变体（事件日志原样带过去：只改缓存提示，不改事实）。 */
function variantDir(source: string, workRoot: string, fixture: string, variant: Variant): string {
  const dir = join(workRoot, `${fixture}-${variant.name}`);
  cpSync(source, dir, { recursive: true });
  const shell = readShell(dir);
  variant.apply(shell);
  writeShell(dir, shell);
  return dir;
}

// ── 夹具 ①：真 ExecutionUnit 跑出来的会话 ──────────────────────────────────────

/** 每轮先来 `toolRounds` 条工具调用，再收口；`requests` 记下模型实际看到的窗口。 */
class ScriptedProvider implements LLMProvider {
  readonly requests: Message[][] = [];
  private budget: number;

  constructor(toolRounds: number) {
    this.budget = toolRounds;
  }

  async chat(request: ChatRequest): Promise<LLMResponse> {
    this.requests.push(request.messages.map((message) => structuredClone(message)));
    const usage = { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 };
    if (this.budget > 0) {
      const id = `call_${String(this.budget)}`;
      this.budget -= 1;
      return {
        content: '',
        finish_reason: 'tool_calls',
        tool_calls: [
          {
            id,
            type: 'function',
            function: { name: TOOL_NAME, arguments: '{"command":"ls"}' },
          },
        ],
        usage,
      };
    }
    return { content: 'assistant done', finish_reason: 'stop', usage };
  }
}

const toolPlugin: Plugin = {
  name: 'probe-cache-agnostic-tools',
  install(host): void {
    const tool: ToolDefinition = {
      name: TOOL_NAME,
      description: 'probe tool that returns a small deterministic body',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => 'probe tool body\nexit code: 0',
    };
    host.registerTool(tool);
  },
};

/** journal 的写是异步排队的：等终态落盘（status 不再是 running）。 */
async function waitPersisted(dir: string): Promise<void> {
  for (let tick = 0; tick < 800; tick += 1) {
    const fresh = await new FileSessionStore(dir).load(SESSION_ID);
    if (fresh !== null && fresh !== undefined && fresh.status !== 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('session state 没有落盘');
}

/** 真跑一轮（真 provider / 真工具 / 真落盘），返回该会话的落盘目录。 */
async function buildRealFixture(
  workRoot: string,
  name: string,
  turns: readonly string[],
  toolRounds: number,
): Promise<string> {
  const dir = join(workRoot, name);
  const store = new FileSessionStore(dir);
  const log = new SessionEventLog({ dir, durable: false });
  const provider = new ScriptedProvider(toolRounds);
  const unit = await ExecutionUnit.create({
    provider,
    model: 'probe/cache-agnostic',
    contextFactory: () => new MemoryWorkingContext({ maxTokens: 200_000 }),
    events: new MemoryEventStream(),
    limits: {},
    termination: {},
    journalFactory: createRunJournalFactory({ session: store as never, eventLog: log }),
    session: store as never,
    eventLog: log,
    plugins: [toolPlugin],
    systemPrompt: SYSTEM_PROMPT,
    retry: { maxRetries: 0 },
  });
  try {
    for (const text of turns) {
      await unit.run(text, SESSION_ID);
      await waitPersisted(dir);
    }
    expect(
      `${name}：真跑后壳里有历史缓存 > 0`,
      (readShell(dir).messages as unknown[]).length > 0,
      true,
    );
    expect(`${name}：真跑后日志里有事件 > 0`, (await readRecords(dir)).length > 0, true);
  } finally {
    await unit.dispose();
  }
  return dir;
}

async function readRecords(dir: string): Promise<SessionEventRecord[]> {
  const log = new SessionEventLog({ dir, durable: false });
  try {
    await log.flush(SESSION_ID).catch(() => undefined);
    return await log.read(SESSION_ID);
  } finally {
    await log.release(SESSION_ID).catch(() => undefined);
  }
}

// ── 夹具 ②：手写事实（事件日志）+ 手写缓存（会话壳） ────────────────────────────
//
// 为什么也要手写：「壳落后于日志」「壳里有日志没有的正文」「撤回在尾部」这些形态用真 run
// 造不稳（要卡时序 / 卡崩溃点）。事件日志仍是**真实现**（真 ndjson + 真 seq），壳仍是真
// `FileSessionStore` 认的文件 —— 被量的那条读路径一步都没被 mock。

interface SyntheticEvent {
  type: string;
  ts: number;
  data: unknown;
  run_id?: string;
}

const RUN_ID = 'run-probe';

/** 公共头：user / injected / 一轮工具调用 / assistant。 */
function baseEvents(): SyntheticEvent[] {
  return [
    { type: 'user.message', ts: 1_760_000_000_001, data: { content: 'u0' } },
    {
      type: 'message.injected',
      ts: 1_760_000_000_002,
      data: { message: { role: 'user', content: 'injected-0' } },
    },
    {
      type: 'llm.response',
      ts: 1_760_000_000_003,
      data: {
        content: '',
        tool_calls: [
          { id: 'call_a', type: 'function', function: { name: TOOL_NAME, arguments: '{}' } },
        ],
      },
    },
    {
      type: 'tool.call.started',
      ts: 1_760_000_000_004,
      data: { tool_call_id: 'call_a', tool_name: TOOL_NAME, arguments: '{"command":"ls"}' },
    },
    {
      type: 'tool.call.completed',
      ts: 1_760_000_000_005,
      data: { tool_call_id: 'call_a', result: 'RAW-A\nsecond line' },
    },
    { type: 'user.message', ts: 1_760_000_000_006, data: { content: 'u1' } },
    { type: 'llm.response', ts: 1_760_000_000_007, data: { content: 'answer-1' } },
  ];
}

const COMPACTION_TAIL: SyntheticEvent[] = [
  {
    type: 'message.compaction',
    ts: 1_760_000_000_008,
    data: { summary: 'S1 summary body', kept: 2, cleared_tool_call_ids: ['call_a'] },
  },
  { type: 'user.message', ts: 1_760_000_000_009, data: { content: 'u2' } },
  { type: 'llm.response', ts: 1_760_000_000_010, data: { content: 'answer-2' } },
];

const NOTICE_MESSAGE: Message = {
  role: 'user',
  name: 'vessel:notice',
  content: '[context] card body that only lives in the session shell',
  timestamp: 1_760_000_000_500,
};

const BASE_SYSTEM: Message = {
  role: 'system',
  content: SYSTEM_PROMPT,
  timestamp: 1_760_000_000_000,
};

async function writeSynthetic(dir: string, events: readonly SyntheticEvent[]): Promise<number> {
  const log = new SessionEventLog({ dir, durable: false });
  let last = 0;
  try {
    for (const event of events) {
      const record = await log.append({
        session_id: SESSION_ID,
        run_id: event.run_id ?? RUN_ID,
        type: event.type,
        ts: event.ts,
        data: event.data,
        durable: false,
      });
      last = record.seq;
    }
    await log.flush(SESSION_ID);
  } finally {
    await log.release(SESSION_ID).catch(() => undefined);
  }
  return last;
}

interface ShellSpec {
  messages: Message[];
  /** `undefined` = 旧壳（没有缓存水位）；`null` 由调用方决定写哪个名字。 */
  cursor?: number;
  cursorKey?: (typeof CURSOR_KEYS)[number];
}

function writeSyntheticShell(dir: string, spec: ShellSpec): void {
  const shell: Record<string, unknown> = {
    session_id: SESSION_ID,
    created_at: BASE_SYSTEM.timestamp,
    updated_at: 1_760_000_000_900,
    status: 'completed',
    run_id: RUN_ID,
    messages: spec.messages,
  };
  if (spec.cursor !== undefined) {
    shell[spec.cursorKey ?? 'derived_upto_seq'] = spec.cursor;
  }
  writeShell(dir, shell);
}

// ── 夹具清单 ──────────────────────────────────────────────────────────────────

interface Fixture {
  readonly name: string;
  readonly dir: string;
  /** keep 投影里**必须出现**的正文片段（证明这块事实没被缓存水位藏起来）。 */
  readonly expectContents?: readonly string[];
  /** keep 投影里**必须不出现**的正文片段（证明替换语义真的生效）。 */
  readonly expectAbsent?: readonly string[];
}

/** 把一批事件投影成壳里的 `messages`（真 `projectMessages`，与生产同一口径）。 */
function foldOf(events: readonly SyntheticEvent[]): Message[] {
  return projectMessages(events, { applyClearedReplacements: false });
}

async function buildFixtures(workRoot: string): Promise<Fixture[]> {
  const fixtures: Fixture[] = [];

  // ① 真跑出来的会话（不手写任何事件）
  fixtures.push({
    name: 'real-simple',
    dir: await buildRealFixture(workRoot, 'real-simple', ['hello there'], 0),
  });
  fixtures.push({
    name: 'real-tool',
    dir: await buildRealFixture(workRoot, 'real-tool', ['read the dir', 'and again'], 2),
  });

  // ② 压缩事件在日志里、壳是最新的（壳含压缩摘要）
  {
    const dir = join(workRoot, 'syn-compact-current');
    const events = [...baseEvents(), ...COMPACTION_TAIL];
    const last = await writeSynthetic(dir, events);
    writeSyntheticShell(dir, { messages: [BASE_SYSTEM, ...foldOf(events)], cursor: last });
    fixtures.push({ name: 'syn-compact-current', dir });
  }

  // ③ 压缩已落盘、壳停在压缩之前（P7 形态：缓存落后于事实）
  {
    const dir = join(workRoot, 'syn-compact-stale');
    const base = baseEvents();
    const events = [...base, ...COMPACTION_TAIL];
    const stale = await writeSynthetic(dir, events);
    const beforeCompaction = stale - COMPACTION_TAIL.length;
    writeSyntheticShell(dir, {
      messages: [BASE_SYSTEM, ...foldOf(base)],
      cursor: beforeCompaction,
    });
    fixtures.push({
      name: 'syn-compact-stale',
      dir,
      // 压缩替换语义必须生效：摘要与压缩后的尾部事实都得在，被压掉的正文不许复活。
      expectContents: ['S1 summary body', 'u2', 'answer-2'],
      expectAbsent: ['u0', 'injected-0'],
    });
  }

  // ④ 壳尾部有一条只存在于壳的 `vessel:notice`（日志里没有这条正文）
  {
    const dir = join(workRoot, 'syn-notice-tail');
    const events = baseEvents();
    const last = await writeSynthetic(dir, events);
    writeSyntheticShell(dir, {
      messages: [BASE_SYSTEM, ...foldOf(events), NOTICE_MESSAGE],
      cursor: last,
    });
    fixtures.push({
      name: 'syn-notice-tail',
      dir,
      // 只存在于壳的卡片不许因为「日志里没有」就被丢掉。
      expectContents: [String(NOTICE_MESSAGE.content)],
    });
  }

  // ⑤ `session.rewound` 在尾部、壳还停在撤回之前
  {
    const dir = join(workRoot, 'syn-rewind-tail');
    const events = baseEvents();
    const last = await writeSynthetic(dir, [
      ...events,
      {
        type: 'session.rewound',
        ts: 1_760_000_000_008,
        data: { keep_messages: 3, keep_projected: 3 },
      },
    ]);
    writeSyntheticShell(dir, { messages: [BASE_SYSTEM, ...foldOf(events)], cursor: last - 1 });
    fixtures.push({
      name: 'syn-rewind-tail',
      dir,
      // 撤回 = 删尾部事实：被撤回的正文不许从壳里复活。
      expectContents: ['u0', 'injected-0'],
      expectAbsent: ['u1', 'answer-1'],
    });
  }

  // ⑥ 壳里的工具正文已被写成占位（0.54 之前的粘住形态），日志里是原文
  {
    const dir = join(workRoot, 'syn-cleared-frozen');
    const events = baseEvents();
    const last = await writeSynthetic(dir, events);
    const frozen = foldOf(events).map((message) =>
      message.tool_call_id === 'call_a'
        ? { ...message, content: '[cleared bash: ls -> exit 0, 2 lines]' }
        : message,
    );
    writeSyntheticShell(dir, { messages: [BASE_SYSTEM, ...frozen], cursor: last });
    fixtures.push({ name: 'syn-cleared-frozen', dir });
  }

  // ⑦ 壳里只有基底 system（没有可比的历史缓存）—— P7 形态：水位说覆盖到日志尾，
  //    但壳里一条事实都没有。修复前这里只剩基底 system。
  {
    const dir = join(workRoot, 'syn-empty-cache');
    const last = await writeSynthetic(dir, baseEvents());
    writeSyntheticShell(dir, { messages: [BASE_SYSTEM], cursor: last });
    fixtures.push({
      name: 'syn-empty-cache',
      dir,
      // P7 的判据：日志里的事实必须全部可见（修复前只剩 1 条基底 system）。
      expectContents: ['u0', 'injected-0', 'RAW-A', 'u1', 'answer-1'],
    });
  }

  // ⑧ 旧壳：两个名字都没有（旧数据口径）
  {
    const dir = join(workRoot, 'syn-legacy-no-field');
    const events = baseEvents();
    await writeSynthetic(dir, events);
    writeSyntheticShell(dir, { messages: [BASE_SYSTEM, ...foldOf(events)] });
    fixtures.push({ name: 'syn-legacy-no-field', dir });
  }

  // ⑨ 壳里的正文与日志**逐字不同**（append 侧脱敏 / guardrail 改写后的形状）：
  //    正文以壳为准，不许拿日志那一份去回改历史（那是 PII 与 append-only 双破）。
  {
    const dir = join(workRoot, 'syn-masked-cache');
    const events = baseEvents();
    const last = await writeSynthetic(dir, events);
    const masked = foldOf(events).map((message) =>
      message.tool_call_id === 'call_a' ? { ...message, content: '«pii:neutralized»' } : message,
    );
    writeSyntheticShell(dir, { messages: [BASE_SYSTEM, ...masked], cursor: last });
    fixtures.push({
      name: 'syn-masked-cache',
      dir,
      // 壳里那份是权威（脱敏后的字节），日志里那一份不许顶替它。
      expectContents: ['«pii:neutralized»'],
      expectAbsent: ['RAW-A'],
    });
  }

  return fixtures;
}

// ── 核心判据：同一夹具、五种壳变体，投影输出逐字节相同 ────────────────────────

async function judgeFixture(fixture: Fixture, workRoot: string): Promise<void> {
  section(`夹具 ${fixture.name}`);

  const measured = new Map<string, Projection>();
  for (const variant of VARIANTS) {
    const dir = variantDir(fixture.dir, workRoot, fixture.name, variant);
    measured.set(variant.name, await readProjection(dir));
  }

  const keep = measured.get('keep');
  if (keep === undefined) {
    fail(`${fixture.name}：keep 变体缺失`, '探针装配错误');
    return;
  }
  ok(
    `${fixture.name}：keep 投影 ${String(keep.messages.length)} 条 / 事件 ${String(keep.eventCount)} 条`,
    `hash=${keep.hash}`,
  );
  // 反真空绿：夹具必须真的有内容，否则「都一样」是因为都空。
  expect(`${fixture.name}：keep 投影非空（判据非真空绿）`, keep.messages.length > 0, true);
  const bodies = keep.messages.map((message) => String(message.content ?? ''));
  for (const expected of fixture.expectContents ?? []) {
    expect(
      `${fixture.name}：事实可见（正文含「${expected.slice(0, 32)}」）`,
      bodies.some((body) => body.includes(expected)),
      true,
    );
  }
  for (const absent of fixture.expectAbsent ?? []) {
    expect(
      `${fixture.name}：替换语义生效（正文不含「${absent.slice(0, 32)}」）`,
      bodies.some((body) => body.includes(absent)),
      false,
    );
  }

  for (const variant of VARIANTS) {
    if (variant.name === 'keep') continue;
    const got = measured.get(variant.name);
    if (got === undefined) {
      fail(`${fixture.name}/${variant.name}：变体缺失`, '探针装配错误');
      continue;
    }
    expect(`${fixture.name}/${variant.name}：投影逐字节相同（sha256）`, got.hash, keep.hash);
    // 逐条结构清单（order / ids / 正文 / ts）：hash 相等之外再给一份人能读的比较结果。
    expect(
      `${fixture.name}/${variant.name}：order/ids/content/ts 逐条相同`,
      digestOf(got.messages),
      digestOf(keep.messages),
    );
    // 事件条数只由日志决定（它是「这一趟读了什么」的直接证据）。
    expect(`${fixture.name}/${variant.name}：eventCount 相同`, got.eventCount, keep.eventCount);
    // 覆盖游标不许再被缓存水位影响：它是「窗口覆盖到哪」的上报值，被污染就等于
    // 又把写侧水位当成了事实判定的一部分（`lastCoveredCursor` 据此决定要不要发
    // `context.changed`，所以这条不是纯观测）。
    expect(`${fixture.name}/${variant.name}：游标相同`, got.cursor, keep.cursor);
  }
}

// ── `sessions.get` 的 wire：壳里的缓存提示被删掉之后，出站逐字节相同 ──────────

/** 直调 `sessions.get` handler（与 gateway 同一份方法表），返回出站结果的指纹。 */
async function wireOf(state: SessionState): Promise<{ hash: string; total: unknown }> {
  const methods = createSessionMethods({
    sessionFor: () =>
      ({
        load: async (sessionId: string) => (sessionId === SESSION_ID ? state : undefined),
      }) as never,
  });
  const method = methods.find((item) => item.name === 'sessions.get');
  if (method === undefined) throw new Error('找不到 RPC 方法 sessions.get');
  const result = (await method.handler({ session_id: SESSION_ID }, {} as never)) as {
    session: Record<string, unknown>;
  };
  const session = result.session;
  return { hash: sha256(canonical(session)), total: session.messages_total };
}

async function judgeSessionsGet(fixtures: readonly Fixture[]): Promise<void> {
  section('`sessions.get` 出站：缓存水位在场 / 缺席（逐字节）');
  for (const fixture of fixtures) {
    const keepShell = readShell(fixture.dir);
    const messages = keepShell.messages as Message[];
    const wireKeep = await wireOf({
      ...(keepShell as unknown as SessionState),
      messages,
    });
    const droppedShell: Record<string, unknown> = { ...keepShell };
    for (const key of CURSOR_KEYS) delete droppedShell[key];
    const wireDrop = await wireOf({
      ...(droppedShell as unknown as SessionState),
      messages,
    });
    expect(`${fixture.name}：sessions.get 出站逐字节相同（sha256）`, wireDrop.hash, wireKeep.hash);
    expect(`${fixture.name}：sessions.get 的 messages_total 相同`, wireDrop.total, wireKeep.total);
  }
}

// ── 向后兼容：旧壳 / 新壳两种名字（双向） ──────────────────────────────────────

async function judgeShellNamingAlias(
  fixtures: readonly Fixture[],
  workRoot: string,
): Promise<void> {
  section('旧壳 + 新代码：覆盖水位只按旧名字写，投影输出必须与 keep 逐字节相同');
  const fixture = fixtures.find((item) => item.name === 'syn-compact-stale');
  if (fixture === undefined) {
    fail('别名夹具缺失', '没找到 syn-compact-stale');
    return;
  }
  const keep = await readProjection(fixture.dir);
  const cursor = readShell(fixture.dir).derived_upto_seq;
  if (typeof cursor !== 'number') {
    fail('别名夹具：旧壳里没有 derived_upto_seq', '夹具不成立');
    return;
  }
  const shells: Array<{ label: string; key?: (typeof CURSOR_KEYS)[number] }> = [
    { label: '只写旧名字 derived_upto_seq', key: 'derived_upto_seq' },
    { label: '只写新名字 projection_cache_seq', key: 'projection_cache_seq' },
  ];
  for (const shell of shells) {
    const dir = join(workRoot, `alias-${String(shell.key)}`);
    cpSync(fixture.dir, dir, { recursive: true });
    const raw = readShell(dir);
    for (const key of CURSOR_KEYS) delete raw[key];
    if (shell.key !== undefined) raw[shell.key] = cursor;
    writeShell(dir, raw);
    const got = await readProjection(dir);
    expect(`${shell.label}：投影逐字节相同`, got.hash, keep.hash);
  }
  // 两个名字都在、值不同 ⇒ 新名字优先（旧名字只是别名，不参与判定）。
  {
    const dir = join(workRoot, 'alias-both');
    cpSync(fixture.dir, dir, { recursive: true });
    const raw = readShell(dir);
    raw.derived_upto_seq = 1;
    raw.projection_cache_seq = cursor;
    writeShell(dir, raw);
    const got = await readProjection(dir);
    expect('两个名字都在（值冲突）：投影逐字节相同', got.hash, keep.hash);
  }
}

async function judgeBackwardCompat(workRoot: string): Promise<void> {
  section('新壳 + 旧代码 / 旧壳 + 新代码：落盘键的双向可读');
  const dir = join(workRoot, 'compat-store');
  const store = new FileSessionStore(dir);
  const base: SessionState = {
    session_id: SESSION_ID,
    created_at: 1_760_000_000_000,
    updated_at: 1_760_000_001_000,
    status: 'completed',
    messages: [],
  };

  await store.save({ ...base, derived_upto_seq: 42 });
  const rawLegacy = readShell(dir);
  expect('旧名写入 ⇒ 旧键仍在（旧代码可读）', rawLegacy.derived_upto_seq, 42);
  expect('旧名写入 ⇒ 新键同值（新代码读同一个数）', rawLegacy.projection_cache_seq, 42);
  const legacyLoaded = await store.load(SESSION_ID);
  expect('旧壳 + 新代码：新名字拿到值', legacyLoaded?.projection_cache_seq, 42);
  expect('旧壳 + 新代码：旧名字保留（不搬走）', legacyLoaded?.derived_upto_seq, 42);

  await store.save({ ...base, projection_cache_seq: 43 });
  const rawModern = readShell(dir);
  expect('新名写入 ⇒ 旧键同值（旧代码忽略未知键仍拿到覆盖）', rawModern.derived_upto_seq, 43);
  expect('新名写入 ⇒ 新键在', rawModern.projection_cache_seq, 43);
  const modernLoaded = await store.load(SESSION_ID);
  expect('新壳 + 旧代码：旧名字有值', modernLoaded?.derived_upto_seq, 43);
  expect('新壳 + 新代码：新名字同值', modernLoaded?.projection_cache_seq, 43);
  // 旧代码是「忽略未知键」的读者：把新键剥掉之后，它看到的东西必须与今天完全一样。
  const asOldReader: Record<string, unknown> = { ...rawModern };
  delete asOldReader.projection_cache_seq;
  expect('新壳被旧读者读（剥掉未知键）：覆盖水位不丢', asOldReader.derived_upto_seq, 43);
}

// ── 收口 ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const workRoot = mkdtempSync(join(tmpdir(), 'vessel-proj-b3-'));
  console.log(`夹具根目录：${workRoot}`);
  try {
    section('夹具构造（真事件日志 + 真会话壳）');
    const fixtures = await buildFixtures(workRoot);
    ok(`夹具 ${String(fixtures.length)} 条：${fixtures.map((item) => item.name).join(' / ')}`);
    for (const fixture of fixtures) await judgeFixture(fixture, workRoot);
    await judgeSessionsGet(fixtures);
    await judgeShellNamingAlias(fixtures, workRoot);
    await judgeBackwardCompat(workRoot);
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }

  console.log('');
  if (failures.length === 0) {
    console.log(`投影缓存无关键探针：全部通过（${String(passed)} 条断言）`);
    process.exit(0);
  }
  console.log(`投影缓存无关键探针：${String(failures.length)} 条失败 / ${String(passed)} 条通过`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}

await main();
