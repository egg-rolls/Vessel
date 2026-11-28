/**
 * 订阅变更通知的**线格式**（零 import 的纯字符串模块）。
 *
 * 为什么单独一个文件：
 * - 通知正文的形状是跨包契约（Web 的 `apps/web/src/domains/chat/env-notice.ts` 按**行首
 *   token** 认 scope、按行首 `  · ` 认明细行），但生产者住在插件包里，**不能** import
 *   `packages/agent`（依赖方向反了：插件依赖 core，不依赖 agent 包）。所以词表在这里存
 *   一份字面量：scope 词必须是 `ENV_INFO_SCOPES` 认识的词、明细标记必须与
 *   `packages/agent/src/env-info-scope.ts` 的 `ENV_INFO_DETAIL_MARK` 逐字相同，
 *   改任何一侧都要同步另一侧（Web 渲染按行解析，对不上就整条挤进卡头 ellipsis）。
 * - 零 import：线格式不依赖宿主模块实例，.tgz 插件单独加载也不会崩。
 *
 * line-level 阅读订阅（蜂群协作增强）：内容用**既有行格式**承载（`  · <diff line>` 明细行），
 * scope 仍 `files`，总行数 ≤11（Web `ENV_NOTICE_DETAILS_MAX` 按全部行计数）；超出行/字节
 * 预算折成 truncation 标记 + inspect 提示。零 apps/web 改动、不新增 scope 词 / message name。
 *
 * @module @vessel-agent/doc-subscription/notice
 */

/**
 * 环境信息的 scope 词：文件变更。
 *
 * 与 `tools:` / `identity:` / `model:` 同一形状（首行 `scope: 摘要`，之后每行 `  · 明细`），
 * 因此 Web 那张「环境信息」卡认得它，卡头标签是「文件变更」。
 */
export const SUBSCRIPTION_NOTICE_SCOPE = 'files';

/**
 * 环境信息的 scope 词：node 健康变更（q-health-subscription，additive）。
 *
 * 与 `files` 同一形状（首行 `scope: 摘要` + `  · ` 明细行），Web 环境卡认得它，
 * 卡头标签是「节点健康」。词表对拍范围同 files：agent `ENV_INFO_SCOPES` /
 * config `DEFAULT_ENV_CADENCE` / Web `ENV_NOTICE_SCOPES` + i18n `chat.env.scope.health`。
 */
export const HEALTH_NOTICE_SCOPE = 'health';

/**
 * 环境信息的 scope 词：成员活动变更（q-sub-unify-p1，additive，★D5 统一 agent 词）。
 *
 * 与 `files` / `health` 同一形状（首行 `scope: 摘要` + `  · ` 明细行），Web 环境卡认得它，
 * 卡头标签是「成员活动」。词表对拍范围同 health：agent `ENV_INFO_SCOPES` /
 * config `DEFAULT_ENV_CADENCE` / Web 词表（R-10 派生）+ i18n `chat.env.scope.agent`。
 * 裸 scope 前缀，无方括号（方括号 legacy 只属固定推送 [inbox]/[runtime]，P2/P4）。
 */
export const AGENT_NOTICE_SCOPE = 'agent';

/**
 * 环境信息的 scope 词：订阅脚本检测结果（q-subscription-script，additive）。
 *
 * 与 `files` / `health` 同一形状（首行 `scope: 摘要` + `  · ` 明细行），Web 环境卡认得它，
 * 卡头标签是「订阅脚本」。词表对拍范围同 files：agent `ENV_INFO_SCOPES` /
 * config `DEFAULT_ENV_CADENCE` / Web 词表（R-10 派生）+ i18n `chat.env.scope.script`。
 * 通用兜底词（案 B 注册制）：任意用户脚本共享本词；内置检测器专词见下
 * （DOC_LAG_NOTICE_SCOPE / CODE_HEAVINESS_NOTICE_SCOPE，q-subscription-script-p1）。
 */
export const SCRIPT_NOTICE_SCOPE = 'script';

/**
 * 内置检测器专词：文档滞后（doc-sync --quiet）。案 B 注册制（q-subscription-script-p1）：
 * 内置实例获得精确卡头（「文档滞后」）与 per-scope 节奏/通道热改；词表对拍范围同 script。
 */
export const DOC_LAG_NOTICE_SCOPE = 'doc-lag';

/**
 * 内置检测器专词：代码厚重（code-size）。案 B 注册制（q-subscription-script-p1）；
 * 卡头「代码厚重」；词表对拍范围同 script。
 */
export const CODE_HEAVINESS_NOTICE_SCOPE = 'code-heaviness';

/**
 * 明细行标记：两个空格 + `·`。
 *
 * 必须与 `packages/agent/src/env-info-scope.ts` 的 `ENV_INFO_DETAIL_MARK` 逐字相同，也要与
 * Web 解析侧的 `DETAIL_MARK` 对得上；对不上时整条通知会被读成一整行（明细全挤进卡头的
 * 单行 ellipsis，展开区空着）。C3 门禁做这个对拍。
 */
export const SUBSCRIPTION_NOTICE_DETAIL_MARK = '  · ';

/**
 * 一条通知最多列几个文件。
 *
 * 8 + 「… and N more」+ 调用提示 = 10 条明细，加首行摘要 = 11 行 = Web 卡片的渲染上限
 * （`ENV_NOTICE_DETAILS_MAX`）。取 20 会有一半明细永远看不到（用户只看到「还有 N 行未显示」），
 * 与其让渲染侧截断，不如生产者先把清单收口成一句概括 —— 报什么、舍什么该由知道语义的这侧定。
 */
export const SUBSCRIPTION_NOTICE_DETAILS_MAX = 8;

/**
 * 一条通知的总行数上限（首行摘要 + 明细）。
 *
 * Web `ENV_NOTICE_DETAILS_MAX = 11` 按**全部行**计数（首行也在内），超出记 droppedLines。
 * 生产者先把预算收口：元数据 ≤8 + 溢出概括 + inspect 提示之外的余量才给 diff 内容行。
 */
export const SUBSCRIPTION_NOTICE_MAX_LINES = 11;

/** diff 内容行超出预算（行或字节）时的截断标记（英文：面向模型，不跟 UI 语言走）。 */
export const SUBSCRIPTION_NOTICE_DIFF_TRUNCATED = '… diff truncated — inspect for the full change';

/**
 * 注入消息的 `name`。
 *
 * 0.51 及以前是 `vessel:subscription`（独立 kind，只有打开「显示系统信息」才可见）。改成
 * `vessel:notice` 是把文件变更收进**唯一那条环境信息通道**：它就是一个环境事实（文件变了），
 * 与身份 / 工具 / 模型变更同类，用 scope 区分即可，不再是第二种卡片形态。
 *
 * 可见性因此是**有意改变**的：订阅通知现在默认可见、渲染成环境信息卡「文件变更」（订阅是
 * 用户自己开的，看不到「自己订阅的文件变了」才是更坏的结果）。老会话里的
 * `vessel:subscription` 消息**不做特判**：它落到「未登记的 `vessel:*` kind」兜底路径，
 * 按 `ui.showInternalEvents` 渲成整段 notice（可读、不崩、不变成裸 JSON）。
 */
export const SUBSCRIPTION_NOTICE_MESSAGE_NAME = 'vessel:notice';

/** 明细里的调用提示（英文：与其它运行时上下文一样面向模型，不跟 UI 语言走）。 */
const INSPECT_HINT = 'Call subscribe with action "inspect" and the id or path to view the diff.';

/** line-level diff 内容（只跟在**第一个** line-level 变化条目的元数据行之后）。 */
export interface SubscriptionNoticeContent {
  /** 该内容所属条目元数据行在 `files` 里的下标（0-based） */
  afterIndex: number;
  /** 各变化 ref 的 diff 行顺次拼接（不带明细前缀，前缀在这里统一加） */
  diffLines: readonly string[];
  /** 内容行总字节预算（config.maxTotalBytesPerRun；纯元数据通知不受影响） */
  maxBytes: number;
}

/**
 * diff 行 → 预算内的明细内容行。
 *
 * 行预算：超出 ⇒ 取前 `lineBudget - 1` 行 + 截断标记（标记占一行，lineBudget ≥ 1 时）。
 * 字节预算：内容行（含标记）总字节 ≤ maxBytes；同样折成截断标记。
 * 预算 ≤ 0 或无 diff 行 ⇒ 空数组（纯元数据通知）。
 */
export function fitDiffContentLines(
  diffLines: readonly string[],
  lineBudget: number,
  maxBytes: number,
): string[] {
  if (lineBudget <= 0 || diffLines.length === 0) return [];
  const rendered = diffLines.map((line) => `${SUBSCRIPTION_NOTICE_DETAIL_MARK}${line}`);
  // 先试全量：行数与字节都装得下就不截断。
  let bytes = 0;
  let fits = 0;
  for (const line of rendered) {
    if (fits >= lineBudget) break;
    const lineBytes = Buffer.byteLength(line, 'utf-8');
    if (bytes + lineBytes > maxBytes) break;
    bytes += lineBytes;
    fits += 1;
  }
  if (fits === rendered.length) return rendered;
  // 截断：标记占一行槽位，其字节也计入预算。
  const marker = `${SUBSCRIPTION_NOTICE_DETAIL_MARK}${SUBSCRIPTION_NOTICE_DIFF_TRUNCATED}`;
  const markerBytes = Buffer.byteLength(marker, 'utf-8');
  if (markerBytes > maxBytes) return [];
  const slots = lineBudget - 1;
  const kept: string[] = [];
  let keptBytes = markerBytes;
  for (const line of rendered) {
    if (kept.length >= slots) break;
    const lineBytes = Buffer.byteLength(line, 'utf-8');
    if (keptBytes + lineBytes > maxBytes) break;
    kept.push(line);
    keptBytes += lineBytes;
  }
  kept.push(marker);
  return kept;
}

/**
 * 一批变更文件 → 一条通知正文（首行 `files: N subscribed files changed`，之后每行 `  · …`）。
 *
 * `files` 是已经格式化好的单文件行（`<file path="…" id="…" rev="…" bytes="…" />`，
 * line-level 条目可带 `lines="a-b"` 属性）；`total` 是实际变更总数（可以大于 `files.length`，
 * 多出来的用「… and N more」概括）。调用方负责边界 / 大小 / 二进制判定，这里只管线格式。
 *
 * `content`（additive，line-level 阅读订阅）：第一个 line-level 变化条目的 diff 明细行，
 * 插在该条目元数据行之后；行预算 = 11 − (摘要 1 + 元数据 min(total,8) + 溢出概括 + inspect
 * 提示 1)，字节预算 = content.maxBytes。无 content 时输出与旧版逐字节一致。
 */
export function formatSubscriptionNotice(
  files: readonly string[],
  total: number,
  content?: SubscriptionNoticeContent,
): string {
  const kept = files.slice(0, SUBSCRIPTION_NOTICE_DETAILS_MAX);
  const dropped = total - kept.length;
  const details = kept.map((file) => `${SUBSCRIPTION_NOTICE_DETAIL_MARK}${file}`);
  if (dropped > 0) {
    details.push(`${SUBSCRIPTION_NOTICE_DETAIL_MARK}… and ${dropped} more`);
  }
  let contentLines: string[] = [];
  if (content !== undefined && content.afterIndex >= 0 && content.afterIndex < kept.length) {
    const reserved = 1 + kept.length + (dropped > 0 ? 1 : 0) + 1;
    contentLines = fitDiffContentLines(
      content.diffLines,
      SUBSCRIPTION_NOTICE_MAX_LINES - reserved,
      content.maxBytes,
    );
  }
  details.push(`${SUBSCRIPTION_NOTICE_DETAIL_MARK}${INSPECT_HINT}`);
  if (contentLines.length > 0 && content !== undefined) {
    details.splice(content.afterIndex + 1, 0, ...contentLines);
  }
  return [`${SUBSCRIPTION_NOTICE_SCOPE}: ${total} subscribed files changed`, ...details].join('\n');
}

/** health 明细里的调用提示（英文：面向模型，与其它运行时上下文同口径）。 */
const HEALTH_INSPECT_HINT =
  'Call subscribe with action "inspect" and the id or node to view node health.';

/**
 * 一批变更 node → 一条 health 通知正文（首行 `health: N subscribed nodes changed`，
 * 之后每行 `  · <node … />`）。线格式与 files 通知同形（Web 同一张环境卡，scope 决定
 * 卡头标签）；行预算同口径：元数据 ≤8 + 溢出概括 + inspect 提示 + 首行 ≤ 11 行。
 *
 * `nodes` 是已经格式化好的单 node 行（`<node target="…" id="…" status="…" … />`）；
 * `total` 是实际变更总数（可以大于 `nodes.length`，多出来的用「… and N more」概括）。
 */
export function formatHealthNotice(nodes: readonly string[], total: number): string {
  const kept = nodes.slice(0, SUBSCRIPTION_NOTICE_DETAILS_MAX);
  const dropped = total - kept.length;
  const details = kept.map((node) => `${SUBSCRIPTION_NOTICE_DETAIL_MARK}${node}`);
  if (dropped > 0) {
    details.push(`${SUBSCRIPTION_NOTICE_DETAIL_MARK}… and ${dropped} more`);
  }
  details.push(`${SUBSCRIPTION_NOTICE_DETAIL_MARK}${HEALTH_INSPECT_HINT}`);
  return [`${HEALTH_NOTICE_SCOPE}: ${total} subscribed nodes changed`, ...details].join('\n');
}

/** script 明细里的调用提示（英文：面向模型，与其它运行时上下文同口径）。 */
const SCRIPT_INSPECT_HINT =
  'Call subscribe with action "inspect" and the name to view the full output.';

/** agent 明细里的调用提示（英文：面向模型，与其它运行时上下文同口径）。 */
const AGENT_INSPECT_HINT =
  'Call subscribe with action "inspect" and the id or agent to view member activity.';

/**
 * 一批变更成员 → 一条 agent 通知正文（首行 `agent: N subscribed agents changed`，
 * 之后每行 `  · <agent … />`）。照抄 formatHealthNotice 骨架（q-sub-unify-p1，★D5）：
 * 裸 scope 前缀，无方括号；行预算同口径：元数据 ≤8 + 溢出概括 + inspect 提示 + 首行 ≤ 11 行。
 *
 * `agents` 是已经格式化好的单 agent 行（`<agent target="…" id="…" state="…" … />`）；
 * `total` 是实际变更总数（可以大于 `agents.length`，多出来的用「… and N more」概括）。
 */
export function formatAgentNotice(agents: readonly string[], total: number): string {
  const kept = agents.slice(0, SUBSCRIPTION_NOTICE_DETAILS_MAX);
  const dropped = total - kept.length;
  const details = kept.map((agent) => `${SUBSCRIPTION_NOTICE_DETAIL_MARK}${agent}`);
  if (dropped > 0) {
    details.push(`${SUBSCRIPTION_NOTICE_DETAIL_MARK}… and ${dropped} more`);
  }
  details.push(`${SUBSCRIPTION_NOTICE_DETAIL_MARK}${AGENT_INSPECT_HINT}`);
  return [`${AGENT_NOTICE_SCOPE}: ${total} subscribed agents changed`, ...details].join('\n');
}

/** 一个脚本变化的通知素材（hook 组装；线格式交给 formatScriptNotice） */
export interface ScriptNoticeEntry {
  /** 订阅名（单脚本摘要用） */
  name: string;
  /** 环境卡 scope 词（spec.scope，已登记词；hook 按它分组，同 scope 折叠一条消息） */
  scope: string;
  /** 元数据行（`<script name="…" exit="…" bytes="…" change="…" />`） */
  metaLine: string;
  /** 内容行（diff / full 的 stdout 行，不带明细前缀；缺省 = 纯元数据） */
  contentLines?: readonly string[];
  /** 内容行字节预算（config.maxTotalBytesPerRun） */
  maxBytes: number;
}

/**
 * 一批脚本变化 → 一条 script 通知正文（首行 `<scope>: …`，之后每行 `  · …`）。
 * 线格式与 files / health 同形（Web 同一张环境卡，scope 决定卡头标签）；
 * 多订阅同 run 都有变化 ⇒ **同 scope** 一条消息多明细行（折叠），不每订阅一张卡；
 * 不同 scope（内置专词 vs 通用兜底）由调用方分组后各发一条（q-subscription-script-p1）。
 *
 * 行预算同口径：元数据 ≤8 + 溢出概括 + inspect 提示 + 首行 ≤ 11 行；内容行只跟
 * **第一个**带内容的条目（files line-level 先例），行/字节预算经 fitDiffContentLines。
 */
export function formatScriptNotice(
  entries: readonly ScriptNoticeEntry[],
  total: number,
  scope: string = SCRIPT_NOTICE_SCOPE,
): string {
  const kept = entries.slice(0, SUBSCRIPTION_NOTICE_DETAILS_MAX);
  const dropped = total - kept.length;
  const details = kept.map((entry) => `${SUBSCRIPTION_NOTICE_DETAIL_MARK}${entry.metaLine}`);
  if (dropped > 0) {
    details.push(`${SUBSCRIPTION_NOTICE_DETAIL_MARK}… and ${dropped} more`);
  }
  let contentLines: string[] = [];
  let insertAt = -1;
  for (let i = 0; i < kept.length; i += 1) {
    const entry = kept[i];
    if (
      entry === undefined ||
      entry.contentLines === undefined ||
      entry.contentLines.length === 0
    ) {
      continue;
    }
    const reserved = 1 + kept.length + (dropped > 0 ? 1 : 0) + 1;
    contentLines = fitDiffContentLines(
      entry.contentLines,
      SUBSCRIPTION_NOTICE_MAX_LINES - reserved,
      entry.maxBytes,
    );
    insertAt = i + 1;
    break;
  }
  details.push(`${SUBSCRIPTION_NOTICE_DETAIL_MARK}${SCRIPT_INSPECT_HINT}`);
  if (insertAt >= 0 && contentLines.length > 0) {
    details.splice(insertAt, 0, ...contentLines);
  }
  const first = kept[0];
  const summary =
    total === 1 && first !== undefined
      ? `${first.name} reported changes`
      : `${total} subscribed scripts reported`;
  return [`${scope}: ${summary}`, ...details].join('\n');
}
