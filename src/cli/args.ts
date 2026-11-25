/**
 * CLI 参数解析（纯函数）
 *
 * 从 cli.ts 抽出，便于单测覆盖每个入口。解析只负责语法与互斥，
 * 不加载配置、不构造 runtime、不产生副作用。
 */

import { allowedOriginError } from '../../packages/config/src/index';
import { parseFederationAddress } from '../federation/federation-address';
import type { DevCommandArgs } from './commands/dev-command';
import { type CompletionCommandArgs, isCompletionShell } from './completion-spec';

/** `--serve` 省略端口时的默认值 */
export const DEFAULT_SERVE_PORT = 8642;

export interface UpdateArgs {
  check: boolean;
  channel?: 'latest' | 'beta';
  json: boolean;
  force: boolean;
  /** 跳过自更新确认（DECISION-023 §2.4） */
  yes: boolean;
}

/** 支持的服务管理器（DECISION-023 §2.2） */
export type GatewayInstallTarget = 'systemd' | 'launchd' | 'schtasks';

/** gateway 实例选择器（0.14；三者互斥，all 单独使用） */
export interface GatewaySelector {
  instance?: string;
  port?: number;
  all?: boolean;
}

/** `vessel gateway` 子命令（DECISION-023 §2.1；0.14 增加多实例） */
export type GatewayCommand =
  | {
      kind: 'start';
      daemon: boolean;
      instance?: string;
      port?: number;
      host?: string;
      log?: string;
    }
  | ({
      kind: 'stop';
      timeoutMs: number;
      /**
       * 0.55.1：缺省只停平台层，**不动 node/hub**（它们身上可能跑着会话，杀掉不可恢复）。
       * 破坏性动作要显式：`--stop-nodes` 才连 node/hub 一起停（整舰队真停）；
       * `--keep-nodes` / `--no-keep-nodes` 保留解析作兼容别名（前者等价缺省，后者等价 --stop-nodes）。
       */
      keepNodes?: boolean;
    } & GatewaySelector)
  | ({ kind: 'status'; json: boolean; rpc?: boolean } & GatewaySelector)
  | { kind: 'list'; json: boolean }
  | ({
      kind: 'restart';
      /**
       * 运行模式：true = 显式 `--daemon`（强制后台）；缺省（undefined）= 保持
       * 当前实例的运行模式，由 cli.ts 分发前读 pid record 的 `daemon` 标记解析
       * （`resolveRestartDaemonMode`）；旧记录无标记时回落前台。
       */
      daemon?: boolean;
      /**
       * 0.55.1：缺省只换平台层（handoff），node/hub 留活并被新平台 adopt（不杀会话）。
       * 要连 node/hub 一起冷重启，显式写 `--stop-nodes`；`--keep-nodes` / `--no-keep-nodes`
       * 保留作兼容别名（前者等价缺省，后者等价 --stop-nodes）。
       */
      keepNodes?: boolean;
    } & GatewaySelector)
  | ({ kind: 'reload'; scopes?: string[] } & GatewaySelector)
  | { kind: 'install-service'; target?: GatewayInstallTarget }
  | { kind: 'uninstall-service' };

/**
 * `vessel node` 子命令（0.49 G1）。
 *
 * node 命名空间只操作 Node API 监听与共享的实例 PID/锁；端口由
 * `serve.port`（缺省 8644）决定，不新增 `--node-port`。
 */
export type NodeCommand =
  | { kind: 'start'; daemon: boolean; configPath?: string }
  | { kind: 'status'; json: boolean; rpc: boolean }
  | { kind: 'stop' }
  | { kind: 'reload'; scopes?: string[] }
  /**
   * 0.56：`vessel node token [--print] [--json] [--node <id>]`。
   * 不带 `--print` 只说明 token 来源；带 `--print` 才打印值（仅交互式终端）。
   */
  | { kind: 'token'; print: boolean; json: boolean; nodeId?: string };

/**
 * `vessel token ...` 子命令（0.56：单一根密钥 + 派生 token）。
 *
 * - `show --purpose <p> [--node <id>] [--json]`：打印**值**（仅回环 + 交互式）；
 * - `list [--json]`：只给 purpose + 指纹前 8 位，永不打印值；
 * - `rotate --yes [--json]`：新根密钥 ⇒ 所有派生 token 一起换。
 */
export type TokenCommand =
  | {
      kind: 'show';
      purpose: string;
      id?: string;
      json: boolean;
      allowNonInteractive: boolean;
      dataDir?: string;
    }
  | { kind: 'list'; json: boolean; dataDir?: string }
  | { kind: 'rotate'; yes: boolean; json: boolean; dataDir?: string };

/**
 * `vessel gateway nodes` 子命令（0.49 G3a）。
 *
 * registry 属平台：`add/remove` 只写 `nodes.json`，不启动 / 停止进程；
 * `--data-dir` 是 **node** 的数据目录，不是全局 `--data-dir`。
 */
export type GatewayNodesCommand =
  | { kind: 'list'; json: boolean }
  | {
      kind: 'add';
      name: string;
      dataDir: string;
      configPath: string;
      autoStart: boolean;
    }
  | { kind: 'remove'; name: string };

export interface EvalCommand {
  target: string;
  json: boolean;
  out?: string;
  filters: string[];
  allowNetwork: boolean;
}

/** `config` 子命令（0.5；0.11 增加 set） */
export type ConfigCommandArgs =
  | { kind: 'path'; json: boolean }
  | { kind: 'init'; json: boolean; force: boolean }
  | { kind: 'show'; json: boolean; sources: boolean }
  | { kind: 'explain'; key: string; json: boolean }
  | {
      kind: 'set';
      key:
        | 'ui.language'
        | 'ui.showReasoning'
        | 'ui.statusBars'
        | 'ui.verbosity'
        | 'ui.showInternalEvents'
        | 'ui.errorLevel'
        | 'ui.askUser'
        | 'ui.expandCards'
        | 'observability.showProcessErrors'
        | 'agent.cwd';
      value: string;
      json: boolean;
    };

/** `migrate` 子命令（0.5） */
export interface MigrateCommandArgs {
  from: string;
  to: string;
  apply: boolean;
  json: boolean;
  source?: string;
}

/** `trace` 子命令（0.5） */
export type TraceCommandArgs = {
  kind: 'prune';
  dryRun: boolean;
  json: boolean;
};

/** `prune` 子命令（0.51）：缺省 dry-run，`--yes` 才真删；判据是状态，`--older-than` 只是可选叠加 */
export interface PruneCommandArgs {
  yes: boolean;
  dryRun: boolean;
  json: boolean;
  /** `--older-than` 解析出的毫秒数；缺省 = 不叠加时间条件（只看状态） */
  olderThanMs?: number;
}

/** `plugin` 子命令（0.6.1；仅本地目录，不做市场） */
export type PluginCommandArgs =
  | { kind: 'list'; json: boolean }
  | { kind: 'install'; path: string; force: boolean }
  | { kind: 'remove'; name: string; yes: boolean }
  | { kind: 'enable'; name: string }
  | { kind: 'disable'; name: string };

/** `doctor` 子命令（0.6.1；0.15 增加 --deep） */
export interface DoctorCommandArgs {
  json: boolean;
  /** 仅显式给出 `--deep` 时存在（additive） */
  deep?: boolean;
}

/** `logs` 子命令（0.15） */
export interface LogsCommandArgs {
  kind: 'tail';
  json: boolean;
  lines: number;
  instance?: string;
}

/** 成员可见性（CLI 语法层） */
export type AgentVisibilityArg = 'private' | 'team' | 'tenant';

/** 成员状态（CLI 语法层；与 MemberState 同名同义） */
export type AgentStateArg =
  | 'created'
  | 'idle'
  | 'running'
  | 'waiting_permission'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'closed'
  | 'stale';

/** `vessel agent ...` 子命令（0.17 Phase A） */
export type AgentCommand =
  | {
      kind: 'create';
      json: boolean;
      name?: string;
      model?: string;
      visibility?: AgentVisibilityArg;
      systemPrompt?: string;
      /** 0.19 S3：显式 workspace → 隐式建 / 复用 Team 并绑定 */
      workspace?: string;
    }
  | {
      kind: 'send';
      json: boolean;
      member: string;
      content: string;
      /** 0.32：打断当前 run（可只带 --message-id）。 */
      interrupt?: boolean;
      /** 按 id 重投已有 inbox 消息；必须与 --interrupt 同用。 */
      messageId?: string;
    }
  | { kind: 'inbox'; json: boolean; member: string }
  | {
      kind: 'dispatch';
      json: boolean;
      to: string;
      content: string;
      allowAutoCreate?: boolean;
    }
  | { kind: 'close'; json: boolean; members: string[] }
  | { kind: 'list'; json: boolean; visibility?: AgentVisibilityArg; state?: AgentStateArg };

/** 预算维度（与 `teams.budget` 契约一致） */
export type TeamBudgetDimension = 'hops' | 'turns' | 'tokens' | 'wall_clock' | 'cycle';

/** `vessel team ...` 子命令（0.19 S3；S4 增加 budget） */
export type TeamCommand =
  | { kind: 'list'; json: boolean }
  | {
      /** S10.3：创建空 Team；workspace 已有 Team 时幂等复用。 */
      kind: 'create';
      workspace: string;
      name?: string;
      description?: string;
      /** 内联 JSON 对象；与 policyFile 互斥。 */
      policy?: Record<string, unknown>;
      /** 从文件读取 JSON 对象；与 policy 互斥。优先用于复杂策略。 */
      policyFile?: string;
      json: boolean;
    }
  | {
      /** S10.3：只改显示信息；`null` 清空可选项。 */
      kind: 'update';
      teamId: string;
      name?: string;
      description?: string | null;
      /** 内联 JSON 对象；与 policyFile 互斥。整体替换。 */
      policy?: Record<string, unknown>;
      /** 从文件读取 JSON 对象；与 policy 互斥。整体替换。 */
      policyFile?: string;
      json: boolean;
    }
  | { kind: 'archive'; teamId: string; json: boolean }
  /** 0.27：冻结 / 解冻 Team 的 spawn（仍受成员上限约束）。 */
  | { kind: 'freeze'; teamId: string; json: boolean }
  | { kind: 'unfreeze'; teamId: string; json: boolean }
  | { kind: 'get'; teamId: string; limit?: number; members?: number; json: boolean }
  /**
   * 0.51：看一个 Team 的基础信息（名称 / workspace / policy / frozen / 成员数）。
   * `team` 可以是 `team_id`，也可以是名字或 workspace 目录名（命令层解析）。
   */
  | { kind: 'show'; team: string; json: boolean }
  /** 0.51：按当前工作目录反查所属 Team（workspace 包含关系）。 */
  | { kind: 'mine'; json: boolean }
  | { kind: 'post'; teamId: string; content: string; mentions: string[]; json: boolean }
  | {
      kind: 'members';
      teamId: string;
      action: 'add' | 'remove';
      member: string;
      json: boolean;
    }
  | { kind: 'budget-status'; teamId: string; conversationId?: string; json: boolean }
  | {
      kind: 'budget-override';
      teamId: string;
      conversationId: string;
      dimension: TeamBudgetDimension;
      max: number | null;
      json: boolean;
    };

/** `vessel federation ...` 子命令（S7.1；0.21 地址寻址） */
export type FederationCommand =
  | {
      kind: 'post';
      /** `<principal>@<node_id>:<team_id>`；命令层解析与本地预校验 */
      to: string;
      /** `<principal>@<node_id>:<team_id>`；必须是本机节点 */
      from: string;
      content: string;
      conversationId?: string;
      json: boolean;
    }
  | {
      kind: 'team-info';
      /** `<principal>@<node_id>:<team_id>`；principal 不参与查询 */
      to: string;
      members?: number;
      json: boolean;
    }
  | { kind: 'peers'; json: boolean }
  /** `federation peer add`：写用户配置 federation.peers（对象数组，不走标量 config.set）。 */
  | {
      kind: 'peer-add';
      nodeId: string;
      teamId: string;
      tokenEnv: string;
      url?: string;
      direction: 'in' | 'out' | 'both';
      localTeamId?: string;
      allowDirectory: boolean;
      caFile?: string;
      json: boolean;
    }
  /** `federation peer list`：与 `federation peers` 同一渲染（token 绝不打印）。 */
  | { kind: 'peer-list'; json: boolean }
  /** `federation peer remove <label|node-id>`：label = `<nodeId>:<teamId>`。 */
  | { kind: 'peer-remove'; target: string; json: boolean }
  /** q-fed-simple：target 侧出一次性配对码（明文只打印一次）。 */
  | { kind: 'pair-code'; ttl?: number; json: boolean }
  /** q-fed-simple：与目标节点握手配对（token 自动交换 + 两侧自动写配置热应用）。 */
  | {
      kind: 'join';
      /** 目标 node base URL 或 node_id（经本地 hub registry 解析回环 url）。 */
      target: string;
      code?: string;
      /** 本机 team（缺省 vessel）。 */
      teamId: string;
      /** 对端 team（缺省 = teamId）。 */
      peerTeamId?: string;
      /** 本机 node base URL 覆盖（缺省从 node.hostname/port 派生）。 */
      selfUrl?: string;
      allowDirectory: boolean;
      json: boolean;
    }
  /** q-fed-simple：读本地 hub registry，列同机回环节点。 */
  | { kind: 'discover'; json: boolean };

/**
 * `vessel rpc ...` 子命令：capabilities.list 的 CLI 包装（AX 自服务 · 能力发现）。
 * targeting（--node / --connect / --connect-token / --ca）复用全局字段，
 * 由 extractTargetFlags 前置摘出（与 agent / team 同机制）。
 */
export type RpcCommand = { kind: 'list'; json: boolean };

/**
 * `vessel fleet ...` 子命令：本舰队一屏总览（AX 自服务 · 发现组）。
 * 本地只读命令：不接受 targeting（--connect / --node），严格本舰队 dataDir。
 */
export type FleetCommand = { kind: 'status'; json: boolean };

/**
 * `vessel model ...` 子命令：model-registry 插件 canonical RPC 的 CLI 包装。
 *
 * kind 与 `plugin.model-registry.<name>` 一一对应（kebab → snake 在命令层映射）。
 * credential-set 的 value 不在 argv 出现：只经 `--value-env` / `--value-stdin` /
 * 交互隐藏输入三条路（命令层解析），这里只携带来源声明。
 */
export type ModelCommand =
  | { kind: 'list'; json: boolean }
  | { kind: 'vendor-set'; id: string; entry: unknown; json: boolean }
  | { kind: 'vendor-remove'; id: string; json: boolean }
  | { kind: 'alias-set'; alias: string; ref: string; json: boolean }
  | { kind: 'alias-remove'; alias: string; json: boolean }
  | { kind: 'set-default'; ref: string; json: boolean }
  | {
      kind: 'credential-set';
      id: string;
      valueEnv?: string;
      valueStdin: boolean;
      json: boolean;
    }
  | { kind: 'credential-remove'; id: string; json: boolean }
  | { kind: 'credentials-list'; json: boolean }
  | { kind: 'test'; vendor: string; model?: string; json: boolean };

/** `vessel hub ...` 子命令（S5） */
export type HubCommand =
  | {
      kind: 'start';
      host?: string;
      port?: number;
      dataDir?: string;
      allowRemote?: boolean;
      tlsCert?: string;
      tlsKey?: string;
    }
  | { kind: 'directory'; hubUrl?: string; tokenEnv?: string; json: boolean }
  | { kind: 'watch'; hubUrl?: string; tokenEnv?: string }
  | { kind: 'join-code'; dataDir?: string; ttl?: number; json: boolean }
  | {
      kind: 'join';
      hubUrl?: string;
      code?: string;
      codeEnv?: string;
      publicUrl?: string;
      caFile?: string;
      dataDir?: string;
      json: boolean;
    }
  | { kind: 'node-list'; hubUrl?: string; json: boolean }
  | { kind: 'node-remove'; pairingId: string; hubUrl?: string };

/**
 * `vessel attention ...`（0.22 S9.1）。
 *
 * `kind: 'list'` 只允许列表参数；`kind: 'respond'` 必须恰好一个目标来源
 * （positional requestId / `--select` / `--all`），且 `--all` 必须带 `--yes`。
 * 连接参数由本命令自行解析（top-level parser 在 i===0 提前返回）。
 */
export interface AttentionCommandArgs {
  kind: 'list' | 'respond';
  connectUrl?: string;
  connectToken?: string;
  caFile?: string;
  /** S9.4：配置中的节点名（`--node`）；与 `--connect` 互斥。 */
  node?: string;
  /** S9.4：聚合所有配置节点（`--all-nodes`）；仅列表。缺省 false。 */
  allNodes?: boolean;
  /** 已通过 `parseFederationAddress` 校验；只用于定位节点与缺省 team。 */
  to?: string;
  teamId?: string;
  agent?: string;
  /** 缺省 `pending`（运行时按 pending 请求）。 */
  status: 'pending' | 'orphaned';
  /** 缺省不传，由服务端保持 `newest`。 */
  order?: 'oldest' | 'newest';
  limit: number;
  cursor?: string;
  json: boolean;
  interactive: boolean;
  requestId?: string;
  select?: number[];
  all: boolean;
  decision?: 'allow' | 'deny';
  answers?: unknown[];
  remember: boolean;
  yes: boolean;
}

/**
 * AX 自服务 · 自观：`vessel session status [--id <session>] [--json]`。
 *
 * 缺省 = 调用者自身（CLI 上下文 = operator，即 `main` primary body）；
 * `--id` 显式指定会话。连接参数复用全局字段（`extractTargetFlags` 摘出）。
 */
export type SessionCommand = {
  kind: 'status';
  /** 显式会话 id；缺省由命令解析调用者自身。 */
  id?: string;
  json: boolean;
};

/**
 * AX 自服务 · 自观：`vessel permission show [--member <id>] [--json]`。
 *
 * 缺省 = 调用者自身权限（CLI 上下文 = operator → 节点级矩阵）；
 * `--member` 限本舰队成员（服务端只认本节点 AgentService）。
 */
export type PermissionCommand = {
  kind: 'show';
  /** 本舰队成员 id；缺省 = 节点级矩阵。 */
  member?: string;
  json: boolean;
};

export interface CliArgs {
  /** `vessel demo`：无 Key 交互演示（mock + tools 场景） */
  demo: boolean;
  /** null = 非 headless；'' = 从 stdin 读；非空 = 文本 prompt 或 @file */
  runArg: string | null;
  /** `--pipe` 隐藏别名，等价 `--run` 无参 */
  pipeMode: boolean;
  sessionArg: string | null;
  /** 0.6.1：`-c/--continue`（续接最近会话） */
  continueArg: boolean;
  /** 0.6.1：null = 未使用；'' = 列出会话；非空 = 恢复该会话 */
  resumeArg: string | null;
  /** null = 不启动 gateway；0 = 由系统分配端口 */
  servePort: number | null;
  /** 端口是否由用户显式给出（用于 config serve.port 回退） */
  servePortExplicit: boolean;
  /** --serve-host <host>；null = 未指定 */
  serveHost: string | null;
  /** --allow-remote：显式允许非回环监听 */
  allowRemote: boolean;
  /** --tls-cert <path> / --tls-key <path>：必须成对 */
  tlsCert: string | null;
  tlsKey: string | null;
  /** null = 未使用；'' = 列出可恢复 run；非空 = 恢复该 run */
  resumeRunArg: string | null;
  help: boolean;
  version: boolean;
  tools: boolean;
  /** `vessel update ...` 子命令 */
  update: UpdateArgs | null;
  /** `vessel eval ...` 子命令 */
  eval: EvalCommand | null;
  /** 0.4：附加开关；只与 run/pipe/resume/tools/version/help 互斥 */
  feishu: boolean;
  /** 0.5：`--connect <url>`（或 VESSEL_CONNECT，由 cli 合并） */
  connectArg: string | null;
  /** 0.6：`--connect-token <token>`（最高优先级；不回显） */
  connectTokenArg: string | null;
  /** 0.6：`--ca <path>`（自签/私有 CA，PEM） */
  caArg: string | null;
  /**
   * q-node-target：`--node <id>`（经平台代理 `/nodes/<id>/v1/rpc` 打到指定 node）。
   * 目前由 `agent` / `team` 子命令解析器摘出；null = 未指定（照旧本地 owner）。
   * 与 `--connect` 组合 = 远端平台代理；单独 = 本地平台代理。
   */
  nodeTargetArg: string | null;
  /** 0.6：`--allowed-origin <origin>`（可重复；需 --serve） */
  allowedOrigins: string[];
  /** 0.5 一次性本地命令 */
  configCommand: ConfigCommandArgs | null;
  migrate: MigrateCommandArgs | null;
  trace: TraceCommandArgs | null;
  /** 0.6.1：`vessel plugin ...` */
  pluginCommand: PluginCommandArgs | null;
  /** 0.6.1：`vessel doctor` */
  doctorCommand: DoctorCommandArgs | null;
  /** 0.15：`vessel logs tail` */
  logsCommand: LogsCommandArgs | null;
  /** 0.15：全局 `--data-dir <path>`；null = 未指定 */
  dataDirArg: string | null;
  /**
   * 0.56.1：全局 `--user-config <path>`；null = 未指定（用 `~/.vessel/config.yaml`）。
   *
   * **只替换用户层**：项目 config / env / CLI 参数的原有优先级不变。
   * 参数会被落到 `VESSEL_USER_CONFIG`，因此 daemon / node / hub 子进程一致生效；
   * 显式给出但文件不存在 → 加载时报错（不静默回落，避免「以为在验空配置」）。
   */
  userConfigArg: string | null;
  /** 0.12：`vessel gateway ...` */
  gateway: GatewayCommand | null;
  /** 0.49 G3：`vessel gateway nodes ...`（registry 管理；与一次性 gateway 命令互斥） */
  gatewayNodes: GatewayNodesCommand | null;
  /** 0.49 G1：`vessel node ...` */
  node: NodeCommand | null;
  /** 0.56：`vessel token ...`（根密钥 / 派生 token） */
  tokenCommand?: TokenCommand | null;
  /** 0.14：`vessel status [--json]` */
  statusCommand: { json: boolean } | null;
  /**
   * 舰队级 `vessel stop`（CONTRACT-stop-semantics S1）。
   * 远程参数复用全局字段 connectArg/connectTokenArg/caArg（零新解析实体）。
   */
  stopCommand: { yes: boolean; timeoutMs: number; selector: GatewaySelector } | null;
  /** 0.14：`vessel agents [--json]` */
  agentsCommand: { json: boolean } | null;
  /** 0.17：`vessel agent create|send|inbox|close|list|dispatch` */
  agentCommand: AgentCommand | null;
  /** 0.19 S3：`vessel team list|get|post|members`；0.24：create|update|archive */
  teamCommand: TeamCommand | null;
  /** S7.1：`vessel federation post|peers` */
  federationCommand?: FederationCommand | null;
  /** S5：`vessel hub ...`；缺省 null（可选以兼容既有 parseArgs 快照测试） */
  hubCommand?: HubCommand | null;
  /** AX 自服务 · 自观：`vessel session status`；可选以兼容既有 parseArgs 快照测试 */
  sessionCommand?: SessionCommand | null;
  /** AX 自服务 · 自观：`vessel permission show`；可选以兼容既有 parseArgs 快照测试 */
  permissionCommand?: PermissionCommand | null;
  /** 0.14：`vessel errors [--json] [--limit N]` */
  errorsCommand: { json: boolean; limit?: number } | null;
  /** 0.18：`vessel completion <bash|zsh|fish|powershell>` */
  completionCommand: CompletionCommandArgs | null;
  /** 0.22 S9.1：`vessel attention [respond]` */
  attentionCommand: AttentionCommandArgs | null;
  /** `vessel model ...`（model-registry RPC 包装） */
  modelCommand: ModelCommand | null;
  /**
   * `vessel rpc ...`（AX 自服务 · capabilities.list 包装）。
   * 可选以兼容既有 parseArgs 快照测试（与 hubCommand / tokenCommand 同先例）。
   */
  rpcCommand?: RpcCommand | null;
  /** `vessel fleet ...`（本舰队总览；可选以兼容既有 parseArgs 快照测试）。 */
  fleetCommand?: FleetCommand | null;
  /** 0.49：`vessel dev reset [--yes] [--dry-run] [--json]` */
  devCommand: DevCommandArgs | null;
  /** 0.51：`vessel prune [--yes] [--dry-run] [--json] [--older-than <dur>]` */
  prune: PruneCommandArgs | null;
}

export type ParseResult = { ok: true; args: CliArgs } | { ok: false; error: string };

// 0 是合法值：由系统分配（team loopback 节点推荐）
const MIN_PORT = 0;
const MAX_PORT = 65535;

/** 解析十进制端口；非法返回 null */
function parsePort(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const port = Number.parseInt(raw, 10);
  if (port < MIN_PORT || port > MAX_PORT) return null;
  return port;
}

/**
 * 把全局 `--user-config <path>` 从 argv 里摘出来（0.56.1）。
 *
 * 为什么先摘：它是**跨命令**的（gateway / node / doctor / token / config / status…），
 * 放在每个子命令解析器里重复一遍既容易漏、又会和 `--data-dir` 的「按子命令语义」
 * 混在一起。摘出来之后，参数由 `cli.ts` 落到 `VESSEL_USER_CONFIG`，spawn 出的
 * daemon / node / hub 也一致携带。
 *
 * 只认 `--user-config <path>` 与 `--user-config=<path>` 两种写法；缺值 → 报错。
 */
function extractUserConfigFlag(
  argv: readonly string[],
): { ok: true; argv: string[]; value: string | null } | { ok: false; error: string } {
  const rest: string[] = [];
  let value: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--user-config') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-') || next.trim() === '') {
        return { ok: false, error: 'Missing value for --user-config' };
      }
      value = next;
      i++;
      continue;
    }
    if (a.startsWith('--user-config=')) {
      const inline = a.slice('--user-config='.length).trim();
      if (inline === '') return { ok: false, error: 'Missing value for --user-config' };
      value = inline;
      continue;
    }
    rest.push(a);
  }
  return { ok: true, argv: rest, value };
}

/**
 * q-node-target：把 targeting 旗标从 `agent` / `team` 子命令 argv 里前置摘出。
 *
 * 为什么前置摘：这两个命令在 parseArgs 主循环 i===0 就进入各自子命令解析器，
 * 主循环的全局 `--connect` / `--ca` 够不着它们；逐个子命令重复一遍既容易漏、
 * 又会和位置参数（send/post 的 content）打架。仿 extractUserConfigFlag 先例，
 * 统一摘出后写回既有全局字段（connectArg/connectTokenArg/caArg）+ nodeTargetArg。
 *
 * 认 `--connect` / `--connect-token` / `--ca` / `--connect-ca` / `--node`，
 * 支持 `--flag value` 与 `--flag=value` 两种写法。缺值 → 报错。
 */
function extractTargetFlags(
  rest: readonly string[],
  args: CliArgs,
): { ok: true; rest: string[] } | { ok: false; error: string } {
  const remaining: string[] = [];
  const assign = (flag: string, value: string): void => {
    if (flag === '--connect') args.connectArg = value;
    else if (flag === '--connect-token') args.connectTokenArg = value;
    else if (flag === '--ca' || flag === '--connect-ca') args.caArg = value;
    else if (flag === '--node') args.nodeTargetArg = value;
  };
  const flags = ['--connect', '--connect-token', '--ca', '--connect-ca', '--node'];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    const inline = flags.find((flag) => a.startsWith(`${flag}=`));
    if (inline !== undefined) {
      const value = a.slice(inline.length + 1).trim();
      if (value === '') return { ok: false, error: `Missing value for ${inline}` };
      assign(inline, value);
      continue;
    }
    if (flags.includes(a)) {
      const next = rest[i + 1];
      // token 值可能以 '-' 开头；其余（url/path/id）不允许。
      const dashOk = a === '--connect-token';
      if (next === undefined || next.trim() === '' || (!dashOk && next.startsWith('-'))) {
        return { ok: false, error: `Missing value for ${a}` };
      }
      assign(a, next);
      i++;
      continue;
    }
    remaining.push(a);
  }
  // connect 专属参数必须伴 --connect 或 --node（agent/team 只认显式 targeting）。
  const connectOnly = [
    args.connectTokenArg !== null ? '--connect-token' : null,
    args.caArg !== null ? '--ca' : null,
  ].filter((v): v is string => v !== null);
  if (connectOnly.length > 0 && args.connectArg === null && args.nodeTargetArg === null) {
    return { ok: false, error: `${connectOnly[0]} requires --connect or --node` };
  }
  return { ok: true, rest: remaining };
}

/**
 * 解析 argv（不含 node/bun 与脚本路径）。
 * 未知参数一律报错，不静默忽略。
 */
export function parseArgs(argv: string[]): ParseResult {
  const args: CliArgs = {
    demo: false,
    runArg: null,
    pipeMode: false,
    sessionArg: null,
    continueArg: false,
    resumeArg: null,
    servePort: null,
    servePortExplicit: false,
    serveHost: null,
    allowRemote: false,
    tlsCert: null,
    tlsKey: null,
    resumeRunArg: null,
    help: false,
    version: false,
    tools: false,
    update: null,
    eval: null,
    feishu: false,
    connectArg: null,
    connectTokenArg: null,
    caArg: null,
    nodeTargetArg: null,
    allowedOrigins: [],
    configCommand: null,
    migrate: null,
    trace: null,
    pluginCommand: null,
    doctorCommand: null,
    logsCommand: null,
    dataDirArg: null,
    userConfigArg: null,
    gateway: null,
    gatewayNodes: null,
    node: null,
    tokenCommand: null,
    statusCommand: null,
    stopCommand: null,
    agentsCommand: null,
    agentCommand: null,
    teamCommand: null,
    errorsCommand: null,
    completionCommand: null,
    attentionCommand: null,
    modelCommand: null,
    devCommand: null,
    prune: null,
  };

  // `--user-config <path>` 是**全局**参数：先整体摘出来（不参与子命令解析），
  // 这样 gateway/node/doctor/token/config/... 全部一致支持，也不会和任何子命令
  // 自己的同名旗标打架。它只替换**用户层**路径（见 loadConfig）。
  const userConfigScan = extractUserConfigFlag(argv);
  if (!userConfigScan.ok) return userConfigScan;
  argv = userConfigScan.argv;
  args.userConfigArg = userConfigScan.value;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';

    // `update` / `eval` / `config` / `migrate` / `trace`
    // 只允许作为第一个参数（子命令），其余位置按未知参数处理。
    if (a === 'update' && i === 0) {
      return parseUpdateArgs(argv.slice(1), args);
    }
    if (a === 'eval' && i === 0) {
      return parseEvalArgs(argv.slice(1), args);
    }
    if (a === 'config' && i === 0) {
      return parseConfigArgs(argv.slice(1), args);
    }
    if (a === 'migrate' && i === 0) {
      return parseMigrateArgs(argv.slice(1), args);
    }
    if (a === 'trace' && i === 0) {
      return parseTraceArgs(argv.slice(1), args);
    }
    if (a === 'plugin' && i === 0) {
      return parsePluginArgs(argv.slice(1), args);
    }
    if (a === 'doctor' && i === 0) {
      return parseDoctorArgs(argv.slice(1), args);
    }
    if (a === 'logs' && i === 0) {
      return parseLogsArgs(argv.slice(1), args);
    }
    if (a === 'gateway' && i === 0) {
      return parseGatewayArgs(argv.slice(1), args);
    }
    if (a === 'node' && i === 0) {
      return parseNodeArgs(argv.slice(1), args);
    }
    if (a === 'token' && i === 0) {
      return parseTokenArgs(argv.slice(1), args);
    }
    if (a === 'status' && i === 0) {
      return parseStatusArgs(argv.slice(1), args);
    }
    if (a === 'session' && i === 0) {
      return parseSessionArgs(argv.slice(1), args);
    }
    if (a === 'permission' && i === 0) {
      return parsePermissionArgs(argv.slice(1), args);
    }
    if (a === 'stop' && i === 0) {
      return parseStopArgs(argv.slice(1), args);
    }
    if (a === 'agents' && i === 0) {
      return parseAgentsArgs(argv.slice(1), args);
    }
    if (a === 'attention' && i === 0) {
      return parseAttentionArgs(argv.slice(1), args);
    }
    if (a === 'agent' && i === 0) {
      return parseAgentArgs(argv.slice(1), args);
    }
    if (a === 'team' && i === 0) {
      return parseTeamArgs(argv.slice(1), args);
    }
    if (a === 'federation' && i === 0) {
      return parseFederationArgs(argv.slice(1), args);
    }
    if (a === 'model' && i === 0) {
      return parseModelArgs(argv.slice(1), args);
    }
    if (a === 'rpc' && i === 0) {
      return parseRpcArgs(argv.slice(1), args);
    }
    if (a === 'fleet' && i === 0) {
      return parseFleetArgs(argv.slice(1), args);
    }
    if (a === 'hub' && i === 0) {
      return parseHubArgs(argv.slice(1), args);
    }
    if (a === 'errors' && i === 0) {
      return parseErrorsArgs(argv.slice(1), args);
    }
    if (a === 'demo' && i === 0) {
      return parseDemoArgs(argv.slice(1), args);
    }
    if (a === 'completion' && i === 0) {
      return parseCompletionArgs(argv.slice(1), args);
    }
    if (a === 'dev' && i === 0) {
      return parseDevArgs(argv.slice(1), args);
    }
    if (a === 'prune' && i === 0) {
      return parsePruneArgs(argv.slice(1), args);
    }

    switch (a) {
      case '--run':
      case '--print':
      case '-p': {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          args.runArg = next;
          i++;
        } else {
          args.runArg = '';
        }
        break;
      }
      case '-c':
      case '--continue':
        args.continueArg = true;
        break;
      case '-r':
      case '--resume': {
        // 0.6.1：`-r` 是 resume（不再等同 --run）；无 id = 列出会话。
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          args.resumeArg = next;
          i++;
        } else {
          args.resumeArg = '';
        }
        break;
      }
      case '--pipe':
        args.pipeMode = true;
        break;
      case '--session':
      case '-s': {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('-')) {
          return { ok: false, error: 'Missing value for --session' };
        }
        args.sessionArg = next;
        i++;
        break;
      }
      case '--serve': {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          const port = parsePort(next);
          if (port === null) {
            return { ok: false, error: `Invalid port for --serve: ${next}` };
          }
          args.servePort = port;
          args.servePortExplicit = true;
          i++;
        } else {
          args.servePort = DEFAULT_SERVE_PORT;
          args.servePortExplicit = false;
        }
        break;
      }
      case '--serve-host': {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('-') || next.trim() === '') {
          return { ok: false, error: 'Missing value for --serve-host' };
        }
        args.serveHost = next;
        i++;
        break;
      }
      case '--allow-remote':
        args.allowRemote = true;
        break;
      case '--tls-cert':
      case '--tls-key': {
        const next = argv[i + 1];
        const flag = a;
        if (next === undefined || next.startsWith('-') || next.trim() === '') {
          return { ok: false, error: `Missing value for ${flag}` };
        }
        if (flag === '--tls-cert') args.tlsCert = next;
        else args.tlsKey = next;
        i++;
        break;
      }
      case '--resume-run': {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          args.resumeRunArg = next;
          i++;
        } else {
          args.resumeRunArg = '';
        }
        break;
      }
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--version':
      case '-v':
        args.version = true;
        break;
      case '--tools':
        args.tools = true;
        break;
      case '--feishu':
        args.feishu = true;
        break;
      case '--data-dir': {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('-') || next.trim() === '') {
          return { ok: false, error: 'Missing value for --data-dir' };
        }
        args.dataDirArg = next;
        i++;
        break;
      }
      case '--connect': {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('-') || next.trim() === '') {
          return { ok: false, error: 'Missing value for --connect' };
        }
        args.connectArg = next;
        i++;
        break;
      }
      case '--connect-token': {
        const next = argv[i + 1];
        if (next === undefined || next.trim() === '') {
          return { ok: false, error: 'Missing value for --connect-token' };
        }
        args.connectTokenArg = next;
        i++;
        break;
      }
      case '--ca':
      case '--connect-ca': {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('-') || next.trim() === '') {
          return { ok: false, error: `Missing value for ${a}` };
        }
        args.caArg = next;
        i++;
        break;
      }
      case '--allowed-origin': {
        const next = argv[i + 1];
        if (next === undefined || next.trim() === '') {
          return { ok: false, error: 'Missing value for --allowed-origin' };
        }
        const message = allowedOriginError(next);
        if (message !== null) {
          return { ok: false, error: `Invalid --allowed-origin: ${message}` };
        }
        args.allowedOrigins.push(next);
        i++;
        break;
      }
      default:
        return { ok: false, error: `Unknown argument: ${a}` };
    }
  }

  // 0.5：客户端模式与服务端模式互斥。
  if (args.connectArg !== null && args.servePort !== null) {
    return { ok: false, error: '--connect cannot be combined with --serve' };
  }
  // 0.6：connect 专属参数只能用于连接（--connect 或 VESSEL_CONNECT）。
  const connectOnly = [
    args.connectTokenArg !== null ? '--connect-token' : null,
    args.caArg !== null ? '--ca' : null,
  ].filter((v): v is string => v !== null);
  if (
    connectOnly.length > 0 &&
    args.connectArg === null &&
    (process.env.VESSEL_CONNECT ?? '').trim() === ''
  ) {
    return { ok: false, error: `${connectOnly[0]} requires --connect` };
  }
  // 0.6：Origin allowlist 只服务 --serve。
  if (args.allowedOrigins.length > 0 && args.servePort === null) {
    return { ok: false, error: '--allowed-origin requires --serve' };
  }

  // --resume-run 是独立模式：不能与其它输入/服务/一次性命令组合（Addendum A §6）。
  if (args.resumeRunArg !== null) {
    const conflicts = [
      args.runArg !== null ? '--run' : null,
      args.pipeMode ? '--pipe' : null,
      args.servePort !== null ? '--serve' : null,
      args.sessionArg !== null ? '--session' : null,
      args.continueArg ? '--continue' : null,
      args.resumeArg !== null ? '--resume' : null,
      args.tools ? '--tools' : null,
    ].filter((v): v is string => v !== null);
    if (conflicts.length > 0) {
      return { ok: false, error: `--resume-run cannot be combined with ${conflicts.join('/')}` };
    }
  }

  // 0.6.1：会话续接 flag 互斥
  if (args.continueArg && args.resumeArg !== null) {
    return { ok: false, error: '--continue cannot be combined with --resume' };
  }
  if (args.continueArg && args.sessionArg !== null) {
    return { ok: false, error: '--continue cannot be combined with --session' };
  }
  if (args.resumeArg !== null && args.sessionArg !== null) {
    return { ok: false, error: '--resume cannot be combined with --session' };
  }
  if ((args.continueArg || args.resumeArg !== null) && args.servePort !== null) {
    return { ok: false, error: '--continue/--resume cannot be combined with --serve' };
  }
  if (args.continueArg && args.pipeMode) {
    return { ok: false, error: '--continue cannot be combined with --pipe' };
  }
  // `-r` 无 id = 列出会话：不能再要求一次 run 输入，也不能带会被忽略的模式开关。
  if (args.resumeArg === '') {
    if (args.runArg !== null) {
      return { ok: false, error: '--resume without an id cannot be combined with --run' };
    }
    if (args.pipeMode) {
      return { ok: false, error: '--resume without an id cannot be combined with --pipe' };
    }
    if (args.feishu) {
      return { ok: false, error: '--resume without an id cannot be combined with --feishu' };
    }
  }

  // TLS 必须成对；serve 专属参数必须有 --serve。
  if ((args.tlsCert !== null) !== (args.tlsKey !== null)) {
    return { ok: false, error: '--tls-cert and --tls-key must be provided together' };
  }

  const serveOnly = [
    args.serveHost !== null ? '--serve-host' : null,
    args.allowRemote ? '--allow-remote' : null,
    args.tlsCert !== null ? '--tls-cert' : null,
    args.tlsKey !== null ? '--tls-key' : null,
  ].filter((v): v is string => v !== null);
  if (serveOnly.length > 0 && args.servePort === null) {
    return { ok: false, error: `${serveOnly[0]} requires --serve` };
  }

  const oneShot = [
    args.help ? '--help' : null,
    args.version ? '--version' : null,
    args.tools ? '--tools' : null,
  ].filter((v): v is string => v !== null);

  if (oneShot.length > 1) {
    return { ok: false, error: `Cannot combine ${oneShot.join(' and ')}` };
  }
  if (
    oneShot.length === 1 &&
    (args.runArg !== null ||
      args.pipeMode ||
      args.servePort !== null ||
      args.continueArg ||
      args.resumeArg !== null)
  ) {
    return { ok: false, error: `${oneShot[0]} cannot be combined with --run/--serve/--continue` };
  }

  // 0.4：`--feishu` 是附加开关，可与 `--serve` / REPL / `--session` 同用；
  // 只与一次性输入命令互斥（Addendum B §11.3.5）。
  if (args.feishu) {
    const conflicts = [
      args.runArg !== null ? '--run' : null,
      args.pipeMode ? '--pipe' : null,
      args.resumeRunArg !== null ? '--resume-run' : null,
      args.tools ? '--tools' : null,
      args.version ? '--version' : null,
      args.help ? '--help' : null,
    ].filter((v): v is string => v !== null);
    if (conflicts.length > 0) {
      return { ok: false, error: `--feishu cannot be combined with ${conflicts.join('/')}` };
    }
  }

  return { ok: true, args };
}

/**
 * 解析 `update` 子命令的剩余参数。
 *
 * 互斥只发生在 `--check` 与 `--yes`（只检查 vs 跳过安装确认，语义相反）。
 * `--channel` 与两者都相容：`--check --channel beta` 查 beta 通道
 * （docs/FILE-MANAGEMENT.md），`--channel beta --yes` 是不确认装 beta。
 */
function parseUpdateArgs(rest: string[], args: CliArgs): ParseResult {
  const update: UpdateArgs = { check: false, json: false, force: false, yes: false };

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    switch (a) {
      case '--check':
        update.check = true;
        break;
      case '--channel': {
        const next = rest[i + 1];
        if (next === undefined || next.startsWith('-')) {
          return { ok: false, error: 'Missing value for --channel' };
        }
        if (next !== 'latest' && next !== 'beta') {
          return { ok: false, error: `Invalid channel: ${next} (expected "latest" or "beta")` };
        }
        update.channel = next;
        i++;
        break;
      }
      case '--json':
        update.json = true;
        break;
      case '--force':
        update.force = true;
        break;
      case '--yes':
      case '-y':
        update.yes = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        return { ok: false, error: `Unknown argument: ${a}` };
    }
  }

  if (update.check && update.yes) {
    return { ok: false, error: 'Cannot combine --check and --yes' };
  }

  args.update = update;
  return { ok: true, args };
}

// ── 0.4 eval 子命令 ───────────────────

/** `eval <suite-name-or-path> [--json] [--out <path>] [--filter <tag>]... [--allow-network]` */
function parseEvalArgs(rest: string[], args: CliArgs): ParseResult {
  let target: string | undefined;
  let json = false;
  let out: string | undefined;
  let allowNetwork = false;
  const filters: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';

    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--allow-network') {
      allowNetwork = true;
      continue;
    }
    if (a === '--out') {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('-') || next.trim() === '') {
        return { ok: false, error: 'Missing value for --out' };
      }
      out = next;
      i++;
      continue;
    }
    if (a === '--filter') {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('-') || next.trim() === '') {
        return { ok: false, error: 'Missing value for --filter' };
      }
      filters.push(next);
      i++;
      continue;
    }
    if (a.startsWith('-')) {
      return { ok: false, error: `Unknown argument: ${a}` };
    }
    if (target !== undefined) {
      return { ok: false, error: `Unexpected argument: ${a}` };
    }
    target = a;
  }

  if (args.help) return { ok: true, args };

  if (target === undefined || target.trim() === '') {
    return { ok: false, error: 'Missing eval suite (name or path)' };
  }

  args.eval = {
    target,
    json,
    ...(out !== undefined ? { out } : {}),
    filters,
    allowNetwork,
  };
  return { ok: true, args };
}

// ── 0.5 config / migrate / trace 子命令 ───────────────

/** `config path|init|show` */
function parseConfigArgs(rest: string[], args: CliArgs): ParseResult {
  const sub = rest[0];
  if (sub === '--help' || sub === '-h' || sub === undefined) {
    if (sub === undefined)
      return { ok: false, error: 'Missing config subcommand (path|init|show|set|explain)' };
    args.help = true;
    return { ok: true, args };
  }

  const tail = rest.slice(1);
  let json = false;
  let force = false;
  let sources = false;

  // 0.11/0.11.1：`config set <key> <value> [--json]`
  if (sub === 'set') {
    const positional: string[] = [];
    for (const a of tail) {
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      if (a.startsWith('-')) {
        return { ok: false, error: `Unknown argument for config set: ${a}` };
      }
      positional.push(a);
    }
    if (args.help) return { ok: true, args };
    if (positional.length !== 2) {
      return {
        ok: false,
        error:
          'Usage: vessel config set <ui.language|ui.showReasoning|ui.statusBars|ui.verbosity|ui.showInternalEvents|ui.errorLevel|ui.askUser|ui.expandCards|observability.showProcessErrors|agent.cwd> <value> [--json]',
      };
    }
    const [key = '', value = ''] = positional;
    if (
      key !== 'ui.language' &&
      key !== 'ui.showReasoning' &&
      key !== 'ui.statusBars' &&
      key !== 'ui.verbosity' &&
      key !== 'ui.showInternalEvents' &&
      key !== 'ui.errorLevel' &&
      key !== 'ui.askUser' &&
      key !== 'ui.expandCards' &&
      key !== 'observability.showProcessErrors' &&
      key !== 'agent.cwd'
    ) {
      return {
        ok: false,
        error:
          `Unsupported config key: ${key} (supported: ui.language, ui.showReasoning, ` +
          'ui.statusBars, ui.verbosity, ui.showInternalEvents, ui.errorLevel, ui.askUser, ' +
          'ui.expandCards, observability.showProcessErrors, agent.cwd)',
      };
    }
    if (key === 'ui.language' && value !== 'zh-CN' && value !== 'en') {
      return { ok: false, error: 'ui.language must be "zh-CN" or "en"' };
    }
    if (key === 'ui.showReasoning' && value !== 'true' && value !== 'false') {
      return { ok: false, error: 'ui.showReasoning must be "true" or "false"' };
    }
    if (key === 'ui.statusBars' && !['top', 'bottom', 'both', 'none'].includes(value)) {
      return { ok: false, error: 'ui.statusBars must be "top", "bottom", "both" or "none"' };
    }
    if (key === 'ui.verbosity' && !['minimal', 'normal', 'debug'].includes(value)) {
      return { ok: false, error: 'ui.verbosity must be "minimal", "normal" or "debug"' };
    }
    if (
      (key === 'ui.showInternalEvents' ||
        key === 'ui.askUser' ||
        key === 'ui.expandCards' ||
        key === 'observability.showProcessErrors') &&
      value !== 'true' &&
      value !== 'false'
    ) {
      return { ok: false, error: `${key} must be "true" or "false"` };
    }
    if (key === 'ui.errorLevel' && value !== 'user' && value !== 'all') {
      return { ok: false, error: 'ui.errorLevel must be "user" or "all"' };
    }
    if (key === 'agent.cwd' && value.trim() === '') {
      return { ok: false, error: 'agent.cwd must be a non-empty path' };
    }
    args.configCommand = { kind: 'set', key, value, json };
    return { ok: true, args };
  }

  // q-ax-config：`config explain <key> [--json]`（逐层值 + 谁赢；键合法性在命令层判，
  // 那里有完整叶子清单，能给出「Did you mean」建议）。
  if (sub === 'explain') {
    const positional: string[] = [];
    for (const a of tail) {
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      if (a.startsWith('-')) {
        return { ok: false, error: `Unknown argument for config explain: ${a}` };
      }
      positional.push(a);
    }
    if (args.help) return { ok: true, args };
    if (positional.length !== 1) {
      return {
        ok: false,
        error: 'Usage: vessel config explain <key> [--json] (e.g. data_dir / provider.model)',
      };
    }
    args.configCommand = { kind: 'explain', key: positional[0] ?? '', json };
    return { ok: true, args };
  }

  for (let i = 0; i < tail.length; i++) {
    const a = tail[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--force' && sub === 'init') {
      force = true;
      continue;
    }
    if (a === '--sources' && sub === 'show') {
      sources = true;
      continue;
    }
    return { ok: false, error: `Unknown argument for config ${sub}: ${a}` };
  }

  if (args.help) return { ok: true, args };

  if (sub === 'path') {
    if (force || sources) {
      return { ok: false, error: 'config path only supports --json' };
    }
    args.configCommand = { kind: 'path', json };
    return { ok: true, args };
  }
  if (sub === 'init') {
    if (sources) {
      return { ok: false, error: 'config init only supports --force and --json' };
    }
    args.configCommand = { kind: 'init', json, force };
    return { ok: true, args };
  }
  if (sub === 'show') {
    if (force) return { ok: false, error: 'config show does not support --force' };
    args.configCommand = {
      kind: 'show',
      json,
      sources,
    };
    return { ok: true, args };
  }
  return { ok: false, error: `Unknown config subcommand: ${sub}` };
}

/** `migrate --from sqlite|file-v1 --to file-v2 [--apply] [--source <path>]` */
function parseMigrateArgs(rest: string[], args: CliArgs): ParseResult {
  let from: string | undefined;
  let to: string | undefined;
  let apply = false;
  let json = false;
  let source: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--apply') {
      apply = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--from' || a === '--to' || a === '--source') {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('-') || next.trim() === '') {
        return { ok: false, error: `Missing value for ${a}` };
      }
      if (a === '--from') from = next;
      else if (a === '--to') to = next;
      else source = next;
      i++;
      continue;
    }
    return { ok: false, error: `Unknown argument for migrate: ${a}` };
  }

  if (args.help) return { ok: true, args };
  if (from === undefined) return { ok: false, error: 'migrate requires --from sqlite|file-v1' };
  if (to === undefined) return { ok: false, error: 'migrate requires --to file-v2' };
  // 取值合法性在解析层校验：与其它用法错误同一出口（stderr + exit 2 + Try 提示），
  // 而不是进了命令层才报「usage:」（那样拿不到 Try 提示）。
  if (from !== 'sqlite' && from !== 'file-v1') {
    return { ok: false, error: `Invalid --from: ${from} (expected "sqlite" or "file-v1")` };
  }
  if (to !== 'file-v2') {
    return { ok: false, error: `Invalid --to: ${to} (expected "file-v2")` };
  }

  args.migrate = {
    from,
    to,
    apply,
    json,
    ...(source !== undefined ? { source } : {}),
  };
  return { ok: true, args };
}

/** `trace prune [--dry-run] [--json]` */
function parseTraceArgs(rest: string[], args: CliArgs): ParseResult {
  const sub = rest[0];
  if (sub === '--help' || sub === '-h') {
    args.help = true;
    return { ok: true, args };
  }
  if (sub === undefined) return { ok: false, error: 'Missing trace subcommand (prune)' };
  if (sub !== 'prune') return { ok: false, error: `Unknown trace subcommand: ${sub}` };

  let dryRun = false;
  let json = false;

  const tail = rest.slice(1);
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    return { ok: false, error: `Unknown argument for trace prune: ${a}` };
  }

  if (args.help) return { ok: true, args };

  args.trace = {
    kind: 'prune',
    dryRun,
    json,
  };
  return { ok: true, args };
}

/** 插件短名：防止 `remove` 越出用户插件目录 */
export const PLUGIN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** `plugin list [--json] | install <path> [--force] | remove <name> [--yes]` */
function parsePluginArgs(rest: string[], args: CliArgs): ParseResult {
  const sub = rest[0];
  if (sub === '--help' || sub === '-h') {
    args.help = true;
    return { ok: true, args };
  }
  if (sub === undefined) {
    return { ok: false, error: 'Missing plugin subcommand (list|install|remove)' };
  }

  if (sub === 'list') {
    let json = false;
    for (const a of rest.slice(1)) {
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      return { ok: false, error: `Unknown argument for plugin list: ${a}` };
    }
    if (args.help) return { ok: true, args };
    args.pluginCommand = { kind: 'list', json };
    return { ok: true, args };
  }

  if (sub === 'install') {
    let source: string | undefined;
    let force = false;
    const tail = rest.slice(1);
    for (let i = 0; i < tail.length; i++) {
      const a = tail[i] ?? '';
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--force') {
        force = true;
        continue;
      }
      if (a.startsWith('-'))
        return { ok: false, error: `Unknown argument for plugin install: ${a}` };
      if (source !== undefined) {
        return { ok: false, error: `Unexpected extra argument for plugin install: ${a}` };
      }
      source = a;
    }
    if (args.help) return { ok: true, args };
    // 空串 / 纯空白不是合法路径：按缺参数处理（否则会带着空 path 进 loader）。
    if (source === undefined || source.trim() === '') {
      return { ok: false, error: 'Missing <path> for plugin install' };
    }
    args.pluginCommand = { kind: 'install', path: source, force };
    return { ok: true, args };
  }

  if (sub === 'enable' || sub === 'disable') {
    let name: string | undefined;
    for (const a of rest.slice(1)) {
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a.startsWith('-')) {
        return { ok: false, error: `Unknown argument for plugin ${sub}: ${a}` };
      }
      if (name !== undefined) {
        return { ok: false, error: `Unexpected extra argument for plugin ${sub}: ${a}` };
      }
      name = a;
    }
    if (args.help) return { ok: true, args };
    if (name === undefined) return { ok: false, error: `Missing <name> for plugin ${sub}` };
    if (!PLUGIN_NAME_RE.test(name)) {
      return { ok: false, error: `Invalid plugin name: ${name}` };
    }
    args.pluginCommand = { kind: sub, name };
    return { ok: true, args };
  }

  if (sub === 'remove') {
    let name: string | undefined;
    let yes = false;
    const tail = rest.slice(1);
    for (let i = 0; i < tail.length; i++) {
      const a = tail[i] ?? '';
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--yes' || a === '-y') {
        yes = true;
        continue;
      }
      if (a.startsWith('-'))
        return { ok: false, error: `Unknown argument for plugin remove: ${a}` };
      if (name !== undefined) {
        return { ok: false, error: `Unexpected extra argument for plugin remove: ${a}` };
      }
      name = a;
    }
    if (args.help) return { ok: true, args };
    if (name === undefined || name.trim() === '') {
      return { ok: false, error: 'Missing <name> for plugin remove' };
    }
    if (!PLUGIN_NAME_RE.test(name)) {
      return { ok: false, error: `Invalid plugin name: ${name}` };
    }
    args.pluginCommand = { kind: 'remove', name, yes };
    return { ok: true, args };
  }

  return { ok: false, error: `Unknown plugin subcommand: ${sub}` };
}

/**
 * `completion <bash|zsh|fish|powershell>`（0.18）。
 * 无参数 / 未知 shell 不在这里报解析错误：交给命令打印用法并 exit 2（用法错误口径）。
 */
function parseCompletionArgs(rest: string[], args: CliArgs): ParseResult {
  if (rest[0] === '--help' || rest[0] === '-h') {
    args.help = true;
    return { ok: true, args };
  }
  if (rest.length > 1) {
    return { ok: false, error: `Unexpected argument for completion: ${rest[1]}` };
  }
  const requested = rest[0];
  if (requested === undefined) {
    args.completionCommand = { shell: null, requested: null };
    return { ok: true, args };
  }
  args.completionCommand = {
    shell: isCompletionShell(requested) ? requested : null,
    requested,
  };
  return { ok: true, args };
}

/**
 * `dev reset [--yes] [--dry-run] [--json]`（0.49）。
 *
 * `dev`（无子命令）/ `dev --help` 走 dev 专用帮助（不置 `args.help`，否则 `cli.ts`
 * 会在命令分派前打印全局 help）；前者是用法错误，退出码由 `runDevCommand` 给 2。
 * `dev` 在 i===0 提前返回，所以这里自行接受
 * `--data-dir`；`cli.ts` 随后会把它镜像到 VESSEL_DATA_DIR。
 */
function parseDevArgs(rest: string[], args: CliArgs): ParseResult {
  const sub = rest[0];
  if (sub === undefined) {
    // 缺失子命令：仍然打帮助（文案同 `vessel dev --help`），但按用法错误 exit 2。
    args.devCommand = { kind: 'help', missingSubcommand: true };
    return { ok: true, args };
  }
  if (sub === '--help' || sub === '-h') {
    args.devCommand = { kind: 'help', missingSubcommand: false };
    return { ok: true, args };
  }
  if (sub !== 'reset') {
    return { ok: false, error: `Unknown dev subcommand: ${sub}` };
  }

  let yes = false;
  let dryRun = false;
  let json = false;
  for (let i = 1; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a === '--yes') {
      yes = true;
      continue;
    }
    if (a === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--help' || a === '-h') {
      args.devCommand = { kind: 'help', missingSubcommand: false };
      return { ok: true, args };
    }
    if (a === '--data-dir') {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('-') || value.trim() === '') {
        return { ok: false, error: 'Missing value for --data-dir' };
      }
      args.dataDirArg = value;
      i++;
      continue;
    }
    return { ok: false, error: `Unknown argument for dev reset: ${a}` };
  }
  args.devCommand = { kind: 'reset', yes, dryRun, json };
  return { ok: true, args };
}

const DAY_MS = 86_400_000;

/**
 * `--older-than`：`<n><ms|s|m|h|d>`（裸数字按天）；非法返回 null。
 *
 * 单位写法照 `--timeout <dur>` 的既有形态（`parseTimeoutMs`）；但**不复用**它：
 * 它的上限是 24h，表达不了「30 天」，而且裸数字按秒 —— 这里裸数字按**天**，
 * 对齐 RPC `trace.prune` 的 `older_than_days` 与 `trace.retention_days` 的口径
 * （也偏保守：阈值更大 ⇒ 删得更少）。
 *
 * 0.51 起这个值只是 `vessel prune` 的**可选叠加**条件（比的是归档 / 停用时刻），
 * 不传就完全不看时间。
 */
export function parseOlderThanMs(raw: string): number | null {
  const match = /^(\d+)(ms|s|m|h|d)?$/.exec(raw.trim());
  if (!match) return null;
  const amount = Number.parseInt(match[1] ?? '', 10);
  // 0 = 删光全部（不是「不限」）：这种取值太容易误伤，一律当非法。
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2] ?? 'd';
  const factor =
    unit === 'ms'
      ? 1
      : unit === 's'
        ? 1000
        : unit === 'm'
          ? 60_000
          : unit === 'h'
            ? 3_600_000
            : DAY_MS;
  return amount * factor;
}

/** `prune [--older-than <dur>] [--dry-run] [--json] [--yes] [--data-dir <path>]` */
function parsePruneArgs(rest: string[], args: CliArgs): ParseResult {
  let yes = false;
  let dryRun = false;
  let json = false;
  let olderThanMs: number | undefined;

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--yes' || a === '-y') {
      yes = true;
      continue;
    }
    if (a === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--older-than') {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('-') || value.trim() === '') {
        return { ok: false, error: 'Missing value for --older-than' };
      }
      const parsed = parseOlderThanMs(value);
      if (parsed === null) return { ok: false, error: `Invalid value for --older-than: ${value}` };
      olderThanMs = parsed;
      i++;
      continue;
    }
    if (a === '--data-dir') {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('-') || value.trim() === '') {
        return { ok: false, error: 'Missing value for --data-dir' };
      }
      args.dataDirArg = value;
      i++;
      continue;
    }
    return { ok: false, error: `Unknown argument for prune: ${a}` };
  }

  if (args.help) return { ok: true, args };

  args.prune = {
    yes,
    dryRun,
    json,
    ...(olderThanMs !== undefined ? { olderThanMs } : {}),
  };
  return { ok: true, args };
}

/** `demo`：无参数（`--help` 由顶层处理） */
function parseDemoArgs(rest: string[], args: CliArgs): ParseResult {
  for (const a of rest) {
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    return { ok: false, error: `Unknown argument for demo: ${a}` };
  }
  if (!args.help) args.demo = true;
  return { ok: true, args };
}

// ── 0.12 gateway 子命令（DECISION-023 §2.1）─────────────

/** `gateway stop` 缺省等待时长 */
export const DEFAULT_STOP_TIMEOUT_MS = 10_000;
const MAX_STOP_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** 解析 `10s` / `500ms` / `1m`（裸数字按秒）；非法返回 null */
export function parseTimeoutMs(raw: string): number | null {
  const match = /^(\d+)(ms|s|m)?$/.exec(raw.trim());
  if (!match) return null;
  const amount = Number.parseInt(match[1] ?? '', 10);
  if (!Number.isFinite(amount)) return null;
  const unit = match[2] ?? 's';
  const ms = unit === 'ms' ? amount : unit === 's' ? amount * 1000 : amount * 60_000;
  if (ms < 100 || ms > MAX_STOP_TIMEOUT_MS) return null;
  return ms;
}

const GATEWAY_TARGETS: ReadonlySet<string> = new Set(['systemd', 'launchd', 'schtasks']);
const RELOAD_SCOPE_RE = /^[a-z][a-z0-9_-]*$/;

/** 逗号分隔的 reload scope；非法返回 null */
function parseReloadScopes(raw: string): string[] | null {
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.length === 0) return null;
  return parts.every((part) => RELOAD_SCOPE_RE.test(part)) ? parts : null;
}

/** 读取 flag 的值（拒绝缺失/空/下一个 flag） */
function readFlagValue(
  rest: string[],
  index: number,
  flag: string,
): { ok: true; value: string; next: number } | { ok: false; error: string } {
  const next = rest[index + 1];
  if (next === undefined || next.startsWith('-') || next.trim() === '') {
    return { ok: false, error: `Missing value for ${flag}` };
  }
  return { ok: true, value: next, next: index + 1 };
}

/**
 * `--data-dir <path>`（0.56.1）：**只覆盖数据目录**，不改变任何其它配置语义。
 *
 * 统一写回 `args.dataDirArg`，由 `cli.ts` 转成进程内的 `VESSEL_DATA_DIR`：
 *
 * ```
 * CLI 参数 > 环境变量 > 项目 config > 用户 config
 * ```
 *
 * 这样 gateway / node 的每个子命令（含它们 spawn 的子进程）看到的都是同一个数据根，
 * 一台机器上因此可以跑互不干扰的多个实例（各自的 pid/lock/logs、各自的 node 注册表、
 * 各自的会话目录）。
 */
function readDataDirFlag(
  rest: string[],
  index: number,
): { ok: true; value: string; next: number } | { ok: false; error: string } {
  return readFlagValue(rest, index, '--data-dir');
}

/** gateway 实例名（与 gateway/pid 的校验一致；解析层只做语法） */
const GATEWAY_INSTANCE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
function parseInstanceName(raw: string): string | null {
  return GATEWAY_INSTANCE_RE.test(raw) ? raw : null;
}

/**
 * 解析 stop/status/restart/reload 的选择器 flags。
 * `matched=false` 表示当前 token 不是选择器，交给调用方继续处理。
 */
function parseGatewaySelectorArg(
  rest: string[],
  index: number,
  selector: GatewaySelector,
  command: string,
): { ok: true; next: number; matched: boolean } | { ok: false; error: string } {
  const a = rest[index] ?? '';
  if (a === '--all') {
    selector.all = true;
    return { ok: true, next: index, matched: true };
  }
  if (a === '--instance') {
    const value = readFlagValue(rest, index, '--instance');
    if (!value.ok) return value;
    const instance = parseInstanceName(value.value);
    if (instance === null) {
      return {
        ok: false,
        error: `Invalid --instance: ${value.value} (expected ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$)`,
      };
    }
    selector.instance = instance;
    return { ok: true, next: value.next, matched: true };
  }
  if (a === '--port') {
    const value = readFlagValue(rest, index, '--port');
    if (!value.ok) return value;
    const port = parsePort(value.value);
    if (port === null || port === 0) {
      return {
        ok: false,
        error: `Invalid --port for gateway ${command}: ${value.value} (1-65535)`,
      };
    }
    selector.port = port;
    return { ok: true, next: value.next, matched: true };
  }
  return { ok: true, next: index, matched: false };
}

/** 选择器互斥检查；通过返回 null */
function gatewaySelectorError(selector: GatewaySelector, command: string): string | null {
  const selected = [
    selector.instance !== undefined,
    selector.port !== undefined,
    selector.all === true,
  ];
  if (selected.filter(Boolean).length > 1) {
    return `gateway ${command} accepts only one of --instance, --port, --all`;
  }
  return null;
}

/** `gateway start [--port N] [--host H] [--daemon] [--log <path>]` */
function parseGatewayStart(rest: string[], args: CliArgs): ParseResult {
  const command: Extract<GatewayCommand, { kind: 'start' }> = { kind: 'start', daemon: false };

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--daemon') {
      command.daemon = true;
      continue;
    }
    if (a === '--instance') {
      const value = readFlagValue(rest, i, '--instance');
      if (!value.ok) return value;
      const instance = parseInstanceName(value.value);
      if (instance === null) {
        return {
          ok: false,
          error: `Invalid --instance: ${value.value} (expected ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$)`,
        };
      }
      command.instance = instance;
      i = value.next;
      continue;
    }
    if (a === '--port') {
      const value = readFlagValue(rest, i, '--port');
      if (!value.ok) return value;
      const port = parsePort(value.value);
      if (port === null) return { ok: false, error: `Invalid port for --port: ${value.value}` };
      command.port = port;
      i = value.next;
      continue;
    }
    if (a === '--host') {
      const value = readFlagValue(rest, i, '--host');
      if (!value.ok) return value;
      command.host = value.value;
      i = value.next;
      continue;
    }
    if (a === '--log') {
      const value = readFlagValue(rest, i, '--log');
      if (!value.ok) return value;
      command.log = value.value;
      i = value.next;
      continue;
    }
    if (a === '--data-dir') {
      const value = readDataDirFlag(rest, i);
      if (!value.ok) return value;
      args.dataDirArg = value.value;
      i = value.next;
      continue;
    }
    return { ok: false, error: `Unknown argument for gateway start: ${a}` };
  }

  if (args.help) return { ok: true, args };
  if (command.port === 0 && command.instance === undefined) {
    return { ok: false, error: 'gateway start --port 0 requires --instance <name>' };
  }
  args.gateway = command;
  return { ok: true, args };
}

/** `gateway stop [--timeout 10s] [--instance N|--port N|--all] [--stop-nodes]` */
function parseGatewayStop(rest: string[], args: CliArgs): ParseResult {
  let timeoutMs = DEFAULT_STOP_TIMEOUT_MS;
  // 0.55.1：缺省只停平台层，**不动 node/hub**（它们身上可能跑着会话，杀掉不可恢复）。
  // 破坏性动作要显式：`--stop-nodes` 才连 node/hub 一起停。
  let keepNodes = true;
  const selector: GatewaySelector = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--stop-nodes') {
      // 连本机 spawn/接管、且归属可复核的 node/hub 一起停。
      keepNodes = false;
      continue;
    }
    if (a === '--no-keep-nodes') {
      // 兼容别名（0.55 的写法），等价于 --stop-nodes。
      keepNodes = false;
      continue;
    }
    if (a === '--keep-nodes') {
      // 兼容别名（0.52 的写法），等价于缺省。
      keepNodes = true;
      continue;
    }
    if (a === '--timeout') {
      const value = readFlagValue(rest, i, '--timeout');
      if (!value.ok) return value;
      const parsed = parseTimeoutMs(value.value);
      if (parsed === null) {
        return { ok: false, error: `Invalid --timeout: ${value.value} (expected e.g. 10s)` };
      }
      timeoutMs = parsed;
      i = value.next;
      continue;
    }
    const selected = parseGatewaySelectorArg(rest, i, selector, 'stop');
    if (!selected.ok) return selected;
    if (selected.matched) {
      i = selected.next;
      continue;
    }
    if (a === '--data-dir') {
      const value = readDataDirFlag(rest, i);
      if (!value.ok) return value;
      args.dataDirArg = value.value;
      i = value.next;
      continue;
    }
    return { ok: false, error: `Unknown argument for gateway stop: ${a}` };
  }
  if (args.help) return { ok: true, args };
  const selectorError = gatewaySelectorError(selector, 'stop');
  if (selectorError !== null) return { ok: false, error: selectorError };
  args.gateway = {
    kind: 'stop',
    timeoutMs,
    keepNodes,
    ...selector,
  };
  return { ok: true, args };
}

/** `gateway status [--json] [--instance N|--port N|--all]` */
function parseGatewayStatus(rest: string[], args: CliArgs): ParseResult {
  let json = false;
  let rpc = false;
  const selector: GatewaySelector = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--rpc') {
      rpc = true;
      continue;
    }
    const selected = parseGatewaySelectorArg(rest, i, selector, 'status');
    if (!selected.ok) return selected;
    if (selected.matched) {
      i = selected.next;
      continue;
    }
    if (a === '--data-dir') {
      const value = readDataDirFlag(rest, i);
      if (!value.ok) return value;
      args.dataDirArg = value.value;
      i = value.next;
      continue;
    }
    return { ok: false, error: `Unknown argument for gateway status: ${a}` };
  }
  if (args.help) return { ok: true, args };
  const selectorError = gatewaySelectorError(selector, 'status');
  if (selectorError !== null) return { ok: false, error: selectorError };
  args.gateway = { kind: 'status', json, ...(rpc ? { rpc: true } : {}), ...selector };
  return { ok: true, args };
}

/** `gateway list [--json] [--data-dir <path>]` */
function parseGatewayList(rest: string[], args: CliArgs): ParseResult {
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === undefined) continue;
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--data-dir') {
      const value = readDataDirFlag(rest, i);
      if (!value.ok) return value;
      args.dataDirArg = value.value;
      i = value.next;
      continue;
    }
    return { ok: false, error: `Unknown argument for gateway list: ${a}` };
  }
  if (args.help) return { ok: true, args };
  args.gateway = { kind: 'list', json };
  return { ok: true, args };
}

/**
 * `gateway restart [--daemon] [--instance N|--port N|--all] [--stop-nodes]`
 * 缺省保持当前实例的运行模式（daemon/前台）；显式 `--daemon` 强制后台。
 */
function parseGatewayRestart(rest: string[], args: CliArgs): ParseResult {
  // undefined = 未显式给 --daemon：保持运行模式，cli.ts 分发前按 pid record 解析。
  let daemon: boolean | undefined;
  // 0.55.1：缺省只换平台层，node/hub 留活并被新平台 adopt（不杀会话）。
  // 与 `stop` 同口径：要连 node 一起冷重启，显式写 `--stop-nodes`。
  // 注意：留活意味着 node 仍跑旧代码 —— 命令结尾会打印一行可复制的提示。
  let keepNodes = true;
  const selector: GatewaySelector = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--daemon') {
      daemon = true;
      continue;
    }
    if (a === '--stop-nodes') {
      // 连 node/hub 一起冷重启（换代码才真正生效的那条路）。
      keepNodes = false;
      continue;
    }
    if (a === '--keep-nodes') {
      // 兼容别名（0.52 的写法），等价于缺省：只换平台层，节点 adopt 接管。
      keepNodes = true;
      continue;
    }
    if (a === '--no-keep-nodes') {
      // 兼容别名（0.55 的写法），等价于 --stop-nodes。
      keepNodes = false;
      continue;
    }
    const selected = parseGatewaySelectorArg(rest, i, selector, 'restart');
    if (!selected.ok) return selected;
    if (selected.matched) {
      i = selected.next;
      continue;
    }
    if (a === '--data-dir') {
      const value = readDataDirFlag(rest, i);
      if (!value.ok) return value;
      args.dataDirArg = value.value;
      i = value.next;
      continue;
    }
    return { ok: false, error: `Unknown argument for gateway restart: ${a}` };
  }
  if (args.help) return { ok: true, args };
  const selectorError = gatewaySelectorError(selector, 'restart');
  if (selectorError !== null) return { ok: false, error: selectorError };
  if (selector.all === true && !daemon) {
    return { ok: false, error: 'gateway restart --all requires --daemon' };
  }
  args.gateway = {
    kind: 'restart',
    daemon,
    keepNodes,
    ...selector,
  };
  return { ok: true, args };
}

/** `gateway reload [--scope config,plugins] [--instance N|--port N|--all]` */
function parseGatewayReload(rest: string[], args: CliArgs): ParseResult {
  let scopes: string[] | undefined;
  const selector: GatewaySelector = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--scope') {
      const value = readFlagValue(rest, i, '--scope');
      if (!value.ok) return value;
      const parsed = parseReloadScopes(value.value);
      if (parsed === null) {
        return {
          ok: false,
          error: `Invalid --scope: ${value.value} (expected e.g. config,plugins)`,
        };
      }
      scopes = [...new Set([...(scopes ?? []), ...parsed])];
      i = value.next;
      continue;
    }
    const selected = parseGatewaySelectorArg(rest, i, selector, 'reload');
    if (!selected.ok) return selected;
    if (selected.matched) {
      i = selected.next;
      continue;
    }
    if (a === '--data-dir') {
      const value = readDataDirFlag(rest, i);
      if (!value.ok) return value;
      args.dataDirArg = value.value;
      i = value.next;
      continue;
    }
    return { ok: false, error: `Unknown argument for gateway reload: ${a}` };
  }
  if (args.help) return { ok: true, args };
  const selectorError = gatewaySelectorError(selector, 'reload');
  if (selectorError !== null) return { ok: false, error: selectorError };
  args.gateway = {
    kind: 'reload',
    ...(scopes !== undefined ? { scopes } : {}),
    ...selector,
  };
  return { ok: true, args };
}

// ── 0.49 G3a gateway nodes 子命令 ─────────────────────

/** `gateway nodes list [--json]` */
function parseGatewayNodesList(rest: string[], args: CliArgs): ParseResult {
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === undefined) continue;
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--data-dir') {
      const value = readDataDirFlag(rest, i);
      if (!value.ok) return value;
      args.dataDirArg = value.value;
      i = value.next;
      continue;
    }
    return { ok: false, error: `Unknown argument for gateway nodes list: ${a}` };
  }
  if (args.help) return { ok: true, args };
  args.gatewayNodes = { kind: 'list', json };
  return { ok: true, args };
}

/** `gateway nodes add <name> --data-dir <dir> --config <path> [--no-auto-start]` */
function parseGatewayNodesAdd(rest: string[], args: CliArgs): ParseResult {
  let name: string | undefined;
  let dataDir: string | undefined;
  let configPath: string | undefined;
  let autoStart = true;

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--data-dir') {
      const value = readFlagValue(rest, i, '--data-dir');
      if (!value.ok) return value;
      dataDir = value.value;
      i = value.next;
      continue;
    }
    if (a === '--config') {
      const value = readFlagValue(rest, i, '--config');
      if (!value.ok) return value;
      configPath = value.value;
      i = value.next;
      continue;
    }
    if (a === '--no-auto-start') {
      autoStart = false;
      continue;
    }
    if (a.startsWith('-')) {
      return { ok: false, error: `Unknown argument for gateway nodes add: ${a}` };
    }
    if (name !== undefined) {
      return { ok: false, error: `gateway nodes add accepts one node name: ${name}, ${a}` };
    }
    name = a;
  }
  if (args.help) return { ok: true, args };
  if (name === undefined) return { ok: false, error: 'Missing node name for gateway nodes add' };
  if (dataDir === undefined)
    return { ok: false, error: 'Missing --data-dir for gateway nodes add' };
  if (configPath === undefined) {
    return { ok: false, error: 'Missing --config for gateway nodes add' };
  }
  args.gatewayNodes = { kind: 'add', name, dataDir, configPath, autoStart };
  return { ok: true, args };
}

/** `gateway nodes remove <name> [--data-dir <path>]` */
function parseGatewayNodesRemove(rest: string[], args: CliArgs): ParseResult {
  let name: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === undefined) continue;
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--data-dir') {
      const value = readDataDirFlag(rest, i);
      if (!value.ok) return value;
      args.dataDirArg = value.value;
      i = value.next;
      continue;
    }
    if (a.startsWith('-')) {
      return { ok: false, error: `Unknown argument for gateway nodes remove: ${a}` };
    }
    if (name !== undefined) {
      return { ok: false, error: `gateway nodes remove accepts one node name: ${name}, ${a}` };
    }
    name = a;
  }
  if (args.help) return { ok: true, args };
  if (name === undefined) return { ok: false, error: 'Missing node name for gateway nodes remove' };
  args.gatewayNodes = { kind: 'remove', name };
  return { ok: true, args };
}

/** `gateway nodes <list|add|remove>` */
function parseGatewayNodes(rest: string[], args: CliArgs): ParseResult {
  const sub = rest[0];
  if (sub === '--help' || sub === '-h') {
    args.help = true;
    return { ok: true, args };
  }
  if (sub === undefined) {
    return { ok: false, error: 'Missing gateway nodes subcommand (list|add|remove)' };
  }
  const tail = rest.slice(1);
  switch (sub) {
    case 'list':
      return parseGatewayNodesList(tail, args);
    case 'add':
      return parseGatewayNodesAdd(tail, args);
    case 'remove':
      return parseGatewayNodesRemove(tail, args);
    default:
      return { ok: false, error: `Unknown gateway nodes subcommand: ${sub}` };
  }
}

/** `gateway install-service [--systemd|--launchd|--schtasks]` */
function parseGatewayInstallService(rest: string[], args: CliArgs): ParseResult {
  let target: GatewayInstallTarget | undefined;
  for (const a of rest) {
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a.startsWith('--') && GATEWAY_TARGETS.has(a.slice(2))) {
      const requested = a.slice(2) as GatewayInstallTarget;
      if (target !== undefined && target !== requested) {
        return { ok: false, error: 'gateway install-service accepts one platform flag' };
      }
      target = requested;
      continue;
    }
    return { ok: false, error: `Unknown argument for gateway install-service: ${a}` };
  }
  if (args.help) return { ok: true, args };
  args.gateway = { kind: 'install-service', ...(target !== undefined ? { target } : {}) };
  return { ok: true, args };
}

/** `gateway uninstall-service` */
function parseGatewayUninstallService(rest: string[], args: CliArgs): ParseResult {
  for (const a of rest) {
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    return { ok: false, error: `Unknown argument for gateway uninstall-service: ${a}` };
  }
  if (args.help) return { ok: true, args };
  args.gateway = { kind: 'uninstall-service' };
  return { ok: true, args };
}

/** `gateway <subcommand>` 分发 */
function parseGatewayArgs(rest: string[], args: CliArgs): ParseResult {
  const sub = rest[0];
  if (sub === '--help' || sub === '-h') {
    args.help = true;
    return { ok: true, args };
  }
  if (sub === undefined) {
    return {
      ok: false,
      error:
        'Missing gateway subcommand ' +
        '(start|stop|status|list|restart|reload|nodes|install-service|uninstall-service)',
    };
  }

  const tail = rest.slice(1);
  switch (sub) {
    case 'start':
      return parseGatewayStart(tail, args);
    case 'stop':
      return parseGatewayStop(tail, args);
    case 'status':
      return parseGatewayStatus(tail, args);
    case 'list':
      return parseGatewayList(tail, args);
    case 'nodes':
      return parseGatewayNodes(tail, args);
    case 'restart':
      return parseGatewayRestart(tail, args);
    case 'reload':
      return parseGatewayReload(tail, args);
    case 'install-service':
      return parseGatewayInstallService(tail, args);
    case 'uninstall-service':
      return parseGatewayUninstallService(tail, args);
    default:
      return { ok: false, error: `Unknown gateway subcommand: ${sub}` };
  }
}

// ── 0.49 G1 node 子命令 ───────────────────────────────

/** `node start [--daemon] [--config <path>]` */
function parseNodeStart(rest: string[], args: CliArgs): ParseResult {
  let daemon = false;
  let configPath: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--daemon') {
      daemon = true;
      continue;
    }
    if (a === '--config') {
      const value = readFlagValue(rest, i, '--config');
      if (!value.ok) return value;
      configPath = value.value;
      i = value.next;
      continue;
    }
    if (a === '--data-dir') {
      const value = readDataDirFlag(rest, i);
      if (!value.ok) return value;
      args.dataDirArg = value.value;
      i = value.next;
      continue;
    }
    return { ok: false, error: `Unknown argument for node start: ${a}` };
  }
  if (args.help) return { ok: true, args };
  args.node = { kind: 'start', daemon, ...(configPath !== undefined ? { configPath } : {}) };
  return { ok: true, args };
}

/** `node status [--json] [--rpc] [--data-dir <path>]` */
function parseNodeStatus(rest: string[], args: CliArgs): ParseResult {
  let json = false;
  let rpc = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === undefined) continue;
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--rpc') {
      rpc = true;
      continue;
    }
    if (a === '--data-dir') {
      const value = readDataDirFlag(rest, i);
      if (!value.ok) return value;
      args.dataDirArg = value.value;
      i = value.next;
      continue;
    }
    return { ok: false, error: `Unknown argument for node status: ${a}` };
  }
  if (args.help) return { ok: true, args };
  args.node = { kind: 'status', json, rpc };
  return { ok: true, args };
}

/** `node stop [--data-dir <path>]` */
function parseNodeStop(rest: string[], args: CliArgs): ParseResult {
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === undefined) continue;
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--data-dir') {
      const value = readDataDirFlag(rest, i);
      if (!value.ok) return value;
      args.dataDirArg = value.value;
      i = value.next;
      continue;
    }
    return { ok: false, error: `Unknown argument for node stop: ${a}` };
  }
  if (args.help) return { ok: true, args };
  args.node = { kind: 'stop' };
  return { ok: true, args };
}

/** `node reload [--scope config,plugins]` */
function parseNodeReload(rest: string[], args: CliArgs): ParseResult {
  let scopes: string[] | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--scope') {
      const value = readFlagValue(rest, i, '--scope');
      if (!value.ok) return value;
      const parsed = parseReloadScopes(value.value);
      if (parsed === null) {
        return {
          ok: false,
          error: `Invalid --scope: ${value.value} (expected e.g. config,plugins)`,
        };
      }
      scopes = [...new Set([...(scopes ?? []), ...parsed])];
      i = value.next;
      continue;
    }
    if (a === '--data-dir') {
      const value = readDataDirFlag(rest, i);
      if (!value.ok) return value;
      args.dataDirArg = value.value;
      i = value.next;
      continue;
    }
    return { ok: false, error: `Unknown argument for node reload: ${a}` };
  }
  if (args.help) return { ok: true, args };
  args.node = { kind: 'reload', ...(scopes !== undefined ? { scopes } : {}) };
  return { ok: true, args };
}

/** `node <subcommand>` 分发 */
function parseNodeArgs(rest: string[], args: CliArgs): ParseResult {
  const sub = rest[0];
  if (sub === '--help' || sub === '-h') {
    args.help = true;
    return { ok: true, args };
  }
  if (sub === undefined) {
    return {
      ok: false,
      error: 'Missing node subcommand (start|status|stop|reload)',
    };
  }

  const tail = rest.slice(1);
  switch (sub) {
    case 'start':
      return parseNodeStart(tail, args);
    case 'status':
      return parseNodeStatus(tail, args);
    case 'stop':
      return parseNodeStop(tail, args);
    case 'reload':
      return parseNodeReload(tail, args);
    case 'token':
      return parseNodeToken(tail, args);
    default:
      return { ok: false, error: `Unknown node subcommand: ${sub}` };
  }
}

/** `node token [--print] [--json] [--node <id>]`（0.56） */
function parseNodeToken(rest: string[], args: CliArgs): ParseResult {
  let print = false;
  let json = false;
  let nodeId: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === undefined) continue;
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--print') {
      print = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--node') {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('-') || next.trim() === '') {
        return { ok: false, error: 'Missing value for --node' };
      }
      nodeId = next;
      i++;
      continue;
    }
    return { ok: false, error: `Unknown argument for node token: ${a}` };
  }
  if (args.help) return { ok: true, args };
  args.node = {
    kind: 'token',
    print,
    json,
    ...(nodeId !== undefined ? { nodeId } : {}),
  };
  return { ok: true, args };
}

/**
 * `token show|list|rotate`（0.56）。
 *
 * `show` 打印 token **值**：默认只允许交互式终端；自动化必须显式
 * `--allow-non-interactive`（仍然只在本机执行，不联网）。
 */
function parseTokenArgs(rest: string[], args: CliArgs): ParseResult {
  const sub = rest[0];
  if (sub === '--help' || sub === '-h') {
    args.help = true;
    return { ok: true, args };
  }
  if (sub === undefined) {
    return { ok: false, error: 'Missing token subcommand (show|list|rotate)' };
  }
  const tail = rest.slice(1);

  if (sub === 'list') {
    let json = false;
    let dataDir: string | undefined;
    for (let i = 0; i < tail.length; i++) {
      const a = tail[i];
      if (a === undefined) continue;
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      if (a === '--data-dir') {
        const next = tail[i + 1];
        if (next === undefined || next.startsWith('-') || next.trim() === '') {
          return { ok: false, error: 'Missing value for --data-dir' };
        }
        args.dataDirArg = next;
        dataDir = next;
        i++;
        continue;
      }
      return { ok: false, error: `Unknown argument for token list: ${a}` };
    }
    if (args.help) return { ok: true, args };
    args.tokenCommand = { kind: 'list', json, ...(dataDir !== undefined ? { dataDir } : {}) };
    return { ok: true, args };
  }

  if (sub === 'rotate') {
    let yes = false;
    let json = false;
    let dataDir: string | undefined;
    for (let i = 0; i < tail.length; i++) {
      const a = tail[i];
      if (a === undefined) continue;
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--yes' || a === '-y') {
        yes = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      if (a === '--data-dir') {
        const next = tail[i + 1];
        if (next === undefined || next.startsWith('-') || next.trim() === '') {
          return { ok: false, error: 'Missing value for --data-dir' };
        }
        args.dataDirArg = next;
        dataDir = next;
        i++;
        continue;
      }
      return { ok: false, error: `Unknown argument for token rotate: ${a}` };
    }
    if (args.help) return { ok: true, args };
    args.tokenCommand = {
      kind: 'rotate',
      yes,
      json,
      ...(dataDir !== undefined ? { dataDir } : {}),
    };
    return { ok: true, args };
  }

  if (sub !== 'show') {
    return { ok: false, error: `Unknown token subcommand: ${sub}` };
  }

  let purpose: string | undefined;
  let nodeId: string | undefined;
  let instanceId: string | undefined;
  let json = false;
  let allowNonInteractive = false;
  let dataDir: string | undefined;
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i];
    if (a === undefined) continue;
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--allow-non-interactive') {
      allowNonInteractive = true;
      continue;
    }
    if (a === '--purpose' || a === '--node' || a === '--instance' || a === '--data-dir') {
      const next = tail[i + 1];
      if (next === undefined || next.startsWith('-') || next.trim() === '') {
        return { ok: false, error: `Missing value for ${a}` };
      }
      if (a === '--purpose') purpose = next;
      else if (a === '--node') nodeId = next;
      else if (a === '--instance') instanceId = next;
      else {
        args.dataDirArg = next;
        dataDir = next;
      }
      i++;
      continue;
    }
    return { ok: false, error: `Unknown argument for token show: ${a}` };
  }
  if (args.help) return { ok: true, args };
  if (purpose === undefined) {
    return { ok: false, error: 'token show requires --purpose <platform|hub|node|proxy>' };
  }
  const id = nodeId ?? instanceId;
  args.tokenCommand = {
    kind: 'show',
    purpose,
    ...(id !== undefined ? { id } : {}),
    json,
    allowNonInteractive,
    ...(dataDir !== undefined ? { dataDir } : {}),
  };
  return { ok: true, args };
}

/**
 * `stop [--yes] [--instance <name> | --port <N> | --all] [--timeout <dur>]`
 * `stop --connect <url> [--connect-token <t>] [--ca <file>] [--yes] [--timeout <dur>]`
 *
 * 舰队级 stop（CONTRACT-stop-semantics S1）：本地缺省 = resolved data root 内所有实例的舰队；
 * `--instance`/`--port` 收窄单实例舰队（`--all` 按选择器复用接受，等价缺省）。
 * `--connect` = 远程单平台实例舰队，与任何本地选择器互斥（远程无 --all）。
 * 破坏性命令只认显式 `--connect` flag，不认 VESSEL_CONNECT env；
 * `--connect-token`/`--ca` 必须伴显式 `--connect`（比 model 先例更严）。
 * connect 三旗写回既有全局字段（parseModelArgs 先例，零新解析实体）。
 */
function parseStopArgs(rest: string[], args: CliArgs): ParseResult {
  let yes = false;
  let timeoutMs = DEFAULT_STOP_TIMEOUT_MS;
  const selector: GatewaySelector = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--yes') {
      yes = true;
      continue;
    }
    if (a === '--timeout') {
      const value = readFlagValue(rest, i, '--timeout');
      if (!value.ok) return value;
      const parsed = parseTimeoutMs(value.value);
      if (parsed === null) {
        return { ok: false, error: `Invalid --timeout: ${value.value} (expected e.g. 10s)` };
      }
      timeoutMs = parsed;
      i = value.next;
      continue;
    }
    if (a === '--connect' || a === '--connect-token' || a === '--ca') {
      const value = readFlagValue(rest, i, a);
      if (!value.ok) return value;
      if (a === '--connect') args.connectArg = value.value;
      else if (a === '--connect-token') args.connectTokenArg = value.value;
      else args.caArg = value.value;
      i = value.next;
      continue;
    }
    const selected = parseGatewaySelectorArg(rest, i, selector, 'stop');
    if (!selected.ok) return selected;
    if (selected.matched) {
      i = selected.next;
      continue;
    }
    if (a === '--data-dir') {
      const value = readDataDirFlag(rest, i);
      if (!value.ok) return value;
      args.dataDirArg = value.value;
      i = value.next;
      continue;
    }
    return { ok: false, error: `Unknown argument for stop: ${a}` };
  }
  if (args.help) return { ok: true, args };
  const selectorError = gatewaySelectorError(selector, 'stop');
  if (selectorError !== null) return { ok: false, error: selectorError };
  if (
    args.connectArg !== null &&
    (selector.instance !== undefined || selector.port !== undefined || selector.all === true)
  ) {
    return {
      ok: false,
      error: 'stop --connect cannot be combined with --instance, --port, or --all',
    };
  }
  // 比 model/全局先例更严：不认 VESSEL_CONNECT env 兜底（破坏性命令不静默跟随环境）。
  const connectOnly =
    args.connectTokenArg !== null ? '--connect-token' : args.caArg !== null ? '--ca' : null;
  if (connectOnly !== null && args.connectArg === null) {
    return { ok: false, error: `${connectOnly} requires --connect` };
  }
  // 本地缺省 = 全实例舰队（S1）：空选择器归一成 { all: true }（与显式 --all 等价）。
  // 注意不能把空 {} 透传给 stopGateway —— 那里 {} 是「default 实例」语义。
  // 远程（--connect）不带选择器（与 connectUrl 互斥）。
  const hasSelector =
    selector.instance !== undefined || selector.port !== undefined || selector.all === true;
  args.stopCommand = {
    yes,
    timeoutMs,
    selector: args.connectArg === null && !hasSelector ? { all: true } : selector,
  };
  return { ok: true, args };
}

// ── 0.14 status / agents / errors ─────────────────────

/** `status [--json]` */
function parseStatusArgs(rest: string[], args: CliArgs): ParseResult {
  let json = false;
  for (const a of rest) {
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    return { ok: false, error: `Unknown argument for status: ${a}` };
  }
  if (args.help) return { ok: true, args };
  args.statusCommand = { json };
  return { ok: true, args };
}

/**
 * `session status [--id <session>] [--json]`（AX 自服务 · 自观）。
 *
 * 连接参数经 `extractTargetFlags` 摘到全局字段（top-level parser 在 i===0
 * 提前返回，不会进入全局 `--connect` switch）；`--data-dir` 自行接受。
 */
function parseSessionArgs(rest: string[], args: CliArgs): ParseResult {
  const extracted = extractTargetFlags(rest, args);
  if (!extracted.ok) return extracted;
  rest = extracted.rest;
  const sub = rest[0];
  if (sub === undefined || sub === '--help' || sub === '-h') {
    args.help = true;
    return { ok: true, args };
  }
  if (sub !== 'status') {
    return { ok: false, error: `Unknown subcommand for session: ${sub}` };
  }
  const tail = rest.slice(1);
  let id: string | undefined;
  let json = false;
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--id') {
      const value = readFlagValue(tail, i, '--id');
      if (!value.ok) return value;
      id = value.value;
      i = value.next;
      continue;
    }
    if (a === '--data-dir') {
      const value = readFlagValue(tail, i, '--data-dir');
      if (!value.ok) return value;
      args.dataDirArg = value.value;
      i = value.next;
      continue;
    }
    return { ok: false, error: `Unknown argument for session status: ${a}` };
  }
  if (args.help) return { ok: true, args };
  args.sessionCommand = { kind: 'status', json, ...(id !== undefined ? { id } : {}) };
  return { ok: true, args };
}

/**
 * `permission show [--member <id>] [--json]`（AX 自服务 · 自观）。
 *
 * 连接参数经 `extractTargetFlags` 摘到全局字段；`--data-dir` 自行接受。
 */
function parsePermissionArgs(rest: string[], args: CliArgs): ParseResult {
  const extracted = extractTargetFlags(rest, args);
  if (!extracted.ok) return extracted;
  rest = extracted.rest;
  const sub = rest[0];
  if (sub === undefined || sub === '--help' || sub === '-h') {
    args.help = true;
    return { ok: true, args };
  }
  if (sub !== 'show') {
    return { ok: false, error: `Unknown subcommand for permission: ${sub}` };
  }
  const tail = rest.slice(1);
  let member: string | undefined;
  let json = false;
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--member') {
      const value = readFlagValue(tail, i, '--member');
      if (!value.ok) return value;
      member = value.value;
      i = value.next;
      continue;
    }
    if (a === '--data-dir') {
      const value = readFlagValue(tail, i, '--data-dir');
      if (!value.ok) return value;
      args.dataDirArg = value.value;
      i = value.next;
      continue;
    }
    return { ok: false, error: `Unknown argument for permission show: ${a}` };
  }
  if (args.help) return { ok: true, args };
  args.permissionCommand = { kind: 'show', json, ...(member !== undefined ? { member } : {}) };
  return { ok: true, args };
}

/** `agents [--json]` */
function parseAgentsArgs(rest: string[], args: CliArgs): ParseResult {
  let json = false;
  for (const a of rest) {
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    return { ok: false, error: `Unknown argument for agents: ${a}` };
  }
  if (args.help) return { ok: true, args };
  args.agentsCommand = { json };
  return { ok: true, args };
}

/** attention 分页上限（与 `interactions.list` 的 limit 上界一致）。 */
const ATTENTION_MAX_LIMIT = 500;
const ATTENTION_DEFAULT_LIMIT = 20;

function parseAttentionLimit(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number.parseInt(raw, 10);
  return value >= 1 && value <= ATTENTION_MAX_LIMIT ? value : null;
}

/** 逗号分隔正整数；去重；空 / 0 / 非数字 → null。 */
function parseAttentionSelect(raw: string): number[] | null {
  const parts = raw.split(',');
  const seen = new Set<number>();
  const selected: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const value = Number.parseInt(part, 10);
    if (value < 1) return null;
    if (seen.has(value)) continue;
    seen.add(value);
    selected.push(value);
  }
  return selected;
}

/**
 * `attention [respond] ...`。
 *
 * 连接参数在这里自行接受：顶层 parser 对 `attention` 在 i===0 提前返回，
 * 不会进入全局 `--connect` switch。
 */
function parseAttentionArgs(rest: string[], args: CliArgs): ParseResult {
  const isRespond = rest[0] === 'respond';
  const tail = isRespond ? rest.slice(1) : rest;

  let connectUrl: string | undefined;
  let connectToken: string | undefined;
  let caFile: string | undefined;
  let node: string | undefined;
  let allNodes = false;
  let to: string | undefined;
  let teamId: string | undefined;
  let agent: string | undefined;
  let status: 'pending' | 'orphaned' = 'pending';
  let statusExplicit = false;
  let order: 'oldest' | 'newest' | undefined;
  let limit = ATTENTION_DEFAULT_LIMIT;
  let cursor: string | undefined;
  let json = false;
  let interactive = false;
  let requestId: string | undefined;
  let select: number[] | undefined;
  let all = false;
  let decision: 'allow' | 'deny' | undefined;
  let answers: unknown[] | undefined;
  let remember = false;
  let yes = false;
  const positionals: string[] = [];

  for (let i = 0; i < tail.length; i++) {
    const a = tail[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--json') {
      if (isRespond) return { ok: false, error: 'Unknown argument for attention respond: --json' };
      json = true;
      continue;
    }
    if (a === '--interactive') {
      if (isRespond) {
        return { ok: false, error: '--interactive is only valid for `vessel attention` (list)' };
      }
      interactive = true;
      continue;
    }
    if (a === '--all-nodes') {
      allNodes = true;
      continue;
    }
    if (a === '--node') {
      const value = readFlagValue(tail, i, '--node');
      if (!value.ok) return value;
      node = value.value;
      i = value.next;
      continue;
    }
    if (a === '--all' || a === '--select' || a === '--allow' || a === '--deny') {
      if (!isRespond) return { ok: false, error: `${a} is only valid for attention respond` };
      if (a === '--all') {
        all = true;
        continue;
      }
      if (a === '--select') {
        const value = readFlagValue(tail, i, '--select');
        if (!value.ok) return value;
        const parsed = parseAttentionSelect(value.value);
        if (parsed === null) {
          return { ok: false, error: `Invalid --select: ${value.value} (expected 1,3,...)` };
        }
        select = parsed;
        i = value.next;
        continue;
      }
      const next: 'allow' | 'deny' = a === '--allow' ? 'allow' : 'deny';
      if (decision !== undefined && decision !== next) {
        return { ok: false, error: '--allow and --deny are mutually exclusive' };
      }
      decision = next;
      continue;
    }
    if (a === '--remember' || a === '--yes') {
      if (!isRespond) return { ok: false, error: `${a} is only valid for attention respond` };
      if (a === '--remember') remember = true;
      else yes = true;
      continue;
    }
    if (a === '--answers') {
      if (!isRespond) return { ok: false, error: '--answers is only valid for attention respond' };
      const value = readFlagValue(tail, i, '--answers');
      if (!value.ok) return value;
      let parsed: unknown;
      try {
        parsed = JSON.parse(value.value);
      } catch {
        return { ok: false, error: '--answers must be valid JSON' };
      }
      if (!Array.isArray(parsed)) return { ok: false, error: '--answers must be a JSON array' };
      answers = parsed;
      i = value.next;
      continue;
    }
    if (a === '--to') {
      const value = readFlagValue(tail, i, '--to');
      if (!value.ok) return value;
      const parsed = parseFederationAddress(value.value);
      if (!parsed.ok) return { ok: false, error: `Invalid --to: ${parsed.message}` };
      to = value.value;
      i = value.next;
      continue;
    }
    if (a === '--team' || a === '--agent') {
      const value = readFlagValue(tail, i, a);
      if (!value.ok) return value;
      if (a === '--team') teamId = value.value;
      else agent = value.value;
      i = value.next;
      continue;
    }
    if (a === '--status') {
      const value = readFlagValue(tail, i, '--status');
      if (!value.ok) return value;
      if (value.value !== 'pending' && value.value !== 'orphaned') {
        return { ok: false, error: '--status must be pending or orphaned' };
      }
      status = value.value;
      statusExplicit = true;
      i = value.next;
      continue;
    }
    if (a === '--order') {
      const value = readFlagValue(tail, i, '--order');
      if (!value.ok) return value;
      if (value.value !== 'oldest' && value.value !== 'newest') {
        return { ok: false, error: '--order must be oldest or newest' };
      }
      order = value.value;
      i = value.next;
      continue;
    }
    if (a === '--limit') {
      const value = readFlagValue(tail, i, '--limit');
      if (!value.ok) return value;
      const parsed = parseAttentionLimit(value.value);
      if (parsed === null) {
        return {
          ok: false,
          error: `Invalid --limit: ${value.value} (expected 1..${ATTENTION_MAX_LIMIT})`,
        };
      }
      limit = parsed;
      i = value.next;
      continue;
    }
    if (a === '--cursor') {
      const value = readFlagValue(tail, i, '--cursor');
      if (!value.ok) return value;
      cursor = value.value;
      i = value.next;
      continue;
    }
    if (a === '--connect-token') {
      // token 可能以 `-` 开头：与全局 parser 一样只要求非空。
      const next = tail[i + 1];
      if (next === undefined || next.trim() === '') {
        return { ok: false, error: 'Missing value for --connect-token' };
      }
      connectToken = next;
      i++;
      continue;
    }
    if (a === '--connect' || a === '--ca') {
      const value = readFlagValue(tail, i, a);
      if (!value.ok) return value;
      if (a === '--connect') connectUrl = value.value;
      else caFile = value.value;
      i = value.next;
      continue;
    }
    if (a.startsWith('-')) return { ok: false, error: `Unknown argument for attention: ${a}` };
    if (!isRespond) return { ok: false, error: `Unknown argument for attention: ${a}` };
    positionals.push(a);
  }

  if (args.help) return { ok: true, args };

  if (interactive && json) {
    return { ok: false, error: '--interactive cannot be combined with --json' };
  }
  if (isRespond && statusExplicit && status !== 'pending') {
    return {
      ok: false,
      error:
        'attention respond only supports --status pending; orphaned interactions cannot be answered',
    };
  }
  if (allNodes && isRespond) {
    return { ok: false, error: '--all-nodes is only valid for `vessel attention` (list)' };
  }
  if (allNodes && interactive) {
    return { ok: false, error: '--all-nodes cannot be combined with --interactive' };
  }
  if (allNodes && node !== undefined) {
    return { ok: false, error: '--all-nodes cannot be combined with --node' };
  }
  if (allNodes && connectUrl !== undefined) {
    return { ok: false, error: '--all-nodes cannot be combined with --connect' };
  }
  if (allNodes && to !== undefined) {
    return { ok: false, error: '--all-nodes cannot be combined with --to' };
  }
  if (allNodes && cursor !== undefined) {
    return { ok: false, error: '--all-nodes cannot be combined with --cursor' };
  }
  if (allNodes && (connectToken !== undefined || caFile !== undefined)) {
    return { ok: false, error: '--all-nodes uses each node token_env; drop --connect-token/--ca' };
  }
  if (node !== undefined && connectUrl !== undefined) {
    return { ok: false, error: '--node cannot be combined with --connect' };
  }
  if (node !== undefined && (connectToken !== undefined || caFile !== undefined)) {
    return {
      ok: false,
      error: '--node uses its configured token_env/ca_file; drop --connect-token/--ca',
    };
  }

  if (
    (connectToken !== undefined || caFile !== undefined) &&
    connectUrl === undefined &&
    (process.env.VESSEL_CONNECT ?? '').trim() === ''
  ) {
    return {
      ok: false,
      error: `${connectToken !== undefined ? '--connect-token' : '--ca'} requires --connect`,
    };
  }

  if (isRespond) {
    if (positionals.length > 1) {
      return { ok: false, error: 'attention respond accepts at most one <request_id>' };
    }
    requestId = positionals[0];
    const targets =
      (requestId !== undefined ? 1 : 0) + (select !== undefined ? 1 : 0) + (all ? 1 : 0);
    if (targets !== 1) {
      return {
        ok: false,
        error: 'attention respond requires exactly one of <request_id>, --select, or --all',
      };
    }
    if (all && !yes) return { ok: false, error: 'attention respond --all requires --yes' };
    if (select !== undefined && decision === undefined) {
      return { ok: false, error: 'attention respond --select requires --allow or --deny' };
    }
    if (answers !== undefined && requestId === undefined) {
      return { ok: false, error: '--answers requires a positional <request_id>' };
    }
    if (answers !== undefined && decision !== undefined) {
      return { ok: false, error: '--answers cannot be combined with --allow/--deny' };
    }
    if (answers === undefined && decision === undefined) {
      return {
        ok: false,
        error: 'attention respond requires --allow or --deny (or --answers with a request_id)',
      };
    }
    if (remember && answers !== undefined) {
      return { ok: false, error: '--remember requires --allow or --deny' };
    }
  }

  args.attentionCommand = {
    kind: isRespond ? 'respond' : 'list',
    ...(connectUrl !== undefined ? { connectUrl } : {}),
    ...(connectToken !== undefined ? { connectToken } : {}),
    ...(caFile !== undefined ? { caFile } : {}),
    ...(node !== undefined ? { node } : {}),
    allNodes,
    ...(to !== undefined ? { to } : {}),
    ...(teamId !== undefined ? { teamId } : {}),
    ...(agent !== undefined ? { agent } : {}),
    status,
    ...(order !== undefined ? { order } : {}),
    limit,
    ...(cursor !== undefined ? { cursor } : {}),
    json,
    interactive,
    ...(requestId !== undefined ? { requestId } : {}),
    ...(select !== undefined ? { select } : {}),
    all,
    ...(decision !== undefined ? { decision } : {}),
    ...(answers !== undefined ? { answers } : {}),
    remember,
    yes,
  };
  return { ok: true, args };
}

/** `agent create|send|inbox|close|list|dispatch`（0.17 Phase A；0.19 dispatch；0.32 inbox） */
function parseAgentArgs(rest: string[], args: CliArgs): ParseResult {
  const extracted = extractTargetFlags(rest, args);
  if (!extracted.ok) return extracted;
  rest = extracted.rest;
  // inbox 是本地只读队列，不经 RPC；显式拒绝 targeting，避免「以为打到了远端」。
  if (rest[0] === 'inbox' && (args.connectArg !== null || args.nodeTargetArg !== null)) {
    return { ok: false, error: 'agent inbox is local-only; --connect/--node are not supported' };
  }
  const sub = rest[0];
  if (sub === undefined || sub === '--help' || sub === '-h') {
    args.help = true;
    return { ok: true, args };
  }
  const tail = rest.slice(1);

  if (sub === 'create') {
    let json = false;
    let name: string | undefined;
    let model: string | undefined;
    let visibility: AgentVisibilityArg | undefined;
    let systemPrompt: string | undefined;
    let workspace: string | undefined;
    for (let i = 0; i < tail.length; i++) {
      const a = tail[i] ?? '';
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      if (
        a === '--name' ||
        a === '--model' ||
        a === '--visibility' ||
        a === '--system-prompt' ||
        a === '--workspace'
      ) {
        const value = readFlagValue(tail, i, a);
        if (!value.ok) return value;
        if (value.value === '') return { ok: false, error: `Invalid ${a}: empty value` };
        if (a === '--name') name = value.value;
        else if (a === '--model') model = value.value;
        else if (a === '--system-prompt') systemPrompt = value.value;
        else if (a === '--workspace') workspace = value.value;
        else {
          if (value.value !== 'private' && value.value !== 'team' && value.value !== 'tenant') {
            return {
              ok: false,
              error: `Invalid --visibility: ${value.value} (expected private|team|tenant)`,
            };
          }
          visibility = value.value;
        }
        i = value.next;
        continue;
      }
      return { ok: false, error: `Unknown argument for agent create: ${a}` };
    }
    if (args.help) return { ok: true, args };
    args.agentCommand = {
      kind: 'create',
      json,
      ...(name !== undefined ? { name } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(visibility !== undefined ? { visibility } : {}),
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(workspace !== undefined ? { workspace } : {}),
    };
    return { ok: true, args };
  }

  if (sub === 'send') {
    let json = false;
    let interrupt = false;
    let messageId: string | undefined;
    const positional: string[] = [];
    for (let i = 0; i < tail.length; i++) {
      const a = tail[i] ?? '';
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      if (a === '--interrupt') {
        interrupt = true;
        continue;
      }
      if (a === '--message-id') {
        const value = readFlagValue(tail, i, '--message-id');
        if (!value.ok) return value;
        messageId = value.value;
        i = value.next;
        continue;
      }
      if (a.startsWith('-')) {
        return { ok: false, error: `Unknown argument for agent send: ${a}` };
      }
      positional.push(a);
    }
    if (args.help) return { ok: true, args };
    const [member, ...contentParts] = positional;
    if (member === undefined || member === '') {
      return { ok: false, error: 'agent send requires <member> <content...>' };
    }
    const content = contentParts.join(' ');
    if (messageId !== undefined && !interrupt) {
      return { ok: false, error: 'agent send --message-id requires --interrupt' };
    }
    if (interrupt) {
      if (content !== '' && messageId !== undefined) {
        return { ok: false, error: 'agent send: pass either content or --message-id, not both' };
      }
      if (content === '' && messageId === undefined) {
        return {
          ok: false,
          error: 'agent send --interrupt requires <content...> or --message-id <id>',
        };
      }
    } else if (content === '') {
      return { ok: false, error: 'agent send requires non-empty <content...>' };
    }
    args.agentCommand = {
      kind: 'send',
      json,
      member,
      content,
      ...(interrupt ? { interrupt: true } : {}),
      ...(messageId !== undefined ? { messageId } : {}),
    };
    return { ok: true, args };
  }

  if (sub === 'inbox') {
    let json = false;
    const positional: string[] = [];
    for (const a of tail) {
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      if (a.startsWith('-')) {
        return { ok: false, error: `Unknown argument for agent inbox: ${a}` };
      }
      positional.push(a);
    }
    if (args.help) return { ok: true, args };
    const [member, extra] = positional;
    if (member === undefined || member === '') {
      return { ok: false, error: 'agent inbox requires <member>' };
    }
    if (extra !== undefined) {
      return { ok: false, error: `Unknown argument for agent inbox: ${extra}` };
    }
    args.agentCommand = { kind: 'inbox', json, member };
    return { ok: true, args };
  }

  if (sub === 'dispatch') {
    let json = false;
    let allowAutoCreate: boolean | undefined;
    const positional: string[] = [];
    for (const a of tail) {
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      if (a === '--allow-auto-create') {
        allowAutoCreate = true;
        continue;
      }
      if (a.startsWith('-')) {
        return { ok: false, error: `Unknown argument for agent dispatch: ${a}` };
      }
      positional.push(a);
    }
    if (args.help) return { ok: true, args };
    const [to, ...contentParts] = positional;
    const content = contentParts.join(' ');
    if (to === undefined || to === '' || content === '') {
      return { ok: false, error: 'agent dispatch requires <to> <content...>' };
    }
    args.agentCommand = {
      kind: 'dispatch',
      json,
      to,
      content,
      ...(allowAutoCreate !== undefined ? { allowAutoCreate } : {}),
    };
    return { ok: true, args };
  }

  if (sub === 'close') {
    let json = false;
    const members: string[] = [];
    for (const a of tail) {
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      if (a.startsWith('-')) {
        return { ok: false, error: `Unknown argument for agent close: ${a}` };
      }
      if (a !== '') members.push(a);
    }
    if (args.help) return { ok: true, args };
    if (members.length === 0) {
      return { ok: false, error: 'agent close requires at least one <member>' };
    }
    args.agentCommand = { kind: 'close', json, members };
    return { ok: true, args };
  }

  if (sub === 'list') {
    let json = false;
    let visibility: AgentVisibilityArg | undefined;
    let state: AgentStateArg | undefined;
    for (let i = 0; i < tail.length; i++) {
      const a = tail[i] ?? '';
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      if (a === '--visibility' || a === '--state') {
        const value = readFlagValue(tail, i, a);
        if (!value.ok) return value;
        if (a === '--visibility') {
          if (value.value !== 'private' && value.value !== 'team' && value.value !== 'tenant') {
            return {
              ok: false,
              error: `Invalid --visibility: ${value.value} (expected private|team|tenant)`,
            };
          }
          visibility = value.value;
        } else {
          const states: readonly AgentStateArg[] = [
            'created',
            'idle',
            'running',
            'waiting_permission',
            'completed',
            'failed',
            'cancelled',
            'closed',
            'stale',
          ];
          if (!states.includes(value.value as AgentStateArg)) {
            return { ok: false, error: `Invalid --state: ${value.value}` };
          }
          state = value.value as AgentStateArg;
        }
        i = value.next;
        continue;
      }
      return { ok: false, error: `Unknown argument for agent list: ${a}` };
    }
    if (args.help) return { ok: true, args };
    args.agentCommand = {
      kind: 'list',
      json,
      ...(visibility !== undefined ? { visibility } : {}),
      ...(state !== undefined ? { state } : {}),
    };
    return { ok: true, args };
  }

  return { ok: false, error: `Unknown agent subcommand: ${sub}` };
}

/** `team budget [override] <team_id> ...`（0.19 S4） */
function parseTeamBudget(tail: string[], args: CliArgs): ParseResult {
  const isOverride = tail[0] === 'override';
  const tokens = isOverride ? tail.slice(1) : tail;
  const errorPrefix = isOverride ? 'team budget override' : 'team budget';
  let json = false;
  let conversationId: string | undefined;
  let dimension: TeamBudgetDimension | undefined;
  let max: number | null | undefined;
  let maxSeen = false;
  const positional: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--conversation') {
      const value = readFlagValue(tokens, i, '--conversation');
      if (!value.ok) return value;
      conversationId = value.value;
      i = value.next;
      continue;
    }
    if (isOverride && a === '--dimension') {
      const value = readFlagValue(tokens, i, '--dimension');
      if (!value.ok) return value;
      if (
        value.value !== 'hops' &&
        value.value !== 'turns' &&
        value.value !== 'tokens' &&
        value.value !== 'wall_clock' &&
        value.value !== 'cycle'
      ) {
        return {
          ok: false,
          error: `Invalid --dimension: ${value.value} (expected hops|turns|tokens|wall_clock|cycle)`,
        };
      }
      dimension = value.value;
      i = value.next;
      continue;
    }
    if (isOverride && a === '--max') {
      const value = readFlagValue(tokens, i, '--max');
      if (!value.ok) return value;
      if (value.value === 'unlimited') {
        max = null;
      } else if (/^\d+$/.test(value.value)) {
        max = Number.parseInt(value.value, 10);
      } else {
        return {
          ok: false,
          error: `Invalid --max: ${value.value} (expected a non-negative integer or unlimited)`,
        };
      }
      maxSeen = true;
      i = value.next;
      continue;
    }
    if (a.startsWith('-')) {
      return { ok: false, error: `Unknown argument for ${errorPrefix}: ${a}` };
    }
    positional.push(a);
  }

  if (args.help) return { ok: true, args };
  const [teamId, extra] = positional;
  if (teamId === undefined || teamId === '') {
    return { ok: false, error: `${errorPrefix} requires <team_id>` };
  }
  if (extra !== undefined) {
    return { ok: false, error: `Unknown argument for ${errorPrefix}: ${extra}` };
  }

  if (!isOverride) {
    args.teamCommand = {
      kind: 'budget-status',
      teamId,
      ...(conversationId !== undefined ? { conversationId } : {}),
      json,
    };
    return { ok: true, args };
  }

  if (conversationId === undefined) {
    return { ok: false, error: 'team budget override requires --conversation <id>' };
  }
  if (dimension === undefined) {
    return { ok: false, error: 'team budget override requires --dimension <d>' };
  }
  if (!maxSeen) {
    return { ok: false, error: 'team budget override requires --max <n|unlimited>' };
  }
  args.teamCommand = {
    kind: 'budget-override',
    teamId,
    conversationId,
    dimension,
    max: max ?? null,
    json,
  };
  return { ok: true, args };
}

/**
 * `team list|get|show|mine|post|members|budget|create|update|archive|freeze|unfreeze`
 * （0.19 S3 / S4；0.24；0.27；0.51 show / mine）。
 * 只做语法；workspace / roster 解析在 `src/team-command.ts`。
 */
function parseTeamArgs(rest: string[], args: CliArgs): ParseResult {
  const extracted = extractTargetFlags(rest, args);
  if (!extracted.ok) return extracted;
  rest = extracted.rest;
  const sub = rest[0];
  if (sub === undefined || sub === '--help' || sub === '-h') {
    args.help = true;
    return { ok: true, args };
  }
  const tail = rest.slice(1);

  if (sub === 'list') {
    let json = false;
    for (const a of tail) {
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      return { ok: false, error: `Unknown argument for team list: ${a}` };
    }
    if (args.help) return { ok: true, args };
    args.teamCommand = { kind: 'list', json };
    return { ok: true, args };
  }

  if (sub === 'create') {
    let json = false;
    let name: string | undefined;
    let description: string | undefined;
    let policy: Record<string, unknown> | undefined;
    let policyFile: string | undefined;
    const positional: string[] = [];
    for (let i = 0; i < tail.length; i++) {
      const a = tail[i] ?? '';
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      if (a === '--name' || a === '--description') {
        const value = readFlagValue(tail, i, a);
        if (!value.ok) return value;
        if (value.value === '') return { ok: false, error: `Invalid ${a}: empty value` };
        if (a === '--name') name = value.value;
        else description = value.value;
        i = value.next;
        continue;
      }
      if (a === '--policy' || a === '--policy-file') {
        const value = readFlagValue(tail, i, a);
        if (!value.ok) return value;
        if (value.value === '') return { ok: false, error: `Invalid ${a}: empty value` };
        if (a === '--policy-file') {
          policyFile = value.value;
        } else {
          let parsed: unknown;
          try {
            parsed = JSON.parse(value.value);
          } catch {
            return { ok: false, error: 'Invalid --policy: expected a JSON object' };
          }
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return { ok: false, error: 'Invalid --policy: expected a JSON object' };
          }
          policy = parsed as Record<string, unknown>;
        }
        i = value.next;
        continue;
      }
      if (a.startsWith('-')) return { ok: false, error: `Unknown argument for team create: ${a}` };
      positional.push(a);
    }
    if (args.help) return { ok: true, args };
    if (policy !== undefined && policyFile !== undefined) {
      return { ok: false, error: 'Use only one of --policy / --policy-file' };
    }
    const [workspace, extra] = positional;
    if (workspace === undefined || workspace === '') {
      return { ok: false, error: 'team create requires <workspace>' };
    }
    if (extra !== undefined) {
      return { ok: false, error: `Unknown argument for team create: ${extra}` };
    }
    args.teamCommand = {
      kind: 'create',
      workspace,
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(policy !== undefined ? { policy } : {}),
      ...(policyFile !== undefined ? { policyFile } : {}),
      json,
    };
    return { ok: true, args };
  }

  if (sub === 'update') {
    let json = false;
    let name: string | undefined;
    let description: string | null | undefined;
    let policy: Record<string, unknown> | undefined;
    let policyFile: string | undefined;
    const positional: string[] = [];
    for (let i = 0; i < tail.length; i++) {
      const a = tail[i] ?? '';
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      if (a === '--clear-description') {
        description = null;
        continue;
      }
      if (a === '--name' || a === '--description') {
        const value = readFlagValue(tail, i, a);
        if (!value.ok) return value;
        if (value.value === '') return { ok: false, error: `Invalid ${a}: empty value` };
        if (a === '--name') name = value.value;
        else description = value.value;
        i = value.next;
        continue;
      }
      if (a === '--policy' || a === '--policy-file') {
        const value = readFlagValue(tail, i, a);
        if (!value.ok) return value;
        if (value.value === '') return { ok: false, error: `Invalid ${a}: empty value` };
        if (a === '--policy-file') {
          policyFile = value.value;
        } else {
          let parsed: unknown;
          try {
            parsed = JSON.parse(value.value);
          } catch {
            return { ok: false, error: 'Invalid --policy: expected a JSON object' };
          }
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return { ok: false, error: 'Invalid --policy: expected a JSON object' };
          }
          policy = parsed as Record<string, unknown>;
        }
        i = value.next;
        continue;
      }
      if (a.startsWith('-')) return { ok: false, error: `Unknown argument for team update: ${a}` };
      positional.push(a);
    }
    if (args.help) return { ok: true, args };
    if (policy !== undefined && policyFile !== undefined) {
      return { ok: false, error: 'Use only one of --policy / --policy-file' };
    }
    const [teamId, extra] = positional;
    if (teamId === undefined || teamId === '') {
      return { ok: false, error: 'team update requires <team_id>' };
    }
    if (extra !== undefined) {
      return { ok: false, error: `Unknown argument for team update: ${extra}` };
    }
    if (
      name === undefined &&
      description === undefined &&
      policy === undefined &&
      policyFile === undefined
    ) {
      return { ok: false, error: 'team update requires at least one field flag' };
    }
    args.teamCommand = {
      kind: 'update',
      teamId,
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(policy !== undefined ? { policy } : {}),
      ...(policyFile !== undefined ? { policyFile } : {}),
      json,
    };
    return { ok: true, args };
  }

  if (sub === 'archive') {
    let json = false;
    const positional: string[] = [];
    for (const a of tail) {
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      if (a.startsWith('-')) return { ok: false, error: `Unknown argument for team archive: ${a}` };
      positional.push(a);
    }
    if (args.help) return { ok: true, args };
    const [teamId, extra] = positional;
    if (teamId === undefined || teamId === '') {
      return { ok: false, error: 'team archive requires <team_id>' };
    }
    if (extra !== undefined) {
      return { ok: false, error: `Unknown argument for team archive: ${extra}` };
    }
    args.teamCommand = { kind: 'archive', teamId, json };
    return { ok: true, args };
  }

  if (sub === 'freeze' || sub === 'unfreeze') {
    let json = false;
    const positional: string[] = [];
    for (const a of tail) {
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      if (a.startsWith('-')) return { ok: false, error: `Unknown argument for team ${sub}: ${a}` };
      positional.push(a);
    }
    if (args.help) return { ok: true, args };
    const [teamId, extra] = positional;
    if (teamId === undefined || teamId === '') {
      return { ok: false, error: `team ${sub} requires <team_id>` };
    }
    if (extra !== undefined) {
      return { ok: false, error: `Unknown argument for team ${sub}: ${extra}` };
    }
    args.teamCommand = { kind: sub, teamId, json };
    return { ok: true, args };
  }

  if (sub === 'get') {
    let json = false;
    let limit: number | undefined;
    let members: number | undefined;
    const positional: string[] = [];
    for (let i = 0; i < tail.length; i++) {
      const a = tail[i] ?? '';
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      if (a === '--limit') {
        const value = readFlagValue(tail, i, '--limit');
        if (!value.ok) return value;
        if (!/^\d+$/.test(value.value) || Number.parseInt(value.value, 10) <= 0) {
          return { ok: false, error: `Invalid --limit: ${value.value}` };
        }
        limit = Number.parseInt(value.value, 10);
        i = value.next;
        continue;
      }
      if (a === '--members') {
        const value = readFlagValue(tail, i, '--members');
        if (!value.ok) return value;
        if (!/^\d+$/.test(value.value)) {
          return { ok: false, error: `Invalid --members: ${value.value} (expected 1..100)` };
        }
        const parsed = Number.parseInt(value.value, 10);
        if (parsed < 1 || parsed > 100) {
          return { ok: false, error: `Invalid --members: ${value.value} (expected 1..100)` };
        }
        members = parsed;
        i = value.next;
        continue;
      }
      if (a.startsWith('-')) {
        return { ok: false, error: `Unknown argument for team get: ${a}` };
      }
      positional.push(a);
    }
    if (args.help) return { ok: true, args };
    const [teamId, extra] = positional;
    if (teamId === undefined || teamId === '') {
      return { ok: false, error: 'team get requires <team_id>' };
    }
    if (extra !== undefined) {
      return { ok: false, error: `Unknown argument for team get: ${extra}` };
    }
    args.teamCommand = {
      kind: 'get',
      teamId,
      ...(limit !== undefined ? { limit } : {}),
      ...(members !== undefined ? { members } : {}),
      json,
    };
    return { ok: true, args };
  }

  if (sub === 'show') {
    let json = false;
    const positional: string[] = [];
    for (const a of tail) {
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      if (a.startsWith('-')) return { ok: false, error: `Unknown argument for team show: ${a}` };
      positional.push(a);
    }
    if (args.help) return { ok: true, args };
    const [team, extra] = positional;
    if (team === undefined || team === '') {
      return { ok: false, error: 'team show requires <team_id|slug>' };
    }
    if (extra !== undefined) {
      return { ok: false, error: `Unknown argument for team show: ${extra}` };
    }
    args.teamCommand = { kind: 'show', team, json };
    return { ok: true, args };
  }

  if (sub === 'mine') {
    let json = false;
    for (const a of tail) {
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      // 这条命令不看 cwd 以外的输入：多给一个字面量就是打字打错了，别静默忽略。
      return { ok: false, error: `Unknown argument for team mine: ${a}` };
    }
    if (args.help) return { ok: true, args };
    args.teamCommand = { kind: 'mine', json };
    return { ok: true, args };
  }

  if (sub === 'post') {
    let json = false;
    const mentions: string[] = [];
    const positional: string[] = [];
    for (let i = 0; i < tail.length; i++) {
      const a = tail[i] ?? '';
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      if (a === '--mention') {
        const value = readFlagValue(tail, i, '--mention');
        if (!value.ok) return value;
        if (value.value === '') {
          return { ok: false, error: 'Invalid --mention: empty value' };
        }
        mentions.push(value.value);
        i = value.next;
        continue;
      }
      if (a.startsWith('-')) {
        return { ok: false, error: `Unknown argument for team post: ${a}` };
      }
      positional.push(a);
    }
    if (args.help) return { ok: true, args };
    const [teamId, ...contentParts] = positional;
    const content = contentParts.join(' ');
    if (teamId === undefined || teamId === '' || content === '') {
      return { ok: false, error: 'team post requires <team_id> <content...>' };
    }
    args.teamCommand = { kind: 'post', teamId, content, mentions, json };
    return { ok: true, args };
  }

  if (sub === 'members') {
    let json = false;
    const positional: string[] = [];
    for (const a of tail) {
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      if (a.startsWith('-')) {
        return { ok: false, error: `Unknown argument for team members: ${a}` };
      }
      positional.push(a);
    }
    if (args.help) return { ok: true, args };
    const [teamId, action, member, extra] = positional;
    if (teamId === undefined || action === undefined || member === undefined) {
      return { ok: false, error: 'team members requires <team_id> add|remove <member>' };
    }
    if (action !== 'add' && action !== 'remove') {
      return {
        ok: false,
        error: `Invalid team members action: ${action} (expected add|remove)`,
      };
    }
    if (extra !== undefined) {
      return { ok: false, error: `Unknown argument for team members: ${extra}` };
    }
    args.teamCommand = { kind: 'members', teamId, action, member, json };
    return { ok: true, args };
  }

  if (sub === 'budget') {
    return parseTeamBudget(tail, args);
  }

  return { ok: false, error: `Unknown team subcommand: ${sub}` };
}

/**
 * `federation post --to <addr> --from <addr> <content...>` / `federation peers`
 * （S7.1；0.21 地址寻址）。
 *
 * 解析层只做语法与必填；地址形状与本地 roster 预校验在 `commands/federation.ts`。
 */
function parseFederationArgs(rest: string[], args: CliArgs): ParseResult {
  const sub = rest[0];
  if (sub === undefined || sub === '--help' || sub === '-h') {
    args.help = true;
    return { ok: true, args };
  }
  const tail = rest.slice(1);

  if (sub === 'peer') {
    return parseFederationPeerArgs(tail, args);
  }

  if (sub === 'pair-code') {
    let json = false;
    let ttl: number | undefined;
    for (let i = 0; i < tail.length; i++) {
      const a = tail[i] ?? '';
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      if (a === '--ttl') {
        const value = readFlagValue(tail, i, '--ttl');
        if (!value.ok) return value;
        if (!/^\d+$/.test(value.value)) {
          return { ok: false, error: `Invalid --ttl: ${value.value} (expected 60..3600 seconds)` };
        }
        const parsed = Number.parseInt(value.value, 10);
        if (parsed < 60 || parsed > 3600) {
          return { ok: false, error: `Invalid --ttl: ${value.value} (expected 60..3600 seconds)` };
        }
        ttl = parsed;
        i = value.next;
        continue;
      }
      return { ok: false, error: `Unknown argument for federation pair-code: ${a}` };
    }
    if (args.help) return { ok: true, args };
    args.federationCommand = { kind: 'pair-code', ...(ttl !== undefined ? { ttl } : {}), json };
    return { ok: true, args };
  }

  if (sub === 'join') {
    let json = false;
    let allowDirectory = false;
    let target: string | undefined;
    let code: string | undefined;
    let teamId = 'vessel';
    let peerTeamId: string | undefined;
    let selfUrl: string | undefined;
    const valueFlags = new Set(['--code', '--team-id', '--peer-team-id', '--url']);
    for (let i = 0; i < tail.length; i++) {
      const a = tail[i] ?? '';
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      if (a === '--allow-directory') {
        allowDirectory = true;
        continue;
      }
      if (valueFlags.has(a)) {
        const value = readFlagValue(tail, i, a);
        if (!value.ok) return value;
        if (a === '--code') code = value.value;
        else if (a === '--team-id') teamId = value.value;
        else if (a === '--peer-team-id') peerTeamId = value.value;
        else selfUrl = value.value;
        i = value.next;
        continue;
      }
      if (a.startsWith('-')) {
        return { ok: false, error: `Unknown argument for federation join: ${a}` };
      }
      if (target !== undefined) {
        return { ok: false, error: 'federation join takes exactly one <url|node-id>' };
      }
      target = a;
    }
    if (args.help) return { ok: true, args };
    if (target === undefined || target === '') {
      return { ok: false, error: 'federation join requires <url|node-id>' };
    }
    args.federationCommand = {
      kind: 'join',
      target,
      teamId,
      allowDirectory,
      ...(code !== undefined ? { code } : {}),
      ...(peerTeamId !== undefined ? { peerTeamId } : {}),
      ...(selfUrl !== undefined ? { selfUrl } : {}),
      json,
    };
    return { ok: true, args };
  }

  if (sub === 'discover') {
    let json = false;
    for (const a of tail) {
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      return { ok: false, error: `Unknown argument for federation discover: ${a}` };
    }
    if (args.help) return { ok: true, args };
    args.federationCommand = { kind: 'discover', json };
    return { ok: true, args };
  }

  if (sub === 'peers') {
    let json = false;
    for (const a of tail) {
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      return { ok: false, error: `Unknown argument for federation peers: ${a}` };
    }
    if (args.help) return { ok: true, args };
    args.federationCommand = { kind: 'peers', json };
    return { ok: true, args };
  }

  if (sub === 'team-info') {
    let json = false;
    let to: string | undefined;
    let members: number | undefined;
    for (let i = 0; i < tail.length; i++) {
      const a = tail[i] ?? '';
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      if (a === '--to') {
        const value = readFlagValue(tail, i, '--to');
        if (!value.ok) return value;
        to = value.value;
        i = value.next;
        continue;
      }
      if (a === '--members') {
        const value = readFlagValue(tail, i, '--members');
        if (!value.ok) return value;
        if (!/^\d+$/.test(value.value)) {
          return {
            ok: false,
            error: `Invalid --members: ${value.value} (expected 1..100)`,
          };
        }
        const parsed = Number.parseInt(value.value, 10);
        if (parsed < 1 || parsed > 100) {
          return {
            ok: false,
            error: `Invalid --members: ${value.value} (expected 1..100)`,
          };
        }
        members = parsed;
        i = value.next;
        continue;
      }
      return { ok: false, error: `Unknown argument for federation team-info: ${a}` };
    }
    if (args.help) return { ok: true, args };
    if (to === undefined) {
      return { ok: false, error: 'federation team-info requires --to <principal@node:team>' };
    }
    args.federationCommand = {
      kind: 'team-info',
      to,
      ...(members !== undefined ? { members } : {}),
      json,
    };
    return { ok: true, args };
  }

  if (sub !== 'post') return { ok: false, error: `Unknown federation subcommand: ${sub}` };

  let json = false;
  let to: string | undefined;
  let from: string | undefined;
  let conversationId: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--to' || a === '--from' || a === '--conversation-id') {
      const value = readFlagValue(tail, i, a);
      if (!value.ok) return value;
      if (a === '--to') to = value.value;
      else if (a === '--from') from = value.value;
      else conversationId = value.value;
      i = value.next;
      continue;
    }
    if (a.startsWith('-')) {
      return { ok: false, error: `Unknown argument for federation post: ${a}` };
    }
    positional.push(a);
  }
  if (args.help) return { ok: true, args };

  const content = positional.join(' ');
  if (to === undefined) {
    return { ok: false, error: 'federation post requires --to <principal@node:team>' };
  }
  if (from === undefined) {
    return { ok: false, error: 'federation post requires --from <principal@node:team>' };
  }
  if (content === '') {
    return { ok: false, error: 'federation post requires <content...>' };
  }

  args.federationCommand = {
    kind: 'post',
    to,
    from,
    content,
    ...(conversationId !== undefined ? { conversationId } : {}),
    json,
  };
  return { ok: true, args };
}

/**
 * `federation peer add|list|remove`（q-federation）：peer 动态管理。
 *
 * peers 是对象数组，不走标量 `config.set` 白名单；这里只做语法与必填，
 * 身份 / 重复 / 自指等语义校验在 `commands/federation-peer.ts`。
 */
function parseFederationPeerArgs(rest: string[], args: CliArgs): ParseResult {
  const sub = rest[0];
  if (sub === undefined || sub === '--help' || sub === '-h') {
    args.help = true;
    return { ok: true, args };
  }
  const tail = rest.slice(1);

  if (sub === 'list') {
    let json = false;
    for (const a of tail) {
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      return { ok: false, error: `Unknown argument for federation peer list: ${a}` };
    }
    if (args.help) return { ok: true, args };
    args.federationCommand = { kind: 'peer-list', json };
    return { ok: true, args };
  }

  if (sub === 'remove') {
    let json = false;
    let target: string | undefined;
    for (const a of tail) {
      if (a === '--help' || a === '-h') {
        args.help = true;
        continue;
      }
      if (a === '--json') {
        json = true;
        continue;
      }
      if (a.startsWith('-')) {
        return { ok: false, error: `Unknown argument for federation peer remove: ${a}` };
      }
      if (target !== undefined) {
        return { ok: false, error: 'federation peer remove takes exactly one <label|node-id>' };
      }
      target = a;
    }
    if (args.help) return { ok: true, args };
    if (target === undefined || target === '') {
      return {
        ok: false,
        error: 'federation peer remove requires <label|node-id> (label = <nodeId>:<teamId>)',
      };
    }
    args.federationCommand = { kind: 'peer-remove', target, json };
    return { ok: true, args };
  }

  if (sub !== 'add') return { ok: false, error: `Unknown federation peer subcommand: ${sub}` };

  let json = false;
  let allowDirectory = false;
  let nodeId: string | undefined;
  let teamId: string | undefined;
  let tokenEnv: string | undefined;
  let url: string | undefined;
  let localTeamId: string | undefined;
  let caFile: string | undefined;
  let direction: 'in' | 'out' | 'both' = 'both';
  const valueFlags = new Set([
    '--node-id',
    '--team-id',
    '--token-env',
    '--url',
    '--direction',
    '--local-team-id',
    '--ca-file',
  ]);
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--allow-directory') {
      allowDirectory = true;
      continue;
    }
    if (valueFlags.has(a)) {
      const value = readFlagValue(tail, i, a);
      if (!value.ok) return value;
      if (a === '--node-id') nodeId = value.value;
      else if (a === '--team-id') teamId = value.value;
      else if (a === '--token-env') tokenEnv = value.value;
      else if (a === '--url') url = value.value;
      else if (a === '--local-team-id') localTeamId = value.value;
      else if (a === '--ca-file') caFile = value.value;
      else {
        if (value.value !== 'in' && value.value !== 'out' && value.value !== 'both') {
          return {
            ok: false,
            error: `Invalid --direction: ${value.value} (expected in | out | both)`,
          };
        }
        direction = value.value;
      }
      i = value.next;
      continue;
    }
    return { ok: false, error: `Unknown argument for federation peer add: ${a}` };
  }
  if (args.help) return { ok: true, args };
  if (nodeId === undefined) {
    return { ok: false, error: 'federation peer add requires --node-id <node_id>' };
  }
  if (teamId === undefined) {
    return { ok: false, error: 'federation peer add requires --team-id <team_id>' };
  }
  if (tokenEnv === undefined) {
    return { ok: false, error: 'federation peer add requires --token-env <ENV_NAME>' };
  }
  // validator 同规则：direction 含 out 必须有 url（入站-only peer 可以没有）。
  if (direction !== 'in' && url === undefined) {
    return {
      ok: false,
      error: 'federation peer add requires --url <base-url> when direction includes out',
    };
  }
  args.federationCommand = {
    kind: 'peer-add',
    nodeId,
    teamId,
    tokenEnv,
    direction,
    allowDirectory,
    ...(url !== undefined ? { url } : {}),
    ...(localTeamId !== undefined ? { localTeamId } : {}),
    ...(caFile !== undefined ? { caFile } : {}),
    json,
  };
  return { ok: true, args };
}

// ── model 子命令（model-registry RPC 包装）─────────────────────────

/** 位置参数规格：个数 + 缺参错误里的用法提示。 */
const MODEL_POSITIONAL_SPEC: Readonly<Record<string, { count: number; usage: string }>> = {
  list: { count: 0, usage: '' },
  'vendor-set': { count: 1, usage: '<id>' },
  'vendor-remove': { count: 1, usage: '<id>' },
  'alias-set': { count: 2, usage: '<alias> <ref>' },
  'alias-remove': { count: 1, usage: '<alias>' },
  'set-default': { count: 1, usage: '<ref>' },
  'credential-set': { count: 1, usage: '<id>' },
  'credential-remove': { count: 1, usage: '<id>' },
  'credentials-list': { count: 0, usage: '' },
  test: { count: 1, usage: '<vendor>' },
};

/**
 * `model <sub> ...`。连接参数在这里自行接受（top-level parser 对 `model` 在
 * i===0 提前返回，不进全局 `--connect` switch）；写回全局 connectArg /
 * connectTokenArg / caArg，registry 透传给命令层（与 status / agents / errors 同形）。
 *
 * 解析层只做语法与必填；vendor entry 的字段 / 语义校验在插件 handler（parseVendorEntry）。
 */
function parseModelArgs(rest: string[], args: CliArgs): ParseResult {
  const sub = rest[0];
  if (sub === undefined || sub === '--help' || sub === '-h') {
    args.help = true;
    return { ok: true, args };
  }
  const spec = MODEL_POSITIONAL_SPEC[sub];
  if (spec === undefined) {
    return { ok: false, error: `Unknown model subcommand: ${sub}` };
  }
  const tail = rest.slice(1);

  let json = false;
  let entry: unknown;
  let entrySeen = false;
  let valueEnv: string | undefined;
  let valueStdin = false;
  let model: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < tail.length; i++) {
    const a = tail[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--connect' || a === '--connect-token' || a === '--ca') {
      const value = readFlagValue(tail, i, a);
      if (!value.ok) return value;
      if (a === '--connect') args.connectArg = value.value;
      else if (a === '--connect-token') args.connectTokenArg = value.value;
      else args.caArg = value.value;
      i = value.next;
      continue;
    }
    if (a === '--entry' && sub === 'vendor-set') {
      const value = readFlagValue(tail, i, '--entry');
      if (!value.ok) return value;
      try {
        entry = JSON.parse(value.value);
      } catch (error) {
        return {
          ok: false,
          error: `Invalid --entry JSON: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        return { ok: false, error: '--entry must be a JSON object (vendor entry)' };
      }
      entrySeen = true;
      i = value.next;
      continue;
    }
    if (a === '--value-env' && sub === 'credential-set') {
      const value = readFlagValue(tail, i, '--value-env');
      if (!value.ok) return value;
      // 与 hub --token-env 同口径的环境变量名形状。
      if (!HUB_ENV_NAME_RE.test(value.value)) {
        return { ok: false, error: 'Invalid --value-env: expected an environment variable name' };
      }
      valueEnv = value.value;
      i = value.next;
      continue;
    }
    if (a === '--value-stdin' && sub === 'credential-set') {
      valueStdin = true;
      continue;
    }
    if (a === '--model' && sub === 'test') {
      const value = readFlagValue(tail, i, '--model');
      if (!value.ok) return value;
      model = value.value;
      i = value.next;
      continue;
    }
    if (a.startsWith('-')) {
      return { ok: false, error: `Unknown argument for model ${sub}: ${a}` };
    }
    positional.push(a);
  }
  if (args.help) return { ok: true, args };

  // 与全局 parser 同口径：connect 专属参数只能用于连接（--connect 或 VESSEL_CONNECT）。
  const connectOnly =
    args.connectTokenArg !== null ? '--connect-token' : args.caArg !== null ? '--ca' : null;
  if (
    connectOnly !== null &&
    args.connectArg === null &&
    (process.env.VESSEL_CONNECT ?? '').trim() === ''
  ) {
    return { ok: false, error: `${connectOnly} requires --connect` };
  }

  if (positional.length !== spec.count) {
    return {
      ok: false,
      error:
        spec.count === 0
          ? `model ${sub} takes no positional arguments`
          : `model ${sub} requires ${spec.usage}`,
    };
  }

  switch (sub) {
    case 'list':
      args.modelCommand = { kind: 'list', json };
      break;
    case 'vendor-set': {
      if (!entrySeen) {
        return { ok: false, error: 'model vendor-set requires --entry <json>' };
      }
      args.modelCommand = { kind: 'vendor-set', id: positional[0] ?? '', entry, json };
      break;
    }
    case 'vendor-remove':
      args.modelCommand = { kind: 'vendor-remove', id: positional[0] ?? '', json };
      break;
    case 'alias-set':
      args.modelCommand = {
        kind: 'alias-set',
        alias: positional[0] ?? '',
        ref: positional[1] ?? '',
        json,
      };
      break;
    case 'alias-remove':
      args.modelCommand = { kind: 'alias-remove', alias: positional[0] ?? '', json };
      break;
    case 'set-default':
      args.modelCommand = { kind: 'set-default', ref: positional[0] ?? '', json };
      break;
    case 'credential-set': {
      if (valueEnv !== undefined && valueStdin) {
        return { ok: false, error: '--value-env and --value-stdin are mutually exclusive' };
      }
      args.modelCommand = {
        kind: 'credential-set',
        id: positional[0] ?? '',
        ...(valueEnv !== undefined ? { valueEnv } : {}),
        valueStdin,
        json,
      };
      break;
    }
    case 'credential-remove':
      args.modelCommand = { kind: 'credential-remove', id: positional[0] ?? '', json };
      break;
    case 'credentials-list':
      args.modelCommand = { kind: 'credentials-list', json };
      break;
    case 'test':
      args.modelCommand = {
        kind: 'test',
        vendor: positional[0] ?? '',
        ...(model !== undefined ? { model } : {}),
        json,
      };
      break;
  }
  return { ok: true, args };
}

// ── S5 hub 子命令 ─────────────────────────────────

const HUB_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

function parseHubTtl(raw: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min || value > max) return null;
  return value;
}

function parseHubEnvName(
  raw: string,
  flag: string,
): { ok: true; value: string } | { ok: false; error: string } {
  if (!HUB_ENV_NAME_RE.test(raw)) {
    return { ok: false, error: `Invalid ${flag}: expected an environment variable name` };
  }
  return { ok: true, value: raw };
}

/** `hub start [--host --port --data-dir --allow-remote --tls-cert --tls-key]` */
function parseHubStart(rest: string[], args: CliArgs): ParseResult {
  const command: Extract<HubCommand, { kind: 'start' }> = { kind: 'start' };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--allow-remote') {
      command.allowRemote = true;
      continue;
    }
    if (
      a === '--host' ||
      a === '--port' ||
      a === '--data-dir' ||
      a === '--tls-cert' ||
      a === '--tls-key'
    ) {
      const value = readFlagValue(rest, i, a);
      if (!value.ok) return value;
      if (a === '--port') {
        const port = parsePort(value.value);
        if (port === null) return { ok: false, error: `Invalid port for --port: ${value.value}` };
        command.port = port;
      } else if (a === '--host') {
        command.host = value.value;
      } else if (a === '--data-dir') {
        command.dataDir = value.value;
      } else if (a === '--tls-cert') {
        command.tlsCert = value.value;
      } else {
        command.tlsKey = value.value;
      }
      i = value.next;
      continue;
    }
    return { ok: false, error: `Unknown argument for hub start: ${a}` };
  }
  if (args.help) return { ok: true, args };
  if ((command.tlsCert === undefined) !== (command.tlsKey === undefined)) {
    return { ok: false, error: 'hub start requires both --tls-cert and --tls-key' };
  }
  args.hubCommand = command;
  return { ok: true, args };
}

/** `hub directory [--hub-url] [--token-env] [--json]` */
function parseHubDirectory(rest: string[], args: CliArgs): ParseResult {
  let hubUrl: string | undefined;
  let tokenEnv: string | undefined;
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--hub-url' || a === '--token-env') {
      const value = readFlagValue(rest, i, a);
      if (!value.ok) return value;
      if (a === '--hub-url') hubUrl = value.value;
      else {
        const envName = parseHubEnvName(value.value, '--token-env');
        if (!envName.ok) return envName;
        tokenEnv = envName.value;
      }
      i = value.next;
      continue;
    }
    return { ok: false, error: `Unknown argument for hub directory: ${a}` };
  }
  if (args.help) return { ok: true, args };
  args.hubCommand = {
    kind: 'directory',
    json,
    ...(hubUrl !== undefined ? { hubUrl } : {}),
    ...(tokenEnv !== undefined ? { tokenEnv } : {}),
  };
  return { ok: true, args };
}

/** `hub watch [--hub-url] [--token-env]` */
function parseHubWatch(rest: string[], args: CliArgs): ParseResult {
  let hubUrl: string | undefined;
  let tokenEnv: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--hub-url' || a === '--token-env') {
      const value = readFlagValue(rest, i, a);
      if (!value.ok) return value;
      if (a === '--hub-url') hubUrl = value.value;
      else {
        const envName = parseHubEnvName(value.value, '--token-env');
        if (!envName.ok) return envName;
        tokenEnv = envName.value;
      }
      i = value.next;
      continue;
    }
    return { ok: false, error: `Unknown argument for hub watch: ${a}` };
  }
  if (args.help) return { ok: true, args };
  args.hubCommand = {
    kind: 'watch',
    ...(hubUrl !== undefined ? { hubUrl } : {}),
    ...(tokenEnv !== undefined ? { tokenEnv } : {}),
  };
  return { ok: true, args };
}

/** `hub join-code [--ttl] [--json]`（hub 侧，S5.1） */
function parseHubJoinCode(rest: string[], args: CliArgs): ParseResult {
  let dataDir: string | undefined;
  let ttl: number | undefined;
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--data-dir' || a === '--ttl') {
      const value = readFlagValue(rest, i, a);
      if (!value.ok) return value;
      if (a === '--data-dir') dataDir = value.value;
      else {
        const parsed = parseHubTtl(value.value, 60, 3600);
        if (parsed === null) {
          return { ok: false, error: `Invalid --ttl: ${value.value} (60-3600 seconds)` };
        }
        ttl = parsed;
      }
      i = value.next;
      continue;
    }
    return { ok: false, error: `Unknown argument for hub join-code: ${a}` };
  }
  if (args.help) return { ok: true, args };
  args.hubCommand = {
    kind: 'join-code',
    json,
    ...(dataDir !== undefined ? { dataDir } : {}),
    ...(ttl !== undefined ? { ttl } : {}),
  };
  return { ok: true, args };
}

/** `hub join [hub-url] --code <CODE> | --code-env <ENV> [...]`（node 侧，S5.1） */
function parseHubJoin(rest: string[], args: CliArgs): ParseResult {
  let code: string | undefined;
  let codeEnv: string | undefined;
  let publicUrl: string | undefined;
  let caFile: string | undefined;
  let dataDir: string | undefined;
  let json = false;
  const positional: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    if (
      a === '--code' ||
      a === '--code-env' ||
      a === '--public-url' ||
      a === '--ca' ||
      a === '--data-dir'
    ) {
      const value = readFlagValue(rest, i, a);
      if (!value.ok) return value;
      if (a === '--code') code = value.value;
      else if (a === '--code-env') {
        const envName = parseHubEnvName(value.value, '--code-env');
        if (!envName.ok) return envName;
        codeEnv = envName.value;
      } else if (a === '--public-url') publicUrl = value.value;
      else if (a === '--ca') caFile = value.value;
      else dataDir = value.value;
      i = value.next;
      continue;
    }
    if (a.startsWith('-')) {
      return { ok: false, error: `Unknown argument for hub join: ${a}` };
    }
    positional.push(a);
  }
  if (args.help) return { ok: true, args };

  const [hubUrl, extra] = positional;
  if (extra !== undefined) {
    return { ok: false, error: `Unknown argument for hub join: ${extra}` };
  }
  if (code !== undefined && codeEnv !== undefined) {
    return { ok: false, error: 'hub join accepts only one of --code and --code-env' };
  }

  args.hubCommand = {
    kind: 'join',
    json,
    ...(hubUrl !== undefined ? { hubUrl } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(codeEnv !== undefined ? { codeEnv } : {}),
    ...(publicUrl !== undefined ? { publicUrl } : {}),
    ...(caFile !== undefined ? { caFile } : {}),
    ...(dataDir !== undefined ? { dataDir } : {}),
  };
  return { ok: true, args };
}

/** `hub node list [--hub-url] [--json]` */
function parseHubNodeList(rest: string[], args: CliArgs): ParseResult {
  let hubUrl: string | undefined;
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--hub-url') {
      const value = readFlagValue(rest, i, a);
      if (!value.ok) return value;
      hubUrl = value.value;
      i = value.next;
      continue;
    }
    return { ok: false, error: `Unknown argument for hub node list: ${a}` };
  }
  if (args.help) return { ok: true, args };
  args.hubCommand = { kind: 'node-list', json, ...(hubUrl !== undefined ? { hubUrl } : {}) };
  return { ok: true, args };
}

/** `hub node remove <pairing_id> [--hub-url]` */
function parseHubNodeRemove(rest: string[], args: CliArgs): ParseResult {
  let hubUrl: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--hub-url') {
      const value = readFlagValue(rest, i, a);
      if (!value.ok) return value;
      hubUrl = value.value;
      i = value.next;
      continue;
    }
    if (a.startsWith('-')) {
      return { ok: false, error: `Unknown argument for hub node remove: ${a}` };
    }
    positional.push(a);
  }
  if (args.help) return { ok: true, args };
  const [pairingId, extra] = positional;
  if (pairingId === undefined || pairingId === '') {
    return { ok: false, error: 'hub node remove requires <pairing_id>' };
  }
  if (extra !== undefined) {
    return { ok: false, error: `Unknown argument for hub node remove: ${extra}` };
  }
  args.hubCommand = {
    kind: 'node-remove',
    pairingId,
    ...(hubUrl !== undefined ? { hubUrl } : {}),
  };
  return { ok: true, args };
}

/** `hub node <list|remove>` */
function parseHubNodeArgs(rest: string[], args: CliArgs): ParseResult {
  const sub = rest[0];
  if (sub === '--help' || sub === '-h') {
    args.help = true;
    return { ok: true, args };
  }
  if (sub === undefined) {
    return { ok: false, error: 'Missing hub node subcommand (list|remove)' };
  }
  const tail = rest.slice(1);
  switch (sub) {
    case 'list':
      return parseHubNodeList(tail, args);
    case 'remove':
      return parseHubNodeRemove(tail, args);
    case 'add':
      return {
        ok: false,
        error: 'vessel hub node add was removed; use vessel hub join-code then vessel hub join',
      };
    default:
      return { ok: false, error: `Unknown hub node subcommand: ${sub}` };
  }
}

/** `hub <subcommand>` 分发 */
function parseHubArgs(rest: string[], args: CliArgs): ParseResult {
  const sub = rest[0];
  if (sub === '--help' || sub === '-h') {
    args.help = true;
    args.hubCommand = null;
    return { ok: true, args };
  }
  if (sub === undefined) {
    return {
      ok: false,
      error: 'Missing hub subcommand (start|directory|watch|join-code|join|node)',
    };
  }
  const tail = rest.slice(1);
  switch (sub) {
    // ── service（保留）──
    case 'start':
      return parseHubStart(tail, args);
    case 'directory':
      return parseHubDirectory(tail, args);
    case 'watch':
      return parseHubWatch(tail, args);
    case 'join-code':
      return parseHubJoinCode(tail, args);
    case 'node':
      return parseHubNodeArgs(tail, args);
    // ── node client（保留）──
    case 'join':
      return parseHubJoin(tail, args);
    // H5 删除的 legacy 命令：fail-closed 并给出同侧/跨侧替代。
    case 'pair':
      return {
        ok: false,
        error:
          'vessel hub pair was removed; use vessel hub join-code on the hub, then vessel hub join on this node',
      };
    case 'token':
      return { ok: false, error: 'vessel hub token was removed; use vessel hub join' };
    case 'data-token':
      return { ok: false, error: 'vessel hub data-token was removed; use vessel hub join' };
    default:
      return { ok: false, error: `Unknown hub subcommand: ${sub}` };
  }
}

/** `errors [--json] [--limit N]` */
function parseErrorsArgs(rest: string[], args: CliArgs): ParseResult {
  let json = false;
  let limit: number | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--limit') {
      const value = readFlagValue(rest, i, '--limit');
      if (!value.ok) return value;
      if (!/^\d+$/.test(value.value)) {
        return { ok: false, error: `Invalid --limit: ${value.value}` };
      }
      const parsed = Number.parseInt(value.value, 10);
      if (parsed < 1 || parsed > 200) {
        return { ok: false, error: `Invalid --limit: ${value.value} (1-200)` };
      }
      limit = parsed;
      i = value.next;
      continue;
    }
    return { ok: false, error: `Unknown argument for errors: ${a}` };
  }
  if (args.help) return { ok: true, args };
  args.errorsCommand = { json, ...(limit !== undefined ? { limit } : {}) };
  return { ok: true, args };
}

/** `doctor [--json] [--deep]` */
function parseDoctorArgs(rest: string[], args: CliArgs): ParseResult {
  let json = false;
  let deep = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === undefined) continue;
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--deep') {
      deep = true;
      continue;
    }
    // 0.56.1：和 gateway/node 同族命令一致，便于「我现在看的是哪个实例」。
    if (a === '--data-dir') {
      const value = readDataDirFlag(rest, i);
      if (!value.ok) return value;
      args.dataDirArg = value.value;
      i = value.next;
      continue;
    }
    return { ok: false, error: `Unknown argument for doctor: ${a}` };
  }
  if (args.help) return { ok: true, args };
  args.doctorCommand = { json, ...(deep ? { deep: true } : {}) };
  return { ok: true, args };
}

/** `logs tail [--json] [--lines N] [--instance <name>]` */
function parseLogsArgs(rest: string[], args: CliArgs): ParseResult {
  if (rest[0] !== 'tail') {
    return { ok: false, error: 'Usage: vessel logs tail [--json] [--lines N]' };
  }
  let json = false;
  let lines = 50;
  let instance: string | undefined;
  for (let i = 1; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--lines' || a === '-n') {
      const value = readFlagValue(rest, i, a);
      if (!value.ok) return value;
      if (!/^\d+$/.test(value.value)) {
        return { ok: false, error: `Invalid --lines: ${value.value}` };
      }
      const parsed = Number.parseInt(value.value, 10);
      if (parsed < 1 || parsed > 10_000) {
        return { ok: false, error: `Invalid --lines: ${value.value} (1-10000)` };
      }
      lines = parsed;
      i = value.next;
      continue;
    }
    if (a === '--instance') {
      const value = readFlagValue(rest, i, '--instance');
      if (!value.ok) return value;
      const parsed = parseInstanceName(value.value);
      if (parsed === null) {
        return { ok: false, error: `Invalid --instance: ${value.value}` };
      }
      instance = parsed;
      i = value.next;
      continue;
    }
    return { ok: false, error: `Unknown argument for logs tail: ${a}` };
  }
  if (args.help) return { ok: true, args };
  args.logsCommand = { kind: 'tail', json, lines, ...(instance !== undefined ? { instance } : {}) };
  return { ok: true, args };
}
// ── rpc 子命令（AX 自服务 · capabilities.list 包装）─────────────────────

/** `rpc list [--json] [--node <id>] [--connect <url>]` */
function parseRpcArgs(rest: string[], args: CliArgs): ParseResult {
  const extracted = extractTargetFlags(rest, args);
  if (!extracted.ok) return extracted;
  rest = extracted.rest;
  const sub = rest[0];
  if (sub === undefined || sub === '--help' || sub === '-h') {
    args.help = true;
    return { ok: true, args };
  }
  if (sub !== 'list') {
    return { ok: false, error: `Unknown rpc subcommand: ${sub}` };
  }
  let json = false;
  for (let i = 1; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    return { ok: false, error: `Unknown argument for rpc list: ${a}` };
  }
  if (args.help) return { ok: true, args };
  args.rpcCommand = { kind: 'list', json };
  return { ok: true, args };
}

// ── fleet 子命令（AX 自服务 · 本舰队总览）─────────────────────────────

/** `fleet status [--json]`（本地只读；--data-dir / --user-config 走全局旗标） */
function parseFleetArgs(rest: string[], args: CliArgs): ParseResult {
  const sub = rest[0];
  if (sub === undefined || sub === '--help' || sub === '-h') {
    args.help = true;
    return { ok: true, args };
  }
  if (sub !== 'status') {
    return { ok: false, error: `Unknown fleet subcommand: ${sub}` };
  }
  let json = false;
  for (let i = 1; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    // 与 gateway/node/doctor 同族：子命令内也认 --data-dir（写回全局字段）。
    if (a === '--data-dir') {
      const value = readDataDirFlag(rest, i);
      if (!value.ok) return value;
      args.dataDirArg = value.value;
      i = value.next;
      continue;
    }
    return { ok: false, error: `Unknown argument for fleet status: ${a}` };
  }
  if (args.help) return { ok: true, args };
  args.fleetCommand = { kind: 'status', json };
  return { ok: true, args };
}
