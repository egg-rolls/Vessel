/**
 * vessel 元工具（P1，单工具面）：结构化 RPC 控制面 + 工具调用桥。
 *
 * 设计契约：个人侧 `docs/dev/plans/vessel-meta-tool.md`；论证见个人侧
 * `docs/dev/research/tools-engine-argumentation.md` §4（桥 = ToolCall guardrail 改写接缝，
 * ADR-058 决策 2：鉴权针对改写后的**最终工具与参数**）。
 * **用户裁定（2026-11-18）：模型面只有 vessel 一个工具**，不设独立执行器工具。
 *
 * 两种执行边界（混用口径）：
 * - **op=call_tool**：vessel-bridge guardrail 改写成目标 ToolCall（保留原 tool_call.id，C-05 配对），
 *   鉴权落在目标工具 + args（auto_approve / checkPermission 按目标键控原样命中，零新鉴权逻辑）。
 *   vessel 对 call_tool **fail-closed**：checkPermission=deny、handler 永不转发——关闭 guardrail
 *   阶段的入口（EU delegate 等）直达 vessel 时 deny 先挡，任何入口组合都不能绕过桥校验
 *   直达任意工具。目标可以是 live 注册表任意工具（含 MCP），桥不放宽目标自身任何权限规则。
 * - **op=rpc / op=set_config**：guardrail 原样放行，**vessel 自执行**。方法级鉴权落在
 *   vessel.checkPermission（工具自描述自判，ADR-026）：按方法在 manifest 里声明的 permission
 *   分层（read→allow / write→ask / admin→deny / 未知→deny），另加自审批/自改策略方法硬禁名单。
 *   ask / auto_approve / remember 全走既有 PermissionPolicy；handler 只执行不判定。
 *   RPC 面是启动期冻结的方法表 + 逐方法门，属**有界执行**，与 call_tool 的任意转发风险不同；
 *   checkPermission 对最终 args 判定（ADR-058 决策 2），BeforeTool 改写 op 也逃不过对应门。
 *
 * 机制全在 core 既有接缝（管道 / guardrail / PermissionPolicy），core 零改动；本模块是
 * 装配层实现（宪法 13）。dispatcher 经 getter 晚绑定——bootstrap 的 localDispatcher 建在
 * 插件安装与 owner 派生之后（与 feishuTeamId 同口径）。
 *
 * @module vessel/vessel-meta
 */

import { randomUUID } from 'node:crypto';
import {
  type Guardrail,
  type GuardrailResult,
  GuardrailStage,
  markBridgeCall,
  resolveToolNameAlias,
  type ToolCall,
  type ToolDefinition,
} from '../../packages/core/src/index';
import type { CapabilityManifest, RpcDispatcher, RpcResponse } from '../../packages/serve/src/rpc';

/** 模型面桥工具名（常驻 tools[]，snake_case 合规；单工具面，无第二执行器）。 */
export const VESSEL_TOOL_NAME = 'vessel';

/**
 * 桥 guardrail 名（core，装配层注册，非插件贡献）。热应用注册面差量的管辖域
 * 必须排除它（pluginManagedGuardrailNames），否则插件目标集里没有它 → 误判 removed。
 */
export const VESSEL_BRIDGE_GUARDRAIL_NAME = 'vessel-bridge';

/**
 * 自审批 / 自改权限策略的方法：只有 human / policy 能答（ADR-077/079/091），
 * 模型经任何通路都不得触碰——否则权限管道形同虚设。
 */
const RPC_SELF_SERVICE_DENYLIST: ReadonlySet<string> = new Set([
  'permission.respond',
  'ask.respond',
  'permissions.setToolPolicy',
]);

/** vessel 依赖的本地 RPC 端口（bootstrap 的 LocalRpcDispatcher 的结构子集）。 */
export interface VesselRpcPort {
  dispatch: RpcDispatcher;
  manifest: () => CapabilityManifest;
}

export interface VesselMetaOptions {
  /** 晚绑定：装配完成前为 undefined（此时 rpc/set_config fail-closed）。 */
  getLocalRpc: () => VesselRpcPort | undefined;
  /**
   * O2：`permission.bridge_deny` 的活引用（热应用经 permission applier 更新）。
   * 缺省 = []（P1 行为零变化）；只影响桥可达性，不影响新会话直调。
   */
  getBridgeDeny?: () => readonly string[];
}

/** O2 配置归一：只留非空字符串，去重（别名解析在匹配时做，表唯一真源 core）。 */
export function normalizeBridgeDeny(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = new Set<string>();
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim() !== '') names.add(entry.trim());
  }
  return [...names];
}

export interface VesselMetaSurface {
  vessel: ToolDefinition;
  bridgeGuardrail: Guardrail;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * bridge 准入：vessel 自身不可桥（单跳递归防护，代码层硬排除，config 不可覆盖）；
 * 其余 live 注册表工具默认可桥，安全性靠「鉴权落在目标自身规则」——高危分级由目标自己的
 * checkPermission / 默认 ask 继承，桥不放宽任何一条。
 * O2（permission.bridge_deny，缺省 [] = P1 行为零变化）：精确工具名匹配，别名经同一
 * TOOL_NAME_ALIASES 表解析（core resolveToolNameAlias，单实现）；命中 → 拦 call_tool，
 * 只影响桥可达性，不影响新会话直调。
 */
function isBridgeEligible(toolName: string, bridgeDeny: readonly string[]): boolean {
  if (toolName === VESSEL_TOOL_NAME) return false;
  if (bridgeDeny.length === 0) return true;
  const resolved = resolveToolNameAlias(toolName);
  return !bridgeDeny.some((entry) => resolveToolNameAlias(entry) === resolved);
}

/**
 * RPC 方法级判定（唯一真源 = dispatcher.manifest 的方法 permission，与分发表同源）。
 * 未知方法 / 控制面不可用一律 deny（fail-closed）；方法发现走 capabilities.list。
 */
function rpcMethodDecision(
  rpc: VesselRpcPort | undefined,
  method: string,
): 'allow' | 'deny' | 'ask' {
  if (RPC_SELF_SERVICE_DENYLIST.has(method)) return 'deny';
  const entry = rpc?.manifest().methods.find((candidate) => candidate.name === method);
  if (entry === undefined) return 'deny';
  if (entry.permission === 'admin') return 'deny';
  if (entry.permission === 'write') return 'ask';
  return 'allow';
}

/** 经既有本地 dispatcher 执行 RPC；失败折稳定错误文本（run 继续，模型自修）。 */
async function executeRpc(
  rpc: VesselRpcPort | undefined,
  method: string | undefined,
  params: unknown,
): Promise<string> {
  if (method === undefined) {
    return 'Error: invalid vessel arguments: method must be a non-empty string';
  }
  if (rpc === undefined) {
    return 'Error: RPC control plane is not available at this entry (not_supported)';
  }
  // params 原样透传：形状校验交给 dispatcher 的 normalizeParams / params_schema（不另造一份）。
  let response: RpcResponse;
  try {
    response = await rpc.dispatch({
      v: 1,
      id: randomUUID(),
      method,
      ...(params !== undefined ? { params } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Error: RPC ${method} failed: [internal] ${message}`;
  }
  if (response.ok) return JSON.stringify(response.result ?? null);
  return `Error: RPC ${method} failed: [${response.error.code}] ${response.error.message}`;
}

function block(reason: string): GuardrailResult {
  return { allowed: false, reason };
}

/** replacement 保留原 tool_call.id；arguments 序列化为 JSON 字符串（ToolCall 形状）。 */
function replace(id: string, name: string, args: Record<string, unknown>): GuardrailResult {
  const replacement: ToolCall = {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
  // O4 溯源：打标 replacement 对象（WeakMap 随对象回收）；loop started / EU completed/failed 读。
  markBridgeCall(replacement);
  return { allowed: true, replacement };
}

/**
 * 翻译 vessel 调用：**只改写 op=call_tool**（→ 目标工具）；op=rpc / set_config 校验形状后
 * 原样放行（vessel 自执行，鉴权在 vessel.checkPermission）。非 vessel 的值一律放行。
 * arguments JSON 解析失败也放行——落 loop 的标准 `Invalid JSON in tool arguments` 路径。
 */
function translateVesselCall(value: unknown, bridgeDeny: readonly string[]): GuardrailResult {
  if (!isRecord(value)) return { allowed: true };
  const fn = value.function;
  if (!isRecord(fn) || fn.name !== VESSEL_TOOL_NAME) return { allowed: true };
  const id = value.id;
  if (typeof id !== 'string') return { allowed: true };

  let args: unknown;
  try {
    args = typeof fn.arguments === 'string' && fn.arguments !== '' ? JSON.parse(fn.arguments) : {};
  } catch {
    return { allowed: true };
  }
  if (!isRecord(args)) return block('vessel arguments must be a JSON object');

  const op = readString(args.op);
  if (op === 'call_tool') {
    const toolName = readString(args.tool_name);
    if (toolName === undefined) return block('vessel call_tool requires a non-empty tool_name');
    if (toolName === VESSEL_TOOL_NAME) {
      return block(
        `vessel call_tool target "${toolName}" is not bridge-eligible (vessel itself is excluded; recursion guard)`,
      );
    }
    if (!isBridgeEligible(toolName, bridgeDeny)) {
      return block(`vessel call_tool target "${toolName}" is denied by permission.bridge_deny`);
    }
    if (args.args !== undefined && !isRecord(args.args)) {
      return block('vessel call_tool args must be an object');
    }
    // 目标不在 live 注册表时不在此拦：管道重 getTool 兜底标准 tool_not_found（稳定错误）。
    return replace(id, toolName, args.args ?? {});
  }
  if (op === 'rpc') {
    if (readString(args.method) === undefined)
      return block('vessel rpc requires a non-empty method');
    if (args.params !== undefined && !isRecord(args.params)) {
      return block('vessel rpc params must be an object');
    }
    return { allowed: true };
  }
  if (op === 'set_config') {
    if (readString(args.key) === undefined)
      return block('vessel set_config requires a non-empty key');
    if (args.value === undefined) return block('vessel set_config requires a value');
    return { allowed: true };
  }
  return block('vessel requires op to be one of: call_tool, rpc, set_config');
}

/** 构造 vessel 元工具面（单工具 + 桥 guardrail），由装配层注册进 PluginHost。 */
export function createVesselMetaSurface(options: VesselMetaOptions): VesselMetaSurface {
  const vessel: ToolDefinition = {
    name: VESSEL_TOOL_NAME,
    description:
      'Vessel control-plane bridge. op=call_tool: invoke a registered tool that is not directly ' +
      'callable in this session (tool_name + args). op=rpc: invoke a Vessel RPC method ' +
      '(method + params; discover methods with op=rpc, method=capabilities.list). ' +
      'op=set_config: change a configuration key (key + value; requires approval). ' +
      'Prefer direct tool calls when the tool is available.',
    inputSchema: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['call_tool', 'rpc', 'set_config'],
          description: 'Operation to perform.',
        },
        tool_name: { type: 'string', description: 'call_tool: name of the target tool.' },
        args: { type: 'object', description: 'call_tool: arguments for the target tool.' },
        method: {
          type: 'string',
          description:
            'rpc: RPC method name, e.g. sessions.list. gateway.restart reserves a graceful ' +
            'self-restart of this node (params: prompt? — omit it for request-level auto-resume; ' +
            'wait_timeout_ms?): the orchestrator waits for this run to finish, then restarts the ' +
            'fleet and delivers the continuation; finish this turn right after it succeeds.',
        },
        params: { type: 'object', description: 'rpc: method parameters.' },
        key: { type: 'string', description: 'set_config: configuration key.' },
        value: {
          description: 'set_config: new value (boolean for boolean keys, string otherwise).',
        },
      },
      required: ['op'],
    },
    // 方法级鉴权落在工具自判（ADR-026），对最终 args 生效（ADR-058 决策 2）：
    // rpc/set_config 按方法分层；call_tool 与未知 op 一律 deny（fail-closed，必须经 guardrail 改写）。
    checkPermission: async (input) => {
      if (!isRecord(input)) return 'deny';
      const op = readString(input.op);
      if (op === 'rpc') {
        const method = readString(input.method);
        if (method === undefined) return 'deny';
        if (input.params !== undefined && !isRecord(input.params)) return 'deny';
        return rpcMethodDecision(options.getLocalRpc(), method);
      }
      if (op === 'set_config') {
        if (readString(input.key) === undefined || input.value === undefined) return 'deny';
        // 键白名单 / 值校验在 config.set handler；permission.* 不可写，无自升级路径。
        return rpcMethodDecision(options.getLocalRpc(), 'config.set');
      }
      return 'deny';
    },
    // rpc/set_config 自执行（checkPermission 已按方法判定）；call_tool 永不转发。
    handler: async (input, ctx) => {
      const args = isRecord(input) ? input : {};
      const op = readString(args.op);
      if (op === 'rpc') {
        const method = readString(args.method);
        let params = args.params;
        // q-restart-tool：gateway.restart 触发者身份专项补注——RPC handler 拿不到
        // ToolContext，这里把 ctx.session_id / run_id 填进缺省参数（与 bash 工具注入
        // VESSEL_SESSION_ID / VESSEL_RUN_ID 同口径）；显式传入的参数优先。additive，
        // 只影响本方法，其它 RPC 仍原样透传。
        if (method === 'gateway.restart') {
          const record = isRecord(params) ? params : {};
          params = {
            ...record,
            ...(readString(record.session_id) === undefined &&
            ctx.session_id !== undefined &&
            ctx.session_id !== ''
              ? { session_id: ctx.session_id }
              : {}),
            ...(readString(record.run_id) === undefined &&
            ctx.run_id !== undefined &&
            ctx.run_id !== ''
              ? { run_id: ctx.run_id }
              : {}),
          };
        }
        return executeRpc(options.getLocalRpc(), method, params);
      }
      if (op === 'set_config') {
        return executeRpc(options.getLocalRpc(), 'config.set', {
          key: args.key,
          value: args.value,
        });
      }
      if (op === 'call_tool') {
        return (
          'Error: vessel call_tool is fail-closed: it must be translated by the vessel-bridge ' +
          'guardrail. This entry did not run the bridge (guardrail stage disabled).'
        );
      }
      return 'Error: vessel requires op to be one of: call_tool, rpc, set_config';
    },
  };

  const bridgeGuardrail: Guardrail = {
    name: VESSEL_BRIDGE_GUARDRAIL_NAME,
    stage: GuardrailStage.ToolCall,
    // 先于 tool-policy（50）：允许/禁止策略落在改写后的最终工具上。
    priority: 40,
    check: async (value) => translateVesselCall(value, options.getBridgeDeny?.() ?? []),
  };

  return { vessel, bridgeGuardrail };
}
