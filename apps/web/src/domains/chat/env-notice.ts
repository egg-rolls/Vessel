/**
 * 「环境信息」卡的解析与折叠（纯函数，无 React / DOM / store）。
 *
 * 用户裁决（2026-01）：环境信息本身也要以卡片出现，用户才能看到模型真实的上下文
 * 长什么样子。它与「底层系统信息」是**两种显示方式**，不是两套数据：
 * - 卡片 = 本模块解析的 `vessel:notice` 消息（模型上下文里的那一行行文本）；
 * - 底层行 = `runtime.notice` 原始事件（归 `INTERNAL_EVENT_TYPES`，开关打开时才出现）。
 *   两者的身份分别是「消息」与「事件」，各自成 item（消息侧 `notice:<下标>`，
 *   事件侧 `notice:notice-<seq>`），因此既不会互相吞掉，也不会把同一条渲染两遍。
 *
 * 为什么按**文本行**解析，而不是给消息加结构化字段：
 * `vessel:notice` 是契约 §3 的尾部上下文消息（`src/runtime-notice-hook.ts` 用
 * `[runtime] <summary>` 一行一条摘要拼起来，每条通知的 `details` 各占一行、行首标
 * `  · `，失败再加 `(not applied)`），scope 只在文本里，且消息可能一次携带多条通知
 * （总线单轮最多 5 条，总行数还有 `NOTICE_LINES_MAX` 上限）。解析留在 Web 侧，服务端
 * 契约不动；正文字面保留（不剥 scope 前缀）——这张卡的目的就是让用户看到上下文原文。
 * 一张卡的作用域 = **首行**（摘要）的 scope；details 行没有自己的作用域，恒为 `context`，
 * 因此在 `peer` 卡里也只会作为「成员」卡下面的一行行明细出现。
 *
 * 可见性不在这里判：`state/runtime-visibility.ts` 决定 `notice` 种类默认可见，
 * 本模块只负责「解析成卡片内容」与「相邻同 scope 折叠」。卡片的**样子**也不在这里：
 * 渲染在 `EnvCard.tsx`，与「来自 agent X」卡同一张卡（用户裁决：复用 agent 卡的样式与
 * 点击展开机制），scope 只作为卡头标签出现。
 *
 * @module web/chat/env-notice
 */

/**
 * 「环境信息」的作用域词表：与 `RuntimeNoticeScope`（`src/runtime-notice.ts`）同源，
 * 外加 `peer`（成员 / 协作通知，随后端一起到）。scope 只决定卡头标签与折叠分组，
 * 不决定可见性：解析不出 scope 的行落到 `context`（inbox 提示、身份变更提示等无 scope 的上下文）。
 */
export const ENV_NOTICE_SCOPES = [
  'config',
  'permission',
  'tools',
  'mcp',
  'update',
  'peer',
] as const;

export type EnvNoticeScope = (typeof ENV_NOTICE_SCOPES)[number] | 'context';

/** 一条通知（= 上下文里的一行）解析后的形状。 */
export interface EnvNoticeLine {
  /** 卡片内稳定的行身份（React key 用；折叠合并后重编，同一张卡内唯一）。 */
  id: string;
  scope: EnvNoticeScope;
  /** false = 未生效（上下文里带 `(not applied)` 标记） */
  ok: boolean;
  /** 上下文原文（去掉 `[runtime]` / `(not applied)` 这两个线格式标记，其余不动） */
  text: string;
}

/** 一张（可能折叠了多条的）环境信息卡的渲染数据。 */
export interface EnvNoticeCard {
  /** 折叠后的统一 scope（折叠只发生在同 scope 之间）。 */
  scope: EnvNoticeScope;
  /** 所有行都生效才为 true。 */
  ok: boolean;
  /** 卡片的行：首行 = 折叠态摘要，其余进展开区。长度 1..ENV_NOTICE_DETAILS_MAX。 */
  lines: EnvNoticeLine[];
  /** 折叠进来的消息条数（>= 1；> 1 时卡头显示「N 条」）。 */
  count: number;
  /** 因为超过 `ENV_NOTICE_DETAILS_MAX` 而没有渲染的行数（> 0 时卡片末尾提示）。 */
  droppedLines?: number;
}

/**
 * 卡片最多渲染多少行。
 *
 * 11 = **首行摘要 1 + 契约 §3 的 details 上限 10**：一条打满的 peer 通知正好是 11 行
 * （`runtime-notice-hook.ts` 的 `NOTICE_DETAILS_MAX`）。取 10 会把最后一位成员的明细
 * 挤成「还有 1 行未显示」——那不是保护，是把刚补上的信息又藏起来。
 */
export const ENV_NOTICE_DETAILS_MAX = 11;

/** `runtimeMessageKind` 给出的种类；环境信息只看这一个 kind（vessel:notice）。 */
export const ENV_NOTICE_KIND = 'notice';

/** 这个 kind 的消息是不是环境信息（`source` / `subscription` / `limit` 均不是）。 */
export function isEnvNoticeKind(kind: string | undefined): boolean {
  return kind === ENV_NOTICE_KIND;
}

/** `[runtime]` 是 hook 的线格式前缀（模型侧上下文里真的存在，卡片里不重复显示）。 */
const RUNTIME_TAG = /^\[runtime\]\s*/i;
/** 失败标记：`formatNoticeLine` 对 `ok: false` 加的前缀。 */
const NOT_APPLIED = /^\(not applied\)\s*/i;
/**
 * details 行的线格式标记（`runtime-notice-hook.ts` 的 `NOTICE_DETAIL_MARK` = `  · `）。
 *
 * 只剥标记本身：`·` 不是正文，剥掉后展开区每行就是作者写的那句话（列表本身没有
 * 项目符号，留着 `·` 会变成双重符号）。**不参与 scope 判定** —— 一条 detail 的 scope
 * 恒为兜底 `context`，卡头仍取首行 summary 的 scope（`envNoticeCard` 的 `first.scope`）。
 */
const DETAIL_MARK = /^·\s*/;
/** 行首 scope 词：`config:` / `permission: ...` / `update ...`（不剥正文，只取 scope）。 */
const SCOPE_TOKEN = /^(config|permission|tools|mcp|update|peer)\b/i;

/** 一行上下文文本 → 解析结果（空行由调用方跳过）。 */
export function parseEnvNoticeLine(raw: string): EnvNoticeLine | undefined {
  let text = raw.trim();
  if (text.length === 0) return undefined;
  text = text.replace(RUNTIME_TAG, '');
  // details 行（`  · name: completed`）：剥掉线格式标记，正文照原样保留。
  // scope 落到兜底 `context` —— 一条 detail 是首行摘要的解释，没有自己的作用域。
  text = text.replace(DETAIL_MARK, '');
  let ok = true;
  if (NOT_APPLIED.test(text)) {
    ok = false;
    text = text.replace(NOT_APPLIED, '');
  }
  text = text.trim();
  if (text.length === 0) return undefined;
  // id 先给占位值：卡片构建（envNoticeCard / mergeEnvNoticeCards）时按卡内序号重编，
  // 保证折叠后同一张卡里的 id 仍唯一。
  return { id: '', scope: scopeOf(text), ok, text };
}

function scopeOf(text: string): EnvNoticeScope {
  const match = SCOPE_TOKEN.exec(text);
  const token = match?.[1];
  if (token === undefined) return 'context';
  const scope = token.toLowerCase();
  return (ENV_NOTICE_SCOPES as readonly string[]).includes(scope)
    ? (scope as EnvNoticeScope)
    : 'context';
}

/**
 * `vessel:notice` 的正文 → 卡片数据（首行 scope 决定卡头标签与折叠分组）。
 *
 * 一次携带多条通知时按行拆开：摘要用第一行，展开区给**全部**行（首行也在内，因为折叠态的
 * 摘要会被 ellipsis 截断），上限 `ENV_NOTICE_DETAILS_MAX`；超出的行数记进 `droppedLines`
 * （卡片末尾提示「还有 N 行」），不静默吞掉。
 */
export function envNoticeCard(content: string): EnvNoticeCard | undefined {
  const all: EnvNoticeLine[] = [];
  for (const raw of content.split('\n')) {
    const line = parseEnvNoticeLine(raw);
    if (line !== undefined) all.push(line);
  }
  const first = all[0];
  if (first === undefined) return undefined;
  const kept = all.slice(0, ENV_NOTICE_DETAILS_MAX);
  const dropped = all.length - kept.length;
  return {
    scope: first.scope,
    ok: kept.every((line) => line.ok),
    lines: kept.map((line, index) => ({ ...line, id: String(index) })),
    count: 1,
    ...(dropped > 0 ? { droppedLines: dropped } : {}),
  };
}

/**
 * 折叠：把后到的一张卡并进前一张（同 scope，由调用方判定）。
 *
 * 与 `pending-strip` 的同源折叠同一口径：**纯展示**合并，行仍逐条保留，
 * 只是共用一张卡（卡头「N 条」，展开看全部）。行数上限同样生效。
 */
export function mergeEnvNoticeCards(head: EnvNoticeCard, next: EnvNoticeCard): EnvNoticeCard {
  const merged = [...head.lines, ...next.lines];
  const kept = merged.slice(0, ENV_NOTICE_DETAILS_MAX);
  const dropped =
    (head.droppedLines ?? 0) + (next.droppedLines ?? 0) + (merged.length - kept.length);
  return {
    scope: head.scope,
    ok: head.ok && next.ok,
    lines: kept.map((line, index) => ({ ...line, id: String(index) })),
    count: head.count + next.count,
    ...(dropped > 0 ? { droppedLines: dropped } : {}),
  };
}
