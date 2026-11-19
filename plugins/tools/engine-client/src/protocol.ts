/**
 * tools-engine child wire 协议（P2 契约 §2/§3 冻结形状；单实现，host/engine 两侧共用）。
 *
 * 这些方法是 **child wire 协议方法，不是 canonical RPC 方法**：不进 gateway 方法表、
 * 零 prompt surface。wire = NDJSON JSON-RPC 2.0，复用 serve/plugin-host/child.ts 帧/pending。
 *
 * 方向：
 * - host→engine request：`tool.invoke` / `engine.registry.sync` / `engine.health`
 * - host→engine notification：`tool.cancel` / `engine.impl.reject`
 * - engine→host request：`tool.callback`（**只带关联 id**，host 按在途记录执行原 handler，
 *   fail-closed —— engine 不能注入任意调用）
 * - engine→host notification：`engine.impl.swapped` / `engine.health`
 *
 * @module @vessel-agent/engine-client
 */

import { createHash } from 'node:crypto';
import type { SerializedBoundary } from '@vessel-agent/basic-tools';
import type {
  McpPromptDef,
  McpResourceDef,
  McpServerConfig,
  McpServerStatus,
  McpToolDef,
} from '@vessel-agent/mcp-client';

/** 单行上限（engine 通道）：4 MiB write 内容 + JSON 开销；与 gateway 8 MiB 背压同量级。 */
export const ENGINE_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

/** wire 方法名（唯一真源；两侧都从这里取，不另写字符串）。 */
export const ENGINE_WIRE = {
  toolInvoke: 'tool.invoke',
  toolCancel: 'tool.cancel',
  toolCallback: 'tool.callback',
  registrySync: 'engine.registry.sync',
  implSwapped: 'engine.impl.swapped',
  implReject: 'engine.impl.reject',
  health: 'engine.health',
  /** 批次 2（修正案 r2 已批）：MCP 控制面（非 canonical RPC，零 prompt surface）。 */
  mcpControl: 'engine.mcp.control',
} as const;

/** 执行类（host 转发工厂逐调用计算；engine 机械路由，不做业务决策）。 */
export type ExecClass = 'worker' | 'callback';

/** host→engine `tool.invoke` 信封（契约 §3 表；args = PII 替换后真值）。 */
export interface ToolInvokeParams {
  run_id: string;
  session_id: string;
  tool_call_id: string;
  /** host 解析后的最终名（别名解析后）。 */
  tool_name: string;
  args: Record<string, unknown>;
  exec: ExecClass;
  /** host resolveCallCwd 结果（绝对路径）；worker 不再解析 config。 */
  cwd?: string;
  /** host buildPathBoundary 结果序列化；exec=worker 的路径类工具必带。 */
  boundary?: SerializedBoundary;
  /** host 预算下发（worker 到点自杀，纵深防御）；缺省按工具语义。 */
  timeout_ms?: number;
}

/** `tool.invoke` 结果：content + 出口闸回执跨进程传递（worker 侧裁剪事实不丢）。 */
export interface ToolInvokeResult {
  content: string;
  /** worker 自己裁过（boundToolResult）⇒ host 转发 handler 登记 markToolResultBounded。 */
  bounded?: boolean;
  original_chars?: number;
}

/** host→engine `tool.cancel`（notification）：worker abort 杀进程树 / callback 清 pending。 */
export interface ToolCancelParams {
  run_id: string;
  tool_call_id: string;
}

/** engine→host `tool.callback`（request）：**只带关联 id**，不带 method/args。 */
export interface ToolCallbackParams {
  run_id: string;
  tool_call_id: string;
}

/** 注册表条目（engine 注册表内容由 PluginHost 接入层喂；engine 不独立发现工具）。 */
export interface RegistryEntry {
  name: string;
  /** 派发前机械校验用（不是权限判定）。 */
  inputSchema: Record<string, unknown>;
  schema_fingerprint: string;
  /** 默认执行类；逐调用以信封 exec 为准（bash async 分流）。 */
  exec_class: ExecClass;
  /** 来源标记（'basic-tools' / 'mcp:<server>' / 入口注册名）。 */
  source: string;
}

/** host→engine `engine.registry.sync`（request）：增量喂注册表。 */
export interface RegistrySyncParams {
  upsert: RegistryEntry[];
  remove: string[];
}

/** registry.sync 回包：对账实现路由与健康，不是注册。 */
export interface RegistrySyncResult {
  ok: true;
  loaded: string[];
}

/** engine→host `engine.impl.swapped`（notification）：host 对拍指纹，校验权在 host。 */
export interface ImplSwappedParams {
  name: string;
  schema_fingerprint: string;
}

/** host→engine `engine.impl.reject`（notification）：指纹不一致，不接受透明替换。 */
export interface ImplRejectParams {
  name: string;
}

/** engine 自报健康（request 回包 / notification 同形）；restarts 由 host supervisor 补。 */
export interface EngineHealthParams {
  status: 'ok' | 'degraded';
  loaded: string[];
  /**
   * 批次 2 additive：MCP server 状态快照（被动变化 notification；host 缓存读面）。
   * 缺省 = 无 MCP server，旧行为零变化。形状单实现 = @vessel-agent/mcp-client types。
   */
  mcp?: McpServerStatus[];
}

/**
 * host→engine `engine.mcp.control`（request；批次 2 修正案 r2 已批，6 action）。
 * 连接配置按 server 喂一次（configure）；注册权威在 host——configure/reconnect 回包
 * 带工具集，host 走既有增删注册流程，engine 不驱动注册（C1）。
 */
export type McpControlParams =
  | { action: 'configure'; servers: McpServerConfig[] }
  | { action: 'reconnect'; server: string }
  | { action: 'listTools'; server: string }
  | { action: 'listResources'; server: string }
  | { action: 'readResource'; server: string; uri: string }
  | { action: 'listPrompts'; server: string };

/** configure 逐 server 结果（部分失败逐 server 报，不整请求失败）。 */
export interface McpConfigureServerResult {
  name: string;
  status: McpServerStatus;
  tools: McpToolDef[];
  error?: string;
}

/** control 回包：ok:true 按 action 判别；ok:false = 业务失败（McpPluginErrorCode 稳定码）。 */
export type McpControlResult =
  | { ok: true; action: 'configure'; results: McpConfigureServerResult[] }
  | { ok: true; action: 'reconnect'; status: McpServerStatus; tools: McpToolDef[] }
  | { ok: true; action: 'listTools'; tools: McpToolDef[] }
  | { ok: true; action: 'listResources'; resources: McpResourceDef[] }
  | { ok: true; action: 'readResource'; content: string }
  | { ok: true; action: 'listPrompts'; prompts: McpPromptDef[] }
  | { ok: false; code: string; message: string };

/** host 侧对外健康报告（supervisor 补重启计数）。 */
export interface EngineHealthReport extends EngineHealthParams {
  restarts: number;
}

/**
 * 稳定错误文本（折回模型的工具错误；error-envelope 默认 tool_error / retryable:false）。
 * 取消文本与 basic-tools CANCELLED_TEXT 逐字一致；超时文本命中既有 tool_timeout 分类。
 */
export const ENGINE_ERROR = {
  unavailable: 'Error: engine_unavailable: tool engine is not running',
  notRegistered: (name: string): string => `Error: engine_tool_not_registered: ${name}`,
  invalidParams: (detail: string): string => `Error: engine_invalid_params: ${detail}`,
  callbackRejected: 'Error: engine_callback_rejected: unknown or already-settled call',
  cancelled: '错误：操作已取消（cancelled）。',
  timeout: (name: string, ms: number): string => `Error: tool "${name}" timed out after ${ms}ms`,
  implRejected: (name: string): string => `Error: engine_impl_rejected: ${name}`,
} as const;

/** canonicalJSON：键排序稳定序列化（指纹用；实现细节）。 */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      output[key] = sortKeys(record[key]);
    }
    return output;
  }
  return value;
}

/** schema_fingerprint = sha256(canonicalJSON({ name, description, inputSchema })) hex。 */
export function computeSchemaFingerprint(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
): string {
  return createHash('sha256')
    .update(canonicalJSON({ name, description, inputSchema }))
    .digest('hex');
}

/**
 * host 侧传输端口（supervisor 用 ChildPluginProcess 实现；engine-client 只认端口）。
 * request 超时 semantics：timeoutMs 缺省 = 不设 per-request timer（心跳守活）。
 */
export interface EngineTransport {
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  /** fire-and-forget；engine 不在跑时静默丢弃（cancel 是 best-effort）。 */
  notify(method: string, params: unknown): void;
  readonly active: boolean;
}
