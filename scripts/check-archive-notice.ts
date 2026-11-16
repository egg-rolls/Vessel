#!/usr/bin/env bun
/**
 * 0.53 U3 探针：`archive_notice`（归档卡）—— 纯追加，不改写历史。
 *
 * 跑的是**真** runtime（`ExecutionUnit` + `FileSessionStore` + `SessionEventLog` + 真
 * `events.ndjson`）与真 gateway 方法（`sessions.events`），因为这条模式的全部不变量都在
 * 「卡有没有落盘 / 请求有没有被动过 / 卡上的 id 到底读不读得回来」上，纯函数单测摸不到。
 *
 * 判据（六组，逐条对应任务单）：
 *
 *  ⓪ 卡片文案本身：折叠态首行只讲**本轮**、展开明细才给**累计**；去重键单射；中英样例；
 *  ① `archive_notice` 下请求视图的工具结果与落盘**逐字节相同**（`[cleared ` 零出现，
 *     `cleared_tool_call_ids` 不落盘）⇒ 不消费 C1h 的豁免；
 *  ② 归档卡的数字口径：第一张「本轮 2 条 / 累计 2 条」，第二张「本轮 1 条 / 累计 3 条」；
 *  ③ 同载荷不重复发卡：集合没变的段起点不再 append 第二张同样的卡（反证：新实例会重发）；
 *  ④ 读回提示**能兑现**：卡上每个 id 都能用 `sessions.events{tool_call_id}` 从事件日志读回来，
 *     且 `data.result` 与原文逐字节相同；
 *  ⑤ 读回能力不可用 ⇒ fail-open 到 `passthrough` + 审计 reason（沿用 §6.4 冻结码），不发卡；
 *  ⑥ **段起点算出的 plan（ids 集合）与审计行里记录的集合逐条相等**，否则 FAIL（带 plan_hash）
 *     —— 这条是补 C1g 的缺口：C1g 只盯「请求视图 vs 审计集合」，没人盯「审计集合 vs 段起点 plan」。
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// 归档卡的文案与去重键按模块 barrel 引入（与 runtime 内部接线同一个入口）：
// U3 不往 core 根 barrel 加导出（那超出了本单的文件清单），消费者走 `context` 子入口。
import { archiveNoticeSignature, renderArchiveNotice } from '../packages/core/src/context/index';
import {
  type ChatRequest,
  createRunJournalFactory,
  declareProjection,
  ExecutionUnit,
  FileSessionStore,
  type LLMProvider,
  type LLMResponse,
  MemoryEventStream,
  MemoryWorkingContext,
  type Message,
  type Plugin,
  planClearedToolResults,
  type SessionEventInput,
  SessionEventLog,
  type SessionEventLogPort,
  type SessionEventRecord,
  type SessionState,
  type ToolDefinition,
} from '../packages/core/src/index';
import { createSessionMethods } from '../packages/serve/src/gateway/methods/sessions';
import { createSessionEventsSource } from '../src/session-events';

const failures: string[] = [];
let checks = 0;

function ok(name: string, detail: string): void {
  checks += 1;
  console.log('  ok   ' + name + ' — ' + detail);
}

function fail(name: string, message: string): void {
  checks += 1;
  console.log('  FAIL ' + name + ' — ' + message);
  failures.push(name + '：' + message);
}

function expect(name: string, actual: unknown, want: unknown): void {
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a === w) ok(name, a.length > 140 ? a.slice(0, 137) + '...' : a);
  else fail(name, 'want ' + w + ' got ' + a);
}

function expectTrue(name: string, actual: boolean, detail: string): void {
  if (actual) ok(name, detail);
  else fail(name, detail);
}

function section(title: string): void {
  console.log('\n' + title);
}

const SESSION = 's-archive-notice';
/**
 * 窗口与正文尺寸的取舍（两个都要满足，否则本探针的判据会被压缩抢走）：
 *
 * - 5% 保留预算 = 2000 × 0.05 = 100 tokens；单条正文 400 字符 ≈ 100 tokens ⇒
 *   **只留最近 1 条**，其余全进归档集合（`2 × 100 > 100` 有 2 倍余量）。
 * - 总量 4 条 ≈ 400 tokens + 卡与消息 ≪ 0.85 × 2000 = 1700 ⇒ 段起点**不会**压缩，
 *   归档集合因此不会被「压缩丢掉最旧前缀」提前清空（那会让 ①②③ 无从判起）。
 */
const WINDOW = 2000;
const BODY = 'x'.repeat(400);
const SYSTEM_PROMPT = 'probe system prompt for archive notice';
const TOOL_NAMES = ['t1', 't2', 't3', 't4'] as const;

// ── 假 provider：按「第几个 run」执行脚本（每轮开头一条非 notice 的 user 消息） ──

class RunScriptedProvider implements LLMProvider {
  /** 每次请求发出那一刻的消息快照（深拷贝：runtime 之后可能复用对象）。 */
  readonly requests: Message[][] = [];
  private callSeq = 0;

  constructor(private readonly scripts: readonly (readonly string[])[]) {}

  /** 当前是第几个 run（0 起）：数「不带 name 的 user 消息」。归档卡是 `vessel:notice`，不算。 */
  private runIndex(request: ChatRequest): number {
    let index = -1;
    for (const message of request.messages) {
      if (message.role === 'user' && message.name === undefined) index += 1;
    }
    return index;
  }

  async chat(request: ChatRequest): Promise<LLMResponse> {
    this.requests.push(structuredClone(request.messages) as Message[]);
    const script = this.scripts[this.runIndex(request)] ?? [];
    let lastUser = -1;
    for (let index = 0; index < request.messages.length; index += 1) {
      if (request.messages[index]?.role === 'user') lastUser = index;
    }
    const produced = request.messages
      .slice(lastUser + 1)
      .filter((message) => message.role === 'tool').length;
    const next = script[produced];
    if (next !== undefined) {
      this.callSeq += 1;
      return {
        content: '',
        finish_reason: 'tool_calls',
        tool_calls: [
          {
            id: 'call_' + next + '_' + String(this.callSeq),
            type: 'function',
            function: { name: next, arguments: '{}' },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
    }
    return {
      content: 'done',
      finish_reason: 'stop',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
  }
}

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: 'probe tool that returns a fixed big body',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => BODY,
  };
}

function toolPlugin(): Plugin {
  return {
    name: 'probe-archive-tools',
    install(host): void {
      for (const name of TOOL_NAMES) host.registerTool(makeTool(name));
    },
  };
}

/**
 * 没有 `lastSeq` 的事件日志替身（复现「读回路径不可用」）。
 *
 * core 的 `SessionEventLogPort` 把 `lastSeq` 声明成**可缺省**，而 `sessions.events` 的端口
 * 契约要求它（`latest_seq` 靠它）：所以「端口在」≠「读得回来」。⑤ 就是这种节点。
 */
class NoSeekEventLog implements SessionEventLogPort {
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

// ── 一个「节点」= 一份落盘目录 + 事件流 + 事件日志 + ExecutionUnit ──

interface SeenEvent {
  type?: string;
  data?: Record<string, unknown>;
}

interface ProbeNode {
  eu: ExecutionUnit;
  seen: SeenEvent[];
  provider: RunScriptedProvider;
  store: FileSessionStore;
  stop(): void;
}

async function startNode(options: {
  dir: string;
  scripts: readonly (readonly string[])[];
  eventLog: SessionEventLogPort;
  store?: FileSessionStore;
}): Promise<ProbeNode> {
  const events = new MemoryEventStream();
  const store = options.store ?? new FileSessionStore(options.dir);
  const provider = new RunScriptedProvider(options.scripts);
  const eu = await ExecutionUnit.create({
    provider: provider as never,
    model: 'probe/archive-notice',
    contextFactory: () => {
      const context = new MemoryWorkingContext({ maxTokens: WINDOW, autoCompact: true });
      // 不给 sessionId 会让 token 计数是 NaN（判据与数量无关，但不该留 NaN）。
      context.setSessionId(SESSION);
      return context;
    },
    events,
    limits: {},
    termination: {},
    journalFactory: createRunJournalFactory({
      session: store as never,
      eventLog: options.eventLog,
    }),
    session: store as never,
    eventLog: options.eventLog,
    plugins: [toolPlugin()],
    systemPrompt: SYSTEM_PROMPT,
    retry: { maxRetries: 0 },
  });
  const seen: SeenEvent[] = [];
  events.subscribe((event: unknown) => {
    seen.push(event as SeenEvent);
  });
  return { eu, seen, provider, store, stop: () => eu.dispose?.() };
}

/** 跑一轮并把盘上的 `SessionState` 读回来（journal 的写是异步排队的）。 */
async function runAndWait(node: ProbeNode, dir: string, input: string): Promise<SessionState> {
  await node.eu.run(input, SESSION);
  for (let tick = 0; tick < 800; tick += 1) {
    const fresh = await new FileSessionStore(dir).load(SESSION);
    if (fresh !== undefined && fresh !== null && fresh.status !== 'running') return fresh;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('session state 没有落盘');
}

async function reload(dir: string): Promise<SessionState | null> {
  return await new FileSessionStore(dir).load(SESSION);
}

/** 种好的历史：3 条工具结果（`placeholder` / `archive_notice` 的 plan 一定会归档最旧两条）。 */
function seededHistory(callIds: readonly string[]): Message[] {
  const messages: Message[] = [{ role: 'user', content: '先读几份文件' }];
  for (const id of callIds) {
    messages.push({
      role: 'assistant',
      content: '',
      tool_calls: [{ id, type: 'function', function: { name: 't1', arguments: '{}' } }],
    });
    messages.push({ role: 'tool', tool_call_id: id, content: BODY });
  }
  messages.push({ role: 'assistant', content: '读完了' });
  return messages;
}

function baseState(messages: Message[]): SessionState {
  return {
    session_id: SESSION,
    status: 'completed',
    messages,
    created_at: Date.now(),
    updated_at: Date.now(),
    derived_upto_seq: 0,
  };
}

/** 落盘的归档卡（`vessel:notice` + 首行 scope `trim` + 归档语义，中英都认）。 */
function archiveCardsIn(state: SessionState | null | undefined): Message[] {
  return (state?.messages ?? []).filter((message) => {
    const content = String(message.content);
    const head = content.split('\n')[0] ?? '';
    // 必须同时满足「env 卡的线格式」与「归档语义」：trim 卡的首行也是 `trim:`，
    // 只按 scope 判会把占位卡算成归档卡（模式之间串味就抓不出来了）。
    return (
      message.name === 'vessel:notice' &&
      /^trim[：:]/.test(head) &&
      (head.includes('archived this run') || head.includes('本轮归档'))
    );
  });
}

function eventsOf(seen: readonly SeenEvent[], type: string): SeenEvent[] {
  return seen.filter((event) => event.type === type);
}

function toolResultContents(messages: readonly Message[]): Map<string, string> {
  const contents = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    if (typeof message.tool_call_id !== 'string') continue;
    contents.set(message.tool_call_id, String(message.content));
  }
  return contents;
}

/**
 * 复算 `plan_hash`（判据的独立一步，不是抄实现）：
 * `sha256(effective_mode + '\0' + 排序后的 id 各 + '\0')` 的前 16 位。
 *
 * 用它交叉验「事件里的 plan_hash」与「探针自己根据历史复算出的 plan」是不是同一件事 ——
 * 这正是 ⑥ 要的那条判据（审计集合 vs 段起点 plan），带 hash 才定位得到是哪一段漂了。
 */
function expectedPlanHash(mode: string, ids: readonly string[]): string {
  const digest = createHash('sha256');
  digest.update(mode);
  digest.update('\u0000');
  for (const id of [...ids].sort()) {
    digest.update(id);
    digest.update('\u0000');
  }
  return digest.digest('hex').slice(0, 16);
}

// ── ⓪ 卡片文案（纯函数） ─────────────────────────────────────────────────

section('⓪ 归档卡文案：折叠只说本轮 / 展开含累计 / 去重键单射');

const sampleIds = ['call_t1_1', 'call_t2_2', 'call_t3_3'];
const sampleTools = ['t1', 't2', 't3'];
const sampleBytes = [1536, 900, 200];

const enNotice = renderArchiveNotice({
  ids: sampleIds,
  tools: sampleTools,
  bytes: sampleBytes,
  sessionId: SESSION,
  archived: 7,
});
const zhNotice = renderArchiveNotice(
  { ids: sampleIds, tools: sampleTools, bytes: sampleBytes, sessionId: SESSION, archived: 7 },
  'zh-CN',
);

const enLines = enNotice.split('\n');
const zhLines = zhNotice.split('\n');

expectTrue(
  '⓪.1 en 折叠态首行只讲本轮 3 条（不带累计 7）',
  (enLines[0] ?? '').startsWith('trim: 3 older tool result(s) archived this run') &&
    !(enLines[0] ?? '').includes(' 7 '),
  enLines[0] ?? '',
);
expectTrue(
  '⓪.2 en 展开明细第一行给累计 7 条',
  (enLines[1] ?? '').startsWith('  · 7 archived in this session'),
  enLines[1] ?? '',
);
expectTrue(
  '⓪.3 zh-CN 折叠态首行只讲本轮 3 条、明细给累计 7 条（两个口径分两层）',
  (zhLines[0] ?? '').startsWith('trim：本轮归档 3 条') &&
    (zhLines[1] ?? '').startsWith('  · 会话内已累计 7 条被归档'),
  JSON.stringify([zhLines[0], zhLines[1]]),
);
expectTrue(
  '⓪.4 卡里写明读回方式与原文位置（读不回来就不许这么写）',
  enLines.some((line) => line.includes('sessions.events{session_id, tool_call_id}')) &&
    enLines.some((line) => line.includes(SESSION + '/events.ndjson')),
  JSON.stringify(enLines.slice(-1)),
);
expectTrue(
  '⓪.5 卡里没有任何工具结果正文（只有元数据）',
  !enNotice.includes(BODY) && !zhNotice.includes(BODY) && enNotice.length < 1024,
  'len=' + String(enNotice.length),
);
expectTrue(
  '⓪.6 id 溢出折成 +N（卡不会被 20 条归档撑大）',
  renderArchiveNotice({
    ids: Array.from({ length: 20 }, (_, index) => 'call_' + String(index)),
    tools: Array.from({ length: 20 }, () => 't1'),
    bytes: Array.from({ length: 20 }, () => 10),
    sessionId: SESSION,
    archived: 20,
  }).includes('+12'),
  '20 条 ⇒ 点名 8 条（与 trim 卡同一上限）',
);
expect(
  '⓪.7 空集不发卡（返回空串，调用方据此不 append）',
  renderArchiveNotice({ ids: [], tools: [], bytes: [], sessionId: SESSION }),
  '',
);
expect(
  '⓪.8 去重键：同一载荷 ⇒ 同一个键',
  archiveNoticeSignature({ archived: 7, added: 3, tool_call_ids: sampleIds }),
  archiveNoticeSignature({ archived: 7, added: 3, tool_call_ids: [...sampleIds] }),
);
expectTrue(
  '⓪.9 去重键：累计 / 新增条数 / id 列表任一项变了 ⇒ 键不同',
  archiveNoticeSignature({ archived: 7, added: 3, tool_call_ids: sampleIds }) !==
    archiveNoticeSignature({ archived: 8, added: 3, tool_call_ids: sampleIds }) &&
    archiveNoticeSignature({ archived: 7, added: 3, tool_call_ids: sampleIds }) !==
      archiveNoticeSignature({ archived: 7, added: 4, tool_call_ids: sampleIds }) &&
    archiveNoticeSignature({ archived: 7, added: 3, tool_call_ids: sampleIds }) !==
      archiveNoticeSignature({ archived: 7, added: 3, tool_call_ids: ['call_t1_1', 'call_t2_2'] }),
  '三元组三项分别改动都会换键',
);
expectTrue(
  '⓪.10 去重键不会把不同载荷撞成同一个键（id 里带分隔符）',
  archiveNoticeSignature({ archived: 1, added: 1, tool_call_ids: ['a,b'] }) !==
    archiveNoticeSignature({ archived: 1, added: 1, tool_call_ids: ['a', 'b'] }),
  'JSON 编码保证单射',
);

// ── ① ② ④ ⑥(archive)：真 runtime + 真 events.ndjson ─────────────────────

section('①②④⑥ 真 runtime：不改写正文 / 数字口径 / 读回 / 审计集合 == 段起点 plan');

const mainDir = mkdtempSync(join(tmpdir(), 'vessel-archive-notice-'));
const sessionsDir = join(mainDir, 'sessions');
const eventsFileOf = (sessionId: string): string =>
  join(sessionsDir, encodeURIComponent(sessionId), 'events.ndjson');
/** 本脚本仍用旧日志做夹具（`SessionEventLog`），水位就照旧日志的 大小:mtime 给。 */
const watermarkOf = async (sessionId: string): Promise<string | undefined> => {
  const info = await stat(eventsFileOf(sessionId)).catch(() => undefined);
  return info === undefined
    ? undefined
    : `${String(info.size)}:${String(Math.floor(info.mtimeMs))}`;
};

try {
  const store = new FileSessionStore(mainDir);
  const log = new SessionEventLog({ dir: sessionsDir, durable: false });
  // 会话壳先落盘（声明在创建时就写好；运行时只读，不许中途改）。
  await store.save({
    ...baseState([]),
    context_projection: declareProjection({ mode: 'archive_notice', source: 'session_created' }),
  });

  // run1 造 3 条工具结果；run2 再造 1 条；run3 / run4 不再造（供 ③ 判「同载荷不发第二张」）。
  const node = await startNode({
    dir: mainDir,
    scripts: [['t1', 't2', 't3'], ['t4'], [], []],
    eventLog: log,
  });
  try {
    await runAndWait(node, mainDir, '第一轮：读三份文件');
    const beforeSecond = await reload(mainDir);
    const planBeforeSecond = planClearedToolResults(beforeSecond?.messages ?? [], WINDOW);
    expect(
      '①.0 段起点 plan 恰好是「最旧两条」（保留最近 1 条，同一套保留预算）',
      planBeforeSecond,
      ['call_t1_1', 'call_t2_2'],
    );

    const requestsBefore = node.provider.requests.length;
    const afterSecond = await runAndWait(node, mainDir, '第二轮：继续');
    const secondRunRequests = node.provider.requests.slice(requestsBefore);

    // ① 请求视图 vs 落盘，逐字节相同。
    const storedBefore = toolResultContents(beforeSecond?.messages ?? []);
    const secondRequest = secondRunRequests[0] ?? [];
    const requestToolContents = toolResultContents(secondRequest);
    let byteIdentical = true;
    for (const [id, content] of storedBefore) {
      if (requestToolContents.get(id) !== content) byteIdentical = false;
    }
    expectTrue(
      '①.1 请求视图的工具结果与落盘逐字节相同（3 条全部原样）',
      byteIdentical && storedBefore.size === 3,
      '比较了 ' + String(storedBefore.size) + ' 条',
    );
    expectTrue(
      '①.2 请求里一个占位都没有（`[cleared ` 零出现 ⇒ 不消费 C1h 豁免）',
      secondRunRequests.every((messages) =>
        messages.every(
          (message) => message.role !== 'tool' || !String(message.content).startsWith('[cleared '),
        ),
      ),
      'archive_notice 下请求视图 = 落盘历史',
    );
    expect(
      '①.3 落盘不写 `cleared_tool_call_ids`（归档不是占位，审计集合必须为空）',
      afterSecond?.cleared_tool_call_ids ?? null,
      null,
    );
    const cardsAfterSecond = archiveCardsIn(afterSecond);
    expect('①.4 落盘里就一张归档卡', cardsAfterSecond.length, 1);
    expectTrue(
      '①.5 卡是 `vessel:notice`（与 trim 卡同一类 ⇒ UI 消息列表可见）',
      cardsAfterSecond[0]?.name === 'vessel:notice' && cardsAfterSecond[0]?.role === 'user',
      String(cardsAfterSecond[0]?.role),
    );

    // ② 数字口径：第一张「本轮 2 / 累计 2」。
    const archiveEvents = eventsOf(node.seen, 'context.archive_notice');
    expect('②.1 段起点发了恰好一条 context.archive_notice', archiveEvents.length, 1);
    const first = archiveEvents[0]?.data ?? {};
    expect(
      '②.2 事件：added = 本轮新增 2、archived = 累计 2',
      [first['added'], first['archived']],
      [2, 2],
    );
    expect('②.3 事件 tool_call_ids = 段起点 plan（顺序一致）', first['tool_call_ids'], [
      'call_t1_1',
      'call_t2_2',
    ]);
    expect(
      '②.4 事件逐条工具名与字节数（BODY 是 400 字节 ASCII）',
      [first['tool_names'], first['bytes'], first['bytes_total']],
      [['t1', 't2'], [400, 400], 800],
    );
    expectTrue(
      '②.5 首行只说本轮 2 条、明细才给累计 2 条（第一张两个数相同也算对）',
      String(first['summary'] ?? '').startsWith('trim: 2 older tool result(s) archived this run'),
      String(first['summary'] ?? '').split('\n')[0] ?? '',
    );
    expectTrue(
      '②.6 落盘卡正文与事件 summary 逐字一致（UI 与模型看同一份）',
      String(cardsAfterSecond[0]?.content) === String(first['summary'] ?? ''),
      'len=' + String(String(first['summary'] ?? '').length),
    );

    // run3：历史里已经有 4 条工具结果 ⇒ 段起点 plan 变成 3 条，本轮新增只有 1 条（t3）。
    const requestsBeforeThird = node.provider.requests.length;
    const afterThird = await runAndWait(node, mainDir, '第三轮：再读一份');
    expect(
      '②.7 第三轮没有再产生请求视图改写（archive_notice 下请求与落盘一致）',
      node.provider.requests.slice(requestsBeforeThird).length >= 1,
      true,
    );
    const secondEvent = eventsOf(node.seen, 'context.archive_notice')[1]?.data ?? {};
    expect(
      '②.8 第二张卡：本轮新增 1 条 / 累计 3 条（折叠说增量、展开说累计）',
      [secondEvent['added'], secondEvent['archived'], secondEvent['tool_call_ids']],
      [1, 3, ['call_t3_3']],
    );
    expectTrue(
      '②.9 第二张卡首行是「本轮 1 条」而不是「累计 3 条」',
      String(secondEvent['summary'] ?? '').startsWith(
        'trim: 1 older tool result(s) archived this run',
      ),
      String(secondEvent['summary'] ?? '').split('\n')[0] ?? '',
    );
    expect('②.10 落盘里两张归档卡', archiveCardsIn(afterThird).length, 2);

    // ⑥(archive)：审计集合 == 段起点 plan，带 plan_hash。
    const beforeThird = await reload(mainDir);
    const planBeforeThird = planClearedToolResults(beforeThird?.messages ?? [], WINDOW);
    const announced = [
      ...((first['tool_call_ids'] as string[] | undefined) ?? []),
      ...((secondEvent['tool_call_ids'] as string[] | undefined) ?? []),
    ];
    const sameSet =
      [...announced].sort().join('\u0000') === [...planBeforeThird].sort().join('\u0000');
    const wantHash = expectedPlanHash('archive_notice', planBeforeThird);
    expectTrue(
      '⑥.1 archive_notice：审计集合（两张卡讲过的 id）== 第三轮段起点 plan，逐条相等',
      sameSet,
      'plan=' + JSON.stringify(planBeforeThird) + ' announced=' + JSON.stringify(announced),
    );
    expectTrue(
      '⑥.2 archive_notice：事件 plan_hash 与探针复算的 plan 指纹相等',
      secondEvent['plan_hash'] === wantHash,
      'plan_hash=' + String(secondEvent['plan_hash']) + ' want=' + wantHash,
    );

    // ③ 同载荷不重复发卡：run4 的历史没变 ⇒ plan 不变 ⇒ 不发第三张。
    const afterFourth = await runAndWait(node, mainDir, '第四轮：没有新工具结果');
    expect(
      '③.1 集合没变的段起点不再发卡（同载荷去重）',
      eventsOf(node.seen, 'context.archive_notice').length,
      2,
    );
    expect('③.2 落盘里仍然两张卡', archiveCardsIn(afterFourth).length, 2);

    // ④ 读回：卡上的每个 id 都能从 events.ndjson 按 tool_call_id 读回来。
    const readbackIds = announced;
    for (let tick = 0; tick < 200; tick += 1) {
      const probe = await log.read(SESSION);
      if (probe.some((record) => record.type === 'tool.call.completed')) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const source = createSessionEventsSource({ log, watermark: watermarkOf });
    const methods = createSessionMethods({
      sessionFor: () => ({ load: async () => await reload(mainDir) }) as never,
      sessionEvents: source,
    });
    const eventsMethod = methods.find((method) => method.name === 'sessions.events');
    if (eventsMethod === undefined) throw new Error('找不到 sessions.events');
    type EventsResult = { events: { type: string; data?: unknown }[]; has_more: boolean };
    const callReadback = async (toolCallId: string): Promise<EventsResult> =>
      (await eventsMethod.handler(
        { session_id: SESSION, tool_call_id: toolCallId },
        {} as never,
      )) as EventsResult;

    let readbackOk = readbackIds.length === 3;
    const readbackDetail: string[] = [];
    for (const id of readbackIds) {
      const page = await callReadback(id);
      const onlyThis = page.events.every(
        (event) => (event.data as { tool_call_id?: unknown } | undefined)?.tool_call_id === id,
      );
      const completed = page.events.find((event) => event.type === 'tool.call.completed');
      const result = (completed?.data as { result?: unknown } | undefined)?.result;
      readbackDetail.push(id + ':' + page.events.length + ':' + String(result === BODY));
      if (!onlyThis || result !== BODY) readbackOk = false;
    }
    expectTrue(
      '④.1 卡上每个 id 都能用 sessions.events{tool_call_id} 读回原文（逐字节相同）',
      readbackOk,
      readbackDetail.join(' '),
    );
    const unknown = await callReadback('call_does_not_exist');
    expect(
      '④.2 未知 tool_call_id ⇒ 空页（不假装有、也不报错）',
      [unknown.events.length, unknown.has_more],
      [0, false],
    );
    const unfiltered = (await eventsMethod.handler({ session_id: SESSION }, {} as never)) as {
      events: { type: string }[];
    };
    expectTrue(
      '④.3 不带 tool_call_id 时照旧返回整段日志（新增参数是 additive）',
      unfiltered.events.length > 3,
      'events=' + String(unfiltered.events.length),
    );
  } finally {
    node.stop();
  }
} finally {
  rmSync(mainDir, { recursive: true, force: true });
}

// ── ⑤ 读回能力不可用 ⇒ fail-open passthrough ────────────────────────────

section('⑤ 读回能力不可用 ⇒ fail-open passthrough + 审计 reason（不发卡）');

const degradeDir = mkdtempSync(join(tmpdir(), 'vessel-archive-degrade-'));
try {
  const store = new FileSessionStore(degradeDir);
  const seed = seededHistory(['call_seed_1', 'call_seed_2', 'call_seed_3']);
  await store.save({
    ...baseState(seed),
    cleared_tool_call_ids: undefined,
    context_projection: declareProjection({ mode: 'archive_notice', source: 'session_created' }),
  });
  const plan = planClearedToolResults(seed, WINDOW);
  expect('⑤.0 这个节点的历史里确实有会被归档的旧结果', plan.length > 0, true);

  const node = await startNode({
    dir: degradeDir,
    scripts: [[]],
    eventLog: new NoSeekEventLog(),
  });
  try {
    const state = await runAndWait(node, degradeDir, '继续');
    const audit = state.context_projection_audit ?? null;
    expect(
      '⑤.1 决策链路仍是冻结词表：声明 archive_notice → unavailable → passthrough',
      audit === null ? null : [audit.steps, audit.reason],
      [['archive_notice', 'unavailable', 'passthrough'], 'projection_mode_unavailable'],
    );
    expect('⑤.2 审计仍记得用户声明的是什么', audit?.requested_mode ?? null, 'archive_notice');
    const degraded = eventsOf(node.seen, 'context.projection_degraded')[0]?.data ?? {};
    expect(
      '⑤.3 degraded 事件：effective_mode = passthrough + 原因（不新造码）',
      [degraded['effective_mode'], degraded['reason'], degraded['readback']],
      ['passthrough', 'projection_mode_unavailable', 'unavailable'],
    );
    expect('⑤.4 读不回来就不许发卡（落盘零归档卡）', archiveCardsIn(state).length, 0);
    expect(
      '⑤.5 不发 context.archive_notice 事件',
      eventsOf(node.seen, 'context.archive_notice').length,
      0,
    );
    expect(
      '⑤.6 也不写占位集合（passthrough 的审计口径）',
      state.cleared_tool_call_ids ?? null,
      null,
    );
    expectTrue(
      '⑤.7 声明本身没被改写（单调收紧：只降这一次 run 的生效模式）',
      state.context_projection?.mode === 'archive_notice',
      String(state.context_projection?.mode),
    );
    expectTrue(
      '⑤.8 降级后请求视图仍是原文（零占位）',
      node.provider.requests.every((messages) =>
        messages.every(
          (message) => message.role !== 'tool' || !String(message.content).startsWith('[cleared '),
        ),
      ),
      'passthrough 的请求与落盘逐字节相同',
    );
  } finally {
    node.stop();
  }
} finally {
  rmSync(degradeDir, { recursive: true, force: true });
}

// ── ⑥(placeholder) 审计集合 vs 段起点 plan（补 C1g 的缺口） ──────────────

section('⑥ placeholder：审计集合（cleared_tool_call_ids）== 段起点 plan，带 plan_hash');

const placeholderDir = mkdtempSync(join(tmpdir(), 'vessel-archive-plan-'));
try {
  const store = new FileSessionStore(placeholderDir);
  const seed = seededHistory(['call_seed_1', 'call_seed_2', 'call_seed_3']);
  await store.save({
    ...baseState(seed),
    context_projection: declareProjection({ mode: 'placeholder', source: 'session_created' }),
  });
  const plan = planClearedToolResults(seed, WINDOW);
  const node = await startNode({
    dir: placeholderDir,
    scripts: [[]],
    eventLog: new SessionEventLog({ dir: join(placeholderDir, 'sessions'), durable: false }),
  });
  try {
    const state = await runAndWait(node, placeholderDir, '继续');
    const auditIds = [...(state.cleared_tool_call_ids ?? [])].sort();
    const sameSet = auditIds.join('\u0000') === [...plan].sort().join('\u0000');
    expectTrue(
      '⑥.3 placeholder：落盘审计集合 == 段起点 plan，逐条相等',
      sameSet && plan.length > 0,
      'plan=' + JSON.stringify(plan) + ' audit=' + JSON.stringify(auditIds),
    );
    const applied = eventsOf(node.seen, 'context.projection_applied')[0]?.data ?? {};
    const wantHash = expectedPlanHash('placeholder', plan);
    expectTrue(
      '⑥.4 placeholder：事件 plan_hash 与探针复算的指纹相等（漂了就是这一段）',
      applied['plan_hash'] === wantHash,
      'plan_hash=' + String(applied['plan_hash']) + ' want=' + wantHash,
    );
    expect('⑥.5 placeholder：归档卡一条都没有（模式之间不串味）', archiveCardsIn(state).length, 0);
  } finally {
    node.stop();
  }
} finally {
  rmSync(placeholderDir, { recursive: true, force: true });
}

// ── 收尾 ────────────────────────────────────────────────────────────────

console.log('');
if (failures.length === 0) {
  console.log('归档卡（archive_notice）探针：通过 ' + String(checks) + ' 项，0 项红。');
  console.log(
    '建议接线位置（U3 不改 package.json）：把本探针加进 gates 的 projection 组，紧随 check-projection-modes 之后。',
  );
  process.exit(0);
}
console.log(
  '归档卡（archive_notice）探针：' +
    String(failures.length) +
    ' 项红（共 ' +
    String(checks) +
    ' 项）：',
);
for (const failure of failures) console.log('  - ' + failure);
process.exit(1);
