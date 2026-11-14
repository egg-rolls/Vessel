/**
 * 会话级「上下文投射」的类型面（0.53 U1，ADR-104）。
 *
 * 只有类型与词表，没有实现：`context/projection-policy.ts` 才是声明 / 解析 / 锁的实现。
 * 这样 `types/session.ts` 可以引用 `ProjectionDeclaration` 而不违反 D1（types 只依赖
 * types），实现侧（context / runtime）也能共用同一份形状。
 *
 * 词表与取值**都由 ADR-104 冻结**：新增模式 / 改字段名必须先改 ADR。
 */

/** 会话的上下文投射模式（ADR-104 §2.1）。 */
export type ProjectionMode = 'passthrough' | 'placeholder' | 'externalize' | 'archive_notice';

/** ADR-104 里的类型名（与 `ProjectionMode` 同一个类型，只是沿用 ADR 的写法）。 */
export type ContextProjectionMode = ProjectionMode;

/**
 * 声明的来源（ADR-104 §5.2）。
 *
 * - `session_created`：会话创建时由调用方显式声明。
 * - `default`：没有声明、新会话缺省解析出来的（= `placeholder`）。
 * - `legacy`：旧会话落盘里根本没有这个字段，读到时解析成 `placeholder`。
 * - `rotate`：换 body（rotate）时给下一条会话声明。
 * - `inherited`：由父会话收窄继承而来（子会话只许同层或收紧）。
 */
export type ProjectionDeclarationSource =
  | 'session_created'
  | 'default'
  | 'legacy'
  | 'rotate'
  | 'inherited';

/**
 * 声明参数（ADR-104 §4.6）。
 *
 * 取值与 `context-manager.ts` 的常量一致；本单元不引入新配置键。
 */
export interface ProjectionParams {
  /** 压缩时保留最近工具结果的 token 占比（= `KEEP_RECENT_TOKEN_RATIO`）。 */
  readonly keepRecentTokenRatio: number;
  /** 压缩时保留最近工具结果的条数上限（= `KEEP_RECENT_MAX`）。 */
  readonly keepRecentMax: number;
  /** 单条工具结果的体积占比阈值（= `TOOL_RESULT_VOLUME_THRESHOLD_RATIO`）。 */
  readonly volumeRatio: number;
}

/**
 * 会话级上下文投射声明（ADR-104 §4.6）。
 *
 * 一次写定、只读；`declaration_id` 是幂等键（重复声明同值 = 同一条）。
 */
export interface ProjectionDeclaration {
  /** 投射模式。 */
  readonly mode: ProjectionMode;
  /** ULID（26 字符）：幂等键与日志凭据。 */
  readonly declaration_id: string;
  /** 声明来源。 */
  readonly source: ProjectionDeclarationSource;
  /** 策略 ID，恒为 `core.context_projection`。 */
  readonly policy: 'core.context_projection';
  /** 声明格式版本，恒为 1。 */
  readonly policy_version: 1;
  /** 声明参数。 */
  readonly params: ProjectionParams;
  /** 本会话不投射的工具（`externalize` 专用，其余模式恒为空）。 */
  readonly excluded_tools: readonly string[];
  /** 声明时刻（ms）。 */
  readonly declared_at: number;
}

/** ADR-104 里的类型名（与 `ProjectionDeclaration` 同一形状）。 */
export type ContextProjectionDeclaration = ProjectionDeclaration;

/**
 * 投射决策审计（ADR-104 §5.1）。
 *
 * 0.53 U1 只声明字段与落盘位置；写入者是 U2 的运行时（每次重新解析 / 降级时覆盖成
 * 最新一条）。
 */
export interface ContextProjectionAudit {
  /** 审计行格式版本，恒为 1。 */
  readonly schema_version: 1;
  /** 本次解析实际使用的声明（无声明时为 null）。 */
  readonly declaration: ProjectionDeclaration | null;
  /** 决策链路，按发生顺序（`passthrough` / `placeholder` / `unavailable` …）。 */
  readonly steps: readonly string[];
  /** 降级 / 拒绝的原因（ADR-104 §6.4 的错误码或 mechanism 名）。 */
  readonly reason: string | null;
  /** 被降级 / 拒绝的原始请求模式。 */
  readonly requested_mode: string | null;
  /** 决策时刻（ms）。 */
  readonly at: number;
}

/** 投射声明 / 锁的拒绝码（ADR-104 §6.4；改名必须先改 ADR）。 */
export type ProjectionErrorCode =
  | 'projection_declaration_invalid'
  | 'projection_mode_unavailable'
  | 'projection_mode_immutable'
  | 'projection_mode_not_allowed';
