/**
 * @vessel-agent/basic-tools - 基础工具插件（bash / read / edit / write）
 * @module @vessel-agent/basic-tools
 *
 * 本项目唯一的工具包，只提供四个互不可替代的工具：
 * - `bash`：执行任意 shell 命令（grep / cat / ls / mkdir / curl …… 全部由它承担），权限 ask
 * - `read`：带行号读文件（支持 offset/limit），权限 allow
 * - `edit`：精确且唯一匹配的字符串替换，权限 ask
 * - `write`：整文件创建 / 整体替换 / 追加（内容逐字节落盘，不经 shell），权限 ask
 *
 * 为什么 `write` 必须存在（0.56 真机事故）：`edit` 只能替换**已有文件里的精确文本**，
 * 于是「建文件」和「追加」只剩 bash heredoc / 重定向 —— 而那条路**不校验内容**，
 * 沙箱还会先把反引号 / `$(` / `${…}` 展开掉，模型连续三次把内容写变形且毫无反馈
 * （写架构文档时整段代码块直接消失）。`write` 把内容当**数据**收，不经 shell，
 * 于是「用 bash 写文件」这条路不再是必需项。
 *
 * 危险操作（bash / edit / write）经 `checkPermission` 返回 `ask`，由 core `PermissionPolicy`
 * 统一发出一次权限请求并等待用户授权（ADR-029 / ADR-079）。
 * `read` / `edit` / `write` / `bash` 额外受路径边界约束（0.8 E1）：内置敏感路径 denylist 直接拒绝；
 * 可选 `allowed_roots` 把越界访问降级为 ask。`..` 与符号链接按真实路径判定。
 * `bash` 另在命令文本里匹配内置 denylist 与配置 `deny_paths`（0.14.2 F2 / 0.15）：命中即拒绝。
 * 这不是沙箱——只做字符串/规范化路径匹配，变量拼接、`cd`、符号链接等仍可能绕过。
 * 可选 `cwd`（0.11.1）提供默认工作目录：`bash` 未显式传 `cwd` 时使用它，
 * `read` / `edit` / `write` 的相对路径按它解析；边界仍按解析后的绝对路径判定。
 *
 * 输出预算（0.55 / 0.56 闸上移）：任一工具的结果回给模型之前都过**同一个** token 闸
 * （core 的 `boundToolResult`：单条 ≤ 16k token，超了先落盘全文再按头 30% / 尾 70% + 一行
 * 省略标注裁切）。闸本体在 `packages/core/src/runtime/tool-result-gate.ts`，由 loop 一处
 * 收口 —— 所以 web_fetch / MCP / 未来插件的返回值也在闸内。本模块保留**第二道闸**：
 * bash / read / edit / write 自己先裁一遍并登记幂等回执（`markToolResultBounded`），loop 见到
 * `bounded` 就不再裁（再裁一次会把「完整输出：<路径>」那一行裁掉）。
 * 2000 行 / 2 MiB 两道旧闸保留作兜底，顺序是 token → 行 / 字节。
 * 事故校准：1,344 行 / 423 KB（≈106k token）的输出两道旧闸都没碰到，所以闸必须按 token 计。
 *
 * 异步（0.55）：`bash` 多一个 `async?: boolean`。缺省（不传）= 同步，行为与 0.54 逐字节相同；
 * `true` = 发起就返回，命令结束时把「退出码 + 头尾输出 + 落盘路径」以一条 `vessel:notice`
 * 尾消息注入该会话的下一次模型请求（复用 runtime notice 那条既有通道，不新造 RPC）。
 * 为什么不单开一个 `bash_async` 工具名：bash 的权限判定（deny 命令文本 / cwd 边界 / ask）、
 * 输出闸、落盘目录都必须与同步路径**同一份实现**，同名同参最不容易漂成两套。
 *
 * 写文件警告（只警告、不阻断）：`bash` 结果文本**末尾**追加一行提示（一次调用最多一行），
 * 覆盖 `sed -i` / `tee <file>` / 重定向到文件 / heredoc 带元字符 / 反引号。理由是这些写法
 * bash **不校验内容**：写坏了不报错、退出码照样 0，模型没有任何反馈可以自纠（实测 74 个会话
 * 1,700+ 次写文件，并且已经出过一次 heredoc 反引号被沙箱预处理掉的事故）。判定是纯文本
 * 正则 / 字符扫描，不改权限、不改退出码与 stdout/stderr；`edit` / `read` / `write` 的输出一个字节都不动。
 * 文案 0.56 订正：以前只说「建议改用 edit」，而 **edit 干不了建文件 / 追加** —— 那条建议本身
 * 就把模型推回 heredoc（今天连续三次写变形的直接原因）。现在按用途分流：
 * **建文件 / 追加用 `write`，局部改代码用 `edit`**。
 *
 * 写协调（蜂群 Phase 1，个人侧研究草案 swarm-shared-workspace-collaboration §3.4/§3.5/§3.6）：
 * - `write` mode=overwrite 可选 `expected_content`：写临界区内与当前内容逐字节比对，不符报错不写
 *   （逼重读，防陈旧 read 后静默抹除）；不传 = 旧行为零回归。「好设计省重试」。
 * - edit/write 写临界区前持 `<baseCwd>/.vessel/write.lock` 全工作区单锁（./write-lock.ts，
 *   data-lock 已验证原语），跨进程串行化**写动作**（毫秒级，非任务级 lease）；合作式协议，
 *   bash/IDE/git 非合作写入者不受约束（诚实边界，Windows 强制锁加固另批）。
 * - edit/write/read 可选 `subscribe:false`：缺省自动订阅（edit/write 所改文件、read 所读行范围；
 *   doc-subscription AfterTool hook，host 侧，覆盖两条执行路），opt-out 省 token；
 *   感知只在 run 边界（append-only）。read 行范围订阅为 line-level（蜂群协作增强）：
 *   追踪所读行，那几行变了推范围 diff，锚歧义回落整文件 rev。
 *
 * 传输层（WSL 启动器修复）：Windows 宿主上 `bash` 若解析到 system32 的 WSL 启动器，`-c` 的
 * 字符串会先被外层 shell 在 spawn cwd 解析一遍 —— 单引号里的反引号 / `$()` 也被提前展开，
 * 还在 cwd（多为仓库根）留下 0 字节垃圾文件。spawnBash 对此改走 base64 传输（编码后超长则
 * 落系统临时目录随机名脚本、进程退出后立即删除），命令文本逐字节到达内层 bash、只解析一次；
 * 已修复路径不再追加反引号 / heredoc 元字符那两条警告。非 Windows 与 Git Bash 的 argv 逐字节不变。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  EnvCadence,
  EnvChannel,
  Hook,
  HookContext,
  Message,
  Plugin,
  PluginHost,
  RunEvent,
  ToolContext,
  ToolDefinition,
} from '@vessel-agent/core';
import {
  attachmentStagingRoot,
  boundToolResult,
  createStderrLogger,
  cutToTokenBudget,
  HookType,
  markToolResultBounded,
  omitMarker,
  runWithToolOutputScope,
  safeSegment,
  toolOutputRoot,
  writeToolOutput,
} from '@vessel-agent/core';
import { acquireWriteLock, type WriteLock, WriteLockError, writeLockPath } from './write-lock.js';

// ── 常量 ──────────────────────────────────────────

/** bash 缺省超时（毫秒）；导出供 host 转发工厂算信封预算（单实现，禁第二份常量） */
export const DEFAULT_BASH_TIMEOUT_MS = 120_000;

/**
 * 单方向输出超过该行数即触发截断（**第二道闸**，token 闸之后的兜底）。
 * 语义自 0.4 起未变；它挡的是「行很多」这一种形状，挡不住「行少但每行超长」
 * ——那种形状由下面的 token 闸负责。
 */
const MAX_OUTPUT_LINES = 2000;

/** 截断后保留的头行数 */
const KEEP_HEAD_LINES = 1000;

/** 截断后保留的尾行数 */
const KEEP_TAIL_LINES = 1000;

/** read 缺省读取行数（导出供 doc-subscription read 订阅规范化同口径，单一真源） */
export const DEFAULT_READ_LIMIT = 2000;

/** 返回给模型的单方向预览字节数（**第三道闸**，超出即标注） */
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

/** 落盘时单方向最多保留的字节数（超出仍丢弃，防止无界输出撑爆内存） */
const MAX_PERSIST_BYTES = 16 * 1024 * 1024;

// ── 01. 预算口径：单条工具结果回给模型的 token 上限（第一道闸；2026-11 用户裁定 ≤ 16k/次）
//
// 0.56 闸上移后数值与实现都在 core（`runtime/tool-result-gate.ts` 的
// `MAX_TOOL_RESULT_TOKENS`）：头 30% / 尾 70%、标注预留 256 token、重切收敛参数
// 一并归那里，本模块**不存第二份数值**（口径漂移会让闸和上下文压缩打架）。
//
// 取值理由（留在原处，读代码的人不必跳文件）：16k token ≈ 64k ASCII 字符，是
// 「一轮完整问答」的量级；再高就会把对话历史、系统提示、self card 挤出去。事故校准：
// 一条 bash 输出 1,344 行 / 423,386 字符（平均每行 315 字符）≈ 106k token，
// **行数闸（2000 行）与字节闸（2 MiB）都没碰到**，于是原文整块进了上下文、
// 直接撑爆 1M 窗口。所以闸必须按 token 计，不能只按行 / 字节计。

/** 取消时返回的固定文本 */
const CANCELLED_TEXT = '错误：操作已取消（cancelled）。';

/**
 * handler 侧 `deny` 的固定文本（纵深防御用；正常路径由 `checkPermission` 先拦）。
 *
 * 口径：说清是**路径策略**拒的、不是文件不存在 —— 否则模型会把「被策略拒」当成
 * 「路径写错了 / 环境坏了」反复重试；且不复述完整路径（调用方的入参里已经带着它，
 * 重复注入只是 token 税）。
 */
const PATH_DENIED_TEXT =
  '错误：该路径被路径策略拒绝（deny 目录 / denylist），不是文件不存在。改用允许范围内的路径，或由用户调整 deny_paths。';

/** read 允许的最大文件字节数（超过直接拒绝，提示用 bash 分块） */
const MAX_READ_BYTES = 8 * 1024 * 1024;

/**
 * write 单次内容上限（字节）：4 MiB。
 *
 * 取 4 MiB 而不是跟 read 的 8 MiB 对齐：写是有副作用的，超出「一个人能用工具手写的文本」
 * 一个数量级就该换别的路（分段写、或确实要用 bash / cp 搬大文件）。这条闸挡的是
 * 「把整个仓库 / 日志灌进一个 content 参数」——那种调用既撑上下文，又必然写错。
 */
const MAX_WRITE_BYTES = 4 * 1024 * 1024;

/**
 * append 回执里「共 N 行」的最大扫描体积：64 MiB。
 *
 * 数总行数要流式读一遍文件。对普通文件无所谓，但「往日志文件追加」是合法用法，
 * 让一次 append 顺带读 2 GB 就成了新的隐性成本。超过这个体积就只报字节数、不报总行数
 * （回执里那一项省略），不阻塞、不猜。
 */
const MAX_LINE_SCAN_BYTES = 64 * 1024 * 1024;

/**
 * 进程已退出后，最多再等管道排空多久（毫秒）。
 * 命令被 kill 时，它派生的孙进程（如 `bash -c 'sleep 10'` 里的 sleep）仍持有管道写端，
 * 管道不会关闭——硬等会永久挂住，超时兜底后带着已读到的输出返回。
 */
const DRAIN_GRACE_MS = 300;

// ── 异步作业的预算（0.55）────────────────────────
//
// 异步作业脱离工具调用活着，所以它的每一处都得有**显式上界**（守则第十一条）：
// 同时几条、跑多久、留几份记录、一条通知最多占多少 token —— 全是常量，不取决于负载。

/**
 * 异步作业的缺省超时（毫秒）：**0 = 不限时**（用户裁定#8：长驻命令不应被杀）。
 *
 * 历史：0.55 缺省 30 分钟 —— 真机上 `gateway start` 这类长驻命令到点被整树杀掉。
 * 异步存在的理由就是「这条命令要跑得久」，给它设缺省死线等于替用户决定命令该活多久。
 * 现在缺省不限时；要死线就显式传 `timeout_ms`（正数），或配 `async_timeout_ms`。
 * 到点杀不杀由 `kill_on_timeout` 决定（缺省 false = 只断连接、进程继续跑）。
 * 同步路径不受影响：仍是 `DEFAULT_BASH_TIMEOUT_MS`（120s）的交互短超时。
 */
const DEFAULT_ASYNC_BASH_TIMEOUT_MS = 0;

/**
 * 同时在跑的后台作业上限（缺省值；可配 `max_async_jobs`，硬顶 `MAX_ASYNC_JOBS_HARD_CAP`）。
 * 内存上界 = N ×（16 MiB stdout + 16 MiB stderr）（两个方向各自受
 * `MAX_PERSIST_BYTES` 封顶）；超了显式拒绝，不排队、不静默顶掉别人。
 * 缺省 16（0.58 用户裁定#8「并发量越高越好」，自 4 提高）：最坏 512 MiB。
 */
const DEFAULT_MAX_ASYNC_JOBS = 16;

/** 并发上限的硬顶：64 × 32 MiB = 2 GiB 内存上界仍是显式常数，不随配置无界放大。 */
const MAX_ASYNC_JOBS_HARD_CAP = 64;

/**
 * 不限时作业的保活心跳间隔。原超时定时器刻意不 unref（作业在跑时撑住进程不退）；
 * 不限时作业没有超时定时器，用一个 ref'd 的空转 interval 承接同一语义，收口时清除。
 */
const ASYNC_KEEPALIVE_INTERVAL_MS = 60_000;

/**
 * 已完成作业的记录保留上限（只留元数据与收口后的通知文本，输出缓冲已释放）。
 * 未注入的记录不会被这条裁掉（`pruneAsyncJobs` 先注入、后清理的语义也靠它），
 * 所以「结果还没送到模型」永远不会因为保留上限而丢；上限只淘汰已送达的旧记录。
 */
const MAX_ASYNC_RECORDS = 16;

/** 一次注入最多带几条完成通知 —— **必须等于生效的并发上限**（`asyncLimits.maxAsyncJobs`）。
 *
 * 这是个不变式，不是巧合：开始作业只发生在模型调工具时，注入只发生在模型请求前，
 * 两次相邻的模型请求之间最多有 `maxAsyncJobs` 条作业可能完成。让「排空速率 ≥ 到达速率」，
 * 未注入的通知集合就永远 ≤ 并发上限（不需要靠淘汰去兜底，也就不会为了腾地方丢结果）。
 * 代价是最坏一条尾消息约 N × 1300 token（缺省 16 ≈ 20.8k）—— 一次性、有上界，
 * 且只有 N 条同时收尾时才会发生。实现见 `takeAsyncNotices`（直接读 limits，不存第二份数值）。
 */

/**
 * 完成通知里**输出预览**的 token 预算：1200。
 * 单条工具结果的总闸是 16k（core 的 `MAX_TOOL_RESULT_TOKENS`），一条后台通知只该占它的
 * 7.5% —— 通知是「顺带告诉你一声」，不是又一次整块输出；剩下的量靠日志路径按需 read。
 */
const MAX_ASYNC_PREVIEW_TOKENS = 1_200;

/**
 * 完成通知的消息名：与 `runtime-notice-hook` / `refs-notice-hook` / doc-subscription 同一个
 * 通道名（`vessel:notice`）。Web 按它认出「这是运行时上下文」，再按正文首行判 scope —
 * 这里刻意不带 `词:` 形式的 scope 前缀（首行是 `[runtime] bash job … finished`），
 * 于是落进兜底的「上下文」卡：不对词表撒谎，也不需要改动别人的 scope 词表。
 *
 * 已知的显示层取舍：头四行套了明细标记（Web 认得出），**输出预览的原文行不套** ——
 * 那些行是命令的逐字输出，套上 `  · ` 只会让 Web 把它们当明细并在第 11 行折叠掉，反而
 * 更不像原样。代价是卡片最多显示前 11 行（其余折成「还有 N 行」），而落盘路径就在卡头下面
 * 第三行，要看全量点那个文件。模型侧不受影响：它读到的是完整的预览。
 */
const ASYNC_NOTICE_MESSAGE_NAME = 'vessel:notice';

/**
 * 明细行标记：两个空格 + `·`。
 * 必须与 `src/runtime-notice-hook.ts` 的 `NOTICE_DETAIL_MARK` / `packages/agent/src/env-info-scope.ts`
 * 的 `ENV_INFO_DETAIL_MARK` 逐字相同：Web 的 `env-notice.ts` 按它认「这一行是明细」，
 * 对不上时整条通知会被读成一整行（明细全挤进卡头并截断）。
 */
const ASYNC_NOTICE_DETAIL_MARK = '  · ';

/** 异步作业的 hook 注册名（幂等注册用：热应用的旁路 host 会重复 install 同一个插件）。 */
export const ASYNC_BASH_NOTICE_HOOK = 'bash-async-notice';

/**
 * 未送达记录的保留时长：1 小时。
 *
 * 为什么需要：作业表的收口只有「自己的超时」和「进程退出」。如果一条作业完成的会话再也
 * 不跑（成员被关、CLI 换个会话），它的通知就永远没人取 —— 没有 TTL 的话，长驻进程里这类
 * 记录会一直攒着。1 小时足够覆盖「人离开一会儿再回来」的正常间隔，超时的那条结果仍在
 * 日志文件里（`log` 路径随记录一起进过工具返回），丢掉内存里的通知副本不算丢事实。
 */
const ASYNC_RECORD_TTL_MS = 60 * 60_000;

// ── 参数与文本工具 ────────────────────────────────

/** 类型守卫：值是否为对象记录 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 从记录安全读取字符串字段（非字符串返回空串） */
function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

/** 从记录安全读取数字字段（非有限数字返回 undefined） */
function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

// ── 路径边界（0.8 E1） ────────────────────────────

/**
 * 内置敏感路径：命中即 deny，不可通过 ask 放行。
 *
 * 2026-11-16 用户裁定：**把 `~/.vessel/config.yaml` 从这里移除**（原话「不怕 agent 会改坏，不要对 agent
 * 做过多限制，他们有自觉」）。它不再是"不可放行"的敏感路径——agent 可以读写自己的配置。
 * 保留 `~/.ssh` / `~/.aws` / `~/.gnupg`：那不是我们自己的配置，是**第三方凭据**，误改影响别人。
 * 若要进一步放开，改这里即可（只此一处，read/edit 路径边界与 bash 命令文本匹配同源）。
 */
const DEFAULT_DENY_PATHS: readonly string[] = ['~/.ssh', '~/.aws', '~/.gnupg'];

/** 插件配置（同时接受 camelCase / snake_case；未知键忽略） */
export interface BasicToolsConfig {
  /** 配置后 read / bash cwd 必须落在任一 root 内；越界走 ask。空 = 不限制根 */
  allowedRoots?: string[];
  /** 追加到内置 denylist 的敏感路径（read/edit 路径边界 + bash 命令文本匹配） */
  denyPaths?: string[];
  /** 默认工作目录（支持 `~`；相对路径按进程 cwd 解析）。bash 未传 cwd、read/edit 相对路径使用 */
  cwd?: string;
  /**
   * 注入粒度（env_injection 框架轴 A）：scope → 检测节奏，由装配层按 `env_injection` 配置
   * 解析后注入（basic-tools 只产 lock / conflict）。缺省 = 内置字面量默认（lock/conflict=request）。
   */
  envGranularity?: Record<string, EnvCadence>;
  /**
   * 投递通道（env_injection 框架轴 C，P2）：scope → channel，由装配层按 `env_injection.channels`
   * 解析后注入（basic-tools 只产 lock / conflict）。缺省 = model+ui（零回归）。
   */
  envChannels?: Record<string, EnvChannel>;
  /**
   * 异步 bash 缺省超时（毫秒）；**0 = 不限时**（缺省）。per-call `timeout_ms` 始终优先。
   * 同步 bash 不受影响（仍 120s 缺省、必须正数）。用户裁定#8：长驻命令不应被缺省死线杀掉。
   */
  asyncTimeoutMs?: number;
  /**
   * 异步作业超时后是否杀进程树。缺省 **false** = 到点只「断连接」（立即收口通知、释放
   * 并发额度），进程继续跑、输出继续追加进日志；true = 0.55 旧行为（整树杀）。
   */
  killOnTimeout?: boolean;
  /** 同时在跑的后台作业上限（整数 1..64；缺省 16）。超限显式拒绝，不排队。 */
  maxAsyncJobs?: number;
}

/** 从记录读取字符串数组字段（camelCase 优先，兼容 snake_case） */
function readStringArray(
  record: Record<string, unknown>,
  camel: string,
  snake: string,
): string[] | undefined {
  const value = record[camel] ?? record[snake];
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

/** 从记录读取非空字符串字段（camelCase 优先，空值回落 snake_case） */
function readStringField(
  record: Record<string, unknown>,
  camel: string,
  snake?: string,
): string | undefined {
  for (const value of snake === undefined ? [record[camel]] : [record[camel], record[snake]]) {
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

/**
 * 读取 envGranularity 字段（scope → cadence；认 'request' / 'run' / 'off'，P2）。
 * 非法值 / 未知键忽略 —— 缺省回落到 producer 的内置字面量节奏（零回归）。
 */
function readEnvGranularity(
  record: Record<string, unknown>,
): Record<string, EnvCadence> | undefined {
  const value = record.envGranularity ?? record.env_granularity;
  if (!isRecord(value)) return undefined;
  const granularity: Record<string, EnvCadence> = {};
  for (const [scope, cadence] of Object.entries(value)) {
    if (cadence === 'request' || cadence === 'run' || cadence === 'off') {
      granularity[scope] = cadence;
    }
  }
  return Object.keys(granularity).length > 0 ? granularity : undefined;
}

/** 读取 envChannels 字段（scope → channel；认 'model+ui' / 'ui-only'，P2 轴 C）。 */
function readEnvChannels(record: Record<string, unknown>): Record<string, EnvChannel> | undefined {
  const value = record.envChannels ?? record.env_channels;
  if (!isRecord(value)) return undefined;
  const channels: Record<string, EnvChannel> = {};
  for (const [scope, channel] of Object.entries(value)) {
    if (channel === 'model+ui' || channel === 'ui-only') channels[scope] = channel;
  }
  return Object.keys(channels).length > 0 ? channels : undefined;
}

/** 把 YAML 里的插件配置解析成已知字段（未知键忽略） */
export function parseBasicToolsConfig(value: unknown): BasicToolsConfig {
  if (!isRecord(value)) return {};
  const allowedRoots = readStringArray(value, 'allowedRoots', 'allowed_roots');
  const denyPaths = readStringArray(value, 'denyPaths', 'deny_paths');
  const cwd = readStringField(value, 'cwd', 'working_dir');
  const envGranularity = readEnvGranularity(value);
  const envChannels = readEnvChannels(value);
  // 异步预算三键（用户裁定#8）：非法值忽略回落缺省（与 envGranularity 同口径，零回归）。
  const asyncTimeoutRaw = value.asyncTimeoutMs ?? value.async_timeout_ms;
  const asyncTimeoutMs =
    typeof asyncTimeoutRaw === 'number' && Number.isFinite(asyncTimeoutRaw) && asyncTimeoutRaw >= 0
      ? asyncTimeoutRaw
      : undefined;
  const killRaw = value.killOnTimeout ?? value.kill_on_timeout;
  const killOnTimeout = typeof killRaw === 'boolean' ? killRaw : undefined;
  const maxJobsRaw = value.maxAsyncJobs ?? value.max_async_jobs;
  const maxAsyncJobs =
    typeof maxJobsRaw === 'number' &&
    Number.isInteger(maxJobsRaw) &&
    maxJobsRaw >= 1 &&
    maxJobsRaw <= MAX_ASYNC_JOBS_HARD_CAP
      ? maxJobsRaw
      : undefined;
  return {
    ...(allowedRoots !== undefined ? { allowedRoots } : {}),
    ...(denyPaths !== undefined ? { denyPaths } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(envGranularity !== undefined ? { envGranularity } : {}),
    ...(envChannels !== undefined ? { envChannels } : {}),
    ...(asyncTimeoutMs !== undefined ? { asyncTimeoutMs } : {}),
    ...(killOnTimeout !== undefined ? { killOnTimeout } : {}),
    ...(maxAsyncJobs !== undefined ? { maxAsyncJobs } : {}),
  };
}

/** 只展开开头的 `~`，不解析相对路径 */
function expandHomePrefix(entry: string): string {
  if (entry === '~') return os.homedir();
  if (entry.startsWith('~/') || entry.startsWith('~\\')) {
    return path.join(os.homedir(), entry.slice(2));
  }
  return entry;
}

/** 展开开头的 `~`；其余按 cwd 解析为绝对路径 */
function expandHome(entry: string): string {
  return path.resolve(expandHomePrefix(entry));
}

/** 解析后的默认工作目录；`issue` 只在配置了 cwd 且不可用时存在 */
export interface BaseCwd {
  path: string;
  issue?: string;
}

/** 目录存在且是目录（不跟随到文件） */
function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 固定 baseCwd：未配置时用进程 cwd（旧行为）；配置后即使目录暂不存在也记录解析结果，
 * 真正用到时由工具返回明确错误（不静默回退到进程 cwd）。
 *
 * 0.51 起它只管**配置**（`agent.cwd`）这一层；成员 cwd 那一层见 `resolveCallCwd`。
 */
function resolveBaseCwd(config: BasicToolsConfig): BaseCwd {
  if (config.cwd === undefined) return { path: process.cwd() };
  const resolved = path.resolve(expandHome(config.cwd));
  if (isDirectory(resolved)) return { path: resolved };
  return {
    path: resolved,
    issue: `错误：配置的默认工作目录不存在或不是目录：${resolved}`,
  };
}

/**
 * 调用期解析默认工作目录（0.51 Bug 1 的 A 方案）。
 *
 * 优先级：**工具参数 cwd** > `agent.cwd`（本插件的配置 cwd）> **成员 cwd**（`ctx.cwd`）
 * > `process.cwd()`。参数 cwd 不在这里比（它在 `runBash` 里先判），本函数只决定「没写
 * 参数时用哪个」。
 *
 * 为什么必须等到调用期才算：工具对象由 `installPluginsIntoHost` 装**一次**，全 tenant
 * 的成员共用同一批闭包。0.50 及以前 baseCwd 在 install 时就算成常量，于是「成员在哪个
 * 目录」根本无处可传 —— 这正是 Bug 1 的成因（`agent.cwd` 全局一份 ⇒ 所有成员同一个目录）。
 *
 * 为什么成员 cwd 失效时要**降级**而不是硬错：成员 cwd 是**派生值**（Team 基础路径的
 * 快照），用户从没在工具配置里写过它。目录被删 / 换机器 / 快照过期都不该把这具 body 的
 * bash / read / edit 全部打死（`main` 曾因锚点目录不存在而面临同样风险）。降级链的
 * 终点是 `process.cwd()`；真正「降级了」这件事由 `packages/agent` 在 spawn 侧 warn 一次。
 * **显式配置**的 `agent.cwd` 维持原有硬错：那是用户亲手写的值，静默回退只会掩盖配置错误。
 */
export function resolveCallCwd(config: BasicToolsConfig, ctxCwd: string | undefined): BaseCwd {
  if (config.cwd !== undefined) return resolveBaseCwd(config);
  if (ctxCwd !== undefined && ctxCwd.trim() !== '') {
    const resolved = path.resolve(expandHome(ctxCwd));
    if (isDirectory(resolved)) return { path: resolved };
  }
  return { path: process.cwd() };
}

/** 工具路径解析：`~` 展开；相对路径按 baseCwd；绝对路径不变 */
function resolveToolPath(baseCwd: string, entry: string): string {
  return path.resolve(baseCwd, expandHomePrefix(entry));
}

/** 相对路径（且不是 `~`）才会依赖 baseCwd */
function dependsOnBaseCwd(entry: string): boolean {
  if (entry === '~' || entry.startsWith('~/') || entry.startsWith('~\\')) return false;
  return !path.isAbsolute(entry);
}

/**
 * 取真实路径：存在则 realpath；不存在则对最近的已存在祖先做 realpath 再拼回剩余段，
 * 这样符号链接目录下的新路径也不会被词法前缀蒙混过去。
 */
export function canonicalPath(target: string): string {
  const absolute = path.resolve(target);
  try {
    return realpathSync.native(absolute);
  } catch {
    // 路径（或末端）不存在：沿父目录上溯到第一个可解析的位置
  }
  const suffix: string[] = [];
  let current = absolute;
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) return absolute;
    suffix.unshift(path.basename(current));
    current = parent;
    try {
      return path.join(realpathSync.native(current), ...suffix);
    } catch {
      // 继续上溯
    }
  }
}

/** candidate 是否等于 root 或位于 root 之下（按路径段，不按字符串前缀） */
function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/** 解析后的路径边界（配置在工具构造时固定，避免每次调用重复 realpath） */
export interface PathBoundary {
  /** 允许的根；空数组 = 不限制根 */
  allowedRoots: string[];
  denyRoots: string[];
  /** bash 命令文本匹配模式（内置 denylist + 配置 deny_paths） */
  commandPatterns: readonly DeniedCommandPattern[];
}

/**
 * 构造边界：内置 denylist 始终生效，配置项追加/合并。
 * 导出供需要同一套 read/edit 路径边界的插件复用（不要复制第二套实现）。
 */
export function buildPathBoundary(config: BasicToolsConfig): PathBoundary {
  const denyEntries = [...DEFAULT_DENY_PATHS, ...(config.denyPaths ?? [])];
  const allowedRoots = (config.allowedRoots ?? []).map((entry) => canonicalPath(expandHome(entry)));
  // 附件暂存根（file-ref-ux A2/A3）：用户经浏览器上传的临时副本落在 dataDir 下，
  // 配置了 allowed_roots 时它通常在根外 —— 追加进允许根，media / ingest /
  // attachments.list 全部经这一份边界自动放行（deny 仍优先）。空 allowedRoots
  // 语义是「不限制根」，不能追加（追加会把 unrestricted 收成只剩暂存根）。
  if (allowedRoots.length > 0) {
    const staging = canonicalPath(attachmentStagingRoot());
    if (!allowedRoots.some((root) => isWithin(staging, root))) allowedRoots.push(staging);
  }
  return {
    allowedRoots,
    denyRoots: denyEntries.map((entry) => canonicalPath(expandHome(entry))),
    commandPatterns: buildDeniedCommandPatterns(denyEntries),
  };
}

/** 判定路径：deny 优先于 allow；配置 allowed_roots 后越界为 ask */
export function evaluatePath(target: string, boundary: PathBoundary): 'allow' | 'ask' | 'deny' {
  const canonical = canonicalPath(target);
  if (boundary.denyRoots.some((root) => isWithin(canonical, root))) return 'deny';
  if (
    boundary.allowedRoots.length > 0 &&
    !boundary.allowedRoots.some((root) => isWithin(canonical, root))
  ) {
    return 'ask';
  }
  return 'allow';
}

// ── bash 命令文本 denylist（0.14.2 F2，best-effort） ──

/** 命令文本归一：大小写不敏感 + `\` 视作 `/`（Windows 两种分隔符都要命中） */
function normalizeCommandText(text: string): string {
  return text.replace(/\\/g, '/').toLowerCase();
}

/** 正则元字符转义 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 一条 denylist 路径在命令文本里可能出现的写法：`~/`、`$HOME/`、`${HOME}/`、绝对路径 */
function deniedPathSpellings(entry: string): string[] {
  const trimmed = entry.trim();
  // biome-ignore lint/suspicious/noTemplateCurlyInString: `${HOME}` 在这里是**要匹配的 shell 变量字面量**（denylist 路径写法），不是模板占位符
  if (trimmed === '~') return ['~', '$HOME', '${HOME}', os.homedir()].map(normalizeCommandText);
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    const suffix = trimmed.slice(2);
    return [
      `~/${suffix}`,
      `$HOME/${suffix}`,
      `\${HOME}/${suffix}`,
      path.join(os.homedir(), suffix),
    ].map(normalizeCommandText);
  }
  if (path.isAbsolute(trimmed)) {
    return [trimmed, path.normalize(trimmed)].map(normalizeCommandText);
  }
  // 相对路径按进程 cwd 解析（与 buildPathBoundary 的 expandHome 一致）
  return [path.resolve(expandHomePrefix(trimmed))].map(normalizeCommandText);
}

/** 命令文本匹配模式（构造边界时算好，避免每条命令重复展开家目录） */
export interface DeniedCommandPattern {
  entry: string;
  pattern: RegExp;
}

/**
 * 为内置 denylist + 配置 `deny_paths` 生成命令文本匹配模式。
 * 命中后要求下一字符不是路径延续，避免把 `~/.sshd` 之类当作 `~/.ssh`。
 */
function buildDeniedCommandPatterns(entries: readonly string[]): DeniedCommandPattern[] {
  return entries.flatMap((entry) =>
    deniedPathSpellings(entry).map((spelling) => ({
      entry,
      pattern: new RegExp(`${escapeRegExp(spelling)}(?![\\w.-])`),
    })),
  );
}

// ── 调用期边界注入 + 边界序列化（tools-engine P2，契约 §5 / §3） ──
//
// worker 执行**同一份** handler 源码，但 boundary 来自信封（host 权威），不是安装期闭包：
// engine 入口逐调用包一层 `runWithBasicToolsCallScope`。host in-process 路径没有 scope
// → 回退安装期闭包，行为逐字不变。**不加 ToolContext 字段**（core 仅增 S11 输出作用域机制，
// 见个人侧 CONTRACT-engine-pool.md；boundary 注入本身仍零 core 改动）。
// cwd 不走 scope：信封 cwd 进 ctx.cwd，worker 侧 config 为空 ⇒ resolveCallCwd 自然落到它。

/**
 * 调用期注入 scope：boundary 单权威 host（worker 不持久化 / 不自决）。
 * engine 池 S12 增可选 dirs：host 装配权威的落盘根 / 数据目录，逐调用注入；
 * 缺省（child 模式 / host in-process）不带 → env fallback 逐字不变（零回归）。
 */
export interface BasicToolsCallScope {
  boundary: PathBoundary;
  toolOutputDir?: string;
  dataDir?: string;
}

const callScopeStorage = new AsyncLocalStorage<BasicToolsCallScope>();

/**
 * 以给定边界 scope 包裹一次工具调用（worker 入口用；host in-process 路径不调用）。
 * scope 带 dirs 时复合 core 输出作用域（S11）：writeToolOutput / asyncLogDir 经
 * toolOutputRoot() 自动作用域化；不带 dirs 走现态逐字。
 */
export function runWithBasicToolsCallScope<T>(scope: BasicToolsCallScope, fn: () => T): T {
  if (scope.toolOutputDir !== undefined || scope.dataDir !== undefined) {
    return callScopeStorage.run(scope, () =>
      runWithToolOutputScope({ toolOutputDir: scope.toolOutputDir, dataDir: scope.dataDir }, fn),
    );
  }
  return callScopeStorage.run(scope, fn);
}

/** handler 取边界：调用期注入优先；无 scope 回退安装期闭包（host 路径一字不改）。 */
function activeBoundary(installed: PathBoundary): PathBoundary {
  return callScopeStorage.getStore()?.boundary ?? installed;
}

/** 边界序列化形状（wire JSON）：RegExp 不可直传，存 source + flags，worker 重建。 */
export interface SerializedBoundary {
  allowedRoots: string[];
  denyRoots: string[];
  commandPatterns: { entry: string; source: string; flags: string }[];
}

/** 序列化边界（host 转发工厂用）。单实现 —— 禁复制第二套（契约 §8）。 */
export function serializeBoundary(boundary: PathBoundary): SerializedBoundary {
  return {
    allowedRoots: [...boundary.allowedRoots],
    denyRoots: [...boundary.denyRoots],
    commandPatterns: boundary.commandPatterns.map(({ entry, pattern }) => ({
      entry,
      source: pattern.source,
      flags: pattern.flags,
    })),
  };
}

/** 从序列化形状重建边界（worker 用）：`new RegExp(source, flags)` 逐条重建。 */
export function deserializeBoundary(serialized: SerializedBoundary): PathBoundary {
  return {
    allowedRoots: [...serialized.allowedRoots],
    denyRoots: [...serialized.denyRoots],
    commandPatterns: serialized.commandPatterns.map(({ entry, source, flags }) => ({
      entry,
      pattern: new RegExp(source, flags),
    })),
  };
}

/**
 * 命令文本是否写出了敏感路径；命中返回对应 denylist 条目。
 * 只做字符串匹配，不做 shell 解析：`cd` 后再访问相对路径、变量拼接、符号链接等仍可绕过。
 */
function findDeniedPathInCommand(
  command: string,
  patterns: readonly DeniedCommandPattern[],
): string | undefined {
  const normalized = normalizeCommandText(command);
  for (const { entry, pattern } of patterns) {
    if (pattern.test(normalized)) return entry;
  }
  return undefined;
}

/** 命令文本命中 denylist 时的拒绝文本；`path_denied` 是稳定可判定的错误码 */
function deniedCommandMessage(entry: string): string {
  return (
    `错误：path_denied：bash 命令写出了敏感路径（${entry}），已拒绝执行。` +
    '这是命令文本的字符串匹配，不是沙箱；变量拼接、cd、符号链接等仍可能绕过。'
  );
}

/**
 * 按 `\n` 切分文本，去掉每行尾部的 `\r`（CRLF 显示归一），
 * 并丢掉末尾换行产生的空元素。「a\nb\nc\n」= 3 行、「」= 0 行。
 * 导出供 doc-subscription line-level 订阅：行号必须与 read 工具逐字同源。
 */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** 把 CRLF 归一为 LF（显示用；edit 仍按原始字节匹配） */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** 单方向输出超限时保留头尾，中间标注省略行数 */
function truncateLines(text: string): string {
  const lines = splitLines(text);
  if (lines.length <= MAX_OUTPUT_LINES) return text;
  const head = lines.slice(0, KEEP_HEAD_LINES);
  const tail = lines.slice(lines.length - KEEP_TAIL_LINES);
  const omitted = lines.length - KEEP_HEAD_LINES - KEEP_TAIL_LINES;
  return [...head, `...（已省略 ${omitted} 行）...`, ...tail].join('\n');
}

// ── token 闸（单条工具结果预算；第一道，行 / 字节闸之前） ──────
//
// 0.56 **闸上移**：实现搬到了 core（`packages/core/src/runtime/tool-result-gate.ts`），
// 由 loop 一处收口，覆盖所有插件工具（web_fetch / MCP / 未来插件）。这里保留的是
// **第二道闸**（过渡期）：bash / read / edit 自己先裁一遍，好处是这几个工具的落盘
// 文件名带工具名、且能省掉 loop 那次额外的全文拷贝。
//
// token 口径**只有一份**：core 的 `estimateTokens`（ASCII 0.25 / CJK 0.5 token 每字符）——
// 口径漂移会让「上下文压缩」和「工具结果截断」互相打架（一个说装得下、一个说装不下）。
//
// 幂等：裁完必须 `markToolResultBounded(ctx, ...)` 登记回执，否则 loop 会再裁一次，
// 第二轮会把「… 省略 N 行 / M 字符 · 完整输出：<path>」那一行自己裁掉。

/** 把「某个工具的一次结果」按 token 预算收口，并按需落盘全文（read / edit 用） */
async function boundToolOutput(ctx: ToolContext, tool: string, text: string): Promise<string> {
  const gated = await boundToolResult(text, {
    persist: () =>
      writeToolOutput({
        tool,
        body: text,
        ...(ctx.session_id !== undefined ? { sessionId: ctx.session_id } : {}),
      }),
  });
  // 幂等回执：告诉 loop「这条已经裁过了」，别裁第二遍（见 core/tool-result-gate.ts）。
  if (gated.bounded) markToolResultBounded(ctx, gated.originalChars);
  return gated.content;
}

/**
 * 替换首个匹配。
 * 刻意不用 `String.prototype.replace`——它的字符串替换会把 `$&`、`$1` 当特殊模式解释，
 * 而 old_string/new_string 是代码文本，必须逐字符原样写入。
 */
function replaceFirst(text: string, search: string, replacement: string): string {
  const index = text.indexOf(search);
  if (index < 0) return text;
  return text.slice(0, index) + replacement + text.slice(index + search.length);
}

/** 统计 search 在 text 中的出现次数（非重叠） */
function countOccurrences(text: string, search: string): number {
  return text.split(search).length - 1;
}

/** 最多等 ms 毫秒，不等 promise 到底 */
async function waitAtMost(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 管道泵：边读边存进 sink（可中途 cancel 取走已读内容） */
interface Pump {
  /** 读到 EOF（或被取消）后 resolve */
  done: Promise<void>;
  /** 放弃剩余读取，解开挂在 read() 上的等待 */
  cancel: () => void;
}

/** 单方向输出缓冲：字节上限之外的 chunk 只读不存 */
interface OutputSink {
  chunks: string[];
  bytes: number;
  truncated: boolean;
  /**
   * 文本入缓冲的唯一入口（泵只调它）。缺省 = 进 chunks；异步作业超时 detach 后
   * 被换成「追加进日志文件」—— 泵零改动继续排空管道，子进程不会因管道写满而阻塞。
   */
  push: (text: string) => void;
}

/** 新建输出缓冲 */
function createSink(): OutputSink {
  const sink: OutputSink = {
    chunks: [],
    bytes: 0,
    truncated: false,
    push: (text: string) => {
      sink.chunks.push(text);
    },
  };
  return sink;
}

/** 把子进程管道泵成文本（超过 MAX_PERSIST_BYTES 的部分丢弃并标记截断） */
function pumpStream(stream: ReadableStream<Uint8Array>, sink: OutputSink): Pump {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const done = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (!chunk.value) continue;
        if (sink.bytes >= MAX_PERSIST_BYTES) {
          sink.truncated = true;
          continue;
        }
        sink.push(decoder.decode(chunk.value, { stream: true }));
        sink.bytes += chunk.value.byteLength;
        if (sink.bytes >= MAX_PERSIST_BYTES) sink.truncated = true;
      }
      const tail = decoder.decode();
      if (tail && sink.bytes < MAX_PERSIST_BYTES) sink.push(tail);
    } catch {
      // 管道被强制关闭——已读到的内容仍然可用
    }
  })();
  return {
    done,
    cancel: () => {
      reader.cancel().catch(() => {});
    },
  };
}

// ── bash 写文件警告（只警告、不阻断）──────────────────
//
// 为什么要有这一段：实测 74 个会话 19,150 次工具调用里，bash 写文件 1,700+ 次
// （`> file` 1,310 / heredoc 262 / `sed -i` 93 / `cat >` 69 / `tee` 9），而 bash
// **不校验内容** —— 写坏了不报错、退出码照样 0，模型没有任何信号可以自纠。真机已经出过
// 一次：heredoc 里的反引号被沙箱预处理掉，文件内容静默变形。
// `edit` 不需要这类提醒：它逐字符匹配，匹配不中当场报错（实测失败率 2.8%，其中 54/106
// 的路径随后改成功）—— 会失败的东西自带反馈，不会失败的东西才需要提示。
//
// 形态（硬约束）：
// - **只追加一行**、固定在工具结果文本的**末尾**（`退出码 / stdout / stderr / 落盘提示`
//   之后，`\n` + 一行）。放末尾的理由：既有输出格式逐字节不变（纯追加），而且模型读完
//   输出、正好在最后一行拿到「下次别这么写」的动作建议；放开头会把首行的退出码顶掉。
// - 一次调用最多一行：多命中合并成一句（命中 heredoc 元字符时不再叠一条反引号警告）。
// - 命令照跑、退出码与输出不变，不动 `deny` / `ask` 权限逻辑，不动 `boundToolResult`；
//   不新增事件 —— `tool.call.completed` 的 `result` 就是这段文本，自然带上。
//
// 成本：纯字符扫描 + 正则（命令文本通常 < 10 KB），不读盘、不 spawn、不 await。
//
// 判据刻意保守（宁可漏报，不许误报成灾）：
//  1. 写文件类：`sed -i` / `tee <file>` / 重定向到像文件的目标。
//     `/dev/null`、`/dev/stdout`、`/dev/stderr`、`/dev/fd/*`、`&1`、`&2` 这些
//     「丢弃 / 接管输出」不算写文件（`cmd 2>/dev/null` 绝不能报）。
//  2. heredoc 且正文可能被预处理：有 `<<` 起手式，且命令文本里同时出现反引号 / `$(` / `${`。
//     这正是出事那一类（内容会被 shell 展开，沙箱也可能改写）。
//     刻意不区分界定符是否加引号（`<<'EOF'`）：本次事故就是沙箱预处理这一层动的手，
//     它不看 bash 的引号语义。
//  3. 命令里出现反引号：单独命中也给一行（命令替换是最常见的「静默变形」来源）。
//
// 判定前的去噪（否则误报会成灾）：先抹掉 heredoc 正文，再抹掉单 / 双引号内的字面量，
// 只拿**真正会被 bash 当命令解释的部分**去匹配重定向 / sed / tee —— 否则
// `echo "a > b"`、写 commit message 里的 `->`、`awk '{print > f}'` 全都会触发。
// 规则 2 / 3 仍扫**原文**：正文里的反引号正是要提醒的东西。

/** 反引号（单独取出来，免得下面几个字面量里混着它不好读） */
const BACKTICK = '\u0060';

/** 警告行前缀：固定一个字符，方便一眼看到 / 也方便事后按它统计命中率 */
const BASH_WRITE_WARN_PREFIX = '⚠ ';

/**
 * heredoc 起手式：`<<` / `<<-` + 可选引号 + 标识符。
 * `<<<`（herestring）与 `1 << 2`（位运算）不算 —— 宁可漏报。
 */
const HEREDOC_START = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1/;

/** `sed` 原地改文件：`-i`、`-i.bak`、`-ibak`、`--in-place` */
const SED_IN_PLACE = /\bsed\b[^|;&\n]*\s(?:-i[\w.]*|--in-place)\b/;

/** `tee` 带文件参数（只给选项 = 仍写到 stdout，不算写文件） */
const TEE_WITH_FILE = /\btee\b(?:\s+-{1,2}[\w-]+)*\s+[^\s|;&<>][^\s|;&<>]*/;

/** 重定向：`> ` / `>>` / `2>` / `&>` ……；捕获组 1 就是目标（fd 复制形如 `&1` 由调用方排除） */
const REDIRECT_TARGET = /(?:^|[\s;&|()])(?:[0-9]*>>?|&>>?)\s*([^\s;&|()<>]+)/g;

/** 这些重定向目标不是「写文件」：丢弃输出 / 复制既有 fd */
function isIgnoredRedirectTarget(target: string): boolean {
  // `2>&1` / `>&2` / `>&-`：目标是 fd 复制或关闭，不落文件
  if (target.startsWith('&') || target === '-') return true;
  if (target === '/dev/null' || target === '/dev/tty') return true;
  if (/^\/dev\/(?:fd\/\d+|stdout|stderr)$/.test(target)) return true;
  if (/^\/proc\/self\/fd\/\d+$/.test(target)) return true;
  return false;
}

/**
 * 抹掉 heredoc 正文（`<<EOF` 的下一行到界定符那一行），只留「会被 bash 当命令读的行」。
 * 正文里出现 `>` / `->` 是常态（写文档、写 commit message），拿它匹配重定向必然误报。
 */
function stripHeredocBodies(command: string): string {
  if (!command.includes('<<')) return command;
  const out: string[] = [];
  let pending: { delimiter: string; stripTabs: boolean } | undefined;
  for (const line of command.split('\n')) {
    if (pending !== undefined) {
      const candidate = pending.stripTabs ? line.replace(/^\t+/, '') : line;
      // 界定符那一行本身是命令的一部分（它闭合 heredoc），保留
      if (candidate.trimEnd() === pending.delimiter) {
        pending = undefined;
        out.push(line);
      }
      continue;
    }
    out.push(line);
    const start = HEREDOC_START.exec(line);
    if (start !== null && start[2] !== undefined) {
      pending = { delimiter: start[2], stripTabs: line.includes('<<-') };
    }
  }
  return out.join('\n');
}

/**
 * 抹掉 shell 引号内的字面量（单 / 双引号 + 反斜杠转义），只留引号外的命令部分。
 * 只为「写文件」判定去噪：`echo "a > b"` 里的 `>` 不是重定向。
 * 引号不配对时（正文里的撇号很常见）该段一直吃到文本结尾 —— 那一段不参与判定，
 * 属于「宁可漏报」。
 */
function stripShellQuotes(command: string): string {
  const out: string[] = [];
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (ch === undefined) break;
    if (quote === undefined) {
      if (ch === '\\') {
        i += 1; // 转义的字符一并丢掉
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      out.push(ch);
      continue;
    }
    if (quote === '"' && ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === quote) quote = undefined;
  }
  return out.join('');
}

/** 命令（去掉正文与引号后）是否会写文件：`sed -i` / `tee <file>` / 重定向到文件 */
function commandWritesFile(command: string): boolean {
  const code = stripShellQuotes(stripHeredocBodies(command));
  if (SED_IN_PLACE.test(code)) return true;
  if (TEE_WITH_FILE.test(code)) return true;
  for (const match of code.matchAll(REDIRECT_TARGET)) {
    const target = match[1];
    if (target !== undefined && !isIgnoredRedirectTarget(target)) return true;
  }
  return false;
}

/** 命令原文里有没有会被 shell 展开的元字符：反引号 / `$(` / `${` */
function hasExpandedMeta(command: string): boolean {
  return command.includes(BACKTICK) || command.includes('$(') || command.includes('${');
}

const WRITE_FILE_WARN =
  '这条命令会写文件（sed -i / 重定向 / tee / heredoc），而 bash 不会校验写进去的内容——' +
  '写坏了也不报错、退出码照样是 0。建文件 / 追加请用 `write`（内容逐字节落盘，不经 shell），' +
  '局部改代码用 `edit`（逐字符唯一匹配，改不中会报错）；非得用 bash 写，写完用 `read` 复核一遍。';

const HEREDOC_META_WARN =
  'heredoc 内容里的反引号与 $ 开头的写法（$() 与 $' +
  '{…}）会被 shell 先展开再写入，沙箱也可能改写正文，文件可能静默变形；' +
  '建文件 / 追加请改用 `write`（内容逐字节落盘，不经 shell），或先把内容写到临时文件再 cp。';

const BACKTICK_WARN =
  '命令里的反引号会被 bash 当命令替换（先执行、再用输出替换成文本）；' +
  '若只是想写反引号字面量（例如写 markdown），请用单引号包住，或用 `write` / `edit` 写文件。';

/**
 * 组装这条命令的写文件警告；无命中返回 `undefined`。
 * 返回值是**一整行**（不含换行），多命中已合并 —— 一次调用只追加这一行。
 * WSL 启动器已走修复传输（base64 / 临时脚本，单次解析）时，反引号 / heredoc 元字符不再被
 * 外层提前展开，BACKTICK_WARN / HEREDOC_META_WARN 不追加；WRITE_FILE_WARN（bash 不校验
 * 写进去的内容）与传输无关，仍然保留。
 */
function bashWriteWarning(command: string): string | undefined {
  if (command === '') return undefined;
  const parts: string[] = [];
  if (commandWritesFile(command)) parts.push(WRITE_FILE_WARN);
  if (!isWslBashLauncher()) {
    if (HEREDOC_START.test(command) && hasExpandedMeta(command)) {
      // 这条已经说清「反引号会被预处理」，再叠一条反引号警告就是啰嗦
      parts.push(HEREDOC_META_WARN);
    } else if (command.includes(BACKTICK)) {
      parts.push(BACKTICK_WARN);
    }
  }
  if (parts.length === 0) return undefined;
  return `${BASH_WRITE_WARN_PREFIX}${parts.join(' ')}`;
}

/** 把警告行追加到结果文本末尾（无警告时原样返回，逐字节不变） */
function appendWriteWarning(text: string, warning: string | undefined): string {
  return warning === undefined ? text : `${text}\n${warning}`;
}

// ── bash ─────────────────────────────────────────

/** 把完整输出裁成模型可读预览（按字节上限） */
function toPreview(text: string): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, 'utf-8');
  if (buffer.byteLength <= MAX_OUTPUT_BYTES) return { text, truncated: false };
  return {
    text: buffer.subarray(0, MAX_OUTPUT_BYTES).toString('utf-8'),
    truncated: true,
  };
}

// 落盘（`toolOutputRoot` / `safeSegment` / `writeToolOutput`）0.56 起只有 core 一份实现
// （`runtime/tool-result-gate.ts`）：loop 为**所有**插件工具落盘全文，必须与这里同一个
// 目录口径；两处各写一份迟早漂成两个目录。

/** bash 落盘正文（同步与异步共用同一格式：头几行元数据 + `[stdout]` / `[stderr]` 两段）。 */
function bashOutputBody(payload: {
  command: string;
  exitCode: number | null;
  cancelled: boolean;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
  /** 异步作业被谁停下（超时 / 插件收口 / 进程退出）；同步路径不带，正文逐字节不变 */
  sweptBy?: 'timeout' | 'exit';
  /** 超时但进程未被杀（kill_on_timeout=false 的 detach）；同步路径不带 */
  processLeftRunning?: boolean;
}): string {
  return [
    `# command: ${payload.command}`,
    `# exit_code: ${payload.exitCode ?? 'null'}`,
    `# cancelled: ${payload.cancelled}`,
    `# timed_out: ${payload.timedOut}`,
    ...(payload.processLeftRunning === true ? ['# process_left_running: true'] : []),
    ...(payload.sweptBy !== undefined ? [`# stopped_by: ${payload.sweptBy}`] : []),
    `# truncated_at_16MiB: ${payload.truncated}`,
    '',
    '[stdout]',
    payload.stdout,
    '[stderr]',
    payload.stderr,
  ].join('\n');
}

/** 把完整 bash 输出写入 session 目录；失败返回 undefined（调用方降级为纯截断） */
async function persistBashOutput(payload: {
  command: string;
  exitCode: number | null;
  cancelled: boolean;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
  sessionId?: string;
}): Promise<string | undefined> {
  return writeToolOutput({
    tool: 'bash',
    body: bashOutputBody(payload),
    ...(payload.sessionId !== undefined ? { sessionId: payload.sessionId } : {}),
  });
}

/**
 * 把完整 bash 输出写到**指定**路径（异步作业用）。
 *
 * 异步作业在启动时就把路径给模型了（并写一行 `# status: running` 占位），收口时覆盖它 ——
 * 只有这样才能让「日志路径」从第一秒起就成立。失败返回 undefined，通知里退化成只有预览。
 */
async function persistBashOutputAt(
  target: string,
  payload: {
    command: string;
    exitCode: number | null;
    cancelled: boolean;
    timedOut: boolean;
    stdout: string;
    stderr: string;
    truncated: boolean;
    processLeftRunning?: boolean;
  },
): Promise<string | undefined> {
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bashOutputBody(payload), 'utf-8');
    return target;
  } catch {
    return undefined;
  }
}

/**
 * 组装 bash 返回文本：退出码 + 非空输出段。
 * `lineGate` 为真时套用行数闸（`truncateLines`，第二道闸）；token 闸要用**未过行闸**
 * 的原文量预算，所以这里把它做成开关，而不是无条件截断。
 */
function formatBashResult(result: {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  timeoutMs: number;
  cancelled: boolean;
  lineGate: boolean;
  /** 超时但进程未被杀（异步 detach，kill_on_timeout=false）；缺省 = 旧文案逐字节不变 */
  processLeftRunning?: boolean;
}): string {
  const parts: string[] = [];
  if (result.cancelled) {
    parts.push(CANCELLED_TEXT);
  } else if (result.timedOut) {
    parts.push(
      result.processLeftRunning === true
        ? `错误：命令执行超时（已超过 ${result.timeoutMs}ms），进程未被终止（kill_on_timeout=false），仍在后台运行，输出继续追加进日志。`
        : `错误：命令执行超时（已超过 ${result.timeoutMs}ms），进程已被终止。`,
    );
  }
  parts.push(`退出码: ${result.exitCode ?? 'null（进程被信号终止）'}`);

  const gate = (text: string): string =>
    result.lineGate ? truncateLines(normalizeNewlines(text)) : normalizeNewlines(text);
  const stdout = gate(result.stdout);
  if (stdout.trim() !== '') {
    const marker = result.stdoutTruncated ? '\n...（输出超过 2MB，已截断）...' : '';
    parts.push(`stdout:\n${stdout}${marker}`);
  }

  const stderr = gate(result.stderr);
  if (stderr.trim() !== '') {
    const marker = result.stderrTruncated ? '\n...（输出超过 2MB，已截断）...' : '';
    parts.push(`stderr:\n${stderr}${marker}`);
  }
  return parts.join('\n');
}

// ── bash 传输层（WSL 启动器修复）──────────────────────
//
// Windows 宿主上 'bash' 可能解析到 C:\Windows\System32\bash.exe（WSL 启动器）。启动器会把
// -c 后面的字符串先在 spawn 的 cwd 过一遍外层 shell 解析，再交给 WSL 里的 /bin/bash：
// 反引号 / $() / ${} 即使写在单引号里也被提前展开，命令替换里的 `> f` 还会在 cwd（多为
// 仓库根）留下 0 字节垃圾文件。Linux/mac 原生 bash 与 Git Bash 的 bash.exe 只解析一次，
// 没有这个问题 —— 所以只修 WSL 启动器这一条路径，其余 argv 逐字节不变。
//
// 修法只改传输、不改命令文本：整条命令 base64 后交给内层 bash 解码 source，逐字节到达、
// 只解析一次（等同原生 Linux bash -c）；base64 字母表不含 shell 元字符，外层解析动不了它。
// 编码后超过 BASH_B64_MAX 字节时，命令文本落系统临时目录的随机名脚本（绝不落仓库），
// 内层 bash source 它，进程退出后立即删除。检测失败 / 临时文件写失败一律回退原 argv，不抛错。

/** WSL 启动器判定缓存：第一次探测后不再重复（非 win32 恒 false，不探测） */
let wslBashLauncher: boolean | undefined;

/** bash 是否解析到 WSL 启动器：判据是 Bun.which('bash') 的路径含 system32；探测失败按非启动器处理 */
function isWslBashLauncher(): boolean {
  if (process.platform !== 'win32') return false;
  if (wslBashLauncher === undefined) {
    try {
      const bashPath = Bun.which('bash');
      wslBashLauncher = (bashPath ?? '').toLowerCase().includes('system32');
    } catch {
      wslBashLauncher = false;
    }
  }
  return wslBashLauncher;
}

/** base64 传输的编码后长度上限：超过改走临时脚本（Windows 命令行约 32k，留足余量） */
const BASH_B64_MAX = 8000;

/** C:\foo\bar → /mnt/c/foo/bar；非盘符路径（UNC 等）返回 undefined，调用方回退现状 */
function windowsToWslPath(p: string): string | undefined {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  const drive = match?.[1];
  const rest = match?.[2];
  if (drive === undefined || rest === undefined) return undefined;
  return `/mnt/${drive.toLowerCase()}/${rest.replace(/\\/g, '/')}`;
}

/** POSIX 单引号包裹（内部撇号按 '\'' 拼接）：临时目录路径里的用户名可能带空格 / 撇号 */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

interface BashTransport {
  cmd: string[];
  /** 超长回退落盘的临时脚本；进程退出后立即删除 */
  scriptPath?: string;
}

/** 选命令传输：WSL 启动器走 base64 / 临时脚本，其余保持原 argv 逐字节不变 */
function buildBashTransport(command: string): BashTransport {
  const plain: BashTransport = { cmd: ['bash', '-c', command] };
  if (!isWslBashLauncher()) return plain;
  const encoded = Buffer.from(command, 'utf-8').toString('base64');
  if (encoded.length <= BASH_B64_MAX) {
    return { cmd: ['bash', '-c', `source <(printf %s ${encoded} | base64 -d)`] };
  }
  // 超长：命令文本落系统临时目录随机名脚本。source 指令本身很短，仍走 base64 包装，
  // 脚本路径转成 /mnt/… 并单引号包住 —— 不依赖启动器对脚本路径参数的未验证行为。
  try {
    const scriptPath = path.join(os.tmpdir(), `vessel-bash-${randomUUID().slice(0, 8)}.sh`);
    const wslPath = windowsToWslPath(scriptPath);
    if (wslPath === undefined) return plain;
    writeFileSync(scriptPath, command, { encoding: 'utf-8', mode: 0o600 });
    const sourceLine = `source ${shellSingleQuote(wslPath)}`;
    const sourceEncoded = Buffer.from(sourceLine, 'utf-8').toString('base64');
    return {
      cmd: ['bash', '-c', `source <(printf %s ${sourceEncoded} | base64 -d)`],
      scriptPath,
    };
  } catch {
    // 临时目录不可写等：回退现状，不抛错
    return plain;
  }
}

/** 待清理的临时脚本（进程退出时同步兜底扫一遍，命令文本别滞留临时目录） */
const pendingTempScripts = new Set<string>();
let tempScriptSweepInstalled = false;

function cleanupTempScript(scriptPath: string): void {
  pendingTempScripts.delete(scriptPath);
  try {
    unlinkSync(scriptPath);
  } catch {
    // 已删除
  }
}

/** bash 退出（正常 / 被杀 / 异常）后立即删脚本；另挂进程退出兜底（'exit' 里 Promise 不再跑） */
function watchTempScript(scriptPath: string, exited: Promise<number>): void {
  pendingTempScripts.add(scriptPath);
  if (!tempScriptSweepInstalled) {
    tempScriptSweepInstalled = true;
    process.once('exit', () => {
      for (const pending of pendingTempScripts) {
        try {
          unlinkSync(pending);
        } catch {
          // 退出路径 best-effort
        }
      }
    });
  }
  const cleanup = (): void => cleanupTempScript(scriptPath);
  void exited.then(cleanup, cleanup);
}

/**
 * run 身份 env（自重启 Option A）：bash 子进程里的 `vessel restart --self` 据此
 * 认出触发者会话 / run，无需模型自报身份。缺字段（如 headless 无 session）就不注入。
 */
function runIdentityEnv(ctx: ToolContext): Record<string, string | undefined> {
  return {
    ...(ctx.session_id !== undefined && ctx.session_id !== ''
      ? { VESSEL_SESSION_ID: ctx.session_id }
      : {}),
    ...(ctx.run_id !== undefined && ctx.run_id !== '' ? { VESSEL_RUN_ID: ctx.run_id } : {}),
  };
}

/** 启动 bash（WSL 启动器时传输走 buildBashTransport）；返回类型交给 Bun.spawn 推导（手写 Subprocess 泛型参数极易踩错） */
function spawnBash(
  command: string,
  cwd: string | undefined,
  options?: { ignoreStdin?: boolean; env?: Record<string, string | undefined> },
) {
  const transport = buildBashTransport(command);
  // engine 池 S12：调用期 scope 的 dirs 注入子进程 env（池内多 node 共进程，进程级 env 不够）；
  // 无 scope（host in-process / child 模式）= 逐字继承 process.env，行为不变。
  const scope = callScopeStorage.getStore();
  // 自重启 Option A：run 身份 env（VESSEL_SESSION_ID / VESSEL_RUN_ID）让 run 内发起的
  // `vessel restart --self` 能认出触发者。WSL2 只传 WSLENV 列出的变量 ⇒ 追加登记。
  const extraEnv = options?.env;
  const wslenvAppend =
    isWslBashLauncher() && extraEnv !== undefined
      ? Object.keys(extraEnv)
          .filter((key) => extraEnv[key] !== undefined)
          .join(':')
      : '';
  try {
    const proc = Bun.spawn({
      cmd: transport.cmd,
      cwd,
      env: {
        ...process.env,
        ...(scope?.dataDir ? { VESSEL_DATA_DIR: scope.dataDir } : {}),
        ...(scope?.toolOutputDir ? { VESSEL_TOOL_OUTPUT_DIR: scope.toolOutputDir } : {}),
        ...(extraEnv ?? {}),
        ...(wslenvAppend !== ''
          ? {
              WSLENV: `${process.env.WSLENV ? `${process.env.WSLENV}:` : ''}${wslenvAppend}`,
            }
          : {}),
      },
      stdout: 'pipe',
      stderr: 'pipe',
      /**
       * 异步作业**不**继承父进程 stdin。
       *
       * 它活过工具调用，继承下来的 stdin 就是宿主（TUI / gateway）那一个 —— 一条会读 stdin 的
       * 命令会把宿主的输入流吃掉，真机里的表现是「起了后台作业后 REPL 立刻退出」（stdin 被
       * 子进程共享后父侧读到 EOF）。同步路径保持继承：那是 0.54 的行为，不传 async 时不变。
       */
      ...(options?.ignoreStdin === true ? { stdin: 'ignore' as const } : {}),
      // Windows + WSL bash 默认会弹出控制台窗口；隐藏它（POSIX 忽略该选项）
      windowsHide: true,
      // POSIX 下建独立进程组，取消时能连同孙进程一起杀
      detached: process.platform !== 'win32',
    });
    if (transport.scriptPath !== undefined) watchTempScript(transport.scriptPath, proc.exited);
    return proc;
  } catch (error) {
    // 进程没起来：已落盘的临时脚本立即删，别滞留命令文本
    if (transport.scriptPath !== undefined) cleanupTempScript(transport.scriptPath);
    throw error;
  }
}

/** 杀掉 bash 及其派生的孙进程（POSIX 用进程组；Windows 用 taskkill /T） */
function killProcessTree(proc: ReturnType<typeof spawnBash>): void {
  const pid = proc.pid;
  if (typeof pid === 'number' && pid > 0) {
    if (process.platform === 'win32') {
      try {
        Bun.spawnSync({
          cmd: ['taskkill', '/PID', String(pid), '/T', '/F'],
          stdout: 'ignore',
          stderr: 'ignore',
          windowsHide: true,
        });
      } catch {
        // taskkill 不可用：仍尝试直接 kill
      }
    } else {
      try {
        // detached 时 pid 即进程组 id
        process.kill(-pid, 'SIGTERM');
      } catch {
        // 进程组已不存在
      }
    }
  }
  try {
    proc.kill();
  } catch {
    // 已退出
  }
}

// ── bash 异步作业（0.55，显式 opt-in）──────────────────
//
// 触发场景：`git worktree add` 这类命令要 30–90 秒（实测还有超 120 秒的），同步 bash 会把
// 整个回合按住等它结束。`async: true` 起进程就返回，回合继续；命令结束时把
// 「退出码 + 头尾输出 + 落盘路径」送回模型。
//
// **交付不新造通道**：完成结果拼成一条 `vessel:notice` 尾消息，由本插件注册的 BeforeLlm
// hook 注入该会话**下一次模型请求之前** —— 与 `runtime-notice-hook` / `refs-notice-hook` /
// doc-subscription 同一个消息名、同一个落盘位置、同一套渲染。为什么不用 inbox + 新 run
// （`ask` 的 async 走那条）：那条路要 node 装配层的 `AgentService.admit`，插件层拿不到端口，
// 也不该为了一个工具去开新 RPC。
//
// 代价（写清楚，别让下一个人猜）：注入发生在**下一次模型请求前**。回合还在跑时通知几乎立刻
// 到（模型每次迭代都过一次 BeforeLlm）；回合已经结束就等到该会话下一次 run 的第一轮。
// 所以工具返回文本必须说清「本轮不等待」，并把日志路径给模型（想看进度可以自己 read）。
//
// 进程生命周期（0.58 用户裁定#8 起）：
// - 缺省**不限时**（`timeout_ms` / `async_timeout_ms` = 0）：长驻命令（gateway start）
//   不会被缺省死线杀掉；显式正数超时仍可用；
// - 到点杀不杀由 `kill_on_timeout` 决定：true = 整棵进程树被杀（0.55 旧行为）；
//   false（缺省）= 只「断连接」：立即收口通知、释放并发额度，进程继续跑，
//   管道泵改向追加进日志文件（子进程不会因管道写满而阻塞），进程退出时补记 exit 行；
// - 插件 dispose 刻意不杀作业（见文件末尾 dispose 注释）；
// - 进程退出时（`process.once('exit')`）兜底杀全部在跑作业与 detached 进程，best-effort；
// - 刻意**不**挂 run 的 AbortSignal：异步作业的全部意义就是活过这次工具调用，跟着 run
//   一起死等于把异步退化成同步。要停它，靠显式超时（kill_on_timeout=true）或进程退出。

/** 一条后台作业的记账（输出缓冲在收口时释放，只留元数据与通知正文）。 */
interface AsyncBashJob {
  readonly id: string;
  readonly command: string;
  readonly cwd: string;
  readonly startedAt: number;
  readonly timeoutMs: number;
  readonly logPath: string;
  readonly proc: ReturnType<typeof spawnBash>;
  readonly pumps: { stdout: Pump; stderr: Pump };
  readonly sinks: { stdout: OutputSink; stderr: OutputSink };
  /** 发起它的会话；缺省 = 无会话（CLI 单会话），任何会话的下一轮都可注入 */
  sessionId?: string;
  /** 发起它的 run（q-async-bash-viz：时间线事实事件 / 注册表元数据用）。 */
  runId?: string;
  /** 子进程 pid（展示 / 诊断用）。 */
  pid?: number;
  /** 退出码（收口时填；null = 被信号杀）。 */
  exitCode?: number | null;
  /**
   * 事实发射端口快照（q-async-bash-viz）：起作业时从 ctx.emitFact 捕获，收口时据此发
   * bash.job.completed/failed 时间线事实（run 已结束也能发——EU.publishEvent 走 transient
   * journal）。缺省（旧装配未注入）= 不发时间线事件，零回归。
   */
  emitFact?: (event: RunEvent) => void;
  /** 超时被杀 / 被 detach（由定时器写，收口时读） */
  timedOut: boolean;
  /** 超时后是否杀进程树（起作业时从生效 limits 快照；作业生命周期内不随热应用变） */
  readonly killOnTimeout: boolean;
  timer?: ReturnType<typeof setTimeout>;
  /** 不限时作业 / detach 后的保活心跳（ref'd，撑住进程不退）；真正退出时清除 */
  keepAlive?: ReturnType<typeof setInterval>;
  /** 已 detach（超时但进程继续跑）：收口通知已发，泵改向追加日志，等真正退出 */
  detached?: boolean;
  /** detach 后的日志追加器（序列化写队列）；进程退出时经它补记 exit 行，保证顺序 */
  tailAppend?: (text: string) => void;
  finishedAt?: number;
  /** 收口后的通知正文；有值即「已完成」 */
  notice?: string;
  /** 已注入过（同一作业只注入一次） */
  announced?: boolean;
  /** 谁把它停下的（超时 / 插件收口 / 进程退出）：进日志，事后能解释作业为什么没跑完 */
  sweptBy?: 'timeout' | 'exit';
}

/**
 * 作业表的唯一持有者：**进程级**，不是插件安装级。
 *
 * 为什么必须这样：热应用会用**旁路 host** 重新 install 一遍 basic-tools 来算出目标工具集
 * （`assemblePluginTools`），那批工具定义随后替换掉真实 host 上的定义 —— 若作业表跟着安装
 * 实例走，替换后新工具起的作业就落在一张 hook 永远看不到的表里。进程级单表 + 按名字幂等
 * 注册 hook，两条路径都收敛到同一份状态。
 */
const asyncJobs = new Map<string, AsyncBashJob>();

/**
 * 超时 detach 后仍在跑的进程（进程级，与 asyncJobs 同口径）。
 * 作业记录可能已被 pruneAsyncJobs 淘汰，但进程还活着 —— exit 兜底必须仍找得到它。
 * 进程真正退出时由 finalizeAsyncBash 的 detached 分支移除。
 */
const detachedAsyncProcs = new Map<string, AsyncBashJob>();

/** 异步预算的生效值（进程级；install 时更新，与作业表同口径，热应用下一作业即生效）。 */
export interface AsyncBashLimits {
  /** 异步缺省超时（ms）；0 = 不限时 */
  asyncTimeoutMs: number;
  /** 超时后是否杀进程树（缺省 false = 只断连接） */
  killOnTimeout: boolean;
  /** 同时在跑作业上限 */
  maxAsyncJobs: number;
}

let asyncLimits: AsyncBashLimits = {
  asyncTimeoutMs: DEFAULT_ASYNC_BASH_TIMEOUT_MS,
  killOnTimeout: false,
  maxAsyncJobs: DEFAULT_MAX_ASYNC_JOBS,
};

/** 读生效的异步预算（装配层 bash-job-delivery 的在途上限与此同源，不存第二份数值）。 */
export function getAsyncBashLimits(): AsyncBashLimits {
  return asyncLimits;
}

/** 后台作业的过程日志（debug 级，一条作业一行起步）；阈值跟随进程级日志中枢。 */
const jobLog = createStderrLogger();

/** 进程退出兜底是否已武装（只装一次，避免多次 install 叠加监听器） */
let asyncExitSweepInstalled = false;

/** 异步日志目录：`<输出根>/<session>/bash-async`（与同步落盘同一个根，便于一起清理）。 */
function asyncLogDir(sessionId: string | undefined): string {
  return path.join(toolOutputRoot(), safeSegment(sessionId), 'bash-async');
}

/** 折成一行并截断（命令 / cwd 这类字段进通知用；全文在日志里）。 */
function oneLineText(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** 在跑（未收口）的作业数 */
function liveAsyncCount(): number {
  let live = 0;
  for (const job of asyncJobs.values()) if (job.notice === undefined) live += 1;
  return live;
}

/** 已完成但还没注入的作业（按完成时间升序），`sessionId` 只取本会话的（无会话作业给所有会话）。 */
function completedAsyncJobs(sessionId: string | undefined): AsyncBashJob[] {
  const ready: AsyncBashJob[] = [];
  for (const job of asyncJobs.values()) {
    if (job.notice === undefined || job.announced === true) continue;
    if (job.sessionId !== undefined && job.sessionId !== sessionId) continue;
    ready.push(job);
  }
  return ready.sort((left, right) => (left.finishedAt ?? 0) - (right.finishedAt ?? 0));
}

/**
 * 淘汰完成记录（两条规则，都是常量上界，与负载无关）：
 * 1) 没人来取的通知超过 `ASYNC_RECORD_TTL_MS` 就丢（理由见该常量）；
 * 2) 已送达的记录只留最近 `MAX_ASYNC_RECORDS` 条。
 * 在跑（未收口）的作业永远不在这里被动。
 */
function pruneAsyncJobs(): void {
  const delivered: AsyncBashJob[] = [];
  const now = Date.now();
  // 1) 过期：没人来取的完成通知最多留 ASYNC_RECORD_TTL_MS（理由见该常量）。
  for (const [id, job] of asyncJobs) {
    if (job.notice === undefined) continue;
    if (job.announced !== true) {
      if (now - (job.finishedAt ?? now) > ASYNC_RECORD_TTL_MS) asyncJobs.delete(id);
      continue;
    }
    // 2) 已送达的旧记录：只留最近 MAX_ASYNC_RECORDS 条（bounded，与负载无关）。
    delivered.push(job);
  }
  const excess = delivered.length - MAX_ASYNC_RECORDS;
  if (excess <= 0) return;
  delivered.sort((left, right) => (left.finishedAt ?? 0) - (right.finishedAt ?? 0));
  for (const job of delivered.slice(0, excess)) asyncJobs.delete(job.id);
}

/** 杀掉全部在跑作业与 detached 进程（进程退出时收口）。 */
function killLiveAsyncJobs(reason: 'exit'): void {
  for (const job of asyncJobs.values()) {
    if (job.notice !== undefined) continue;
    job.sweptBy ??= reason;
    // 收口留一条 stderr：事后能解释「这条作业为什么没了」
    console.error(`[vessel] basic-tools: stopping bash job ${job.id} (${reason})`);
    killProcessTree(job.proc);
  }
  // detach 的作业通知已发（notice 有值），但进程还在跑 —— 同样不留孤儿。
  for (const job of detachedAsyncProcs.values()) {
    console.error(`[vessel] basic-tools: stopping detached bash job ${job.id} (${reason})`);
    killProcessTree(job.proc);
  }
}

/**
 * 进程退出兜底：在 'exit' 里同步杀一遍。
 *
 * 为什么必须有：`bash -c` 的子进程在父进程退出后会被 init 收养（POSIX 不级联杀），
 * 一次 `vessel` 一次性运行结束就会留下一条还在跑的长命令 —— 那正是「孤儿」。
 * 这里只做 best-effort（Windows 的 taskkill 走 `Bun.spawnSync`），失败不报错。
 */
function installAsyncExitSweep(): void {
  if (asyncExitSweepInstalled) return;
  asyncExitSweepInstalled = true;
  process.once('exit', () => {
    try {
      killLiveAsyncJobs('exit');
    } catch {
      // 退出路径不抛错
    }
  });
}

/** 起一条后台命令（校验已在 `runBash` 里做完）；返回给模型的「已启动」文本。 */
async function startAsyncBash(options: {
  command: string;
  cwd: string;
  timeoutMs: number;
  ctx: ToolContext;
}): Promise<string> {
  const limits = asyncLimits;
  if (liveAsyncCount() >= limits.maxAsyncJobs) {
    return (
      `错误：后台作业已达上限（${limits.maxAsyncJobs} 个在跑）。等其中一条结束再发，` +
      '或者去掉 async 用同步方式跑这一条（上限可配 basic-tools max_async_jobs）。'
    );
  }

  const id = randomUUID().slice(0, 8);
  const logPath = path.join(asyncLogDir(options.ctx.session_id), `bash-async-${id}.log`);
  // 先落一行 started：路径从第一秒起就存在，模型中途 read 也不会误判成「文件不存在」。
  try {
    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(
      logPath,
      [
        `# command: ${options.command}`,
        `# cwd: ${options.cwd}`,
        `# started_at: ${Date.now()}`,
        '# status: running（命令结束后本文件被完整输出覆盖）',
        '',
      ].join('\n'),
      'utf-8',
    );
  } catch {
    // 落盘不可用：作业照跑，通知里会带输出预览（只是没有全文）
  }

  let proc: ReturnType<typeof spawnBash>;
  try {
    proc = spawnBash(options.command, options.cwd, {
      ignoreStdin: true,
      env: runIdentityEnv(options.ctx),
    });
  } catch (error) {
    // 占位日志别留在盘上假装还在跑
    try {
      unlinkSync(logPath);
    } catch {
      // 文件可能没写成功，忽略
    }
    return `错误：无法启动 bash：${String(error)}`;
  }

  const sinks = { stdout: createSink(), stderr: createSink() };
  const job: AsyncBashJob = {
    id,
    command: options.command,
    cwd: options.cwd,
    startedAt: Date.now(),
    timeoutMs: options.timeoutMs,
    logPath,
    proc,
    pumps: {
      stdout: pumpStream(proc.stdout, sinks.stdout),
      stderr: pumpStream(proc.stderr, sinks.stderr),
    },
    sinks,
    timedOut: false,
    killOnTimeout: limits.killOnTimeout,
    ...(options.ctx.session_id !== undefined ? { sessionId: options.ctx.session_id } : {}),
    ...(options.ctx.run_id !== undefined ? { runId: options.ctx.run_id } : {}),
    ...(typeof proc.pid === 'number' ? { pid: proc.pid } : {}),
    ...(options.ctx.emitFact !== undefined ? { emitFact: options.ctx.emitFact } : {}),
  };
  asyncJobs.set(id, job);
  installAsyncExitSweep();
  // q-async-bash-viz：通知装配层起了一条作业（往 inbox 插 running 占位卡）。fire-and-forget：
  // 没装出口（CLI / TUI / 嵌入方）= 不插占位，完成退回 hook 通知，零回归。
  notifyAsyncBashStarted(job);
  // 时间线事实：bash.job.started（WebUI 据此跟踪在跑作业 → run 徽标「等待异步任务」）。
  emitBashJobFact(job, 'bash.job.started', {
    status: 'running',
    command: oneLineText(job.command),
    pid: job.pid,
    log_path: job.logPath,
    started_at: job.startedAt,
  });
  // 一条起步日志：事后能回答「这条作业当时走的是哪条交付通道」（装配层的唤醒投递
  // 注册在 src/，插件看不到它是否成功；这里只读出口槽本身）。
  jobLog.debug('basic_tools.bash_job.started', {
    job_id: id,
    delivery: asyncSinkSlot().sink === undefined ? 'hook-only' : 'wired',
    timeout_ms: options.timeoutMs,
    kill_on_timeout: job.killOnTimeout,
  });

  // 定时器**不** unref：作业在跑的时候我们就要求进程别退出（否则输出会被丢在半路）。
  // 0 = 不限时（缺省）：没有死线，用一个 ref'd 保活心跳承接同一语义（真正退出时清除）。
  if (options.timeoutMs > 0) {
    job.timer = setTimeout(() => {
      job.timedOut = true;
      job.sweptBy ??= 'timeout';
      if (job.killOnTimeout) {
        killProcessTree(proc);
      } else {
        // 断连接不杀进程：立即收口通知，泵改向追加日志，进程继续跑。
        detachAsyncJob(job);
      }
    }, options.timeoutMs);
  } else {
    job.keepAlive = setInterval(() => {
      // 空转保活：只为撑住事件循环（见 ASYNC_KEEPALIVE_INTERVAL_MS）
    }, ASYNC_KEEPALIVE_INTERVAL_MS);
  }

  // 收口是脱钩的（工具已经返回了）：异常没有收件人，收敛成一条「收集失败」的通知。
  void finalizeAsyncBash(job).catch(() => {
    job.finishedAt = Date.now();
    job.notice = `[runtime] bash job ${id} finished, but its output could not be collected. See ${logPath}.`;
    pruneAsyncJobs();
  });

  // 写文件警告只挂在**起步文本**上：这是模型还能改主意的时刻；收口通知是「结果」，
  // 同一条命令的同一句提醒不重复塞两遍。
  const asyncWriteWarning = bashWriteWarning(options.command);
  return [
    `已启动（异步）：job ${id}`,
    `命令：${oneLineText(options.command, 400)}`,
    `cwd：${options.cwd}`,
    `超时：${options.timeoutMs > 0 ? `${options.timeoutMs}ms` : '无（不限时）'}`,
    ...(options.timeoutMs > 0 && !job.killOnTimeout
      ? [
          '超时行为：到点不杀进程（kill_on_timeout=false）——立即回报超时，进程继续跑，输出继续追加进日志。',
        ]
      : []),
    `日志：${logPath}（运行中只有一行 started 标记，命令结束后写入完整输出）`,
    '本轮不等待：继续做别的事，不要轮询、不要重复启动同一条命令。',
    '命令结束时会有一条 runtime 消息（退出码 + 头尾输出 + 日志路径）注入你这个会话的下一轮上下文；',
    '若本轮已结束，它在该会话下一次 run 的第一轮到达。中途想看进度就直接 read 上面的日志文件。',
    '注意：本进程退出时仍在跑的后台命令会被一并终止。',
    ...(asyncWriteWarning === undefined ? [] : [asyncWriteWarning]),
  ].join('\n');
}

/**
 * 唤醒投递（finalize / detach 共用，单实现）：装了出口就试一次，成功标 announced
 * （hook 永不再注入）；失败 / 没装不标，hook 兜底。任何异常收敛成「未投递」，不抛。
 */
async function deliverAsyncNotice(
  job: AsyncBashJob,
  content: string,
  exitCode: number | null,
  logPath: string,
): Promise<void> {
  const sink = asyncSinkSlot().sink;
  if (sink === undefined || job.sessionId === undefined) return;
  let delivered = false;
  try {
    delivered = await sink({
      jobId: job.id,
      sessionId: job.sessionId,
      content,
      exitCode,
      timedOut: job.timedOut,
      elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt,
      logPath,
    });
  } catch {
    delivered = false;
  }
  if (delivered) job.announced = true;
}

/**
 * 序列化日志追加器（detach 后的泵出口）：chunk 进队列、按序 appendFile。
 * `open()` 前只攒不写 —— 超时快照必须先覆盖落盘，追加才开闸，否则快照会把先到的追加抹掉。
 * 队列上界 = 泵的重置后预算（每方向 16 MiB，`MAX_PERSIST_BYTES`），不随输出无界增长。
 * 落盘失败只丢当前批（管道必须继续排空，子进程不能因我们写不进盘而阻塞）。
 */
function createLogAppender(target: string): { push: (text: string) => void; open: () => void } {
  const queue: string[] = [];
  let writing = false;
  let opened = false;
  const flush = async (): Promise<void> => {
    if (writing || !opened) return;
    writing = true;
    try {
      while (queue.length > 0) {
        const batch = queue.join('');
        queue.length = 0;
        await appendFile(target, batch, 'utf-8');
      }
    } catch {
      queue.length = 0;
    } finally {
      writing = false;
    }
  };
  return {
    push: (text: string): void => {
      queue.push(text);
      void flush();
    },
    open: (): void => {
      opened = true;
      void flush();
    },
  };
}

/**
 * 超时「断连接」（kill_on_timeout=false，缺省）：不杀进程，立即收口通知、释放并发额度。
 *
 * 关键约束：管道泵**不能停** —— 子进程（如 gateway）持续输出，泵一停，64KB 管道写满
 * 子进程就阻塞在 write 上，等于变相杀。所以把泵的出口从内存缓冲换成日志追加器：
 * 快照（截至超时的输出）先按标准格式覆盖落盘，之后的输出继续追加（每方向再给
 * 16 MiB 预算，超了只读不存）。进程真正退出时 finalizeAsyncBash 的 detached 分支补记 exit 行。
 */
function detachAsyncJob(job: AsyncBashJob): void {
  // ── 同步段：快照 + 泵换向（无 await，泵插不进来，输出零丢失）──
  const stdout = job.sinks.stdout.chunks.join('');
  const stderr = job.sinks.stderr.chunks.join('');
  const truncated = job.sinks.stdout.truncated || job.sinks.stderr.truncated;
  const appender = createLogAppender(job.logPath);
  job.tailAppend = appender.push;
  for (const sink of [job.sinks.stdout, job.sinks.stderr]) {
    sink.chunks.length = 0;
    sink.bytes = 0;
    sink.truncated = false;
    sink.push = appender.push;
  }
  appender.push(
    '\n# --- timeout reached; process left running (kill_on_timeout=false); live output appended below (stdout/stderr interleaved) ---\n',
  );
  job.detached = true;
  detachedAsyncProcs.set(job.id, job);
  // detach 后仍要撑住进程（原定时器已触发；不限时作业本就有 keepAlive）
  job.keepAlive ??= setInterval(() => {
    // 空转保活（见 ASYNC_KEEPALIVE_INTERVAL_MS）
  }, ASYNC_KEEPALIVE_INTERVAL_MS);
  job.finishedAt = Date.now();
  jobLog.debug('basic_tools.bash_job.detached', { job_id: job.id, timeout_ms: job.timeoutMs });

  void (async () => {
    // 快照先覆盖落盘，追加才开闸（createLogAppender 的 open 语义）
    const saved = await persistBashOutputAt(job.logPath, {
      command: job.command,
      exitCode: null,
      cancelled: false,
      timedOut: true,
      stdout,
      stderr,
      truncated,
      processLeftRunning: true,
    });
    appender.open();

    // 通知与 finalize 同口径：组装 → 预览 token 闸 → 出口闸
    const full = formatBashResult({
      exitCode: null,
      stdout,
      stderr,
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: true,
      timeoutMs: job.timeoutMs,
      cancelled: false,
      lineGate: false,
      processLeftRunning: true,
    });
    const cut = cutToTokenBudget(full, MAX_ASYNC_PREVIEW_TOKENS);
    const preview =
      cut.omittedChars === 0
        ? full
        : `${cut.head}\n${omitMarker(cut, saved ?? job.logPath)}\n${cut.tail}`;
    const elapsed = Math.max(
      0,
      Math.round(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000),
    );
    const head = [
      `[runtime] bash job ${job.id} finished — timed out after ${job.timeoutMs}ms · process left running (kill_on_timeout=false) · ${elapsed}s`,
      `${ASYNC_NOTICE_DETAIL_MARK}cmd: ${oneLineText(job.command)}`,
      `${ASYNC_NOTICE_DETAIL_MARK}cwd: ${job.cwd}`,
      `${ASYNC_NOTICE_DETAIL_MARK}log: ${saved ?? job.logPath} (snapshot at timeout; live output keeps appending)`,
      `${ASYNC_NOTICE_DETAIL_MARK}output (head/tail at timeout; the log path has all of it):`,
    ].join('\n');
    job.notice = (
      await boundToolResult(`${head}\n${preview}`, {
        persist: async () => saved ?? job.logPath,
      })
    ).content;
    await deliverAsyncNotice(job, job.notice, null, saved ?? job.logPath);
    // q-async-bash-viz：超时 detach 的时间线事实（进程仍在跑，但作业额度已释放、通知已发）。
    emitBashJobFact(job, 'bash.job.failed', {
      status: 'failed',
      exit_code: null,
      timed_out: true,
      detached: true,
      elapsed_ms: (job.finishedAt ?? Date.now()) - job.startedAt,
      log_path: saved ?? job.logPath,
      ended_at: job.finishedAt,
    });
    pruneAsyncJobs();
  })().catch(() => {
    appender.open();
    job.notice = `[runtime] bash job ${job.id} timed out after ${job.timeoutMs}ms; process left running, but its output could not be collected. See ${job.logPath}.`;
    pruneAsyncJobs();
  });
}

/** 作业收口（只跑一次）：等退出 → 排空管道 → 落盘全文 → 收口通知正文。 */
async function finalizeAsyncBash(job: AsyncBashJob): Promise<void> {
  let exitCode: number | null = null;
  try {
    exitCode = await job.proc.exited;
  } catch {
    exitCode = job.proc.exitCode ?? null;
  }
  job.exitCode = exitCode;
  if (job.timer !== undefined) clearTimeout(job.timer);
  if (job.detached === true) {
    // 超时通知已在 detach 时发过：这里只做真正退出的收口，绝不发第二条通知。
    if (job.keepAlive !== undefined) clearInterval(job.keepAlive);
    detachedAsyncProcs.delete(job.id);
    await waitAtMost(Promise.all([job.pumps.stdout.done, job.pumps.stderr.done]), DRAIN_GRACE_MS);
    job.pumps.stdout.cancel();
    job.pumps.stderr.cancel();
    // exit 行走同一追加队列：与仍在落盘的追加输出保证顺序
    job.tailAppend?.(`\n# process_exited: ${exitCode ?? 'null'} (after timeout detach)\n`);
    jobLog.debug('basic_tools.bash_job.detached_exited', { job_id: job.id, exit_code: exitCode });
    return;
  }
  if (job.keepAlive !== undefined) clearInterval(job.keepAlive);
  await waitAtMost(Promise.all([job.pumps.stdout.done, job.pumps.stderr.done]), DRAIN_GRACE_MS);
  job.pumps.stdout.cancel();
  job.pumps.stderr.cancel();

  const stdout = job.sinks.stdout.chunks.join('');
  const stderr = job.sinks.stderr.chunks.join('');
  const truncated = job.sinks.stdout.truncated || job.sinks.stderr.truncated;
  job.finishedAt = Date.now();

  // 全文落盘：与同步路径同一个格式（覆盖启动时那行 running 占位）
  const saved = await persistBashOutputAt(job.logPath, {
    command: job.command,
    exitCode,
    cancelled: false,
    timedOut: job.timedOut,
    stdout,
    stderr,
    truncated,
    ...(job.sweptBy !== undefined && job.sweptBy !== 'timeout' ? { sweptBy: job.sweptBy } : {}),
  });

  // 预览：先按 bash 结果的组装口径拼（行闸关，交给 token 闸），再按通知预算切头尾
  const full = formatBashResult({
    exitCode,
    stdout,
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: job.timedOut,
    timeoutMs: job.timeoutMs,
    cancelled: false,
    lineGate: false,
  });
  const cut = cutToTokenBudget(full, MAX_ASYNC_PREVIEW_TOKENS);
  const preview =
    cut.omittedChars === 0
      ? full
      : `${cut.head}\n${omitMarker(cut, saved ?? job.logPath)}\n${cut.tail}`;

  const elapsed = Math.max(0, Math.round((job.finishedAt - job.startedAt) / 1000));
  const outcome = job.timedOut
    ? `timed out after ${job.timeoutMs}ms`
    : `exit ${exitCode ?? 'null (killed by signal)'}${
        job.sweptBy === 'exit' ? ' · stopped by process exit' : ''
      }`;
  const head = [
    `[runtime] bash job ${job.id} finished — ${outcome} · ${elapsed}s`,
    `${ASYNC_NOTICE_DETAIL_MARK}cmd: ${oneLineText(job.command)}`,
    `${ASYNC_NOTICE_DETAIL_MARK}cwd: ${job.cwd}`,
    `${ASYNC_NOTICE_DETAIL_MARK}log: ${saved ?? job.logPath} (stdout ${Buffer.byteLength(stdout)} B · stderr ${Buffer.byteLength(stderr)} B${truncated ? ` · output over ${MAX_PERSIST_BYTES} B was dropped` : ''})`,
    `${ASYNC_NOTICE_DETAIL_MARK}output (head/tail; the log path has all of it):`,
  ].join('\n');

  // 出口闸：与其它工具结果同一个（≤ 16k token；超了先落盘再头 30% / 尾 70% 裁切）。
  // 通知是一次投递的纯文本（不是某次工具调用的返回值），所以只取裁好的 content，
  // 不登记幂等回执 —— 它不会经过 loop 的闸。
  job.notice = (
    await boundToolResult(`${head}\n${preview}`, {
      persist: async () => saved ?? job.logPath,
    })
  ).content;

  // 二选一：装了唤醒出口就试它一次（成功 = 自己起一轮 run，hook 永不再注入这份通知）。
  // 失败不标记，hook 仍会兜底 —— 宁可晚到，不可不到，也不可送两遍。
  await deliverAsyncNotice(job, job.notice, exitCode, saved ?? job.logPath);

  // q-async-bash-viz：时间线事实 bash.job.completed/failed（WebUI 徽标解除 / 作业卡态迁）。
  const failed = job.timedOut || job.sweptBy !== undefined || (exitCode !== null && exitCode !== 0);
  emitBashJobFact(job, failed ? 'bash.job.failed' : 'bash.job.completed', {
    status: failed ? 'failed' : 'done',
    exit_code: exitCode,
    timed_out: job.timedOut,
    elapsed_ms: job.finishedAt - job.startedAt,
    log_path: saved ?? job.logPath,
    ended_at: job.finishedAt,
  });

  // 输出缓冲释放：完成态只留元数据与通知文本（否则一条 16 MiB 的输出会被一直攥着）
  job.sinks.stdout.chunks.length = 0;
  job.sinks.stderr.chunks.length = 0;
  pruneAsyncJobs();
}

/**
 * 取走本会话「已完成、还没注入」的通知（取走即标记已注入，保证只注入一次）。
 *
 * 返回的是收口时就算好的**纯文本**：hook 只负责挂消息，不重新读输出、不重新走闸 ——
 * 一条通知的预算在收口那一刻就定了，注入路径上不做第二次裁切（两处裁切必然漂）。
 */
function takeAsyncNotices(sessionId: string | undefined): string[] {
  const texts: string[] = [];
  for (const job of completedAsyncJobs(sessionId)) {
    // 不变式：一次注入条数 = 生效并发上限（排空速率 ≥ 到达速率，见常量段注释）
    if (texts.length >= asyncLimits.maxAsyncJobs) break;
    if (job.notice === undefined) continue;
    job.announced = true;
    texts.push(job.notice);
  }
  if (texts.length > 0) pruneAsyncJobs();
  return texts;
}

/**
 * 完成通知的**第二条出口**：装配层的唤醒投递（0.55，可选）。
 *
 * 为什么需要第二条：BeforeLlm hook 只能在该会话**下一次模型请求前**注入通知。回合先结束、
 * 之后没人再说话时，那份结果就永远送不到 —— 而那正是异步最该覆盖的场景（长作业 + 回合早退）。
 * 装配层（`src/bash-job-delivery.ts`）手里有 `AgentService`，可以把同一份通知当一条消息投进
 * 会话并**自己起一轮 run**（与 ask 的异步答复同一条准入链）。
 *
 * 判据（二选一，绝不两个都送）：收口那一刻看有没有装出口 ——
 * - 装了且投递返回 true → 立即标 `announced`，hook 永不再注入；
 * - 装了但返回 false → **不**标记，hook 仍然兜底（结果不丢，只是退回「等下一次 run」）；
 * - 没装 → 纯 hook（今天的默认形态：CLI / TUI / 嵌入方都能跑，不依赖装配层）。
 *
 * 槽是**进程级单槽**（只留最后一次注册）：一个进程只该有一条唤醒通道，两个出口同时生效
 * 必然送两遍。返回值是注销函数，方便宿主收口。
 */
export interface AsyncBashCompletion {
  jobId: string;
  sessionId: string;
  /** 已过出口闸的通知正文（元数据 + 头尾预览 ≤1200 token + 日志路径），全文不在里面 */
  content: string;
  exitCode: number | null;
  timedOut: boolean;
  elapsedMs: number;
  logPath: string;
}

export type AsyncBashCompletionSink = (completion: AsyncBashCompletion) => Promise<boolean>;

/**
 * 出口槽挂在 `globalThis` 上，不挂在模块变量上 —— 真机踩到过：
 *
 * 插件的**模块实例**和装配层 `import` 的那个实例不一定是同一个（插件按目录/自身根两条
 * 路径解析时会出现两份）。挂在模块变量上的话，装配层注册的出口会被写进"另一份"，而
 * 真正跑作业的那份永远看不到它 —— 表现是「一声不响地不投递」，比报错难查得多。
 * 进程级 single slot + `Symbol.for` 让两份实例看到同一个槽。
 */
const ASYNC_SINK_SLOT = Symbol.for('vessel.basic-tools.async-bash-completion-sink');

function asyncSinkSlot(): { sink?: AsyncBashCompletionSink } {
  const host = globalThis as unknown as Record<symbol, { sink?: AsyncBashCompletionSink }>;
  const existing = host[ASYNC_SINK_SLOT];
  if (existing !== undefined) return existing;
  const created: { sink?: AsyncBashCompletionSink } = {};
  host[ASYNC_SINK_SLOT] = created;
  return created;
}

/** 注册唤醒投递出口（进程级单槽，最后一次注册生效）。 */
export function registerAsyncBashCompletionSink(sink: AsyncBashCompletionSink): () => void {
  asyncSinkSlot().sink = sink;
  return () => {
    const slot = asyncSinkSlot();
    if (slot.sink === sink) slot.sink = undefined;
  };
}

// ── q-async-bash-viz：起作业通知 + 注册表快照 + 时间线事实 ──────────────
//
// 复用 inbox 的占位回调卡：起作业时装配层往 inbox 插一条 running 占位（科技蓝、不可消费、
// 沉底），完成时**按 jobId 原位更新同一条目**（done/failed + 填结果）。起作业通知与完成
// 通知共用 jobId 键。完成路由本就进 inbox（admit origin bash_job），改动只是匹配占位槽
// 原位填充而非新插一条 —— 单一真相源，杜绝双份。

/** 起一条作业时通知装配层的元数据（与完成通知共用 jobId 键）。 */
export interface AsyncBashJobStart {
  jobId: string;
  sessionId: string;
  runId?: string;
  command: string;
  pid?: number;
  startedAt: number;
  logPath: string;
}

export type AsyncBashStartSink = (start: AsyncBashJobStart) => void | Promise<void>;

/** 起作业出口槽：与完成槽同一先例（进程级单槽 + Symbol.for，跨模块实例共享）。 */
const ASYNC_START_SINK_SLOT = Symbol.for('vessel.basic-tools.async-bash-start-sink');

function asyncStartSinkSlot(): { sink?: AsyncBashStartSink } {
  const host = globalThis as unknown as Record<symbol, { sink?: AsyncBashStartSink }>;
  const existing = host[ASYNC_START_SINK_SLOT];
  if (existing !== undefined) return existing;
  const created: { sink?: AsyncBashStartSink } = {};
  host[ASYNC_START_SINK_SLOT] = created;
  return created;
}

/** 注册起作业通知出口（进程级单槽，最后一次注册生效）；返回注销函数。 */
export function registerAsyncBashStartSink(sink: AsyncBashStartSink): () => void {
  asyncStartSinkSlot().sink = sink;
  return () => {
    const slot = asyncStartSinkSlot();
    if (slot.sink === sink) slot.sink = undefined;
  };
}

/** 起作业通知（fire-and-forget）：没装出口 / 无会话 = 不插占位；异常只记日志，不影响作业。 */
function notifyAsyncBashStarted(job: AsyncBashJob): void {
  const sink = asyncStartSinkSlot().sink;
  if (sink === undefined || job.sessionId === undefined) return;
  const start: AsyncBashJobStart = {
    jobId: job.id,
    sessionId: job.sessionId,
    command: oneLineText(job.command),
    startedAt: job.startedAt,
    logPath: job.logPath,
    ...(job.runId !== undefined ? { runId: job.runId } : {}),
    ...(job.pid !== undefined ? { pid: job.pid } : {}),
  };
  try {
    const result = sink(start);
    if (result instanceof Promise) result.catch(() => {});
  } catch {
    // 占位插入失败不影响作业本身（完成时 updateBashJob 找不到占位会退回旧投递路径）。
  }
}

/**
 * 发一条 bash 作业时间线事实（bash.job.started/completed/failed）。经 ctx.emitFact 快照
 * （EU.publishEvent → journal → 时间线双写）：run 已结束也能发（transient journal）。
 * 缺省（旧装配未注入 emitFact）= 不发，零回归。异常只记日志，不影响作业收口。
 */
function emitBashJobFact(job: AsyncBashJob, type: string, data: Record<string, unknown>): void {
  const emit = job.emitFact;
  if (emit === undefined) return;
  try {
    emit({
      type,
      run_id: job.runId ?? 'plugin',
      data: {
        job_id: job.id,
        session_id: job.sessionId,
        run_id: job.runId,
        ...data,
      },
      ts: Date.now(),
    });
  } catch (error) {
    jobLog.debug('basic_tools.bash_job.fact_failed', {
      job_id: job.id,
      type,
      error: String(error),
    });
  }
}

/** 注册表快照的一条作业元数据（会话绑定；RPC jobs.list / WebUI 徽标用）。 */
export interface AsyncBashJobSnapshot {
  jobId: string;
  sessionId?: string;
  runId?: string;
  command: string;
  pid?: number;
  status: 'running' | 'done' | 'failed';
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  logPath: string;
  timedOut: boolean;
  detached: boolean;
}

/**
 * 会话绑定的作业注册表快照（只读）：活跃 + 近期 job。`sessionId` 缺省 = 全部会话。
 *
 * 注册表唯一真相源就是进程级 `asyncJobs`（每条带 sessionId）—— 不另存第二份嵌套 Map
 * （两份必漂）；会话绑定经 job.sessionId 过滤体现。status 由收口态派生：未收口 = running；
 * 收口后 exitCode≠0 / timedOut / sweptBy = failed，否则 done。
 */
export function listAsyncBashJobs(sessionId?: string): AsyncBashJobSnapshot[] {
  const out: AsyncBashJobSnapshot[] = [];
  for (const job of asyncJobs.values()) {
    if (sessionId !== undefined && job.sessionId !== sessionId) continue;
    const finished = job.notice !== undefined;
    const failed =
      finished &&
      (job.timedOut ||
        job.sweptBy !== undefined ||
        (job.exitCode !== undefined && job.exitCode !== null && job.exitCode !== 0));
    out.push({
      jobId: job.id,
      command: oneLineText(job.command),
      status: !finished ? 'running' : failed ? 'failed' : 'done',
      startedAt: job.startedAt,
      logPath: job.logPath,
      timedOut: job.timedOut,
      detached: job.detached === true,
      ...(job.sessionId !== undefined ? { sessionId: job.sessionId } : {}),
      ...(job.runId !== undefined ? { runId: job.runId } : {}),
      ...(job.pid !== undefined ? { pid: job.pid } : {}),
      ...(job.finishedAt !== undefined ? { endedAt: job.finishedAt } : {}),
      ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
    });
  }
  return out.sort((left, right) => right.startedAt - left.startedAt);
}

/**
 * 读一条作业日志的尾部（q-async-bash-viz：inbox 作业卡的 log tail 按钮）。
 *
 * 只对在跑 / 近期还在注册表里的作业有效（jobId → logPath）；已被 prune 的旧作业返回 null
 * （其完整结果已在 inbox 条目正文里，log tail 主要服务在跑作业的实时输出）。读最后
 * `maxBytes` 字节（缺省 8 KiB），按 UTF-8 解码（可能截断多字节字符，尾部预览可接受）。
 */
export function readAsyncBashJobLogTail(jobId: string, maxBytes = 8192): string | null {
  const job = asyncJobs.get(jobId) ?? detachedAsyncProcs.get(jobId);
  if (job === undefined) return null;
  try {
    const size = statSync(job.logPath).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return '';
    const fd = openSync(job.logPath, 'r');
    try {
      const buf = Buffer.alloc(length);
      readSync(fd, buf, 0, length, start);
      return buf.toString('utf-8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * 完成通知的 BeforeLlm hook：把已完成作业的通知作为一条 `vessel:notice` 尾消息挂到本次请求上
 * （`role: 'user'` + `name: 'vessel:notice'`，与 runtime-notice / doc-subscription 同一条通道）。
 *
 * 为什么不用 `HookResult.additionalContext`：那条路已废弃（会破坏 system 前缀稳定性），
 * 现有三个通知 hook 全部写 `ctx.messages`，这里跟随。
 */
export function createAsyncBashNoticeHook(): Hook {
  return {
    name: ASYNC_BASH_NOTICE_HOOK,
    type: HookType.BeforeLlm,
    // 排在 doc-subscription（150）之后：命令完成是「刚发生的事实」，晚一点挂上去更靠近本轮请求
    priority: 160,
    run: async (ctx: HookContext): Promise<void> => {
      const texts = takeAsyncNotices(ctx.session_id);
      if (texts.length === 0) return;
      ctx.messages = [
        ...(ctx.messages ?? []),
        {
          role: 'user',
          name: ASYNC_NOTICE_MESSAGE_NAME,
          content: texts.join('\n'),
          timestamp: Date.now(),
        },
      ];
    },
  };
}

// ── 写协调表面记录（lock / conflict） ────────────────────────────────
//
// 注入粒度框架 M3：写锁争用 / expected_content 并发冲突这两类「写协调事实」除了照旧折进
// 工具错误文本，还额外记一条表面条目，在下一次 LLM 请求前以 `vessel:notice` 环境卡注入
// （与 async bash / doc-subscription 同一条通道）。**工具失败语义不变**：记录点仍返回原
// 错误文本，卡是 additive 表面（今天这两类事实没有卡 ⇒ 非回归）。
//
// scope 词与明细标记是跨包契约的字面量副本（插件不 import agent）：必须与
// `packages/agent/src/env-info-scope.ts` 的 ENV_INFO_SCOPES / ENV_INFO_DETAIL_MARK 逐字相同，
// Web 的 `env-notice.ts` 按行首 token 认 scope、按行首标记认明细行。改任一侧人工核对另一侧。

/** 环境信息 scope 词：工作区写锁争用 / 超时 / 不可用 */
const WRITE_LOCK_SCOPE = 'lock';

/** 环境信息 scope 词：expected_content 并发修改冲突 */
const WRITE_CONFLICT_SCOPE = 'conflict';

/** 明细行标记：两个空格 + `·`（与 agent ENV_INFO_DETAIL_MARK 逐字同） */
const ENV_DETAIL_MARK = '  · ';

/** 写协调通知的 hook 注册名（幂等注册用，口径同 ASYNC_BASH_NOTICE_HOOK） */
export const WRITE_COORD_NOTICE_HOOK = 'write-coord-notice';

/** 一张卡最多带几条明细（与 agent ENV_INFO_DETAILS_MAX 同）；超出折 `+N more` */
const WRITE_COORD_DETAILS_MAX = 10;

/** 未注入条目的保留时长（ASYNC_RECORD_TTL_MS 同口径）：会话不再跑时事实仍在工具结果里，丢内存副本不算丢事实 */
const COORD_RECORD_TTL_MS = 60 * 60_000;

/** 已注入条目每会话只留最近这么多条（MAX_ASYNC_RECORDS 同口径）——它们是签名去重记忆，上限只淘汰已送达的 */
const MAX_COORD_RECORDS = 16;

/** lock 卡摘要（统一字面量；具体锁路径 / 错误进明细行） */
const WRITE_LOCK_SUMMARY = 'write lock contention or lock unavailable; write not performed';

/** conflict 卡摘要（统一字面量；具体路径 / 字节数进明细行） */
const WRITE_CONFLICT_SUMMARY =
  'concurrent modification conflict; write not performed (expected_content mismatch)';

/** 一条待注入的写协调事实 */
interface PendingCoordNotice {
  scope: typeof WRITE_LOCK_SCOPE | typeof WRITE_CONFLICT_SCOPE;
  summary: string;
  details: string[];
  /** 去重签名（同签名只注入一次） */
  signature: string;
  ts: number;
  /** 已注入过；announced 条目留在缓冲里作签名去重记忆，受 MAX_COORD_RECORDS 裁剪 */
  announced?: boolean;
}

/**
 * 待注入条目的唯一持有者：**进程级**（asyncJobs 同理）——热应用用旁路 host 反复 install，
 * 状态跟安装实例走会让记录落在 hook 永远看不到的表里。键 = session_id ?? '_'。
 */
const pendingCoordNotices = new Map<string, PendingCoordNotice[]>();

function coordSessionKey(sessionId: string | undefined): string {
  return sessionId ?? '_';
}

/**
 * 裁剪（pruneAsyncJobs 同形，两条常量上界）：
 * 1) 未注入条目超过 COORD_RECORD_TTL_MS 过期；
 * 2) 已注入（announced）条目每会话只留最近 MAX_COORD_RECORDS 条。
 * 未注入条目不受 MAX 裁剪 —— 「事实还没送到模型」不因保留上限而丢。
 */
function pruneCoordNotices(): void {
  const now = Date.now();
  for (const [key, entries] of pendingCoordNotices) {
    const announced = entries.filter((entry) => entry.announced === true);
    let droppedOldest: Set<PendingCoordNotice> | undefined;
    const excess = announced.length - MAX_COORD_RECORDS;
    if (excess > 0) {
      announced.sort((left, right) => left.ts - right.ts);
      droppedOldest = new Set(announced.slice(0, excess));
    }
    const kept = entries.filter((entry) => {
      if (droppedOldest?.has(entry) === true) return false;
      if (entry.announced === true) return true;
      return now - entry.ts <= COORD_RECORD_TTL_MS;
    });
    if (kept.length === 0) pendingCoordNotices.delete(key);
    else if (kept.length !== entries.length) pendingCoordNotices.set(key, kept);
  }
}

/** 记一条写协调事实（工具失败点调用；不改工具返回值）。 */
function recordCoordNotice(
  sessionId: string | undefined,
  entry: Pick<PendingCoordNotice, 'scope' | 'summary' | 'details' | 'signature'>,
): void {
  const key = coordSessionKey(sessionId);
  const entries = pendingCoordNotices.get(key) ?? [];
  entries.push({ ...entry, ts: Date.now() });
  pendingCoordNotices.set(key, entries);
  pruneCoordNotices();
}

/** 一张卡的草稿（drain 时按 scope 聚合；每 scope 一条消息，混 scope 不合并） */
interface CoordCardDraft {
  summary: string;
  details: string[];
  events: number;
}

/**
 * 排空本会话待注入条目：**按条目 scope 的 cadence 过滤**（cadence 缺省 request）——
 * `cadence==='run' && requestIndex>0` 的条目跳过、留在缓冲（下个 run 首请求再 drain），
 * 其余 drain。gate 在 drain 而不是记录点：记录是工具侧事实，节奏只决定何时上表面，不丢事实。
 *
 * 签名去重：同签名只注入一次（announced 标记；缓冲里的 announced 条目是去重记忆）。
 * 返回的每张卡是一个 scope 的完整正文（formatEnvInfo 形状字面量拼）。
 */
function takeWriteCoordNotices(
  sessionId: string | undefined,
  granularity: Record<string, EnvCadence> | undefined,
  requestIndex: number,
): { scope: string; content: string }[] {
  const entries = pendingCoordNotices.get(coordSessionKey(sessionId));
  if (entries === undefined || entries.length === 0) return [];
  const announcedSignatures = new Set<string>();
  for (const entry of entries) {
    if (entry.announced === true) announcedSignatures.add(entry.signature);
  }
  const byScope = new Map<string, CoordCardDraft>();
  for (const entry of entries) {
    if (entry.announced === true) continue;
    const cadence = granularity?.[entry.scope] ?? 'request';
    if (cadence === 'run' && requestIndex > 0) continue;
    entry.announced = true;
    // off（P2 轴 A）：整段静默——消费掉（announced）但不产卡、不注入。
    if (cadence === 'off') continue;
    if (announcedSignatures.has(entry.signature)) continue;
    announcedSignatures.add(entry.signature);
    const draft = byScope.get(entry.scope) ?? { summary: entry.summary, details: [], events: 0 };
    draft.details.push(...entry.details);
    draft.events += 1;
    byScope.set(entry.scope, draft);
  }
  const cards: { scope: string; content: string }[] = [];
  for (const [scope, draft] of byScope) {
    // 首行 `scope: 摘要`（多事件带计数），明细行 `  · `；明细超预算折 `+N more`。
    const head =
      draft.events > 1
        ? `${scope}: ${draft.summary} (${draft.events} events)`
        : `${scope}: ${draft.summary}`;
    const kept = draft.details.slice(0, WRITE_COORD_DETAILS_MAX);
    const dropped = draft.details.length - kept.length;
    const lines = kept.map((detail) => `${ENV_DETAIL_MARK}${detail}`);
    if (dropped > 0) lines.push(`${ENV_DETAIL_MARK}+${dropped} more`);
    cards.push({ scope, content: [head, ...lines].join('\n') });
  }
  pruneCoordNotices();
  return cards;
}

/**
 * 写协调通知的 BeforeLlm hook：把 lock / conflict 表面记录作为 `vessel:notice` 环境卡
 * 追加到本次请求（每 scope 一条消息）。**每请求都跑**，cadence 过滤在 drain 内按条目
 * scope 生效（lock / conflict 可各配不同节奏，整 hook 早退会吞掉另一 scope 的卡）。
 * priority 165：排在 async bash（160）之后 —— 写协调是更近的工具侧事实，更靠近本轮请求。
 */
export function createWriteCoordNoticeHook(
  granularity?: Record<string, EnvCadence>,
  channels?: Record<string, EnvChannel>,
): Hook {
  return {
    name: WRITE_COORD_NOTICE_HOOK,
    type: HookType.BeforeLlm,
    priority: 165,
    run: async (ctx: HookContext): Promise<void> => {
      const cards = takeWriteCoordNotices(ctx.session_id, granularity, ctx.request_index ?? 0);
      if (cards.length === 0) return;
      const timestamp = Date.now();
      const injected: Message[] = [];
      for (const card of cards) {
        // P2 轴 C：ui-only ⇒ 只落 UI 卡事实（message.injected），不写 ctx.messages。
        // 缺省 emitFact（旧 core / 裸宿主）⇒ 回退注入（model+ui 现状，additive）。
        if (channels?.[card.scope] === 'ui-only' && ctx.emitFact !== undefined) {
          ctx.emitFact({
            type: 'message.injected',
            run_id: ctx.run_id,
            data: {
              run_id: ctx.run_id,
              session_id: ctx.session_id,
              message: {
                role: 'user',
                name: ASYNC_NOTICE_MESSAGE_NAME,
                content: card.content,
                timestamp,
                message_id: `${ctx.run_id}:notice:${String(timestamp)}:${card.scope}`,
              },
            },
            ts: timestamp,
          });
          continue;
        }
        injected.push({
          role: 'user',
          name: ASYNC_NOTICE_MESSAGE_NAME,
          content: card.content,
          timestamp,
        });
      }
      if (injected.length > 0) ctx.messages = [...(ctx.messages ?? []), ...injected];
    },
  };
}

/** 执行 bash 命令；超时/取消返回错误文本，不抛异常 */
async function runBash(
  args: unknown,
  ctx: ToolContext,
  boundary: PathBoundary,
  baseCwd: BaseCwd,
): Promise<string> {
  if (!isRecord(args)) return '错误：bash 需要 { command: string }';
  const command = readString(args, 'command');
  // 纯空白命令是无意义的一次调用，直接挡掉（否则白烧一轮）
  if (command.trim() === '') return '错误：command 不能为空';

  // 防御性检查：即使调用方绕过 checkPermission，命令文本命中 denylist 也不执行
  const deniedEntry = findDeniedPathInCommand(command, boundary.commandPatterns);
  if (deniedEntry !== undefined) return deniedCommandMessage(deniedEntry);

  const cwd = readString(args, 'cwd');
  if (cwd !== '' && !existsSync(cwd)) return `错误：cwd 不存在：${cwd}`;
  // 显式 cwd 优先；未传时落调用期默认目录（配置 cwd > 成员 cwd > 进程 cwd）
  const effectiveCwd = cwd === '' ? baseCwd.path : cwd;
  // 防御性检查：即使调用方绕过 checkPermission 直接调 handler，
  // 敏感路径的 cwd 仍然拒绝；allowed_roots 的越界由 checkPermission 走 ask。
  if (evaluatePath(effectiveCwd, boundary) === 'deny') {
    return `错误：cwd 在敏感路径拒绝列表中：${effectiveCwd}`;
  }
  if (cwd === '' && baseCwd.issue !== undefined) return baseCwd.issue;

  // async 缺省读生效 limits（0 = 不限时，用户裁定#8）；sync 仍 120s 交互短超时。
  const timeoutMs =
    readNumber(args, 'timeout_ms') ??
    (args.async === true ? asyncLimits.asyncTimeoutMs : DEFAULT_BASH_TIMEOUT_MS);
  if (args.async === true ? timeoutMs < 0 : timeoutMs <= 0) {
    return '错误：timeout_ms 必须为正数（async 可为 0 = 不限时）';
  }

  // 写文件警告：只算一次（纯文本判定），命中的话在后面**每个返回点**末尾追加同一行。
  // 放在校验之后：被拒绝的命令根本没执行，不该再提「写完要复核」。
  const writeWarning = bashWriteWarning(command);

  const signal = ctx.signal;
  if (signal?.aborted) return CANCELLED_TEXT;

  // 异步（0.55，显式 opt-in）：起进程就返回，结果稍后经 BeforeLlm hook 注入本会话下一轮。
  // 校验（deny 命令文本 / cwd 边界 / 缺省 cwd 的配置错误）已在上面全部做完，
  // 所以异步路径与同步路径**同一套拒绝口径**，不会出现「换个参数就能绕过」。
  if (args.async === true) {
    return startAsyncBash({ command, cwd: effectiveCwd, timeoutMs, ctx });
  }

  let proc: ReturnType<typeof spawnBash>;
  try {
    proc = spawnBash(command, effectiveCwd, { env: runIdentityEnv(ctx) });
  } catch (error) {
    return `错误：无法启动 bash：${String(error)}`;
  }

  // 先挂上读取再等退出，否则大输出会把子进程写管道堵死
  const stdoutSink = createSink();
  const stderrSink = createSink();
  const stdoutPump = pumpStream(proc.stdout, stdoutSink);
  const stderrPump = pumpStream(proc.stderr, stderrSink);

  let timedOut = false;
  let cancelled = false;
  const onAbort = (): void => {
    if (cancelled) return;
    cancelled = true;
    killProcessTree(proc);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  // addEventListener 不会补发已发生的 abort
  if (signal?.aborted) onAbort();

  const timer = setTimeout(() => {
    timedOut = true;
    killProcessTree(proc);
  }, timeoutMs);

  try {
    await proc.exited;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  await waitAtMost(Promise.all([stdoutPump.done, stderrPump.done]), DRAIN_GRACE_MS);
  // 孙进程可能仍握着管道写端：主动放弃剩余读取，别让一次超时把整轮对话挂死
  stdoutPump.cancel();
  stderrPump.cancel();

  const stdout = stdoutSink.chunks.join('');
  const stderr = stderrSink.chunks.join('');
  const stdoutPreview = toPreview(stdout);
  const stderrPreview = toPreview(stderr);
  const overLines =
    splitLines(stdout).length > MAX_OUTPUT_LINES || splitLines(stderr).length > MAX_OUTPUT_LINES;
  const overBytes = stdoutPreview.truncated || stderrPreview.truncated;

  // 落盘按**需要**发生，且只写一次：token 闸与行 / 字节闸共用同一次写入（否则一次调用落两份盘）。
  let savedOnce: Promise<string | undefined> | undefined;
  const persistRaw = (): Promise<string | undefined> => {
    savedOnce ??= persistBashOutput({
      command,
      exitCode: proc.exitCode,
      cancelled,
      timedOut,
      stdout,
      stderr,
      truncated: stdoutSink.truncated || stderrSink.truncated,
      ...(ctx.session_id !== undefined ? { sessionId: ctx.session_id } : {}),
    });
    return savedOnce;
  };

  // ── 三层闸，顺序：token → 行 → 字节 ──────────────────
  //
  // 第一道（token）必须量**没被任何闸动过**的原文：先砍到 2 MiB 再取尾，会把「真正的结尾」
  // （错误信息、失败原因所在）丢掉。代价是这条路径要拼一次全文，峰值内存 ≈ 2 ×
  // MAX_PERSIST_BYTES（stdout/stderr 各 16 MiB + 拼出来的字符串），仍是显式上界。
  const full = formatBashResult({
    exitCode: proc.exitCode,
    stdout,
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut,
    timeoutMs,
    cancelled,
    lineGate: false,
  });
  // 预算内时 boundToolResult 原样返回同一个字符串（不做任何拷贝/裁剪）：`bounded` 为假
  // 就继续走下面的行 / 字节闸，与 0.55 之前逐字节一致。
  const budgeted = await boundToolResult(full, { persist: persistRaw });
  if (budgeted.bounded) {
    // 幂等回执：bash 自己裁过了，loop 别再裁第二遍（否则省略标注行会被裁掉）。
    markToolResultBounded(ctx, budgeted.originalChars);
    return appendWriteWarning(budgeted.content, writeWarning);
  }

  // 第二 / 三道闸（行数 2000 / 字节 2 MiB）：语义与 0.4 起一致，作为兜底保留。
  // 按上面的顺序，它们实际只在「行很多但每行极短」的输出上生效（token 闸都放行了，
  // 字节闸必然放行）；留着是为了守住旧行为，也让将来放宽 token 预算时仍有防线。
  const formatted = formatBashResult({
    exitCode: proc.exitCode,
    stdout: stdoutPreview.text,
    stderr: stderrPreview.text,
    stdoutTruncated: stdoutPreview.truncated || stdoutSink.truncated,
    stderrTruncated: stderrPreview.truncated || stderrSink.truncated,
    timedOut,
    timeoutMs,
    cancelled,
    lineGate: true,
  });
  const shouldPersist = overLines || overBytes || stdoutSink.truncated || stderrSink.truncated;
  if (!shouldPersist) return appendWriteWarning(formatted, writeWarning);
  const saved = await persistRaw();
  return appendWriteWarning(
    saved !== undefined
      ? `${formatted}\n完整输出已写入：${saved}（${Buffer.byteLength(stdout) + Buffer.byteLength(stderr)} 字节）`
      : `${formatted}\n完整输出落盘失败（预览已截断）。`,
    writeWarning,
  );
}

/** 构造 bash 工具（路径边界随配置固定；默认工作目录按调用期解析） */
function createBashTool(boundary: PathBoundary, config: BasicToolsConfig): ToolDefinition {
  return {
    name: 'bash',
    description:
      'Run a shell command in bash and return merged stdout/stderr with the exit code. ' +
      'Use it for shell-level work only: git, builds, tests, HTTP requests, process management, ' +
      'and finding/listing files. Do NOT use it to read file contents: use the `read` tool ' +
      'instead of cat/sed/head/tail/awk. Do NOT use it to write file contents (heredocs, ' +
      'redirection, sed -i, tee): use `write` to create/append/replace a whole file and `edit` ' +
      'for a partial change — shell expansion silently mangles backticks and $(...). ' +
      'Commands that spell out built-in or configured sensitive paths (~/.ssh, ~/.aws, ' +
      '~/.gnupg, ~/.vessel/config.yaml and extra deny_paths) are rejected. That check matches ' +
      'the command text only; it is best-effort, not a sandbox. ' +
      'For commands that take longer than about thirty seconds (builds, installs, ' +
      '`git worktree add`), pass async: true: the call returns immediately with a job id and a ' +
      'log path, this turn keeps going, and when the command finishes a runtime message with ' +
      'the exit code, head/tail of the output and the log path is injected into your next ' +
      'request in the same session. Default (no async) is synchronous: the call waits for the ' +
      'command and returns its output, exactly as before.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to run' },
        cwd: {
          type: 'string',
          description: 'Working directory (default: agent cwd, else member cwd, else process cwd)',
        },
        timeout_ms: {
          type: 'number',
          description:
            `Timeout in milliseconds (default ${DEFAULT_BASH_TIMEOUT_MS} when synchronous). ` +
            'When async the default is NO timeout (0 = unlimited): long-running commands ' +
            '(e.g. a gateway) are not killed. A positive value sets a deadline; on timeout the ' +
            'process is left running by default (kill_on_timeout=false) and output keeps ' +
            'appending to the log. Configurable via basic-tools async_timeout_ms / kill_on_timeout.',
        },
        async: {
          type: 'boolean',
          description:
            'Default false = wait for the command and return its output here. true = start it in the background and return at once with a job id and a log path; the result (exit code, head/tail of the output, log path) arrives later as a runtime message before your next model call in this session. No timeout by default — safe for long-running commands. Use it only for long commands — do not poll, and do not start the same command twice.',
        },
      },
      required: ['command'],
    },
    checkPermission: async (input, ctx) => {
      if (isRecord(input)) {
        // 命令文本命中内置 denylist：与敏感 cwd 一样直接 deny，不走用户 ask
        if (
          findDeniedPathInCommand(readString(input, 'command'), boundary.commandPatterns) !==
          undefined
        ) {
          return 'deny';
        }
        const cwd = readString(input, 'cwd');
        // 显式 cwd 优先；未传时按调用期默认目录做边界判定
        // （默认目录只是起点，不放宽 denylist / allowed_roots）
        const defaultCwd = resolveCallCwd(config, ctx.cwd).path;
        const decision = evaluatePath(cwd === '' ? defaultCwd : cwd, boundary);
        // deny 直接拒绝；配置 allowed_roots 的越界走 ask（由运行时向用户确认）
        if (decision !== 'allow') return decision;
      }
      // 统一由 core PermissionPolicy 发一次请求；autoApprove / neverAutoApprove / always 在那里生效
      return 'ask';
    },
    handler: async (args, ctx) =>
      runBash(args, ctx, activeBoundary(boundary), resolveCallCwd(config, ctx.cwd)),
  };
}

// ── read ─────────────────────────────────────────

/** 读出带行号的文本片段（行号从 1 开始，`<行号>\t<内容>`） */
function readFileSlice(
  args: unknown,
  ctx: ToolContext,
  boundary: PathBoundary,
  config: BasicToolsConfig,
): string {
  const signal = ctx.signal;
  if (signal?.aborted) return CANCELLED_TEXT;
  if (!isRecord(args)) return '错误：read 需要 { path: string }';
  const inputPath = readString(args, 'path');
  if (inputPath === '') return '错误：path 不能为空';
  const baseCwd = resolveCallCwd(config, ctx.cwd);
  const absolute = resolveToolPath(baseCwd.path, inputPath);
  // 防御性检查：即使调用方绕过 checkPermission，也绝不读取敏感路径。
  // 相对路径先按 baseCwd 解析，边界按解析后的绝对路径判定（不因 baseCwd 放宽）。
  if (evaluatePath(absolute, boundary) === 'deny') {
    return PATH_DENIED_TEXT;
  }
  if (dependsOnBaseCwd(inputPath) && baseCwd.issue !== undefined) return baseCwd.issue;

  if (!existsSync(absolute)) return `错误：文件不存在：${inputPath}`;

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(absolute);
  } catch (error) {
    return `错误：无法访问 ${inputPath}：${String(error)}`;
  }
  if (stat.isDirectory()) return `错误：${inputPath} 是目录，不是文件（用 bash 列出目录）`;
  if (!stat.isFile()) return `错误：${inputPath} 不是普通文件`;
  if (stat.size > MAX_READ_BYTES) {
    return `错误：文件过大（${stat.size} 字节，上限 ${MAX_READ_BYTES} 字节）。请用 bash 分块读取（如 sed -n '1,2000p'）。`;
  }

  let text: string;
  try {
    text = readFileSync(absolute, 'utf-8');
  } catch (error) {
    return `错误：读取失败：${String(error)}`;
  }
  if (text.includes('\0')) {
    return `错误：${inputPath} 看起来是二进制文件（含 NUL 字节），read 只处理文本。`;
  }

  const lines = splitLines(text);
  const total = lines.length;
  if (total === 0) return `（空文件：${inputPath}）`;

  const offset = readNumber(args, 'offset') ?? 1;
  if (!Number.isInteger(offset) || offset < 1) {
    return '错误：offset 必须是不小于 1 的整数（行号从 1 开始）';
  }
  if (offset > total) {
    return `错误：offset（${offset}）超过文件总行数（${total}）`;
  }

  const limit = readNumber(args, 'limit') ?? DEFAULT_READ_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    return '错误：limit 必须是不小于 1 的整数';
  }

  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const numbered = slice.map((line, index) => `${offset + index}\t${line}`).join('\n');
  const lastLine = offset - 1 + slice.length;

  if (lastLine < total) {
    return `${numbered}\n\n已截断，共 ${total} 行，用 offset/limit 继续读（本次已读第 ${offset}-${lastLine} 行）`;
  }
  return numbered;
}

/** 构造 read 工具（路径边界随配置固定；默认工作目录按调用期解析） */
function createReadTool(boundary: PathBoundary, config: BasicToolsConfig): ToolDefinition {
  return {
    name: 'read',
    description:
      'Read a text file and return its content with line numbers (1-based, `<line>\\t<content>`). ' +
      `Use offset/limit to page through large files (limit defaults to ${DEFAULT_READ_LIMIT} lines). ` +
      'Prefer this tool over bash commands such as cat/sed/head/tail/awk for reading file contents. ' +
      'The line ranges you read are auto-subscribed for change notices; subscribe:false opts out.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        offset: { type: 'number', description: 'First line to read (1-based, default 1)' },
        limit: {
          type: 'number',
          description: `How many lines to read (default ${DEFAULT_READ_LIMIT})`,
        },
        subscribe: {
          type: 'boolean',
          description:
            'Auto-subscribe the line ranges you read for change notices (default true). Set false ' +
            'for a one-off look to save tokens; you will not be notified if others change those lines.',
        },
      },
      required: ['path'],
    },
    // 只读操作无副作用；敏感路径 deny、配置 allowed_roots 后越界 ask
    concurrencySafe: true,
    checkPermission: async (input, ctx) => {
      if (!isRecord(input)) return 'allow';
      const inputPath = readString(input, 'path');
      if (inputPath === '') return 'allow';
      // 与 handler 同一条解析路径：相对路径按调用期默认目录，再按绝对路径判定边界
      return evaluatePath(
        resolveToolPath(resolveCallCwd(config, ctx.cwd).path, inputPath),
        boundary,
      );
    },
    // 出口闸（token 预算）：2000 行 × 每行几千字符的文件同样能一次灌满窗口，
    // 所以 read 也必须过同一个 boundToolResult，而不是只靠「文件 ≤ 8 MiB」这一道闸。
    handler: async (args, ctx) =>
      boundToolOutput(ctx, 'read', readFileSlice(args, ctx, activeBoundary(boundary), config)),
  };
}

// ── edit ─────────────────────────────────────────

/**
 * 原子写：先写同目录临时文件再 rename，避免写一半崩溃把原文件截断。
 * 失败时清理临时文件并把错误留给调用方格式化。
 */
function writeFileAtomic(absolutePath: string, content: string): void {
  const tempPath = `${absolutePath}.vessel-tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tempPath, content, 'utf-8');
    renameSync(tempPath, absolutePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // 临时文件可能未创建，忽略
    }
    throw error;
  }
}

/** 精确且唯一匹配的字符串替换；多处替换必须显式 replace_all */
function editFile(
  args: unknown,
  ctx: ToolContext,
  boundary: PathBoundary,
  config: BasicToolsConfig,
): string {
  const signal = ctx.signal;
  if (signal?.aborted) return CANCELLED_TEXT;
  if (!isRecord(args)) return '错误：edit 需要 { path, old_string, new_string }';
  const inputPath = readString(args, 'path');
  const oldString = readString(args, 'old_string');
  const newString = readString(args, 'new_string');
  if (inputPath === '') return '错误：path 不能为空';
  if (oldString === '') return '错误：old_string 不能为空';

  const baseCwd = resolveCallCwd(config, ctx.cwd);
  const absolute = resolveToolPath(baseCwd.path, inputPath);
  // 防御性检查：与 read 同一条边界；绕过 checkPermission 也不得改敏感路径
  if (evaluatePath(absolute, boundary) === 'deny') {
    return PATH_DENIED_TEXT;
  }
  if (dependsOnBaseCwd(inputPath) && baseCwd.issue !== undefined) return baseCwd.issue;
  if (!existsSync(absolute)) return `错误：文件不存在：${inputPath}`;

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(absolute);
  } catch (error) {
    return `错误：无法访问 ${inputPath}：${String(error)}`;
  }
  if (stat.isDirectory()) return `错误：${inputPath} 是目录，不是文件`;
  if (!stat.isFile()) return `错误：${inputPath} 不是普通文件`;

  let original: string;
  try {
    original = readFileSync(absolute, 'utf-8');
  } catch (error) {
    return `错误：读取失败：${String(error)}`;
  }

  const count = countOccurrences(original, oldString);
  if (count === 0) {
    const crlfHint =
      original.includes('\r\n') && oldString.includes('\n') && !oldString.includes('\r\n')
        ? ' 该文件使用 CRLF 换行：old_string 里的换行需要写成 \\r\\n，或先用 bash 归一换行。'
        : '';
    return `错误：未找到匹配（匹配 0 处），未做任何修改。old_string 必须与文件内容逐字符一致（含缩进与换行）。${crlfHint}`;
  }

  const replaceAll = args.replace_all === true;
  if (count > 1 && !replaceAll) {
    return `错误：old_string 匹配到 ${count} 处，不唯一，未做任何修改。请补足上下文使其唯一，或传 replace_all: true 全部替换。`;
  }

  const updated = replaceAll
    ? original.split(oldString).join(newString)
    : replaceFirst(original, oldString, newString);

  // 校验通过后、落盘前再检查一次：取消后不得留下半次修改
  if (signal?.aborted) return CANCELLED_TEXT;

  try {
    writeFileAtomic(absolute, updated);
  } catch (error) {
    return `错误：写入失败：${String(error)}`;
  }

  return `已替换 ${count} 处（${inputPath}）`;
}

/**
 * edit/write 共用：写临界区前持工作区写锁，临界区后释放（蜂群 Phase 1 第三重保险）。
 * action 是同步临界区（读→比对→写），在锁内求值；锁获取/释放是异步边缘，不阻塞事件循环。
 * 锁失败折稳定错误文本（run 继续）；取消优先（与 editFile/writeFileText 内部口径一致）。
 */
async function runWithWriteLock(
  config: BasicToolsConfig,
  ctx: ToolContext,
  tool: string,
  action: () => string,
): Promise<string> {
  const baseCwd = resolveCallCwd(config, ctx.cwd);
  let lock: WriteLock;
  try {
    lock = await acquireWriteLock(baseCwd.path, ctx.signal);
  } catch (error) {
    if (ctx.signal?.aborted) return CANCELLED_TEXT;
    // 表面记录（additive）：锁争用 / 不可用是环境事实，下次请求前注入 lock 卡；
    // 工具失败语义不变，仍返回原错误文本。holder 身份不在 WriteLockError 上，不可得则不写。
    // S14：writeLockPath 含 realpath 归一，可能失败（如目录不存在）——表面记录 best-effort：
    // 失败时记原始 baseCwd（仅诊断）；锁仲裁路径恒走 writeLockPath 单产地，此处不拼第二份字面量。
    let lockPath: string;
    try {
      lockPath = writeLockPath(baseCwd.path);
    } catch {
      lockPath = baseCwd.path;
    }
    const errorClass = error instanceof Error ? error.name : 'Error';
    recordCoordNotice(ctx.session_id, {
      scope: WRITE_LOCK_SCOPE,
      summary: WRITE_LOCK_SUMMARY,
      details: [
        `lock: ${lockPath}`,
        `error: ${errorClass}: ${oneLineText(error instanceof Error ? error.message : String(error))}`,
      ],
      signature: `${WRITE_LOCK_SCOPE}|${lockPath}|${errorClass}`,
    });
    return error instanceof WriteLockError
      ? error.message
      : `错误：写入锁获取失败：${String(error)}`;
  }
  try {
    return await boundToolOutput(ctx, tool, action());
  } finally {
    await lock.release();
  }
}

/** 构造 edit 工具（相对路径按调用期默认目录解析；路径边界与 read 相同） */
function createEditTool(boundary: PathBoundary, config: BasicToolsConfig): ToolDefinition {
  return {
    name: 'edit',
    description:
      'Replace a text snippet in a file. old_string must match the file content exactly and ' +
      'occur exactly once; pass replace_all: true to replace every occurrence.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        old_string: { type: 'string', description: 'Exact text to replace (must be unique)' },
        new_string: { type: 'string', description: 'Replacement text' },
        replace_all: {
          type: 'boolean',
          description: 'Replace every occurrence instead of requiring a unique match',
        },
        subscribe: {
          type: 'boolean',
          description:
            'Auto-subscribe this file for change notices (default true). Set false when confident ' +
            'the edit is final and you want to save tokens; you will not be notified if others change it.',
        },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    checkPermission: async (input, ctx) => {
      if (isRecord(input)) {
        const inputPath = readString(input, 'path');
        if (inputPath !== '') {
          // deny 直接拒绝；allowed_roots 越界返回 ask，由运行时确认
          const decision = evaluatePath(
            resolveToolPath(resolveCallCwd(config, ctx.cwd).path, inputPath),
            boundary,
          );
          if (decision !== 'allow') return decision;
        }
      }
      // 统一由 core PermissionPolicy 发一次请求；autoApprove / neverAutoApprove / always 在那里生效
      return 'ask';
    },
    handler: async (args, ctx) =>
      runWithWriteLock(config, ctx, 'edit', () =>
        editFile(args, ctx, activeBoundary(boundary), config),
      ),
  };
}

// ── write ────────────────────────────────────────
//
// 存在理由：`edit` 只能替换**已有文件里的精确文本**，所以「建文件 / 追加」只能走
// `bash` 的 heredoc / 重定向 —— 而那条路内容要过一遍 shell + 沙箱预处理，反引号 / `$(`
// / `${…}` 会被先展开，写坏了 bash 退出码照样 0（0.56 真机事故：写架构文档时整段代码块
// 静默消失）。`write` 把 content 当**数据**收：不经过 shell、不做任何转义或展开，
// 落盘字节 = 入参字节。
//
// 契约（宁可不便利，不许静默）：
// - `create`（缺省）：文件已存在则**报错**，不静默覆盖 —— 覆盖是破坏性操作，
//   必须由调用方显式说 `overwrite`。
// - `overwrite`：整体替换；目标不存在时等价于建文件（语义是「把这个路径的内容变成这段」，
//   不把「文件本来不存在」当成错误，但会在回执里说清）。
// - `append`：追加到末尾；目标不存在时创建（与 `>>` 一致）。
// - 父目录：**只自动创建一级**不存在的父目录。更深的不猜 —— 猜错目录是「写到一个
//   你以为不存在的地方」这类事故的源头，模型该自己先说清路径（`mkdir` 在 bash 里）。
// - 上限 4 MiB（`MAX_WRITE_BYTES`），超了报错并给字节数，不截断。
//
// 原子性：create / overwrite 先写**同目录**临时文件 + fsync，再落位（同目录是为了 rename
// 不会跨设备）。create 落位用 `link` 而不是 `rename`：rename 会静默覆盖，link 在目标已存在时
// 报 EEXIST —— 这样「检查已存在」和「落盘」之间没有 TOCTOU 窗口。append 走 `O_APPEND` + fsync。

/** write 的三种模式 */
type WriteMode = 'create' | 'overwrite' | 'append';

/** 千分位格式化（只用于回执 / 报错里的读数，不用 locale，保证确定性） */
function groupThousands(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 按 `splitLines` 同一口径数行数（末尾换行不额外算一行） */
function countTextLines(text: string): number {
  return splitLines(text).length;
}

/** errno 码判定（`code` 是 Node 错误对象上的稳定字段） */
function isErrnoCode(error: unknown, code: string): boolean {
  return isRecord(error) && (error as { code?: unknown }).code === code;
}

/** 不支持硬链接的 errno（create 的排他落盘在这些盘上退回 rename） */
const LINK_UNSUPPORTED_CODES = new Set([
  'ENOSYS',
  'EPERM',
  'EOPNOTSUPP',
  'ENOTSUP',
  'EXDEV',
  'EMLINK',
]);

/** 同目录临时文件路径（create / overwrite 共用；pid + 时间戳 + 随机段，避免并发撞名） */
function tempPathFor(absolutePath: string): string {
  const nonce = randomUUID().slice(0, 8);
  return `${absolutePath}.vessel-tmp-${process.pid}-${Date.now()}-${nonce}`;
}

/**
 * 原子整体写（overwrite 用）：临时文件 → fsync → rename。
 * fsync 在 rename **之前**：否则崩溃可能留下「名字对了、内容是空的」文件。
 */
function writeFileAtomicDurable(absolutePath: string, content: string, mode?: number): void {
  const tempPath = tempPathFor(absolutePath);
  try {
    const fd = openSync(tempPath, 'w');
    try {
      writeFileSync(fd, content, 'utf-8');
      // 覆盖时沿用原文件的权限位：临时文件的默认 0644 会把可执行脚本 / 0600 的密钥文件降级，
      // 而「内容对了、权限变了」这种副作用同样不会被任何工具报出来。
      if (mode !== undefined) fchmodSync(fd, mode);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tempPath, absolutePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // 临时文件可能未创建，忽略
    }
    throw error;
  }
}

/**
 * 排他落盘（create 用）：临时文件 → fsync → link。
 * link 在目标已存在时抛 EEXIST，不会像 rename 那样静默覆盖 —— 这是「create 绝不覆盖」的
 * 最后一道保证（前面的 existsSync 只用于给出更好的报错文案）。
 *
 * 回退：极少数文件系统不支持硬链接（exFAT / 部分网络盘）。那时退回「二次确认不存在 + rename」，
 * 与前面的 existsSync 检查之间留一个极窄的窗口 —— 但在不支持硬链接的盘上，「工具直接坏掉」
 * 是更糟的结果，而且窗口只在多人同时写同一路径时才可能被踩到。
 */
function createFileExclusiveDurable(absolutePath: string, content: string): void {
  const tempPath = tempPathFor(absolutePath);
  try {
    const fd = openSync(tempPath, 'w');
    try {
      writeFileSync(fd, content, 'utf-8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(tempPath, absolutePath);
    } catch (error) {
      if (!LINK_UNSUPPORTED_CODES.has(String((error as { code?: unknown }).code))) throw error;
      if (existsSync(absolutePath)) {
        const conflict = new Error(`文件已存在：${absolutePath}`) as NodeJS.ErrnoException;
        conflict.code = 'EEXIST';
        throw conflict;
      }
      renameSync(tempPath, absolutePath);
    }
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {
      // 未创建 / 已清理，忽略
    }
  }
}

/** 追加（append 用）：O_APPEND 一次写入并 fsync */
function appendToFileDurable(absolutePath: string, content: string): void {
  const fd = openSync(absolutePath, 'a');
  try {
    writeFileSync(fd, content, 'utf-8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** 流式扫一遍文件的行数 / 字节数（append 的「共 N 行」读数用；不整读进内存） */
function scanFileStats(absolutePath: string): { lines: number; bytes: number } | undefined {
  // 先看体积：超过扫描上限就干脆不数（见 `MAX_LINE_SCAN_BYTES`），别让一次 append 顺带读 GB 级文件
  try {
    if (Number(statSync(absolutePath).size) > MAX_LINE_SCAN_BYTES) return undefined;
  } catch {
    return undefined;
  }
  let fd: number | undefined;
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let newlines = 0;
  let bytes = 0;
  let lastByte = -1;
  try {
    fd = openSync(absolutePath, 'r');
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read <= 0) break;
      for (let i = 0; i < read; i += 1) {
        if (chunk[i] === 0x0a) newlines += 1;
      }
      lastByte = chunk[read - 1] ?? lastByte;
      bytes += read;
    }
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (bytes === 0) return { lines: 0, bytes: 0 };
  return { lines: lastByte === 0x0a ? newlines : newlines + 1, bytes };
}

/** 文件最后一个字节（判断追加是否接在「没有换行的最后一行」后面；空文件返回 undefined） */
function lastByteOf(absolutePath: string): number | undefined {
  let fd: number | undefined;
  try {
    const size = statSync(absolutePath).size;
    if (size === 0) return undefined;
    fd = openSync(absolutePath, 'r');
    const one = Buffer.allocUnsafe(1);
    const read = readSync(fd, one, 0, 1, size - 1);
    return read === 1 ? one[0] : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** create 撞已有文件时的报错：说清三条出路，别让模型猜 */
function existingFileMessage(inputPath: string): string {
  return (
    `错误：文件已存在：${inputPath}（未做任何改动）。` +
    '要整体替换用 mode=overwrite；要局部修改用 edit（逐字符唯一匹配，找不到会报错）；' +
    '要追加用 mode=append。'
  );
}

/** 单次内容超过上限的报错（不截断、不静默写半截） */
function tooLargeMessage(bytes: number): string {
  return (
    `错误：内容过大（${groupThousands(bytes)} 字节，单次上限 ${groupThousands(MAX_WRITE_BYTES)} 字节 = 4 MiB），未写入。` +
    '请拆成多次 write（create + append），或改用 bash 搬运大文件。'
  );
}

/**
 * 建文件 / 整体替换 / 追加。
 * 路径解析与边界判定与 read / edit **同一条实现**（`resolveToolPath` + `evaluatePath`），
 * 所以 deny_paths / 内置 denylist / symlink 逃逸 / 成员 cwd 的语义与它们逐条一致。
 */
function writeFileText(
  args: unknown,
  ctx: ToolContext,
  boundary: PathBoundary,
  config: BasicToolsConfig,
): string {
  const signal = ctx.signal;
  if (signal?.aborted) return CANCELLED_TEXT;
  if (!isRecord(args)) return '错误：write 需要 { path, content, mode? }';
  const inputPath = readString(args, 'path');
  if (inputPath === '') return '错误：path 不能为空';
  // content 用 typeof 判而不是 readString：空字符串是合法内容（建空文件），不能和「没传」混淆
  if (typeof args.content !== 'string') {
    return '错误：content 必须是字符串（UTF-8 文本）；要建空文件请显式传 content: ""';
  }
  const content = args.content;

  const rawMode = args.mode;
  let mode: WriteMode;
  if (rawMode === undefined || rawMode === 'create') mode = 'create';
  else if (rawMode === 'overwrite' || rawMode === 'append') mode = rawMode;
  else {
    return `错误：mode 只能是 create / overwrite / append（收到 ${JSON.stringify(rawMode)}）；缺省是 create。`;
  }

  const bytes = Buffer.byteLength(content, 'utf-8');
  if (bytes > MAX_WRITE_BYTES) return tooLargeMessage(bytes);

  const baseCwd = resolveCallCwd(config, ctx.cwd);
  const absolute = resolveToolPath(baseCwd.path, inputPath);
  // 防御性检查：与 read / edit 同一条边界；绕过 checkPermission 也不得写敏感路径。
  // symlink 逃逸同样在这里被拦：evaluatePath 按 canonicalPath（realpath）判定。
  if (evaluatePath(absolute, boundary) === 'deny') return PATH_DENIED_TEXT;
  if (dependsOnBaseCwd(inputPath) && baseCwd.issue !== undefined) return baseCwd.issue;

  // 目标现状：只区分「不存在 / 普通文件 / 别的」。硬链接与符号链接的**指向**已由边界判定处理。
  let existing: ReturnType<typeof statSync> | undefined;
  if (existsSync(absolute)) {
    try {
      existing = statSync(absolute);
    } catch (error) {
      return `错误：无法访问 ${inputPath}：${String(error)}`;
    }
    if (existing.isDirectory()) return `错误：${inputPath} 是目录，不是文件`;
    if (!existing.isFile()) return `错误：${inputPath} 不是普通文件`;
  }

  if (mode === 'create' && existing !== undefined) return existingFileMessage(inputPath);

  // 父目录：只自动建一级（见本节顶部注释）。目标已存在时父目录必然存在，跳过。
  let createdDir = false;
  if (existing === undefined) {
    const parent = path.dirname(absolute);
    if (!isDirectory(parent)) {
      if (existsSync(parent)) {
        return `错误：${path.dirname(inputPath)} 已存在但不是目录，无法在其下建文件。`;
      }
      if (!isDirectory(path.dirname(parent))) {
        return (
          `错误：父目录不存在：${path.dirname(inputPath)}（write 只自动创建**一级**不存在的父目录，` +
          '更深的路径请先用 bash 进入目标目录再写，或先 mkdir 建好）。'
        );
      }
      try {
        mkdirSync(parent);
        createdDir = true;
      } catch (error) {
        return `错误：创建父目录失败：${String(error)}`;
      }
    }
  }

  // 落盘前再查一次取消：不允许「取消后留下半次写入」
  if (signal?.aborted) return CANCELLED_TEXT;

  const dirNote = createdDir ? ` · 新建父目录 ${path.dirname(inputPath)}` : '';

  // 落盘目标：目标已存在时按 realpath 写**指到的那个文件**（符号链接不被替换成普通文件）。
  // 边界判定用的也是 canonicalPath，所以在「链接指向 deny 目录」这种情况下早就在上面被拒了；
  // 这里只解决「链接指向允许目录」时的写入语义，与 bash 的 `>` 一致。
  const writeTarget = existing === undefined ? absolute : canonicalPath(absolute);

  // expected_content（可选，仅 overwrite；蜂群 Phase 1 第一重保险）：临界区内逐字节比对，
  // 不符 → 稳定错误不写，逼重读（防 L-010 类陈旧 read 后 overwrite 静默抹除）。
  // 不传 = 今天行为零回归。比对在写锁临界区内完成（handler 层持锁，见 runWithWriteLock）。
  if (mode === 'overwrite' && args.expected_content !== undefined) {
    if (typeof args.expected_content !== 'string') {
      return '错误：expected_content 必须是字符串（UTF-8 文本，你最近一次读到的当前全文）。';
    }
    let current: Buffer;
    try {
      current = existing === undefined ? Buffer.alloc(0) : readFileSync(writeTarget);
    } catch (error) {
      return `错误：读取当前内容失败（expected_content 比对）：${String(error)}`;
    }
    if (!current.equals(Buffer.from(args.expected_content, 'utf-8'))) {
      const currentLines = countTextLines(current.toString('utf-8'));
      // 表面记录（additive）：并发修改冲突是环境事实，下次请求前注入 conflict 卡；
      // 工具失败语义不变，仍返回原错误文本。签名按绝对路径（同一文件的不同拼写去重）。
      recordCoordNotice(ctx.session_id, {
        scope: WRITE_CONFLICT_SCOPE,
        summary: WRITE_CONFLICT_SUMMARY,
        details: [
          `path: ${inputPath}`,
          `current: ${groupThousands(current.byteLength)} bytes / ${groupThousands(currentLines)} lines`,
        ],
        signature: `${WRITE_CONFLICT_SCOPE}|${absolute}`,
      });
      return (
        `错误：expected_content 与当前文件内容不符，未写入（当前 ${groupThousands(current.byteLength)} 字节 / ` +
        `${groupThousands(currentLines)} 行）。文件在你读取后已被改动：请用 read 重读最新内容，` +
        '更新 expected_content 后重试，或改用 edit 做局部修改。'
      );
    }
  }

  if (mode === 'append') {
    // 追加前记一下原文件末尾：没有换行的文件直接追加会把内容接到最后一行后面，值得说一句
    const previousSize = existing === undefined ? 0 : Number(existing.size);
    const tailByte =
      existing === undefined || previousSize === 0 ? undefined : lastByteOf(writeTarget);
    try {
      appendToFileDurable(writeTarget, content);
    } catch (error) {
      return `错误：写入失败：${String(error)}`;
    }
    const stats = scanFileStats(writeTarget);
    const totalBytes = stats === undefined ? previousSize + bytes : stats.bytes;
    const totalLinesPart = stats === undefined ? '' : ` · 共 ${groupThousands(stats.lines)} 行`;
    // 原文件末尾没有换行时，追加的第一行会**接到最后一行后面**（净增行数比 content 行数少 1）。
    // 不替调用方补换行（content 必须逐字节落盘），但把这件事和真实净增行数说清楚。
    const merged = tailByte !== undefined && tailByte !== 0x0a && content !== '';
    const contentLines = countTextLines(content);
    const addedLines = merged ? Math.max(0, contentLines - 1) : contentLines;
    const mergeNote = merged ? '（原文件末尾没有换行，追加内容接在最后一行之后）' : '';
    const createdNote = existing === undefined ? ' · 文件原先不存在，已创建' : '';
    return (
      `已追加 ${inputPath}（append · +${groupThousands(addedLines)} 行${totalLinesPart} · ` +
      `${groupThousands(totalBytes)} 字节${createdNote}${dirNote}）${mergeNote}`
    );
  }

  try {
    if (mode === 'create') createFileExclusiveDurable(absolute, content);
    else
      writeFileAtomicDurable(
        writeTarget,
        content,
        existing === undefined ? undefined : Number(existing.mode) & 0o7777,
      );
  } catch (error) {
    // 并发下 existsSync 可能漏判（另一进程刚好建成）：link 的 EEXIST 是准确答案
    if (isErrnoCode(error, 'EEXIST')) return existingFileMessage(inputPath);
    return `错误：写入失败：${String(error)}`;
  }

  const lines = countTextLines(content);
  if (mode === 'overwrite' && existing !== undefined) {
    // statSync 的 size 在 bigint 模式下是 bigint；这里统一按 number 展示（回执只用于读数）
    const previousBytes = Number(existing.size);
    return `已写入 ${inputPath}（overwrite · ${groupThousands(lines)} 行 · ${groupThousands(bytes)} 字节 · 原 ${groupThousands(previousBytes)} 字节${dirNote}）`;
  }
  const createdNote = mode === 'overwrite' ? ' · 文件原先不存在，已创建' : '';
  return `已写入 ${inputPath}（${mode} · ${groupThousands(lines)} 行 · ${groupThousands(bytes)} 字节${createdNote}${dirNote}）`;
}

/** 构造 write 工具（相对路径按调用期默认目录解析；路径边界与 read / edit 相同） */
function createWriteTool(boundary: PathBoundary, config: BasicToolsConfig): ToolDefinition {
  return {
    name: 'write',
    description:
      'Write a whole file: create, replace entirely, or append. Use this — not bash heredocs / ' +
      'redirection — whenever the content is text you already have: it is stored byte-for-byte ' +
      '(no shell expansion, so backticks, $(...), ' +
      // `\${...}` 是字面量（说给模型看的 shell 展开写法），不是插值
      `\${...} and quotes are safe). ` +
      'mode=create (default) creates a new file and ERRORS if the path already exists (never a ' +
      'silent overwrite); mode=overwrite replaces the whole file; mode=append adds to the end. ' +
      'For a partial change inside an existing file use `edit` instead (exact, unique match; it ' +
      'fails loudly when the text does not match). Only ONE missing parent directory is created ' +
      'automatically. Max content 4 MiB per call. Returns line/byte counts. ' +
      'Good design saves retries: pass expected_content (the exact current content you last read) ' +
      'with mode=overwrite so a concurrent change is caught before you clobber it. ' +
      'edit/write auto-subscribe the touched file for change notices; subscribe:false opts out.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        content: {
          type: 'string',
          description: 'UTF-8 text written verbatim (no escaping, no shell expansion)',
        },
        mode: {
          type: 'string',
          enum: ['create', 'overwrite', 'append'],
          description:
            'create (default; error if the file exists) | overwrite (replace whole content) | ' +
            'append (add at the end)',
        },
        expected_content: {
          type: 'string',
          description:
            'Optional, mode=overwrite only: the exact current content you last read. The write is ' +
            'rejected (nothing written) if the file bytes differ — detects concurrent changes instead ' +
            'of silently clobbering them. Omit for legacy behavior.',
        },
        subscribe: {
          type: 'boolean',
          description:
            'Auto-subscribe this file for change notices (default true). Set false when confident ' +
            'the write is final and you want to save tokens.',
        },
      },
      required: ['path', 'content'],
    },
    // 写有副作用，与 bash / edit 同口径：默认 ask，由 core PermissionPolicy 统一定夺；
    // deny 直接拒绝，allowed_roots 越界返回 ask（与 read / edit 完全同一条解析路径）。
    checkPermission: async (input, ctx) => {
      if (isRecord(input)) {
        const inputPath = readString(input, 'path');
        if (inputPath !== '') {
          const decision = evaluatePath(
            resolveToolPath(resolveCallCwd(config, ctx.cwd).path, inputPath),
            boundary,
          );
          if (decision !== 'allow') return decision;
        }
      }
      return 'ask';
    },
    handler: async (args, ctx) =>
      runWithWriteLock(config, ctx, 'write', () =>
        writeFileText(args, ctx, activeBoundary(boundary), config),
      ),
  };
}

// ── 插件导出 ──────────────────────────────────────

/**
 * 创建四个基础工具。
 * 不传配置时只启用内置 denylist（不限制根）、默认工作目录按调用期解析，与旧行为兼容。
 *
 * 0.51：三个工具都**不再**在 install 期固定工作目录 —— 那是全 tenant 一份的常量，
 * 成员 cwd 无处可传（Bug 1）。默认目录在每次 handler / checkPermission 调用时由
 * `resolveCallCwd` 算出（配置 cwd > `ctx.cwd` > 进程 cwd）。
 *
 * 0.56 加入 `write`：它和 read / edit 共用同一个 `boundary`，所以路径语义（deny_paths /
 * 内置 denylist / allowed_roots / symlink）四件工具是同一套，不新增第二份实现。
 */
export function createBasicTools(config: BasicToolsConfig = {}): ToolDefinition[] {
  const boundary = buildPathBoundary(config);
  return [
    createBashTool(boundary, config),
    createReadTool(boundary, config),
    createEditTool(boundary, config),
    createWriteTool(boundary, config),
  ];
}

/**
 * basic-tools 插件——唯一工具包，install 时把四个工具注册进 PluginHost。
 *
 * 0.55：install 还要注册 BeforeLlm hook（异步 bash 的完成通知；M3 起又加写协调 lock/conflict
 * 通知）。按名字幂等：热应用的旁路 host 会为算目标工具集反复 install 同一个插件，重复注册
 * 会让同一条通知被注入两次。
 */
export const basicToolsPlugin: Plugin = {
  name: 'basic-tools',
  version: '0.1.0',
  description: 'bash / read / edit / write — the minimal tool set everything else composes from',
  install(host: PluginHost, options?: { config?: Record<string, unknown> }) {
    const config = parseBasicToolsConfig(options?.config);
    // 异步预算进程级生效（与作业表同口径）：热应用重装即更新，下一条作业用新值；
    // 已在跑的作业保持起作业时的快照（killOnTimeout / timeoutMs），不中途变语义。
    asyncLimits = {
      asyncTimeoutMs: config.asyncTimeoutMs ?? DEFAULT_ASYNC_BASH_TIMEOUT_MS,
      killOnTimeout: config.killOnTimeout ?? false,
      maxAsyncJobs: config.maxAsyncJobs ?? DEFAULT_MAX_ASYNC_JOBS,
    };
    for (const tool of createBasicTools(config)) {
      host.registerTool(tool);
    }
    // 幂等注册：同一个 host 上只留一个（`RUNTIME_NOTICE_HOOK` / `REFS_NOTICE_HOOK` 同口径）
    if (!host.getHooks().some((hook) => hook.name === ASYNC_BASH_NOTICE_HOOK)) {
      host.registerHook(createAsyncBashNoticeHook());
    }
    // 写协调通知（lock/conflict）：cadence 从 install config 的 envGranularity 读，
    // 缺省不注入 ⇒ producer 用内置字面量默认（request）。
    if (!host.getHooks().some((hook) => hook.name === WRITE_COORD_NOTICE_HOOK)) {
      host.registerHook(createWriteCoordNoticeHook(config.envGranularity, config.envChannels));
    }
  },
  /**
   * 刻意**不**在这里杀在跑作业。
   *
   * 真机教训（0.55）：宿主会为每一次 body 收口调用插件的 `dispose()`（交互式 REPL 里跑完一轮
   * 就会发生），而作业表是**进程级**的 —— 在 dispose 里杀，等于「任何一次收口都把别的会话
   * 的长作业杀掉」，实测表现为「起了后台作业，回合结束那一刻它就被杀」。
   * 作业的收口只有两个：自己的超时，和进程退出时的那一次兜底。
   */
  dispose() {
    // 见上：不杀作业，也不清表（进程还活着，别的会话可能还要它）。
  },
};

export default basicToolsPlugin;
