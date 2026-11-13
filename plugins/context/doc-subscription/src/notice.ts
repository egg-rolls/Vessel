/**
 * 订阅变更通知的**线格式**（零 import 的纯字符串模块）。
 *
 * 为什么单独一个文件：
 * - 通知正文的形状是跨包契约（Web 的 `apps/web/src/domains/chat/env-notice.ts` 按**行首
 *   token** 认 scope、按行首 `  · ` 认明细行），但生产者住在插件包里，**不能** import
 *   `packages/agent`（依赖方向反了：插件依赖 core，不依赖 agent 包）。所以词表在这里存
 *   一份字面量，另由 `scripts/check-append-only-context.ts` 的 C3 做对拍：这里写的 scope
 *   词必须是 `ENV_INFO_SCOPES` 认识的词、明细标记必须与 `ENV_INFO_DETAIL_MARK` 逐字相同。
 *   生产侧改了词而词表没改（或反过来），门禁直接红 —— 靠人记的「两边都改」迟早漏。
 * - 零 import 才能在**测试里真跑一次**（`src/doc-subscription-notice.test.ts`）：hook.ts
 *   引了 `@vessel-agent/basic-tools`，根目录没装 node_modules（worktree 里不该 `bun install`），
 *   真跑 hook 会把测试拖成「需要装依赖才能验证」。格式留在纯模块里，最该被验证的那段就能
 *   在没有依赖的环境里断言。
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

/**
 * 一批变更文件 → 一条通知正文（首行 `files: N subscribed files changed`，之后每行 `  · …`）。
 *
 * `files` 是已经格式化好的单文件行（`<file path="…" id="…" rev="…" bytes="…" />`，
 * 不含任何文件正文）；`total` 是实际变更总数（可以大于 `files.length`，多出来的用
 * 「… and N more」概括）。调用方负责边界 / 大小 / 二进制判定，这里只管线格式。
 */
export function formatSubscriptionNotice(files: readonly string[], total: number): string {
  const kept = files.slice(0, SUBSCRIPTION_NOTICE_DETAILS_MAX);
  const dropped = total - kept.length;
  const details = kept.map((file) => `${SUBSCRIPTION_NOTICE_DETAIL_MARK}${file}`);
  if (dropped > 0) {
    details.push(`${SUBSCRIPTION_NOTICE_DETAIL_MARK}… and ${dropped} more`);
  }
  details.push(`${SUBSCRIPTION_NOTICE_DETAIL_MARK}${INSPECT_HINT}`);
  return [`${SUBSCRIPTION_NOTICE_SCOPE}: ${total} subscribed files changed`, ...details].join('\n');
}
