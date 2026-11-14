/**
 * 工具结果清理策略的离线实测对照（0.53 主题1②/B）。
 *
 * 干什么：把本地真实会话落盘（`sessions.db`）里的 run 拉出来，逐 run 给出
 * 用量与「若按每 run 重算，会新清掉几条旧工具结果」，再对「段起点冻结（现状）」
 * 与「每 run 重算（旧行为）」两种策略做前缀可复用长度的离线模拟。
 *
 * 离线：不启 gateway、不要 API key、不联网。只读本地 sqlite + 纯函数模拟。
 *
 * ── 列来源必须分清，否则这表就是骗人的 ──────────────────────────────
 * [实测] 磁盘上真实会话里已有的事实（messages 条数、prompt_tokens 等）
 * [推算] 本脚本的模型（前缀可复用长度、cached 上下界、重建的 run 切分）
 * [合成] fixture 造的数据（`--synthetic`），不是真机流量
 *
 * 用法：
 *   bun run scripts/measure-tool-result-clear.ts            # 读本地真实会话
 *   bun run scripts/measure-tool-result-clear.ts --db=/path/to/sessions.db
 *   bun run scripts/measure-tool-result-clear.ts --max-tokens=200000
 *   bun run scripts/measure-tool-result-clear.ts --top=6     # 模拟表取前 N 个大会话
 *   bun run scripts/measure-tool-result-clear.ts --synthetic # 只用 MemoryLLMProvider fixture
 */

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ChatRequest, Message, ToolCall, Usage } from '../packages/core/src/index';
import {
  estimateMessagesTokens,
  estimateMessageTokens,
  MemoryLLMProvider,
  measureRetainedToolResultVolume,
  planClearedToolResults,
  withClearedToolResults,
} from '../packages/core/src/index';

/** 窗口预算默认值（可用 `--max-tokens=` 覆盖）：本地大会话最大 prompt ≈ 150k。 */
const DEFAULT_MAX_TOKENS = 200_000;
/** 与 core 的默认压缩阈值一致（0.85），段边界模拟必须同源，否则对照失真。 */
const COMPACT_THRESHOLD = 0.85;

interface CliOptions {
  readonly dbPath: string | null;
  readonly maxTokens: number;
  readonly top: number;
  readonly syntheticOnly: boolean;
}

function readCli(): CliOptions {
  const args = process.argv.slice(2);
  const pick = (name: string): string | null => {
    const prefix = '--' + name + '=';
    const hit = args.find((arg) => arg.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : null;
  };
  const envDb = process.env.VESSEL_SESSIONS_DB;
  const dbPath = pick('db') ?? (envDb && envDb.length > 0 ? envDb : null);
  const maxTokensRaw = Number(pick('max-tokens') ?? '');
  const topRaw = Number(pick('top') ?? '');
  return {
    dbPath,
    maxTokens:
      Number.isFinite(maxTokensRaw) && maxTokensRaw > 0 ? maxTokensRaw : DEFAULT_MAX_TOKENS,
    top: Number.isFinite(topRaw) && topRaw > 0 ? Math.floor(topRaw) : 6,
    syntheticOnly: args.includes('--synthetic'),
  };
}

/** 真实 run 的一行（sqlite `sessions` 表的一行 = 一个 run 结束时的快照）。 */
interface RealRun {
  readonly sessionId: string;
  readonly runId: string;
  readonly startedAt: number;
  readonly messages: readonly Message[];
  readonly usage: Usage;
}

function pickString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function pickNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readRole(record: Record<string, unknown>): Message['role'] | null {
  const role = record.role;
  if (role === 'system' || role === 'user' || role === 'assistant' || role === 'tool') return role;
  return null;
}

function readToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: ToolCall[] = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue;
    const call = item as Record<string, unknown>;
    const fn = call.function;
    if (fn === null || typeof fn !== 'object') continue;
    const fnRecord = fn as Record<string, unknown>;
    const id = pickString(call, 'id');
    const name = pickString(fnRecord, 'name');
    if (!id || !name) continue;
    calls.push({
      id,
      type: 'function',
      function: { name, arguments: pickString(fnRecord, 'arguments') ?? '' },
    });
  }
  return calls;
}

/** 从落盘的 messages JSON 里还出 Message[]（旧数据缺字段一律降级，不抛）。 */
function parseMessages(raw: string | null): Message[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const messages: Message[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const role = readRole(record);
    if (!role) continue;
    const message: Message = { role, content: pickString(record, 'content') ?? '' };
    const toolCallId = pickString(record, 'tool_call_id');
    if (toolCallId) message.tool_call_id = toolCallId;
    const name = pickString(record, 'name');
    if (name) message.name = name;
    const reasoning = pickString(record, 'reasoning_content');
    if (reasoning) message.reasoning_content = reasoning;
    const toolCalls = readToolCalls(record.tool_calls);
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    messages.push(message);
  }
  return messages;
}

function parseUsage(raw: string | null): Usage {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object') return {};
  const record = parsed as Record<string, unknown>;
  const usage: Usage = {};
  const prompt = pickNumber(record, 'prompt_tokens');
  if (prompt !== null) usage.prompt_tokens = prompt;
  const completion = pickNumber(record, 'completion_tokens');
  if (completion !== null) usage.completion_tokens = completion;
  const total = pickNumber(record, 'total_tokens');
  if (total !== null) usage.total_tokens = total;
  const cacheRead = pickNumber(record, 'cache_read_input_tokens');
  if (cacheRead !== null) usage.cache_read_input_tokens = cacheRead;
  return usage;
}

/** 找本地真实会话库：`--db` / 环境变量优先，否则按仓库常见落盘位置探测。 */
function resolveDbPath(explicit: string | null): string | null {
  if (explicit) {
    const candidate = resolve(explicit);
    return existsSync(candidate) ? candidate : null;
  }
  const repoRoot = resolve(import.meta.dir, '..');
  const candidates = [
    resolve(repoRoot, 'Vessel/.vessel/sessions.db'),
    resolve(repoRoot, '.vessel/sessions.db'),
    resolve(repoRoot, '../../Vessel/.vessel/sessions.db'),
    resolve(repoRoot, '../../.vessel/sessions.db'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function readRealRuns(dbPath: string): RealRun[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    // bun:sqlite 的 `.all()` 声明为 unknown[]；列名与形状由上面那条 query 固定，
    // 这里的断言与 packages/core/src/session/sqlite-backend.ts 的做法一致。
    const rows = db
      .query(
        'select session_id, run_id, messages, started_at, usage from sessions order by started_at',
      )
      .all() as Array<Record<string, unknown>>;
    const runs: RealRun[] = [];
    for (const row of rows) {
      const runId = pickString(row, 'run_id');
      if (!runId) continue;
      runs.push({
        sessionId: pickString(row, 'session_id') ?? '(unknown)',
        runId,
        startedAt: pickNumber(row, 'started_at') ?? 0,
        messages: parseMessages(pickString(row, 'messages')),
        usage: parseUsage(pickString(row, 'usage')),
      });
    }
    return runs;
  } finally {
    db.close();
  }
}

/** 一次模型调用的输入历史（`index` 从 1 起，对齐「run 序号」）。 */
interface RunFrame {
  readonly index: number;
  readonly history: readonly Message[];
}

/**
 * 把一个会话快照切成逐次模型调用的输入历史（[推算]：切分点取 assistant 消息位置）。
 *
 * 第 k 条 assistant 之前的全部消息就是第 k 次调用的 prompt —— run 结束时的快照里
 * 必然留着这些历史，所以切分只用真实消息，不造内容。
 */
function splitFrames(messages: readonly Message[]): RunFrame[] {
  const frames: RunFrame[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message.role !== 'assistant') continue;
    frames.push({ index: frames.length + 1, history: messages.slice(0, index) });
  }
  return frames;
}

interface RunCost {
  readonly index: number;
  readonly messages: number;
  readonly promptTokens: number;
  readonly clearedCount: number;
  readonly newCleared: number;
  readonly prefixTokens: number;
  readonly cachedRatio: number;
  readonly uncachedTokens: number;
}

/** 前缀可复用长度：逐条比较上一条请求与本条请求的载荷，取相同前缀的 token 数。 */
function prefixReusableTokens(previous: readonly Message[], current: readonly Message[]): number {
  const limit = Math.min(previous.length, current.length);
  let tokens = 0;
  for (let index = 0; index < limit; index += 1) {
    const previousMessage = previous[index];
    const currentMessage = current[index];
    if (!previousMessage || !currentMessage) break;
    if (JSON.stringify(previousMessage) !== JSON.stringify(currentMessage)) break;
    tokens += estimateMessageTokens(currentMessage);
  }
  return tokens;
}

/**
 * 模拟一种清理策略在整段会话上的逐 run 成本。
 *
 * `freezeAtSegmentStart = true`  = 现状：段起点算一次清除集合并冻结，段内不再变；
 * `freezeAtSegmentStart = false` = 旧行为：每个 run 都重算。
 * 段边界（token 越过 `COMPACT_THRESHOLD`）在两种策略下都按 core 的默认阈值判定，
 * 因为那是 compaction 触发，不是本主题要改的东西。
 */
function simulate(
  frames: readonly RunFrame[],
  maxTokens: number,
  freezeAtSegmentStart: boolean,
): RunCost[] {
  const costs: RunCost[] = [];
  let frozen: string[] = [];
  let previousPayload: Message[] = [];
  let previousClearedCount = 0;
  let segmentStart = true;
  for (const frame of frames) {
    const rawTokens = estimateMessagesTokens(frame.history);
    if (!freezeAtSegmentStart || segmentStart || rawTokens > maxTokens * COMPACT_THRESHOLD) {
      frozen = planClearedToolResults(frame.history, maxTokens);
      segmentStart = false;
    }
    const payload = withClearedToolResults(frame.history, frozen);
    const promptTokens = estimateMessagesTokens(payload);
    const prefixTokens =
      previousPayload.length > 0 ? prefixReusableTokens(previousPayload, payload) : 0;
    const newCleared = Math.max(0, frozen.length - previousClearedCount);
    costs.push({
      index: frame.index,
      messages: frame.history.length,
      promptTokens,
      clearedCount: frozen.length,
      newCleared,
      prefixTokens,
      cachedRatio: promptTokens > 0 ? prefixTokens / promptTokens : 0,
      uncachedTokens: promptTokens - prefixTokens,
    });
    previousPayload = payload;
    previousClearedCount = frozen.length;
  }
  return costs;
}

function formatRatio(value: number): string {
  return (value * 100).toFixed(1) + '%';
}

function tableRow(cells: readonly string[]): string {
  return '| ' + cells.join(' | ') + ' |';
}

function renderRealTable(runs: readonly RealRun[], maxTokens: number): string {
  const lines: string[] = [];
  lines.push(
    tableRow([
      'run',
      'session',
      'messages [实测]',
      'tool 条数 [实测]',
      'prompt_tokens [实测]',
      'cached_tokens [实测]',
      'cached 占比 [实测]',
      '保留体积占比 [实测输入+确定性判据]',
      '重算新增清除条数 [推算]',
    ]),
  );
  lines.push(tableRow(['---', '---', '---', '---', '---', '---', '---', '---', '---']));
  runs.forEach((run, offset) => {
    const toolCount = run.messages.filter((message) => message.role === 'tool').length;
    const measured = measureRetainedToolResultVolume(run.messages, maxTokens);
    const frames = splitFrames(run.messages);
    const recomputed = simulate(frames, maxTokens, false);
    const last = recomputed[recomputed.length - 1];
    const first = recomputed[0];
    const deltaCleared = last && first ? last.clearedCount - first.clearedCount : 0;
    const cached = run.usage.cache_read_input_tokens;
    const promptTokens = run.usage.prompt_tokens;
    lines.push(
      tableRow([
        String(offset + 1),
        run.sessionId.slice(0, 8),
        String(run.messages.length),
        String(toolCount),
        promptTokens === undefined ? '未上报 [实测缺]' : String(promptTokens),
        cached === undefined ? '未上报 [实测缺]' : String(cached),
        cached === undefined || promptTokens === undefined || promptTokens === 0
          ? 'N/A（provider 未回报 cache_read_input_tokens）'
          : formatRatio(cached / promptTokens),
        formatRatio(measured.ratio) +
          '（保留 ' +
          String(measured.retainedCount) +
          ' 条 / ' +
          String(measured.retainedTokens) +
          ' tokens）',
        String(deltaCleared),
      ]),
    );
  });
  return lines.join('\n');
}

interface SimulationSummary {
  readonly sessionId: string;
  readonly frozen: RunCost[];
  readonly recomputed: RunCost[];
}

function renderSimulationTable(summaries: readonly SimulationSummary[]): string {
  const lines: string[] = [];
  lines.push(
    tableRow([
      'session',
      'run',
      'messages [实测]',
      'prompt tokens（现状）[推算]',
      '现状：前缀可复用 [推算]',
      '现状：cached 上界 [推算]',
      '旧行为：前缀可复用 [推算]',
      '旧行为：cached 上界 [推算]',
      '旧行为：本 run 新清掉 [推算]',
    ]),
  );
  lines.push(tableRow(['---', '---', '---', '---', '---', '---', '---', '---', '---']));
  for (const summary of summaries) {
    const rows = Math.max(summary.frozen.length, summary.recomputed.length);
    for (let index = 0; index < rows; index += 1) {
      const frozen = summary.frozen[index];
      const recomputed = summary.recomputed[index];
      lines.push(
        tableRow([
          summary.sessionId.slice(0, 8),
          String(index + 1),
          String((frozen ?? recomputed)?.messages ?? 0),
          String(frozen?.promptTokens ?? 0),
          String(frozen?.prefixTokens ?? 0),
          formatRatio(frozen?.cachedRatio ?? 0),
          String(recomputed?.prefixTokens ?? 0),
          formatRatio(recomputed?.cachedRatio ?? 0),
          String(recomputed?.newCleared ?? 0),
        ]),
      );
    }
  }
  return lines.join('\n');
}

interface AggregateRatio {
  readonly frozen: number;
  readonly recomputed: number;
  readonly frozenUncached: number;
  readonly recomputedUncached: number;
}

function aggregate(summaries: readonly SimulationSummary[]): AggregateRatio {
  let frozenPrefix = 0;
  let frozenPrompt = 0;
  let recomputedPrefix = 0;
  let recomputedPrompt = 0;
  let frozenUncached = 0;
  let recomputedUncached = 0;
  for (const summary of summaries) {
    for (const cost of summary.frozen) {
      frozenPrefix += cost.prefixTokens;
      frozenPrompt += cost.promptTokens;
      frozenUncached += cost.uncachedTokens;
    }
    for (const cost of summary.recomputed) {
      recomputedPrefix += cost.prefixTokens;
      recomputedPrompt += cost.promptTokens;
      recomputedUncached += cost.uncachedTokens;
    }
  }
  return {
    frozen: frozenPrompt > 0 ? frozenPrefix / frozenPrompt : 0,
    recomputed: recomputedPrompt > 0 ? recomputedPrefix / recomputedPrompt : 0,
    frozenUncached,
    recomputedUncached,
  };
}

/**
 * [合成] 兜底：用 `MemoryLLMProvider` + 可控 fixture 造 8 个 run。
 *
 * 注意 `MemoryLLMProvider` 自带的 usage 是**固定常量**（prompt_tokens=10 或输入长度），
 * 不是前缀感知的，所以它给不了真实的 cached_tokens —— 这张表里 prompt/cached 全是
 * 本脚本按 `estimateTokens` 口径算出来的合成值，只用于演示判据形状，不是真机数据。
 */
async function runSynthetic(maxTokens: number): Promise<string> {
  // 合成 fixture 用更小的窗口把清理逼出来：8 run × 750 tokens 在 200k 窗口里根本清不到。
  const windowTokens = Math.min(maxTokens, 8_000);
  const provider = new MemoryLLMProvider();
  const history: Message[] = [
    { role: 'system', content: '合成 fixture（不是真机流量）：演示 8 轮工具结果清理形状。' },
    { role: 'user', content: '按 run 逐个读文件，每轮回一段工具结果。' },
  ];
  const frames: RunFrame[] = [];
  for (let index = 0; index < 8; index += 1) {
    const toolCallId = 'call_syn_' + String(index);
    frames.push({ index: index + 1, history: [...history] });
    const request: ChatRequest = { model: 'memory', messages: [...history] };
    await provider.chat(request);
    history.push({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: toolCallId,
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"f' + String(index) + '"}' },
        },
      ],
    });
    // 每轮工具结果 3k 字符 ≈ 750 tokens：8 轮累计远超默认 5% 保留预算，逼出清理。
    history.push({ role: 'tool', tool_call_id: toolCallId, content: 'x'.repeat(3_000) });
  }
  const frozen = simulate(frames, windowTokens, true);
  const recomputed = simulate(frames, windowTokens, false);
  const lines: string[] = [];
  lines.push(
    '### 表 3（合成数据，不是实测）8 run fixture · `MemoryLLMProvider` 驱动 · 窗口 ' +
      String(windowTokens) +
      ' tokens\n',
  );
  lines.push(
    tableRow([
      'run',
      'messages [合成]',
      'prompt tokens [合成]',
      '现状 cached 上界 [合成]',
      '旧行为 cached 上界 [合成]',
      '旧行为本 run 新清掉 [合成]',
    ]),
  );
  lines.push(tableRow(['---', '---', '---', '---', '---', '---']));
  for (let index = 0; index < frozen.length; index += 1) {
    const frozenCost = frozen[index];
    const recomputedCost = recomputed[index];
    if (!frozenCost || !recomputedCost) continue;
    lines.push(
      tableRow([
        String(index + 1),
        String(frozenCost.messages),
        String(frozenCost.promptTokens),
        formatRatio(frozenCost.cachedRatio),
        formatRatio(recomputedCost.cachedRatio),
        String(recomputedCost.newCleared),
      ]),
    );
  }
  const totals = aggregate([{ sessionId: 'synthetic', frozen, recomputed }]);
  lines.push('');
  lines.push(
    '- [合成] 现状（段起点冻结）cached 上界均值 ' +
      formatRatio(totals.frozen) +
      '，旧行为（每 run 重算）' +
      formatRatio(totals.recomputed) +
      '；旧行为每 run 平均新清掉 ' +
      (
        recomputed.reduce((sum, cost) => sum + cost.newCleared, 0) / Math.max(1, recomputed.length)
      ).toFixed(2) +
      ' 条。',
  );
  return lines.join('\n');
}

async function main(): Promise<void> {
  const cli = readCli();
  console.log('# 工具结果清理：离线实测对照（0.53 主题1②/B）');
  console.log('');
  console.log(
    '窗口预算参数 `maxTokens = ' +
      String(cli.maxTokens) +
      '`（可用 `--max-tokens=` 改）；压缩阈值 ' +
      String(COMPACT_THRESHOLD) +
      ' 与 core 默认一致。',
  );
  console.log('');

  if (!cli.syntheticOnly) {
    const dbPath = resolveDbPath(cli.dbPath);
    if (dbPath === null) {
      console.log('## 表 1/表 2 跳过：本地找不到真实会话库 [实测缺]');
      console.log('');
      console.log(
        '探测过：`--db=`、`VESSEL_SESSIONS_DB`、`<repo>/Vessel/.vessel/sessions.db`、`<repo>/.vessel/sessions.db`。',
      );
      console.log('要在真机上拿真数字：跑一次真实会话后执行');
      console.log('');
      console.log('```bash');
      console.log(
        'bun run scripts/measure-tool-result-clear.ts --db=<你的 sessions.db> --max-tokens=<窗口>',
      );
      console.log('```');
      console.log('');
    } else {
      const runs = readRealRuns(dbPath);
      console.log('数据源 [实测]：`' + dbPath + '`（' + String(runs.length) + ' 个真实 run 快照）');
      console.log('');
      console.log('## 表 1：真实 run 的用量与清理（逐列标注来源）');
      console.log('');
      console.log(renderRealTable(runs, cli.maxTokens));
      console.log('');
      const measured = runs.map((run) =>
        measureRetainedToolResultVolume(run.messages, cli.maxTokens),
      );
      const exceeded = measured.filter((item) => item.exceeds).length;
      const ratios = measured.map((item) => item.ratio);
      const maxRatio = ratios.length > 0 ? Math.max(...ratios) : 0;
      const maxRetained = measured.reduce((best, item) => Math.max(best, item.retainedTokens), 0);
      console.log('## 默认阈值在真实数据上的触发情况 [实测输入 + 确定性判据]');
      console.log('');
      console.log(
        '- 阈值 `TOOL_RESULT_VOLUME_THRESHOLD_RATIO = 0.2`：' +
          String(runs.length) +
          ' 个真实 run 里触发 **' +
          String(exceeded) +
          '** 个（0 个 ⇒ 默认配置与旧行为等价，不是靠嘴说的）。',
      );
      console.log(
        '- 实测最大保留体积占比 **' +
          formatRatio(maxRatio) +
          '**，最大单 run 保留体积 ' +
          String(maxRetained) +
          ' tokens（窗口 ' +
          String(cli.maxTokens) +
          '）。',
      );
      console.log('');
      const withTools = runs
        .filter((run) => run.messages.filter((message) => message.role === 'tool').length >= 2)
        .sort(
          (left, right) =>
            estimateMessagesTokens(right.messages) - estimateMessagesTokens(left.messages),
        )
        .slice(0, cli.top);
      const summaries: SimulationSummary[] = withTools.map((run) => ({
        sessionId: run.sessionId,
        frozen: simulate(splitFrames(run.messages), cli.maxTokens, true),
        recomputed: simulate(splitFrames(run.messages), cli.maxTokens, false),
      }));
      console.log('## 表 2：两种策略的前缀可复用长度（离线模拟，全部为推算）');
      console.log('');
      console.log('模型：provider 的 cached_tokens ≈ 上一条请求与本条请求的**最长公共前缀**长度；');
      console.log(
        '段边界（估算 prompt 越过 ' +
          String(COMPACT_THRESHOLD) +
          ' × 窗口）按 core 默认压缩阈值判定。',
      );
      console.log('');
      console.log(renderSimulationTable(summaries));
      console.log('');
      const totals = aggregate(summaries);
      console.log('## 汇总（推算）');
      console.log('');
      console.log(
        '- 现状（段起点冻结）：cached 上界 **' +
          formatRatio(totals.frozen) +
          '**，累计未缓存输入 ' +
          String(totals.frozenUncached) +
          ' tokens。',
      );
      console.log(
        '- 旧行为（每 run 重算）：cached 上界 **' +
          formatRatio(totals.recomputed) +
          '**，累计未缓存输入 ' +
          String(totals.recomputedUncached) +
          ' tokens。',
      );
      console.log(
        '- 旧行为每 run 的 prompt 更小（占位符更早生效），但未缓存部分更大：' +
          String(totals.recomputedUncached - totals.frozenUncached) +
          ' tokens 的净增量就是「每 run 重算」买到的可见代价；结论见报告。',
      );
      console.log(
        '- cached 理论下界两种策略都是 **0%**（provider 缓存全失效时前缀一条都命中不了）。',
      );
      console.log(
        '- 差额来自「每 run 重算会把占位符插到窗口**早期位置**」：前缀当场失配，' +
          '之后整段都进不了 cache；段起点冻结则只在开新段那一次失配。',
      );
      console.log('');
    }
  }

  console.log(await runSynthetic(cli.maxTokens));
  console.log('');
  console.log('## 真机取真数需要什么');
  console.log('');
  console.log(
    '- 命令：`bun run scripts/measure-tool-result-clear.ts --db=<sessions.db> --max-tokens=<窗口>`',
  );
  console.log(
    '- 字段：`sessions.usage` 里的 `prompt_tokens`（已上报）与 `cache_read_input_tokens`（本机 46 个 run 全部未上报）',
  );
  console.log(
    '- 要真 cached 占比：让 provider 适配层把 `cache_read_input_tokens` 写进 `usage` 后重跑本脚本，表 1 的 cached 两列才会从「未上报」变成实测值。',
  );
}

await main();
