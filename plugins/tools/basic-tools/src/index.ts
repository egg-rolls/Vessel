/**
 * @vessel-agent/basic-tools - 基础工具插件（bash / read / edit）
 * @module @vessel-agent/basic-tools
 *
 * 本项目唯一的工具包，只提供三个互不可替代的工具：
 * - `bash`：执行任意 shell 命令（grep / cat / ls / mkdir / curl …… 全部由它承担），权限 ask
 * - `read`：带行号读文件（支持 offset/limit），权限 allow
 * - `edit`：精确且唯一匹配的字符串替换，权限 ask
 *
 * 危险操作（bash / edit）经 `checkPermission` 返回 `ask`，由 core `PermissionPolicy`
 * 统一发出一次权限请求并等待用户授权（ADR-029 / ADR-079）。
 * `read` / `edit` / `bash` 额外受路径边界约束（0.8 E1）：内置敏感路径 denylist 直接拒绝；
 * 可选 `allowed_roots` 把越界访问降级为 ask。`..` 与符号链接按真实路径判定。
 * `bash` 另在命令文本里匹配内置 denylist 与配置 `deny_paths`（0.14.2 F2 / 0.15）：命中即拒绝。
 * 这不是沙箱——只做字符串/规范化路径匹配，变量拼接、`cd`、符号链接等仍可能绕过。
 * 可选 `cwd`（0.11.1）提供默认工作目录：`bash` 未显式传 `cwd` 时使用它，
 * `read` / `edit` 的相对路径按它解析；边界仍按解析后的绝对路径判定。
 *
 * 输出预算（0.55 / 0.56 闸上移）：任一工具的结果回给模型之前都过**同一个** token 闸
 * （core 的 `boundToolResult`：单条 ≤ 16k token，超了先落盘全文再按头 30% / 尾 70% + 一行
 * 省略标注裁切）。闸本体在 `packages/core/src/runtime/tool-result-gate.ts`，由 loop 一处
 * 收口 —— 所以 web_fetch / MCP / 未来插件的返回值也在闸内。本模块保留**第二道闸**：
 * bash / read / edit 自己先裁一遍并登记幂等回执（`markToolResultBounded`），loop 见到
 * `bounded` 就不再裁（再裁一次会把「完整输出：<路径>」那一行裁掉）。
 * 2000 行 / 2 MiB 两道旧闸保留作兜底，顺序是 token → 行 / 字节。
 * 事故校准：1,344 行 / 423 KB（≈106k token）的输出两道旧闸都没碰到，所以闸必须按 token 计。
 *
 * 异步（0.55）：`bash` 多一个 `async?: boolean`。缺省（不传）= 同步，行为与 0.54 逐字节相同；
 * `true` = 发起就返回，命令结束时把「退出码 + 头尾输出 + 落盘路径」以一条 `vessel:notice`
 * 尾消息注入该会话的下一次模型请求（复用 runtime notice 那条既有通道，不新造 RPC）。
 * 为什么不单开一个 `bash_async` 工具名：bash 的权限判定（deny 命令文本 / cwd 边界 / ask）、
 * 输出闸、落盘目录都必须与同步路径**同一份实现**，同名同参最不容易漂成两套。
 */

import { randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  Hook,
  HookContext,
  Plugin,
  PluginHost,
  ToolContext,
  ToolDefinition,
} from '@vessel-agent/core';
import {
  boundToolResult,
  cutToTokenBudget,
  HookType,
  markToolResultBounded,
  omitMarker,
  safeSegment,
  toolOutputRoot,
  writeToolOutput,
} from '@vessel-agent/core';

// ── 常量 ──────────────────────────────────────────

/** bash 缺省超时（毫秒） */
const DEFAULT_BASH_TIMEOUT_MS = 120_000;

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

/** read 缺省读取行数 */
const DEFAULT_READ_LIMIT = 2000;

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
 * 异步作业的缺省超时（毫秒）：30 分钟。
 *
 * 为什么不是同步的 120s：异步存在的理由就是「这条命令要跑半分钟以上」（用户举例
 * `git worktree add` 实测 30–90s，还有超 120s 的），拿 120s 当缺省等于照样杀。30 分钟是
 * 一次交互式等编译 / 等安装的合理上界；要更久就显式传 `timeout_ms`。
 */
const DEFAULT_ASYNC_BASH_TIMEOUT_MS = 30 * 60_000;

/**
 * 同时在跑的后台作业上限。
 * 内存上界 = 4 ×（16 MiB stdout + 16 MiB stderr）= 128 MiB（两个方向各自受
 * `MAX_PERSIST_BYTES` 封顶）；超了显式拒绝，不排队、不静默顶掉别人。
 */
const MAX_ASYNC_JOBS = 4;

/**
 * 已完成作业的记录保留上限（只留元数据与收口后的通知文本，输出缓冲已释放）。
 * 未注入的记录不会被这条裁掉（`pruneAsyncJobs` 先注入、后清理的语义也靠它），
 * 所以「结果还没送到模型」永远不会因为保留上限而丢；上限只淘汰已送达的旧记录。
 */
const MAX_ASYNC_RECORDS = 16;

/** 一次注入最多带几条完成通知 —— **必须等于 `MAX_ASYNC_JOBS`**。
 *
 * 这是个不变式，不是巧合：开始作业只发生在模型调工具时，注入只发生在模型请求前，
 * 两次相邻的模型请求之间最多有 `MAX_ASYNC_JOBS` 条作业可能完成。让「排空速率 ≥ 到达速率」，
 * 未注入的通知集合就永远 ≤ 4 条（不需要靠淘汰去兜底，也就不会为了腾地方丢结果）。
 * 代价是最坏一条尾消息约 4 × 1300 ≈ 5.2k token —— 一次性、有上界，且只有四条同时收尾时才会发生。
 */
const MAX_ASYNC_NOTICES_PER_INJECTION = MAX_ASYNC_JOBS;

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

/** 把 YAML 里的插件配置解析成已知字段（未知键忽略） */
export function parseBasicToolsConfig(value: unknown): BasicToolsConfig {
  if (!isRecord(value)) return {};
  const allowedRoots = readStringArray(value, 'allowedRoots', 'allowed_roots');
  const denyPaths = readStringArray(value, 'denyPaths', 'deny_paths');
  const cwd = readStringField(value, 'cwd', 'working_dir');
  return {
    ...(allowedRoots !== undefined ? { allowedRoots } : {}),
    ...(denyPaths !== undefined ? { denyPaths } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
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
interface BaseCwd {
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
function resolveCallCwd(config: BasicToolsConfig, ctxCwd: string | undefined): BaseCwd {
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
  return {
    allowedRoots: (config.allowedRoots ?? []).map((entry) => canonicalPath(expandHome(entry))),
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
 */
function splitLines(text: string): string[] {
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
}

/** 新建输出缓冲 */
function createSink(): OutputSink {
  return { chunks: [], bytes: 0, truncated: false };
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
        sink.chunks.push(decoder.decode(chunk.value, { stream: true }));
        sink.bytes += chunk.value.byteLength;
        if (sink.bytes >= MAX_PERSIST_BYTES) sink.truncated = true;
      }
      const tail = decoder.decode();
      if (tail && sink.bytes < MAX_PERSIST_BYTES) sink.chunks.push(tail);
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
}): string {
  return [
    `# command: ${payload.command}`,
    `# exit_code: ${payload.exitCode ?? 'null'}`,
    `# cancelled: ${payload.cancelled}`,
    `# timed_out: ${payload.timedOut}`,
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
}): string {
  const parts: string[] = [];
  if (result.cancelled) {
    parts.push(CANCELLED_TEXT);
  } else if (result.timedOut) {
    parts.push(`错误：命令执行超时（已超过 ${result.timeoutMs}ms），进程已被终止。`);
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

/** 启动 `bash -c`；返回类型交给 Bun.spawn 推导（手写 Subprocess 泛型参数极易踩错） */
function spawnBash(command: string, cwd: string | undefined, options?: { ignoreStdin?: boolean }) {
  return Bun.spawn({
    cmd: ['bash', '-c', command],
    cwd,
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
// 进程生命周期（不留孤儿）：
// - 每个作业有自己的超时（`timeout_ms`，缺省 30 分钟），到点整棵进程树被杀；
// - 插件 dispose（tenant / 会话收口）时杀掉全部在跑作业；
// - 进程退出时（`process.once('exit')`）再兜一次，best-effort；
// - 刻意**不**挂 run 的 AbortSignal：异步作业的全部意义就是活过这次工具调用，跟着 run
//   一起死等于把异步退化成同步。要停它，靠超时或进程退出。

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
  /** 超时被杀（由定时器写，收口时读） */
  timedOut: boolean;
  timer?: ReturnType<typeof setTimeout>;
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

/** 杀掉全部在跑作业（进程退出时收口）。 */
function killLiveAsyncJobs(reason: 'exit'): void {
  for (const job of asyncJobs.values()) {
    if (job.notice !== undefined) continue;
    job.sweptBy ??= reason;
    // 收口留一条 stderr：事后能解释「这条作业为什么没了」
    console.error(`[vessel] basic-tools: stopping bash job ${job.id} (${reason})`);
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
  if (liveAsyncCount() >= MAX_ASYNC_JOBS) {
    return (
      `错误：后台作业已达上限（${MAX_ASYNC_JOBS} 个在跑）。等其中一条结束再发，` +
      '或者去掉 async 用同步方式跑这一条。'
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
    proc = spawnBash(options.command, options.cwd, { ignoreStdin: true });
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
    ...(options.ctx.session_id !== undefined ? { sessionId: options.ctx.session_id } : {}),
  };
  asyncJobs.set(id, job);
  installAsyncExitSweep();
  // 一条起步日志：事后能回答「这条作业当时走的是哪条交付通道」（装配层的唤醒投递
  // 注册在 src/，插件看不到它是否成功；这里只读出口槽本身）。
  console.error(
    `[vessel] basic-tools: bash job ${id} started in background (wake delivery: ${
      asyncSinkSlot().sink === undefined ? 'hook-only' : 'wired'
    })`,
  );

  // 定时器**不** unref：作业在跑的时候我们就要求进程别退出（否则输出会被丢在半路）。
  job.timer = setTimeout(() => {
    job.timedOut = true;
    job.sweptBy ??= 'timeout';
    killProcessTree(proc);
  }, options.timeoutMs);

  // 收口是脱钩的（工具已经返回了）：异常没有收件人，收敛成一条「收集失败」的通知。
  void finalizeAsyncBash(job).catch(() => {
    job.finishedAt = Date.now();
    job.notice = `[runtime] bash job ${id} finished, but its output could not be collected. See ${logPath}.`;
    pruneAsyncJobs();
  });

  return [
    `已启动（异步）：job ${id}`,
    `命令：${oneLineText(options.command, 400)}`,
    `cwd：${options.cwd}`,
    `超时：${options.timeoutMs}ms`,
    `日志：${logPath}（运行中只有一行 started 标记，命令结束后写入完整输出）`,
    '本轮不等待：继续做别的事，不要轮询、不要重复启动同一条命令。',
    '命令结束时会有一条 runtime 消息（退出码 + 头尾输出 + 日志路径）注入你这个会话的下一轮上下文；',
    '若本轮已结束，它在该会话下一次 run 的第一轮到达。中途想看进度就直接 read 上面的日志文件。',
    '注意：本进程退出时仍在跑的后台命令会被一并终止。',
  ].join('\n');
}

/** 作业收口（只跑一次）：等退出 → 排空管道 → 落盘全文 → 收口通知正文。 */
async function finalizeAsyncBash(job: AsyncBashJob): Promise<void> {
  let exitCode: number | null = null;
  try {
    exitCode = await job.proc.exited;
  } catch {
    exitCode = job.proc.exitCode ?? null;
  }
  if (job.timer !== undefined) clearTimeout(job.timer);
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
  const sink = asyncSinkSlot().sink;
  if (sink !== undefined && job.sessionId !== undefined) {
    let delivered = false;
    try {
      delivered = await sink({
        jobId: job.id,
        sessionId: job.sessionId,
        content: job.notice,
        exitCode,
        timedOut: job.timedOut,
        elapsedMs: job.finishedAt - job.startedAt,
        logPath: saved ?? job.logPath,
      });
    } catch {
      delivered = false;
    }
    if (delivered) job.announced = true;
  }

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
    if (texts.length >= MAX_ASYNC_NOTICES_PER_INJECTION) break;
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

  const timeoutMs =
    readNumber(args, 'timeout_ms') ??
    (args.async === true ? DEFAULT_ASYNC_BASH_TIMEOUT_MS : DEFAULT_BASH_TIMEOUT_MS);
  if (timeoutMs <= 0) return '错误：timeout_ms 必须为正数';

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
    proc = spawnBash(command, effectiveCwd);
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
    return budgeted.content;
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
  if (!shouldPersist) return formatted;
  const saved = await persistRaw();
  return saved !== undefined
    ? `${formatted}\n完整输出已写入：${saved}（${Buffer.byteLength(stdout) + Buffer.byteLength(stderr)} 字节）`
    : `${formatted}\n完整输出落盘失败（预览已截断）。`;
}

/** 构造 bash 工具（路径边界随配置固定；默认工作目录按调用期解析） */
function createBashTool(boundary: PathBoundary, config: BasicToolsConfig): ToolDefinition {
  return {
    name: 'bash',
    description:
      'Run a shell command in bash and return merged stdout/stderr with the exit code. ' +
      'Use it for shell-level work only: git, builds, tests, HTTP requests, process management, ' +
      'and finding/listing files. Do NOT use it to read file contents: use the `read` tool ' +
      'instead of cat/sed/head/tail/awk. Do NOT use it to modify files: use the `edit` tool. ' +
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
          description: `Timeout in milliseconds (default ${DEFAULT_BASH_TIMEOUT_MS} when synchronous, ${DEFAULT_ASYNC_BASH_TIMEOUT_MS} when async)`,
        },
        async: {
          type: 'boolean',
          description:
            'Default false = wait for the command and return its output here. true = start it in the background and return at once with a job id and a log path; the result (exit code, head/tail of the output, log path) arrives later as a runtime message before your next model call in this session. Use it only for long commands — do not poll, and do not start the same command twice.',
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
    handler: async (args, ctx) => runBash(args, ctx, boundary, resolveCallCwd(config, ctx.cwd)),
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
      'Prefer this tool over bash commands such as cat/sed/head/tail/awk for reading file contents.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        offset: { type: 'number', description: 'First line to read (1-based, default 1)' },
        limit: {
          type: 'number',
          description: `How many lines to read (default ${DEFAULT_READ_LIMIT})`,
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
      boundToolOutput(ctx, 'read', readFileSlice(args, ctx, boundary, config)),
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
      boundToolOutput(ctx, 'edit', editFile(args, ctx, boundary, config)),
  };
}

// ── 插件导出 ──────────────────────────────────────

/**
 * 创建三个基础工具。
 * 不传配置时只启用内置 denylist（不限制根）、默认工作目录按调用期解析，与旧行为兼容。
 *
 * 0.51：三个工具都**不再**在 install 期固定工作目录 —— 那是全 tenant 一份的常量，
 * 成员 cwd 无处可传（Bug 1）。默认目录在每次 handler / checkPermission 调用时由
 * `resolveCallCwd` 算出（配置 cwd > `ctx.cwd` > 进程 cwd）。
 */
export function createBasicTools(config: BasicToolsConfig = {}): ToolDefinition[] {
  const boundary = buildPathBoundary(config);
  return [
    createBashTool(boundary, config),
    createReadTool(boundary, config),
    createEditTool(boundary, config),
  ];
}

/**
 * basic-tools 插件——唯一工具包，install 时把三个工具注册进 PluginHost。
 *
 * 0.55：install 还要注册**一个** BeforeLlm hook（异步 bash 的完成通知）。按名字幂等：
 * 热应用的旁路 host 会为算目标工具集反复 install 同一个插件，重复注册会让同一条通知被注入两次。
 */
export const basicToolsPlugin: Plugin = {
  name: 'basic-tools',
  version: '0.1.0',
  description: 'bash / read / edit — the minimal tool set everything else composes from',
  install(host: PluginHost, options?: { config?: Record<string, unknown> }) {
    const config = parseBasicToolsConfig(options?.config);
    for (const tool of createBasicTools(config)) {
      host.registerTool(tool);
    }
    // 幂等注册：同一个 host 上只留一个（`RUNTIME_NOTICE_HOOK` / `REFS_NOTICE_HOOK` 同口径）
    if (!host.getHooks().some((hook) => hook.name === ASYNC_BASH_NOTICE_HOOK)) {
      host.registerHook(createAsyncBashNoticeHook());
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
