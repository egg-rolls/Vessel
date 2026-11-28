/**
 * CLI 命令单一真相源（cli-single-source P1 · S1）。
 *
 * 一条 CommandSpec 声明「命令是什么」：路径 / 摘要 / flag / 位置参数 / 约束 /
 * 路由面 / 懒实现引用。六消费面（执行分派 / argv 解析 / 命令页 help / 全局总览 /
 * shell 补全 / i18n 键声明）全部由 `project.ts` 纯函数投射，任何消费面不再手写
 * 命令 / flag 清单（设计 §2.1 / §3）。
 *
 * **纯数据硬约束**（S4 §2.3 help 早退零 IO）：本模块静态 import 闭包只含
 * 纯数据 + 轻校验器 + i18n 类型，**无 commands/* 实现**——实现经 `load()` 动态
 * thunk 懒加载，分派投射模块的 dynamic import 边界保持（cli.ts 先例）。
 *
 * 类型互锁（设计 D3 / §8.4 main 裁定：优先映射类型全推断）：
 * - `ParsedFlags<S>` 由 spec.flags 字面量联合映射——run 读未声明 flag = 编译红；
 * - summary 键由 path 约定派生（help.cmd.<camelPath>，§8.8 main 裁定），
 *   派生键不在 catalog 时强制显式声明。
 *
 * @module vessel/cli-command-spec
 */

import type { MessageKey } from '../i18n';
import {
  parseAttentionSelect,
  parseHubEnvName,
  parseInstanceName,
  parseOlderThanMs,
  parsePort,
  parseReloadScopes,
  parseTimeoutMs,
} from './parse-validators';

// ── flag 取值形态（单一声明，三处投射：解析 arity / help 占位 / 补全候选） ──

/** flag 取值形态（设计 §2.2 sketch）。 */
export type FlagValueKind =
  | { readonly kind: 'boolean' }
  | {
      readonly kind: 'string';
      readonly placeholder: string;
      readonly parse?: (raw: string) => { ok: true; value: string } | { ok: false; error: string };
    }
  | {
      readonly kind: 'number';
      readonly placeholder: string;
      readonly parse: (raw: string) => number | null;
    }
  | {
      readonly kind: 'enum';
      readonly candidates: readonly string[];
      /** 展示占位覆盖（--state <state> 先例：候选供补全，help 占位保持现态文案） */
      readonly placeholder?: string;
    }
  | {
      readonly kind: 'dynamic';
      readonly placeholder: string;
      /** 可选校验（--instance 语法 / --scope逗号列表 / --dimension 枚举校验先例） */
      readonly parse?: (raw: string) => { ok: true; value: unknown } | { ok: false; error: string };
    }
  | { readonly kind: 'optional-string'; readonly placeholder: string };

/** 一个 flag 的完整声明（合并现 CLI_FLAG_VALUE / CLI_FLAG_HELP / 补全三清单 / 解析校验）。 */
export interface FlagSpec {
  /** 长字面量 '--instance'（const 推断下为字面量类型成员） */
  readonly flag: string;
  /** 短别名 '-n'（今天只活在补全/解析，收敛到此；解析归一 + 补全候选） */
  readonly aliases?: readonly string[];
  readonly value: FlagValueKind;
  /** 说明键（现 CLI_FLAG_HELP）；入口专用 flag（不上命令页）可省 */
  readonly help?: MessageKey;
  /** 全局 flag（现 GLOBAL_FLAGS）：任何命令可叠加，入口层处理 */
  readonly global?: boolean;
  /** 必填（现 CliHelpCommand.required）：usage 行不加方括号 */
  readonly required?: boolean;
  /** 弃用 warning 键（--stop-nodes 先例）：解析保留 + warning，help 带弃用标注 */
  readonly deprecated?: MessageKey;
  /** 解析但不渲染 / 不补全（内部 --orchestrate / --handoff 先例） */
  readonly hidden?: boolean;
  /** 可重复 flag（--filter / --allowed-origin / --mention 先例）：产物为数组 */
  readonly repeatable?: boolean;
  /** 缺值错误文案（现态 parser 口径 parity；缺省 `Missing value for <flag>`） */
  readonly missingError?: string;
  /** 非法值错误文案（现态 parser 口径 parity；缺省 `Invalid value for <flag>: <raw>`） */
  readonly invalidError?: (raw: string) => string;
}

// ── flag 规范表（每个 flag 单一声明；命令以字面量引用） ──

/**
 * 全部 flag 的规范声明（合并现 CLI_FLAG_VALUE / CLI_FLAG_HELP / 补全三清单 /
 * 解析校验器）。命令 spec.flags 只写字面量引用此表——flag 数据不重复，
 * 字面量 ⊆ keyof FLAG_DEFS 编译期校验（D3 守卫）。S2-S4 转录现态。
 * 实施微调（设计 sketch flags: FlagSpec[] → 字面量引用 + 规范表，候 lead 知悉）：
 * 守卫强度不变（ParsedFlags 仍由声明字面量映射），消除 ~96 命令的 FlagSpec 重复。
 */
export const FLAG_DEFS = {
  // ── 全局 / 入口 flag（声明序 = 现 GLOBAL_FLAGS 序；global:true 派生补全顶层清单） ──
  '--help': {
    flag: '--help',
    aliases: ['-h'],
    value: { kind: 'boolean' },
    help: 'flag.help',
    global: true,
  },
  '--version': { flag: '--version', aliases: ['-v'], value: { kind: 'boolean' }, global: true },
  '--tools': { flag: '--tools', value: { kind: 'boolean' }, global: true },
  '--feishu': { flag: '--feishu', value: { kind: 'boolean' }, global: true },
  '--run': {
    flag: '--run',
    aliases: ['-p', '--print'],
    value: { kind: 'optional-string', placeholder: '<prompt>' },
    help: 'flag.run',
    global: true,
  },
  '--continue': { flag: '--continue', aliases: ['-c'], value: { kind: 'boolean' }, global: true },
  '--resume': {
    flag: '--resume',
    aliases: ['-r'],
    value: { kind: 'optional-string', placeholder: '<id>' },
    global: true,
  },
  '--session': {
    flag: '--session',
    aliases: ['-s'],
    value: { kind: 'dynamic', placeholder: '<id>' },
    help: 'flag.session',
    global: true,
  },
  '--resume-run': {
    flag: '--resume-run',
    value: { kind: 'optional-string', placeholder: '<runId>' },
    global: true,
  },
  '--serve': {
    flag: '--serve',
    value: { kind: 'optional-string', placeholder: '[N]' },
    global: true,
  },
  '--serve-host': {
    flag: '--serve-host',
    value: { kind: 'dynamic', placeholder: '<host>' },
    global: true,
  },
  '--allow-remote': {
    flag: '--allow-remote',
    value: { kind: 'boolean' },
    help: 'flag.allowRemote',
    global: true,
  },
  '--tls-cert': {
    flag: '--tls-cert',
    value: { kind: 'dynamic', placeholder: '<path>' },
    help: 'flag.tlsCert',
    global: true,
  },
  '--tls-key': {
    flag: '--tls-key',
    value: { kind: 'dynamic', placeholder: '<path>' },
    help: 'flag.tlsKey',
    global: true,
  },
  '--data-dir': {
    flag: '--data-dir',
    value: { kind: 'dynamic', placeholder: '<path>' },
    help: 'flag.dataDir',
    global: true,
  },
  '--connect': {
    flag: '--connect',
    value: { kind: 'dynamic', placeholder: '<url>' },
    help: 'flag.connect',
    global: true,
  },
  '--connect-token': {
    flag: '--connect-token',
    value: { kind: 'dynamic', placeholder: '<token>' },
    help: 'flag.connectToken',
    global: true,
  },
  '--ca': {
    flag: '--ca',
    aliases: ['--connect-ca'],
    value: { kind: 'dynamic', placeholder: '<path>' },
    help: 'flag.ca',
    global: true,
  },
  '--allowed-origin': {
    flag: '--allowed-origin',
    value: { kind: 'dynamic', placeholder: '<origin>' },
    global: true,
    repeatable: true,
  },
  // ── 命令 flag（现 CLI_FLAG_VALUE 序；kind 合并 args 解析 / completion 三清单） ──
  // boolean（CLI_FLAG_VALUE null 占位）
  '--json': { flag: '--json', value: { kind: 'boolean' }, help: 'flag.json' },
  '--daemon': { flag: '--daemon', value: { kind: 'boolean' }, help: 'flag.daemon' },
  '--foreground': { flag: '--foreground', value: { kind: 'boolean' }, help: 'flag.foreground' },
  '--keep-nodes': { flag: '--keep-nodes', value: { kind: 'boolean' }, help: 'flag.keepNodes' },
  '--no-keep-nodes': {
    flag: '--no-keep-nodes',
    value: { kind: 'boolean' },
    help: 'flag.noKeepNodes',
  },
  '--force': { flag: '--force', value: { kind: 'boolean' }, help: 'flag.force' },
  '--yes': { flag: '--yes', aliases: ['-y'], value: { kind: 'boolean' }, help: 'flag.yes' },
  '--check': { flag: '--check', value: { kind: 'boolean' }, help: 'flag.check' },
  '--deep': { flag: '--deep', value: { kind: 'boolean' }, help: 'flag.deep' },
  '--rpc': { flag: '--rpc', value: { kind: 'boolean' }, help: 'flag.rpc' },
  '--sources': { flag: '--sources', value: { kind: 'boolean' }, help: 'flag.sources' },
  '--dry-run': { flag: '--dry-run', value: { kind: 'boolean' }, help: 'flag.dryRun' },
  '--apply': { flag: '--apply', value: { kind: 'boolean' }, help: 'flag.apply' },
  '--interactive': { flag: '--interactive', value: { kind: 'boolean' }, help: 'flag.interactive' },
  '--all-nodes': { flag: '--all-nodes', value: { kind: 'boolean' }, help: 'flag.allNodes' },
  '--all': { flag: '--all', value: { kind: 'boolean' }, help: 'flag.all' },
  '--allow': { flag: '--allow', value: { kind: 'boolean' }, help: 'flag.allow' },
  '--deny': { flag: '--deny', value: { kind: 'boolean' }, help: 'flag.deny' },
  '--remember': { flag: '--remember', value: { kind: 'boolean' }, help: 'flag.remember' },
  '--interrupt': { flag: '--interrupt', value: { kind: 'boolean' }, help: 'flag.interrupt' },
  '--allow-auto-create': {
    flag: '--allow-auto-create',
    value: { kind: 'boolean' },
    help: 'flag.allowAutoCreate',
  },
  '--allow-network': {
    flag: '--allow-network',
    value: { kind: 'boolean' },
    help: 'flag.allowNetwork',
  },
  '--no-auto-start': {
    flag: '--no-auto-start',
    value: { kind: 'boolean' },
    help: 'flag.noAutoStart',
  },
  '--systemd': { flag: '--systemd', value: { kind: 'boolean' }, help: 'flag.systemd' },
  '--launchd': { flag: '--launchd', value: { kind: 'boolean' }, help: 'flag.launchd' },
  '--schtasks': { flag: '--schtasks', value: { kind: 'boolean' }, help: 'flag.schtasks' },
  '--clear-description': {
    flag: '--clear-description',
    value: { kind: 'boolean' },
    help: 'flag.clearDescription',
  },
  '--self': { flag: '--self', value: { kind: 'boolean' }, help: 'flag.self' },
  '--value-stdin': { flag: '--value-stdin', value: { kind: 'boolean' }, help: 'flag.valueStdin' },
  '--allow-directory': {
    flag: '--allow-directory',
    value: { kind: 'boolean' },
    help: 'flag.allowDirectory',
  },
  // enum（静态候选 → 补全 flagValues；--state 占位保持现态 '<state>' 文案）
  '--channel': {
    flag: '--channel',
    value: { kind: 'enum', candidates: ['latest', 'beta'] },
    help: 'flag.channel',
    invalidError: (raw) => `Invalid channel: ${raw} (expected "latest" or "beta")`,
  },
  '--visibility': {
    flag: '--visibility',
    value: { kind: 'enum', candidates: ['private', 'team', 'tenant'] },
    help: 'flag.visibility',
  },
  '--state': {
    flag: '--state',
    value: {
      kind: 'enum',
      candidates: [
        'created',
        'idle',
        'running',
        'waiting_permission',
        'completed',
        'failed',
        'cancelled',
        'closed',
        'stale',
      ],
      placeholder: '<state>',
    },
    help: 'flag.state',
  },
  '--order': {
    flag: '--order',
    value: { kind: 'enum', candidates: ['oldest', 'newest'] },
    help: 'flag.order',
  },
  '--direction': {
    flag: '--direction',
    value: { kind: 'enum', candidates: ['in', 'out', 'both'] },
    help: 'flag.direction',
  },
  // number（无静态候选 → 补全 DYNAMIC 派生含 number；校验器引 parse-validators）
  '--port': {
    flag: '--port',
    value: { kind: 'number', placeholder: '<N>', parse: parsePort },
    help: 'flag.port',
  },
  '--limit': {
    flag: '--limit',
    value: {
      kind: 'number',
      placeholder: '<n>',
      parse: (raw) =>
        /^\d+$/.test(raw) && Number.parseInt(raw, 10) > 0 ? Number.parseInt(raw, 10) : null,
    },
    help: 'flag.limit',
    invalidError: (raw) => `Invalid --limit: ${raw}`,
  },
  '--members': {
    flag: '--members',
    value: {
      kind: 'number',
      placeholder: '<n>',
      parse: (raw) => (/^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null),
    },
    help: 'flag.members',
    invalidError: (raw) => `Invalid --members: ${raw} (expected 1..100)`,
  },
  '--lines': {
    flag: '--lines',
    aliases: ['-n'],
    value: {
      kind: 'number',
      placeholder: '<n>',
      parse: (raw) => (/^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null),
    },
    help: 'flag.lines',
  },
  '--ttl': {
    flag: '--ttl',
    value: {
      kind: 'number',
      placeholder: '<seconds>',
      parse: (raw) => (/^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null),
    },
    help: 'flag.ttl',
  },
  '--timeout': {
    flag: '--timeout',
    value: { kind: 'number', placeholder: '<dur>', parse: parseTimeoutMs },
    help: 'flag.timeout',
  },
  '--wait-timeout': {
    flag: '--wait-timeout',
    value: { kind: 'number', placeholder: '<dur>', parse: parseTimeoutMs },
    help: 'flag.waitTimeout',
    invalidError: (raw) => `Invalid --wait-timeout: ${raw} (expected e.g. 120s)`,
  },
  '--older-than': {
    flag: '--older-than',
    value: { kind: 'number', placeholder: '<dur>', parse: parseOlderThanMs },
    help: 'flag.olderThan',
  },
  // dynamic（现 DYNAMIC_VALUE_FLAGS：无静态候选，补全回落文件/默认）
  '--out': { flag: '--out', value: { kind: 'dynamic', placeholder: '<path>' }, help: 'flag.out' },
  '--filter': {
    flag: '--filter',
    value: { kind: 'dynamic', placeholder: '<tag>' },
    help: 'flag.filter',
    repeatable: true,
  },
  '--source': {
    flag: '--source',
    value: { kind: 'dynamic', placeholder: '<path>' },
    help: 'flag.source',
  },
  '--from': {
    flag: '--from',
    value: { kind: 'dynamic', placeholder: '<value>' },
    help: 'flag.from',
  },
  '--to': { flag: '--to', value: { kind: 'dynamic', placeholder: '<value>' }, help: 'flag.to' },
  '--name': {
    flag: '--name',
    value: { kind: 'dynamic', placeholder: '<name>' },
    help: 'flag.name',
  },
  '--model': {
    flag: '--model',
    value: { kind: 'dynamic', placeholder: '<model>' },
    help: 'flag.model',
  },
  '--system-prompt': {
    flag: '--system-prompt',
    value: { kind: 'dynamic', placeholder: '<text>' },
    help: 'flag.systemPrompt',
  },
  '--startup-prompt': {
    flag: '--startup-prompt',
    value: { kind: 'dynamic', placeholder: '<text>' },
    help: 'flag.startupPrompt',
  },
  '--startup-prompt-file': {
    flag: '--startup-prompt-file',
    value: { kind: 'dynamic', placeholder: '<path>' },
    help: 'flag.startupPromptFile',
  },
  '--workspace': {
    flag: '--workspace',
    value: { kind: 'dynamic', placeholder: '<path>' },
    help: 'flag.workspace',
  },
  '--mention': {
    flag: '--mention',
    value: { kind: 'dynamic', placeholder: '<name|id>' },
    help: 'flag.mention',
    repeatable: true,
  },
  '--hub-url': {
    flag: '--hub-url',
    value: { kind: 'dynamic', placeholder: '<URL>' },
    help: 'flag.hubUrl',
  },
  '--token-env': {
    flag: '--token-env',
    value: {
      kind: 'dynamic',
      placeholder: '<ENV>',
      parse: (raw) => parseHubEnvName(raw, '--token-env'),
    },
    help: 'flag.tokenEnv',
  },
  '--code': {
    flag: '--code',
    value: { kind: 'dynamic', placeholder: '<CODE>' },
    help: 'flag.code',
  },
  '--code-env': {
    flag: '--code-env',
    value: {
      kind: 'dynamic',
      placeholder: '<ENV>',
      parse: (raw) => parseHubEnvName(raw, '--code-env'),
    },
    help: 'flag.codeEnv',
  },
  '--public-url': {
    flag: '--public-url',
    value: { kind: 'dynamic', placeholder: '<url>' },
    help: 'flag.publicUrl',
  },
  '--conversation': {
    flag: '--conversation',
    value: { kind: 'dynamic', placeholder: '<id>' },
    help: 'flag.conversation',
  },
  '--dimension': {
    flag: '--dimension',
    value: { kind: 'dynamic', placeholder: '<hops|turns|tokens|wall_clock|cycle>' },
    help: 'flag.dimension',
  },
  '--max': {
    flag: '--max',
    value: { kind: 'dynamic', placeholder: '<n|unlimited>' },
    help: 'flag.max',
  },
  '--agent': {
    flag: '--agent',
    value: { kind: 'dynamic', placeholder: '<name>' },
    help: 'flag.agent',
  },
  '--cursor': {
    flag: '--cursor',
    value: { kind: 'dynamic', placeholder: '<cursor>' },
    help: 'flag.cursor',
  },
  '--select': {
    flag: '--select',
    value: {
      kind: 'dynamic',
      placeholder: '<ids>',
      parse: (raw) => {
        const v = parseAttentionSelect(raw);
        return v === null
          ? { ok: false, error: `Invalid --select: ${raw} (expected 1,3,...)` }
          : { ok: true, value: v };
      },
    },
    help: 'flag.select',
  },
  '--answers': {
    flag: '--answers',
    value: { kind: 'dynamic', placeholder: '<json>' },
    help: 'flag.answers',
  },
  '--entry': {
    flag: '--entry',
    value: { kind: 'dynamic', placeholder: '<json>' },
    help: 'flag.entry',
  },
  '--value-env': {
    flag: '--value-env',
    value: {
      kind: 'dynamic',
      placeholder: '<ENV>',
      parse: (raw) => parseHubEnvName(raw, '--value-env'),
    },
    help: 'flag.valueEnv',
  },
  '--instance': {
    flag: '--instance',
    value: {
      kind: 'dynamic',
      placeholder: '<name>',
      parse: (raw) => {
        const v = parseInstanceName(raw);
        return v === null
          ? {
              ok: false,
              error: `Invalid --instance: ${raw} (expected ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$)`,
            }
          : { ok: true, value: v };
      },
    },
    help: 'flag.instance',
  },
  '--host': { flag: '--host', value: { kind: 'dynamic', placeholder: '<H>' }, help: 'flag.host' },
  '--log': { flag: '--log', value: { kind: 'dynamic', placeholder: '<path>' }, help: 'flag.log' },
  '--config': {
    flag: '--config',
    value: { kind: 'dynamic', placeholder: '<path>' },
    help: 'flag.config',
  },
  '--scope': {
    flag: '--scope',
    value: {
      kind: 'dynamic',
      placeholder: '<config,plugins>',
      parse: (raw) => {
        const v = parseReloadScopes(raw);
        return v === null
          ? { ok: false, error: `Invalid --scope: ${raw} (expected e.g. config,plugins)` }
          : { ok: true, value: v };
      },
    },
    help: 'flag.scope',
  },
  '--team': {
    flag: '--team',
    value: { kind: 'dynamic', placeholder: '<team_id>' },
    help: 'flag.team',
  },
  // string（有值但现态不在 DYNAMIC 清单：补全不回落、无静态候选，保持现态）
  '--message-id': {
    flag: '--message-id',
    value: { kind: 'string', placeholder: '<id>' },
    help: 'flag.messageId',
  },
  '--id': { flag: '--id', value: { kind: 'string', placeholder: '<id>' }, help: 'flag.id' },
  '--member': {
    flag: '--member',
    value: { kind: 'string', placeholder: '<id>' },
    help: 'flag.member',
  },
  '--description': {
    flag: '--description',
    value: { kind: 'string', placeholder: '<text>' },
    help: 'flag.description',
  },
  '--policy': {
    flag: '--policy',
    value: { kind: 'string', placeholder: '<json>' },
    help: 'flag.policy',
  },
  '--policy-file': {
    flag: '--policy-file',
    value: { kind: 'string', placeholder: '<path>' },
    help: 'flag.policyFile',
  },
  '--conversation-id': {
    flag: '--conversation-id',
    value: { kind: 'string', placeholder: '<id>' },
    help: 'flag.conversationId',
  },
  '--prompt': {
    flag: '--prompt',
    value: { kind: 'string', placeholder: '<text>' },
    help: 'flag.prompt',
  },
  '--node': { flag: '--node', value: { kind: 'string', placeholder: '<name>' }, help: 'flag.node' },
  '--column': {
    flag: '--column',
    value: { kind: 'string', placeholder: '<column>' },
    help: 'flag.column',
  },
  '--owner': {
    flag: '--owner',
    value: { kind: 'string', placeholder: '<owner>' },
    help: 'flag.owner',
  },
  '--base-url': {
    flag: '--base-url',
    value: { kind: 'string', placeholder: '<url>' },
    help: 'flag.baseUrl',
  },
  '--api-key-env': {
    flag: '--api-key-env',
    value: {
      kind: 'string',
      placeholder: '<ENV>',
      parse: (raw) => parseHubEnvName(raw, '--api-key-env'),
    },
    help: 'flag.apiKeyEnv',
  },
  '--credential': {
    flag: '--credential',
    value: { kind: 'string', placeholder: '<id>' },
    help: 'flag.credential',
  },
  '--provider': {
    flag: '--provider',
    value: { kind: 'string', placeholder: '<name>' },
    help: 'flag.provider',
  },
  '--node-id': {
    flag: '--node-id',
    value: { kind: 'string', placeholder: '<node_id>' },
    help: 'flag.nodeId',
  },
  '--team-id': {
    flag: '--team-id',
    value: { kind: 'string', placeholder: '<team_id>' },
    help: 'flag.teamId',
  },
  '--peer-team-id': {
    flag: '--peer-team-id',
    value: { kind: 'string', placeholder: '<team_id>' },
    help: 'flag.peerTeamId',
  },
  '--url': {
    flag: '--url',
    value: { kind: 'string', placeholder: '<base-url>' },
    help: 'flag.url',
  },
  '--local-team-id': {
    flag: '--local-team-id',
    value: { kind: 'string', placeholder: '<team_id>' },
    help: 'flag.localTeamId',
  },
  '--ca-file': {
    flag: '--ca-file',
    value: { kind: 'string', placeholder: '<path>' },
    help: 'flag.caFile',
  },
} as const satisfies Readonly<Record<string, FlagSpec>>;

/** flag 字面量联合（取代现 CliFlag 白名单）。 */
export type FlagLiteral = keyof typeof FLAG_DEFS;

/** 运行时 flag 规范查找（宽形状访问器；字面量互锁经 ParsedFlags 映射，不在此）。 */
export function flagDef(flag: string): FlagSpec | undefined {
  return (FLAG_DEFS as Readonly<Record<string, FlagSpec>>)[flag];
}

// ── 全局 / 入口层字段（现 CliArgs 全局字段原样保留；逐命令字段删除） ──

/**
 * 全局与入口模式字段（parse-engine 全局层产物）。
 * 语义与现 CliArgs 同名字段逐一对应（语义零变化硬验收）；
 * 入口模式（REPL / -c / -r / -p / --run / --serve）不是 schema 命令，
 * 由 cli.ts 入口处理（设计 §3.1 / §3.4）。
 */
export interface Globals {
  demo: boolean;
  /** null = 非 headless；'' = 从 stdin 读；非空 = 文本 prompt 或 @file */
  runArg: string | null;
  pipeMode: boolean;
  sessionArg: string | null;
  continueArg: boolean;
  /** null = 未使用；'' = 列出会话；非空 = 恢复该会话 */
  resumeArg: string | null;
  /** null = 不启动 gateway；0 = 由系统分配端口 */
  servePort: number | null;
  servePortExplicit: boolean;
  serveHost: string | null;
  allowRemote: boolean;
  tlsCert: string | null;
  tlsKey: string | null;
  /** null = 未使用；'' = 列出可恢复 run；非空 = 恢复该 run */
  resumeRunArg: string | null;
  help: boolean;
  version: boolean;
  tools: boolean;
  feishu: boolean;
  connectArg: string | null;
  connectTokenArg: string | null;
  caArg: string | null;
  nodeTargetArg: string | null;
  allowedOrigins: string[];
  dataDirArg: string | null;
  userConfigArg: string | null;
}

/** 一次性命令执行上下文（现 CliCommandContext 形状不变）。 */
export interface CommandContext {
  /** `VESSEL_MOCK=1|true` */
  useMock: boolean;
  /** 已解析配置（入口可注入；hub 等命令缺省自行 loadConfig）。 */
  config?: import('../../packages/config/src/index').VesselConfig;
}

// ── ParsedFlags 映射推断（§8.4 强守卫形态） ──

/** 单个 flag 的解析产物类型（由 value.kind + repeatable 映射）。 */
export type FlagBaseValue<F extends FlagSpec> = F['value'] extends { kind: 'boolean' }
  ? boolean
  : F['value'] extends { kind: 'number' }
    ? number | undefined
    : F['value'] extends { kind: 'enum'; candidates: readonly (infer C)[] }
      ? C | undefined
      : string | undefined;

export type FlagParsedValue<F extends FlagSpec> = F extends { repeatable: true }
  ? Exclude<FlagBaseValue<F>, undefined>[] | undefined
  : FlagBaseValue<F>;

/** spec.flags 字面量联合 → 解析产物映射（run 读未声明 flag = 编译红）。 */
export type ParsedFlags<S extends { readonly flags?: readonly FlagLiteral[] }> = {
  [K in NonNullable<S['flags']>[number]]: FlagParsedValue<(typeof FLAG_DEFS)[K]>;
};

/** 引擎产物：flag 映射 + 位置参数 + 全局层。 */
export interface ParsedCommand<S extends { readonly flags?: readonly FlagLiteral[] }> {
  readonly flags: ParsedFlags<S>;
  readonly positionals: readonly string[];
  readonly globals: Globals;
}
// ── i18n 键 path 约定派生（§8.8 main 裁定） ──

/** 'install-service' → 'installService'（类型级）。 */
type CamelCase<S extends string> = S extends `${infer H}-${infer T}`
  ? `${H}${Capitalize<CamelCase<T>>}`
  : S;

/** ['gateway','nodes','list'] → 'gatewayNodesList'（类型级）。 */
type CamelPath<P extends readonly unknown[]> = P extends readonly [
  infer H extends string,
  ...infer T extends readonly unknown[],
]
  ? T extends readonly []
    ? CamelCase<H>
    : `${CamelCase<H>}${Capitalize<CamelPath<T>>}`
  : '';

/** 派生摘要键：help.cmd.<camelPath>。 */
export type DefaultSummaryKey<P extends readonly unknown[]> = `help.cmd.${CamelPath<P>}`;

/** 运行时派生（与类型级 CamelPath 同口径；投射层用）。 */
export function defaultSummaryKey(path: readonly string[]): string {
  const camel = path
    .map((segment, index) => {
      const parts = segment.split('-');
      const head = parts[0] ?? '';
      const tail = parts
        .slice(1)
        .map((p) => (p === '' ? '' : (p[0]?.toUpperCase() ?? '') + p.slice(1)))
        .join('');
      const joined = head + tail;
      return index === 0
        ? joined
        : joined === ''
          ? ''
          : (joined[0]?.toUpperCase() ?? '') + joined.slice(1);
    })
    .join('');
  return `help.cmd.${camel}`;
}

/**
 * 摘要键约束：派生键 ∈ MessageKey 时 summary 可省（投射层派生）；
 * 否则强制显式 MessageKey（既有键不合约定者，如 gateway install-service →
 * help.cmd.gatewayInstall）。编译期守卫不降（D3）。
 */
export type SummaryField<P extends readonly unknown[]> =
  DefaultSummaryKey<P> extends MessageKey
    ? { readonly summary?: MessageKey }
    : { readonly summary: MessageKey };

// ── CommandSpec ──

/** 命令声明数据面（设计 §2.2 sketch；实施微调见 PLAN §3.4 / S1 决策报告）。 */
export interface CommandSpecBase {
  /** N 级路径：['gateway','nodes','add']，无两级上限（const 泛型推断字面量元组） */
  readonly path: readonly string[];
  /** 位置参数形态：'<name>' / '[<hub-url>]' / '<member> <content...>' */
  readonly positional?: string;
  /** help 展示占位覆盖（completion 先例：引擎可选 '[<shell>]'，展示 '<bash|zsh|...>'） */
  readonly helpArgs?: string;
  /** 本命令 flag 字面量（引用 FLAG_DEFS；不含 -h/--help，渲染统一追加） */
  readonly flags?: readonly FlagLiteral[];
  /** 本命令必填 flag（现 CliHelpCommand.required；usage 行不加方括号 + 引擎校验） */
  readonly required?: readonly FlagLiteral[];
  /** 必填缺失错误文案（migrate 先例；缺省 Missing required flag: X） */
  readonly requiredError?: (flag: string) => string;
  /** 命令级覆盖（现 flagValue/flagHelp + 每命令解析差异：--limit/--ttl 错误文案先例） */
  readonly flagOverrides?: Readonly<
    Partial<
      Record<
        FlagLiteral,
        {
          readonly value?: FlagValueKind;
          readonly help?: MessageKey;
          readonly missingError?: string;
          readonly invalidError?: (raw: string) => string;
          /** 本命令内隐藏（接受但不上 help/补全；config path --force 先例） */
          readonly hidden?: boolean;
        }
      >
    >
  >;
  /** 互斥形态无法由 flag 列表表达时手写整行 usage（attention respond 先例） */
  readonly usage?: string;
  /** 互斥组（如 --allow|--deny|--answers） */
  readonly exclusive?: readonly (readonly FlagLiteral[])[];
  /** 互斥错误文案（现态 parser 口径 parity；缺省 `<a> and <b> cannot be combined`） */
  readonly exclusiveError?: string;
  /** 位置参数错误文案 parity：missing 整句；extra 自定义整句（缺省 Unknown argument: X） */
  readonly positionalErrors?: {
    readonly missing?: string;
    readonly extra?: (token: string) => string;
  };
  /** 路由面：one-shot 进注册表 / foreground 进前台管线 / entry 在入口处理 */
  readonly surface: 'one-shot' | 'foreground' | 'entry';
  /** 命令页脚注投射（§8.5；缺省不声明 = 无脚注） */
  readonly exitCodes?: readonly { readonly code: number; readonly summary: MessageKey }[];
  /** 不进总览/补全（内部命令面） */
  readonly hidden?: boolean;
}

/** 完整 CommandSpec（含懒实现引用；投射消费的基础形状）。 */
export interface CommandSpec extends CommandSpecBase {
  readonly summary: MessageKey;
  /** 纯分组（自身非命令）摘要（现 CLI_HELP_GROUPS）；兼作命令的分组用自身 summary */
  readonly groupSummary?: MessageKey;
  /** 跨字段约束（selector 互斥 / --self 规则）；返回错误文案或 null */
  readonly validate?: (
    parsed: ParsedCommand<CommandSpecBase>,
  ) => string | null | Promise<string | null>;
  /** 懒实现引用：动态 import + flags→域选项映射（机械转录自现 registry 包装器） */
  readonly load: () => Promise<{
    run: (
      parsed: ParsedCommand<CommandSpecBase>,
      ctx: CommandContext,
    ) => Promise<number | undefined>;
  }>;
}

/**
 * 定义一条命令（const 泛型保留 flag/path 字面量 → ParsedFlags 映射互锁）。
 * summary 缺省时由 path 派生（§8.8）；派生键不在 catalog 时类型强制显式。
 * validate 接收完整 ParsedCommand（flags + positionals + globals；实施微调：
 * 跨字段约束需读全局层，如 stop 的 connect×selector，候 lead 知悉）。
 */
export function defineCommand<const P extends readonly unknown[], const S extends CommandSpecBase>(
  spec: S & { readonly path: P } & SummaryField<P> & {
      readonly groupSummary?: MessageKey;
      readonly validate?: (parsed: ParsedCommand<S>) => string | null | Promise<string | null>;
      readonly load: () => Promise<{
        run: (parsed: ParsedCommand<S>, ctx: CommandContext) => Promise<number | undefined>;
      }>;
    },
): CommandSpec {
  const summary = (spec as { summary?: MessageKey }).summary;
  return {
    ...spec,
    summary: summary ?? (defaultSummaryKey(spec.path) as MessageKey),
  } as CommandSpec;
}

/**
 * 纯分组（自身非命令）摘要（现 CLI_HELP_GROUPS 中无独立命令的分组，如
 * 'gateway nodes' / 'federation peer' / 'hub node'）。分组**存在性**由命令
 * path 前缀派生（buildHelpTree），此表只声明摘要文案——仍在 schema 模块单一源。
 * 兼作命令的分组（team budget / attention）用自身 summary，不在此表。
 * S2-S4 转录现态 CLI_HELP_GROUPS 时核对哪些是纯分组。
 */
export const PURE_GROUP_SUMMARIES: Readonly<Record<string, MessageKey>> = {
  agent: 'help.group.agent',
  config: 'help.group.config',
  dev: 'help.group.dev',
  federation: 'help.group.federation',
  'federation peer': 'help.group.federationPeer',
  fleet: 'help.group.fleet',
  gateway: 'help.group.gateway',
  'gateway nodes': 'help.group.gatewayNodes',
  hub: 'help.group.hub',
  'hub node': 'help.group.hubNode',
  logs: 'help.group.logs',
  model: 'help.group.model',
  node: 'help.group.node',
  permission: 'help.group.permission',
  plugin: 'help.group.plugin',
  rpc: 'help.group.rpc',
  kanban: 'help.group.kanban',
  session: 'help.group.session',
  team: 'help.group.team',
  trace: 'help.group.trace',
};

/** 纯分组未知子命令错误文案（现态 parser 口径 parity；缺省 Unknown argument: X）。 */
export const PURE_GROUP_ERRORS: Readonly<Record<string, (token: string) => string>> = {
  fleet: (token) => `Unknown fleet subcommand: ${token}`,
  session: (token) => `Unknown subcommand for session: ${token}`,
  permission: (token) => `Unknown subcommand for permission: ${token}`,
};

/**
 * 内置命令 schema（唯一声明处）。顺序 = 现 registry 命中即停顺序 + help 分组页
 * 排列同源（help-spec.ts:295 注释）。S1 为空壳；S2-S4 分批改录现态四份声明。
 * 插件命令不进内置 schema（另走 plugin-cli 预解析，CONTRACT-0.48 §4）。
 */
export const COMMAND_SCHEMA: readonly CommandSpec[] = [
  // ── 批 A1：入口 / 元命令 / 只读清点（S2；flag 面以 args 解析为准） ──
  defineCommand({
    path: ['demo'],
    surface: 'entry',
    positionalErrors: { extra: (token) => `Unknown argument for demo: ${token}` },
    // entry surface：cli.ts 入口处理（bootstrap/REPL），load 不被分派消费。
    load: async () => ({ run: async () => 0 }),
  }),
  defineCommand({
    path: ['completion'],
    surface: 'one-shot',
    positional: '[<shell>]',
    helpArgs: '<bash|zsh|fish|powershell>',
    positionalErrors: { extra: (token) => `Unexpected argument for completion: ${token}` },
    load: async () => {
      const { runCompletionCommand } = await import('./commands/completion-command');
      const { isCompletionShell } = await import('./completion-spec');
      return {
        run: async (parsed) => {
          const requested = parsed.positionals[0] ?? null;
          return runCompletionCommand({
            shell: requested !== null && isCompletionShell(requested) ? requested : null,
            requested,
          });
        },
      };
    },
  }),
  defineCommand({
    path: ['update'],
    surface: 'one-shot',
    flags: ['--check', '--channel', '--json', '--force', '--yes'],
    exclusive: [['--check', '--yes']],
    exclusiveError: 'Cannot combine --check and --yes',
    load: async () => {
      const { runUpdateCommand } = await import('./commands/cli-update');
      return {
        run: async (parsed) => {
          const f = parsed.flags;
          return runUpdateCommand({
            check: f['--check'],
            json: f['--json'],
            force: f['--force'],
            yes: f['--yes'],
            ...(f['--channel'] !== undefined ? { channel: f['--channel'] } : {}),
          });
        },
      };
    },
  }),
  defineCommand({
    path: ['doctor'],
    surface: 'one-shot',
    // D-12：args 接受 --data-dir（help-spec 漏声明，args 为准补齐）
    flags: ['--json', '--deep', '--data-dir'],
    positionalErrors: { extra: (token) => `Unknown argument for doctor: ${token}` },
    load: async () => {
      const { doctorCommand } = await import('./commands/doctor-command');
      const { printCommandResult } = await import('./command-support');
      return {
        run: async (parsed) => {
          const f = parsed.flags;
          return printCommandResult(
            await doctorCommand({ json: f['--json'], ...(f['--deep'] ? { deep: true } : {}) }),
          );
        },
      };
    },
  }),
  defineCommand({
    path: ['status'],
    surface: 'one-shot',
    // D-11：args 只接受 --json（help-spec 超声明 --connect 系，args 为准移除）
    flags: ['--json'],
    positionalErrors: { extra: (token) => `Unknown argument for status: ${token}` },
    load: async () => {
      const { statusCommand } = await import('./commands/fleet/status-command');
      const { printCommandResult } = await import('./command-support');
      return {
        run: async (parsed) =>
          printCommandResult(
            await statusCommand({
              json: parsed.flags['--json'],
              connectUrl: parsed.globals.connectArg,
              connectToken: parsed.globals.connectTokenArg,
              caFile: parsed.globals.caArg,
            }),
          ),
      };
    },
  }),
  defineCommand({
    path: ['agents'],
    surface: 'one-shot',
    // D-11：args 只接受 --json
    flags: ['--json'],
    positionalErrors: { extra: (token) => `Unknown argument for agents: ${token}` },
    load: async () => {
      const { agentsCommand } = await import('./commands/agent/agents-command');
      const { printCommandResult } = await import('./command-support');
      return {
        run: async (parsed) =>
          printCommandResult(
            await agentsCommand({
              json: parsed.flags['--json'],
              connectUrl: parsed.globals.connectArg,
              connectToken: parsed.globals.connectTokenArg,
              caFile: parsed.globals.caArg,
            }),
          ),
      };
    },
  }),
  defineCommand({
    path: ['errors'],
    surface: 'one-shot',
    // D-11：args 只接受 --json/--limit；--limit 1..200 双文案（非数字 vs 超范围）
    flags: ['--json', '--limit'],
    flagOverrides: {
      '--limit': {
        value: {
          kind: 'number',
          placeholder: '<n>',
          parse: (raw) => {
            if (!/^\d+$/.test(raw)) return null;
            const v = Number.parseInt(raw, 10);
            return v >= 1 && v <= 200 ? v : null;
          },
        },
        invalidError: (raw) =>
          /^\d+$/.test(raw) ? `Invalid --limit: ${raw} (1-200)` : `Invalid --limit: ${raw}`,
      },
    },
    positionalErrors: { extra: (token) => `Unknown argument for errors: ${token}` },
    load: async () => {
      const { errorsCommand } = await import('./commands/errors-command');
      const { printCommandResult } = await import('./command-support');
      return {
        run: async (parsed) => {
          const f = parsed.flags;
          return printCommandResult(
            await errorsCommand({
              json: f['--json'],
              ...(f['--limit'] !== undefined ? { limit: f['--limit'] } : {}),
              connectUrl: parsed.globals.connectArg,
              connectToken: parsed.globals.connectTokenArg,
              caFile: parsed.globals.caArg,
            }),
          );
        },
      };
    },
  }),
  defineCommand({
    path: ['session', 'status'],
    surface: 'one-shot',
    flags: ['--id', '--json', '--data-dir', '--connect', '--connect-token', '--ca', '--node'],
    positionalErrors: { extra: (token) => `Unknown argument for session status: ${token}` },
    validate: (p) => {
      const g = p.globals;
      const connectOnly =
        g.connectTokenArg !== null ? '--connect-token' : g.caArg !== null ? '--ca' : null;
      if (connectOnly !== null && g.connectArg === null && g.nodeTargetArg === null) {
        return `${connectOnly} requires --connect or --node`;
      }
      return null;
    },
    load: async () => {
      const { sessionStatusCommand } = await import('./commands/session/session-status-command');
      const { printCommandResult } = await import('./command-support');
      return {
        run: async (parsed) => {
          const f = parsed.flags;
          return printCommandResult(
            await sessionStatusCommand({
              json: f['--json'],
              ...(f['--id'] !== undefined ? { id: f['--id'] } : {}),
              connectUrl: parsed.globals.connectArg,
              connectToken: parsed.globals.connectTokenArg,
              caFile: parsed.globals.caArg,
            }),
          );
        },
      };
    },
  }),
  defineCommand({
    path: ['permission', 'show'],
    surface: 'one-shot',
    flags: ['--member', '--json', '--data-dir', '--connect', '--connect-token', '--ca', '--node'],
    positionalErrors: { extra: (token) => `Unknown argument for permission show: ${token}` },
    validate: (p) => {
      const g = p.globals;
      const connectOnly =
        g.connectTokenArg !== null ? '--connect-token' : g.caArg !== null ? '--ca' : null;
      if (connectOnly !== null && g.connectArg === null && g.nodeTargetArg === null) {
        return `${connectOnly} requires --connect or --node`;
      }
      return null;
    },
    load: async () => {
      const { permissionShowCommand } = await import(
        './commands/permission/permission-show-command'
      );
      const { printCommandResult } = await import('./command-support');
      return {
        run: async (parsed) => {
          const f = parsed.flags;
          return printCommandResult(
            await permissionShowCommand({
              json: f['--json'],
              ...(f['--member'] !== undefined ? { member: f['--member'] } : {}),
              connectUrl: parsed.globals.connectArg,
              connectToken: parsed.globals.connectTokenArg,
              caFile: parsed.globals.caArg,
            }),
          );
        },
      };
    },
  }),
  defineCommand({
    path: ['prune'],
    surface: 'one-shot',
    flags: ['--older-than', '--dry-run', '--json', '--yes', '--data-dir'],
    positionalErrors: { extra: (token) => `Unknown argument for prune: ${token}` },
    load: async () => {
      const { pruneCommand } = await import('./commands/prune-command');
      const { printCommandResult } = await import('./command-support');
      return {
        run: async (parsed) => {
          const f = parsed.flags;
          return printCommandResult(
            await pruneCommand({
              yes: f['--yes'],
              dryRun: f['--dry-run'],
              json: f['--json'],
              ...(f['--older-than'] !== undefined ? { olderThanMs: f['--older-than'] } : {}),
            }),
          );
        },
      };
    },
  }),
  defineCommand({
    path: ['trace'],
    surface: 'one-shot',
    hidden: true, // parse-only：help 树 trace 仍为纯分组（现态无裸 trace 命令页）
    summary: 'help.group.trace',
    // 裸 trace：用法错误 exit 2（异于 fleet/session/permission 的 help 兜底）
    positional: '<sub>',
    positionalErrors: {
      missing: 'Missing trace subcommand (prune)',
      extra: (token) => `Unknown trace subcommand: ${token}`,
    },
    validate: (p) =>
      p.positionals[0] !== undefined ? `Unknown trace subcommand: ${p.positionals[0]}` : null,
    load: async () => ({ run: async () => 2 }),
  }),
  defineCommand({
    path: ['trace', 'prune'],
    surface: 'one-shot',
    flags: ['--dry-run', '--json'],
    positionalErrors: { extra: (token) => `Unknown argument for trace prune: ${token}` },
    load: async () => {
      const { tracePruneCommand } = await import('./commands/trace-command');
      const { printCommandResult } = await import('./command-support');
      return {
        run: async (parsed) =>
          printCommandResult(
            await tracePruneCommand({
              dryRun: parsed.flags['--dry-run'],
              json: parsed.flags['--json'],
            }),
          ),
      };
    },
  }),
  defineCommand({
    path: ['dev'],
    surface: 'one-shot',
    hidden: true, // parse-only：help 树 dev 仍为纯分组（现态无裸 dev 命令页）
    summary: 'help.group.dev',
    // 裸 dev：dev 专用帮助 + exit 2（runDevCommand kind help；非全局总览）
    positionalErrors: { extra: (token) => `Unknown dev subcommand: ${token}` },
    load: async () => {
      const { runDevCommand } = await import('./commands/dev-command');
      const { printCommandResult } = await import('./command-support');
      return {
        run: async () =>
          printCommandResult(await runDevCommand({ kind: 'help', missingSubcommand: true })),
      };
    },
  }),
  defineCommand({
    path: ['dev', 'reset'],
    surface: 'one-shot',
    flags: ['--yes', '--dry-run', '--json', '--data-dir'],
    positionalErrors: { extra: (token) => `Unknown argument for dev reset: ${token}` },
    load: async () => {
      const { runDevCommand } = await import('./commands/dev-command');
      const { printCommandResult } = await import('./command-support');
      return {
        run: async (parsed) => {
          const f = parsed.flags;
          return printCommandResult(
            await runDevCommand({
              kind: 'reset',
              yes: f['--yes'],
              dryRun: f['--dry-run'],
              json: f['--json'],
            }),
          );
        },
      };
    },
  }),
  defineCommand({
    path: ['fleet', 'status'],
    surface: 'one-shot',
    flags: ['--json', '--data-dir'],
    positionalErrors: { extra: (token) => `Unknown argument for fleet status: ${token}` },
    load: async () => {
      const { fleetStatusCommand } = await import('./commands/fleet/fleet-status-command');
      const { printCommandResult } = await import('./command-support');
      return {
        run: async (parsed) =>
          printCommandResult(await fleetStatusCommand({ json: parsed.flags['--json'] })),
      };
    },
  }),
  defineCommand({
    path: ['ps'],
    surface: 'one-shot',
    flags: ['--json', '--all', '--data-dir'],
    flagOverrides: { '--all': { help: 'flag.all.ps' } },
    positionalErrors: { extra: (token) => `Unknown argument for ps: ${token}` },
    load: async () => {
      const { psCommand } = await import('./commands/fleet/ps-command');
      const { printCommandResult } = await import('./command-support');
      return {
        run: async (parsed) => {
          const f = parsed.flags;
          return printCommandResult(await psCommand({ json: f['--json'], all: f['--all'] }));
        },
      };
    },
  }),
  // ── 批 A2：config / migrate / eval（S2） ──
  defineCommand({
    path: ['config'],
    surface: 'one-shot',
    hidden: true, // parse-only：help 树 config 仍为纯分组
    summary: 'help.group.config',
    positional: '<sub>',
    positionalErrors: {
      missing: 'Missing config subcommand (path|init|show|set|explain)',
      extra: (token) => `Unknown config subcommand: ${token}`,
    },
    validate: (p) =>
      p.positionals[0] !== undefined ? `Unknown config subcommand: ${p.positionals[0]}` : null,
    load: async () => ({ run: async () => 2 }),
  }),
  defineCommand({
    path: ['config', 'path'],
    surface: 'one-shot',
    flags: ['--json', '--force', '--sources'],
    flagOverrides: { '--force': { hidden: true }, '--sources': { hidden: true } },
    positionalErrors: { extra: (token) => `Unknown argument for config path: ${token}` },
    validate: (p) =>
      p.flags['--force'] === true || p.flags['--sources'] === true
        ? 'config path only supports --json'
        : null,
    load: async () => {
      const { configPathCommand } = await import('./commands/config-command');
      const { printCommandResult } = await import('./command-support');
      return {
        run: async (parsed) =>
          printCommandResult(await configPathCommand({ json: parsed.flags['--json'] })),
      };
    },
  }),
  defineCommand({
    path: ['config', 'init'],
    surface: 'one-shot',
    flags: ['--json', '--force', '--sources'],
    flagOverrides: { '--sources': { hidden: true } },
    positionalErrors: { extra: (token) => `Unknown argument for config init: ${token}` },
    validate: (p) =>
      p.flags['--sources'] === true ? 'config init only supports --force and --json' : null,
    load: async () => {
      const { configInitCommand } = await import('./commands/config-command');
      const { printCommandResult } = await import('./command-support');
      return {
        run: async (parsed) =>
          printCommandResult(
            await configInitCommand({
              json: parsed.flags['--json'],
              force: parsed.flags['--force'],
            }),
          ),
      };
    },
  }),
  defineCommand({
    path: ['config', 'show'],
    surface: 'one-shot',
    flags: ['--json', '--sources', '--force'],
    flagOverrides: { '--force': { hidden: true } },
    positionalErrors: { extra: (token) => `Unknown argument for config show: ${token}` },
    validate: (p) => (p.flags['--force'] === true ? 'config show does not support --force' : null),
    load: async () => {
      const { configShowCommand } = await import('./commands/config-command');
      const { printCommandResult } = await import('./command-support');
      return {
        run: async (parsed) =>
          printCommandResult(
            await configShowCommand({
              json: parsed.flags['--json'],
              sources: parsed.flags['--sources'],
            }),
          ),
      };
    },
  }),
  defineCommand({
    path: ['config', 'set'],
    surface: 'one-shot',
    flags: ['--json'],
    positional: '<key> <value>',
    positionalErrors: {
      missing:
        'Usage: vessel config set <key> <value> [--json] (supported keys: ui.*, observability.*, agent.*, emptyResponse.*, autoPrune.*, kanban.boardPath, vision.imageTokenBudgetRatio, envInjection.*)',
      extra: () =>
        'Usage: vessel config set <key> <value> [--json] (supported keys: ui.*, observability.*, agent.*, emptyResponse.*, autoPrune.*, kanban.boardPath, vision.imageTokenBudgetRatio, envInjection.*)',
    },
    // 白名单 + 逐键值校验（现 parseConfigArgs 1418-1451 逐字转录；懒 import 保重闭包不进 help 早退）
    validate: async (p) => {
      const key = p.positionals[0] ?? '';
      const value = p.positionals[1] ?? '';
      const { isSettableConfigKey } = await import('../config/ui-settings');
      if (!isSettableConfigKey(key)) {
        return `Unsupported config key: ${key} (supported keys: see 'vessel config set --help')`;
      }
      if (key === 'ui.language' && value !== 'zh-CN' && value !== 'en') {
        return 'ui.language must be "zh-CN" or "en"';
      }
      if (key === 'ui.showReasoning' && value !== 'true' && value !== 'false') {
        return 'ui.showReasoning must be "true" or "false"';
      }
      if (key === 'ui.statusBars' && !['top', 'bottom', 'both', 'none'].includes(value)) {
        return 'ui.statusBars must be "top", "bottom", "both" or "none"';
      }
      if (key === 'ui.verbosity' && !['minimal', 'normal', 'debug'].includes(value)) {
        return 'ui.verbosity must be "minimal", "normal" or "debug"';
      }
      if (
        (key === 'ui.showInternalEvents' ||
          key === 'ui.askUser' ||
          key === 'ui.expandCards' ||
          key === 'observability.showProcessErrors') &&
        value !== 'true' &&
        value !== 'false'
      ) {
        return `${key} must be "true" or "false"`;
      }
      if (key === 'ui.errorLevel' && value !== 'user' && value !== 'all') {
        return 'ui.errorLevel must be "user" or "all"';
      }
      if (key === 'agent.cwd' && value.trim() === '') {
        return 'agent.cwd must be a non-empty path';
      }
      return null;
    },
    load: async () => {
      const { configSetCommand } = await import('./commands/config-command');
      const { printCommandResult } = await import('./command-support');
      return {
        run: async (parsed) =>
          printCommandResult(
            await configSetCommand(parsed.positionals[0] ?? '', parsed.positionals[1] ?? '', {
              json: parsed.flags['--json'],
            }),
          ),
      };
    },
  }),
  defineCommand({
    path: ['config', 'explain'],
    surface: 'one-shot',
    flags: ['--json'],
    positional: '<key>',
    positionalErrors: {
      missing: 'Usage: vessel config explain <key> [--json] (e.g. data_dir / provider.model)',
      extra: () => 'Usage: vessel config explain <key> [--json] (e.g. data_dir / provider.model)',
    },
    load: async () => {
      const { configExplainCommand } = await import('./commands/config-command');
      const { printCommandResult } = await import('./command-support');
      return {
        run: async (parsed) =>
          printCommandResult(
            await configExplainCommand(parsed.positionals[0] ?? '', {
              json: parsed.flags['--json'],
            }),
          ),
      };
    },
  }),
  defineCommand({
    path: ['migrate'],
    surface: 'one-shot',
    flags: ['--from', '--to', '--apply', '--json', '--source'],
    required: ['--from', '--to'],
    requiredError: (flag) =>
      flag === '--from'
        ? 'migrate requires --from sqlite|file-v1'
        : 'migrate requires --to file-v2',
    flagOverrides: {
      '--from': {
        help: 'flag.from.migrate',
        value: {
          kind: 'dynamic',
          placeholder: '<sqlite|file-v1>',
          parse: (raw) =>
            raw === 'sqlite' || raw === 'file-v1'
              ? { ok: true, value: raw }
              : { ok: false, error: `Invalid --from: ${raw} (expected "sqlite" or "file-v1")` },
        },
      },
      '--to': {
        help: 'flag.to.migrate',
        value: {
          kind: 'dynamic',
          placeholder: '<file-v2>',
          parse: (raw) =>
            raw === 'file-v2'
              ? { ok: true, value: raw }
              : { ok: false, error: `Invalid --to: ${raw} (expected "file-v2")` },
        },
      },
    },
    positionalErrors: { extra: (token) => `Unknown argument for migrate: ${token}` },
    load: async () => {
      const { migrateCommand } = await import('./commands/migrate-command');
      const { printCommandResult } = await import('./command-support');
      return {
        run: async (parsed) => {
          const f = parsed.flags;
          return printCommandResult(
            await migrateCommand({
              from: f['--from'] ?? '',
              to: f['--to'] ?? '',
              apply: f['--apply'],
              json: f['--json'],
              ...(f['--source'] !== undefined ? { source: f['--source'] } : {}),
            }),
          );
        },
      };
    },
  }),
  defineCommand({
    path: ['eval'],
    surface: 'one-shot',
    flags: ['--json', '--out', '--filter', '--allow-network'],
    positional: '<suite>',
    positionalErrors: {
      missing: 'Missing eval suite (name or path)',
      extra: (token) => `Unexpected argument: ${token}`,
    },
    load: async () => {
      const { runEvalCommand } = await import('./commands/eval-command');
      return {
        run: async (parsed, ctx) => {
          const f = parsed.flags;
          return runEvalCommand(
            {
              target: parsed.positionals[0] ?? '',
              json: f['--json'],
              ...(f['--out'] !== undefined ? { out: f['--out'] } : {}),
              filters: f['--filter'] ?? [],
              allowNetwork: f['--allow-network'],
            },
            { useMock: ctx.useMock },
          );
        },
      };
    },
  }),
];
