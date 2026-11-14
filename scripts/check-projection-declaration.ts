#!/usr/bin/env bun

/**
 * 门禁：会话级「上下文投射声明与锁」（0.53 U1，ADR-104）。
 *
 * 本单元**只做声明，不改任何运行时行为**：`ExecutionUnit` / `ContextManager` 一行
 * 不动，所有会话的行为仍等价于现在的 placeholder。所以这里的判据全部是「声明 /
 * 解析 / 锁 / 落盘」四件事，一条也不许碰窗口裁剪。
 *
 * 判据分层：
 *
 * - **C0 口径自检**：默认模式 = placeholder（用户 0.53 拍板，`passthrough` 是手动
 *   opt-in 的逃生门）；声明参数默认值与 `context-manager` 的三个常量逐字节一致
 *   （不然「声明 placeholder」和「什么都不声明」的窗口口径会悄悄分叉）。
 * - **C1 拒绝码**：未知 mode ⇒ `projection_declaration_invalid`；`externalize` ⇒
 *   `projection_mode_unavailable`（词表合法、版本不可用，两者不许混成一个码）。
 * - **C2 解析口径**：新会话缺省 ⇒ `placeholder + default`；旧会话（落盘没有该字段）
 *   ⇒ `placeholder + legacy`；声明形状坏 ⇒ 按旧会话解析但带
 *   `projection_declaration_invalid`，不许静默当好数据。
 * - **C3 不可变锁**：同 mode 重复声明幂等（保留先写的那条 `declaration_id`），
 *   不同 mode ⇒ `projection_mode_immutable`；**静默忽略视为失败**。
 * - **C4 权限收窄**：子不能放松父（父 placeholder ⇒ 子 passthrough 被拒；父
 *   passthrough ⇒ 子 placeholder 允许）。
 * - **C5 落盘往返**：File / SQLite 两种后端写→读字段等价；旧快照 / 旧库（没有列 /
 *   没有字段）照常加载并走 legacy 解析；脏数据不把会话读崩。
 * - **C6 声明 id 形状**：ULID（26 字符 Crockford base32）、非空、连续两次不同；
 *   声明对象的键集合稳定。
 *
 * 用法：bun run scripts/check-projection-declaration.ts（退出码 0 = 全过，1 = 有 FAIL）
 *
 * 建议接门禁位置（本单元**先不接** `package.json`，留给 U2 一起接）：
 *   "check:projection-declaration": "bun run scripts/check-projection-declaration.ts"
 * 并挂到 `gates` 里排在 `check:session-events` 之后（纯 core 判据，无网络 / 无 LLM）。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyDeclaredProjection,
  armProjectionDeclaration,
  assertProjectionImmutable,
  assertProjectionModeAllowedForChild,
  DEFAULT_PROJECTION_PARAMS,
  declareProjection,
  FileSessionStore,
  forgetProjectionDeclaration,
  isDeclarationId,
  isProjectionModeAllowedForChild,
  KEEP_RECENT_MAX,
  KEEP_RECENT_TOKEN_RATIO,
  knownProjectionDeclaration,
  type Message,
  newDeclarationId,
  normalizeContextProjectionAudit,
  normalizeProjectionDeclaration,
  type ProjectionDeclaration,
  ProjectionDeclarationInvalidError,
  ProjectionModeImmutableError,
  ProjectionModeNotAllowedError,
  ProjectionModeUnavailableError,
  ProjectionPolicyError,
  resetProjectionDeclarations,
  resolveProjection,
  type SessionState,
  SQLiteSessionStore,
  TOOL_RESULT_VOLUME_THRESHOLD_RATIO,
} from '../packages/core/src/index';

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

function expectTrue(where: string, value: boolean, detail = ''): void {
  if (value) ok(`${where}${detail === '' ? '' : ` (${detail})`}`);
  else fail(where, `期望为真${detail === '' ? '' : `（${detail}）`}`);
}

/**
 * 断言一次调用抛出指定码的 ProjectionPolicyError。
 *
 * 判据同时看「错误类」与「code」：类名是人读的，code 是 ADR 冻结的契约，
 * 两者不一致（比如把 externalize 的拒绝也归到 invalid）必须红。
 */
function expectThrows(
  where: string,
  code: string,
  run: () => unknown,
  errorClass?: new (...args: never[]) => ProjectionPolicyError,
): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  if (thrown === undefined) {
    fail(where, `期望抛 ${code}，实际没有抛`);
    return;
  }
  if (!(thrown instanceof ProjectionPolicyError)) {
    fail(where, `期望抛 ProjectionPolicyError，实际 ${String(thrown)}`);
    return;
  }
  if (thrown.code !== code) {
    fail(where, `期望码 ${code}，实际 ${thrown.code}（${thrown.message}）`);
    return;
  }
  if (errorClass !== undefined && !(thrown instanceof errorClass)) {
    fail(where, `期望错误类 ${errorClass.name}，实际 ${thrown.constructor.name}`);
    return;
  }
  ok(`${where} ⇒ ${code}`);
}

// ───────────────────────── C0 口径自检 ─────────────────────────

function c0(): void {
  // 1. 缺省模式：用户 0.53 拍板 —— 默认 placeholder，passthrough 是手动 opt-in。
  const byDefault = declareProjection({});
  expect('C0.1 缺省声明模式', byDefault.mode, 'placeholder');
  expect('C0.1b 缺省声明来源', byDefault.source, 'session_created');
  expect('C0.1c 缺省声明策略', byDefault.policy, 'core.context_projection');

  // 2. 默认参数必须与 context-manager 的三个常量逐字节一致，否则「显式声明
  //    placeholder」与「什么都不声明」的窗口口径会悄悄分叉。
  expect(
    'C0.2 keepRecentTokenRatio = KEEP_RECENT_TOKEN_RATIO',
    DEFAULT_PROJECTION_PARAMS.keepRecentTokenRatio,
    KEEP_RECENT_TOKEN_RATIO,
  );
  expect(
    'C0.3 keepRecentMax = KEEP_RECENT_MAX',
    DEFAULT_PROJECTION_PARAMS.keepRecentMax,
    KEEP_RECENT_MAX,
  );
  expect(
    'C0.4 volumeRatio = TOOL_RESULT_VOLUME_THRESHOLD_RATIO',
    DEFAULT_PROJECTION_PARAMS.volumeRatio,
    TOOL_RESULT_VOLUME_THRESHOLD_RATIO,
  );

  // 3. 显式 placeholder / passthrough（opt-in 逃生门）都合法。
  expect('C0.5 显式 placeholder', declareProjection({ mode: 'placeholder' }).mode, 'placeholder');
  expect('C0.6 显式 passthrough', declareProjection({ mode: 'passthrough' }).mode, 'passthrough');
  expect(
    'C0.7 显式 archive_notice',
    declareProjection({ mode: 'archive_notice' }).mode,
    'archive_notice',
  );

  // 4. 参数覆盖只覆盖给出来的那一项，其余取默认。
  const partial = declareProjection({ mode: 'placeholder', params: { keepRecentMax: 3 } });
  expect('C0.8 部分参数覆盖', partial.params.keepRecentMax, 3);
  expect(
    'C0.8b 未覆盖的参数保持默认',
    partial.params.keepRecentTokenRatio,
    DEFAULT_PROJECTION_PARAMS.keepRecentTokenRatio,
  );

  // 5. 调用方没要求时，落盘的那条声明的形状：placeholder + default。
  //    「谁都没声明」与「声明了默认值」在裁剪口径上必须是同一个东西。
  const implicitDefault = declareProjection({ source: 'default' });
  expect('C0.9 缺省声明的模式', implicitDefault.mode, 'placeholder');
  expect('C0.9b 缺省声明的来源', implicitDefault.source, 'default');
  expect(
    'C0.9c 缺省声明与显式 placeholder 的参数一致',
    implicitDefault.params,
    declareProjection({ mode: 'placeholder' }).params,
  );
  // 已经有缺省声明，再显式要求 placeholder ⇒ 幂等（不能因为「谁写的」不同就报冲突）。
  expect(
    'C0.10 缺省声明 + 显式 placeholder 幂等',
    assertProjectionImmutable(implicitDefault, declareProjection({ mode: 'placeholder' }))
      .declaration_id,
    implicitDefault.declaration_id,
  );
}

// ───────────────────────── C1 拒绝码 ─────────────────────────

function c1(): void {
  // ①  未知 mode 必须拒绝（不是「悄悄当 placeholder」）
  expectThrows(
    'C1.1 未知 mode 拒绝',
    'projection_declaration_invalid',
    () => declareProjection({ mode: 'telepathy' }),
    ProjectionDeclarationInvalidError,
  );
  expectThrows('C1.1b 大小写不同的 mode 也拒绝', 'projection_declaration_invalid', () =>
    declareProjection({ mode: 'Passthrough' }),
  );
  expectThrows('C1.1c 空串 mode 拒绝', 'projection_declaration_invalid', () =>
    declareProjection({ mode: '' }),
  );
  expectThrows('C1.1d 未知 source 拒绝', 'projection_declaration_invalid', () =>
    declareProjection({ source: 'vibes' }),
  );

  // ②  externalize：词表合法，但本版本不可用 ⇒ 独立拒绝码
  expectThrows(
    'C1.2 externalize 不可用',
    'projection_mode_unavailable',
    () => declareProjection({ mode: 'externalize' }),
    ProjectionModeUnavailableError,
  );
  // 拒绝的是「可用性」，不许退化成「未知值」（两个码的处置完全不同）
  let externalizeCode = '';
  try {
    declareProjection({ mode: 'externalize' });
  } catch (error) {
    externalizeCode = error instanceof ProjectionPolicyError ? error.code : 'not_policy_error';
  }
  if (externalizeCode === 'projection_declaration_invalid') {
    fail('C1.2b externalize 不得退化成 projection_declaration_invalid', externalizeCode);
  } else ok(`C1.2b externalize 用可用性码而非词表码 (${externalizeCode})`);

  // 3. 参数必须是有限非负数（NaN / 负数 / 字符串一律拒）
  expectThrows('C1.3 参数 NaN 拒绝', 'projection_declaration_invalid', () =>
    declareProjection({ params: { keepRecentMax: Number.NaN } }),
  );
  expectThrows('C1.4 参数负数拒绝', 'projection_declaration_invalid', () =>
    declareProjection({ params: { volumeRatio: -0.1 } }),
  );

  // 4. excluded_tools 只在 externalize 下有定义
  expectThrows('C1.5 placeholder 带 excluded_tools 拒绝', 'projection_declaration_invalid', () =>
    declareProjection({ mode: 'placeholder', excluded_tools: ['bash'] }),
  );
}

// ───────────────────────── C2 解析口径 ─────────────────────────

/** 一条旧会话的最小状态（落盘里没有 context_projection）。 */
function legacyState(sessionId: string): SessionState {
  const messages: Message[] = [{ role: 'user', content: '旧会话内容（没有投射字段）' }];
  return {
    session_id: sessionId,
    messages,
    created_at: 1,
    updated_at: 2,
    status: 'completed',
    derived_upto_seq: 1,
  } as unknown as SessionState;
}

function c2(): void {
  // ③  新会话缺省 ⇒ placeholder + default
  const fresh = resolveProjection(null);
  expect('C2.1 新会话缺省模式', fresh.mode, 'placeholder');
  expect('C2.1b 新会话缺省来源', fresh.source, 'default');
  expect('C2.1c 新会话还没锁', fresh.locked, false);
  expect('C2.1d 新会话没有声明', fresh.declaration, null);

  // ④  旧会话（有状态、无字段）⇒ placeholder + legacy，且已锁
  const legacy = resolveProjection(legacyState('s-legacy'));
  expect('C2.2 旧会话模式', legacy.mode, 'placeholder');
  expect('C2.2b 旧会话来源', legacy.source, 'legacy');
  expect('C2.2c 旧会话已锁', legacy.locked, true);
  expect('C2.2d 旧会话无错误码', legacy.error, null);

  // 5. 有声明 ⇒ 声明本身
  const declared = declareProjection({ mode: 'passthrough' });
  const resolved = resolveProjection({ session_id: 's-decl', context_projection: declared });
  expect('C2.3 声明的会话模式', resolved.mode, 'passthrough');
  expect('C2.3b 声明的会话来源', resolved.source, 'session_created');
  expect('C2.3c 声明的会话已锁', resolved.locked, true);
  expect('C2.3d 解析带出声明 id', resolved.declaration?.declaration_id, declared.declaration_id);

  // 6. 脏声明（形状坏）⇒ 按旧会话解析，但必须报出 invalid，不许静默
  const dirty = resolveProjection({
    session_id: 's-dirty',
    context_projection: { mode: 'telepathy' } as unknown as ProjectionDeclaration,
  });
  expect('C2.4 脏声明按旧会话模式解析', dirty.mode, 'placeholder');
  expect('C2.4b 脏声明按旧会话来源解析', dirty.source, 'legacy');
  expect('C2.4c 脏声明报 invalid', dirty.error, 'projection_declaration_invalid');
  expect(
    'C2.5 裸读 normalize 丢掉脏声明',
    normalizeProjectionDeclaration({ mode: 'x' }),
    undefined,
  );

  // 7. 读侧对参数缺失 / 越权版本不容忍（否则等于把坏数据当声明用）
  const droppedVersion = normalizeProjectionDeclaration({
    ...declared,
    policy_version: 2,
  });
  expect('C2.6 policy_version 不认识 ⇒ 丢弃', droppedVersion, undefined);
}

// ───────────────────────── C3 不可变锁 ─────────────────────────

function c3(): void {
  const first = declareProjection({ mode: 'placeholder' });
  const again = declareProjection({ mode: 'placeholder' });

  // ⑤  同值重复声明幂等：保留先写的那条（declaration_id 不变）
  const kept = assertProjectionImmutable(first, again);
  expect('C3.1 同值幂等保留原声明 id', kept.declaration_id, first.declaration_id);
  expect('C3.1b 同值幂等不换模式', kept.mode, 'placeholder');
  expectTrue(
    'C3.1c 两次声明 id 不同（幂等不是靠 id 相同）',
    first.declaration_id !== again.declaration_id,
  );

  // ⑥  不同 mode ⇒ projection_mode_immutable（静默忽略视为失败）
  expectThrows(
    'C3.2 改模式被拒',
    'projection_mode_immutable',
    () => assertProjectionImmutable(first, declareProjection({ mode: 'passthrough' })),
    ProjectionModeImmutableError,
  );
  // 反方向同样拒绝（放宽 / 收紧都不行：模式不是「可以再谈」的字段）
  expectThrows('C3.2b passthrough 收紧成 placeholder 也被拒', 'projection_mode_immutable', () =>
    assertProjectionImmutable(declareProjection({ mode: 'passthrough' }), first),
  );
  // 没有既有声明 ⇒ 直接接受（首次写定）
  expect(
    'C3.3 首次声明被接受',
    assertProjectionImmutable(null, first).declaration_id,
    first.declaration_id,
  );
  expect(
    'C3.3b 没有既有声明时接受更有约束的模式',
    assertProjectionImmutable(undefined, declareProjection({ mode: 'placeholder' })).mode,
    'placeholder',
  );

  // 4. 登记表（进程内）同样是不可变的：同值幂等、不同值抛
  resetProjectionDeclarations();
  armProjectionDeclaration('s-arm', first);
  expect(
    'C3.4 登记表同值幂等',
    armProjectionDeclaration('s-arm', again).declaration_id,
    first.declaration_id,
  );
  expectThrows('C3.5 登记表不同值拒绝', 'projection_mode_immutable', () =>
    armProjectionDeclaration('s-arm', declareProjection({ mode: 'passthrough' })),
  );
  expect('C3.6 登记表读回声明', knownProjectionDeclaration('s-arm')?.mode, 'placeholder');
  forgetProjectionDeclaration('s-arm');
  expect('C3.7 忘掉登记后未知', knownProjectionDeclaration('s-arm'), undefined);
  resetProjectionDeclarations();
}

// ───────────────────────── C4 权限收窄（子不能放松父） ─────────────────────────

function c4(): void {
  // ⑦ ADR-104 §8.3.1 单调收紧（2026-11-15 用户裁定）：严格度
  // passthrough < placeholder ≈ archive_notice < externalize(恒拒)。
  expectTrue(
    'C4.1 父 placeholder ⇒ 子 placeholder 允许',
    isProjectionModeAllowedForChild('placeholder', 'placeholder'),
  );
  expectTrue(
    'C4.2 父 placeholder ⇒ 子 passthrough 拒绝',
    !isProjectionModeAllowedForChild('placeholder', 'passthrough'),
  );
  // archive_notice 与 placeholder 同层（都丢掉正文，只是可不可寻址的差别）
  expectTrue(
    'C4.3 父 placeholder ⇒ 子 archive_notice 允许（同层）',
    isProjectionModeAllowedForChild('placeholder', 'archive_notice'),
  );
  expectTrue(
    'C4.4 父 passthrough ⇒ 子 placeholder 允许（收紧）',
    isProjectionModeAllowedForChild('passthrough', 'placeholder'),
  );
  expectTrue(
    'C4.5 父 passthrough ⇒ 子 passthrough 允许（同层）',
    isProjectionModeAllowedForChild('passthrough', 'passthrough'),
  );
  expectTrue(
    'C4.5b 父 passthrough ⇒ 子 archive_notice 允许（收紧）',
    isProjectionModeAllowedForChild('passthrough', 'archive_notice'),
  );
  expectTrue(
    'C4.5c 父 archive_notice ⇒ 子 passthrough 拒绝',
    !isProjectionModeAllowedForChild('archive_notice', 'passthrough'),
  );
  expectTrue(
    'C4.5d 父 archive_notice ⇒ 子 placeholder 允许（同层）',
    isProjectionModeAllowedForChild('archive_notice', 'placeholder'),
  );
  expectTrue(
    'C4.6 无父（顶层）⇒ 任意模式允许',
    isProjectionModeAllowedForChild(undefined, 'passthrough'),
  );
  expectTrue(
    'C4.7 任何父 ⇒ 子 externalize 拒绝',
    !isProjectionModeAllowedForChild('passthrough', 'externalize'),
  );

  // 抛错版本：码必须是 projection_mode_not_allowed，且带上父/子的模式
  expectThrows(
    'C4.8 父 placeholder 下的 passthrough 抛码',
    'projection_mode_not_allowed',
    () => assertProjectionModeAllowedForChild('placeholder', 'passthrough'),
    ProjectionModeNotAllowedError,
  );
  try {
    assertProjectionModeAllowedForChild('placeholder', 'passthrough');
  } catch (error) {
    if (error instanceof ProjectionModeNotAllowedError) {
      expect('C4.8b 错误里带父模式', error.parent, 'placeholder');
      expect('C4.8c 错误里带请求模式', error.requested, 'passthrough');
    } else fail('C4.8d', '期望 ProjectionModeNotAllowedError');
  }
  // 允许的组合不抛
  try {
    assertProjectionModeAllowedForChild('passthrough', 'placeholder');
    ok('C4.9 父 passthrough ⇒ 子 placeholder 不抛');
  } catch (error) {
    fail('C4.9', `不该抛：${String(error)}`);
  }
}

// ───────────────────────── C5 落盘往返 ─────────────────────────

function declaredState(sessionId: string): SessionState {
  const messages: Message[] = [{ role: 'user', content: '新会话内容' }];
  return {
    session_id: sessionId,
    messages,
    created_at: 1,
    updated_at: 2,
    status: 'completed',
    derived_upto_seq: 1,
    context_projection: declareProjection({
      mode: 'passthrough',
      declaration_id: '01J0000000000000000000000A',
      declared_at: 1_700_000_000_000,
    }),
    context_projection_audit: {
      schema_version: 1,
      declaration: null,
      steps: ['passthrough', 'placeholder'],
      reason: 'provider_unavailable',
      requested_mode: 'passthrough',
      at: 1_700_000_000_100,
    },
  } as unknown as SessionState;
}

async function c5(): Promise<void> {
  // ⑧  写 → 读 → 字段等价（File 后端）
  const dir = mkdtempSync(join(tmpdir(), 'vessel-projection-'));
  try {
    const fileStore = new FileSessionStore(dir);
    const written = declaredState('s-file');
    await fileStore.save(written);
    const loaded = await fileStore.load('s-file');
    expect(
      'C5.1 File 后端读回声明（mode）',
      loaded?.context_projection?.mode,
      written.context_projection?.mode,
    );
    expect(
      'C5.1b File 后端读回声明（declaration_id）',
      loaded?.context_projection?.declaration_id,
      written.context_projection?.declaration_id,
    );
    expect(
      'C5.1c File 后端读回参数',
      loaded?.context_projection?.params,
      written.context_projection?.params,
    );
    expect(
      'C5.1d File 后端读回审计行',
      loaded?.context_projection_audit?.reason,
      written.context_projection_audit?.reason,
    );
    expect('C5.1e 读回后解析口径一致', resolveProjection(loaded).mode, 'passthrough');

    const onDisk = readFileSync(join(dir, 's-file.json'), 'utf8');
    expectTrue('C5.2 File 后端把声明写进 JSON', onDisk.includes('context_projection'));
    expectTrue(
      'C5.2b 字段名与 ADR 一致（context_projection_audit）',
      onDisk.includes('context_projection_audit'),
    );

    // 旧快照（无字段）⇒ 照常加载 + legacy 解析
    await fileStore.save(legacyState('s-file-legacy'));
    const legacyLoaded = await fileStore.load('s-file-legacy');
    expect('C5.3 旧快照照常加载', legacyLoaded?.session_id, 's-file-legacy');
    expect('C5.3b 旧快照声明缺省', legacyLoaded?.context_projection, undefined);
    const legacyResolved = resolveProjection(legacyLoaded);
    expect('C5.3c 旧快照走 legacy', legacyResolved.source, 'legacy');
    expect('C5.3d 旧快照解析成 placeholder', legacyResolved.mode, 'placeholder');

    // 脏声明 ⇒ 丢弃，会话不被读崩（读到就跑 legacy）
    const dirtyPath = join(dir, 's-file-dirty.json');
    await fileStore.save(legacyState('s-file-dirty'));
    const dirtyRaw = JSON.parse(readFileSync(dirtyPath, 'utf8')) as Record<string, unknown>;
    dirtyRaw.context_projection = { mode: 'telepathy', declaration_id: 'nope' };
    await Bun.write(dirtyPath, JSON.stringify(dirtyRaw));
    const dirtyLoaded = await fileStore.load('s-file-dirty');
    expect('C5.4 脏声明加载时丢弃', dirtyLoaded?.context_projection, undefined);
    expect('C5.4b 脏声明会话仍能读', dirtyLoaded?.session_id, 's-file-dirty');

    // SQLite 后端往返（内存库）
    const dbStore = new SQLiteSessionStore(':memory:');
    await dbStore.save(declaredState('s-sql'));
    const sqlLoaded = await dbStore.load('s-sql');
    expect('C5.5 SQLite 后端读回声明（mode）', sqlLoaded?.context_projection?.mode, 'passthrough');
    expect(
      'C5.5b SQLite 后端读回声明（declaration_id）',
      sqlLoaded?.context_projection?.declaration_id,
      '01J0000000000000000000000A',
    );
    expect('C5.5c SQLite 后端读回审计行', sqlLoaded?.context_projection_audit?.steps, [
      'passthrough',
      'placeholder',
    ]);
    // 旧行（NULL 列）⇒ 走 legacy
    await dbStore.save(legacyState('s-sql-legacy'));
    const sqlLegacy = await dbStore.load('s-sql-legacy');
    expect('C5.6 SQLite 旧行声明缺省', sqlLegacy?.context_projection, undefined);
    expect('C5.6b SQLite 旧行走 legacy', resolveProjection(sqlLegacy).source, 'legacy');
    dbStore.close?.();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // 旧库补列：手建一张没有 context_projection 的 sessions 表，打开后必须能读能写
  const dir2 = mkdtempSync(join(tmpdir(), 'vessel-projection-mig-'));
  const dbPath = join(dir2, 'sessions.db');
  try {
    const { Database } = await import('bun:sqlite');
    const legacyDb = new Database(dbPath);
    legacyDb.run(
      'CREATE TABLE sessions (session_id TEXT PRIMARY KEY, run_id TEXT, messages TEXT NOT NULL, started_at INTEGER NOT NULL, completed_at INTEGER, status TEXT NOT NULL, usage TEXT, error TEXT, title TEXT, title_source TEXT, preview TEXT, updated_at INTEGER NOT NULL, branch TEXT, tenant_id TEXT, derived_upto_seq INTEGER)',
    );
    legacyDb.run(
      'INSERT INTO sessions (session_id, run_id, messages, started_at, completed_at, status, usage, error, title, title_source, preview, updated_at, branch, tenant_id, derived_upto_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        's-mig-legacy',
        null,
        JSON.stringify([{ role: 'user', content: '旧库会话' }]),
        1,
        2,
        'completed',
        null,
        null,
        null,
        null,
        null,
        2,
        null,
        null,
        null,
      ],
    );
    legacyDb.close();

    const migrated = new SQLiteSessionStore(dbPath);
    const oldRow = await migrated.load('s-mig-legacy');
    expect('C5.7 旧库补列后能读旧行', oldRow?.session_id, 's-mig-legacy');
    expect('C5.7b 旧库旧行声明缺省', oldRow?.context_projection, undefined);
    expect('C5.7c 旧库旧行走 legacy', resolveProjection(oldRow).source, 'legacy');
    // 补列后能写新声明
    await migrated.save(declaredState('s-mig-new'));
    const newRow = await migrated.load('s-mig-new');
    expect('C5.8 补列后能写/读声明', newRow?.context_projection?.mode, 'passthrough');
    migrated.close?.();
  } finally {
    // Windows 上 sqlite 句柄未完全释放时 rm 会 EBUSY：清理失败不影响判据
    try {
      rmSync(dir2, { recursive: true, force: true });
    } catch {
      // 临时目录残留可接受
    }
  }

  // 会话创建 ⇒ 状态写入的粘合：登记了声明之后，即使调用方重建的 state 没带该字段
  // （执行单元的 createSessionState 只带走它认识的字段），写前也必须合并回去。
  resetProjectionDeclarations();
  const armed = declareProjection({
    mode: 'placeholder',
    declaration_id: '01J0000000000000000000000B',
  });
  armProjectionDeclaration('s-carry', armed);
  const rebuilt = legacyState('s-carry');
  await applyDeclaredProjection(rebuilt, () => Promise.resolve(null));
  expect(
    'C5.9 重建的 state 写前被合并回声明',
    rebuilt.context_projection?.declaration_id,
    armed.declaration_id,
  );

  // 进程重启后登记表是空的：声明要从盘上读一次再合并回去（每会话每进程一次）。
  resetProjectionDeclarations();
  const fromDisk = legacyState('s-carry2');
  await applyDeclaredProjection(fromDisk, () =>
    Promise.resolve({ session_id: 's-carry2', context_projection: armed }),
  );
  expect(
    'C5.10 重启后从盘上种子并合并',
    fromDisk.context_projection?.declaration_id,
    armed.declaration_id,
  );
  // 盘上也没有 ⇒ 记成「探测过、没有」，之后的写入不会凭空造一条声明
  resetProjectionDeclarations();
  const none = legacyState('s-carry3');
  await applyDeclaredProjection(none, () => Promise.resolve(null));
  expect('C5.11 盘上也没有 ⇒ 不造声明', none.context_projection, undefined);
  expect('C5.11b 登记表记成「没有」', knownProjectionDeclaration('s-carry3'), null);
  resetProjectionDeclarations();

  // 旧会话（无字段）经读路径不会被写出一条假的 legacy 声明。
  const untouched = legacyState('s-untouched');
  await applyDeclaredProjection(untouched, () => Promise.resolve(null));
  expect('C5.12 旧会话写入不带声明', untouched.context_projection, undefined);
  resetProjectionDeclarations();
}

// ───────────────────────── C6 声明 id 形状 ─────────────────────────

function c6(): void {
  // ⑨  declaration_id 非空且形状稳定
  const declaration = declareProjection({ mode: 'placeholder' });
  const id = declaration.declaration_id;
  expectTrue('C6.1 declaration_id 非空', id.length > 0, id);
  expect('C6.2 declaration_id 长度 26', id.length, 26);
  expectTrue('C6.3 declaration_id 是 ULID 形状', isDeclarationId(id));
  expectTrue('C6.4 declaration_id 只含 Crockford base32', /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id));
  const firstId = newDeclarationId();
  const secondId = newDeclarationId();
  expectTrue('C6.5 连续两次声明 id 不同', firstId !== secondId, `${firstId} vs ${secondId}`);
  expectTrue('C6.6 非法 id 不被接受', !isDeclarationId('not-a-ulid'));

  // 形状稳定：键集合固定（加字段必须先改 ADR，读侧 normalize 也只认这一组）
  expect('C6.7 声明键集合', Object.keys(declaration).sort(), [
    'declaration_id',
    'declared_at',
    'excluded_tools',
    'mode',
    'params',
    'policy',
    'policy_version',
    'source',
  ]);
  expect('C6.8 参数键集合', Object.keys(declaration.params).sort(), [
    'keepRecentMax',
    'keepRecentTokenRatio',
    'volumeRatio',
  ]);
  // 序列化往返后逐字等价（落盘后读到的东西必须还是同一条声明）
  const roundTrip = normalizeProjectionDeclaration(JSON.parse(JSON.stringify(declaration)));
  expect('C6.9 序列化往返等价', roundTrip, declaration as unknown);
  // 审计行读侧形状校验：脏数据不许当审计用
  expect('C6.10 脏审计行丢弃', normalizeContextProjectionAudit({ schema_version: 9 }), undefined);
}

// ───────────────────────── 入口 ─────────────────────────

async function main(): Promise<void> {
  c0();
  c1();
  c2();
  c3();
  c4();
  await c5();
  c6();

  for (const line of paths) console.log(line);
  if (failures.length > 0) {
    console.error(`\nFAIL (${failures.length})`);
    for (const line of failures) console.error(`  ${line}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nOK  projection declaration: ${passed} 项判据全过`);
}

await main();
