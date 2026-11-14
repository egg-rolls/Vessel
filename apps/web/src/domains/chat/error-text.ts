/**
 * 内部错误码 → 人话（0.52）。
 * @module
 *
 * 用户报的问题：`verbosity: normal`、也没开「显示系统信息（内部事件）」，却在报错会话里
 * 看到了 `stale_fence: fencing token is older than the current lease`。
 *
 * 定位到根因不是白名单塌了，而是**白名单只管事件、不管错误文本**：那种卡是 run 失败卡
 * （content 层，永远可见——这是对的），但 `StreamItems` 把 `failure.error` 原样塞进
 * `<pre class="run-error-body">`，而 `LeaseExpiredError.message` 本身就是内部不变量字符串
 * （`packages/core/src/types/lease.ts`）。
 *
 * 所以这里做「错误文本分级」：已知的内部 reason 映射成人话，原文只在 debug 口径下展示
 * （`verbosity==='debug'` 或在 Observe/Runs 面）。**未知错误保持原样**——宁可露出陌生
 * 原文，也不要为了好看把真错误藏起来。
 */

const HUMANIZED: readonly { pattern: RegExp; key: string }[] = [
  { pattern: /\b(lease_expired|stale_fence)\b/u, key: 'chat.run.reason.lease' },
  { pattern: /\b(session_locked|binding_locked)\b/u, key: 'chat.run.reason.locked' },
  { pattern: /\b(quota|rate_limit|429)\b/u, key: 'chat.run.reason.rateLimited' },
  {
    pattern: /\b(context_(overflow|exceeded)|prompt_too_long)\b/u,
    key: 'chat.run.reason.contextTooLong',
  },
];

export interface HumanizedRunError {
  /** 给人看的句子（已 i18n 化）；未知错误 = undefined */
  key?: string;
  /** 原始文本；只有 debug 口径才该展示 */
  raw: string;
}

/** 把 run 失败文本分级。纯函数：探针直接 import。 */
export function humanizeRunError(raw: string | undefined): HumanizedRunError | undefined {
  if (raw === undefined) return undefined;
  const text = raw.trim();
  if (text === '') return undefined;
  for (const entry of HUMANIZED) {
    if (entry.pattern.test(text)) return { key: entry.key, raw: text };
  }
  return { raw: text };
}
