#!/usr/bin/env bun
/**
 * 探针：投影卡规格 §1.5 张力的实测（0.54-proj-readback）。
 *
 * 要裁决的三个问题（压缩/重启之后，`sessions.get` 那条被 cleared 的工具消息正文到底是什么）：
 *
 *   A 重启等价的恢复路径（**新的** ExecutionUnit 实例从盘上恢复历史）后是什么？
 *   B 压缩当轮（同一进程、不重启）是什么？
 *   C `sessions.get` 的 8 KiB 裁剪（`capToolMessages`）会不会把 `[cleared ` 前缀吃掉，
 *     截断后的正文 `isClearedToolResult` 还认不认得出来？
 *
 * 这个探针只**测量**、不下产品口径结论，退出码恒为 0（除非探针自己跑不起来）。
 *
 * 为什么必须是真 run：`loadStoredHistory` 的投影分支（增量 vs 满投影）、`projectMessages`
 * 的占位替换、`finalizeSessionState` 的写回、`sessions.get` 的裁剪，全都在「真落盘 +
 * 真读回」时才连起来。纯函数单测只能证明每一段自己说得通。
 *
 * 落盘目录一律在系统临时目录（`os.tmpdir()`），**不碰** `~/.vessel/data`，也不读任何
 * 用户层配置；测完删掉。
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  resolveProjection,
  SessionEventLog,
  type SessionEventRecord,
  type SessionState,
  type ToolDefinition,
} from '../packages/core/src/index';
import { createSessionMethods } from '../packages/serve/src/gateway/methods/sessions';
import { capToolMessages } from '../packages/serve/src/tool-events';

const SESSION_ID = 's-proj-readback';
const SYSTEM_PROMPT = 'probe system prompt for projection readback';
const TOOL_NAME = 'bash';

/**
 * 窗口 20000 tokens：0.85 阈值 = 17000，单条工具结果 ≈ 1500 tokens ⇒ 约 12 轮后压缩。
 *
 * 这几个数不是随手选的，两个约束把「能不能看到占位」卡死了：
 * - 压缩保留区 = `maxTokens × 0.3` = 6000 tokens，单条工具结果 1500 ⇒ 压缩后窗口里
 *   还剩 3 条工具结果（占位才有东西可替换、才有东西留在 `messages` 里）；
 * - 工具结果保留预算 = `maxTokens × 5%` = 1000 tokens < 1500 ⇒ 只保留最新 1 条原文，
 *   其余全部进 `cleared_tool_call_ids`（否则集合为空，探针退化成假绿）。
 */
const WINDOW_TOKENS = 20000;
/**
 * 工具结果正文 ≈ 5700 字符 ≈ 1400 tokens（`estimateTokens` 对 ASCII 是 0.25/字符），
 * 末尾带 `exit code: 1`（占位里能落到 `-> exit 1, N lines`）。
 */
const TOOL_BODY = `${Array.from({ length: 150 }, (_, index) => `build log line ${String(index)} xxxxxxxxxxxxxx`).join('\n')}\nexit code: 1`;
/**
 * 每轮收尾的 assistant 正文 ≈ 500 tokens。
 *
 * 为什么需要它：请求里的旧工具结果被换成占位后，**请求本身很小**，provider 上报的
 * `prompt_tokens`（= 真实锚点）就涨不上去 ⇒ 0.85 阈值永远不触发，压缩一辈子不发生。
 * 真会话里涨的是模型自己写出来的内容（这里用一段 filler 代替），所以探针也照这个口径
 * 长历史，否则根本走不到「压缩」这一步。
 */
const ASSISTANT_TAIL = `assistant tail ${'a'.repeat(2000)}`;

function section(title: string): void {
  console.log(`\n${title}`);
}

function note(label: string, value: unknown): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  console.log(`  ${label} = ${text}`);
}

function head(text: string, max = 96): string {
  const flat = text.replace(/\n/g, '\\n');
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

// ── 假 provider：每轮最多发一次工具调用，之后收尾 ────────────────────────────

/**
 * 一轮 = 一次 `run()`。`toolPerRun` 为真时，本轮第一条请求返回一个 `bash` 工具调用；
 * 拿到工具结果后的下一条请求收尾（否则会无限调工具）。
 */
class ScriptedProvider implements LLMProvider {
  /** 本轮是否要发一次工具调用（探针在 run 之间改它）。 */
  toolPerRun = true;
  /** 每次请求的 messages 快照（探针用来看「模型实际看到了什么」）。 */
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
    // usage 必须跟着请求体量走：runtime 用 `llm.response` 的 per-request
    // `prompt_tokens` 当真实锚点（`seedRealTokensFromLastRequest`），写死 10 会让
    // tokenCount 永远停在 10、段起点压缩永远不触发（探针第一版就栽在这里）。
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

function makeTool(): ToolDefinition {
  return {
    name: TOOL_NAME,
    description: 'probe tool that returns a big body with an exit code',
    inputSchema: { type: 'object', properties: {} },
    // `ToolHandler` 返回 string，runtime 原样存进 tool 消息正文。
    handler: async () => TOOL_BODY,
  };
}

const toolPlugin: Plugin = {
  name: 'probe-proj-readback-tools',
  install(host): void {
    host.registerTool(makeTool());
  },
};

// ── 一个「节点」= 一份落盘目录 + 真事件日志 + 一个 ExecutionUnit ──────────────

interface Node {
  readonly dir: string;
  readonly provider: ScriptedProvider;
  readonly log: SessionEventLog;
  readonly eu: ExecutionUnit;
  run(text: string): Promise<void>;
  records(): Promise<SessionEventRecord[]>;
  stop(): void;
}

const sessionFile = (dir: string): string => join(dir, `${encodeURIComponent(SESSION_ID)}.json`);

/**
 * 起一个节点。`dir` 就是「数据目录」：会话壳 `s-xxx.json` 与事件日志
 * `s-xxx/events.ndjson` 都在它下面（与真装配的分层一致）。
 *
 * 「重启」= 丢掉旧节点（含 store / 日志实例 / provider），用**同一个 dir** 再造一个 ——
 * 读的只有盘上的东西，不吃内存残留。
 */
async function startNode(dir: string): Promise<Node> {
  const events = new MemoryEventStream();
  const log = new SessionEventLog({ dir, durable: false });
  const store = new FileSessionStore(dir);
  const provider = new ScriptedProvider();
  const eu = await ExecutionUnit.create({
    provider: provider as never,
    model: 'probe/proj-readback',
    contextFactory: () => {
      const context = new MemoryWorkingContext({
        maxTokens: WINDOW_TOKENS,
        autoCompact: true,
      });
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
    dir,
    provider,
    log,
    eu,
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
    if (fresh !== undefined && fresh !== null && fresh.status !== 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('session state 没有落盘');
}

// ── sessions.get：跑真方法（含 capToolMessages），不是自己拼一份 ─────────────

async function sessionsGet(dir: string): Promise<Message[]> {
  const methods = createSessionMethods({ sessionFor: () => new FileSessionStore(dir) });
  const method = methods.find((item) => item.name === 'sessions.get');
  if (method === undefined) throw new Error('找不到 RPC 方法 sessions.get');
  // 出站形状：`{ session: { ..., messages, messages_total } }`（消息挂在 session 下，
  // 不是顶层 —— 探针第一版就看错了这一层，读到空数组）。
  const result = (await method.handler({ session_id: SESSION_ID }, {} as never)) as {
    session?: { messages?: Message[]; messages_total?: number };
  };
  return result.session?.messages ?? [];
}

interface ToolRow {
  readonly id: string;
  readonly cleared: boolean;
  readonly chars: number;
  readonly head: string;
}

/** 窗口里的工具结果（按出现顺序）。 */
function toolRows(messages: readonly Message[]): ToolRow[] {
  const rows: ToolRow[] = [];
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    const content = String(message.content ?? '');
    rows.push({
      id: String(message.tool_call_id),
      cleared: isClearedToolResult(content),
      chars: content.length,
      head: head(content, 72),
    });
  }
  return rows;
}

function printRows(label: string, rows: readonly ToolRow[]): void {
  console.log(`  ${label}（${String(rows.length)} 条工具结果）`);
  for (const row of rows) {
    console.log(
      `    ${row.id.padEnd(10)} cleared=${String(row.cleared).padEnd(5)} ${String(row.chars).padStart(6)} chars  ${row.head}`,
    );
  }
}

/** 指定 id 的那些工具结果正文（原样，落盘或出站都行）。 */
function contentById(messages: readonly Message[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    out.set(String(message.tool_call_id), String(message.content ?? ''));
  }
  return out;
}

/** 压缩事件点名的审计集合（跨多条事件取并集，保序）。 */
function clearedIdsOf(records: readonly SessionEventRecord[]): string[] {
  const out: string[] = [];
  for (const record of records) {
    if ((record as unknown as { type: string }).type !== 'message.compaction') continue;
    const data = (record as unknown as { data?: { cleared_tool_call_ids?: unknown } }).data;
    const ids = data?.cleared_tool_call_ids;
    if (!Array.isArray(ids)) continue;
    for (const id of ids) {
      if (typeof id === 'string' && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

function compactionSeq(records: readonly SessionEventRecord[]): number | undefined {
  const record = records.find(
    (item) => (item as unknown as { type: string }).type === 'message.compaction',
  ) as unknown as { seq: number } | undefined;
  return record?.seq;
}

/** 压缩事件里 `kept`（压缩应用后保留的非 system 条数，投影按同一边界裁剪）。 */
function keptOf(records: readonly SessionEventRecord[]): number | undefined {
  const record = records.find(
    (item) => (item as unknown as { type: string }).type === 'message.compaction',
  ) as unknown as { data?: { kept?: unknown } } | undefined;
  const kept = record?.data?.kept;
  return typeof kept === 'number' ? kept : undefined;
}

/** 窗口里的非 system 条数（与事件里的 `kept` 同口径）。 */
function nonSystemCount(messages: readonly Message[]): number {
  return messages.filter((message) => message.role !== 'system').length;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'vessel-proj-readback-'));
  console.log(`探针数据目录（临时）：${root}`);
  try {
    await runAll(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function runAll(root: string): Promise<void> {
  const dir = join(root, 'build');
  let node = await startNode(dir);
  let priorStateJson: string | undefined;
  let turn = 0;
  let storedAfterCompaction: SessionState | null = null;

  // ── 阶段 0：造历史，跑到日志里出现 message.compaction ──────────────────────
  section('阶段 0：真 run × N，直到日志里出现 message.compaction');
  for (turn = 1; turn <= 40; turn += 1) {
    let before: string | undefined;
    try {
      before = readFileSync(sessionFile(dir), 'utf8');
    } catch {
      before = undefined;
    }
    await node.run(`turn ${String(turn)}`);
    const records = await node.records();
    if (compactionSeq(records) !== undefined) {
      priorStateJson = before;
      storedAfterCompaction = await new FileSessionStore(dir).load(SESSION_ID);
      break;
    }
  }
  const records = await node.records();
  const cleared = clearedIdsOf(records);
  const seqOfCompaction = compactionSeq(records);
  note('压缩发生在第几轮 run', turn);
  note('message.compaction 的 seq', seqOfCompaction);
  note('cleared_tool_call_ids 条数', cleared.length);
  note('cleared_tool_call_ids', cleared);
  note('压缩事件的 kept（保留的非 system 条数）', keptOf(records));
  // 本会话没有声明 context_projection ⇒ 走默认分支；把解析结果打出来，
  // 免得「探针其实跑在 passthrough 下」这种假绿（passthrough 不会有 cleared 集合）。
  const resolution = resolveProjection(storedAfterCompaction);
  note('本会话解析出的投射模式', `${resolution.mode}（source=${resolution.source}）`);
  if (storedAfterCompaction === null) throw new Error('40 轮内没有触发压缩，探针没覆盖到压缩路径');

  const derived = storedAfterCompaction.derived_upto_seq;
  note('压缩当轮落盘 derived_upto_seq', derived);
  note(
    '落盘状态 vs 日志：压缩事件在不在「下次启动要重放的尾部」里',
    seqOfCompaction !== undefined && (derived ?? 0) >= seqOfCompaction
      ? `不在（derived ${String(derived)} >= compaction ${String(seqOfCompaction)}）⇒ 下一次启动走增量`
      : `在（derived ${String(derived)} < compaction ${String(seqOfCompaction)}）⇒ 下一次启动走满投影`,
  );

  // ── 阶段 1（B）：压缩当轮、不重启，sessions.get 说什么 ─────────────────────
  section('B 压缩当轮（同一进程、不重启）：sessions.get 的正文');
  const bRows = toolRows(await sessionsGet(dir));
  printRows('sessions.get.messages', bRows);
  const bDisk = contentById(storedAfterCompaction.messages ?? []);
  printRows('落盘 state.messages', toolRows(storedAfterCompaction.messages ?? []));
  for (const id of cleared) {
    const text = bDisk.get(id);
    if (text === undefined) continue;
    note(`B:${id} 落盘正文`, `cleared=${String(isClearedToolResult(text))} ${head(text, 72)}`);
  }
  note('B: 审计集合里有、但已不在窗口里的 id 条数', cleared.filter((id) => !bDisk.has(id)).length);

  // 同一条消息的两个视角：模型看到的请求视图 vs 落盘（sessions.get 的来源）。
  const lastRequest = node.provider.requests[node.provider.requests.length - 1] ?? [];
  const requestPlaceholders = lastRequest
    .filter(
      (message) => message.role === 'tool' && isClearedToolResult(String(message.content ?? '')),
    )
    .map((message) => String(message.tool_call_id));
  note('B 压缩当轮最后一条请求里的占位条数', requestPlaceholders.length);
  note('B 压缩当轮最后一条请求里的占位 id', requestPlaceholders);
  for (const id of requestPlaceholders.slice(0, 3)) {
    note(
      `B:${id} 请求视图 vs 落盘`,
      `请求=${head(contentById(lastRequest).get(id) ?? '', 48)} | 落盘=${head(bDisk.get(id) ?? '（不在窗口）', 48)}`,
    );
  }

  // 后面每个变体都从「压缩当轮落盘」这一份冻结快照复制，互不污染。
  const pristine = join(root, 'pristine');
  node.stop();
  await node.log.release(SESSION_ID).catch(() => {});
  cpSync(dir, pristine, { recursive: true });
  node = await startNode(dir);
  node.provider.toolPerRun = false;

  // ── 阶段 2（A1）：干净重启 —— 落盘是最新的，重启后走增量 ────────────────
  section('A1 干净重启（新 ExecutionUnit 实例，盘上状态是最新的）');
  await node.run('after restart');
  const a1Disk = (await new FileSessionStore(dir).load(SESSION_ID))?.messages ?? [];
  const a1Get = await sessionsGet(dir);
  printRows('重启后 sessions.get.messages', toolRows(a1Get));
  for (const id of cleared) {
    const text = contentById(a1Disk).get(id);
    if (text === undefined) continue;
    note(
      `A1:${id}`,
      `cleared=${isClearedToolResult(text)} chars=${String(text.length)} ${head(text, 72)}`,
    );
  }
  node.stop();
  await node.log.release(SESSION_ID).catch(() => {});

  // ── 阶段 3（A2）：等价「压缩后立刻崩溃」—— 会话壳没存下来，日志里有压缩 ──
  section('A2 重启时尾部含压缩事件（= 压缩已发事件、会话壳还是上一轮的：崩溃窗口）');
  const crashDir = join(root, 'crash');
  cpSync(pristine, crashDir, { recursive: true });
  if (priorStateJson === undefined) throw new Error('没有拿到「压缩前的会话壳」快照');
  writeFileSync(sessionFile(crashDir), priorStateJson);
  const restored = await new FileSessionStore(crashDir).load(SESSION_ID);
  note('回滚后的 derived_upto_seq（< compaction seq ⇒ 满投影）', restored?.derived_upto_seq);
  note(
    '回滚后的落盘正文（工具结果应仍是原文）',
    toolRows(restored?.messages ?? []).map((row) => `${row.id}:cleared=${String(row.cleared)}`),
  );
  const crashNode = await startNode(crashDir);
  crashNode.provider.toolPerRun = false;
  await crashNode.run('after crash restart');
  const a2Disk = (await new FileSessionStore(crashDir).load(SESSION_ID))?.messages ?? [];
  const a2Get = await sessionsGet(crashDir);
  printRows('A2 重启一轮之后 sessions.get.messages', toolRows(a2Get));
  note('A2 重建后窗口的非 system 条数（对比压缩事件里的 kept）', nonSystemCount(a2Disk));
  for (const id of cleared) {
    const text = contentById(a2Disk).get(id);
    if (text === undefined) continue;
    note(
      `A2:${id}`,
      `cleared=${isClearedToolResult(text)} chars=${String(text.length)} ${head(text, 96)}`,
    );
  }
  note(
    'A2 恢复轮之后 derived_upto_seq',
    (await new FileSessionStore(crashDir).load(SESSION_ID))?.derived_upto_seq,
  );
  crashNode.stop();
  await crashNode.log.release(SESSION_ID).catch(() => {});

  // ── 阶段 3b（A2b）：占位一旦写进落盘，后面每次重启都是占位（粘性） ────────
  section('A2b 占位写进落盘之后**再**重启一次（增量路径，没触发满投影）');
  const stickyNode = await startNode(crashDir);
  stickyNode.provider.toolPerRun = false;
  await stickyNode.run('after sticky restart');
  const a2bGet = await sessionsGet(crashDir);
  printRows('A2b 再重启一轮之后 sessions.get.messages', toolRows(a2bGet));
  note(
    'A2b derived_upto_seq',
    (await new FileSessionStore(crashDir).load(SESSION_ID))?.derived_upto_seq,
  );
  stickyNode.stop();
  await stickyNode.log.release(SESSION_ID).catch(() => {});

  // ── 阶段 4（A3）：缓存不可用（旧数据没有 derived_upto_seq）⇒ 满投影 ──────
  section('A3 重启时缓存没有 derived_upto_seq（旧数据 / 缓存缺失）⇒ 满投影');
  const noCacheDir = join(root, 'nocache');
  cpSync(pristine, noCacheDir, { recursive: true });
  const shell = JSON.parse(readFileSync(sessionFile(noCacheDir), 'utf8')) as Record<
    string,
    unknown
  >;
  delete shell.derived_upto_seq;
  writeFileSync(sessionFile(noCacheDir), JSON.stringify(shell));
  const noCacheNode = await startNode(noCacheDir);
  noCacheNode.provider.toolPerRun = false;
  await noCacheNode.run('after cache-less restart');
  const a3Disk = (await new FileSessionStore(noCacheDir).load(SESSION_ID))?.messages ?? [];
  const a3Get = await sessionsGet(noCacheDir);
  printRows('A3 重启一轮之后 sessions.get.messages', toolRows(a3Get));
  for (const id of cleared) {
    const text = contentById(a3Disk).get(id);
    if (text === undefined) continue;
    note(
      `A3:${id}`,
      `cleared=${isClearedToolResult(text)} chars=${String(text.length)} ${head(text, 72)}`,
    );
  }
  noCacheNode.stop();
  await noCacheNode.log.release(SESSION_ID).catch(() => {});

  // ── 阶段 5（A4）：尾部出现 session.rewound（与压缩同一分支） ──────────────
  section('A4 重启时尾部含 session.rewound（撤回是「替换」⇒ 与压缩同一分支）');
  const rewoundDir = join(root, 'rewound');
  cpSync(pristine, rewoundDir, { recursive: true });
  const rewindLog = new SessionEventLog({ dir: rewoundDir, durable: false });
  const shellNow = await new FileSessionStore(rewoundDir).load(SESSION_ID);
  const keepProjected = (shellNow?.messages ?? []).length;
  const appended = await rewindLog.append({
    session_id: SESSION_ID,
    run_id: 'probe-rewind',
    type: 'session.rewound',
    ts: Date.now(),
    data: { keep_messages: keepProjected, keep_projected: keepProjected, reason: 'probe' },
  });
  await rewindLog.flush(SESSION_ID);
  await rewindLog.release(SESSION_ID).catch(() => {});
  note('追加的 session.rewound seq', (appended as unknown as { seq: number }).seq);
  note('落盘 derived_upto_seq（< rewound seq ⇒ 满投影）', shellNow?.derived_upto_seq);
  const rewoundNode = await startNode(rewoundDir);
  rewoundNode.provider.toolPerRun = false;
  await rewoundNode.run('after rewind restart');
  const a4Disk = (await new FileSessionStore(rewoundDir).load(SESSION_ID))?.messages ?? [];
  const a4Get = await sessionsGet(rewoundDir);
  printRows('A4 重启一轮之后 sessions.get.messages', toolRows(a4Get));
  for (const id of cleared) {
    const text = contentById(a4Disk).get(id);
    if (text === undefined) continue;
    note(
      `A4:${id}`,
      `cleared=${isClearedToolResult(text)} chars=${String(text.length)} ${head(text, 72)}`,
    );
  }
  rewoundNode.stop();
  await rewoundNode.log.release(SESSION_ID).catch(() => {});

  // ── 阶段 6（C）：8 KiB 裁剪认不认得出 `[cleared ` ─────────────────────────
  section('C sessions.get 的 8 KiB 裁剪（capToolMessages）对占位的识别');
  const placeholderOnDisk = [...contentById(a2Disk).values()].find((text) =>
    isClearedToolResult(text),
  );
  const realPlaceholder =
    placeholderOnDisk ??
    formatClearedToolResult(
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
  note('用来测裁剪的占位正文', realPlaceholder);

  capCase('C1 真实占位（短）', realPlaceholder);
  capCase('C2 原文 6000 字符（未超 8 KiB）', TOOL_BODY);
  capCase('C3 原文 40 KB（超 8 KiB）', 'y'.repeat(40 * 1024));
  // 病态构造：工具名极长 ⇒ 占位本身超 8 KiB（现实里不会，但要把边界打出来）。
  const longName = `bash_${'z'.repeat(9000)}`;
  const longPlaceholder = formatClearedToolResult(
    [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_long', type: 'function', function: { name: longName, arguments: '{}' } },
        ],
      },
      { role: 'tool', content: TOOL_BODY, tool_call_id: 'call_long' },
    ],
    'call_long',
    TOOL_BODY,
  );
  capCase('C4 病态：占位本身 9 KB', longPlaceholder);
  capCase('C5 旧常量正文（精确匹配形态）', '[Old tool result content cleared]');

  section('C 追加：对截断后的原文再跑 formatClearedToolResult（§1.4 的自降级在裁剪后是什么样）');
  const cappedRaw = String(
    capToolMessages([{ role: 'tool', content: 'y'.repeat(40 * 1024), tool_call_id: 'call_x' }])[0]
      ?.content,
  );
  const reRun = formatClearedToolResult([], 'call_x', cappedRaw);
  note('原文行数（40000 字符单行）', TOOL_BODY.split('\n').length);
  note('对 40 KB 原文重跑（未裁剪）', formatClearedToolResult([], 'call_x', 'y'.repeat(40 * 1024)));
  note('对 8 KiB 截断后的正文重跑', reRun);
}

/** 一条消息过 `capToolMessages`，打印「前缀还在不在 / 认不认得出」。 */
function capCase(label: string, content: string): void {
  const capped = capToolMessages([{ role: 'tool', content, tool_call_id: 'call_probe' }])[0];
  const text = String(capped?.content ?? '');
  const keptPrefix = text.startsWith('[cleared ') || text.startsWith('[Old tool result');
  console.log(
    `  ${label}：${String(content.length)} → ${String(text.length)} chars，` +
      `尾部=${JSON.stringify(text.slice(-20))}，前缀保留=${String(keptPrefix)}，` +
      `isClearedToolResult=${String(isClearedToolResult(text))}`,
  );
}

await main();
