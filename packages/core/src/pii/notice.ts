/**
 * 句柄失效的**渲染**（0.52，用户裁定，别回退）。
 *
 * 口径分四处，别混：
 * 1. **脱敏在 append 侧**：落盘即占位符 ⇒ store / 请求 / UI 同一份字节（可见性对等）。
 * 2. **句柄失效不靠定时器、不等工具报错**：在**请求构造那一趟扫描**里把不可解析的
 *    `«pii:xxxx»` 原地改写成 `«pii-expired:xxxx»`（同一 id、形状可判、跨请求稳定），
 *    并在该请求的系统说明区加**一行**固定文案（无 dead 就不出现，按请求去重）。
 *    这样模型在「要用这个引用」的那一刻就知道它死了，省掉一轮工具失败往返。
 * 3. **工具侧仍保留硬报错**兜底（模型万一还是硬写了占位符）：那条路径是兜底，不是主路径。
 * 4. **只有系统性事件才发环境信息卡**（broker 重启 / 容量耗尽，每 session 至多一张）；
 *    逐调用的 `unknown_handle` / `expired_handle` 只落成那次工具失败，不发卡。
 *
 * 本文件只有文案与形状，无 IO。文案 en / zh-CN 两侧都在（模型侧默认 en，
 * 与其它环境卡提示一致；前端卡头标签走 web 的 i18n key `chat.env.scope.pii`）。
 */

import { findHandles } from './rules.js';

/** 文案语言（模型侧提示默认 en；与其它环境卡提示保持一致）。 */
export type PiiNoticeLocale = 'en' | 'zh-CN';

/**
 * dead 引用标记的固定前缀：`«pii-expired:<id>»`。
 *
 * 形状与正常句柄**不重叠**（多了 `-expired`），所以：
 * - `vault.substitute()` 不会把我们自己的标记当成句柄再解引用一遍（防止自替换回真值）；
 * - 入站中和（`neutralize`）也不会误伤它；
 * - 前端 / 探针可以一眼看出「这条引用已经死了」。
 */
export const PII_EXPIRED_PREFIX = '«pii-expired:';

/** `«pii-expired:<8 位 base32>»`。 */
export const PII_EXPIRED_PATTERN_SOURCE = '«pii-expired:([A-Z2-7]{8})»';

export function piiExpiredPattern(): RegExp {
  return new RegExp(PII_EXPIRED_PATTERN_SOURCE, 'g');
}

/** 由句柄 id 拼出 dead 标记（同一个 id ⇒ 同一个标记，跨请求稳定）。 */
export function piiExpiredOf(handleId: string): string {
  return `${PII_EXPIRED_PREFIX}${handleId}»`;
}

/**
 * 请求内的**一行固定说明**（只在本次请求里出现过 dead 引用时加）。
 *
 * 这是**请求内的上下文提示**，不是聊天流里的环境卡：模型在「要用这个引用」的那一刻
 * 就看到它死了，省掉一轮工具失败的往返；没有 dead 引用就**不出现**（不常驻、不噪音）。
 * 只讲状态与下一步，不含任何真值。
 */
export const PII_DEAD_REFERENCE_NOTE: Record<PiiNoticeLocale, string> = {
  en:
    'Some PII placeholders in this context are marked «pii-expired:<id>»: they can no longer be resolved ' +
    '(expired, unknown, or invalidated by a runtime restart). Re-fetch the source data to obtain a fresh ' +
    'placeholder, or request pii.reveal (human approval) for the value — never pass a «pii-expired:…» marker ' +
    'or a bare placeholder to an external system.',
  'zh-CN':
    '本上下文里有占位符被标成 «pii-expired:<id>»：它们已经无法解析（过期、未知，或运行时重启导致失效）。' +
    '请先重新获取原始数据拿到新的占位符，或用 pii.reveal（需人工审批）申请真值；' +
    '不要把 «pii-expired:…» 标记或裸占位符发给外部系统。',
};

/**
 * 把文本里**不可解析**的句柄原地改写成 `«pii-expired:<id>»`（同一 id，形状可判）。
 *
 * 只在**请求投影**这一份拷贝上做（不动 store、不发定时器）：
 * 出站请求本来就要扫一遍脱敏，这一趟扫描是零额外成本。
 *
 * @param text 待投影正文
 * @param isAlive 该句柄 id 当前是否可解析
 */
export function markDeadHandles(
  text: string,
  isAlive: (handleId: string) => boolean,
): { text: string; dead: number } {
  const occurrences = findHandles(text);
  if (occurrences.length === 0) return { text, dead: 0 };
  let out = '';
  let cursor = 0;
  let dead = 0;
  for (const occurrence of occurrences) {
    if (isAlive(occurrence.id)) continue;
    out += text.slice(cursor, occurrence.start) + piiExpiredOf(occurrence.id);
    cursor = occurrence.end;
    dead += 1;
  }
  if (dead === 0) return { text, dead: 0 };
  return { text: out + text.slice(cursor), dead };
}

/**
 * 取那行固定说明。**同一请求最多一行**（调用方按请求去重）：
 * `dead > 0` 返回那一行，否则 `undefined`（不常驻）。
 */
export function deadReferenceNote(dead: number, locale: PiiNoticeLocale = 'en'): string | undefined {
  if (dead <= 0) return undefined;
  return PII_DEAD_REFERENCE_NOTE[locale];
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
