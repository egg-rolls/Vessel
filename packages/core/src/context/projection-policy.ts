/**
 * 会话级「上下文投射声明与锁」（0.53 U1，ADR-104 §4.6 / §5.1 / §7.2 / §8.3）。
 *
 * 本单元**只做声明，不改任何运行时行为**：谁都不读 `mode` 去裁剪窗口
 * （那是 U2 的接线），`ExecutionUnit` / `ContextManager` 一行不动。所以这里存在的
 * 唯一效果是：会话创建时把「这个会话怎么投上下文」写成一个**不可变声明**落到
 * `SessionState.context_projection`，并在读侧给出唯一的解析口径。
 *
 * 三条硬口径：
 *
 * 1. **默认 `placeholder`**（用户 0.53 拍板，覆盖 ADR-104 默认表里的 passthrough）：
 *    WebUI 主会话 / agent 首会话 / 团队短任务一律 `placeholder`；`passthrough` 是
 *    手动 opt-in 的逃生门，只能由调用方显式要求。
 * 2. **声明不可变**：同一会话的 `mode` 一次写定，重复声明同值幂等成功，不同值
 *    **必须抛错**（`projection_mode_immutable`）—— 静默忽略会让「谁改了模式」永远查不出来。
 * 3. **子不能放松父**：见 `isProjectionModeAllowedForChild`。
 *
 * 依赖方向：本模块只 import 自己的类型，不 import `context-manager` / `execution-unit`
 * （那两个文件在本单元是冻结点）。默认参数与 `context-manager` 的
 * `KEEP_RECENT_TOKEN_RATIO` / `KEEP_RECENT_MAX` / `TOOL_RESULT_VOLUME_THRESHOLD_RATIO`
 * 逐字节一致，由 `scripts/check-projection-declaration.ts` 的 C0 对拍守住漂移。
 */

import type {
  ContextProjectionAudit,
  ContextProjectionDeclaration,
  ContextProjectionMode,
  ProjectionDeclaration,
  ProjectionDeclarationSource,
  ProjectionErrorCode,
  ProjectionMode,
  ProjectionParams,
} from '../types/projection.js';

export type {
  ContextProjectionAudit,
  ContextProjectionDeclaration,
  ContextProjectionMode,
  ProjectionDeclaration,
  ProjectionDeclarationSource,
  ProjectionErrorCode,
  ProjectionMode,
  ProjectionParams,
};

/**
 * 词表常量（ADR-104 §2.1 / §5.2 / §6.4；新增值必须先改 ADR）。
 *
 * 形状（`ProjectionMode` / `ProjectionDeclaration` …）定义在 `types/projection.ts`，
 * 这里只把词表落成运行时可用的常量并统一 re-export —— types 是叶子，不能再反向
 * 依赖 context（`check-deps` D1）。
 */
export const PROJECTION_MODES: readonly ProjectionMode[] = [
  'passthrough',
  'placeholder',
  'externalize',
  'archive_notice',
];

/** 声明来源词表（ADR-104 §5.2）。 */
export const PROJECTION_DECLARATION_SOURCES: readonly ProjectionDeclarationSource[] = [
  'session_created',
  'default',
  'legacy',
  'rotate',
  'inherited',
];

/** 声明所属策略 ID（ADR-104 §2.1，唯一取值）。 */
export const PROJECTION_POLICY_ID = 'core.context_projection';

/** 声明格式版本（ADR-104 §4.6；读侧只认这一个值）。 */
export const PROJECTION_POLICY_VERSION = 1;

/** 拒绝码（ADR-104 §6.4；改名必须先改 ADR，且门禁会逐码断言）。 */
export const PROJECTION_ERROR_CODES: readonly ProjectionErrorCode[] = [
  'projection_declaration_invalid',
  'projection_mode_unavailable',
  'projection_mode_immutable',
  'projection_mode_not_allowed',
];

/**
 * 声明参数的默认值（ADR-104 §4.6）。
 *
 * 与 `context-manager.ts` 的 `KEEP_RECENT_TOKEN_RATIO` / `KEEP_RECENT_MAX` /
 * `TOOL_RESULT_VOLUME_THRESHOLD_RATIO` 逐字节一致，由 `check-projection-declaration`
 * 的 C0 对拍守漂移 —— 本单元不引入新配置键，也不改任何裁剪行为。
 */
export const DEFAULT_PROJECTION_PARAMS: ProjectionParams = {
  keepRecentTokenRatio: 0.05,
  keepRecentMax: 10,
  volumeRatio: 0.2,
};

/** 投射声明 / 锁相关的领域错误。 */
export class ProjectionPolicyError extends Error {
  /** 拒绝码（ADR-104 §6.4）。 */
  readonly code: ProjectionErrorCode;

  constructor(code: ProjectionErrorCode, message: string) {
    super(message);
    this.name = 'ProjectionPolicyError';
    this.code = code;
  }
}

/** 声明本身不合法（未知模式、未知来源、参数不是有限数……）。 */
export class ProjectionDeclarationInvalidError extends ProjectionPolicyError {
  constructor(message: string) {
    super('projection_declaration_invalid', message);
    this.name = 'ProjectionDeclarationInvalidError';
  }
}

/** `externalize` 在本版本声明期即不可用（ADR-104 §2.3c）。 */
export class ProjectionModeUnavailableError extends ProjectionPolicyError {
  /** 被拒绝的模式。 */
  readonly mode: string;

  constructor(mode: string, message: string) {
    super('projection_mode_unavailable', message);
    this.name = 'ProjectionModeUnavailableError';
    this.mode = mode;
  }
}

/** 同一会话的投射模式已经写定，不允许改成别的值（ADR-104 §7.2）。 */
export class ProjectionModeImmutableError extends ProjectionPolicyError {
  /** 已落盘的模式。 */
  readonly existing: ProjectionMode;
  /** 请求的模式。 */
  readonly incoming: ProjectionMode;

  constructor(existing: ProjectionMode, incoming: ProjectionMode, message: string) {
    super('projection_mode_immutable', message);
    this.name = 'ProjectionModeImmutableError';
    this.existing = existing;
    this.incoming = incoming;
  }
}

/** 子会话请求的模式比父会话更松（违反 §8.3.1 单调收紧）。 */
export class ProjectionModeNotAllowedError extends ProjectionPolicyError {
  /** 父会话的模式。 */
  readonly parent: ProjectionMode;
  /** 子会话请求的模式。 */
  readonly requested: ProjectionMode;

  constructor(parent: ProjectionMode, requested: ProjectionMode, message: string) {
    super('projection_mode_not_allowed', message);
    this.name = 'ProjectionModeNotAllowedError';
    this.parent = parent;
    this.requested = requested;
  }
}

// ───────────────────────── declaration_id（ULID） ─────────────────────────

/** ULID 的 Crockford base32 字母表（去掉 I/L/O/U）。 */
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 一次声明 id 生成用掉的毫秒（用于同毫秒内递增序号）。 */
let lastDeclarationMs = 0;

/** 同毫秒内已生成的 id 数（保证同一毫秒内也不撞）。 */
let declarationSeq = 0;

/** 把整数编码成 n 位 Crockford base32。 */
function encodeBase32(value: number, length: number): string {
  let rest = Math.max(0, Math.trunc(value));
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out = (ULID_ALPHABET[rest % 32] ?? '0') + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

/**
 * 生成一个 ULID 形状的声明 id：26 字符，10 字符毫秒时间 + 16 字符随机/序号。
 *
 * 只作幂等键与日志凭据，不需要密码学强度（不参与鉴权），所以不引 `node:crypto` ——
 * core 也会被打进 Web 侧产物，多一个 node 内建就多一处 bundler 坑。
 * 后半段前 12 字符取 `Math.random()`，末 4 字符写上同毫秒序号，
 * 保证「同一毫秒连续声明」也一定不同。
 */
export function newDeclarationId(now: number = Date.now()): string {
  if (now === lastDeclarationMs) declarationSeq += 1;
  else {
    lastDeclarationMs = now;
    declarationSeq = 0;
  }
  let randomPart = '';
  for (let i = 0; i < 12; i += 1) {
    randomPart += ULID_ALPHABET[Math.floor(Math.random() * 32)] ?? '0';
  }
  return encodeBase32(now, 10) + randomPart + encodeBase32(declarationSeq, 4);
}

/** 判断一个字符串是否是合法声明 id（26 字符、Crockford base32 字母表）。 */
export function isDeclarationId(value: string): boolean {
  if (value.length !== 26) return false;
  for (const char of value) {
    if (!ULID_ALPHABET.includes(char)) return false;
  }
  return true;
}

// ───────────────────────── 词表校验 ─────────────────────────

/** 是否是已知投射模式。 */
export function isProjectionMode(value: unknown): value is ProjectionMode {
  return typeof value === 'string' && (PROJECTION_MODES as readonly string[]).includes(value);
}

/** 是否是已知声明来源。 */
export function isProjectionDeclarationSource(
  value: unknown,
): value is ProjectionDeclarationSource {
  return (
    typeof value === 'string' &&
    (PROJECTION_DECLARATION_SOURCES as readonly string[]).includes(value)
  );
}

/**
 * 校验并返回一个投射模式；未知值立刻抛 `projection_declaration_invalid`。
 *
 * `externalize` 是**词表合法但本版本不可用**：抛 `projection_mode_unavailable`
 * （ADR-104 §2.3c —— 会话创建期即拒绝，不留「落盘了但永远降级」的状态）。
 */
export function resolveProjectionMode(value: unknown): ProjectionMode {
  if (!isProjectionMode(value)) {
    throw new ProjectionDeclarationInvalidError(
      '未知的投射模式：' +
        describeValue(value) +
        '（合法值：' +
        PROJECTION_MODES.join(' / ') +
        '）',
    );
  }
  if (value === 'externalize') {
    throw new ProjectionModeUnavailableError(
      value,
      '投射模式 externalize 在本版本不可用（destination store 未就绪）',
    );
  }
  return value;
}

/** 把任意输入压成一句人类可读的描述（错误信息用，不参与判据）。 */
function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `「${value}」`;
  return typeof value;
}

// ───────────────────────── 参数 ─────────────────────────

/** 校验单个参数取值：必须是有限数，且不小于 0。 */
function readParamNumber(name: string, value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ProjectionDeclarationInvalidError(
      `声明参数 ${name} 必须是非负有限数，收到：${describeValue(value)}`,
    );
  }
  return value;
}

/**
 * 合并声明参数：缺省取 `DEFAULT_PROJECTION_PARAMS`，显式给出则逐字沿用。
 *
 * 不做范围裁剪（那会在用户不知情时改掉他写下的值），只拒非有限数 / 负数。
 */
export function normalizeProjectionParams(
  value?: Partial<ProjectionParams> | null,
): ProjectionParams {
  const ratio = readParamNumber('keepRecentTokenRatio', value?.keepRecentTokenRatio);
  const max = readParamNumber('keepRecentMax', value?.keepRecentMax);
  const volume = readParamNumber('volumeRatio', value?.volumeRatio);
  return {
    keepRecentTokenRatio: ratio ?? DEFAULT_PROJECTION_PARAMS.keepRecentTokenRatio,
    keepRecentMax: max ?? DEFAULT_PROJECTION_PARAMS.keepRecentMax,
    volumeRatio: volume ?? DEFAULT_PROJECTION_PARAMS.volumeRatio,
  };
}

// ───────────────────────── 声明 ─────────────────────────

/** `declareProjection` 的输入。 */
export interface DeclareProjectionInput {
  /**
   * 请求的投射模式。
   *
   * 类型写成 `string` 是刻意的：入口拿到的永远是 RPC 的原始值，
   * 校验必须发生在运行时（未知值 → `projection_declaration_invalid`）。
   * 省略 ⇒ 默认 `placeholder`（用户 0.53 口径）。
   */
  readonly mode?: string | undefined;
  /** 声明来源，缺省 `session_created`。 */
  readonly source?: string | undefined;
  /** 参数覆盖项，缺省取 `DEFAULT_PROJECTION_PARAMS`。 */
  readonly params?: Partial<ProjectionParams> | undefined;
  /** 显式指定声明 id（测试与幂等重放用；缺省生成 ULID）。 */
  readonly declaration_id?: string | undefined;
  /** 显式指定声明时刻（ms；缺省当前时间）。 */
  readonly declared_at?: number | undefined;
  /** 不投射的工具（只有 `externalize` 会用到，其余模式必须为空）。 */
  readonly excluded_tools?: readonly string[] | undefined;
}

/**
 * 声明一个会话的上下文投射模式。
 *
 * 这一步只**构造并校验**声明，不落盘、不改运行时行为；落盘由会话创建路径
 * （`armProjectionDeclaration` + 状态写入）完成。
 *
 * 拒绝码：
 * - 未知 `mode` / 未知 `source` / 参数不是有限数 ⇒ `projection_declaration_invalid`
 * - `mode === 'externalize'` ⇒ `projection_mode_unavailable`
 */
export function declareProjection(input: DeclareProjectionInput = {}): ProjectionDeclaration {
  const mode = resolveProjectionMode(input.mode ?? 'placeholder');
  const source = input.source ?? 'session_created';
  if (!isProjectionDeclarationSource(source)) {
    throw new ProjectionDeclarationInvalidError(
      '未知的声明来源：' +
        describeValue(source) +
        '（合法值：' +
        PROJECTION_DECLARATION_SOURCES.join(' / ') +
        '）',
    );
  }
  const declarationId = input.declaration_id ?? newDeclarationId(input.declared_at);
  if (!isDeclarationId(declarationId)) {
    throw new ProjectionDeclarationInvalidError(
      `declaration_id 必须是 26 字符的 ULID，收到：${describeValue(input.declaration_id)}`,
    );
  }
  const declaredAt = input.declared_at ?? Date.now();
  if (typeof declaredAt !== 'number' || !Number.isFinite(declaredAt) || declaredAt < 0) {
    throw new ProjectionDeclarationInvalidError('declared_at 必须是毫秒时间戳');
  }
  const excludedTools = input.excluded_tools ?? [];
  if (!Array.isArray(excludedTools) || excludedTools.some((tool) => typeof tool !== 'string')) {
    throw new ProjectionDeclarationInvalidError('excluded_tools 必须是字符串数组');
  }
  if (mode !== 'externalize' && excludedTools.length > 0) {
    throw new ProjectionDeclarationInvalidError(
      `excluded_tools 只在 externalize 下有定义，${mode} 必须为空`,
    );
  }
  return {
    mode,
    declaration_id: declarationId,
    source,
    policy: PROJECTION_POLICY_ID,
    policy_version: PROJECTION_POLICY_VERSION,
    params: normalizeProjectionParams(input.params),
    excluded_tools: [...excludedTools],
    declared_at: declaredAt,
  };
}

/**
 * 校验落盘 / 传输来的声明形状（读侧）。
 *
 * 脏数据一律返回 `undefined`（= 当成旧会话，走 legacy 解析），**不抛错** ——
 * 读路径炸掉会让一个坏字段带走整个会话的历史。
 */
export function normalizeProjectionDeclaration(value: unknown): ProjectionDeclaration | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (!isProjectionMode(raw.mode)) return undefined;
  if (typeof raw.declaration_id !== 'string' || !isDeclarationId(raw.declaration_id))
    return undefined;
  if (!isProjectionDeclarationSource(raw.source)) return undefined;
  if (raw.policy !== PROJECTION_POLICY_ID) return undefined;
  if (raw.policy_version !== PROJECTION_POLICY_VERSION) return undefined;
  const params =
    raw.params !== null && typeof raw.params === 'object'
      ? normalizeProjectionParamsOrUndefined(raw.params as Partial<ProjectionParams>)
      : undefined;
  if (params === undefined) return undefined;
  const declaredAt = raw.declared_at;
  if (typeof declaredAt !== 'number' || !Number.isFinite(declaredAt) || declaredAt < 0) {
    return undefined;
  }
  const excluded = raw.excluded_tools;
  const excludedTools =
    Array.isArray(excluded) && excluded.every((tool) => typeof tool === 'string')
      ? [...(excluded as string[])]
      : [];
  return {
    mode: raw.mode,
    declaration_id: raw.declaration_id,
    source: raw.source,
    policy: PROJECTION_POLICY_ID,
    policy_version: PROJECTION_POLICY_VERSION,
    params,
    excluded_tools: excludedTools,
    declared_at: declaredAt,
  };
}

/** `normalizeProjectionParams` 的「坏值返回 undefined」版本（读侧用）。 */
function normalizeProjectionParamsOrUndefined(
  value?: Partial<ProjectionParams> | null,
): ProjectionParams | undefined {
  try {
    return normalizeProjectionParams(value);
  } catch {
    return undefined;
  }
}

/**
 * 校验落盘的审计行形状（读侧）。
 *
 * 同 `normalizeProjectionDeclaration`：脏数据返回 `undefined`，不抛错。
 */
export function normalizeContextProjectionAudit(
  value: unknown,
): ContextProjectionAudit | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.schema_version !== PROJECTION_POLICY_VERSION) return undefined;
  if (typeof raw.at !== 'number' || !Number.isFinite(raw.at)) return undefined;
  if (!Array.isArray(raw.steps) || raw.steps.some((step) => typeof step !== 'string')) {
    return undefined;
  }
  const declaration =
    raw.declaration === null ? null : normalizeProjectionDeclaration(raw.declaration);
  if (declaration === undefined) return undefined;
  const reason = raw.reason === null || typeof raw.reason === 'string' ? raw.reason : undefined;
  if (reason === undefined) return undefined;
  const requested =
    raw.requested_mode === null || typeof raw.requested_mode === 'string'
      ? raw.requested_mode
      : undefined;
  if (requested === undefined) return undefined;
  return {
    schema_version: PROJECTION_POLICY_VERSION,
    declaration,
    steps: [...(raw.steps as string[])],
    reason,
    requested_mode: requested,
    at: raw.at,
  };
}

// ───────────────────────── 解析 ─────────────────────────

/** 解析需要的最小会话状态形状（避免本模块 import `types/session`）。 */
export interface ProjectionSessionLike {
  /** 会话 id（幂等键维度）。 */
  readonly session_id?: string | undefined;
  /** 会话级投射声明（缺 = 旧会话）。 */
  readonly context_projection?: ProjectionDeclaration | null | undefined;
  /** 最近一次投射决策审计（U2 写入）。 */
  readonly context_projection_audit?: ContextProjectionAudit | null | undefined;
}

/** 一个会话当前的投射口径。 */
export interface ProjectionResolution {
  /** 生效的投射模式。 */
  readonly mode: ProjectionMode;
  /** 这个模式是怎么来的。 */
  readonly source: ProjectionDeclarationSource;
  /** 生效的声明（缺省 / 旧会话为 null）。 */
  readonly declaration: ProjectionDeclaration | null;
  /** 错误码 → 拒绝理由；正常解析为 null。 */
  readonly error: ProjectionErrorCode | null;
  /** 最近一次审计行（U2 写入；本单元恒为 null）。 */
  readonly audit: ContextProjectionAudit | null;
  /**
   * 模式是否已经写定（供 UI 判断「能不能改」，**不许 UI 自己推断**）。
   *
   * 会话存在（有状态）= 已写定；会话还不存在 = 还没锁。
   */
  readonly locked: boolean;
}

/**
 * 解析一个会话的投射口径 —— 读侧**唯一**入口。
 *
 * - 没有声明、会话还不存在（新会话缺省）⇒ `placeholder` + `default`
 * - 没有声明、会话已存在（旧会话，落盘里根本没这个字段）⇒ `placeholder` + `legacy`
 * - 有声明 ⇒ 声明本身（`locked: true`）
 *
 * 脏声明（形状坏）按旧会话处理，并把 `error` 标成 `projection_declaration_invalid`，
 * 好让上层能报出来，而不是静默当成正常旧会话。
 */
export function resolveProjection(state?: ProjectionSessionLike | null): ProjectionResolution {
  if (state === null || state === undefined) {
    return {
      mode: 'placeholder',
      source: 'default',
      declaration: null,
      error: null,
      audit: null,
      locked: false,
    };
  }
  const audit = normalizeContextProjectionAudit(state.context_projection_audit) ?? null;
  const raw = state.context_projection;
  if (raw !== null && raw !== undefined) {
    const declaration = normalizeProjectionDeclaration(raw);
    if (declaration !== undefined) {
      return {
        mode: declaration.mode,
        source: declaration.source,
        declaration,
        error: null,
        audit,
        locked: true,
      };
    }
    return {
      mode: 'placeholder',
      source: 'legacy',
      declaration: null,
      error: 'projection_declaration_invalid',
      audit,
      locked: true,
    };
  }
  return {
    mode: 'placeholder',
    source: 'legacy',
    declaration: null,
    error: null,
    audit,
    locked: true,
  };
}

// ───────────────────────── 不可变锁 ─────────────────────────

/**
 * 校验「同一会话的投射模式不可变」（ADR-104 §7.2）。
 *
 * - 还没有声明 ⇒ 接受 `incoming`（首次写定）
 * - 已有声明、`mode` 相同 ⇒ 幂等成功，**保留先写的那条**（`declaration_id` 不变）
 * - 已有声明、`mode` 不同 ⇒ 抛 `ProjectionModeImmutableError`
 *
 * 「静默忽略」被明确禁止：改不动就要抛，否则没人知道是谁试图改。
 */
export function assertProjectionImmutable(
  existing: ProjectionDeclaration | null | undefined,
  incoming: ProjectionDeclaration,
): ProjectionDeclaration {
  const current = normalizeProjectionDeclaration(existing);
  if (current === undefined) return incoming;
  if (current.mode !== incoming.mode) {
    throw new ProjectionModeImmutableError(
      current.mode,
      incoming.mode,
      '会话的投射模式已写定为 ' +
        current.mode +
        '（declaration ' +
        current.declaration_id +
        '），不能再改成 ' +
        incoming.mode,
    );
  }
  return current;
}

// ───────────────────────── 权限收窄（子不能放松父） ─────────────────────────

/**
 * 模式的「严格度」全序（ADR-104 §8.3.1 的**唯一权威排序**）：数值越大越严格。
 *
 * `passthrough < placeholder ≈ archive_notice < externalize`（externalize 未实现，恒被拒）。
 * `archive_notice` 与 `placeholder` **同层**：两者都丢掉正文，差别只在「丢得可不可寻址」
 * （archive_notice 给一张指向 `sessions.events` 的卡），在「模型看不看得见原文」这个
 * 判据上等价 —— 所以两者互切既不算放松也不算收紧。
 *
 * 0.53 口径（用户拍板，改写 ADR 原稿方向）：默认就是 `placeholder`，所以
 * `passthrough` 是**放松**（手动 opt-in 的逃生门），子会话只能「同层或收紧」：
 *
 * - 父 `placeholder` ⇒ 子 ∈ {`placeholder`, `archive_notice`}；`passthrough` 被拒
 * - 父 `passthrough` ⇒ 子 ∈ {`passthrough`, `placeholder`, `archive_notice`}
 * - 父 `archive_notice` ⇒ 子 ∈ {`archive_notice`, `placeholder`}；`passthrough` 被拒
 *
 * 新枚举**不得**默认插进这个序里（ADR §8.3.1）：必须先补 ADR 的一行排序才能被声明。
 */
export const PROJECTION_MODE_STRICTNESS: Readonly<Record<ProjectionMode, number>> = {
  passthrough: 0,
  placeholder: 1,
  archive_notice: 1,
  // 排序用不到；给一个不可能被满足的值，任何涉及 externalize 的比较都会失败。
  externalize: Number.POSITIVE_INFINITY,
};

/** 子会话请求的模式是否「同层或收紧」（ADR-104 §8.3.1 单调收紧）。 */
export function isProjectionModeAllowedForChild(
  parent: ProjectionMode | null | undefined,
  requested: ProjectionMode,
): boolean {
  if (requested === 'externalize') return false;
  if (parent === null || parent === undefined) return true;
  if (parent === 'externalize') return false;
  return PROJECTION_MODE_STRICTNESS[requested] >= PROJECTION_MODE_STRICTNESS[parent];
}

/**
 * 子会话请求的模式**只许同层或收紧**（ADR-104 §8.3.1 单调收紧），否则抛
 * `projection_mode_not_allowed`。
 *
 * 父模式未知（= 读不到父会话的状态）时**按默认 `placeholder` 处理**（保守：
 * 宁可拒掉一次 opt-in，也不让子会话在父收紧的情况下偷偷用 passthrough）。
 */
export function assertProjectionModeAllowedForChild(
  parent: ProjectionMode | null | undefined,
  requested: ProjectionMode,
): void {
  if (isProjectionModeAllowedForChild(parent, requested)) return;
  throw new ProjectionModeNotAllowedError(
    parent ?? 'placeholder',
    requested,
    '子会话不能放松父会话的投射模式：父 ' +
      (parent ?? 'placeholder（未知，按默认）') +
      ' ⇒ 子请求 ' +
      requested,
  );
}

// ───────────────────────── 进程内声明登记表 ─────────────────────────

/**
 * 进程内「已声明投射」登记表：`session_id → 声明 | null`（null = 探测过、盘上没有）。
 *
 * 为什么需要它：`SessionState` 的唯一写入者是运行日志（journal），而执行单元重建
 * state 时只带走它认识的那些字段 —— `context_projection` 不在其中（本单元不允许
 * 改 `execution-unit.ts`）。所以声明必须像续跑标记一样「写前合并回去」：
 *
 * - 会话创建路径 `armProjectionDeclaration()` 先登记；
 * - 状态写入前的 `applyDeclaredProjection()` 把登记表里的声明合并回 state；
 * - 进程重启后登记表是空的 ⇒ 首次写前从盘上读一次（每会话每进程最多一次）。
 *
 * 只增不改：往同一个 `session_id` 登记不同 `mode` 会抛 `projection_mode_immutable`。
 */
const declaredProjections = new Map<string, ProjectionDeclaration | null>();

/**
 * 登记一个会话的投射声明（会话创建路径调用）。
 *
 * 同一会话重复登记同一 `mode` 幂等成功；不同 `mode` 抛
 * `ProjectionModeImmutableError` —— 静默忽略会让「谁改了模式」查不出来。
 */
export function armProjectionDeclaration(
  sessionId: string,
  declaration: ProjectionDeclaration,
): ProjectionDeclaration {
  const existing = declaredProjections.get(sessionId) ?? null;
  const kept = assertProjectionImmutable(existing, declaration);
  declaredProjections.set(sessionId, kept);
  return kept;
}

/**
 * 读出登记表里已知的声明（`undefined` = 还没探测过，`null` = 探测过、盘上没有）。
 */
export function knownProjectionDeclaration(
  sessionId: string,
): ProjectionDeclaration | null | undefined {
  return declaredProjections.get(sessionId);
}

/** 读出登记表里已知的投射模式（未知 ⇒ `undefined`，调用方自行决定兜底）。 */
export function knownProjectionMode(sessionId: string): ProjectionMode | undefined {
  const known = declaredProjections.get(sessionId);
  return known === null || known === undefined ? undefined : known.mode;
}

/** 忘掉一个会话的登记（删会话时调用，避免登记表长成泄漏）。 */
export function forgetProjectionDeclaration(sessionId: string): void {
  declaredProjections.delete(sessionId);
}

/** 清空登记表（门禁 / 测试用）。 */
export function resetProjectionDeclarations(): void {
  declaredProjections.clear();
}

/**
 * 状态写入前把已声明的投射合并回 `state`（journal 调用；见登记表注释）。
 *
 * 语义：
 * - `state` 自带声明 ⇒ 以它为准并登记（幂等）；
 * - 登记表已知该会话 ⇒ 合并回去；
 * - 登记表未知 ⇒ 从盘上读一次（每会话每进程一次），有就登记并合并，没有就记 `null`。
 *
 * 只补 `context_projection`，不碰 `context_projection_audit`（那是 U2 运行时的写入）。
 */
export async function applyDeclaredProjection(
  state: { session_id: string; context_projection?: ProjectionDeclaration | null },
  loadStored: (sessionId: string) => Promise<ProjectionSessionLike | null>,
): Promise<void> {
  const carried = normalizeProjectionDeclaration(state.context_projection);
  if (carried !== undefined) {
    declaredProjections.set(state.session_id, carried);
    return;
  }
  const known = declaredProjections.get(state.session_id);
  if (known === undefined) {
    const stored = await loadStored(state.session_id);
    const fromDisk = normalizeProjectionDeclaration(stored?.context_projection);
    declaredProjections.set(state.session_id, fromDisk ?? null);
    if (fromDisk !== undefined) state.context_projection = fromDisk;
    return;
  }
  if (known !== null) state.context_projection = known;
}
