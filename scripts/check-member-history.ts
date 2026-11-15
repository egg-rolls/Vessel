#!/usr/bin/env bun

/**
 * `agent list` 只读历史视图（0.53，`includeReleases`）门禁。
 *
 * 用户的原话是「可以加一个只读历史，但是要有默认上限，可以自己控制上限内容」。起因是
 * `agent close` 之后成员从 `agent list` 彻底消失：记录永不删（`reclaimAgent` / `closeOne`
 * 只把 `state='closed'`、`membership='left'`、`presence='gone'`），而成员视图走的是
 * Team roster（只放 `membership='present'`），于是一个被释放的协作方连「存在过」都查不到。
 *
 * 这个探针钉住七件事（每一条都对应一种真实退化，且都不会报错）：
 *
 * ① **默认行为不变**：不带 `includeReleases` 时，成员视图仍然只有 present roster、绝不调用
 *    历史视图方法（用 Proxy 计数），owner 视图也仍然是原来那个数组（不是历史页）。
 *    （口径说明：成员侧本来就走 Team roster 只放 present；owner 侧的 `service.list` 在
 *    这一版**本来就**会把 closed 记录一起返回 —— 本单不动它，①锁的是「没有被历史视图顶掉」。）
 * ② **能列出来 + 默认有上限**：`includeReleases` 列出全部已释放成员，但默认只返回 20 条，
 *    并显式给 `truncated` / `total` / `limit`。
 * ③ **上限可控且封顶**：`limit=5` 生效；`limit=500` 钳到 200 且 `truncated: true`；
 *    非法（0 / 负数）退回默认 20。裁剪只发生在一处（服务层）。
 * ④ **只读**：多次读取历史视图前后，每个成员的 state / membership / presence 全等，
 *    且没有发出任何生命周期事件，快照文件字节不变。
 * ⑤ **字段可控**：`fields: ['name']` 的每条就真只有 name；未知字段名直接拒绝
 *    （静默忽略会让调用方以为拿到了自己要的东西）；`includeReleases` 不与 roster 过滤混用。
 * ⑥ **成员侧只覆盖自己的 Team**：不传 `teamId` 等于把别的 Team 的已释放成员也交出去。
 * ⑦ **释放时刻真的落盘**：`close` 之后 `closed_at` / `close_reason` 写进记录，并在
 *    重新从快照启动后仍然读得回来（旧记录没有这两个键时不补默认值）。
 *
 * 形态沿用 src/rotate-handoff.test.ts / scripts/check-rotate-accounting.ts：本 worktree
 * 没有 node_modules，`packages/agent/src/*` 按 bare specifier 引 core，所以只替掉 core 的
 * **运行时出口**，被测的是真实的 AgentService 与真实的 `agent` 工具 handler。成员记录由
 * 快照种子灌入（历史视图不该依赖活体，探针也不需要 spawn）。
 *
 * 跑法：bun run scripts/check-member-history.ts（退出码 0 = 全过，1 = 有 FAIL）
 */

import { mock } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** core 运行时替身：只列 packages/agent/src 真取用的出口，少一个就会在 import 时炸。 */
mock.module('@vessel-agent/core', () => ({
  assertTenantId: () => {},
  compactMessagesForSeed: () => [],
  LeaseExpiredError: class extends Error {},
  RunResumeError: class extends Error {},
  noopLogger: quietLogger,
  projectMessages: () => [],
  atomicWrite: async (path: string, data: string) => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data, 'utf8');
  },
  HookType: { BeforeLlm: 'before_llm', AfterLlm: 'after_llm' },
  MESSAGE_REFS_MAX: 8,
  MESSAGE_REF_PATH_MAX: 4096,
  LIMIT_WARNING_THRESHOLD: 0.9,
  PROJECTION_MODE_STRICTNESS: {
    passthrough: 0,
    placeholder: 1,
    archive_notice: 1,
    externalize: Number.POSITIVE_INFINITY,
  },
  declareProjection: (input: { mode?: string; source?: string } = {}) => ({
    mode: input.mode ?? 'placeholder',
    declaration_id: '01MOCKDECLARATION0000000000',
    source: input.source ?? 'session_created',
    policy: 'core.context_projection',
    policy_version: 1,
    params: { keepRecentTokenRatio: 0.05, keepRecentMax: 10, volumeRatio: 0.2 },
    excluded_tools: [],
    declared_at: 0,
  }),
  armProjectionDeclaration: (_sessionId: string, declaration: unknown) => declaration,
  assertProjectionModeAllowedForChild: () => {},
  knownProjectionMode: () => undefined,
  forgetProjectionDeclaration: () => {},
}));

/**
 * config 运行时替身：`tool.ts` → `team-store.ts` 取 `parseTeamPolicy` / `TeamPolicyError`。
 * 少了这条 mock，bun 解不到 bare specifier 会直接 segfault（不是报错）。
 */
mock.module('@vessel-agent/config', () => ({
  parseTeamPolicy: () => undefined,
  TeamPolicyError: class extends Error {},
}));

const { createAgentService } = await import('../packages/agent/src/service');
const { createAgentTool } = await import('../packages/agent/src/tool');
const { snapshotPath } = await import('../packages/agent/src/snapshot');

type AnyRecord = Record<string, unknown>;
type Service = ReturnType<typeof createAgentService>;

const passed: string[] = [];
const failures: string[] = [];

function check(name: string, ok: boolean, got?: string): void {
  if (ok) {
    passed.push(name);
    return;
  }
  failures.push(got === undefined ? name : name + ' | got: ' + got);
}

// ─── 场景常量 ──────────────────────────────────────────────────

const TENANT = 't1';
const OWNER = 'human';
const OWNER_SESSION = 'sess-owner';
const CALLER_SESSION = 'sess-alive';
const TEAM_A = 'team-a';
const TEAM_B = 'team-b';
/** 种子的「最后一次活动 / 释放」基准时刻 */
const SEED_TS = 1_700_000_000_000;
/** 被测服务里的 `now()`：比所有种子都新，方便断言「刚关的那个排第一」 */
const NOW = 1_800_000_000_000;
const TEAM_A_RELEASED = 200;
const TEAM_B_RELEASED = 8;
const TOTAL_RELEASED = TEAM_A_RELEASED + TEAM_B_RELEASED + 2;

const pad = (value: number): string => String(value).padStart(3, '0');

function bodies(sessionId: string, at: number): AnyRecord[] {
  return [{ body_id: sessionId, epoch: 0, created_at: SEED_TS, last_active_at: at, primary: true }];
}

/** 一条已释放成员（`state='closed'` + `membership='left'`，记录仍在） */
function seedReleased(index: number, teamId?: string): AnyRecord {
  const id = 'rel-' + pad(index);
  const sessionId = 'sess-' + id;
  const at = SEED_TS + index * 1000;
  return {
    id,
    session_id: sessionId,
    name: id,
    role: 'temporary',
    owner: OWNER,
    visibility: 'team',
    state: 'closed',
    membership: 'left',
    last_seen: at,
    closed_at: at,
    close_reason: 'closed',
    bodies: bodies(sessionId, at),
    primary_body_id: sessionId,
    ...(teamId !== undefined ? { team_id: teamId } : {}),
  };
}

/** 旧记录（0.53 之前）的 last_seen：给个显眼值，用来验证「未知释放时刻用 last_seen 兜底」 */
const LEGACY_LAST_SEEN = SEED_TS + 400_000;

/** 0.53 之前的旧记录：没有 closed_at / close_reason（历史视图不许补默认值） */
function seedLegacyReleased(index: number, teamId: string): AnyRecord {
  const { closed_at, close_reason, ...legacy } = seedReleased(index, teamId);
  return { ...legacy, last_seen: LEGACY_LAST_SEEN };
}

/** 一条在册成员（历史视图默认看不到它） */
function seedPresent(id: string, teamId: string): AnyRecord {
  const sessionId = 'sess-' + id;
  return {
    id,
    session_id: sessionId,
    name: id,
    role: 'temporary',
    owner: OWNER,
    visibility: 'team',
    state: 'idle',
    membership: 'present',
    team_id: teamId,
    last_seen: SEED_TS,
    bodies: bodies(sessionId, SEED_TS),
    primary_body_id: sessionId,
  };
}

// ─── 装配 ──────────────────────────────────────────────────────

const dataDir = await mkdtemp(join(tmpdir(), 'vessel-member-history-'));
const snapshotFile = snapshotPath(dataDir, TENANT);

const members: AnyRecord[] = [];
for (let index = 1; index <= TEAM_A_RELEASED; index += 1) {
  members.push(seedReleased(index, TEAM_A));
}
for (let index = 1; index <= TEAM_B_RELEASED; index += 1) {
  members.push(seedReleased(TEAM_A_RELEASED + index, TEAM_B));
}
// 无 Team 的已释放成员（root owner 的租户级历史应包含，成员侧不应包含）
members.push(seedReleased(TEAM_A_RELEASED + TEAM_B_RELEASED + 1));
// 旧记录（没有释放时刻 / 原因）
members.push(seedLegacyReleased(TEAM_A_RELEASED + TEAM_B_RELEASED + 2, TEAM_A));
// 在册成员：一个当成员侧调用者，一个留给 close() 验证落盘
members.push(seedPresent('alive', TEAM_A));
members.push(seedPresent('closable', TEAM_A));

await mkdir(dirname(snapshotFile), { recursive: true });
await writeFile(
  snapshotFile,
  JSON.stringify({ version: 4, updated_at: SEED_TS, members }, null, 2),
  'utf8',
);

function newService(): Service {
  return createAgentService({
    tenantId: TENANT,
    dataDir,
    runtime: {} as never,
    scheduler: {} as never,
    now: () => NOW,
    logger: quietLogger as never,
  });
}

const service = newService();
await service.list(); // 触发 ready（快照加载）

/**
 * 只读判据的基准：**任何历史视图调用之前**的全量指纹。
 *
 * 必须在这里取而不是在 ④ 里就地取：②③⑤ 已经调过历史视图，就地取会把「读取顺手改了
 * 状态」的退化吃掉（改完再比当然相等）。启动态 = 快照刚加载完的样子。
 */
function fingerprint(
  statuses: { id: string; state: string; membership?: string; presence?: string }[],
): string {
  return statuses
    .map(
      (entry) => `${entry.id}:${entry.state}:${entry.membership ?? '-'}:${entry.presence ?? '-'}`,
    )
    .sort()
    .join('|');
}

const pristine = fingerprint(await service.list({ viewer: OWNER }));

/** 记一次「历史视图被调用过」：默认 list 必须一次都不调它。 */
let releasedCalls = 0;
const spied = new Proxy(service, {
  get(target, prop, receiver) {
    if (prop === 'listReleasedMembers') {
      return async (query: unknown) => {
        releasedCalls += 1;
        return target.listReleasedMembers(query as never);
      };
    }
    const value = Reflect.get(target, prop, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  },
}) as Service;

const ownerTool = createAgentTool(spied, {
  ownerId: OWNER,
  ownerSessionId: OWNER_SESSION,
  // 成员侧默认 list 走 Team roster；这里给一个与真实 rosterFor 同口径的替身
  // （只放 present），断言的是**工具层**不会往默认输出里塞已释放成员。
  team: {
    listForCaller: async () => {
      const statuses = await spied.list({ viewer: OWNER });
      return statuses
        .filter((entry) => entry.team_id === TEAM_A && entry.membership === 'present')
        .map((entry) => ({
          agent_id: entry.id,
          name: entry.name,
          state: entry.state,
          session_id: entry.session_id,
          visibility: entry.visibility,
        }));
    },
  } as never,
});

const ownerCtx = { run_id: 'run-owner', session_id: OWNER_SESSION } as never;
const memberCtx = { run_id: 'run-member', session_id: CALLER_SESSION } as never;

/** 调工具并把输出解析成 JSON；`Error: ...` 串原样返回字符串。 */
async function callTool(
  tool: ReturnType<typeof createAgentTool>,
  args: AnyRecord,
  ctx: never,
): Promise<unknown> {
  const raw = await tool.handler?.(args, ctx);
  const text = typeof raw === 'string' ? raw : '';
  if (text.startsWith('Error:')) return text;
  return JSON.parse(text) as unknown;
}

function asPage(value: unknown): {
  members: AnyRecord[];
  limit: number;
  total: number;
  returned: number;
  truncated: boolean;
  fields: string[];
} {
  const page = value as {
    members?: AnyRecord[];
    limit?: number;
    total?: number;
    returned?: number;
    truncated?: boolean;
    fields?: string[];
  };
  return {
    members: page.members ?? [],
    limit: page.limit ?? -1,
    total: page.total ?? -1,
    returned: page.returned ?? -1,
    truncated: page.truncated === true,
    fields: page.fields ?? [],
  };
}

// ─── ① 默认行为不变（回归锁） ──────────────────────────────────

const memberDefault = await callTool(ownerTool, { action: 'list' }, memberCtx);
const memberDefaultList = Array.isArray(memberDefault) ? (memberDefault as AnyRecord[]) : [];
check(
  '① 成员默认 list 仍是数组（不是历史页）',
  Array.isArray(memberDefault),
  JSON.stringify(memberDefault).slice(0, 120),
);
check(
  '① 成员默认 list 不含已释放成员',
  memberDefaultList.length === 2 && memberDefaultList.every((entry) => entry.state !== 'closed'),
  JSON.stringify(memberDefaultList.map((entry) => entry.state)),
);
check(
  '① 成员默认 list 没有任何历史字段',
  memberDefaultList.every(
    (entry) => entry.closed_at === undefined && entry.close_reason === undefined,
  ),
);

const ownerDefault = await callTool(ownerTool, { action: 'list' }, ownerCtx);
check('① owner 默认 list 仍是数组（形状没被历史页顶掉）', Array.isArray(ownerDefault));
check(
  '① 默认 list 一次都没调用历史视图',
  releasedCalls === 0,
  'releasedCalls=' + String(releasedCalls),
);

// ─── ② includeReleases 能列出来 + 默认上限 ─────────────────────

const page = asPage(await callTool(ownerTool, { action: 'list', includeReleases: true }, ownerCtx));
check('② 默认上限 20', page.limit === 20, 'limit=' + String(page.limit));
check('② 默认只返回 20 条', page.returned === 20, 'returned=' + String(page.returned));
check('② 命中总数是全部已释放成员', page.total === TOTAL_RELEASED, 'total=' + String(page.total));
check('② 截断有显式标记', page.truncated);
check(
  '② 每条都是已释放成员',
  page.members.length > 0 && page.members.every((entry) => entry.state === 'closed'),
);
check(
  '② 默认字段集 = name/state/membership/closed_at',
  JSON.stringify([...page.fields].sort()) ===
    JSON.stringify(['closed_at', 'membership', 'name', 'state']),
  JSON.stringify(page.fields),
);
check(
  '② 每条只有默认字段集里的键',
  page.members.every((entry) => Object.keys(entry).every((key) => page.fields.includes(key))),
);
check(
  '② 排序：释放时刻新的在前（未知释放时刻用 last_seen 兜底）',
  page.members[0]?.name === 'rel-' + pad(TEAM_A_RELEASED + TEAM_B_RELEASED + 2) &&
    page.members[1]?.name === 'rel-' + pad(TEAM_A_RELEASED + TEAM_B_RELEASED + 1),
  JSON.stringify(page.members.slice(0, 2).map((entry) => entry.name)),
);

// ─── ③ 上限可控 + 封顶 200 ─────────────────────────────────────

const five = await service.listReleasedMembers({ limit: 5 });
check('③ limit=5 生效', five.returned === 5, 'returned=' + String(five.returned));
check('③ limit=5 仍标截断', five.truncated);
const clamped = await service.listReleasedMembers({ limit: 500 });
check('③ limit=500 钳到 200', clamped.limit === 200, 'limit=' + String(clamped.limit));
check('③ 钳之后正好返回 200 条', clamped.returned === 200, 'returned=' + String(clamped.returned));
check('③ 钳到上限时仍标截断', clamped.truncated, 'total=' + String(clamped.total));
const clampedViaTool = asPage(
  await callTool(ownerTool, { action: 'list', includeReleases: true, limit: 500 }, ownerCtx),
);
check(
  '③ 工具路径同样钳到 200',
  clampedViaTool.limit === 200,
  'limit=' + String(clampedViaTool.limit),
);
const zero = await service.listReleasedMembers({ limit: 0 });
check('③ 非法 limit 退回默认 20', zero.limit === 20, 'limit=' + String(zero.limit));

// ─── ④ 只读：状态与事件都不许动 ────────────────────────────────

const events: string[] = [];
const unsubscribe = service.subscribe((event) => events.push(event.type));
const snapshotBefore = await readFile(snapshotFile, 'utf8');

await service.listReleasedMembers({ limit: 200 });
await service.listReleasedMembers({ fields: ['name', 'session_id', 'cost'] });
await callTool(ownerTool, { action: 'list', includeReleases: true }, ownerCtx);
await callTool(ownerTool, { action: 'list', includeReleases: true }, memberCtx);

const after = fingerprint(await service.list({ viewer: OWNER }));
const snapshotAfter = await readFile(snapshotFile, 'utf8');
check('④ 读取前后成员状态全等（基准取启动态）', pristine === after, after.slice(0, 200));
check('④ 没有发出任何生命周期事件', events.length === 0, events.join(','));
check('④ 没有顺手写盘（快照字节不变）', snapshotBefore === snapshotAfter);

// ─── ⑤ fields 过滤 ────────────────────────────────────────────

const nameOnly = await service.listReleasedMembers({ fields: ['name'], limit: 3 });
check(
  '⑤ fields=[name] 每条只有 name',
  nameOnly.members.length === 3 &&
    nameOnly.members.every(
      (entry) => Object.keys(entry).length === 1 && typeof entry.name === 'string',
    ),
  JSON.stringify(nameOnly.members[0]),
);
check('⑤ 回显生效字段集', JSON.stringify(nameOnly.fields) === '["name"]');
const fieldsViaTool = asPage(
  await callTool(
    ownerTool,
    { action: 'list', includeReleases: true, fields: ['name', 'close_reason'], limit: 2 },
    ownerCtx,
  ),
);
check(
  '⑤ 工具路径的 fields 生效',
  fieldsViaTool.members.length === 2 &&
    fieldsViaTool.members.every(
      (entry) =>
        Object.keys(entry).length <= 2 &&
        typeof entry.name === 'string' &&
        entry.state === undefined &&
        entry.closed_at === undefined,
    ),
  JSON.stringify(fieldsViaTool.members[0]),
);
let unknownFieldError = '';
try {
  await service.listReleasedMembers({ fields: ['nope'] });
} catch (error) {
  unknownFieldError = String((error as { code?: string }).code ?? error);
}
check('⑤ 未知字段被拒（不静默忽略）', unknownFieldError === 'invalid_input', unknownFieldError);
const combo = await callTool(
  ownerTool,
  { action: 'list', includeReleases: true, state: 'closed' },
  ownerCtx,
);
check(
  '⑤ includeReleases 不跟 roster 过滤参数混用',
  typeof combo === 'string' && combo.includes('cannot be combined'),
  String(combo).slice(0, 120),
);

// ─── ⑥ 成员侧只看自己的 Team ──────────────────────────────────

/** 别的 Team / 无 Team 的已释放成员：成员侧一条都不该出现 */
const OUTSIDE_TEAM_A = new Set<string>([
  ...Array.from(
    { length: TEAM_B_RELEASED },
    (_unused, offset) => 'rel-' + pad(TEAM_A_RELEASED + offset + 1),
  ),
  'rel-' + pad(TEAM_A_RELEASED + TEAM_B_RELEASED + 1),
]);

const memberPage = asPage(
  await callTool(ownerTool, { action: 'list', includeReleases: true, limit: 5 }, memberCtx),
);
check(
  '⑥ 成员侧历史只含自己 Team（201 条，不是 210）',
  memberPage.total === TEAM_A_RELEASED + 1,
  'total=' + String(memberPage.total),
);
check(
  '⑥ 成员侧看不到别的 Team / 无 Team 的已释放成员',
  memberPage.members.every((entry) => !OUTSIDE_TEAM_A.has(String(entry.name))),
  JSON.stringify(memberPage.members.map((entry) => entry.name)),
);

// ─── ⑦ closed_at / close_reason 真能落盘 ───────────────────────

const oldRecorded = await service.listReleasedMembers({
  fields: ['name', 'closed_at', 'close_reason'],
  limit: 200,
});
const legacy = oldRecorded.members.find((entry) => entry.name === 'rel-210');
check(
  '⑦ 旧记录（无释放时刻）不补默认值',
  legacy !== undefined && legacy.closed_at === undefined && legacy.close_reason === undefined,
  JSON.stringify(legacy),
);

await service.close({ member: 'closable' });
// 反「空订阅」：close 必须真的把事件送到监听器上，④ 的「零事件」才有意义。
unsubscribe();
check(
  '⑦ 监听器确实收到 close 的生命周期事件（④ 的零事件不是空订阅）',
  events.includes('agent.closed'),
  events.join(','),
);
const justClosed = await service.listReleasedMembers({
  fields: ['name', 'state', 'membership', 'closed_at', 'close_reason'],
  limit: 1,
});
const freshest = justClosed.members[0] ?? {};
check(
  '⑦ close 写了 closed_at / close_reason',
  freshest.name === 'closable' && freshest.closed_at === NOW && freshest.close_reason === 'closed',
  JSON.stringify(freshest),
);

const reloaded = newService();
const afterReload = await reloaded.listReleasedMembers({
  fields: ['name', 'closed_at', 'close_reason'],
  limit: 1,
});
const reloadedFreshest = afterReload.members[0] ?? {};
check(
  '⑦ 重载后释放时刻仍在（真的落盘了）',
  reloadedFreshest.name === 'closable' &&
    reloadedFreshest.closed_at === NOW &&
    reloadedFreshest.close_reason === 'closed',
  JSON.stringify(reloadedFreshest),
);
const reloadedSeed = await reloaded.listReleasedMembers({
  fields: ['name', 'closed_at'],
  limit: 200,
});
const reloadedSeeded = reloadedSeed.members.find((entry) => entry.name === 'rel-190');
check(
  '⑦ 种子的 closed_at 能被读回来（parseMember 认这个键）',
  reloadedSeeded?.closed_at === SEED_TS + 190_000,
  JSON.stringify(reloadedSeeded),
);

await rm(dataDir, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(
    `FAIL check-member-history: ${String(failures.length)} / ${String(passed.length + failures.length)}`,
  );
  for (const failure of failures) console.error('  - ' + failure);
  process.exit(1);
}
console.log(`OK check-member-history passed ${String(passed.length)} / ${String(passed.length)}`);
