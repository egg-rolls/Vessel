#!/usr/bin/env bun

/**
 * 门禁：上下文「真实用量锚点」（0.52 C）。
 *
 * 背景（实测）：同一份上下文（2032 条消息）重启前显示 80%（provider 上报
 * prompt_tokens 803k），重启后显示 51%（本地估算 543k）—— 本地估算对 CJK /
 * reasoning / 工具参数偏乐观，比例约 1.48。realTokens 只对某一次 provider
 * 请求有效，重启 / 新进程第一轮 / 压缩后都会归零，于是显示值掉回去。
 *
 * 修法：拿到真实用量的那一刻记下 ratio = prompt_tokens ÷ 同一请求的本地估算，
 * 按会话落盘到 SessionState.context_anchor；realTokens 为 0 时用 ratio 校正估算。
 *
 * 四层判据：
 *
 * - **C0 口径自检**：无锚点 = 裸估算（旧行为）、有锚点 = round(估算 × ratio)、
 *   有真实值时真实值优先（锚点不抢）、脏数据 / 换模型退回裸估算。
 * - **C1 记录口径**：ratio 的分母必须是**未校正的本地估算**。若用 tokenCount 当分母，
 *   第一次响应之后它已经等于真实口径，比值会塌成 1.0，重启后就白校正了 —— 这一层
 *   专门钉住这个陷阱。
 * - **C2 真实路径**：驱动真 ExecutionUnit + 假 provider（只改 prompt_tokens），
 *   把落盘的 SessionState 抓下来：锚点必须在，且读回新窗口后 tokenCount 仍是校正值。
 * - **C3 落盘兼容**：File / SQLite 两种后端真往返；旧快照 / 旧库没有该字段照常加载
 *   （缺省 = 裸估算，行为与 0.51 一致）；脏 JSON 不许把会话读崩。
 *
 * 用法：bun run scripts/check-context-anchor.ts（退出码 0 = 全过，1 = 有 FAIL）
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTEXT_ANCHOR_RATIO_MAX,
  CONTEXT_ANCHOR_RATIO_MIN,
  createRunJournalFactory,
  ExecutionUnit,
  estimateMessagesTokens,
  FileSessionStore,
  MemoryEventStream,
  MemoryLLMProvider,
  MemorySessionStore,
  MemoryWorkingContext,
  type Message,
  normalizeContextAnchor,
  type SessionEventInput,
  type SessionEventLogPort,
  type SessionEventRecord,
  type SessionState,
  SQLiteSessionStore,
} from '../packages/core/src/index';

const MODEL = 'probe-model-a';

const failures: string[] = [];
let passed = 0;
const paths: string[] = [];

function ok(label: string): void {
  passed += 1;
  paths.push(`OK   ${label}`);
}

function fail(where: string, message: string): void {
  failures.push(`${where}: ${message}`);
}

function expect(where: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) ok(`${where} = ${e}`);
  else fail(where, `期望 ${e}，实际 ${a}`);
}

// ───────────────────────── C0 口径自检 ─────────────────────────

/** 一条固定输入的消息：估算值由实现决定，判据只比「有没有乘 ratio」。 */
function seedWindow(ctx: MemoryWorkingContext, sessionId: string): void {
  ctx.setSessionId(sessionId);
  ctx.add({ role: 'user', content: '请审查 packages/core 的上下文估算口径（CJK 与工具参数）。' });
  ctx.add({
    role: 'assistant',
    content: '好，我先看 estimateTokens 与 tokenCount。',
    reasoning_content: '需要区分「真实用量」与「本地估算」两条路径，否则重启后会掉。',
  });
  ctx.add({ role: 'user', content: '继续。' });
}

function newContext(): MemoryWorkingContext {
  return new MemoryWorkingContext({ maxTokens: 200000 });
}

/** 无锚点时的裸估算（判据的基准值）。 */
function bareEstimate(): number {
  const ctx = newContext();
  seedWindow(ctx, 's-bare');
  return ctx.tokenCount;
}

function anchorOf(ratio: number, model = MODEL): SessionState['context_anchor'] {
  return {
    ratio,
    prompt_tokens: Math.round(1000 * ratio),
    request_estimate: 1000,
    model,
    at: 1_700_000_000_000,
  };
}

function c0(): void {
  const bare = bareEstimate();
  if (bare > 0) ok(`C0.0 裸估算基准 > 0（${bare}）`);
  else fail('C0.0', '裸估算为 0，判据无法成立');

  // 1. 没有锚点 ⇒ 等于裸估算（= 今天，0.51 行为）
  {
    const ctx = newContext();
    seedWindow(ctx, 's-no-anchor');
    expect('C0.1 无锚点 = 裸估算', ctx.tokenCount, bare);
  }

  // 2. 有锚点 ratio=1.48 ⇒ round(估算 × 1.48)
  {
    const ctx = newContext();
    seedWindow(ctx, 's-anchor');
    ctx.setContextAnchor(anchorOf(1.48), MODEL);
    expect('C0.2 锚点 1.48 = round(裸估算 × 1.48)', ctx.tokenCount, Math.round(bare * 1.48));
    // 锚点只影响展示 / 阈值口径，不改写底层估算缓存本身
    ctx.setContextAnchor(undefined, MODEL);
    expect('C0.2b 撤掉锚点回到裸估算', ctx.tokenCount, bare);
  }

  // 3. realTokens > 0 时仍然真实值优先（锚点不抢）
  {
    const ctx = newContext();
    seedWindow(ctx, 's-real');
    ctx.setContextAnchor(anchorOf(1.48), MODEL);
    ctx.updateRealTokens(803000);
    expect('C0.3 真实用量优先于锚点', ctx.tokenCount, 803000);
    ctx.add({ role: 'user', content: '再看一处。' });
    if (ctx.tokenCount > 803000) ok('C0.3b 真实值之上按增量累加（锚点不参与）');
    else fail('C0.3b', `真实值 + 新增消息后没有增长：${ctx.tokenCount}`);
  }

  // 4a. 非有限 / 非正 ratio ⇒ 退裸估算
  for (const ratio of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1.48]) {
    const ctx = newContext();
    seedWindow(ctx, 's-dirty');
    ctx.setContextAnchor({ ...anchorOf(1.48), ratio }, MODEL);
    expect(`C0.4a 脏 ratio(${String(ratio)}) = 裸估算`, ctx.tokenCount, bare);
  }

  // 4b. 落盘值越过 clamp 区间 ⇒ 当脏数据丢弃（记录路径夹紧，加载路径丢弃）
  for (const ratio of [CONTEXT_ANCHOR_RATIO_MIN / 2, CONTEXT_ANCHOR_RATIO_MAX * 2]) {
    const ctx = newContext();
    seedWindow(ctx, 's-out-of-range');
    ctx.setContextAnchor({ ...anchorOf(1.48), ratio }, MODEL);
    expect(`C0.4b 越界 ratio(${ratio}) = 裸估算`, ctx.tokenCount, bare);
    if (normalizeContextAnchor({ ...anchorOf(1.48), ratio }) === undefined) {
      ok(`C0.4b2 normalizeContextAnchor 丢弃越界值 ${ratio}`);
    } else {
      fail('C0.4b2', `normalizeContextAnchor 放过了越界 ratio ${ratio}`);
    }
  }

  // 4c. model 不一致 ⇒ 退裸估算（换 tokenizer 宁可不校正）
  {
    const ctx = newContext();
    seedWindow(ctx, 's-model');
    ctx.setContextAnchor(anchorOf(1.48, 'other-model'), MODEL);
    expect('C0.4c 换模型 = 裸估算', ctx.tokenCount, bare);
    const noModel = newContext();
    seedWindow(noModel, 's-model-less');
    noModel.setContextAnchor({ ...anchorOf(1.48), model: undefined }, MODEL);
    expect('C0.4c2 锚点没记模型 ⇒ 仍然生效', noModel.tokenCount, Math.round(bare * 1.48));
  }

  // 4d. 记录路径把极端值夹到区间边界（刚测到的真实数据，别整个丢掉）
  {
    const ctx = newContext();
    seedWindow(ctx, 's-clamp-hi');
    const stored = ctx.recordRealPromptTokens({ promptTokens: bare * 100, model: MODEL });
    expect('C0.4d 记录时上限夹紧', stored?.ratio, CONTEXT_ANCHOR_RATIO_MAX);
    const lo = newContext();
    seedWindow(lo, 's-clamp-lo');
    const storedLo = lo.recordRealPromptTokens({ promptTokens: 1, model: MODEL });
    expect('C0.4d2 记录时下限夹紧', storedLo?.ratio, CONTEXT_ANCHOR_RATIO_MIN);
  }

  // 4e. model 信息要跟着锚点走（换模型的会话不能误用）
  {
    const ctx = newContext();
    seedWindow(ctx, 's-model-stamp');
    const stored = ctx.recordRealPromptTokens({ promptTokens: bare, model: 'model-x' });
    expect('C0.4e 记录带 model', stored?.model, 'model-x');
  }
}

// ───────────────────────── C1 记录口径 ─────────────────────────

function c1(): void {
  const ctx = newContext();
  seedWindow(ctx, 's-record');
  const bare = ctx.tokenCount;
  // 模拟「第一轮 provider 上报 1.48 倍」：分母必须是裸估算，才记得住这个 1.48。
  const stored = ctx.recordRealPromptTokens({
    promptTokens: Math.round(bare * 1.48),
    model: MODEL,
  });
  expect('C1.2 request_estimate 记的是裸估算', stored?.request_estimate, bare);
  // prompt_tokens 取整会带来 ±0.5/bare 的误差，按容差比
  if (stored !== undefined && Math.abs(stored.ratio - 1.48) < 0.02) {
    ok(`C1.1 ratio = prompt_tokens ÷ 未校正估算（${stored.ratio.toFixed(4)}）`);
  } else {
    fail('C1.1', `ratio 不等于 1.48：${JSON.stringify(stored)}`);
  }

  // 陷阱：同一窗口里先塞了真实值再记录，若分母用 tokenCount 会得到 1.0
  const poisoned = newContext();
  seedWindow(poisoned, 's-record-after-real');
  poisoned.updateRealTokens(Math.round(bare * 1.48));
  const afterReal = poisoned.recordRealPromptTokens({
    promptTokens: Math.round(bare * 1.48),
    model: MODEL,
  });
  if (afterReal !== undefined && Math.abs(afterReal.ratio - 1.48) < 0.01) {
    ok('C1.3 真实值在场时分母仍是裸估算（ratio 保持 1.48）');
  } else {
    fail('C1.3', `真实值在场时 ratio 塌了：${JSON.stringify(afterReal)}`);
  }

  // 拿不到 estimate（空窗口）时不写锚点，避免 0 分母
  const empty = newContext();
  empty.setSessionId('s-empty');
  expect('C1.4 空窗口不写锚点', empty.recordRealPromptTokens({ promptTokens: 100 }), undefined);
}

// ───────────────────────── C2 真实路径 ─────────────────────────

/** 内存事件日志（SessionEventLogPort 的最小实现：只追加 + 按 seq 读）。 */
class MemoryEventLog implements SessionEventLogPort {
  private readonly bySession = new Map<string, SessionEventRecord[]>();

  private records(sessionId: string): SessionEventRecord[] {
    return this.bySession.get(sessionId) ?? [];
  }

  async append(input: SessionEventInput): Promise<SessionEventRecord> {
    const list = this.records(input.session_id);
    const previous = list.length === 0 ? 0 : (list[list.length - 1]?.seq ?? 0);
    const record: SessionEventRecord = { ...input, v: 1, seq: previous + 1 };
    list.push(record);
    this.bySession.set(input.session_id, list);
    return record;
  }

  async read(
    sessionId: string,
    opts?: { sinceSeq?: number; limit?: number },
  ): Promise<SessionEventRecord[]> {
    const since = opts?.sinceSeq ?? 0;
    const list = this.records(sessionId).filter((record) => record.seq > since);
    return opts?.limit === undefined ? list : list.slice(0, opts.limit);
  }

  async lastSeq(sessionId: string): Promise<number | undefined> {
    return this.lastPersistedSeq(sessionId);
  }

  lastPersistedSeq(sessionId: string): number | undefined {
    const list = this.records(sessionId);
    return list.length === 0 ? undefined : list[list.length - 1]?.seq;
  }

  async flush(): Promise<void> {
    // 内存实现没有写队列：append 已是同步生效。
  }
}

/** 记下每一次落盘的 SessionStore（深拷贝：内存后端是浅引用，会串）。 */
class RecordingSessionStore extends MemorySessionStore {
  readonly saves: SessionState[] = [];

  override async save(state: SessionState): Promise<void> {
    await super.save(state);
    this.saves.push(structuredClone(state));
  }
}

/** 只改 usage.prompt_tokens 的 provider 包装：其余行为沿用 MemoryLLMProvider。 */
function providerWithPromptTokens(inner: MemoryLLMProvider, multiplier: number): unknown {
  return {
    chat: async (req: { messages: Message[] }) => {
      const response = await inner.chat(req as never);
      // provider 口径 = 请求消息的本地估算 × multiplier：同量纲但整体放大，
      // 用来验证比值被真实测出来（而不是撞到 clamp 边界）并落盘。
      const promptTokens = Math.max(
        1,
        Math.round(estimateMessagesTokens(req.messages) * multiplier),
      );
      return {
        ...response,
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: 5,
          total_tokens: promptTokens + 5,
        },
      };
    },
  };
}

async function c2(): Promise<void> {
  const provider = new MemoryLLMProvider();
  provider.setResponse('第一步', { content: '好的', finish_reason: 'stop' } as never);
  const events = new MemoryEventStream();
  const log = new MemoryEventLog();
  const store = new RecordingSessionStore();
  const eu = await ExecutionUnit.create({
    provider: providerWithPromptTokens(provider, 1.48) as never,
    model: MODEL,
    contextFactory: () => new MemoryWorkingContext({ maxTokens: 200_000 }),
    events,
    limits: {},
    termination: {},
    journalFactory: createRunJournalFactory({ session: store, eventLog: log }),
    session: store,
    eventLog: log,
    systemPrompt: 'context anchor probe system prompt',
    // 重试会掩盖「同一次请求记一次锚点」的确定性，门禁要的是可重复
    retry: { maxRetries: 0 },
  });

  try {
    await eu.run('第一步', 's-real-anchor');
  } catch (error) {
    fail('C2.0', `run 抛错：${String(error)}`);
  }
  // journal 的写是异步排队的：等锚点落盘
  for (
    let tick = 0;
    tick < 200 && store.saves.every((s) => s.context_anchor === undefined);
    tick += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const saves = store.saves;
  const anchored = saves.filter((s) => s.context_anchor !== undefined);
  if (anchored.length > 0) {
    ok(`C2.1 锚点进了落盘 SessionState（${anchored.length}/${saves.length} 次保存）`);
    const anchor = anchored[anchored.length - 1]?.context_anchor;
    if (anchor === undefined) {
      fail('C2.2', '锚点为空');
    } else {
      expect('C2.2 锚点带 model', anchor.model, MODEL);
      if (anchor.ratio > CONTEXT_ANCHOR_RATIO_MIN && anchor.ratio < CONTEXT_ANCHOR_RATIO_MAX) {
        ok(`C2.3 锚点 ratio 真实落在区间内、没撞 clamp 边界（${anchor.ratio.toFixed(4)}）`);
      } else {
        fail('C2.3', `ratio 撞到 clamp 边界了：${anchor.ratio}`);
      }
      if (anchor.prompt_tokens > 0 && anchor.request_estimate > 0) {
        ok(
          'C2.3b 分子分母都记下来了（真实 ' +
            anchor.prompt_tokens +
            ' / 估算 ' +
            anchor.request_estimate +
            '）',
        );
      } else {
        fail('C2.3b', `分子或分母为 0：${JSON.stringify(anchor)}`);
      }
    }
  } else {
    fail('C2.1', `跑完一轮没写 context_anchor（${saves.length} 次保存）`);
  }

  // 模拟重启：从落盘状态重建窗口，注入锚点 ⇒ 裸估算被校正
  const persisted = await store.load('s-real-anchor');
  if (persisted === null) {
    fail('C2.4', '会话没落盘');
    return;
  }
  const anchor = persisted.context_anchor;
  if (anchor === undefined) {
    fail('C2.4', '落盘状态没有 context_anchor');
    return;
  }
  const rebuilt = new MemoryWorkingContext({ maxTokens: 200000 });
  rebuilt.setSessionId('s-real-anchor');
  for (const message of persisted.messages) rebuilt.add(message);
  const bareAfterRestart = rebuilt.tokenCount;
  rebuilt.setContextAnchor(anchor, MODEL);
  expect(
    'C2.4 重启后 tokenCount = round(裸估算 × ratio)',
    rebuilt.tokenCount,
    Math.round(bareAfterRestart * anchor.ratio),
  );
  if (rebuilt.tokenCount > bareAfterRestart) {
    ok(`C2.4b 重启后估算被抬高（${bareAfterRestart} -> ${rebuilt.tokenCount}）`);
  } else {
    fail('C2.4b', `重启后估算没有变化：${rebuilt.tokenCount}`);
  }
  // 换模型重开同一会话 ⇒ 退回裸估算（tokenizer 不同，宁可不校正）
  const switched = new MemoryWorkingContext({ maxTokens: 200000 });
  switched.setSessionId('s-real-anchor');
  for (const message of persisted.messages) switched.add(message);
  switched.setContextAnchor(anchor, 'probe-model-b');
  expect('C2.5 换模型重启 = 裸估算', switched.tokenCount, bareAfterRestart);

  // 走真实 runtime 的续接：新 EU + 空事件日志（= 重启后日志里没有 llm.response）⇒
  // realTokens 拿不到，只能靠落盘锚点，llm.request 的 estimated_tokens 应被抬高。
  const withAnchor = await runSecondTurn(persisted, persisted.context_anchor, MODEL);
  const withoutAnchor = await runSecondTurn(persisted, undefined, MODEL);
  const wrongModel = await runSecondTurn(persisted, persisted.context_anchor, 'probe-model-b');
  if (withAnchor === undefined || withoutAnchor === undefined || wrongModel === undefined) {
    fail('C2.6', '没抓到 llm.request 的 estimated_tokens');
  } else {
    if (withAnchor > withoutAnchor) {
      ok(`C2.6 重启续接：锚点把 llm.request 估算抬高（${withoutAnchor} -> ${withAnchor}）`);
    } else {
      fail('C2.6', `锚点没被 runtime 注入：${withoutAnchor} vs ${withAnchor}`);
    }
    expect('C2.7 换模型续接 = 不带锚点的裸估算', wrongModel, withoutAnchor);
  }
}

/**
 * 起一个新的 ExecutionUnit 续接同一会话，返回首个 llm.request 的 estimated_tokens。
 *
 * 空事件日志 = 「重启后日志里已经没有 llm.response」：真实用量种子拿不到，只有
 * 落盘锚点这一条路 —— 这正是要验证的回退路径。
 */
async function runSecondTurn(
  state: SessionState,
  anchor: SessionState['context_anchor'],
  model: string,
): Promise<number | undefined> {
  const provider = new MemoryLLMProvider();
  provider.setResponse('第二步', { content: '继续', finish_reason: 'stop' } as never);
  const events = new MemoryEventStream();
  const log = new MemoryEventLog();
  const store = new RecordingSessionStore();
  await store.save({ ...state, context_anchor: anchor } as SessionState);

  // `estimated_tokens` 只落在 `llm.request` 的**落盘副本**里（发布副本不带正文，
  // 也不带这个数），所以从事件日志读，而不是订阅事件流。
  const capture = async (): Promise<number | undefined> => {
    const records = await log.read(state.session_id);
    for (const record of records) {
      if (record.type !== 'llm.request') continue;
      const data = record.data as { estimated_tokens?: number } | undefined;
      if (typeof data?.estimated_tokens === 'number') return data.estimated_tokens;
    }
    return undefined;
  };

  const eu = await ExecutionUnit.create({
    provider: provider as never,
    model,
    contextFactory: () => new MemoryWorkingContext({ maxTokens: 200_000 }),
    events,
    limits: {},
    termination: {},
    journalFactory: createRunJournalFactory({ session: store, eventLog: log }),
    session: store,
    eventLog: log,
    systemPrompt: 'context anchor probe system prompt',
    retry: { maxRetries: 0 },
  });
  try {
    await eu.run('第二步', state.session_id);
  } catch (error) {
    fail('C2.6', `续接 run 抛错：${String(error)}`);
  }
  // 落盘是异步排队的：轮询到 seq 稳定或超时
  let estimate: number | undefined;
  for (let tick = 0; tick < 400; tick += 1) {
    estimate = await capture();
    if (estimate !== undefined) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return estimate;
}

// ───────────────────────── C2b 压缩提前（期望的副作用） ─────────────────────────

/**
 * 锚点把估算校准到 provider 口径后变大 ⇒ 阈值更早被越过 ⇒ 压缩提前。
 * 这是**期望行为**（压缩阈值本身没动），门禁把它钉住，免得下一个人当回退修掉。
 */
async function c2b(): Promise<void> {
  const messages: Message[] = [];
  for (let index = 0; index < 12; index += 1) {
    messages.push({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `第 ${index} 条消息：压缩阈值口径核对（CJK 与工具参数）。`,
    });
  }

  // 先量出裸估算，再把 maxTokens 卡在「裸估算 < 阈值 < 裸估算 × 3」之间：
  // 这样两侧的唯一差别就是锚点，阈值公式本身没被改动。
  const probe = new MemoryWorkingContext({ maxTokens: 1_000_000 });
  probe.setSessionId('s-measure');
  for (const message of messages) probe.add(message);
  const bare = probe.tokenCount;
  const maxTokens = Math.max(20, Math.ceil((bare / 0.85) * 1.5));

  const build = () => {
    // 配了 summarizer 时 add() 不做同步压缩，压缩时机交给 autoCompactAsync 的阈值判断。
    const ctx = new MemoryWorkingContext({
      maxTokens,
      autoCompact: true,
      summarizer: async () => '',
    });
    ctx.setSessionId('s-compact');
    for (const message of messages) ctx.add(message);
    return ctx;
  };

  const noAnchor = build();
  expect('C2b.0 构造条件：裸估算低于阈值', noAnchor.tokenCount < maxTokens * 0.85, true);
  const bareRemoved = await noAnchor.autoCompactAsync();
  expect('C2b.1 无锚点未越过阈值 ⇒ 不压缩', bareRemoved, 0);

  const anchored = build();
  anchored.setContextAnchor(anchorOf(CONTEXT_ANCHOR_RATIO_MAX), MODEL);
  expect('C2b.2a 锚点把估算抬到阈值之上', anchored.tokenCount > maxTokens * 0.85, true);
  const removed = await anchored.autoCompactAsync();
  if (removed > 0) {
    ok(`C2b.2 锚点抬高估算 ⇒ 压缩提前触发（移除 ${removed} 条）`);
  } else {
    fail('C2b.2', '锚点没有让压缩提前触发；阈值链路可能被改动');
  }
}

// ───────────────────────── C3 落盘兼容 ─────────────────────────
function baseState(sessionId: string): SessionState {
  const messages: Message[] = [{ role: 'user', content: '旧会话内容（没有锚点字段）' }];
  return {
    session_id: sessionId,
    messages,
    title: 'legacy',
    title_source: 'user',
    preview: '旧会话内容',
    created_at: 1,
    updated_at: 2,
    status: 'completed',
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    derived_upto_seq: 3,
  } as SessionState;
}

async function c3(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'vessel-anchor-'));
  try {
    // FileSessionStore 往返（带锚点）
    const fileStore = new FileSessionStore(dir);
    const withAnchor = { ...baseState('s-file'), context_anchor: anchorOf(1.48) };
    await fileStore.save(withAnchor as SessionState);
    const loaded = await fileStore.load('s-file');
    expect('C3.1 File 后端读回锚点', loaded?.context_anchor?.ratio, 1.48);
    const onDisk = readFileSync(join(dir, 's-file.json'), 'utf8');
    if (onDisk.includes('context_anchor')) ok('C3.2 File 后端把锚点写进 JSON');
    else fail('C3.2', 'JSON 里没有 context_anchor');

    // 旧快照（无该字段）照常加载
    await fileStore.save(baseState('s-old'));
    const oldLoaded = await fileStore.load('s-old');
    expect('C3.3 旧快照无字段 ⇒ 照常加载', oldLoaded?.session_id, 's-old');
    expect('C3.3b 旧快照锚点缺省', oldLoaded?.context_anchor, undefined);

    // 脏锚点（手改 / 越界）⇒ 加载时丢弃，不把会话读崩
    const dirty = JSON.parse(
      JSON.stringify({
        ...baseState('s-dirty-file'),
        context_anchor: { ratio: 99, prompt_tokens: 1, request_estimate: 1, at: 0 },
      }),
    );
    await fileStore.save(dirty as SessionState);
    const dirtyLoaded = await fileStore.load('s-dirty-file');
    expect('C3.4 越界锚点加载时丢弃', dirtyLoaded?.context_anchor, undefined);

    // SQLiteSessionStore 往返（内存库）
    const dbStore = new SQLiteSessionStore(':memory:');
    await dbStore.save({ ...baseState('s-sql'), context_anchor: anchorOf(1.48) } as SessionState);
    const sqlLoaded = await dbStore.load('s-sql');
    expect('C3.5 SQLite 后端读回锚点', sqlLoaded?.context_anchor?.ratio, 1.48);
    await dbStore.save(baseState('s-sql-old'));
    const sqlOld = await dbStore.load('s-sql-old');
    expect('C3.6 SQLite 旧行（NULL）⇒ 锚点缺省', sqlOld?.context_anchor, undefined);
    dbStore.close?.();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // 旧库补列：手建一张没有 context_anchor 的 sessions 表，打开后必须能读能写
  const dir2 = mkdtempSync(join(tmpdir(), 'vessel-anchor-mig-'));
  const dbPath = join(dir2, 'sessions.db');
  try {
    const { Database } = await import('bun:sqlite');
    const legacy = new Database(dbPath);
    legacy.run(
      'CREATE TABLE sessions (session_id TEXT PRIMARY KEY, run_id TEXT, messages TEXT NOT NULL, started_at INTEGER NOT NULL, completed_at INTEGER, status TEXT NOT NULL, usage TEXT, error TEXT, title TEXT, title_source TEXT, preview TEXT, updated_at INTEGER NOT NULL, branch TEXT, tenant_id TEXT, derived_upto_seq INTEGER)',
    );
    legacy.run(
      'INSERT INTO sessions (session_id, run_id, messages, started_at, completed_at, status, usage, error, title, title_source, preview, updated_at, branch, tenant_id, derived_upto_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        's-legacy-db',
        null,
        JSON.stringify([{ role: 'user', content: '旧库会话' }]),
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
    const row = await migrated.load('s-legacy-db');
    expect('C3.7 旧库补列后照常加载', row?.session_id, 's-legacy-db');
    expect('C3.7b 旧库锚点缺省', row?.context_anchor, undefined);
    await migrated.save({
      ...baseState('s-after-mig'),
      context_anchor: anchorOf(1.48),
    } as SessionState);
    const afterMig = await migrated.load('s-after-mig');
    expect('C3.8 补列后新锚点能落盘', afterMig?.context_anchor?.ratio, 1.48);
    migrated.close?.();
  } catch (error) {
    fail('C3.7', `旧库补列失败：${String(error)}`);
  } finally {
    // Windows 上 sqlite 句柄未完全释放时 rm 会 EBUSY：清理失败不影响判据
    try {
      rmSync(dir2, { recursive: true, force: true });
    } catch {
      // 临时目录残留可接受
    }
  }
}

// ───────────────────────── 入口 ─────────────────────────

async function main(): Promise<void> {
  c0();
  c1();
  await c2();
  await c2b();
  await c3();

  for (const line of paths) console.log(line);
  if (failures.length > 0) {
    console.error(`\nFAIL (${failures.length})`);
    for (const line of failures) console.error(`  ${line}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nOK  context anchor: ${passed} 项判据全过`);
}

await main();
