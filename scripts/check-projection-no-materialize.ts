#!/usr/bin/env bun

/**
 * 门禁：满投影不再把清集替换物化进 `SessionState`（0.54，方案①）。
 *
 * 不变量（也写进了 `SessionState.messages` 的类型注释）：这个字段是**原文视图**，
 * 不允许出现清集替换的占位正文（`isClearedToolResult(content)` 为真的 tool 消息）；
 * 占位只活在**请求视图**（`withClearedToolResults`）与 **UI 派生投影**
 * （`sessions.get.session.messages[i].projection`）里。
 *
 * 为什么这条是「关掉最后一个口子」：存量体检证明「压缩就地改写」早已修掉，残留入口只有
 * `loadStoredHistory` 的**满投影** —— `projectMessages` 默认应用清集替换 ⇒
 * `seedTransientContext` 塞进工作上下文 ⇒ `finalizeSessionState` / `saveSessionState`
 * 把占位写回盘上，并且**粘住**（`derived_upto_seq` 越过压缩事件之后永远走增量）。
 * 实测：`docs/dev/reports/0.54/proj-readback-15.md` §1.6（尾部压缩）/ §1.8（缓存不可用）/
 * §1.9（尾部撤回）/ §1.7（粘性）。规格：`docs/dev/handoff/plan-projection-no-materialize.md`。
 *
 * 为什么必须是真东西：投影分支（增量 vs 满投影）、占位替换、写回、请求视图的冻结集合、
 * 出站裁剪、摘要器输入，全都只有在「真落盘 + 真读回 + 真请求」时才会连起来。所以本探针用
 * 真 `ExecutionUnit` + 真 `FileSessionStore` + 真 `SessionEventLog` + 真 `sessions.get`
 * handler + 真 `agent` 工具 handler + 真摘要器回调；落盘目录在 `os.tmpdir()`，测完删。
 *
 * 覆盖（每条都对应规格 §6 的一条断言）：
 *
 * - N0 静态闸：`packages/**` 与 `src/**` 里**每一个** `projectMessages(` 调用点都必须传
 *   `applyClearedReplacements: false`（函数定义除外）。这是「不许再开新口子」的机械判据。
 * - N1 满投影三个入口（尾部压缩 / 缓存不可用 / 尾部撤回）+ 干净重启对照：恢复后盘上
 *   `messages` 里 **0 条**占位（结构判定，不扫 `[cleared ` 文本），且被点名的 id 正文与
 *   事件日志原文**逐字相同**。
 * - N2 `derived_upto_seq` 照常推进、`cleared_tool_call_ids` 照旧落盘（它是模型视图的输入）。
 * - N3 反向：恢复后**第一轮请求**里那些 id 仍是占位，占位文本与 `formatClearedToolResult`
 *   逐字相同（证明模型视图没退化）。
 * - N4 纯函数对照：`applyClearedReplacements` true / false 两跑，条数与顺序逐条相同，
 *   只有占位处不同；反事实（true 跑确实有占位）保证断言不是真空绿。
 * - N5 `kept` 裁尾 + `session.rewound` 截断在 false 下与 true **逐条相同**（事实不受开关影响）。
 * - N6 `sessions.get` 出站：正文是原文，`projection` 走「现算」分支
 *   （`original_available` 不是 `readback` —— 那代表原文已经不在 `messages` 里）。
 * - N7 摘要器看到的也是原文（压缩摘要不会建立在占位之上）。
 * - N8 读点 ② / ⑤：`agent read` 工具返回原文、会话搜索能在原文里命中。
 *
 * 用法：bun run scripts/check-projection-no-materialize.ts（退出码 0 = 全过，1 = 有 FAIL）
 */

import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { createAgentTool } from '../packages/agent/src/index';
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
  type ProjectableEvent,
  projectMessages,
  resolveProjection,
  SessionEventLog,
  type SessionEventRecord,
  type SessionState,
  type ToolDefinition,
} from '../packages/core/src/index';
import { createSessionMethods } from '../packages/serve/src/gateway/methods/sessions';
import { searchSessions } from '../packages/serve/src/session-search';

const SESSION_ID = 's-no-materialize';
const SYSTEM_PROMPT = 'probe system prompt for projection no-materialize';
const TOOL_NAME = 'bash';
const OWNER_ID = 'owner-root';
const OWNER_SESSION = 's-owner';

/**
 * 窗口 20000 tokens：0.85 阈值 = 17000，单条工具结果 ≈ 1400 tokens ⇒ 十几轮后压缩。
 * 两个数是被判据卡死的（与 `probe-proj-readback.ts` 同一套口径）：
 * - 压缩保留区 = 20000 × 0.3 = 6000 tokens ⇒ 压缩后窗口里还剩几条工具结果（占位才有东西可换）；
 * - 工具结果保留预算 = 20000 × 5% = 1000 tokens < 1400 ⇒ 只留最新 1 条原文，其余全进
 *   `cleared_tool_call_ids`（否则集合为空，整条探针退化成假绿）。
 */
const WINDOW_TOKENS = 20_000;
/** 工具结果正文 ≈ 5700 字符 ≈ 1400 tokens，末尾带 `exit code: 1`。 */
const TOOL_BODY = `${Array.from({ length: 150 }, (_, index) => `build log line ${String(index)} xxxxxxxxxxxxxx`).join('\n')}\nexit code: 1`;
/** 每轮收尾的 assistant 正文：请求里的旧结果被占位后请求很小，靠它把真实锚点顶上去。 */
const ASSISTANT_TAIL = `assistant tail ${'a'.repeat(2000)}`;
/** 只在**原文**里出现的串（占位正文里没有）：用来区分「原文」与「占位」。 */
const RAW_ONLY_MARK = 'build log line 0 ';
/** 占位正文的前缀（只用于反事实断言，判身份一律走 `isClearedToolResult`）。 */
const CLEARED_PREFIX = '[cleared ';

const failures: string[] = [];
let passed = 0;

function ok(label: string): void {
  passed += 1;
  console.log(`  ok   ${label}`);
}

function fail(label: string, detail: string): void {
  failures.push(`${label}：${detail}`);
  console.log(`  FAIL ${label}：${detail}`);
}

function expect(label: string, actual: unknown, want: unknown): void {
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a === w) ok(`${label} — ${a}`);
  else fail(label, `want ${w} got ${a}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/** 每条工具结果的身份（顺序 = 窗口顺序），不依赖正文。 */
function toolIdList(messages: readonly Message[]): string[] {
  return messages
    .filter((message) => message.role === 'tool')
    .map((message) => String(message.tool_call_id ?? ''));
}

/** 占位工具结果（**结构判定**：`isClearedToolResult`，不扫前缀文本）。 */
function placeholderToolMessages(messages: readonly Message[]): Message[] {
  return messages.filter(
    (message) => message.role === 'tool' && isClearedToolResult(String(message.content ?? '')),
  );
}

/** 正文里含原文标记的 tool 消息（用来证明「是原文，不只是『不是占位』」）。 */
function rawToolMessages(messages: readonly Message[]): Message[] {
  return messages.filter(
    (message) => message.role === 'tool' && String(message.content ?? '').includes(RAW_ONLY_MARK),
  );
}

/** 从事件日志里取「原文」：`tool.call.completed` / `tool.call.failed` 的正文。 */
function rawBodyById(events: readonly ProjectableEvent[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const event of events) {
    const data = (event.data ?? {}) as Record<string, unknown>;
    const id = typeof data.tool_call_id === 'string' ? data.tool_call_id : undefined;
    if (id === undefined) continue;
    if (event.type === 'tool.call.completed' && typeof data.result === 'string') {
      out.set(id, data.result);
    } else if (event.type === 'tool.call.failed' && typeof data.content === 'string') {
      out.set(id, data.content);
    }
  }
  return out;
}

function seqOfType(events: readonly SessionEventRecord[], type: string): number | undefined {
  const record = events.find((event) => event.type === type);
  return (record as { seq?: number } | undefined)?.seq;
}

function head(text: string, max = 80): string {
  const flat = text.replace(/\n/gu, '\\n');
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

// ── 假 provider：每轮最多一次工具调用，之后收尾 ────────────────────────────────

class ScriptedProvider implements LLMProvider {
  /** 本轮是否要发一次工具调用（探针在 run 之间改它）。 */
  toolPerRun = true;
  /** 每次请求的 messages 快照（「模型实际看到了什么」的唯一证据）。 */
  readonly requests: Message[][] = [];
  private seq = 0;

  async chat(request: ChatRequest): Promise<LLMResponse> {
    this.requests.push(structuredClone(request.messages) as Message[]);
    let lastUser = -1;
    for (let index = 0; index < request.messages.length; index += 1) {
      if (request.messages[index]?.role === 'user') lastUser = index;
    }
    const produced = request.messages
      .slice(lastUser + 1)
      .filter((message) => message.role === 'tool').length;
    // usage 必须跟着请求体量走：runtime 用 per-request `prompt_tokens` 当真实锚点，
    // 写死小数字会让段起点压缩永远不触发（探针会空转成假绿）。
    const promptTokens = request.messages.reduce(
      (sum, message) => sum + Math.ceil(String(message.content ?? '').length / 4),
      0,
    );
    const usage = {
      prompt_tokens: promptTokens,
      completion_tokens: 5,
      total_tokens: promptTokens + 5,
    };
    if (this.toolPerRun && produced === 0) {
      this.seq += 1;
      return {
        content: '',
        finish_reason: 'tool_calls',
        tool_calls: [
          {
            id: `call_${String(this.seq)}`,
            type: 'function',
            function: { name: TOOL_NAME, arguments: '{"command":"pnpm build"}' },
          },
        ],
        usage,
      };
    }
    return { content: ASSISTANT_TAIL, finish_reason: 'stop', usage };
  }
}

const toolPlugin: Plugin = {
  name: 'probe-no-materialize-tools',
  install(host): void {
    const tool: ToolDefinition = {
      name: TOOL_NAME,
      description: 'probe tool that returns a big body with an exit code',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => TOOL_BODY,
    };
    host.registerTool(tool);
  },
};

// ── 一个「节点」= 一份落盘目录 + 真事件日志 + 一个 ExecutionUnit ──────────────

interface Node {
  readonly provider: ScriptedProvider;
  readonly log: SessionEventLog;
  run(text: string): Promise<void>;
  records(): Promise<SessionEventRecord[]>;
  stop(): void;
}

const sessionFile = (dir: string): string => join(dir, `${encodeURIComponent(SESSION_ID)}.json`);

/** 「重启」= 丢掉旧节点（store / 日志实例 / provider / EU 全丢），用同一个 dir 再造一个。 */
async function startNode(dir: string): Promise<Node> {
  const events = new MemoryEventStream();
  const log = new SessionEventLog({ dir, durable: false });
  const store = new FileSessionStore(dir);
  const provider = new ScriptedProvider();
  const eu = await ExecutionUnit.create({
    provider: provider as never,
    model: 'probe/no-materialize',
    contextFactory: () => {
      const context = new MemoryWorkingContext({ maxTokens: WINDOW_TOKENS, autoCompact: true });
      context.setSessionId(SESSION_ID);
      return context;
    },
    events,
    limits: {},
    termination: {},
    journalFactory: createRunJournalFactory({ session: store as never, eventLog: log }),
    session: store as never,
    eventLog: log,
    plugins: [toolPlugin],
    systemPrompt: SYSTEM_PROMPT,
    retry: { maxRetries: 0 },
  });
  return {
    provider,
    log,
    async run(text: string) {
      await eu.run(text, SESSION_ID);
      await waitPersisted(dir);
    },
    async records() {
      await log.flush(SESSION_ID);
      return log.read(SESSION_ID);
    },
    stop() {
      eu.dispose?.();
    },
  };
}

/** journal 的写是异步排队的：等到 status 不再 running（= 本轮终态已落盘）。 */
async function waitPersisted(dir: string): Promise<void> {
  for (let tick = 0; tick < 800; tick += 1) {
    const fresh = await new FileSessionStore(dir).load(SESSION_ID);
    if (fresh !== null && fresh !== undefined && fresh.status !== 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('session state 没有落盘');
}

async function readEvents(dir: string): Promise<SessionEventRecord[]> {
  const log = new SessionEventLog({ dir, durable: false });
  try {
    await log.flush(SESSION_ID).catch(() => undefined);
    return await log.read(SESSION_ID);
  } finally {
    await log.release(SESSION_ID).catch(() => undefined);
  }
}

async function loadState(dir: string): Promise<SessionState | null> {
  return await new FileSessionStore(dir).load(SESSION_ID);
}

// ── N0：静态闸 —— 不许再开新口子 ─────────────────────────────────────────────

const PRODUCT_ROOTS = ['packages', 'src', 'apps/web/src'] as const;
/** 调用点必须显式带上这个实参（`projectMessages` 的缺省是 `true`，即「会物化占位」）。 */
const REQUIRED_OPTION = 'applyClearedReplacements: false';

function listSourceFiles(root: string, out: string[]): string[] {
  for (const entry of readdirSync(root)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(root, entry);
    if (statSync(full).isDirectory()) listSourceFiles(full, out);
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

function lineNumberOf(text: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text[cursor] === '\n') line += 1;
  }
  return line;
}

/**
 * 判据：产品代码（`packages/**`、`src/**`）里每一个 `projectMessages(` **调用点**都必须
 * 显式传 `applyClearedReplacements: false`。
 *
 * 为什么拿静态闸兜这一层：这条不变量（`SessionState.messages` = 原文视图）的破法只有一种 ——
 * 新增/改回一个默认口径的调用点，占位就又会被 `finalizeSessionState` 写回盘上，而**行为
 * 断言只在探针跑过的入口上有效**（新入口可能一步都没被覆盖）。函数定义、注释里的引用不算。
 */
function judgeProjectCallSites(): void {
  const offenders: string[] = [];
  const labels: string[] = [];
  for (const root of PRODUCT_ROOTS) {
    for (const file of listSourceFiles(root, [])) {
      const text = readFileSync(file, 'utf8');
      let index = text.indexOf('projectMessages(');
      while (index >= 0) {
        const next = index + 'projectMessages('.length;
        const before = text.slice(Math.max(0, index - 40), index);
        const lineStart = text.lastIndexOf('\n', index) + 1;
        const lineEnd = text.indexOf('\n', index);
        const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).trim();
        const isDefinition = /function\s*$/u.test(before);
        const isComment = line.startsWith('*') || line.startsWith('//') || line.startsWith('/*');
        if (!isDefinition && !isComment) {
          const site = `${relative(process.cwd(), file)}:${String(lineNumberOf(text, index))}`;
          const args = text.slice(index, index + 240).replace(/\s+/gu, ' ');
          labels.push(site);
          if (!args.includes(REQUIRED_OPTION)) offenders.push(`${site} → ${args.slice(0, 80)}`);
        }
        index = text.indexOf('projectMessages(', next);
      }
    }
  }
  // 4 个已知调用点：增量投影 / 满投影 / idle 会话压缩 / 派生会话的种子。
  expect('N0.1 产品代码里的 projectMessages 调用点数量（≥4）', labels.length >= 4, true);
  expect(`N0.2 每个调用点都显式传「${REQUIRED_OPTION}」`, offenders, []);
  if (labels.length > 0) ok(`N0.3 扫描到的调用点：${labels.join(' / ')}`);
}

// ── N4：纯函数对照 —— true / false 两跑只有「替换」不同 ───────────────────────

function judgePureProjection(events: readonly ProjectableEvent[]): void {
  const withReplacement = projectMessages(events);
  const original = projectMessages(events, { applyClearedReplacements: false });

  expect('N4.1 两跑的消息条数相同', original.length, withReplacement.length);
  expect(
    'N4.2 两跑的 role 序列逐条相同',
    withReplacement.map((message) => message.role),
    original.map((message) => message.role),
  );
  expect(
    'N4.3 两跑的 tool_call_id 序列逐条相同',
    toolIdList(withReplacement),
    toolIdList(original),
  );

  // 身份（run_id / run_segment / timestamp / tool_calls / compaction_summary）也不许因开关而变。
  const identityMismatch: string[] = [];
  for (let index = 0; index < original.length; index += 1) {
    const left = withReplacement[index];
    const right = original[index];
    if (left === undefined || right === undefined) {
      identityMismatch.push(`${String(index)}:缺一条`);
      continue;
    }
    const same =
      left.name === right.name &&
      left.compaction_summary === right.compaction_summary &&
      left.run_id === right.run_id &&
      left.run_segment === right.run_segment &&
      left.timestamp === right.timestamp &&
      JSON.stringify(left.tool_calls ?? null) === JSON.stringify(right.tool_calls ?? null);
    if (!same) identityMismatch.push(`${String(index)}:${left.role}`);
  }
  expect('N4.4 两跑除正文外逐条身份相同', identityMismatch, []);

  const diff: number[] = [];
  for (let index = 0; index < original.length; index += 1) {
    if (withReplacement[index]?.content !== original[index]?.content) diff.push(index);
  }
  // 反事实（防真空绿）：这条日志里**确实**有可替换的条目，否则 N4.5~N4.7 等于没跑。
  expect('N4.5 两跑的差异位置非空（日志里确有可替换的旧工具结果）', diff.length > 0, true);

  const wrong: string[] = [];
  for (const index of diff) {
    const replaced = withReplacement[index];
    const raw = original[index];
    if (replaced === undefined || raw === undefined) continue;
    if (replaced.role !== 'tool' || raw.role !== 'tool') {
      wrong.push(`${String(index)}:${replaced.role} 不是 tool`);
      continue;
    }
    if (!isClearedToolResult(String(replaced.content ?? ''))) {
      wrong.push(`${String(index)}:换出来的不是占位`);
      continue;
    }
    if (isClearedToolResult(String(raw.content ?? ''))) {
      wrong.push(`${String(index)}:原始那跑已经是占位`);
      continue;
    }
    const expected = formatClearedToolResult(
      original,
      String(raw.tool_call_id ?? ''),
      String(raw.content ?? ''),
    );
    if (replaced.content !== expected) {
      wrong.push(`${String(index)}:占位文本对不上 ${head(String(replaced.content ?? ''), 40)}`);
    }
  }
  expect(
    `N4.6 差异位置全部是「原文 → formatClearedToolResult 的占位」（${String(diff.length)} 处）`,
    wrong,
    [],
  );

  // 反向：false 那跑里一条占位都不许有（这是本单的核心断言在纯函数层的形态）。
  expect('N4.7 false 跑的产物里 0 条占位工具结果', placeholderToolMessages(original).length, 0);
  expect(
    'N4.8 对照：true 跑的产物里确实有占位（否则本探针测不到替换）',
    placeholderToolMessages(withReplacement).length > 0,
    true,
  );
  const rawInOriginal = rawToolMessages(original).length;
  expect('N4.9 false 跑里含原文标记的工具结果 > 0（不是「什么都没有」）', rawInOriginal > 0, true);
}

// ── N5：kept 裁尾 + rewound 截断是事实，开关不许影响 ─────────────────────────

/** 造一条「压缩替换 + kept 裁尾 + 撤回截断」全都在的事件流（纯手写，不依赖真 run）。 */
function syntheticTrimmingEvents(rewoundKeep: number | undefined): ProjectableEvent[] {
  const big = `${RAW_ONLY_MARK}${'x'.repeat(200)}`;
  const events: ProjectableEvent[] = [
    { type: 'user.message', ts: 1, data: { content: 'u0' } },
    {
      type: 'llm.response',
      ts: 2,
      data: {
        content: '',
        tool_calls: [
          { id: 'call_a', type: 'function', function: { name: TOOL_NAME, arguments: '{}' } },
        ],
      },
    },
    { type: 'tool.call.completed', ts: 3, data: { tool_call_id: 'call_a', result: big } },
    { type: 'user.message', ts: 4, data: { content: 'u1' } },
    {
      type: 'llm.response',
      ts: 5,
      data: {
        content: '',
        tool_calls: [
          { id: 'call_b', type: 'function', function: { name: TOOL_NAME, arguments: '{}' } },
        ],
      },
    },
    { type: 'tool.call.completed', ts: 6, data: { tool_call_id: 'call_b', result: 'small-b' } },
    { type: 'user.message', ts: 7, data: { content: 'u2' } },
    {
      type: 'message.compaction',
      ts: 8,
      data: { summary: 'S', kept: 6, cleared_tool_call_ids: ['call_a'] },
    },
  ];
  if (rewoundKeep !== undefined) {
    events.push({
      type: 'session.rewound',
      ts: 9,
      data: { keep_messages: rewoundKeep, keep_projected: rewoundKeep },
    });
  }
  return events;
}

function judgeTrimmingIsFact(): void {
  // ① 只有 kept：7 条 → 裁到 6 条非 system + 1 条摘要。u0 必须被裁掉。
  for (const apply of [true, false]) {
    const label = apply ? 'true' : 'false';
    const projected = projectMessages(syntheticTrimmingEvents(undefined), {
      applyClearedReplacements: apply,
    });
    const contents = projected.map((message) => String(message.content ?? ''));
    expect(`N5.1 kept 裁尾（${label}）：条数 = 1 摘要 + kept 6`, projected.length, 7);
    expect(`N5.2 kept 裁尾（${label}）：u0 已被裁掉`, contents.includes('u0'), false);
    expect(`N5.3 kept 裁尾（${label}）：u2 仍在`, contents.includes('u2'), true);
    expect(
      `N5.4 kept 裁尾（${label}）：最后一条仍是 u2（顺序不变）`,
      projected[projected.length - 1]?.content,
      'u2',
    );
  }

  // ② kept + rewound：截到 5 条（call_b / u2 被撤回掉，call_a 仍活）。
  const withReplacement = projectMessages(syntheticTrimmingEvents(5));
  const original = projectMessages(syntheticTrimmingEvents(5), { applyClearedReplacements: false });
  expect('N5.5 rewound 截断后条数（true）', withReplacement.length, 5);
  expect('N5.6 rewound 截断后条数（false，两跑必须相同）', original.length, 5);
  expect(
    'N5.7 rewound 截断后 role 序列逐条相同',
    withReplacement.map((message) => message.role),
    original.map((message) => message.role),
  );
  expect(
    'N5.8 rewound 截断后 tool_call_id 序列逐条相同',
    toolIdList(withReplacement),
    toolIdList(original),
  );
  expect('N5.9 rewound 截断后 tool_call_id 只剩 call_a（call_b 真被撤回）', toolIdList(original), [
    'call_a',
  ]);
  const withReplacementBody = withReplacement[2];
  const originalBody = original[2];
  expect(
    'N5.10 true 跑里那条是占位',
    isClearedToolResult(String(withReplacementBody?.content ?? '')),
    true,
  );
  expect(
    'N5.11 false 跑里那条是原文（含原文标记、不是占位）',
    [
      String(originalBody?.content ?? '').includes(RAW_ONLY_MARK),
      isClearedToolResult(String(originalBody?.content ?? '')),
    ],
    [true, false],
  );
  // 除那一条正文外，两跑逐条相同（证明开关只动正文）。
  const mismatch: string[] = [];
  for (let index = 0; index < original.length; index += 1) {
    const left = withReplacement[index];
    const right = original[index];
    if (left === undefined || right === undefined) continue;
    if (left.role !== right.role || left.tool_call_id !== right.tool_call_id) {
      mismatch.push(`${String(index)}:身份不同`);
    }
    if (index !== 2 && left.content !== right.content) mismatch.push(`${String(index)}:正文不同`);
  }
  expect('N5.12 除占位那一处外，两跑逐条相同', mismatch, []);
}

// ── 恢复路径：真 ExecutionUnit 从盘上重建 ────────────────────────────────────

/** 事件日志里所有压缩事件点名的 id（跨多条取并集，保序）。 */
function auditedIdsOf(events: readonly SessionEventRecord[]): string[] {
  const out: string[] = [];
  for (const event of events) {
    if (event.type !== 'message.compaction') continue;
    const ids = (event.data as { cleared_tool_call_ids?: unknown } | undefined)
      ?.cleared_tool_call_ids;
    if (!Array.isArray(ids)) continue;
    for (const id of ids) {
      if (typeof id === 'string' && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

interface RestoredFacts {
  readonly state: SessionState | null;
  /** 恢复后**第一轮请求**的消息数组（模型实际看到的那一份）。 */
  readonly firstRequest: readonly Message[];
  /** 那条请求里 id → 占位正文。 */
  readonly placeholderById: Map<string, string>;
}

/**
 * 起一个节点跑一轮（= 「重启后接管」），然后对**盘上**与**第一轮请求**同时下断言。
 *
 * `label` 里的入口名由调用方给（干净重启 / 尾部压缩 / 缓存不可用 / 尾部撤回）——
 * 四个入口跑同一条判据，才不会「只有我测过的那条路是干净的」。
 */
async function judgeRestoredSession(
  label: string,
  dir: string,
  anchors: { minSeq: number; previousDerived?: number | undefined },
): Promise<RestoredFacts> {
  const node = await startNode(dir);
  node.provider.toolPerRun = false;
  try {
    await node.run('after restart');
  } finally {
    node.stop();
  }
  const state = await loadState(dir);
  const events = await readEvents(dir);
  const raw = rawBodyById(events);
  const audited = new Set(auditedIdsOf(events));
  const disk = state?.messages ?? [];
  const firstRequest = node.provider.requests[0] ?? [];

  // ── N1：结构判定 —— 盘上一条占位都不许有 ────────────────────────────────
  const placeholders = placeholderToolMessages(disk);
  expect(`N1.1 ${label}：恢复后盘上 messages 里 0 条占位工具结果`, placeholders.length, 0);
  if (placeholders.length > 0) {
    fail(
      `N1.1 ${label}`,
      `占位被物化进盘上：${placeholders
        .slice(0, 3)
        .map(
          (message) => `${String(message.tool_call_id)}=${head(String(message.content ?? ''), 48)}`,
        )
        .join(' , ')}`,
    );
  }
  // 反真空绿：窗口里必须**仍有**曾经被点名（会被替换）的 id，否则上面那条 0 是因为没东西可换。
  const namedInWindow = disk.filter(
    (message) =>
      message.role === 'tool' &&
      typeof message.tool_call_id === 'string' &&
      audited.has(message.tool_call_id),
  );
  expect(
    `N1.2 ${label}：窗口里仍有被点名过的工具结果（判据非真空绿）> 0`,
    namedInWindow.length > 0,
    true,
  );
  // 且那些条目正文必须**逐字等于事件日志原文**（「不是占位」不等于「是原文」）。
  const bodyMismatch: string[] = [];
  for (const message of namedInWindow) {
    const expected = raw.get(String(message.tool_call_id));
    if (expected === undefined) continue;
    if (message.content !== expected) {
      bodyMismatch.push(
        `${String(message.tool_call_id)}:${head(String(message.content ?? ''), 40)}`,
      );
    }
  }
  expect(`N1.3 ${label}：被点名条目的正文与事件日志原文逐字相同`, bodyMismatch, []);

  // ── N2：derived_upto_seq 照常推进 + cleared_tool_call_ids 照旧落盘 ───────
  // 为什么口径是「越过替换类事件 + 比原游标更前」而不是「≥ 日志最后一条 seq」：落盘发生在
  // 收尾路径里，之后还会追加收尾事件（`session.saved` 之类），所以最后一条 seq 只能更大。
  const derived = state?.derived_upto_seq;
  expect(`N2.1 ${label}：derived_upto_seq 仍是 number`, typeof derived === 'number', true);
  expect(
    `N2.2 ${label}：derived_upto_seq 已越过被重放的替换类事件（${String(derived)} ≥ ${String(anchors.minSeq)}）`,
    typeof derived === 'number' ? derived >= anchors.minSeq : false,
    true,
  );
  if (anchors.previousDerived !== undefined) {
    expect(
      `N2.2b ${label}：derived_upto_seq 比恢复前的游标更前（${String(derived)} > ${String(anchors.previousDerived)}）`,
      typeof derived === 'number' ? derived > anchors.previousDerived : false,
      true,
    );
  }
  const frozen = state?.cleared_tool_call_ids;
  expect(`N2.3 ${label}：cleared_tool_call_ids 照旧落盘（数组）`, Array.isArray(frozen), true);
  expect(`N2.4 ${label}：本段确实清过（集合非空）`, (frozen ?? []).length > 0, true);

  // ── N3：反向 —— 第一轮请求里那些 id 仍是占位 ────────────────────────────
  const placeholderById = new Map<string, string>();
  for (const message of firstRequest) {
    if (message.role !== 'tool') continue;
    const content = String(message.content ?? '');
    if (!isClearedToolResult(content)) continue;
    placeholderById.set(String(message.tool_call_id ?? ''), content);
  }
  expect(
    `N3.1 ${label}：恢复后第一轮请求里确实有占位（模型视图没退化）> 0`,
    placeholderById.size > 0,
    true,
  );
  if (placeholderById.size === 0) {
    fail(`N3.1 ${label}`, '第一轮请求里一条占位都没有 —— 模型会看到原文，token 白省');
  }
  const requestToolIds = new Set(toolIdList(firstRequest));
  const expectedPlaceholders = [...new Set(frozen ?? [])]
    .filter((id) => requestToolIds.has(id))
    .sort();
  expect(
    `N3.2 ${label}：请求里的占位 id 恰好 = 本段冻结集合 ∩ 窗口工具结果（不多不少）`,
    [...placeholderById.keys()].sort(),
    expectedPlaceholders,
  );
  const placeholderMismatch: string[] = [];
  for (const [id, text] of placeholderById) {
    const expectedRaw = raw.get(id);
    if (expectedRaw === undefined) {
      placeholderMismatch.push(`${id}:事件日志里没有原文`);
      continue;
    }
    const expected = formatClearedToolResult(disk, id, expectedRaw);
    if (text !== expected)
      placeholderMismatch.push(`${id}:${head(text, 48)} ≠ ${head(expected, 48)}`);
  }
  expect(
    `N3.3 ${label}：每条占位 = formatClearedToolResult(原文)（逐字，与请求层同一函数）`,
    placeholderMismatch,
    [],
  );
  // 没被点名的工具结果必须保留原文（占位不许溢出到新结果上）。
  const leaked: string[] = [];
  for (const message of firstRequest) {
    if (message.role !== 'tool') continue;
    const id = String(message.tool_call_id ?? '');
    if (placeholderById.has(id)) continue;
    const expectedRaw = raw.get(id);
    if (expectedRaw === undefined) continue;
    if (message.content !== expectedRaw) leaked.push(id);
  }
  expect(`N3.4 ${label}：没被点名的工具结果在请求里保留原文`, leaked, []);

  return { state, firstRequest, placeholderById };
}

// ── N6：sessions.get 的出站形状 ──────────────────────────────────────────────

interface WireProjection {
  mode?: string;
  tool_call_id?: string;
  placeholder_text?: string;
  placeholder_hash?: string;
  original_available?: string;
}

interface WireMessage {
  role?: string;
  content?: string;
  tool_call_id?: string;
  projection?: WireProjection;
}

async function sessionsGet(dir: string): Promise<{
  messages: WireMessage[];
  summary?: { total?: number; modes?: Record<string, number>; unknown_original_count?: number };
}> {
  const methods = createSessionMethods({ sessionFor: () => new FileSessionStore(dir) } as never);
  const method = methods.find((entry) => entry.name === 'sessions.get');
  if (method === undefined) throw new Error('找不到 RPC 方法 sessions.get');
  // 出站形状：消息挂在 `session` 下（不是顶层）。
  const result = (await method.handler({ session_id: SESSION_ID }, {} as never)) as {
    session?: { messages?: WireMessage[]; projection_summary?: Record<string, unknown> };
  };
  return {
    messages: result.session?.messages ?? [],
    ...(result.session?.projection_summary !== undefined
      ? { summary: result.session.projection_summary as never }
      : {}),
  };
}

async function judgeWire(dir: string, facts: RestoredFacts, label: string): Promise<void> {
  const wire = await sessionsGet(dir);
  const wireToolMessages = wire.messages.filter((message) => message.role === 'tool');
  // ④ `capToolMessages` 这条读路径**本来就该**看到原文（wire 的 projection 负责派生显示）。
  const leaked = wireToolMessages.filter((message) =>
    isClearedToolResult(String(message.content ?? '')),
  );
  expect(`N6.1 ${label}：sessions.get 出站正文里 0 条占位（读回的是原文）`, leaked.length, 0);
  const rawInWire = wireToolMessages.filter((message) =>
    String(message.content ?? '').includes(RAW_ONLY_MARK),
  );
  expect(
    `N6.2 ${label}：sessions.get 出站里确实有原文（判据非真空绿）> 0`,
    rawInWire.length > 0,
    true,
  );

  const projected = wireToolMessages.filter((message) => message.projection !== undefined);
  expect(
    `N6.3 ${label}：被点名的工具结果带 projection（派生展示层没丢）> 0`,
    projected.length > 0,
    true,
  );
  const wrongMode = projected
    .filter((message) => message.projection?.mode !== 'placeholder')
    .map((message) => `${String(message.tool_call_id)}:${String(message.projection?.mode)}`);
  expect(`N6.4 ${label}：投影模式都是 placeholder`, wrongMode, []);
  // 关键：`readback` 代表「原文已经不在 messages 里」。修好之后这条路走的是「现算」分支。
  const readback = projected
    .filter((message) => message.projection?.original_available === 'readback')
    .map((message) => String(message.tool_call_id));
  expect(
    `N6.5 ${label}：没有一条退化成 original_available=readback（原文就在 messages 里）`,
    readback,
    [],
  );

  // 模型视图 vs 派生展示：同一 id 的两份占位文本必须逐字相同（同一函数、同一次决策）。
  const mismatch: string[] = [];
  for (const message of projected) {
    const id = String(message.tool_call_id ?? '');
    const requestText = facts.placeholderById.get(id);
    if (requestText === undefined) continue;
    if (String(message.projection?.placeholder_text ?? '') !== requestText) {
      mismatch.push(`${id}:${head(String(message.projection?.placeholder_text ?? ''), 40)}`);
    }
  }
  expect(`N6.6 ${label}：出站 projection 的占位文本 = 请求视图里的那一条（逐字）`, mismatch, []);
  expect(
    `N6.7 ${label}：projection_summary 记到了占位条数（派生层用的是原文，不是二手占位）`,
    (wire.summary?.total ?? 0) > 0,
    true,
  );
}

// ── N7：摘要器看到的也是原文 ────────────────────────────────────────────────

async function judgeSummarizerInput(disk: readonly Message[]): Promise<void> {
  const captured: Message[][] = [];
  const context = new MemoryWorkingContext({
    maxTokens: 8000,
    summarizer: async (messages) => {
      captured.push(messages.map((message) => structuredClone(message)));
      return 'summary-from-probe';
    },
  });
  for (const message of disk) context.add(message);
  const removed = await context.compactAsync();
  expect('N7.1 摘要真的跑了（有消息被移除）', removed > 0, true);
  expect('N7.2 摘要器被调用过', captured.length > 0, true);
  const text = (captured[0] ?? []).map((message) => String(message.content ?? '')).join('\n');
  expect('N7.3 摘要器输入里含原文标记（摘要建立在原文上）', text.includes(RAW_ONLY_MARK), true);
  expect('N7.4 摘要器输入里没有占位正文', text.includes(CLEARED_PREFIX), false);
}

// ── N8：读点 ② / ⑤ ──────────────────────────────────────────────────────────

async function judgeAgentReadTool(
  disk: readonly Message[],
  raw: Map<string, string>,
): Promise<void> {
  const state: SessionState = {
    session_id: SESSION_ID,
    created_at: 1,
    updated_at: 2,
    messages: [...disk],
  };
  const tool = createAgentTool(
    {
      // 只用到这两个方法（`agent read` 的解析步骤），其余动作不触发。
      list: async () => [{ id: 'member-a', session_id: SESSION_ID, name: 'member-a' }],
      identify: async () => ({ session_id: SESSION_ID, state: 'idle' }),
    } as never,
    {
      ownerId: OWNER_ID,
      ownerSessionId: OWNER_SESSION,
      // 与装配层同一份 SessionState（`sessions.get` RPC 也是读它）。
      readSession: async () => ({ messages: state.messages ?? [] }),
    },
  );
  const text = await tool.handler?.({ action: 'read', to: 'member-a', limit: 20 }, {
    run_id: 'run-probe',
    session_id: OWNER_SESSION,
  } as never);
  const payload = JSON.parse(String(text ?? '{}')) as {
    messages?: { role?: string; content?: string }[];
  };
  const bodies = (payload.messages ?? []).map((message) => String(message.content ?? ''));
  expect(
    'N8.1 `agent read` 返回了消息（读点 ⑤：工具把会话正文喂进另一个 agent）',
    bodies.length > 0,
    true,
  );
  expect(
    'N8.2 `agent read` 的正文含原文标记（读到的是原文）',
    bodies.some((body) => body.includes(RAW_ONLY_MARK)),
    true,
  );
  expect(
    'N8.3 `agent read` 的正文里没有占位',
    bodies.some((body) => body.includes(CLEARED_PREFIX)),
    false,
  );
  // 逐字对上前 1000 字符（`agent read` 按 `READ_MESSAGE_MAX_CHARS = 1000` 截断；本探针的
  // 正文远长于它，所以比的是前缀 —— 前缀一致就证明喂进去的是原文，不是占位）。
  const namedRaw = [...raw.entries()].filter(([, body]) => body.includes(RAW_ONLY_MARK));
  const exactPrefix = namedRaw.some(([, body]) =>
    bodies.some((entry) => entry.startsWith(body.slice(0, 200))),
  );
  expect(
    'N8.4 `agent read` 里至少有一条以事件日志原文逐字开头（正文按 1000 字符截断）',
    exactPrefix,
    true,
  );
}

async function judgeSessionSearch(dir: string): Promise<void> {
  const hits = await searchSessions(new FileSessionStore(dir), RAW_ONLY_MARK.trim(), 5);
  expect(
    'N8.5 会话搜索能在原文里命中（读点 ⑤ 的旁路：以前这里搜不到被占位的正文）',
    hits.length > 0,
    true,
  );
  // 反真空绿：占位正文里确实没有这个串（否则命中的可能是占位而不是原文）。
  const placeholder = formatClearedToolResult(
    [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_x', type: 'function', function: { name: TOOL_NAME, arguments: '{}' } },
        ],
      },
      { role: 'tool', content: TOOL_BODY, tool_call_id: 'call_x' },
    ],
    'call_x',
    TOOL_BODY,
  );
  expect('N8.6 反真空绿：占位正文里没有这个串', placeholder.includes(RAW_ONLY_MARK), false);
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // N0 静态闸先跑：它不依赖任何落盘。
  judgeProjectCallSites();
  judgeTrimmingIsFact();

  const root = mkdtempSync(join(tmpdir(), 'vessel-no-materialize-'));
  console.log(`\n探针数据目录（临时）：${root}`);
  try {
    await runRealRestore(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  console.log('');
  if (failures.length === 0) {
    console.log(`投影不物化判据：通过 ${String(passed)} 项，0 项红。`);
    process.exit(0);
  }
  console.log(`投影不物化判据：通过 ${String(passed)} 项，红 ${String(failures.length)} 项：`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}

async function runRealRestore(root: string): Promise<void> {
  const build = join(root, 'build');

  section('阶段 0：真 run × N，直到日志里出现 message.compaction');
  const node = await startNode(build);
  let priorStateJson: string | undefined;
  let turn = 0;
  try {
    for (turn = 1; turn <= 40; turn += 1) {
      let before: string | undefined;
      try {
        before = readFileSync(sessionFile(build), 'utf8');
      } catch {
        before = undefined;
      }
      await node.run(`turn ${String(turn)}`);
      const records = await node.records();
      if (seqOfType(records, 'message.compaction') !== undefined) {
        priorStateJson = before;
        break;
      }
    }
  } finally {
    node.stop();
  }
  await node.log.release(SESSION_ID).catch(() => undefined);

  const events = await readEvents(build);
  const compactSeq = seqOfType(events, 'message.compaction');
  const audited = auditedIdsOf(events);
  const shellAfterCompaction = await loadState(build);
  const resolution = resolveProjection(shellAfterCompaction);
  ok(
    `阶段 0：${String(turn)} 轮后出现 message.compaction（seq ${String(compactSeq)}），` +
      `审计集合 ${String(audited.length)} 条，投射模式 ${resolution.mode}（source=${resolution.source}）`,
  );
  if (compactSeq === undefined || priorStateJson === undefined) {
    fail('阶段 0', '40 轮内没有触发压缩 —— 本探针没覆盖到替换路径，后面全部无意义');
    return;
  }
  expect(
    '阶段 0.1 投射模式是 placeholder（passthrough 不会有占位集合，判据会假绿）',
    resolution.mode,
    'placeholder',
  );
  expect('阶段 0.2 压缩事件点名的审计集合非空', audited.length > 0, true);

  section('N4 纯函数对照：applyClearedReplacements true / false 只有「替换」不同');
  judgePureProjection(events);

  // 每个入口都从这一份冻结快照复制，互不污染。
  const pristine = join(root, 'pristine');
  cpSync(build, pristine, { recursive: true });

  // ── A1：干净重启（增量路径，对照组）──────────────────────────────────────
  section('A1 干净重启（会话壳是最新的 ⇒ 增量；对照：这里本来就不该有占位）');
  const cleanDir = join(root, 'clean');
  cpSync(pristine, cleanDir, { recursive: true });
  expect(
    'A1.0 入口条件成立：derived_upto_seq ≥ 压缩事件 seq（⇒ 走增量）',
    typeof shellAfterCompaction?.derived_upto_seq === 'number' &&
      compactSeq <= (shellAfterCompaction?.derived_upto_seq ?? 0),
    true,
  );
  const a1 = await judgeRestoredSession('A1 干净重启（增量）', cleanDir, {
    minSeq: compactSeq,
    previousDerived: shellAfterCompaction?.derived_upto_seq,
  });
  await judgeWire(cleanDir, a1, 'A1');

  // ── A2：尾部含压缩事件（崩溃窗口）⇒ 满投影 ──────────────────────────────
  section('A2 尾部含压缩事件（= 压缩已发事件、会话壳还是上一轮的：崩溃窗口）⇒ 满投影');
  const crashDir = join(root, 'crash');
  cpSync(pristine, crashDir, { recursive: true });
  writeFileSync(sessionFile(crashDir), priorStateJson);
  const rolledBack = await loadState(crashDir);
  expect(
    'A2.0 入口条件成立：derived_upto_seq < 压缩事件 seq（⇒ 走满投影）',
    typeof rolledBack?.derived_upto_seq === 'number' && rolledBack.derived_upto_seq < compactSeq,
    true,
  );
  expect(
    'A2.0b 回滚后的盘上正文仍是原文（占位只会在恢复时才可能被物化）',
    placeholderToolMessages(rolledBack?.messages ?? []).length,
    0,
  );
  const a2 = await judgeRestoredSession('A2 尾部压缩', crashDir, {
    minSeq: compactSeq,
    previousDerived: rolledBack?.derived_upto_seq,
  });
  await judgeWire(crashDir, a2, 'A2');

  // ── A3：缓存不可用（没有 derived_upto_seq）⇒ 满投影 ─────────────────────
  section('A3 缓存没有 derived_upto_seq（旧数据 / 缓存缺失）⇒ 满投影');
  const noCacheDir = join(root, 'nocache');
  cpSync(pristine, noCacheDir, { recursive: true });
  const shellJson = JSON.parse(readFileSync(sessionFile(noCacheDir), 'utf8')) as Record<
    string,
    unknown
  >;
  delete shellJson.derived_upto_seq;
  writeFileSync(sessionFile(noCacheDir), JSON.stringify(shellJson));
  expect(
    'A3.0 入口条件成立：缓存里的 derived_upto_seq 已经不存在',
    (await loadState(noCacheDir))?.derived_upto_seq,
    undefined as never,
  );
  const a3 = await judgeRestoredSession('A3 缓存不可用', noCacheDir, { minSeq: compactSeq });
  await judgeWire(noCacheDir, a3, 'A3');

  // ── A4：尾部含 session.rewound ⇒ 满投影（最常见的入口）─────────────────
  section('A4 尾部含 session.rewound（撤回 / 分支切换之后的下一次启动）⇒ 满投影');
  const rewoundDir = join(root, 'rewound');
  cpSync(pristine, rewoundDir, { recursive: true });
  const rewindLog = new SessionEventLog({ dir: rewoundDir, durable: false });
  const beforeRewind = await loadState(rewoundDir);
  const keepProjected = (beforeRewind?.messages ?? []).length;
  const appended = await rewindLog.append({
    session_id: SESSION_ID,
    run_id: 'probe-rewind',
    type: 'session.rewound',
    ts: Date.now(),
    data: { keep_messages: keepProjected, keep_projected: keepProjected, reason: 'probe' },
  });
  await rewindLog.flush(SESSION_ID);
  await rewindLog.release(SESSION_ID).catch(() => undefined);
  const rewoundSeq = (appended as unknown as { seq?: number }).seq;
  expect(
    'A4.0 入口条件成立：derived_upto_seq < 撤回事件 seq（⇒ 走满投影）',
    typeof beforeRewind?.derived_upto_seq === 'number' &&
      typeof rewoundSeq === 'number' &&
      beforeRewind.derived_upto_seq < rewoundSeq,
    true,
  );
  const a4 = await judgeRestoredSession('A4 尾部撤回', rewoundDir, {
    minSeq: rewoundSeq ?? compactSeq,
    previousDerived: beforeRewind?.derived_upto_seq,
  });
  await judgeWire(rewoundDir, a4, 'A4');

  // ── N7 / N8：摘要器输入与两条「直接拿 messages 当输入」的读路径 ──────────
  section('N7 摘要器看到的是原文（压缩摘要不建立在占位之上）');
  const crashEvents = await readEvents(crashDir);
  await judgeSummarizerInput(a2.state?.messages ?? []);

  section('N8 读点 ② / ⑤：`agent read` 与会话搜索');
  await judgeAgentReadTool(a2.state?.messages ?? [], rawBodyById(crashEvents));
  await judgeSessionSearch(crashDir);
}

await main();
