#!/usr/bin/env bun
/**
 * 0.53 U2 探针：会话级投射模式（`placeholder` / `passthrough`）的端到端接线。
 *
 * 跑的是**真** runtime（`ExecutionUnit` + `FileSessionStore` + `MemoryWorkingContext`），
 * 不是纯函数单测 —— 因为这些不变量只在「请求真的发出去」的时候才成立：
 *
 *  ① `passthrough` 的请求与「完全没有投射机制」逐字节相同（含消息顺序、tool_call 配对、
 *     零占位、无 trim 卡）；
 *  ② `placeholder` 与改前行为等价（占位集合 = 段起点规划集合，新工具结果保留原文）；
 *  ③ **同 run 两次请求的占位集合完全相同**（run 起点冻结；这是硬不变式，反事实测算
 *     改成每请求重算会把净收益从 +9.85 打成 −72.37）；
 *  ④ 决策变更的 run 起点写一条 `context_projection_audit` + 同名事件；没变更的 run
 *     不写（不刷日志）；
 *  ⑤ 未实现 mode（`archive_notice`）⇒ fail-open `passthrough` + 审计 reason；
 *  ⑥ 非法声明 ⇒ fail-open `passthrough` + 审计 reason；
 *  ⑦ `passthrough` 下 0.20 体积阈值只发 `context.projection_pressure`，不触发压缩，
 *     且 0.85 主阈值仍是硬兜底。
 *
 * 落盘历史只 append/pop、正文不改 —— 本探针顺带钉住：占位只出现在**请求视图**里，
 * 盘上的工具结果正文一个字节都没变（T2 的老断言在 `check-tool-result-clear.ts`，
 * 这里再确认一遍端到端版本）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ChatRequest,
  createRunJournalFactory,
  declareProjection,
  ExecutionUnit,
  FileSessionStore,
  isClearedToolResult,
  type LLMProvider,
  type LLMResponse,
  MemoryEventStream,
  MemoryWorkingContext,
  type Message,
  type Plugin,
  planClearedToolResults,
  type SessionEventInput,
  type SessionEventLogPort,
  type SessionEventRecord,
  type SessionState,
  type ToolDefinition,
} from '../packages/core/src/index';

const SESSION_ID = 's-projection-modes';
const SYSTEM_PROMPT = 'probe system prompt for projection modes';
/** 单条工具结果 ≈ 2000 字符 ≈ 500 tokens（`estimateTokens` 对 ASCII 是 0.25/字符）。 */
const BIG_BODY = 'x'.repeat(2000);
/**
 * ②③④⑥ 的窗口：5% 保留预算 = 130 tokens ⇒ 500-token 的工具结果必被清；20% 线 = 520
 * ⇒ 单条 500 **不**触顶（否则段起点先压缩，占位判据就被压缩抢先了，看不干净）。
 */
const WINDOW = 2600;
/** ⑦ 的窗口：两条工具结果 = 1000 / 2000 = 50% 越过 20%，而总量 ≈ 1030 < 0.85 × 2000。 */
const PRESSURE_WINDOW = 2000;

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
  if (a === w) ok(name, a.length > 120 ? a.slice(0, 117) + '...' : a);
  else fail(name, 'want ' + w + ' got ' + a);
}

function expectTrue(name: string, actual: boolean, detail: string): void {
  if (actual) ok(name, detail);
  else fail(name, detail);
}

function section(title: string): void {
  console.log('\n' + title);
}

// ── 内存事件日志（journal 需要它；探针不关心盘上事件） ──────────────────────

class ProbeEventLog implements SessionEventLogPort {
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

// ── 假 provider：记录每次请求的 messages，按脚本回工具调用 ──────────────────

/**
 * 按脚本发工具调用的 provider。
 *
 * `toolNames` 是「这一轮要依次调用的工具」：第 N 条请求里已经有 M 条工具结果，
 * M < toolNames.length 就再调一个，否则收尾。这样一次 `run()` 里能稳定拿到
 * toolNames.length + 1 条请求 —— ③ 需要「同 run 两次请求」才能验证冻结。
 */
class ScriptedProvider implements LLMProvider {
  readonly requests: Message[][] = [];
  private readonly toolNames: readonly string[];
  /** 唯一 call id 的计数器：同名工具在不同轮必须拿到不同 id（否则历史里 id 撞车）。 */
  private callSeq = 0;

  constructor(toolNames: readonly string[]) {
    this.toolNames = toolNames;
  }

  async chat(request: ChatRequest): Promise<LLMResponse> {
    // 深拷贝：runtime 之后可能复用/改写这些对象，探针要的是「发出去那一刻」的快照。
    this.requests.push(structuredClone(request.messages) as Message[]);
    // 只数**本轮**产生的工具结果：最后一条 user 消息之后的 tool 消息条数。
    // （按全历史数会让第二轮一开始就以为脚本走完了 —— 每轮都要重新从第一个工具开始。）
    let lastUser = -1;
    for (let index = 0; index < request.messages.length; index += 1) {
      if (request.messages[index]?.role === 'user') lastUser = index;
    }
    const produced = request.messages
      .slice(lastUser + 1)
      .filter((message) => message.role === 'tool').length;
    const next = this.toolNames[produced];
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
    description: 'probe tool that returns a big body',
    inputSchema: { type: 'object', properties: {} },
    // `ToolHandler` 返回 string，runtime 原样存进 tool 消息 —— 工具结果正文故意很大：
    // 段起点的占位规划一定会清掉它（passthrough 下才不产生占位）。
    handler: async () => BIG_BODY,
  };
}

/**
 * 包一层 store：`load()` 会把声明**注入**成脏值。
 *
 * 为什么需要它：`FileSessionStore` 读盘时就会把非法声明归一成 `undefined`（防御性设计，
 * 值得保留 —— 一个坏字段不该带走整个会话）。所以「运行期读到脏声明」这条路径用真
 * FileStore 造不出来，但它必须被守：runtime 不能假设每个 store 都做了归一化
 * （旧后端 / 别家实现 / 内存态都可能把原样对象递进来）。这里模拟的正是那种来源。
 */
class StateInjectingStore extends FileSessionStore {
  private readonly dirty: unknown;

  constructor(dir: string, dirty: unknown) {
    super(dir);
    this.dirty = dirty;
  }

  override async load(sessionId: string): Promise<SessionState | null> {
    const base = await super.load(sessionId);
    if (base === null) return null;
    return { ...base, context_projection: this.dirty as never };
  }
}

function toolPlugin(names: readonly string[]): Plugin {
  return {
    name: 'probe-projection-tools',
    install(host): void {
      for (const name of names) host.registerTool(makeTool(name));
    },
  };
}

// ── 一个「节点」= 一份落盘目录 + 事件流 + ExecutionUnit ─────────────────────

interface RunEventLike {
  type?: string;
  data?: Record<string, unknown>;
}

class SimNode {
  readonly dir: string;
  readonly events: MemoryEventStream;
  readonly log: ProbeEventLog;
  readonly store: FileSessionStore;
  readonly eu: ExecutionUnit;
  readonly provider: ScriptedProvider;
  readonly seen: RunEventLike[] = [];

  constructor(
    dir: string,
    events: MemoryEventStream,
    log: ProbeEventLog,
    store: FileSessionStore,
    eu: ExecutionUnit,
    provider: ScriptedProvider,
  ) {
    this.dir = dir;
    this.events = events;
    this.log = log;
    this.store = store;
    this.eu = eu;
    this.provider = provider;
  }

  static async start(
    dir: string,
    toolNames: readonly string[],
    options?: { store?: FileSessionStore | StateInjectingStore; maxTokens?: number },
  ): Promise<SimNode> {
    const events = new MemoryEventStream();
    const log = new ProbeEventLog();
    const store = options?.store ?? new FileSessionStore(dir);
    const windowTokens = options?.maxTokens ?? WINDOW;
    const provider = new ScriptedProvider(toolNames);
    const eu = await ExecutionUnit.create({
      provider: provider as never,
      model: 'probe/projection',
      contextFactory: () => {
        const context = new MemoryWorkingContext({ maxTokens: windowTokens, autoCompact: true });
        // 不给 sessionId 会让 token 计数是 NaN（limit 卡会印出「NaN/2000」），
        // 探针要判的是体积阈值，必须让计数是真的。
        context.setSessionId(SESSION_ID);
        return context;
      },
      events,
      limits: {},
      termination: {},
      journalFactory: createRunJournalFactory({ session: store as never, eventLog: log }),
      session: store as never,
      eventLog: log,
      plugins: [toolPlugin(toolNames)],
      systemPrompt: SYSTEM_PROMPT,
      retry: { maxRetries: 0 },
    });
    const node = new SimNode(dir, events, log, store, eu, provider);
    events.subscribe((event: unknown) => {
      node.seen.push(event as RunEventLike);
    });
    return node;
  }

  /** 跑一轮。返回这一轮**之后**盘上的 SessionState（等它落盘）。 */
  async run(text: string): Promise<SessionState> {
    await this.eu.run(text, SESSION_ID);
    return await this.waitPersisted();
  }

  /** journal 的写是异步排队的：等到 status 不再 running 且能看到最新一条。 */
  async waitPersisted(): Promise<SessionState> {
    for (let tick = 0; tick < 800; tick += 1) {
      const fresh = await new FileSessionStore(this.dir).load(SESSION_ID);
      if (fresh !== undefined && fresh !== null && fresh.status !== 'running') return fresh;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const last = await new FileSessionStore(this.dir).load(SESSION_ID);
    if (last === undefined || last === null) throw new Error('session state 没有落盘');
    return last;
  }

  async reload(): Promise<SessionState | null> {
    return await new FileSessionStore(this.dir).load(SESSION_ID);
  }

  /** 把声明写进盘上的会话状态（应用层动作；runtime 只读声明）。 */
  async declare(params: {
    mode: 'placeholder' | 'passthrough' | 'archive_notice' | 'externalize';
  }): Promise<void> {
    const current = await this.reload();
    const base: SessionState = current ?? {
      session_id: SESSION_ID,
      status: 'completed',
      messages: [],
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    await this.store.save({
      ...base,
      context_projection: declareProjection({
        mode: params.mode,
        source: 'session_created',
      }),
      updated_at: Date.now(),
    });
  }

  eventsOf(type: string): RunEventLike[] {
    return this.seen.filter((event) => event.type === type);
  }

  stop(): void {
    this.eu.dispose?.();
  }
}

// ── 请求视图的小工具 ────────────────────────────────────────────────────────

/** 请求视图里被占位的 tool_call id（按出现顺序）。 */
function clearedIdsOf(messages: readonly Message[]): string[] {
  return messages
    .filter((message) => message.role === 'tool' && isClearedToolResult(String(message.content)))
    .map((message) => String(message.tool_call_id));
}

/** 盘上历史里的工具结果正文（tool_call_id → 长度）。 */
/** 盘上历史（ 是可选的；探针里缺省当空）。 */
function historyOf(state: SessionState | null | undefined): Message[] {
  return state?.messages ?? [];
}

function toolBodyLengths(messages: readonly Message[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    out[String(message.tool_call_id)] = String(message.content).length;
  }
  return out;
}

function withDir<T>(prefix: string, body: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return body(dir).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

// ── ① passthrough：与「没有投射机制」逐字节相同 ─────────────────────────────

async function scenarioPassthrough(): Promise<void> {
  section('① passthrough 的请求 = 落盘历史逐字节（零占位、无 trim 卡）');
  await withDir('vessel-proj-pass-', async (dir) => {
    const node = await SimNode.start(dir, ['probe_read_a', 'probe_read_b']);
    try {
      await node.declare({ mode: 'passthrough' });
      const state = await node.run('读这两份文件');
      const history = historyOf(state);
      const requests = node.provider.requests;

      // 请求条数：2 次工具调用 ⇒ 3 条请求（末条收尾）。
      expect('①.1 一轮里发了 3 条请求', requests.length, 3);

      const last = requests[requests.length - 1] ?? [];
      // 「完全没有投射机制」的基线：**盘上历史的前 N 条**。历史只 append，请求视图
      // 必然是它的前缀；基线完全由盘上数据拼，不经过任何投射代码。
      const baseline = history.slice(0, last.length);
      expect('①.2 最后一条请求（含 2 条大工具结果）逐字节等于基线', last, baseline);
      expect('①.3 请求里一条占位都没有', clearedIdsOf(last), []);
      expect(
        '①.4 工具结果正文长度 = 原始长度（没被截断 / 没被替换）',
        Object.values(toolBodyLengths(last)).sort(),
        [BIG_BODY.length, BIG_BODY.length],
      );
      // trim 卡是 env 卡（role=user, name=vessel:notice）：passthrough 下不许出现。
      expect(
        '①.5 落盘历史里没有任何 trim 卡',
        history.filter((message) => message.name === 'vessel:notice').length,
        0,
      );
      // 反证：这些工具结果**本来会被**清 —— 否则 ①.3 只是「没到阈值」的假绿。
      expectTrue(
        '①.6 反证：同一条历史按 placeholder 规划会清掉最旧 1 条',
        planClearedToolResults(baseline, WINDOW).length === 1,
        '规划集合 = ' + JSON.stringify(planClearedToolResults(baseline, WINDOW)),
      );
      // 落盘只 append：正文一字未改。
      expect('①.7 落盘的工具结果正文没被改写', Object.values(toolBodyLengths(history)).sort(), [
        BIG_BODY.length,
        BIG_BODY.length,
      ]);
    } finally {
      node.stop();
    }
  });
}

// ── ②③ placeholder：与改前等价 + 同 run 集合冻结 ─────────────────────────────

async function scenarioPlaceholder(): Promise<void> {
  section('②③ placeholder 等价 + 同 run 两次请求集合完全相同（冻结锁）');
  await withDir('vessel-proj-place-', async (dir) => {
    const node = await SimNode.start(dir, ['probe_read_a', 'probe_read_b']);
    try {
      await node.declare({ mode: 'placeholder' });
      // 第一轮：段起点没有工具结果 ⇒ 规划集合为空 ⇒ 请求里没有占位（改前行为）。
      const first = await node.run('读这两份文件');
      expect(
        '②.1 第一轮段起点没有旧工具结果 ⇒ 零占位',
        node.provider.requests.every((messages) => clearedIdsOf(messages).length === 0),
        true,
      );
      expect('②.2 第一轮落盘也没清任何 id', first.cleared_tool_call_ids ?? [], []);

      // 第二轮：段起点有 2 条工具结果 ⇒ 规划清掉最旧 1 条（只留最近 1 条）。
      const expectedPlan = planClearedToolResults(historyOf(first), WINDOW);
      expect('②.3 段起点规划（改前口径，纯函数复算）', expectedPlan, ['call_probe_read_a_1']);

      const beforeRun2 = node.provider.requests.length;
      const second = await node.run('再读一份');
      const run2 = node.provider.requests.slice(beforeRun2);
      expect('②.4 第二轮发了 3 条请求', run2.length, 3);

      const view1 = run2[0] ?? [];
      expect('②.5 第二轮第一条请求的占位集合 = 段起点规划集合', clearedIdsOf(view1), expectedPlan);
      // ②.6 本段**新产生**的工具结果必须保留原文：只在 freeze 的那一刻规划集合，
      // 之后新到的工具结果不进集合（否则「清了又清」）。看最后一条请求里的新工具结果。
      const lastView = run2[run2.length - 1] ?? [];
      const freshTools = lastView.filter((message) => message.role === 'tool').slice(-2);
      expect(
        '②.6 本段新产生的工具结果保留原文',
        freshTools.map((message) => isClearedToolResult(String(message.content))),
        [false, false],
      );

      // ③ 冻结锁：同一 run 内，工具结果从 2 条涨到 4 条，占位集合一个都不许变。
      expect(
        '③.1 同 run 第二次请求的占位集合与第一次**完全相同**',
        clearedIdsOf(run2[1] ?? []),
        clearedIdsOf(view1),
      );
      expect(
        '③.2 同 run 第三次请求的占位集合仍完全相同',
        clearedIdsOf(run2[2] ?? []),
        clearedIdsOf(view1),
      );
      // 自检：按当前 messages 重算确实会多清 —— 探针抓得到「每请求重算」的回归。
      const recomputed = planClearedToolResults(run2[2] ?? [], WINDOW);
      expectTrue(
        '③.3 回归自检：按当前 messages 重算会多清（旧行为的形状）',
        recomputed.length > clearedIdsOf(view1).length,
        '重算 ' + JSON.stringify(recomputed) + ' vs 冻结 ' + JSON.stringify(clearedIdsOf(view1)),
      );
      // 落盘只 append/pop：第二轮结束时的历史包含 4 条工具结果原文 + 2 条 trim 卡。
      expect(
        '③.4 落盘历史里的工具结果正文仍是原文（占位只在请求视图里）',
        Object.values(toolBodyLengths(historyOf(second))).every((n) => n === BIG_BODY.length),
        true,
      );
      expect(
        '③.5 落盘集合 = 段起点冻结集合（journal 单写口）',
        second.cleared_tool_call_ids ?? [],
        expectedPlan,
      );
    } finally {
      node.stop();
    }
  });
}

// ── ④ 审计：变更写一条、未变不写 ────────────────────────────────────────────

async function scenarioAudit(): Promise<void> {
  section('④ 审计只在决策变更时写一条（模式/集合都没变的 run 不写）');
  await withDir('vessel-proj-audit-', async (dir) => {
    const node = await SimNode.start(dir, ['probe_read_a']);
    try {
      await node.declare({ mode: 'placeholder' });
      const first = await node.run('读这份文件');
      const audit1 = first.context_projection_audit ?? null;
      expectTrue('④.1 第一次决策（新会话）写了一条审计', audit1 !== null, JSON.stringify(audit1));
      expect(
        '④.2 审计的决策链路 = 声明模式 → 生效模式',
        audit1 === null ? null : [audit1.steps, audit1.reason, audit1.requested_mode],
        [['placeholder', 'placeholder'], null, null],
      );
      expect('④.3 正常路径的 schema_version', audit1 === null ? null : audit1.schema_version, 1);
      expect(
        '④.4 决策变更 ⇒ 一条 context.projection_applied 事件',
        node.eventsOf('context.projection_applied').length,
        1,
      );
      expect(
        '④.5 没降级 ⇒ 不发 context.projection_degraded',
        node.eventsOf('context.projection_degraded').length,
        0,
      );
      // 快照（序列化后的字符串）：store 可能把同一个 state 对象递回来并在后续 run 里被
      // journal 原地改写，持着对象引用做比较会变成自证 —— 只比不可变的文本。
      const auditSnapshot = JSON.stringify(audit1);
      expectTrue(
        '④.5b 快照里能看出这是第一次决策',
        auditSnapshot.includes('"placeholder","placeholder"'),
        auditSnapshot.slice(0, 120),
      );

      // 第二轮：段起点的工具结果还是 1 条 ⇒ 「只留最近 1 条」⇒ 不清；模式也没变
      // ⇒ 决策没变 ⇒ 不写审计、不发事件。
      await node.run('再读一份');
      const afterSecond = await node.reload();
      expect(
        '④.6 模式与集合都没变 ⇒ 审计不重写（逐字节等于快照）',
        JSON.stringify(afterSecond?.context_projection_audit ?? null),
        auditSnapshot,
      );
      expect(
        '④.7 决策没变 ⇒ 没多发 applied 事件',
        node.eventsOf('context.projection_applied').length,
        1,
      );

      // 第三轮：显式改成 passthrough ⇒ 决策变更 ⇒ 覆盖一条新审计 + 一条新事件。
      await node.declare({ mode: 'passthrough' });
      await node.run('继续');
      const afterThird = await node.reload();
      const audit3 = afterThird?.context_projection_audit ?? null;
      expect(
        '④.8 模式变更 ⇒ 审计覆盖成本次决策',
        audit3 === null ? null : [audit3.steps, audit3.reason],
        [['passthrough', 'passthrough'], null],
      );
      expect(
        '④.9 模式变更 ⇒ 又发一条 applied 事件',
        node.eventsOf('context.projection_applied').length,
        2,
      );
      expect(
        '④.10 落盘的声明没有被 runtime 改写（单调收紧：只降生效模式）',
        afterThird?.context_projection?.mode ?? null,
        'passthrough',
      );
    } finally {
      node.stop();
    }
  });
}

// ── ⑤⑥ fail-open：未实现 mode / 非法声明 ────────────────────────────────────

async function scenarioFailOpen(): Promise<void> {
  section('⑤ 未实现 mode（archive_notice）⇒ fail-open passthrough + 审计 reason');

  await withDir('vessel-proj-arch-', async (dir) => {
    const node = await SimNode.start(dir, ['probe_read_a']);
    try {
      await node.declare({ mode: 'archive_notice' });
      const state = await node.run('读这份文件');
      const audit = state.context_projection_audit ?? null;
      expect(
        '⑤.1 决策链路 = 声明 archive_notice → unavailable → passthrough',
        audit === null ? null : [audit.steps, audit.reason],
        [['archive_notice', 'unavailable', 'passthrough'], 'projection_mode_unavailable'],
      );
      expect(
        '⑤.2 降级也要留原始请求模式',
        audit === null ? null : audit.requested_mode,
        'archive_notice',
      );
      expect(
        '⑤.3 降级发 context.projection_degraded（reason 可查）',
        node
          .eventsOf('context.projection_degraded')
          .map((event) => (event.data ?? {}).reason ?? null),
        ['projection_mode_unavailable'],
      );
      expect(
        '⑤.4 生效模式 passthrough ⇒ 请求里零占位（不许静默按 placeholder 跑）',
        node.provider.requests.every((messages) => clearedIdsOf(messages).length === 0),
        true,
      );
      expect('⑤.5 落盘集合为空（passthrough 不写占位集合）', state.cleared_tool_call_ids ?? [], []);
      expect(
        '⑤.6 声明本身没被改写（仍是 archive_notice）',
        state.context_projection?.mode ?? null,
        'archive_notice',
      );
    } finally {
      node.stop();
    }
  });

  section('⑥ 非法声明 ⇒ fail-open passthrough + 审计 reason');

  await withDir('vessel-proj-invalid-', async (dir) => {
    // 先落一份**合法**的会话壳（真 FileStore，声明先按 placeholder 存）。
    const seedStore = new FileSessionStore(dir);
    await seedStore.save({
      session_id: SESSION_ID,
      status: 'completed',
      messages: [],
      created_at: Date.now(),
      updated_at: Date.now(),
      context_projection: declareProjection({
        mode: 'placeholder',
        source: 'session_created',
      }),
    });
    // 再让 load 递进来一份**脏**声明（词表外的 mode）。真 FileStore 会在读盘时把它
    // 归一成 undefined，所以要模拟「别家 / 旧后端把原样对象递进来」的来源 ——
    // runtime 不能假设每个 store 都做了防御（这正是 fail-open 要守的边界）。
    const dirtyStore = new StateInjectingStore(dir, {
      declaration_id: 'dirty-1',
      mode: 'bogus_mode',
    });
    const node = await SimNode.start(dir, ['probe_read_a'], { store: dirtyStore });
    try {
      const state = await node.run('读这份文件');
      const audit = state.context_projection_audit ?? null;
      expect(
        '⑥.1 非法声明 ⇒ 生效 passthrough + reason 是 §6.4 的冻结码',
        audit === null ? null : [audit.steps[audit.steps.length - 1], audit.reason],
        ['passthrough', 'projection_declaration_invalid'],
      );
      expect(
        '⑥.2 非法声明也发 degraded 事件',
        node.eventsOf('context.projection_degraded').length > 0,
        true,
      );
      expect(
        '⑥.3 生效模式 passthrough ⇒ 零占位',
        node.provider.requests.every((messages) => clearedIdsOf(messages).length === 0),
        true,
      );
    } finally {
      node.stop();
    }
  });
}

// ── ⑦ passthrough 下的体积压力：只发事件、不压缩 ────────────────────────────

async function scenarioPressure(): Promise<void> {
  section('⑦ passthrough 下 0.20 只发 pressure、不压缩；0.85 仍是硬兜底');
  await withDir('vessel-proj-pressure-', async (dir) => {
    const node = await SimNode.start(dir, ['probe_read_a', 'probe_read_b'], {
      maxTokens: PRESSURE_WINDOW,
    });
    try {
      await node.declare({ mode: 'passthrough' });
      await node.run('读这两份文件');
      const afterFirst = await node.reload();
      const historyLen = historyOf(afterFirst).length;

      // 第二轮段起点：2 条 500-token 工具结果 = 1000 / 2000 = 50% > 20%，
      // 但 token 合计 ≈ 1030 < 0.85 × 2000 = 1700 ⇒ 只有 0.20 会越线。
      await node.run('再读一份');
      const afterSecond = await node.reload();

      const pressure = node.eventsOf('context.projection_pressure');
      expect('⑦.1 passthrough 下发了 context.projection_pressure', pressure.length, 1);
      const data = pressure[0]?.data ?? {};
      expect(
        '⑦.2 事件的体积口径',
        [data.basis, data.used, data.max, data.ratio],
        ['all_tool_results', 1000, 2000, 0.5],
      );
      expect('⑦.3 事件不带 mode 语义混淆：effective_mode 明写', data.effective_mode, 'passthrough');
      expect(
        '⑦.4 不触发压缩（没有 context.compacted 事件）',
        node.eventsOf('context.compacted').length,
        0,
      );
      expectTrue(
        '⑦.5 落盘历史只 append：没有压缩摘要',
        historyOf(afterSecond).length >= historyLen,
        'run2 后 ' + String(historyOf(afterSecond).length) + ' 条 ≥ run1 后 ' + String(historyLen),
      );
      expect(
        '⑦.6 请求里仍然是零占位（20% 越线也没开机制）',
        node.provider.requests.every((messages) => clearedIdsOf(messages).length === 0),
        true,
      );
    } finally {
      node.stop();
    }
  });

  // 硬兜底：同样的 passthrough 会话，把窗口压到 0.85 主阈值以下 ⇒ 必须压缩。
  await withDir('vessel-proj-floor-', async (dir) => {
    const node = await SimNode.start(dir, ['probe_read_a', 'probe_read_b'], {
      maxTokens: PRESSURE_WINDOW,
    });
    try {
      await node.declare({ mode: 'passthrough' });
      await node.run('读这两份文件');
      // 把同一段历史塞进一个更小的窗口（400 tokens ⇒ 0.85 × 400 = 340 < 1000）。
      // 这是「硬兜底」的口径检验：passthrough 不许把窗口撑爆。
      const shrunkEvents = new MemoryEventStream();
      const compacted: string[] = [];
      const pressureInShrunk: string[] = [];
      shrunkEvents.subscribe((event: unknown) => {
        const typed = event as RunEventLike;
        if (typed.type === 'context.compacted') compacted.push('context.compacted');
        if (typed.type === 'context.projection_pressure') pressureInShrunk.push('pressure');
      });
      const shrunk = await ExecutionUnit.create({
        provider: new ScriptedProvider([]) as never,
        model: 'probe/projection',
        contextFactory: () => {
          const context = new MemoryWorkingContext({ maxTokens: 400, autoCompact: true });
          context.setSessionId(SESSION_ID);
          return context;
        },
        events: shrunkEvents,
        limits: {},
        termination: {},
        journalFactory: createRunJournalFactory({
          session: new FileSessionStore(dir),
          eventLog: new ProbeEventLog(),
        }),
        session: new FileSessionStore(dir),
        eventLog: new ProbeEventLog(),
        systemPrompt: SYSTEM_PROMPT,
        retry: { maxRetries: 0 },
      });
      try {
        await shrunk.run('继续', SESSION_ID);
      } finally {
        shrunk.dispose?.();
      }
      expect(
        '⑦.7 passthrough 下 0.85 主阈值仍是硬兜底（小窗口 ⇒ 压缩过）',
        compacted.length > 0,
        true,
      );
      // 同一个段起点上压力事件还在（0.20 不驱动压缩，但要可观测）。
      expect('⑦.8 小窗口段起点照样发 pressure（观测面不丢）', pressureInShrunk.length > 0, true);
    } finally {
      node.stop();
    }
  });
}

// ── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await scenarioPassthrough();
  await scenarioPlaceholder();
  await scenarioAudit();
  await scenarioFailOpen();
  await scenarioPressure();

  console.log('');
  if (failures.length > 0) {
    console.log('投射模式接线探针：' + String(failures.length) + ' 项失败 / 共 ' + String(checks));
    for (const failure of failures) console.log('  - ' + failure);
    process.exit(1);
  }
  console.log('投射模式接线探针：全部通过（' + String(checks) + ' 项）');
  console.log(
    '建议接线位置（U2 不改 package.json）：把本探针加进 gates 的 projection 组，' +
      '紧随 check-projection-declaration 之后。',
  );
}

await main();
