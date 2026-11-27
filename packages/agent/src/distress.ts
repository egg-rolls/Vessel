/**
 * 遇难求救消息（q-distress-message）：run 致命错误时，node 以遇难 agent 自身身份
 * 向 parent/创建者（fallback 最近发送者）发一条**普通 inbox 消息**，让故障可见可救援。
 *
 * 灵感来自 lead 超窗卡死双向哑火事件：`run.failed` 只写一行 Team 日志，父级与
 * 协作方都看不到「这具 body 已经跑不动了」；0.55 硬错误闸让它停止自动接单，但
 * 停止本身是静默的。求救消息是闸的**通信兜底**：把「谁遇难 / 在哪 / 为什么 /
 * 怎么救」写成一条可回复的消息。
 *
 * 本模块只做**纯函数**：触发码表、错误分类、建议处置、正文渲染。收件人解析 /
 * 限流 / 防循环 / 投递在 `AgentService`（需要 registry / inbox / admit）。
 *
 * @module @vessel-agent/agent
 */

import { toErrorEnvelope } from '@vessel-agent/core';

/** 每 agent 求救冷却：窗口内至多一条（去重 / 防风暴）。 */
export const DISTRESS_COOLDOWN_MS = 5 * 60_000;

/** 解析「最近发送者」时扫描 inbox 历史的条数上限（newest-first）。 */
export const DISTRESS_HISTORY_SCAN = 50;

/** 正文里错误消息的长度上限（与硬错误闸 `singleLineReason` 同口径）。 */
const MAX_DISTRESS_ERROR_CHARS = 500;

/**
 * 触发码表：只覆盖**致命 / 终态** run 错误 —— 同一份请求重发必然再失败、或
 * body 已无法继续，需要外部（parent / 人）介入的那一类。
 *
 * 刻意**不含**：
 * - 瞬态可重试错误（`provider_rate_limit` / `provider_timeout` / `provider_network` /
 *   `provider_unavailable` / `checkpoint_failed` / `atomic_write_failed` /
 *   `run_already_running`）—— core 自己会重试或调用方可安全重发；
 * - 权限流错误（`permission_denied` / `permission_cancelled` / `permission_timeout`）
 *   —— 用户动作的结果，已有各自的可见通知，不是「遇难」；
 * - 工具 / PII 动作错误（`tool_*` / `pii_*`）—— 失败结果回喂模型，run 通常继续；
 * - 预算阻塞（`limit_blocked`）—— 已有 `team.budget.blocked` 事件与 override 路径；
 * - 输入类错误（`run_not_found` / `agent_not_found` / `conflict` 等）—— 调用方
 *   直接收到错误，不存在「静默卡死」。
 *
 * `internal_error` 是引擎崩溃的兜底档（未分类内部错误一律落它，retryable=false）。
 */
export const DISTRESS_TRIGGER_CODES: ReadonlySet<string> = new Set([
  // 本地发送前闸拦下的超窗（请求根本没出去）—— lead 事故的直接形态。
  'context_window_exceeded',
  // provider 说超了（400 + 超限文本）。
  'provider_context_overflow',
  // 401 / 403：密钥 / 权限配置错，重发必然再失败。
  'provider_auth',
  // 402：余额 / 配额耗尽。
  'provider_quota_exceeded',
  // 其它 4xx（如 404 模型不存在）：请求本身被拒。
  'provider_http_error',
  // 无状态码的 provider 错误且不可重试。
  'provider_error',
  // 会话数据损坏：历史读不回来，body 起不来。
  'session_corrupt',
  // 引擎 / 内部崩溃兜底档。
  'internal_error',
  // 空响应兜底耗尽（seamless + nudge 仍空）：需要 parent 催续 / 人介入。
  'empty_response_exhausted',
]);

/**
 * 服务层触发码：body spawn 失败。错误对象本身可能没有稳定 code（模型解析 /
 * 插件安装 / 文件系统各种来源），但「body 起不来」对投递而言就是终态 ——
 * 消息留在 inbox 反复重投反复失败，正是要求救的静默故障。
 */
export const DISTRESS_SPAWN_FAILED = 'spawn_failed';

export interface DistressClassification {
  code: string;
  /** 原始错误文本（渲染时折单行 + 截断）。 */
  message: string;
}

/**
 * 致命错误分类：envelope 的 `error_code` 命中触发码表才返回。
 * 不传 phase 提示 —— 让 envelope 自己按错误对象 / 文本判（与 `hardProviderFailure`
 * 同一口径：强行传 phase 会把别的 category 误判进来）。
 */
export function classifyDistress(error: unknown): DistressClassification | undefined {
  const envelope = toErrorEnvelope(error);
  if (!DISTRESS_TRIGGER_CODES.has(envelope.error_code)) return undefined;
  return {
    code: envelope.error_code,
    message: error instanceof Error ? error.message : String(error),
  };
}

/** 按错误码给可操作的处置建议（收件人一看就知道下一步做什么）。 */
const DISTRESS_ADVICE: Readonly<Record<string, string>> = {
  context_window_exceeded:
    '上下文超窗（本地闸拦下，请求未发出）：让它 rotate（写交接嘱托）或开新会话；不要直接重发原消息。',
  provider_context_overflow:
    '上下文超窗（provider 拒绝）：让它 rotate（写交接嘱托）或开新会话；不要直接重发原消息。',
  provider_auth: 'provider 认证失败（401/403）：检查 API key / 模型配置，修复后再让它重试。',
  provider_quota_exceeded: 'provider 配额耗尽（402）：检查余额 / 配额，充值后再让它重试。',
  provider_http_error: 'provider 拒绝请求（4xx）：检查模型名与请求参数，修复后再让它重试。',
  provider_error: 'provider 错误且不可重试：检查模型服务状态与配置。',
  session_corrupt: '会话数据损坏：可能需要开新会话，或从事件日志重建历史。',
  internal_error: '引擎 / 内部错误：检查节点日志，尝试让它 rotate 或重建 body。',
  empty_response_exhausted: '模型连续空响应：尝试催续、换模型或人介入。',
  spawn_failed: 'body 启动失败：检查模型配置 / 节点日志，修复后重投消息。',
};

export function distressAdvice(code: string): string {
  return DISTRESS_ADVICE[code] ?? '致命 run 错误：检查节点日志并介入处置。';
}

/** 失败原因折单行并截断（与硬错误闸同口径：一条消息不该被多行正文撑开）。 */
function singleLineError(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_DISTRESS_ERROR_CHARS
    ? `${flat.slice(0, MAX_DISTRESS_ERROR_CHARS)}...`
    : flat;
}

export interface DistressContentInput {
  memberId: string;
  memberName?: string;
  /** 遇难 body 的 session（binding id）：救援者据此定位现场。 */
  sessionId: string;
  teamId?: string;
  code: string;
  message: string;
  /**
   * 受众 = 人类（顶层 fallback 投 Team 日志）：回信指引换成 Web Team 面板 / CLI，
   * 而非 agent 工具。缺省 = agent 收件人。
   */
  human?: boolean;
}

/**
 * 渲染求救正文：汇报地址（可回信）+ 报错（code + message）+ 建议处置 + 防循环说明。
 * 普通消息正文（不是系统事件）：agent 收件人可直接回复或 `agent send to=<memberId>`；
 * 人类收件人（顶层 fallback）在 Web Team 面板回信。
 */
export function renderDistressContent(input: DistressContentInput): string {
  const who =
    input.memberName !== undefined && input.memberName !== ''
      ? `"${input.memberName}" (${input.memberId})`
      : input.memberId;
  const team = input.teamId !== undefined ? ` team=${input.teamId}` : '';
  const reply =
    input.human === true
      ? `回信/救援: 在本 Team 面板回复并 @ 该成员，或 vessel agent send to=${input.memberId}`
      : `回信/救援: agent send to=${input.memberId}`;
  const tail =
    input.human === true
      ? '本条为顶层/无 parent agent 的遇难求救（人类兜底）：该 agent 没有可报的成员收件人，故报给本节点人类。每 agent 每 5 分钟至多一条。'
      : '本消息带 distress:true 标记：你处理这条求救时若也报错，node 不会再替你发求救（防级联）；每 agent 每 5 分钟至多一条求救。';
  return [
    `[distress] agent ${who} 的 run 遇到致命错误，node 以它的身份代发求救。`,
    `遇难地址: member_id=${input.memberId} session_id=${input.sessionId}${team}（${reply}）`,
    `错误: ${input.code} — ${singleLineError(input.message)}`,
    `建议处置: ${distressAdvice(input.code)}`,
    tail,
  ].join('\n');
}
