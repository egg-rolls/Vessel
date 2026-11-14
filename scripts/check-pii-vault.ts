/**
 * check-pii-vault —— PII / 密钥脱敏 + 内存句柄 vault 的零依赖探针（0.52）。
 *
 * 跑法：`bun run scripts/check-pii-vault.ts`（只 import 仓库内相对路径 + node 内建，
 * 不需要 node_modules；不碰网络、不碰真 LLM）。
 *
 * 断言对齐 0.52 的两条产品不变量（见 docs/architecture/message-invariants.md）：
 * - **可见性对等**：UI 渲染的必须包含 agent 看得到的一切；
 * - **请求 messages 只许 append**：任何一条已发出的消息都不许回改。
 * 推论（本探针重点覆盖）：脱敏发生在 **append 侧**；句柄失效只能**追加一张 env 卡**。
 *
 * 覆盖：
 *   a. 规则矩阵（各类别正例 / 反例，含整串分类的三种负例）
 *   b. 句柄稳定（同 session 同句柄 / 跨 session 不同 / TTL 过期不可解引用）
 *   c. 工具参数替换（真值回填；未知 / 过期 / 整批失效三档失败）
 *   d. 入站脱敏（工具结果里的真值在 append 时变占位符；伪造占位符被中和）
 *   e. append-only + 可见性对等（真实 run：落盘即占位符 / 请求前缀只增不改 / UI 与模型同字节）
 *   f. 死引用：追加 env 卡（列 id + 类别、不含真值），同一批只追加一次；工具侧仍然硬报错
 *   g. 审批解锁（无审批 ⇒ 拒；有审批 ⇒ 一次真值 + 审计不含真值）
 *   h. 容量降级（超限后直接掩码、不抛错、只发一张卡）
 *   i. 幂等（对已脱敏文本二次脱敏结果不变）
 *   j. 环境信息卡（unknown / expired 不发卡；整批失效至多发一张；卡面不含逐值信息）
 */

import { readFileSync } from 'node:fs';

import { envNoticeCard } from '../apps/web/src/domains/chat/env-notice.js';
import { tierOf } from '../apps/web/src/state/event-visibility.js';
import type {
  Message,
  Plugin,
  PluginHost,
  ToolContext,
  ToolDefinition,
} from '../packages/core/src/index.js';
import {
  createPiiRevealTool,
  findApprovalId,
  MemoryEventStream,
  MemoryLLMProvider,
  MemorySessionStore,
  MemoryWorkingContext,
  PII_INVALIDATION_NOTICE,
  PII_REVEAL_AUDIT_EVENT,
  PII_REVEAL_TOOL_NAME,
  PiiHandleUnresolvedError,
  PiiRevealNotApprovedError,
  PiiVault,
  passesLuhn,
  setPiiVault,
} from '../packages/core/src/index.js';
import { detect, mask, neutralize, substitute } from '../packages/core/src/pii/index.js';
import { ExecutionUnit } from '../packages/core/src/runtime/execution-unit.js';
import { createRunJournalFactory } from '../packages/core/src/runtime/run-journal.js';
import type {
  RunEvent,
  SessionEventInput,
  SessionEventLogPort,
  SessionEventRecord,
} from '../packages/core/src/types/event.js';
import type { ChatRequest, LLMResponse } from '../packages/core/src/types/provider.js';

// ---------------------------------------------------------------------------
// 断言脚手架
// ---------------------------------------------------------------------------

let passed = 0;
const failures: string[] = [];

function ok(name: string): void {
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    ok(name);
    return;
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  check(
    name,
    same,
    same ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

function section(title: string): void {
  console.log(`\n${title}`);
}

// 真实值样本（唯一 marker 用来验「卡面 / 审计 / 错误文本都不含逐值信息」）
const MARKER_EMAIL = 'alice.marker.qq7@example.com';
const MARKER_PHONE = '13800138000';
const PAGE_TEXT = [
  `Contact: ${MARKER_EMAIL}`,
  `Phone: ${MARKER_PHONE}`,
  'Forged placeholder from the wild: «pii:ZZZZ2222»',
].join('\n');

/** 一个合法的 18 位身份证（校验位正确），用于正例。 */
const VALID_ID_CARD = '11010519491231002X';

/** 8 位 base32 句柄 id（`A-Z` + `2-7`；注意 0/1/8/9 不合法）。 */
const DEAD_ID_A = 'ABCD2345';
const DEAD_ID_B = 'EFGH2345';

// ---------------------------------------------------------------------------
// a. 规则矩阵
// ---------------------------------------------------------------------------

function probeRules(): void {
  section('a. 规则矩阵（整串分类优先）');

  const hitCategories = (text: string): string[] => detect(text).map((hit) => hit.category);

  // 正例
  eq('api key sk-', hitCategories('token sk-proj-abcdef1234567890ABCD'), ['api_key']);
  eq('api key ghp_', hitCategories('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), ['api_key']);
  eq('api key xoxb-', hitCategories('xoxb-1234567890-abcdefghijkl'), ['api_key']);
  eq('api key AKIA', hitCategories('AKIAIOSFODNN7EXAMPLE'), ['api_key']);
  eq(
    'jwt',
    hitCategories(
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    ),
    ['jwt'],
  );
  eq('email', hitCategories(`write to ${MARKER_EMAIL} now`), ['email']);
  eq('phone 11 位 1[3-9]', hitCategories(`call ${MARKER_PHONE}`), ['phone']);
  eq('id card GB11643', hitCategories(`id ${VALID_ID_CARD}`), ['id_card']);
  eq('bank card Luhn (16)', hitCategories('card 4111111111111111'), ['bank_card']);
  eq('bank card 带分隔符', hitCategories('card 4111 1111 1111 1111'), ['bank_card']);
  eq(
    'private key 块',
    hitCategories('-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----'),
    ['private_key'],
  );
  eq('带密码的连接串', hitCategories('redis://default:hunter2@cache.internal:6379/0'), [
    'conn_string',
  ]);
  eq('Authorization 头', hitCategories('Authorization: Bearer abcdef123456'), ['auth_header']);
  eq('Cookie 头', hitCategories('Cookie: sid=abcdef123456'), ['auth_header']);

  // 头值规则只打「值」：头名与换行必须保留（否则两行会被粘在一起，也不幂等）
  const headerMasked = mask('GET /x\nAuthorization: Bearer abcdef123456\nHost: example.com');
  eq(
    '只打头值、保留行结构',
    headerMasked.text,
    'GET /x\nAuthorization: «pii:mask:auth_header»\nHost: example.com',
  );
  eq('头值打码幂等', mask(headerMasked.text).text, headerMasked.text);

  // 反例（这三条是「不做无边界子串匹配」的核心证据）
  eq('1794482135404 不是手机号', hitCategories('1794482135404'), []);
  eq('随机 18 位不是身份证', hitCategories('123456789012345678'), []);
  eq('裸 16 位（Luhn 不过）不是卡号', hitCategories('1234567890123456'), []);
  check(
    'Luhn 工具本身：4111111111111111 通过 / 1234567890123456 不过',
    passesLuhn('4111111111111111') && !passesLuhn('1234567890123456'),
  );
  eq(
    '普通 hash 不命中',
    hitCategories('sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'),
    [],
  );
  eq('普通 diff 行不命中', hitCategories('- return 1234567890123456 + return 42'), []);
  eq('端口号 / 版本号不命中', hitCategories('listen 8080, version 1.2.3'), []);

  // 熵启发：默认关；打开后也要求「密钥类关键字同行共现」，否则连 base64 都不打码
  const base64ish = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2wxMjM0';
  eq('熵启发默认关 ⇒ 长 base64 不打码', hitCategories(`blob ${base64ish}`), []);
  eq('熵启发打开但无关键字 ⇒ 不打码', detect(`blob ${base64ish}`, { entropy: true }).length, 0);
  eq(
    '熵启发打开 + 关键字同行 ⇒ 命中 high_entropy',
    detect(`api_token=${base64ish}`, { entropy: true }).map((hit) => hit.category),
    ['high_entropy'],
  );
}

// ---------------------------------------------------------------------------
// b. 句柄稳定 + TTL
// ---------------------------------------------------------------------------

function probeStability(): void {
  section('b. 句柄稳定 / 跨 session / TTL');

  let clock = 1_000;
  const vault = new PiiVault({ now: () => clock, ttlMs: 60_000 });

  const first = vault.protect(`mail ${MARKER_EMAIL}`, 'session-A');
  const again = vault.protect(`again ${MARKER_EMAIL}`, 'session-A');
  eq('同 session 同真值 ⇒ 同占位符', again.handles[0], first.handles[0]);
  check('占位符形状 «pii:<8 base32>»', /^«pii:[A-Z2-7]{8}»$/.test(first.handles[0] ?? ''));

  const otherSession = vault.protect(`mail ${MARKER_EMAIL}`, 'session-B');
  check('不同 session ⇒ 不同占位符', otherSession.handles[0] !== first.handles[0]);

  const both = vault.protect(`a ${MARKER_EMAIL} b ${MARKER_PHONE}`, 'session-A');
  eq('同一 session 两个真值 ⇒ 两个不同占位符', new Set(both.handles).size, 2);

  // TTL 过期 ⇒ 不可解引用（分类为 expired_handle）
  clock += 61_000;
  const expired = vault.resolve('session-A', (first.handles[0] ?? '').slice(5, 13));
  check('TTL 过期 ⇒ 不可解引用', !expired.ok);
  check('TTL 过期 ⇒ 原因归类为 expired_handle', !expired.ok && expired.reason === 'expired_handle');

  // 过期后重新 protect ⇒ 同一个 id 复活（决定性哈希），前缀因此稳定
  const revived = vault.protect(`mail ${MARKER_EMAIL}`, 'session-A');
  eq('过期后重新登记 ⇒ 同一 id（决定性哈希）', revived.handles[0], first.handles[0]);

  const unknown = vault.resolve('session-A', 'ZZZZ2222');
  check('未知 id ⇒ unknown_handle', !unknown.ok && unknown.reason === 'unknown_handle');

  const invalidated = vault.resolve('session-restarted-elsewhere', DEAD_ID_A);
  check(
    '未初始化 session ⇒ invalidated_handle',
    !invalidated.ok && invalidated.reason === 'invalidated_handle',
  );
}

// ---------------------------------------------------------------------------
// c. 工具参数替换
// ---------------------------------------------------------------------------

function probeSubstitution(): void {
  section('c. 工具参数求值前的占位符替换');

  const vault = new PiiVault({ now: () => 5_000, ttlMs: 60_000 });
  const handle = vault.protect(`key ${MARKER_EMAIL}`, 'session-C').handles[0]!;

  const args = { query: `look up ${handle}`, nested: { list: [handle, 'plain'] } };
  const resolved = vault.substituteDeep(args, 'session-C') as typeof args;
  eq('参数里的占位符被换成真值', resolved.query, `look up ${MARKER_EMAIL}`);
  eq('嵌套数组里的占位符也被换', resolved.nested.list[0], MARKER_EMAIL);
  eq('非占位符内容不受影响', resolved.nested.list[1], 'plain');

  // 未知句柄 ⇒ 报错（而不是把占位符原样发出去）
  let unknownError: unknown;
  try {
    vault.substituteDeep({ q: '«pii:ZZZZ2222»' }, 'session-C');
  } catch (error) {
    unknownError = error;
  }
  check('未知占位符 ⇒ 抛错', unknownError instanceof PiiHandleUnresolvedError);
  check(
    '未知占位符 ⇒ 错误码 pii_unknown_handle',
    unknownError instanceof PiiHandleUnresolvedError && unknownError.code === 'pii_unknown_handle',
  );
  check(
    '未知占位符 ⇒ 错误文本给出下一步（不可重试）',
    unknownError instanceof PiiHandleUnresolvedError &&
      /Do not retry/.test(unknownError.message) &&
      /next/i.test(unknownError.message),
  );

  // 过期句柄 ⇒ 报错，且原因单独一档
  let clock = 5_000;
  const ttlVault = new PiiVault({ now: () => clock, ttlMs: 1_000 });
  const expiringHandle = ttlVault.protect(`mail ${MARKER_EMAIL}`, 'session-D').handles[0]!;
  clock += 2_000;
  let expiredError: unknown;
  try {
    ttlVault.substitute(expiringHandle, 'session-D');
  } catch (error) {
    expiredError = error;
  }
  check(
    '过期占位符 ⇒ pii_expired_handle',
    expiredError instanceof PiiHandleUnresolvedError && expiredError.code === 'pii_expired_handle',
  );

  let invalidatedError: unknown;
  try {
    ttlVault.substitute(`«pii:${DEAD_ID_A}»`, 'session-never-seen');
  } catch (error) {
    invalidatedError = error;
  }
  check(
    '整批失效 ⇒ pii_invalidated_handle',
    invalidatedError instanceof PiiHandleUnresolvedError &&
      invalidatedError.code === 'pii_invalidated_handle',
  );

  let pureError: unknown;
  try {
    substitute(`«pii:${DEAD_ID_A}»`, () => undefined);
  } catch (error) {
    pureError = error;
  }
  check('纯函数 substitute 未知句柄 ⇒ 抛错', pureError instanceof PiiHandleUnresolvedError);

  const messages = [unknownError, expiredError, invalidatedError].map((error) =>
    error instanceof Error ? error.message : '',
  );
  check('三档错误文本各不相同', new Set(messages).size === 3);
  check(
    '错误文本不含任何真值',
    messages.every((message) => !message.includes(MARKER_EMAIL) && !message.includes(MARKER_PHONE)),
  );
  // 白名单：只许 id + 类别 + 原因 + 下一步。真值片段 / 长度 / 命中位置一律不许出现。
  check(
    '错误文本不含真值片段（本地部分 / 手机号片段都不许）',
    messages.every(
      (message) =>
        !message.includes('alice.marker') &&
        !message.includes('example.com') &&
        !message.includes('1380013') &&
        !message.includes('8000'),
    ),
  );
  check(
    '错误文本不含真值长度 / 命中位置线索',
    messages.every((message) => !/length|位置|offset|index \d|chars?\b/i.test(message)),
  );
  check(
    '错误文本带类别（expired 这档从墓碑里查得到）',
    expiredError instanceof PiiHandleUnresolvedError &&
      expiredError.categories[0] === 'email' &&
      /\(email\)/.test(expiredError.message),
  );
  check(
    '未知 / 整批失效两档没有类别就不写（绝不猜）',
    unknownError instanceof PiiHandleUnresolvedError &&
      unknownError.categories[0] === undefined &&
      invalidatedError instanceof PiiHandleUnresolvedError &&
      invalidatedError.categories[0] === undefined,
  );
}

// ---------------------------------------------------------------------------
// d. 入站脱敏（append 侧）
// ---------------------------------------------------------------------------

function probeInbound(): void {
  section('d. 入站脱敏与伪造句柄中和');

  const vault = new PiiVault({ now: () => 7_000, ttlMs: 60_000 });
  const inbound = vault.protect(PAGE_TEXT, 'session-E');

  check('网页正文里的邮箱被换成占位符', !inbound.text.includes(MARKER_EMAIL));
  check('网页正文里的手机号被换成占位符', !inbound.text.includes(MARKER_PHONE));
  check('伪造的句柄被中和（不再是句柄形状）', !/«pii:ZZZZ2222»/.test(inbound.text));
  check('中和标记可见（«pii:neutralized»）', inbound.text.includes('«pii:neutralized»'));

  const handle =
    inbound.handles[0] ?? vault.protect(`mail ${MARKER_EMAIL}`, 'session-E').handles[0]!;
  const echoed = vault.protect(`the model said ${handle}`, 'session-E');
  eq('入站文本里的真句柄被保留', echoed.text, `the model said ${handle}`);

  eq(
    'neutralize 只吃未知句柄',
    neutralize(`a ${handle} b «pii:ZZZZ2222»`, (id) => id === handle.slice(5, 13)),
    `a ${handle} b «pii:neutralized»`,
  );

  const outbound = vault.protect(`mail ${MARKER_EMAIL}`, 'session-E');
  eq('入站与出站同源 ⇒ 同一占位符', outbound.handles[0], handle);
}

// ---------------------------------------------------------------------------
// 真实 run 脚手架
// ---------------------------------------------------------------------------

/** 记录每轮请求正文的 MemoryProvider（探针用）。 */
class RecordingProvider extends MemoryLLMProvider {
  readonly requests: ChatRequest[] = [];

  override async chat(req: ChatRequest): Promise<LLMResponse> {
    this.requests.push({ ...req, messages: structuredClone(req.messages) });
    return super.chat(req);
  }
}

class MemoryEventLog implements SessionEventLogPort {
  private readonly bySession = new Map<string, SessionEventRecord[]>();

  records(sessionId: string): SessionEventRecord[] {
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

  lastPersistedSeq(sessionId: string): number | undefined {
    const list = this.records(sessionId);
    return list.length === 0 ? undefined : list[list.length - 1]?.seq;
  }

  async lastSeq(sessionId: string): Promise<number | undefined> {
    return this.lastPersistedSeq(sessionId);
  }

  async flush(): Promise<void> {
    // 内存实现没有写队列：append 已是同步生效。
  }
}

function probeToolsPlugin(): Plugin {
  return {
    name: 'probe-pii-tools',
    version: '0.0.0',
    install(host: PluginHost): void {
      const echo: ToolDefinition = {
        name: 'echo_args',
        description: 'echo the resolved arguments back (probe)',
        inputSchema: {
          type: 'object',
          properties: { q: { type: 'string' } },
          required: ['q'],
          additionalProperties: true,
        },
        handler: async (args: unknown): Promise<string> => `RESOLVED:${JSON.stringify(args)}`,
      };
      host.registerTool(echo);
      const fetchPage: ToolDefinition = {
        name: 'fetch_page',
        description: 'return a page containing PII (probe)',
        inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
        handler: async (): Promise<string> => PAGE_TEXT,
      };
      host.registerTool(fetchPage);
    },
  };
}

interface Stack {
  eu: ExecutionUnit;
  provider: RecordingProvider;
  store: MemorySessionStore;
  events: MemoryEventStream;
}

async function buildStack(vault?: PiiVault): Promise<Stack> {
  const provider = new RecordingProvider();
  const store = new MemorySessionStore();
  const events = new MemoryEventStream();
  const log = new MemoryEventLog();
  const eu = await ExecutionUnit.create({
    provider,
    model: 'probe-model',
    events,
    session: store,
    eventLog: log,
    journalFactory: createRunJournalFactory({ session: store, eventLog: log }),
    limits: {},
    termination: {},
    retry: { maxRetries: 0 },
    contextFactory: () => new MemoryWorkingContext({ maxTokens: 200_000 }),
    systemPrompt: 'SYSTEM-PROBE',
    permission: { default: 'allow' },
    plugins: [probeToolsPlugin()],
  });
  if (vault !== undefined) eu.setPiiVault(vault);
  return { eu, provider, store, events };
}

function toolCallResponse(name: string, args: unknown, id = 'call-1'): LLMResponse {
  return {
    content: '',
    finish_reason: 'tool_calls',
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  };
}

async function storedMessages(store: MemorySessionStore, sessionId: string): Promise<Message[]> {
  const state = await store.load(sessionId);
  return state?.messages ?? [];
}

function messageTexts(messages: readonly Message[]): string {
  return messages.map((message) => message.content ?? '').join('\n');
}

async function noticeCards(store: MemorySessionStore, sessionId: string): Promise<string[]> {
  return (await storedMessages(store, sessionId))
    .filter((message) => message.name === 'vessel:notice')
    .map((message) => message.content);
}

// ---------------------------------------------------------------------------
// e. append-only + 可见性对等（真实 run）
// ---------------------------------------------------------------------------

async function probeAppendOnlyAndParity(): Promise<void> {
  section('e. append-only + 可见性对等（真实 run）');

  const vault = new PiiVault();
  const stack = await buildStack(vault);
  const sessionId = 'session-e2e';
  stack.provider.setResponse('FETCH', toolCallResponse('fetch_page', {}));
  await stack.eu.run('FETCH the page', sessionId);

  const stored = await storedMessages(stack.store, sessionId);
  const storedText = messageTexts(stored);

  // ① 脱敏发生在 append：落盘即占位符，真值不在盘上
  check('落盘即占位符（store 里没有原文邮箱）', !storedText.includes(MARKER_EMAIL));
  check('落盘即占位符（store 里没有原文手机号）', !storedText.includes(MARKER_PHONE));
  check('store 里出现占位符', /«pii:[A-Z2-7]{8}»/.test(storedText));
  check('入站伪造句柄在 append 时被中和', !storedText.includes('«pii:ZZZZ2222»'));

  // 只跑一轮时先用第 1 轮快照比较；後面第 2/3 轮会再断言「前缀延伸」。
  const requestMessages =
    stack.provider.requests[stack.provider.requests.length - 1]?.messages ?? [];
  const storedNonSystem = stored.filter((message) => message.role !== 'system');
  const requestNonSystem = requestMessages.filter((message) => message.role !== 'system');
  eq(
    '可见性对等：请求与 store 的非 system 消息逐条逐字一致',
    requestNonSystem.map((message) => JSON.stringify(message)),
    storedNonSystem.slice(0, requestNonSystem.length).map((message) => JSON.stringify(message)),
  );

  // ③ 请求 messages 只许 append：第 N 轮必须是第 N-1 轮的**前缀延伸**
  //    （长度不减 + 逐条 JSON 完全相同）；任何中间差异都是 FAIL。
  const rounds = stack.provider.requests.map((request) => request.messages);
  check('多轮请求都发出了', rounds.length >= 2);
  let prefixOk = true;
  let prefixDetail = '';
  for (let index = 1; index < rounds.length; index += 1) {
    const previous = rounds[index - 1]!;
    const current = rounds[index]!;
    if (current.length < previous.length) {
      prefixOk = false;
      prefixDetail = `round ${index} 变短：${previous.length} → ${current.length}`;
      break;
    }
    for (let position = 0; position < previous.length; position += 1) {
      if (JSON.stringify(previous[position]) !== JSON.stringify(current[position])) {
        prefixOk = false;
        prefixDetail = `round ${index} 第 ${position} 条被改写`;
        break;
      }
    }
    if (!prefixOk) break;
  }
  check('append-only：每轮请求都是上一轮的逐条前缀延伸', prefixOk, prefixDetail);
  check(
    '至少有一轮确实只追加（长度增加）',
    rounds.some((round, index) => index > 0 && round.length > rounds[index - 1]!.length),
  );

  // ④ 脱敏发生在 append：store 里的内容再过一遍 protect 必须**幂等**（再读/再投影不变）
  eq('已落盘内容再投影幂等（不会二次改写）', vault.protect(storedText, sessionId).text, storedText);
}

// ---------------------------------------------------------------------------
// f. 死引用：追加 env 卡（不回改历史）
// ---------------------------------------------------------------------------

async function probeDeadReferenceCards(): Promise<void> {
  section('f. 死引用：追加 env 卡 / 去重 / 工具侧硬报错');

  let clock = 1_000;
  const vault = new PiiVault({ now: () => clock, ttlMs: 1_000 });
  const stack = await buildStack(vault);
  const sessionId = 'session-f';

  // 第 1 轮：把真值读进上下文（append 时变成占位符）
  stack.provider.setResponse('FETCH', toolCallResponse('fetch_page', {}));
  await stack.eu.run('FETCH the page', sessionId);
  const afterFirst = messageTexts(await storedMessages(stack.store, sessionId));
  const handles = [...afterFirst.matchAll(/«pii:[A-Z2-7]{8}»/g)].map((match) => match[0]);
  check('第 1 轮拿到了占位符', handles.length >= 1);
  const handle = handles[0]!;

  // 第 2 轮前让句柄过期：只追加一张 env 卡，历史一个字不改
  const beforeSecond = await storedMessages(stack.store, sessionId);
  clock += 5_000;
  stack.provider.setResponse('PLAIN', { content: 'noted', finish_reason: 'stop' });
  await stack.eu.run('PLAIN follow-up', sessionId);

  const afterSecond = await storedMessages(stack.store, sessionId);
  const cardsAfterSecond = (await noticeCards(stack.store, sessionId)).filter((card) =>
    card.startsWith('pii:'),
  );
  eq('死引用 ⇒ 追加一张 env 卡', cardsAfterSecond.length, 1);
  check(
    '卡面列出句柄 id',
    cardsAfterSecond[0]?.includes(handle) === true,
    cardsAfterSecond[0] ?? '(none)',
  );
  check('卡面带类别（email）', cardsAfterSecond[0]?.includes('(email)') === true);
  check(
    '卡面不含真值',
    (cardsAfterSecond[0] ?? '').length > 0 &&
      !cardsAfterSecond[0]!.includes(MARKER_EMAIL) &&
      !cardsAfterSecond[0]!.includes(MARKER_PHONE),
  );
  check(
    '卡面同时列出两个失效引用（email / phone）',
    handles.length >= 2 &&
      handles.slice(0, 2).every((item) => cardsAfterSecond[0]?.includes(item) === true) &&
      cardsAfterSecond[0]?.includes('(email)') === true &&
      cardsAfterSecond[0]?.includes('(phone)') === true,
    cardsAfterSecond[0] ?? '(none)',
  );

  // 旧消息一个字没改（append-only）
  eq(
    '历史消息逐条未改（只追加）',
    afterSecond.slice(0, beforeSecond.length).map((message) => JSON.stringify(message)),
    beforeSecond.map((message) => JSON.stringify(message)),
  );
  check('第 2 轮确实追加了新消息', afterSecond.length > beforeSecond.length);

  // durable + 两处可见：卡既在 store 里（UI 读），也出现在随后的请求里（模型读）
  const requestAfterSecond = messageTexts(
    stack.provider.requests[stack.provider.requests.length - 1]?.messages ?? [],
  );
  check(
    '失效通知 durable 且两处可见（store 与请求都含同一张卡）',
    cardsAfterSecond[0] !== undefined &&
      (await noticeCards(stack.store, sessionId)).includes(cardsAfterSecond[0]) &&
      requestAfterSecond.includes(cardsAfterSecond[0]),
  );

  // 第 3 轮：同一批 id 不再重复追加卡（去重）
  stack.provider.setResponse('PLAIN2', { content: 'again', finish_reason: 'stop' });
  await stack.eu.run('PLAIN2 follow-up', sessionId);
  const cardsAfterThird = (await noticeCards(stack.store, sessionId)).filter((card) =>
    card.startsWith('pii:'),
  );
  eq('同一批死引用只追加一次卡', cardsAfterThird.length, 1);

  // EnvCard 渲染族认得出这张卡：scope = pii，明细区带 id 与类别，摘要行不含真值
  const card = envNoticeCard(cardsAfterSecond[0] ?? '');
  eq('失效通知走 EnvCard：scope = pii', card?.scope, 'pii');
  check(
    '失效通知的明细区列出占位符与类别',
    (card?.lines ?? []).some((line) => line.text.includes(handle) && line.text.includes('(email)')),
    JSON.stringify(card?.lines ?? []),
  );
  check(
    '失效通知的明细里有下一步（重新获取 / reveal）',
    (card?.lines ?? []).some((line) => /reveal|重新获取|pii\.reveal/.test(line.text)),
  );
  check(
    '卡片全部行都不含真值',
    (card?.lines ?? []).every(
      (line) => !line.text.includes(MARKER_EMAIL) && !line.text.includes(MARKER_PHONE),
    ),
  );

  // 工具侧仍然硬报错：死句柄不许静默外发
  stack.provider.setResponse('USE', toolCallResponse('echo_args', { q: handle }, 'call-use'));
  await stack.eu.run('USE the handle', sessionId);
  const finalStored = await storedMessages(stack.store, sessionId);
  const toolResult = finalStored
    .filter((message) => message.role === 'tool')
    .map((message) => message.content ?? '')
    .join('\n');
  check('死句柄进工具参数 ⇒ 工具调用失败', toolResult.includes('PII handle cannot be resolved'));
  check('工具失败文本区分原因（expired_handle）', toolResult.includes('expired_handle'));
  check('没有把占位符原样当结果外发', !toolResult.includes('RESOLVED:'));
}

// ---------------------------------------------------------------------------
// f2. 通知去重键：批哈希 + 60s 预算（合成判定）
// ---------------------------------------------------------------------------

function probeNoticeDedup(): void {
  section('f2. 失效通知去重：批哈希（同批不重发、换批允许）+ 60s 防抖');

  let clock = 1_000;
  const vault = new PiiVault({ now: () => clock, ttlMs: 60_000 });
  const session = 'session-f2';
  const batchA = ['AAAAAAAA', 'BBBBBBBB'];
  const batchB = ['CCCCCCCC'];

  eq('同批第一次 ⇒ 该发', vault.shouldAnnounceDeadBatch(session, batchA), true);
  eq(
    '同批第二次（立刻）⇒ 不发（批哈希去重）',
    vault.shouldAnnounceDeadBatch(session, batchA),
    false,
  );
  eq(
    '同批顺序不同也算同一批（哈希按排序后集合）',
    vault.shouldAnnounceDeadBatch(session, [...batchA].reverse()),
    false,
  );
  eq(
    '换一批但还在 60s 冷却里 ⇒ 不发（防抖）',
    vault.shouldAnnounceDeadBatch(session, batchB),
    false,
  );
  clock += 60_001;
  eq(
    '换一批且已过 60s ⇒ 允许再发一张（不许静默）',
    vault.shouldAnnounceDeadBatch(session, batchB),
    true,
  );
  eq(
    '已发过的批 A 即使过了 60s 也不再重发（哈希被记住）',
    vault.shouldAnnounceDeadBatch(session, batchA),
    false,
  );
  // different session: 独立预算与独立批集合
  eq('不同 session 互不影响', vault.shouldAnnounceDeadBatch('other-session', batchA), true);
}

// ---------------------------------------------------------------------------
// g. 审批解锁
// ---------------------------------------------------------------------------

async function probeReveal(): Promise<void> {
  section('g. 审批解锁（pii.reveal）');

  const vault = new PiiVault({ now: () => 11_000, ttlMs: 60_000 });
  const handle = vault.protect(`mail ${MARKER_EMAIL}`, 'session-G').handles[0]!;
  const tool = createPiiRevealTool({ vault });
  eq('工具名', tool.name, PII_REVEAL_TOOL_NAME);
  eq(
    'checkPermission 走 ask（复用现有审批链）',
    await tool.checkPermission?.({}, { name: 'x' } as never),
    'ask',
  );

  const events = new MemoryEventStream();
  const published: RunEvent[] = [];
  const fakeCtx = (toolCallId: string): ToolContext =>
    ({
      session_id: 'session-G',
      run_id: 'run-G',
      tool_call_id: toolCallId,
      events: {
        publish: (event: RunEvent) => {
          published.push(event);
          events.publish(event);
        },
        getHistory: (runId: string) => events.getHistory(runId),
        subscribe: () => () => undefined,
      },
    }) as unknown as ToolContext;

  // 没有审批证据 ⇒ 直接拒
  let denied: unknown;
  try {
    await tool.handler({ handle }, fakeCtx('call-1'));
  } catch (error) {
    denied = error;
  }
  check('无审批 ⇒ 拒绝解锁', denied instanceof PiiRevealNotApprovedError);
  check(
    '无审批 ⇒ 错误文本提示需要人工审批',
    denied instanceof Error && /human approval/.test(denied.message),
  );

  // 有审批证据 ⇒ 返回真值一次 + 审计不含真值
  const approvalId = 'perm-req-42';
  events.publish({
    type: 'tool.permission.request',
    run_id: 'run-G',
    ts: 11_100,
    data: { requestId: approvalId, tool_call_id: 'call-2', tool_name: PII_REVEAL_TOOL_NAME },
  });
  eq('审计事件名', PII_REVEAL_AUDIT_EVENT, 'pii.reveal.audit');
  eq('审计事件已登记可见性（observe 档，聊天永不出现）', tierOf(PII_REVEAL_AUDIT_EVENT), 'observe');
  eq('句柄审计事件同族', tierOf('pii.vault.audit'), 'observe');
  eq('整批失效事件同族', tierOf('pii.handles.invalidated'), 'observe');
  eq(
    '审批 id 能从事件流里对上（按 tool_call_id）',
    findApprovalId(events, 'run-G', 'call-2'),
    approvalId,
  );

  const revealed = await tool.handler(
    { handle, reason: 'need to write it into .env' },
    fakeCtx('call-2'),
  );
  eq('有审批 ⇒ 返回真值', revealed, MARKER_EMAIL);

  const audit = published.filter((event) => event.type === PII_REVEAL_AUDIT_EVENT);
  eq('审计事件只落一条', audit.length, 1);
  const auditData = audit[0]?.data as Record<string, unknown>;
  eq('审计含 approval id', auditData.approval_id, approvalId);
  eq('审计含类别', auditData.category, 'email');
  eq('审计含会话', auditData.session, 'session-G');
  check(
    '审计不含真值',
    !JSON.stringify(auditData).includes(MARKER_EMAIL) &&
      !JSON.stringify(auditData).includes(MARKER_PHONE),
  );
}

// ---------------------------------------------------------------------------
// h. 容量降级
// ---------------------------------------------------------------------------

async function probeCapacity(): Promise<void> {
  section('h. 容量上限降级为直接掩码');

  const vault = new PiiVault({ maxHandlesPerSession: 3, now: () => 9_000, ttlMs: 60_000 });
  const emitted: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    emitted.push(vault.protect(`user${i}@example.com`, 'session-H').text);
  }
  check(
    '前 3 个得到句柄',
    /«pii:[A-Z2-7]{8}»/.test(emitted[0]!) && /«pii:[A-Z2-7]{8}»/.test(emitted[2]!),
  );
  eq('第 4 个起降级为直接掩码', emitted[3], '«pii:mask:email»');
  eq('第 6 个依然是直接掩码（不无限增长）', emitted[5], '«pii:mask:email»');
  eq('降级计数被记下来', vault.degradedCount('session-H'), 3);
  check('句柄数量不超过上限', vault.handleIds('session-H').length === 3);

  // 真实 run：容量耗尽也只在「面上的」层面发一张卡
  const tightVault = new PiiVault({ maxHandlesPerSession: 1 });
  const stack = await buildStack(tightVault);
  const sessionId = 'session-h-run';
  stack.provider.setResponse('FETCH', toolCallResponse('fetch_page', {}));
  await stack.eu.run('FETCH the page', sessionId);
  stack.provider.setResponse('PLAIN', { content: 'ok', finish_reason: 'stop' });
  await stack.eu.run('PLAIN again', sessionId);
  const cards = (await noticeCards(stack.store, sessionId)).filter((card) =>
    card.includes('handle capacity'),
  );
  eq('容量耗尽 ⇒ 只追加一张卡', cards.length, 1);
  check('容量卡不含真值', !cards[0]!.includes(MARKER_EMAIL) && !cards[0]!.includes(MARKER_PHONE));
}

// ---------------------------------------------------------------------------
// i. 幂等
// ---------------------------------------------------------------------------

function probeIdempotent(): void {
  section('i. 幂等');

  const once = mask(`mail ${MARKER_EMAIL} card 4111111111111111 key sk-proj-abcdef1234567890ABCD`);
  eq('对已脱敏文本二次脱敏结果不变', mask(once.text).text, once.text);

  const vault = new PiiVault({ now: () => 13_000, ttlMs: 60_000 });
  const first = vault.protect(PAGE_TEXT, 'session-I');
  eq(
    'vault.protect 二次投影不变（含中和标记）',
    vault.protect(first.text, 'session-I').text,
    first.text,
  );
  eq(
    '同一原文重复 protect ⇒ 同一份结果（占位符不漂移）',
    vault.protect(PAGE_TEXT, 'session-I').text,
    first.text,
  );
}

// ---------------------------------------------------------------------------
// j. 环境信息卡（逐调用 vs 面上的）
// ---------------------------------------------------------------------------

async function runToolFailureCase(
  vault: PiiVault,
  sessionId: string,
  args: unknown,
  trigger: string,
): Promise<{ cards: string[]; toolFailed: boolean }> {
  const stack = await buildStack(vault);
  stack.provider.setResponse(trigger, toolCallResponse('echo_args', args));
  await stack.eu.run(`${trigger} please`, sessionId);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const stored = await storedMessages(stack.store, sessionId);
  return {
    cards: (await noticeCards(stack.store, sessionId)).filter((card) => card.startsWith('pii:')),
    toolFailed: stored.some(
      (message) =>
        message.role === 'tool' &&
        (message.content ?? '').includes('PII handle cannot be resolved'),
    ),
  };
}

async function probeEnvCards(): Promise<void> {
  section('j. 环境信息卡（逐调用失败不发卡，整批失效至多一张）');

  // ① unknown_handle：本 session 有活句柄，但用了个不认识的 id
  const unknownVault = new PiiVault();
  unknownVault.protect(`mail ${MARKER_EMAIL}`, 'session-j1');
  const unknownCase = await runToolFailureCase(
    unknownVault,
    'session-j1',
    { q: `«pii:${DEAD_ID_A}»` },
    'CASE-UNKNOWN',
  );
  check('① unknown_handle ⇒ 工具调用失败', unknownCase.toolFailed);
  eq('① unknown_handle ⇒ 不发环境信息卡', unknownCase.cards.length, 0);

  // ② expired_handle：句柄曾经有效，TTL 已过（这句柄只在参数里出现，没进过上下文）
  let clock = 1_000;
  const expiredVault = new PiiVault({ now: () => clock, ttlMs: 1_000 });
  const expiring = expiredVault.protect(`mail ${MARKER_EMAIL}`, 'session-j2').handles[0]!;
  clock += 5_000;
  const expiredCase = await runToolFailureCase(
    expiredVault,
    'session-j2',
    { q: expiring },
    'CASE-EXPIRED',
  );
  check('② expired_handle ⇒ 工具调用失败', expiredCase.toolFailed);
  eq('② expired_handle ⇒ 也不发环境信息卡', expiredCase.cards.length, 0);

  // ③ invalidated_handle：broker 重启（新 vault 没有这个 session 的状态），连续两次
  const restartedVault = new PiiVault();
  const firstInvalidated = await runToolFailureCase(
    restartedVault,
    'session-j3',
    { q: `«pii:${DEAD_ID_A}»` },
    'CASE-INVALIDATED-1',
  );
  const secondInvalidated = await runToolFailureCase(
    restartedVault,
    'session-j3',
    { q: `«pii:${DEAD_ID_B}»` },
    'CASE-INVALIDATED-2',
  );
  check('③ 整批失效 ⇒ 工具调用失败', firstInvalidated.toolFailed && secondInvalidated.toolFailed);
  // 每个 case 是独立 stack（独立 store），卡落在第一次那轮；去重靠 vault（跨 stack 共享）
  const allCards = [...firstInvalidated.cards, ...secondInvalidated.cards];
  eq('③ 两次整批失效 ⇒ 至多一张卡', allCards.length, 1);
  eq('③ 卡面就是固定文案', allCards[0], PII_INVALIDATION_NOTICE.en);
  // 卡与工具失败**同时存在**：卡解释「为什么突然都不行了」，工具卡解释「这一次没做成」
  check(
    '③ 环境卡与逐调用工具失败并存（不互相替代）',
    firstInvalidated.toolFailed && allCards.length === 1,
  );
  // 文案 i18n 两侧都在（模型侧默认 en；zh-CN 供中文环境）
  check('③ 卡面文案有 zh-CN 版本', typeof PII_INVALIDATION_NOTICE['zh-CN'] === 'string');
  check('③ 中英两版不是同一串', PII_INVALIDATION_NOTICE['zh-CN'] !== PII_INVALIDATION_NOTICE.en);

  // ④ 卡面只讲状态：不含任何逐值信息
  check(
    '④ 卡面不含真值',
    allCards.every((card) => !card.includes(MARKER_EMAIL) && !card.includes(MARKER_PHONE)),
  );
  check(
    '④ 卡面不含原始 id 猜解线索（只列占位符）',
    allCards.every((card) => card === PII_INVALIDATION_NOTICE.en),
  );
}

// ---------------------------------------------------------------------------
// g2. append-only 的形状：源码层面没有「请求侧改写句柄」的残留
// ---------------------------------------------------------------------------

function probeNoRequestRewrite(): void {
  section('g2. 没有请求侧改写残留（append-only 铁律）');

  const read = (relative: string): string => readFileSync(relative, 'utf8');
  const core = read('packages/core/src/index.ts');
  const notice = read('packages/core/src/pii/notice.ts');
  const unit = read('packages/core/src/runtime/execution-unit.ts');
  const guard = read('packages/core/src/runtime/prompt-prefix-guard.ts');

  check('已作废的 pii-expired 标记全仓无残留', !notice.includes('pii-expired'));
  check('core 导出里没有 pii-expired 相关符号', !core.includes('pii-expired'));
  check('execution-unit 不再改写请求里的占位符', !unit.includes('markDeadHandles'));
  check(
    'PrefixChangeReason 里没有 PII 业务枚举（业务口径不该进前缀守卫）',
    !guard.includes('pii_handle_expired'),
  );
  check('失效通知只走「追加一张 env 卡」', unit.includes('renderDeadReferencesNotice'));
  check('store→请求是同一份字节（脱敏在 append 侧）', unit.includes('maskForAppend'));
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('check-pii-vault: PII 句柄 vault / append 侧脱敏 / 审批解锁');

  probeRules();
  probeStability();
  probeSubstitution();
  probeInbound();
  await probeAppendOnlyAndParity();
  await probeDeadReferenceCards();
  await probeReveal();
  await probeCapacity();
  probeIdempotent();
  probeNoticeDedup();
  probeNoRequestRewrite();
  await probeEnvCards();

  console.log(`\n${passed} 项通过，${failures.length} 项失败`);
  if (failures.length > 0) {
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
  setPiiVault(undefined);
}

await main();
