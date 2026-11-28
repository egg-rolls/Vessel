/**
 * 「环境信息」卡的解析与折叠（纯函数，无 React / DOM / store）。
 *
 * 用户裁决（2026-01）：环境信息本身也要以卡片出现，用户才能看到模型真实的上下文
 * 长什么样子。它与「底层系统信息」是**两种显示方式**，不是两套数据：
 * - 卡片 = 本模块解析的 `vessel:notice` 消息（模型上下文里的那一行行文本）与
 *   `vessel:source` 来源行（`sourceNoticeCard`，q-from-card 裁定：scope「来源」，
 *   principal/node/team 组织投射 + 原文块）；
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
 * 可见性不在这里判：`state/runtime-visibility.ts` 决定 `notice` / `source` 种类默认可见
 * （`ENV_MESSAGE_KINDS`，两侧对账），本模块只负责「解析成卡片内容」与「相邻同 scope 折叠」。
 * 卡片的**样子**也不在这里：
 * 渲染在 `EnvCard.tsx`，与「来自 agent X」卡同一张卡（用户裁决：复用 agent 卡的样式与
 * 点击展开机制），scope 只作为卡头标签出现。
 *
 * @module web/chat/env-notice
 */
// q-addr-display：地址显示纯函数（零 import leaf，不破坏本模块「无 React / DOM / store」）。
import {
  type AddressNameMaps,
  type AddressStyle,
  formatAddress,
} from '@vessel-agent/agent/address-display';
// R-10 单源：env 词表按源码消费 config 叶模块（type-only import 运行时零依赖，
// 与上面 address-display 同一 paths + vite alias 先例）。
import { DEFAULT_ENV_CADENCE } from '@vessel-agent/config/env-injection';

/**
 * 「环境信息」的作用域词表。
 *
 * 用户裁定（0.52）：模型上下文里只有**一类卡** —— 环境信息（首行的 scope 词只决定卡头标签
 * 与折叠分组）。词表的生产侧真相是 `packages/agent/src/env-info-scope.ts`（`ENV_INFO_SCOPES`）；
 * 核心词表派生 config `DEFAULT_ENV_CADENCE`（含 `config` / `permission` / `mcp` / `update` /
 * `peer` 这些 `runtime-notice-hook` bus 老词，历史消息里全都在用），这里额外保留两个
 * 不在节奏表里的历史词：
 * - `selfcard`：0.52 之前 `self-card-delta` 的首词（改名 / 换 model / 换 prompt 都叫它），
 *   落盘消息里有存量 —— 删掉它等于让老消息的卡头静默退化成「上下文」；
 * - `inbox`：0.53 补的词 —— 收件箱提醒（别人发给这个 agent 的消息）在模型侧是一条
 *   `[inbox] N unread` 的 `vessel:notice` 尾消息（发点在 `packages/agent/src/inbox.ts` 的
 *   `noticeContent`，事件侧见 `packages/agent/src/runtime.ts`）。它过去既不在 `ENV_INFO_SCOPES`
 *   里、也没有卡头标签 ⇒ 只能落进兜底「上下文」，用户在杂项里扫不到。
 * - `context`：兜底（解析不出 scope 的行）现在也是一个**正式**种类（系统提示词 / 自卡变更），
 *   在 `EnvNoticeScope` 类型里补充，不进解析词表。
 *
 * R-10 单源：核心词表派生 config `DEFAULT_ENV_CADENCE`（`Object.keys`，21 词含 agent /
 * script / doc-lag / code-heaviness），
 * 只额外保留两个不在节奏表里的历史词（inbox / selfcard，见上）。生产者加词时同步
 * agent `ENV_INFO_SCOPES` + config `DEFAULT_ENV_CADENCE` + i18n 标签（`chat.env.scope.*`）
 * + 插件字面量副本；本数组与 Web settings-registry 词表自动跟随，不再人工对拍。
 * 这里漏了词，卡头静默退化成「上下文」；登记了词却没有标签 / 解析器认不出，标签就是死代码。
 */
export const ENV_NOTICE_SCOPES: readonly string[] = [
  ...Object.keys(DEFAULT_ENV_CADENCE),
  // 历史词（不在 DEFAULT_ENV_CADENCE）：inbox = 0.53 收件箱提醒；selfcard = 0.52 前存量首词。
  'inbox',
  'selfcard',
];

// R-10 单源后词表是运行时派生的开放词集（string）：scope 的合法性由 SCOPE_TOKEN 解析
// 门禁（不在词表 ⇒ 兜底 'context'），类型层不再枚举字面量。
export type EnvNoticeScope = (typeof ENV_NOTICE_SCOPES)[number] | 'context' | 'source';
// `source` 不在 ENV_NOTICE_SCOPES 里：那份词表是 vessel:notice **行首 scope 词**的解析
// 词表，来源卡的 scope 只由 sourceNoticeCard 装配（vessel:source 是另一种线格式
// `<from location="..." />`，不走行解析）。加进解析词表反而会让 notice 正文里以
// `source:` 开头的行被误认成来源卡。

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
   * scope `context`（全量快照）与 `source`（来源行原文，q-from-card）会带；
   * 渲染仍由 `EnvCard` 一处负责。
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
 * `vessel:source`（投射来源行）的种类：同样按环境信息卡呈现（用户裁定 q-from-card），
 * 但线格式不同（`<from location="principal@node:team" />`），解析走 `sourceNoticeCard`。
 * 可见性口径在 `state/runtime-kinds.ts` 的 `ENV_MESSAGE_KINDS`（两侧对账，门禁 O8）。
 */
export const ENV_SOURCE_KIND = 'source';

/**
 * 这个 kind 的消息是不是 `vessel:notice` 环境信息（`source` 走 `sourceNoticeCard`，
 * `limit` 等仍不是）。
 *
 * 0.52 起 doc-subscription 也写 `vessel:notice`（scope `files`），所以老通道
 * `vessel:subscription` 不再有生产者，也**不**在这里特判：那些老消息落到「未登记的
 * `vessel:*` kind」兜底路径（整段 notice 呈现），既不会崩，也不会变成裸 JSON。
 */
export function isEnvNoticeKind(kind: string | undefined): boolean {
  return kind === ENV_NOTICE_KIND;
}

/**
 * runtime 上下文种类 → 环境信息卡数据的**统一装配入口**（live / history / 中途注入 /
 * 只读成员视图共用，双路径一致由结构保证而不是约定）：
 * - `notice` → `envNoticeCard`（行解析）；
 * - `source` → `sourceNoticeCard`（来源地址组织 + 原文块）；
 * - 其余 kind → undefined（渲染侧退回整段文本的运行时提示卡）。
 */
export function runtimeEnvCard(
  kind: string | undefined,
  content: string,
): EnvNoticeCard | undefined {
  if (kind === ENV_NOTICE_KIND) return envNoticeCard(content);
  if (kind === ENV_SOURCE_KIND) return sourceNoticeCard(content);
  return undefined;
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
 * 由 `ENV_NOTICE_SCOPES` 生成而不是另写一份字面量：加 scope 时唯一的改动点在
 * config `DEFAULT_ENV_CADENCE`（R-10 单源，词表自动派生），漏改那里会让新 scope
 * 静默退化成 `context`（卡头标签变错，正文却看着正常，最难发现）。
 * 词间无前缀包含关系且裸词形式带 `\b` 边界，alternation 顺序不影响匹配。
 *
 * 两种线格式都要认：裸词（`tools: 12 → 14`）和方括号形式（`[inbox] 3 unread`，即 inbox
 * 生产者的正文 —— `noticeContent` 写的就是方括号）。方括号只用于**取 scope**，一个字符都不从
 * 正文里剥（本模块的口径：正文字面保留，用户看到的就是模型上下文里的原文）。
 */
const SCOPE_ALTERNATION = ENV_NOTICE_SCOPES.join('|');
const SCOPE_TOKEN = new RegExp(`^(?:\\[(${SCOPE_ALTERNATION})\\]|(${SCOPE_ALTERNATION})\\b)`, 'i');

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
  // 两组互为备选：[1] = `[inbox] …` 的方括号形式，[2] = 裸词形式。
  const token = match?.[1] ?? match?.[2];
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
 * `vessel:source` 的正文（`<from location="principal@node:team" />`）→ 环境信息卡
 * （scope「来源」，用户裁定 q-from-card）。
 *
 * 口径：
 * - 摘要行 = location 地址原文（可回信的地址就是「一眼要看的事实」，模型回信时原样抄）；
 * - 明细行 = principal / node / team 三段组织投射（键是协议词，不翻译 —— 与
 *   `contextChangeEntries` 的键同一口径：模型 id / 地址段都是事实，翻译只会丢信息）；
 * - 展开区 = 全部行 + **原文块**（整段正文一字不动 —— 原文即模型所见事实，不改内容）；
 * - 解析不出 location（旧数据 / 第三方改写）时不吞正文：整段原文当摘要行，仍是可读卡。
 *
 * 与 `transcript-items.ts` 的 `sourceLocationOf` 同一条正则口径（那边供 agent 卡吸收
 * 折叠用，这边供卡片装配用）；两处都是纯函数，不互相 import（避免环）。
 */
const SOURCE_LOCATION = /location="([^"]+)"/;

/** 来源地址的段：`principal@node:team`（缺 node 时 `principal@team`，见 formatMessageSource）。 */
export interface SourceAddress {
  principal: string;
  node?: string;
  team?: string;
}

/** node 段是 uuid（生产侧 nodeId）：两段地址里区分 `@node` 与 `@team` 的形状判据。 */
const NODE_UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * location 地址 → 三段。段数决定语义（生产侧 `formatMessageSource`：有 node 才写三段，
 * 缺的段不补占位符）：
 * - 无 `@`：只有 principal（human / system / 纯内存构造）；
 * - `@` 后带 `:`：三段 `principal@node:team`（空段不登记）；
 * - `@` 后无 `:`：两段 —— uuid 形状是 node（缺 team），否则是 team（缺 nodeId）。
 * 形状不合（空 principal / 空 host）返回 undefined，调用方退回原文呈现，绝不吞正文。
 */
export function parseSourceAddress(location: string): SourceAddress | undefined {
  // q-inbox-ux-fix：联邦来源 `federation:principal@node:team` 先剥前缀 —— principal 段
  // 才是发送者身份；带着前缀解析会把 principal 认成 `federation:<name>`，roster 查不到、
  // 名字被挡。vessel:source 的 location 本就无前缀（服务端已剥），此处幂等。
  const value = location.trim().replace(/^federation:/, '');
  if (value.length === 0) return undefined;
  const at = value.indexOf('@');
  if (at < 0) return { principal: value };
  const principal = value.slice(0, at);
  const host = value.slice(at + 1);
  if (principal.length === 0 || host.length === 0) return undefined;
  const colon = host.indexOf(':');
  if (colon >= 0) {
    const node = host.slice(0, colon);
    const team = host.slice(colon + 1);
    return {
      principal,
      ...(node.length > 0 ? { node } : {}),
      ...(team.length > 0 ? { team } : {}),
    };
  }
  return NODE_UUID_LIKE.test(host) ? { principal, node: host } : { principal, team: host };
}

/**
 * q-addr-display：来源卡按 `ui.addressStyle` 渲染（纯函数，渲染侧调用）。
 *
 * 只动「组织行」：摘要行（location）与 `principal: / node: / team:` 明细行按
 * formatAddress 兜底链渲染；**原文块（blocks）一字不动** —— 原文即模型所见事实。
 * 非 source 卡原样返回；解析不出地址的行（旧数据 / 第三方改写）原样保留，不吞不改。
 */
export function styleSourceCard(
  env: EnvNoticeCard,
  style: AddressStyle,
  names?: AddressNameMaps,
): EnvNoticeCard {
  if (env.scope !== 'source') return env;
  return {
    ...env,
    lines: env.lines.map((line) => ({ ...line, text: styleSourceLine(line.text, style, names) })),
  };
}

function styleSourceLine(text: string, style: AddressStyle, names?: AddressNameMaps): string {
  for (const key of ['principal', 'node', 'team'] as const) {
    const prefix = `${key}: `;
    if (text.startsWith(prefix)) {
      const value = text.slice(prefix.length);
      const segment =
        key === 'principal'
          ? { principal: value }
          : key === 'node'
            ? { node: value }
            : { team: value };
      return prefix + formatAddress(segment, style, names);
    }
  }
  // 含标签字符的不是裸地址（原文兜底行 / 第三方改写）：不猜，原样。
  if (text.includes('<') || text.includes('"')) return text;
  const address = parseSourceAddress(text);
  return address !== undefined ? formatAddress(address, style, names) : text;
}

export function sourceNoticeCard(content: string): EnvNoticeCard | undefined {
  const raw = content.trim();
  if (raw.length === 0) return undefined;
  const location = SOURCE_LOCATION.exec(content)?.[1];
  const texts: string[] = [];
  if (location !== undefined && location.length > 0) {
    texts.push(location);
    const address = parseSourceAddress(location);
    if (address !== undefined) {
      texts.push(`principal: ${address.principal}`);
      if (address.node !== undefined) texts.push(`node: ${address.node}`);
      if (address.team !== undefined) texts.push(`team: ${address.team}`);
    }
  } else {
    texts.push(raw);
  }
  return {
    scope: 'source',
    ok: true,
    lines: texts.map((text, index) => ({ id: String(index), scope: 'source', ok: true, text })),
    count: 1,
    blocks: [{ labelKey: 'chat.env.source.raw', text: content }],
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
  // 原文块随折叠保留（来源卡的原文块是「模型所见事实」，折掉第二张卡不能丢它的原文）。
  const blocks = [...(head.blocks ?? []), ...(next.blocks ?? [])];
  return {
    scope: head.scope,
    ok: head.ok && next.ok,
    lines: kept.map((line, index) => ({ ...line, id: String(index) })),
    count: head.count + next.count,
    ...(dropped > 0 ? { droppedLines: dropped } : {}),
    ...(blocks.length > 0 ? { blocks } : {}),
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

/**
 * 纯 pending 形态的 `[inbox] N pending` 通知（0.55.1 引入，q-inbox-notice-visibility-fix 收窄）。
 *
 * **这只是形态判据，不是覆盖判据**：命中它只说明这张卡「有可能」被 PendingStrip 承接，
 * 是否真抑制由调用方（TranscriptWindow）叠加「条带此刻正画着本会话 human 源未消费条目」
 * 的实时判定（stripCoversInboxPending）决定。
 *
 * 历史背景：0.55.1 按当时用户裁定「多余设计」把命中本形态的卡一律隐藏，前提是条带已承接。
 * probe-inbox-notice（2026-11-27）证伪了该前提：生产 56/56 条通知来自 agent 投递
 * （wake/quiet / 成员 send），条带行消费即消失、不留持久痕迹，一律抑制 ⇒ 用户从未见过卡。
 * 另注：条带取数自 I-1（194c348b）起是 agent 级全量（含无 session 归属的 wake/quiet），
 * 「无归属条目被条带隐藏」的旧说法已不成立；真正的覆盖缺口是「消费即消失 + 非 human 排队」。
 *
 * 只认**纯 pending** 那一种（`[inbox] N pending`，不含 unread）：含 unread 的行说的是
 * 「别人给你发了消息、要用 inbox 工具去读」，与条带的「排队输入」语义不同，保守起见一律出卡。
 */
export function isStripCoveredInboxNotice(card: EnvNoticeCard): boolean {
  if (card.scope !== 'inbox') return false;
  if (card.lines.length === 0) return false;
  return card.lines.every((line) => /^\[inbox\] \d+ pending$/i.test(line.text.trim()));
}
