#!/usr/bin/env bun
/**
 * 端到端门禁：「上下文」环境卡的跨进程去重（分支 0.52-ctx-card-dedup）。
 *
 * 现象：重启 gateway 后发第一条消息，又收到一张**全量**「上下文」卡 —— 卡里的
 * hash / model / tools_count 与重启前那张完全一样，只有 message_count、
 * estimated_tokens 变了。⇒ 不是「指纹变了」，是去重判定没生效。
 *
 * 为什么这个探针必须跑**真实 run**：scripts/check-prompt-context-dedup.ts 只测
 * 纯函数 shouldPublishSystemContext() 和源码接线。它证明了「判定写对了」，却证明
 * 不了「判定拿到的 restored 不是 undefined」。这里起真的 ExecutionUnit，从
 * MemoryEventStream 上数 prompt.system_context 的实际发布次数。
 *
 * 「重启」的口径：丢掉 ExecutionUnit 与事件流，**重新 new FileSessionStore(同一目录)**
 * 再造一个单元 —— 与会话文件落盘/重读走同一条路径，不吃内存里的残留状态。
 *
 * 场景（每条都是断言，失败即非零退出）：
 *   E1 新会话第一次 run             => 恰好 1 张**全量**卡（带 system_prompt，无 previous_hash）
 *   E2 同一 ExecutionUnit 连跑 3 轮  => 0 张（不许「只修首轮」）
 *   E3 重启（新 store + 新 EU）      => 0 张  <- 用户实测报的那条
 *   E4 换 model                     => 恰好 1 张，previous_hash = E1 的 hash，changed 只列 model
 *   E5 换 tools 数（装个插件）      => 恰好 1 张，changed 只列 tools
 *   E6 E4/E5 之后再重启且形状不变   => 0 张（认的是最新落盘指纹）
 *   E7 连续 5 轮形状不变            => 永远 0 张（跨轮稳定，不是碰巧首轮）
 *
 * 反例护栏：E4 / E5 保证「真实变化必须发」，不许为了「不发」把变化一起吞掉。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createRunJournalFactory,
  ExecutionUnit,
  FileSessionStore,
  MemoryEventStream,
  MemoryLLMProvider,
  MemoryWorkingContext,
  type Plugin,
  type RunEvent,
  type RunRecord,
  type SessionEventInput,
  type SessionEventLogPort,
  type SessionEventRecord,
  type SessionState,
  type ToolDefinition,
} from '../packages/core/src/index';

const MODEL_A = 'probe/model-a';
const MODEL_B = 'probe/model-b';
const SESSION_ID = 's-ctx-card-dedup';
const SYSTEM_PROMPT = 'probe system prompt for context card dedup';

/** 一张「上下文」环境卡（payload 里我们关心的部分）。 */
interface ContextCard {
  hash: string;
  model: string;
  tools_count: number;
  message_count?: number;
  estimated_tokens?: number;
  previous_hash?: string;
  changed?: string[];
  system_prompt?: string;
  self_card?: unknown;
}

const failures: string[] = [];
let checks = 0;

function ok(name: string, detail: string): void {
  checks += 1;
  console.log('  ok   ' + name + ' — ' + detail);
}

function fail(name: string, message: string): void {
  checks += 1;
  failures.push(name + ': ' + message);
  console.log('  FAIL ' + name + ' — ' + message);
}

/** 断言：实际值等于期望值 */
function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) ok(name, '= ' + String(a));
  else fail(name, '期望 ' + String(e) + '，实际 ' + String(a));
}

/** 抓 prompt.system_context 的收集器（按场景分段取用）。 */
class CardCollector {
  private readonly seen: ContextCard[] = [];
  private readonly unsubscribe: () => void;

  constructor(events: MemoryEventStream) {
    this.unsubscribe = events.subscribe((event: RunEvent) => {
      if (event.type !== 'prompt.system_context') return;
      this.seen.push(event.data as unknown as ContextCard);
    });
  }

  /** 取走自上次 take() 以来发布的所有卡 */
  take(): ContextCard[] {
    return this.seen.splice(0, this.seen.length);
  }

  stop(): void {
    this.unsubscribe();
  }
}

/** 内存事件日志（journal 需要它；探针不关心盘上事件，只数发布次数）。 */
class MemoryEventLog implements SessionEventLogPort {
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

/** 让 tools 数量变化用的假工具（E5：换 tools 数必须发卡） */
function makeProbeTool(name: string): ToolDefinition {
  return {
    name,
    description: 'probe tool',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => ({ content: 'ok' }) as never,
  };
}

const extraToolPlugin: Plugin = {
  name: 'probe-extra-tool',
  install(host): void {
    host.registerTool(makeProbeTool('probe_extra_tool'));
  },
};

interface NodeSpec {
  dir: string;
  model: string;
  /** 可选：只在需要「tools 数变化」的用例里给 */
  extraTool?: boolean;
}

/**
 * 一个「节点」= 一份落盘目录 + 一条事件流 + 一个 ExecutionUnit。
 * 想要「重启」，就丢掉这个对象，用同一个 dir 再造一个。
 */
class SimNode {
  readonly events: MemoryEventStream;
  readonly log: MemoryEventLog;
  readonly collector: CardCollector;
  readonly store: FileSessionStore;
  readonly eu: ExecutionUnit;

  private constructor(
    readonly spec: NodeSpec,
    events: MemoryEventStream,
    log: MemoryEventLog,
    store: FileSessionStore,
    eu: ExecutionUnit,
  ) {
    this.events = events;
    this.log = log;
    this.store = store;
    this.eu = eu;
    this.collector = new CardCollector(events);
  }

  static async start(spec: NodeSpec): Promise<SimNode> {
    return SimNode.startWithPlugins(spec, spec.extraTool ? [extraToolPlugin] : []);
  }

  static async startWithPlugins(spec: NodeSpec, plugins: Plugin[]): Promise<SimNode> {
    const events = new MemoryEventStream();
    const log = new MemoryEventLog();
    // 关键：每次「启动」都新建 store，读的是盘上的会话文件，不是内存残留
    const store = new FileSessionStore(spec.dir);
    const eu = await ExecutionUnit.create({
      provider: new MemoryLLMProvider() as never,
      model: spec.model,
      contextFactory: () => new MemoryWorkingContext({ maxTokens: 200_000 }),
      events,
      limits: {},
      termination: {},
      journalFactory: createRunJournalFactory({ session: store, eventLog: log }),
      session: store,
      eventLog: log,
      ...(plugins.length > 0 ? { plugins } : {}),
      systemPrompt: SYSTEM_PROMPT,
      retry: { maxRetries: 0 },
    });
    return new SimNode(spec, events, log, store, eu);
  }

  /** 跑一轮，返回这一轮新发布的卡 */
  async turn(text: string): Promise<ContextCard[]> {
    await this.eu.run(text, SESSION_ID);
    return this.collector.take();
  }

  /** 等这一轮的 SessionState 指纹落盘（journal 的写是异步排队的） */
  async waitForPersisted(hash: string | undefined): Promise<void> {
    for (let tick = 0; tick < 400; tick += 1) {
      const fresh = await new FileSessionStore(this.spec.dir).load(SESSION_ID);
      const stored = fresh?.prompt_context;
      if (hash === undefined) {
        if (stored !== undefined) return;
      } else if (stored !== undefined && stored.hash === hash) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /** 从盘上重新读一份 SessionState（模拟另一个进程看到的状态） */
  async reload(): Promise<SessionState | null> {
    return new FileSessionStore(this.spec.dir).load(SESSION_ID);
  }

  stop(): void {
    this.collector.stop();
    this.eu.dispose?.();
  }
}

/**
 * 可在两轮之间装卸工具的插件：用来证明「tools 数变了必须发卡」，而且是在**同一个进程**
 * 里变（这样才有可比快照， 才有内容可列）。
 */
/** 插件装工具只需要这两个方法（不依赖 PluginHost 的具体实现） */
interface ToolHostLike {
  registerTool(tool: ToolDefinition): void;
  unregisterTool(name: string): boolean;
}

class ToolToggle implements Plugin {
  readonly name = 'probe-tool-toggle';
  private host: ToolHostLike | null = null;

  install(host: unknown): void {
    this.host = host as ToolHostLike;
  }

  add(): void {
    this.host?.registerTool(makeProbeTool('probe_extra_tool'));
  }

  remove(): void {
    this.host?.unregisterTool('probe_extra_tool');
  }
}

/**
 * 一条「被中断的 run」记录（重启后平台就是拿这种记录去 resumeRun）。
 * resumeRun 只关心 run_id / session_id / status，其余字段按 RunRecord 的形状补齐。
 */
function makeInterruptedRecord(runId: string): RunRecord {
  const now = Date.now();
  return {
    run_id: runId,
    session_id: SESSION_ID,
    status: 'interrupted',
    created_at: now - 60_000,
    updated_at: now - 30_000,
    iteration: 1,
  } as unknown as RunRecord;
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'vessel-ctx-card-'));

  try {
    console.log('[E1] 新会话第一次 run：应当恰好 1 张全量卡');
    const first = await SimNode.start({ dir, model: MODEL_A, extraTool: false });
    const e1 = await first.turn('第一次说话');
    eq('E1.1 新会话恰好发 1 张上下文卡', e1.length, 1);
    const card1 = e1[0];
    if (card1 === undefined) {
      fail('E1.2 首卡存在', '一张都没有');
      throw new Error('首卡缺失，后续断言无意义');
    }
    const baseHash = card1.hash;
    const baseTools = card1.tools_count;
    ok('E1.2 首卡 hash', baseHash);
    eq('E1.3 首卡是全量（没有 previous_hash）', card1.previous_hash, undefined);
    eq('E1.4 首卡没有 changed（首次没有可比对象）', card1.changed, undefined);
    eq('E1.5 首卡带 system_prompt 原文', card1.system_prompt, SYSTEM_PROMPT);
    eq('E1.6 首卡 model', card1.model, MODEL_A);
    await first.waitForPersisted(baseHash);
    const persisted1 = await first.reload();
    eq('E1.7 SessionState 落盘了 prompt_context.hash', persisted1?.prompt_context?.hash, baseHash);
    eq('E1.8 落盘的 prompt_context.model', persisted1?.prompt_context?.model, MODEL_A);
    eq(
      'E1.9 落盘的 prompt_context.tools_count',
      persisted1?.prompt_context?.tools_count,
      baseTools,
    );

    console.log('[E2] 同一个 ExecutionUnit 连跑 3 轮（形状不变）：应当 0 张');
    const e2a = await first.turn('第二次说话');
    eq('E2.1 第 2 轮不发卡', e2a.length, 0);
    const e2b = await first.turn('第三次说话');
    eq('E2.2 第 3 轮不发卡', e2b.length, 0);
    const e2c = await first.turn('第四次说话');
    eq('E2.3 第 4 轮不发卡', e2c.length, 0);
    first.stop();

    console.log('[E3] 重启（新 store + 新 ExecutionUnit，hash/model/tools 全同）：应当 0 张');
    const restarted = await SimNode.start({ dir, model: MODEL_A, extraTool: false });
    const e3 = await restarted.turn('重启后的第一条消息');
    eq('E3.1 重启后不发全量卡（用户报的那条）', e3.length, 0);
    restarted.stop();

    const restartedAgain = await SimNode.start({ dir, model: MODEL_A, extraTool: false });
    const e3b = await restartedAgain.turn('再次重启后的第一条消息');
    eq('E3.2 连续第二次重启仍然不发卡', e3b.length, 0);
    restartedAgain.stop();

    console.log('[E4] 重启 + 换 model：恰好 1 张（真实变化不许被吞掉）');
    const swapped = await SimNode.start({ dir, model: MODEL_B, extraTool: false });
    const e4 = await swapped.turn('换模型后的第一条消息');
    eq('E4.1 换 model 必须发卡', e4.length, 1);
    const card4 = e4[0];
    eq('E4.2 换 model 后的卡里 model 是新值', card4?.model, MODEL_B);
    eq('E4.3 跨进程只有指纹可比：仍带 previous_hash', card4?.previous_hash, baseHash);
    eq('E4.4 只列变了的项（model）', card4?.changed, ['model: ' + MODEL_A + ' → ' + MODEL_B]);
    eq('E4.5 卡里仍然带全文 system_prompt（全量卡不缩水）', card4?.system_prompt, SYSTEM_PROMPT);
    await swapped.waitForPersisted(card4?.hash);
    swapped.stop();

    const swappedAgain = await SimNode.start({ dir, model: MODEL_B, extraTool: false });
    const e4b = await swappedAgain.turn('新模型下的第二条消息');
    eq('E4.6 换模型之后再重启且形状不变：不发卡', e4b.length, 0);
    swappedAgain.stop();

    console.log('[E5] 同一进程内装卸工具（tools_count 变）：恰好 1 张，且只列变了的项');
    const toggle = new ToolToggle();
    const toggled = await SimNode.startWithPlugins({ dir, model: MODEL_B }, [toggle]);
    const e5pre = await toggled.turn('装工具前的第二条消息');
    eq('E5.1 装工具之前不发卡', e5pre.length, 0);
    toggle.add();
    const e5 = await toggled.turn('装了一个新工具之后');
    eq('E5.2 tools 数变化必须发卡', e5.length, 1);
    const card5 = e5[0];
    eq('E5.3 changed 只列变了的项', card5?.changed, [
      'tools: ' + String(baseTools) + ' → ' + String(baseTools + 1),
    ]);
    eq('E5.4 增量卡带 previous_hash', card5?.previous_hash, baseHash);
    eq('E5.5 hash 没变（hash 只覆盖 system_prompt / self_card）', card5?.hash, baseHash);
    const e5b = await toggled.turn('工具没再变的一轮');
    eq('E5.6 工具变了之后，形状不变就不发卡', e5b.length, 0);
    toggle.remove();
    const e5c = await toggled.turn('把工具卸掉之后');
    eq('E5.7 卸载工具也算变化，必须发卡', e5c.length, 1);
    eq('E5.8 卸载后的 changed', e5c[0]?.changed, [
      'tools: ' + String(baseTools + 1) + ' → ' + String(baseTools),
    ]);
    await toggled.waitForPersisted(e5c[0]?.hash);
    toggled.stop();

    console.log('[E6] 带着新指纹重启：形状不变 => 0 张');
    const afterToggle = await SimNode.start({ dir, model: MODEL_B, extraTool: false });
    const e6 = await afterToggle.turn('最后一次重启后的第一条消息');
    eq('E6.1 重启后指纹一致：不发卡', e6.length, 0);
    afterToggle.stop();

    console.log('[E7] 连续 5 轮形状不变：永远 0 张（不是碰巧首轮）');
    const stable = await SimNode.start({ dir, model: MODEL_B, extraTool: false });
    let published = 0;
    for (const text of ['稳定 1', '稳定 2', '稳定 3', '稳定 4', '稳定 5']) {
      const cards = await stable.turn(text);
      published += cards.length;
    }
    eq('E7.1 连续 5 轮不发卡', published, 0);
    stable.stop();

    console.log('[E8] 重启后接管被中断的 run（resumeRun）：指纹没变 => 0 张');
    const resumeDir = await mkdtemp(join(tmpdir(), 'vessel-ctx-card-resume-'));
    try {
      const beforeRestart = await SimNode.start({
        dir: resumeDir,
        model: MODEL_A,
        extraTool: false,
      });
      const e8first = await beforeRestart.turn('重启前的那一轮');
      eq('E8.1 重启前的一轮恰好 1 张卡', e8first.length, 1);
      await beforeRestart.waitForPersisted(e8first[0]?.hash);
      beforeRestart.stop();

      // 重启：新 store + 新 ExecutionUnit，走 resumeRun（不是 run）接管被中断的 run
      const takingOver = await SimNode.start({ dir: resumeDir, model: MODEL_A, extraTool: false });
      await takingOver.eu.resumeRun(makeInterruptedRecord('run-interrupted-same'));
      eq('E8.2 resume 接管同形状环境：不发全量卡', takingOver.collector.take().length, 0);
      takingOver.stop();

      // 反例：resume 时环境真变了（换 model）=> 必须发，且只列变了的项
      const takingOverChanged = await SimNode.start({
        dir: resumeDir,
        model: MODEL_B,
        extraTool: false,
      });
      await takingOverChanged.eu.resumeRun(makeInterruptedRecord('run-interrupted-changed'));
      const e8c = takingOverChanged.collector.take();
      eq('E8.3 resume 时换 model 必须发卡', e8c.length, 1);
      eq('E8.4 卡里 model 是新值', e8c[0]?.model, MODEL_B);
      eq('E8.5 只列变了的项', e8c[0]?.changed, ['model: ' + MODEL_A + ' → ' + MODEL_B]);
      eq('E8.6 增量卡带 previous_hash', e8c[0]?.previous_hash, e8first[0]?.hash);
      takingOverChanged.stop();
    } finally {
      await rm(resumeDir, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log('');
  console.log('共 ' + String(checks) + ' 条断言，失败 ' + String(failures.length) + ' 条');
  if (failures.length > 0) {
    for (const item of failures) console.log('  - ' + item);
    process.exit(1);
  }
  console.log('prompt.system_context 跨进程去重：全部通过');
}

await main();
