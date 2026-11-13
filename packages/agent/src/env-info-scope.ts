/**
 * 「环境信息」的 scope 词表与线格式（**唯一真相**）。
 *
 * 用户裁定（0.52）：模型上下文里不需要第二种卡片。身份 / 工具 / 模型 / 提示词 / 系统重启
 * 这些「模型需要知道的改变」全部是**同一类东西**——环境信息：同一条通道
 * （`role: 'user'` + `name: 'vessel:notice'` 的尾消息）、同一个渲染入口
 * （Web 的 `env-notice.ts` → `EnvCard`），只用 **scope** 区分种类。
 *
 * 为什么词表要收在一个零依赖的叶模块里：
 * - 生产者有三个（`self-card-delta` / `tool-surface-delta` / 以后的 restart），各自拼字符串
 *   就会各自拼出不同的首词 —— Web 的 scope 判定按**行首 token** 做，一个词对不上，那条卡
 *   静默掉回兜底的「上下文」，正文看着正常、标签是错的（最难发现的那种坏）。
 * - Web 侧（`apps/web/src/domains/chat/env-notice.ts`）必须认得这里的每一个词。两边分属
 *   packages 与应用层，不能互相 import，所以 `scripts/check-append-only-context.ts` 的 C3
 *   做词表对拍：生产者加了词而 Web 没加，门禁直接红。
 * - 还有一类生产者在**插件包**里（`plugins/context/doc-subscription`）：插件依赖 core、
 *   不依赖本包（依赖方向反了），因此它的首词只能是**字面量副本**
 *   （`plugins/context/doc-subscription/src/notice.ts`）。C3 对拍那份副本，不靠人记。
 *
 * 词义（决定卡头标签，不决定可见性）：
 * - `restart`：系统 / body 重启（换了一具 body，之前的上下文不再是「现在」）；
 * - `tools`：工具面变更（增减工具、权限档切换导致的可用工具变化）；
 * - `model`：模型变更；
 * - `identity`：身份变更（改名 / Team / parent）；
 * - `fields`：其它基础字段变更；
 * - `files`：文件变更（doc-subscription 的订阅文件被改动，只报元数据、不报正文）；
 * - `context`：系统提示词 / Self Card 本身变了（可展开看完整快照）。
 *
 * @module @vessel-agent/agent
 */

/**
 * scope 词表。
 *
 * 顺序有两个用处，都必须稳定：
 * - 同轮多条环境信息的**落盘顺序**（一批变更跨种类时按它依次注入）；
 * - 一条消息里明细行的分组顺序（`formatSelfCardDeltas`）。
 *
 * 排列按「模型最该先知道」而非字母序：重启 → 身份 → 其它字段 → 模型 → 工具 → 文件 → 上下文。
 */
export const ENV_INFO_SCOPES = [
  'restart',
  'identity',
  'fields',
  'model',
  'tools',
  'files',
  'context',
] as const;

export type EnvInfoScope = (typeof ENV_INFO_SCOPES)[number];

/**
 * 注入消息的 `name`：与 `runtime-notice-hook` / `refs-notice-hook` / inbox 提示同一条通道。
 *
 * Web 按 `name === 'vessel:notice'` 认出「这是环境信息」（`runtimeMessageKind` → `notice`），
 * 再按正文首行的 scope 词决定卡头标签。**不新造事件类型**：这条通道已经有人看、有人测、
 * 有人渲染。
 */
export const ENV_INFO_MESSAGE_NAME = 'vessel:notice';

/**
 * details 行的线格式前缀：两个空格 + `·`。
 *
 * **必须**与 `src/runtime-notice-hook.ts` 的 `NOTICE_DETAIL_MARK` 逐字相同 —— Web 的
 * `env-notice.ts` 按这个标记认「这一行是明细」；对不上时整条消息会被读成一整行（明细全挤进
 * 卡头的单行 ellipsis，展开区空着）。两边分属 packages 与应用层，不能互相 import，
 * `src/self-card-delta.test.ts` 断言两者相等，防止哪天单边改动。
 */
export const ENV_INFO_DETAIL_MARK = '  · ';

/**
 * 一条环境信息最多带多少行明细。
 *
 * 10 + 1 行摘要 = 11 = Web 卡片的渲染上限（`ENV_NOTICE_DETAILS_MAX`）：多出来的行会被卡片
 * 折成「还有 N 行未显示」。与其让用户点开只看到被截断的清单，不如生产者先把长清单收口成
 * 「… 还有 N 项」—— 决定权（报什么、舍什么）应该在知道语义的这一侧。
 */
export const ENV_INFO_DETAILS_MAX = 10;

export interface EnvInfoOptions {
  readonly scope: EnvInfoScope;
  /** 摘要（**不含** scope 词，由本函数统一加前缀）。 */
  readonly summary: string;
  /** 明细行（每条会被加上线格式标记；超长由本函数收口）。 */
  readonly details: readonly string[];
  /** 被收口的明细条数文案（可选：默认英文，见 `formatEnvInfo`）。 */
  readonly moreLabel?: (dropped: number) => string;
}

/**
 * 一批明细 → 一条环境信息正文（首行 `scope: summary`，之后每行 `  · detail`）。
 *
 * 形状是**契约**（Web 的解析器就认这个形状）：首行必须是 `scope: ` 开头，明细行必须以
 * `ENV_INFO_DETAIL_MARK` 开头。空明细也允许（只有摘要的环境信息）。
 */
export function formatEnvInfo(options: EnvInfoOptions): string {
  const head = `${options.scope}: ${options.summary}`;
  const kept = options.details.slice(0, ENV_INFO_DETAILS_MAX);
  const dropped = options.details.length - kept.length;
  const lines = kept.map((detail) => `${ENV_INFO_DETAIL_MARK}${detail}`);
  if (dropped > 0) {
    const label = options.moreLabel?.(dropped) ?? `and ${String(dropped)} more`;
    lines.push(`${ENV_INFO_DETAIL_MARK}${label}`);
  }
  return [head, ...lines].join('\n');
}

/**
 * 名字集合的稳定形式（新增 / 删除工具的 diff 用）。
 *
 * 排序是去重与测试的前提，不是美观：同一批变更在任何一轮里都必须拼出同一个字符串，
 * 否则「只报一次」就变成看运气。
 */
export function sortedNames(names: readonly string[]): string[] {
  return [...new Set(names)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}
