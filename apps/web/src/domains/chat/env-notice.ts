/**
 * 「环境信息」卡的解析与折叠（纯函数，无 React / DOM / store）。
 *
 * 用户裁决（2026-01）：环境信息本身也要以卡片出现，用户才能看到模型真实的上下文
 * 长什么样子。它与「底层系统信息」是**两种显示方式**，不是两套数据：
 * - 卡片 = 本模块解析的 `vessel:notice` 消息（模型上下文里的那一行行文本）；
 * - 底层行 = `runtime.notice` 原始事件（档位 `internal`，见 `state/event-visibility.ts`，开关打开时才出现）。
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
 * 「环境信息」的作用域词表。
 *
 * 用户裁定（0.52）：模型上下文里只有**一类卡** —— 环境信息（首行的 scope 词只决定卡头标签
 * 与折叠分组）。词表的生产侧真相是 `packages/agent/src/env-info-scope.ts`（`ENV_INFO_SCOPES`），
 * 这里额外保留三类：
 * - `config` / `permission` / `mcp` / `update` / `peer`：`runtime-notice-hook` 老词，历史消息里
 *   全都在用；
 * - `selfcard`：0.52 之前 `self-card-delta` 的首词（改名 / 换 model / 换 prompt 都叫它），
 *   落盘消息里有存量 —— 删掉它等于让老消息的卡头静默退化成「上下文」；
 * - `context`：兜底（解析不出 scope 的行）现在也是一个**正式**种类（系统提示词 / 自卡变更）。
 *
 * 生产者加了词而这里没加，`scripts/check-append-only-context.ts` 的 C3 会直接红。
 */
export const ENV_NOTICE_SCOPES = [
  'config',
  'permission',
  'tools',
  'mcp',
  'update',
  'peer',
  'restart',
  'model',
  'identity',
  'fields',
  'files',
  'context',
  'selfcard',
  'pii',
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
  /**
   * 展开区的**原文块**（additive，0.52）：`labelKey` + 原样文本。
   *
   * 给「可展开看完整快照」那一类环境信息用：快照原文（system prompt / Self Card）是事实，
   * 不能按行拆、也不该被 `ENV_NOTICE_DETAILS_MAX` 截断 —— 它与「行」是两种粒度，各放一处。
   * 现在只有 scope `context` 会带；渲染仍由 `EnvCard` 一处负责。
   */
  blocks?: EnvNoticeBlock[];
}

/** 展开区里的一块原文（`labelKey` 由渲染侧本地化）。 */
export interface EnvNoticeBlock {
  labelKey: string;
  text: string;
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

/**
 * 这个 kind 的消息是不是环境信息（`source` / `limit` 均不是）。
 *
 * 0.52 起 doc-subscription 也写 `vessel:notice`（scope `files`），所以老通道
 * `vessel:subscription` 不再有生产者，也**不**在这里特判：那些老消息落到「未登记的
 * `vessel:*` kind」兜底路径（整段 notice 呈现），既不会崩，也不会变成裸 JSON。
 */
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
/**
 * 行首 scope 词：`config:` / `permission: ...` / `update ...`（不剥正文，只取 scope）。
 *
 * 由 `ENV_NOTICE_SCOPES` 生成而不是另写一份字面量：加 scope 时唯一的改动点就在那份数组，
 * 漏改这里会让新 scope 静默退化成 `context`（卡头标签变错，正文却看着正常，最难发现）。
 */
const SCOPE_TOKEN = new RegExp(`^(${ENV_NOTICE_SCOPES.join('|')})\\b`, 'i');

/** 一行上下文文本 → 解析结果（空行由调用方跳过）。 */
export function parseEnvNoticeLine(raw: string): EnvNoticeLine | undefined {
  let text = raw.trim();
  if (text.length === 0) return undefined;
  text = text.replace(RUNTIME_TAG, '');
  // details 行（`  · name: completed`）：剥掉线格式标记，正文照原样保留。
  // scope 恒为兜底 `context` —— 一条 detail 是首行摘要的解释，没有自己的作用域。
  //
  // 为什么要**先**判标记再判 scope 词：明细正文可能正好以 scope 词开头（`model: a → b`、
  // `tools: 12 → 14`）。先剥标记再判词，这类明细就会被读成自己的 scope，卡头标签跟着变，
  // 与「卡的作用域只看首行」这条口径直接冲突。
  const isDetail = DETAIL_MARK.test(text);
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
  return { id: '', scope: isDetail ? 'context' : scopeOf(text), ok, text };
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

/**
 * `prompt.system_context.changed` 的一条：键 + 原始值。
 *
 * 线上是 `键: 值` 的短句（`model: A → B`、`tools: 12 → 14`、`system_prompt: replaced`）。
 * 只拆成「键 / 值」两段、**不在这里翻译**：键用固定词表映射成本地化标签（`chat.env.changed.*`），
 * 值原样显示（模型 id、数字、`A → B` 都是事实，翻译只会丢信息）。
 *
 * 认不出来的键不丢：原样当键显示（服务端加了新种类而前端还没跟上时，宁可显示一个生词，
 * 也不要把这条变更静默吞掉）。
 */
export interface ContextChangeEntry {
  /** 行身份（React key；同一张卡内唯一）。 */
  id: string;
  /** 键（`system_prompt` / `self_card` / `model` / `tools` / 未知词的原文）。 */
  key: string;
  /** 值（缺省 = 这条只有键，例如 `self_card: added` 之外的兜底形状）。 */
  value?: string;
}

/** 一条 `changed` 短句 → 键 / 值。冒号只在第一个处切（值里可能还有冒号）。 */
export function parseContextChange(raw: string, index: number): ContextChangeEntry | undefined {
  const text = raw.trim();
  if (text.length === 0) return undefined;
  const colon = text.indexOf(':');
  const key = (colon < 0 ? text : text.slice(0, colon)).trim();
  if (key.length === 0) return undefined;
  const value = colon < 0 ? undefined : text.slice(colon + 1).trim();
  return {
    id: String(index),
    key,
    ...(value !== undefined && value.length > 0 ? { value } : {}),
  };
}

/** 一批 `changed` → 可渲染的条目（保持服务端顺序：那是稳定的，不重排）。 */
export function contextChangeEntries(changed: readonly string[]): ContextChangeEntry[] {
  const entries: ContextChangeEntry[] = [];
  for (const [index, raw] of changed.entries()) {
    const entry = parseContextChange(raw, index);
    if (entry !== undefined) entries.push(entry);
  }
  return entries;
}

/**
 * 一条**已算好的**摘要行 + 原文块 → 一张环境信息卡（scope `context`）。
 *
 * 为什么由调用方给摘要文本（`summaryParts`）而不是这里拼：摘要要本地化
 * （模型 · 消息数 · 工具数），而本模块是纯函数、不碰 i18n。本函数只做「装配」：
 * 首行 = 摘要，明细 = 每一行摘要各自的条目（展开区能读全），原文块 = 全量快照。
 *
 * 形态是「一张环境信息卡」而不是「另一种卡」：`EnvCard` 是唯一渲染入口，`prompt.system_context`
 * 只是它的一个数据来源（事件而不是 `vessel:notice` 消息）。
 */
export function envCardOfPromptContext(
  summaryParts: readonly string[],
  blocks: readonly EnvNoticeBlock[],
): EnvNoticeCard {
  // 0.52：调用方可以把摘要整段拿去做折叠态那一行（EnvCard 的 `facts`），此时
  // `summaryParts` 传空 ⇒ 展开体里不重复这些事实（只剩原文块 / hash / 窗口上限）。
  const texts = [...summaryParts];
  const kept = texts.slice(0, ENV_NOTICE_DETAILS_MAX);
  return {
    scope: 'context',
    ok: true,
    lines: kept.map((text, index) => ({
      id: String(index),
      scope: 'context' as const,
      ok: true,
      text,
    })),
    count: 1,
    ...(texts.length > kept.length ? { droppedLines: texts.length - kept.length } : {}),
    ...(blocks.length > 0 ? { blocks: [...blocks] } : {}),
  };
}
