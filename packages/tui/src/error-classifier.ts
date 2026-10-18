/**
 * 错误分类器
 *
 * 将 run() 抛出的错误分类（取消 / 权限 / 超时 / 网络 / API / 限额 / 鉴权 / 其他）。
 * 纯函数，可单测。
 */

export type ErrorCategory =
  | 'cancelled'
  | 'permission'
  | 'timeout'
  | 'network'
  | 'auth'
  | 'quota'
  | 'api'
  // 0.3：durable / MCP 稳定错误码（DECISION-008 §4.4 + Addendum A §1 + Addendum B §9.2）
  | 'not_found'
  | 'not_resumable'
  | 'conflict'
  | 'disabled'
  | 'invalid'
  | 'unknown';

/** 跨层稳定的错误 code（core RunResumeError / MCP 控制面约定） */
const STABLE_ERROR_CODES = [
  'run_not_found',
  'run_not_resumable',
  'run_already_running',
  'run_store_required',
  'agent_not_found',
  'durable_disabled',
  'mcp_disabled',
  'mcp_server_not_found',
  'mcp_server_disabled',
  // 0.4：workflow / feishu 稳定错误码（DECISION-009 §5.1.4 / §5.3.4）
  'workflow_not_found',
  'workflow_invalid',
  'workflow_already_running',
  'workflow_not_resumable',
  'workflow_cancelled',
  'workflow_disabled',
  'channel_disabled',
  'channel_not_connected',
  'channel_auth_failed',
  // 0.5：RPC 冻结错误码（DECISION-010 §2.3）。放在长码之后，避免子串抢先匹配。
  'unauthorized',
  'forbidden',
  'invalid_params',
  'tenant_locked',
  'quota_exceeded',
  'conflict',
  'internal',
  'not_found',
] as const;

type StableErrorCode = (typeof STABLE_ERROR_CODES)[number];

/** 0.5 RPC 错误码中过短/易误判的两个，只从 Error.code 识别 */
const CODE_ONLY_RPC_CODES = new Set<StableErrorCode>(['conflict', 'internal']);

/** 先读 Error.code，再回退到 message；两者都可能来自不同装配层 */
function readStableCode(error: unknown, lowerMessage: string): StableErrorCode | undefined {
  const rawCode =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (typeof rawCode === 'string') {
    const matched = STABLE_ERROR_CODES.find((code) => rawCode.includes(code));
    if (matched) return matched;
  }
  return STABLE_ERROR_CODES.find(
    (code) => !CODE_ONLY_RPC_CODES.has(code) && lowerMessage.includes(code),
  );
}

export interface ClassifiedError {
  category: ErrorCategory;
  message: string;
  hint?: string;
}

/**
 * 把 run() 抛出的错误分类。纯函数，可单测。
 *
 * 顺序很重要：
 * - 先判 timeout——`The operation was aborted due to timeout` 同时含 abort，不能被当成取消；
 * - 再判权限拒绝、取消；
 * - 其余沿用原有网络 / 限额 / 鉴权 / API 规则。
 */
export function classifyError(error: unknown): ClassifiedError {
  const msg = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';
  const lower = msg.toLowerCase();

  // 0.3 稳定错误码优先：它们是跨层协议，不能被 message 里的泛化词误判
  const stableCode = readStableCode(error, lower);
  if (stableCode) {
    switch (stableCode) {
      case 'run_not_found':
      case 'agent_not_found':
      case 'mcp_server_not_found':
        return {
          category: 'not_found',
          message: msg,
          hint: '目标不存在；用 /runs 或 /mcp 查看当前可用项。',
        };
      case 'run_not_resumable':
        return {
          category: 'not_resumable',
          message: msg,
          hint: '该 run 已结束（completed/failed/cancelled），不能恢复。',
        };
      case 'run_already_running':
        return {
          category: 'conflict',
          message: msg,
          hint: '该 run 已有恢复在进行中；等它结束或先用 /runs 查看状态。',
        };
      case 'run_store_required':
      case 'durable_disabled':
        return {
          category: 'disabled',
          message: msg,
          hint: 'durable.enabled 未开启；检查配置后重启。',
        };
      case 'mcp_disabled':
      case 'mcp_server_disabled':
        return {
          category: 'disabled',
          message: msg,
          hint: 'mcp_servers 未配置或该 server 已禁用；检查配置后重启。',
        };
      case 'workflow_not_found':
        return {
          category: 'not_found',
          message: msg,
          hint: '目标不存在；用 /workflows 查看当前 workflow run。',
        };
      case 'workflow_invalid':
        return {
          category: 'invalid',
          message: msg,
          hint: 'workflow 定义无效；检查 YAML/JSON、workflow.dir 与模板变量。',
        };
      case 'workflow_already_running':
        return {
          category: 'conflict',
          message: msg,
          hint: '该 workflow run 已有执行在进行；等它结束或先 /workflows show。',
        };
      case 'workflow_not_resumable':
        return {
          category: 'not_resumable',
          message: msg,
          hint: '该 run 是 cancelled（或已终止）；cancelled 不可 resume。',
        };
      case 'workflow_cancelled':
        return { category: 'cancelled', message: msg };
      case 'workflow_disabled':
        return {
          category: 'disabled',
          message: msg,
          hint: 'workflow.enabled 未开启；检查配置后重启。',
        };
      case 'channel_disabled':
        return {
          category: 'disabled',
          message: msg,
          hint: 'feishu.enabled 未开启；检查配置后重启。',
        };
      case 'channel_not_connected':
        return {
          category: 'network',
          message: msg,
          hint: '飞书渠道未连接；查看 /feishu 的 last error。',
        };
      case 'channel_auth_failed':
        return {
          category: 'auth',
          message: msg,
          hint: '飞书 app_id/app_secret 无效；检查环境变量或配置。',
        };
      // 0.5：RPC 冻结错误码
      case 'unauthorized':
        return {
          category: 'auth',
          message: msg,
          hint: '凭据缺失或无效；检查 token 配置。',
        };
      case 'forbidden':
        return {
          category: 'permission',
          message: msg,
          hint: 'tenant 隔离或角色权限不足；确认 tenant 与权限后重试。',
        };
      case 'invalid_params':
        return {
          category: 'invalid',
          message: msg,
          hint: '命令参数不合法；用 /help 或命令 usage 确认格式。',
        };
      case 'not_found':
        return {
          category: 'not_found',
          message: msg,
          hint: '目标不存在；用 /runs、/sessions 或 /workflows 查看可用项。',
        };
      case 'tenant_locked':
        return {
          category: 'conflict',
          message: msg,
          hint: '同一 tenant 已有写者；用 --connect <url> 连接 gateway，或关闭占用进程。',
        };
      case 'quota_exceeded':
        return {
          category: 'quota',
          message: msg,
          hint: 'tenant quota 超限；清理会话/run 或调大配额后重试。',
        };
      case 'conflict':
        return {
          category: 'conflict',
          message: msg,
          hint: '状态冲突（已运行/已结束/仍有活动 run）；先查看当前状态。',
        };
      case 'internal':
        return {
          category: 'api',
          message: msg,
          hint: '服务端内部错误；稍后重试或查看 gateway 日志。',
        };
    }
  }

  // 超时（含 AbortSignal.timeout 的 TimeoutError）
  if (
    name === 'TimeoutError' ||
    /timed out|timeout|etimedout|connect_timeout|deadline exceeded/.test(lower)
  ) {
    return { category: 'timeout', message: msg, hint: '请求超时；检查网络或稍后重试。' };
  }

  // 权限拒绝（用户或策略）
  if (/denied by (user|permission policy)|execution denied|permission denied/.test(lower)) {
    return {
      category: 'permission',
      message: msg,
      hint: '权限确认被拒绝；模型会收到拒绝结果并继续。',
    };
  }

  // 取消（Esc / Ctrl+C / AbortError）
  if (name === 'AbortError' || /abort|cancel/.test(lower)) {
    return { category: 'cancelled', message: msg };
  }

  if (/usage limits exceeded|termination policy|max iterations|max_runtime/.test(lower)) {
    return {
      category: 'quota',
      message: msg,
      hint: '用量/限额触发，调大 limits 或 /new 开新会话。',
    };
  }
  if (/429|rate limit|rate_limit|quota/.test(lower)) {
    return { category: 'quota', message: msg, hint: '请求过频或额度不足，稍后重试。' };
  }
  if (/401|unauthorized|invalid api key|invalid_api_key|authentication/.test(lower)) {
    return { category: 'auth', message: msg, hint: 'API Key 无效，运行 /setup 重新配置。' };
  }
  if (
    /fetch failed|econnrefused|econnreset|enotfound|etimedout|connect_timeout|network|socket hang up|dns/.test(
      lower,
    )
  ) {
    return { category: 'network', message: msg, hint: '网络不可达，检查 BaseURL/网络后重试。' };
  }
  if (/api error|http \d{3}|bad request|400|403|404|500|502|503/.test(lower)) {
    return { category: 'api', message: msg, hint: 'Provider 返回错误，检查模型名/参数。' };
  }
  return { category: 'unknown', message: msg };
}

/**
 * 格式化为单条可读文本（TTY / simple mode 共用）。
 * 取消不是错误，显示为一条状态；其余带分类标签与 hint。
 */
export function formatClassifiedError(classified: ClassifiedError): string {
  if (classified.category === 'cancelled') return '⏹ Cancelled.';
  const head = `✗ [${classified.category}] ${classified.message}`;
  return classified.hint ? `${head}\n  ${classified.hint}` : head;
}
