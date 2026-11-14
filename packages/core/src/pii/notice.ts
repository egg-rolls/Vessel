/**
 * 句柄失效的**渲染**（0.52，用户裁定，别回退）。
 *
 * 三条不变量（0.52 起是硬约束，见 AGENTS.md）：
 * 1. **可见性对等**：UI 里渲染出来的消息必须包含 agent 看得到的一切。所以脱敏发生在
 *    **append 侧** —— 落盘即占位符，store / 请求 / UI 三处同一份字节，不存在「两级形态」。
 * 2. **请求 messages 只许 append**：任何一条已发出的消息都不许回改（否则前缀缓存全废）。
 * 3. 因此「句柄失效」**不能改写成新标记**，只能**追加一条 notice**：同 session 同一批
 *    失效引用只追加一条（按 id 去重），持久、UI 与模型都看得见、且不携带真值。
 *
 * 另外（逐调用 vs 面上的区分）：
 * - `unknown_handle` / `expired_handle` 是**动作错误**：只落成那次工具调用的失败
 *   （`retryable: false` + 下一步），**不发环境信息卡**；
 * - 「整批失效」（broker 重启）与「容量耗尽」是**面上的事件**：至多发**一张**环境卡
 *   （每 session 一个名额），卡面只讲状态。
 *
 * 本文件只有文案与形状，无 IO。文案 en / zh-CN 两侧都在（模型侧默认 en，
 * 与其它环境卡提示一致；前端卡头标签走 web 的 i18n key `chat.env.scope.pii`）。
 */

import type { PiiCategory } from './types.js';

/** 文案语言（模型侧提示默认 en；与其它环境卡提示保持一致）。 */
export type PiiNoticeLocale = 'en' | 'zh-CN';

/** 本批失效引用最多列多少个 id（超出的只说数量，避免 notice 无限长）。 */
export const PII_DEAD_REFERENCE_LIST_LIMIT = 8;

export interface PiiDeadReference {
  /** 占位符（`«pii:xxxxxxxx»`），不含真值 */
  handle: string;
  /** 类别（能判定时才给；判定不了就不写，绝不猜） */
  category?: PiiCategory;
}

const DEAD_REFERENCES_SUMMARY: Record<PiiNoticeLocale, string> = {
  en: 'these references are no longer resolvable (expired, unknown, or invalidated by a restart).',
  'zh-CN': '以下引用已无法解析（过期、未知，或运行时重启导致失效）。',
};

const DEAD_REFERENCES_NEXT_STEP: Record<PiiNoticeLocale, string> = {
  en: 'Re-fetch the source data for a fresh placeholder, or request pii.reveal (human approval) for the value.',
  'zh-CN': '请重新获取原始数据拿到新占位符，或用 pii.reveal（需人工审批）申请真值。',
};

const DEAD_REFERENCES_OMITTED: Record<PiiNoticeLocale, (omitted: number) => string> = {
  en: (omitted) => `+${omitted} more`,
  'zh-CN': (omitted) => `另有 ${omitted} 项`,
};

/**
 * 环境信息卡的**明细行线格式前缀**：两个空格 + `·`。
 *
 * **必须**与 `packages/agent/src/env-info-scope.ts` 的 `ENV_INFO_DETAIL_MARK` 以及 Web
 * 的 `apps/web/src/domains/chat/env-notice.ts` 的 `NOTICE_DETAIL_MARK` 逐字相同：对不上时
 * 整条消息会被读成一整行（明细全挤进卡头的单行 ellipsis，展开区空着）。
 *
 * core 不能 import agent（依赖方向反了），所以这是一份**字面量副本**，
 * 与 `plugins/context/doc-subscription` 里的副本同性质。
 */
export const PII_ENV_DETAIL_MARK = '  · ';

/**
 * 追加的「失效引用」**环境信息卡**正文（`vessel:notice`，Web 走 EnvCard 渲染族）。
 *
 * 形状与其它环境卡一致：首行 `pii: <摘要>`（scope 词决定卡头标签与折叠分组），
 * 之后每行一条明细、以 {@link PII_ENV_DETAIL_MARK} 开头（Web 按 `\n` 拆行、剥掉明细前缀）。
 * 明细条数受 `PII_DEAD_REFERENCE_LIST_LIMIT` 限制，超出先收口成「另有 N 项」，
 * 再加一条「下一步」，整体不越过 Web 的明细上限，不会被静默截断。
 *
 * 每行明细**只列占位符 id 与类别**：没有真值、片段、长度，也不给原始位置。
 * 同一批只公告一次（去重见 `PiiVault.shouldAnnounceDeadBatch`）。
 */
export function renderDeadReferencesNotice(
  references: readonly PiiDeadReference[],
  locale: PiiNoticeLocale = 'en',
): string {
  const describe = (reference: PiiDeadReference): string =>
    reference.category === undefined
      ? reference.handle
      : `${reference.handle} (${reference.category})`;
  const shown = references.slice(0, PII_DEAD_REFERENCE_LIST_LIMIT);
  const omitted = references.length - shown.length;
  const lines = shown.map((reference) => `${PII_ENV_DETAIL_MARK}${describe(reference)}`);
  if (omitted > 0) lines.push(`${PII_ENV_DETAIL_MARK}${DEAD_REFERENCES_OMITTED[locale](omitted)}`);
  lines.push(`${PII_ENV_DETAIL_MARK}${DEAD_REFERENCES_NEXT_STEP[locale]}`);
  return [`pii: ${DEAD_REFERENCES_SUMMARY[locale]}`, ...lines].join('\n');
}

/**
 * 「整批失效」环境信息卡文案（与容量卡共用每 session 一张的名额）。
 *
 * 形状与其它环境卡一致：首行必须是 `scope: summary`（Web 的 env-card 解析器就按这个形状
 * 解析，**没有** `[runtime] ` 前缀）。首词 `pii` 必须在
 * `packages/agent/src/env-info-scope.ts` 的 `ENV_INFO_SCOPES` 与 web 的
 * `ENV_NOTICE_SCOPES` 里都能对上（C3 词表对拍），卡头标签走
 * `chat.env.scope.pii`（en / zh-CN）。
 */
export const PII_INVALIDATION_NOTICE: Record<PiiNoticeLocale, string> = {
  en:
    'pii: PII handles were invalidated in bulk — the in-memory PII broker restarted, so every ' +
    '«pii:…» placeholder from before this restart is unusable. Re-fetch the source data to obtain new ' +
    'placeholders; values can only be surfaced through pii.reveal with human approval.',
  'zh-CN':
    'pii: PII 句柄已整批失效 —— 内存 broker 重启，重启之前的所有 «pii:…» 占位符都不能再用。' +
    '请重新获取原始数据以获得新占位符；需要真值时只能走 pii.reveal（需人工审批）。',
};

/**
 * 「句柄容量耗尽」环境信息卡文案（与失效卡共用每 session 一张的名额）。
 *
 * 为什么要说：容量满了以后模型看到的是 `«pii:mask:…»` 而不是可引用的句柄，
 * 它得知道「这不是我拼错了」。
 */
export const PII_CAPACITY_NOTICE: Record<PiiNoticeLocale, string> = {
  en:
    'pii: PII handle capacity for this session is exhausted — further hits are masked as ' +
    '«pii:mask:<category>» and cannot be re-referenced by placeholder. Reduce the amount of distinct sensitive ' +
    'data in play, or ask the user for the specific value via pii.reveal (human approval).',
  'zh-CN':
    'pii: 本 session 的 PII 句柄容量已用尽 —— 之后的命中会直接掩码成 «pii:mask:<类别>»，' +
    '无法再用占位符引用。请减少同时涉及的敏感数据数量，或用 pii.reveal（需人工审批）向用户申请具体值。',
};
