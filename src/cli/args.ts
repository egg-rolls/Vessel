/**
 * CLI 域命令类型 + 保留常量（cli-single-source W2 slim）。
 *
 * 解析唯一源 = command-spec.ts（schema）+ parse-engine.ts（引擎）；
 * 分派唯一源 = project.ts（projectDispatch）。本模块只保留 commands/*
 * 消费的域选项类型（run 实现签名零改动）与共享常量。
 * 原 parseArgs / 顶层 if 链 / 逐命令 parseXxxArgs / CliArgs 已删除（设计 §5.3）。
 */

import type { SettableConfigKey } from '../config/ui-settings';

/** `--serve` 省略端口时的默认值（移居 parse-validators；re-export 兼容既有消费） */
export { DEFAULT_SERVE_PORT } from './parse-validators';

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
      /**
       * 用户裁定 #1（start 即退）：缺省 true（detach）——spawn 平台后打印
       * pid/port/node name 即退出；`--foreground` 显式 false 保留前台（调试）。
       */
      daemon: boolean;
      instance?: string;
      port?: number;
      host?: string;
      log?: string;
    }
  | ({
      kind: 'stop';
      /** 用户裁定 #5：缺省 undefined = 不限时 drain；显式 --timeout 才是可选上限。 */
      timeoutMs?: number;
      /**
       * 0.55.1：缺省只停平台层，**不动 node/hub**（它们身上可能跑着会话，杀掉不可恢复）。
       * 破坏性动作要显式：`--stop-nodes` 才连 node/hub 一起停（整舰队真停）；
       * `--keep-nodes` / `--no-keep-nodes` 保留解析作兼容别名（前者等价缺省，后者等价 --stop-nodes）。
       */
      keepNodes?: boolean;
      /** 用户裁定 #5：--force = 显式非正常退出（快照 + 强杀 + 审计 abnormal_exit）。 */
      force?: boolean;
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
      /** 用户裁定 #5：--force 传播到 stop 段（非正常退出 + 审计）；start 段无 force 语义。 */
      force?: boolean;
      /**
       * 用户裁定 #6：gateway restart 恒平台-only（不碰 node/hub）。--stop-nodes /
       * --no-keep-nodes 已弃用：解析保留但不再停 node，置此旗标供命令打弃用 warning
       * 并指路 `vessel restart`（舰队级 stop+start）。
       */
      stopNodesDeprecated?: boolean;
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
  | { kind: 'stop'; force?: boolean }
  | { kind: 'restart'; force?: boolean; name?: string }
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
      // q-env-config-set：与 ui-settings CONFIG_SET_TARGETS 单一事实源同口径
      // （含 envInjection 三层键）；逐键值校验在 configSetCommand。
      key: SettableConfigKey;
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
  /** q-error-e3（§3.10）：`--errors` 近期错误 + 注册表漂移巡检（additive；rebase 吸收） */
  errors?: boolean;
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
      /** q-hire-prompt：创建即投递的首条任务（与 --startup-prompt-file 互斥）。 */
      startupPrompt?: string;
      /** q-hire-prompt：长文本任务文件路径（命令层读取；与 --startup-prompt 互斥）。 */
      startupPromptFile?: string;
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
 * `vessel kanban ...` 子命令（q-tooling）：kanban.list / kanban.view 的 CLI 包装。
 * targeting（--node / --connect / --connect-token / --ca）复用全局字段，
 * 由 extractTargetFlags 前置摘出（与 rpc / agent / team 同机制）。
 */
export type KanbanCommand =
  | { kind: 'list'; column?: string; owner?: string; status?: string; json: boolean }
  | { kind: 'view'; id: string; json: boolean };

/**
 * `vessel fleet ...` 子命令：本舰队一屏总览（AX 自服务 · 发现组）。
 * 本地只读命令：不接受 targeting（--connect / --node），严格本舰队 dataDir。
 */
export type FleetCommand = { kind: 'status'; json: boolean };

/**
 * `vessel ps` / `vessel gateway ps` / `vessel node ps` / `vessel hub ps`
 * （用户裁定 #4：docker ps 式进程管理）。
 *
 * `type` 缺省 = 全部类型；`all` = 含已停止（docker ps -a 式）。
 * 只读本舰队运行时文件；--data-dir / --user-config 走全局旗标。
 */
export type PsCommand = {
  kind: 'ps';
  type?: 'gateway' | 'node' | 'hub';
  json: boolean;
  all: boolean;
};

/**
 * `vessel model ...` 子命令：model-registry 插件 canonical RPC 的 CLI 包装（两面重构 §8.2）。
 *
 * kind 与 `plugin.model-registry.<name>` 一一对应（kebab → snake 在命令层映射）。
 * credential-set 的 value 不在 argv 出现：只经 `--value-env` / `--value-stdin` /
 * 交互隐藏输入三条路（命令层解析），这里只携带来源声明。
 */
export type ModelCommand =
  | { kind: 'list'; json: boolean }
  | { kind: 'set'; id: string; entry: unknown; json: boolean }
  | { kind: 'remove'; id: string; json: boolean }
  | { kind: 'set-default'; ref: string; json: boolean }
  | {
      kind: 'credential-set';
      id: string;
      baseUrl: string;
      apiKeyEnv?: string;
      valueEnv?: string;
      valueStdin: boolean;
      json: boolean;
    }
  | { kind: 'credential-remove'; id: string; json: boolean }
  | { kind: 'credentials-list'; json: boolean }
  | {
      kind: 'test';
      entry?: string;
      credential?: string;
      provider?: string;
      model?: string;
      json: boolean;
    };

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
      /** T2（cli-single-source）：--daemon 分离启动；缺省仍前台（兼容）。 */
      daemon?: boolean;
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

// ── 保留常量（域类型见上；解析/分派唯一源 = command-spec + parse-engine + project） ──

/** `gateway stop` 缺省等待时长 */
export const DEFAULT_STOP_TIMEOUT_MS = 10_000;
