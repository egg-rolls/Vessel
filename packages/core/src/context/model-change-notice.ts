/**
 * 「跨重启 / 换 body 的模型变更」env 卡的文案与形状（model-follow Step D）。
 *
 * 与 `pii/notice.ts` / `context-notice.ts` 同一套路：core 直接写出一张 `vessel:notice`
 * 尾消息（追加，不改历史），正文首行 `model: <A> → <B>`，明细行以 `  · ` 开头。
 * 线格式与 scope 词的唯一真相是 `packages/agent/src/env-info-scope.ts`
 * （`ENV_INFO_SCOPES` / `ENV_INFO_DETAIL_MARK` / `formatEnvInfo`）；core 不能 import agent
 * （依赖方向反了），所以这里是**字面量副本**，与 `pii/notice.ts` 的副本同性质。
 *
 * **对拍义务**（原 C3 对拍脚本已按宪法删除，改动本文件时人工核对，
 * 口径见 `docs/architecture/env-info-append-only.md`）：
 * - {@link MODEL_CHANGE_DETAIL_MARK} 必须与 `ENV_INFO_DETAIL_MARK` 及 Web
 *   `apps/web/src/domains/chat/env-notice.ts` 的明细标记逐字相同（两空格 + `·`）；
 * - 首词 `model` 必须在 `ENV_INFO_SCOPES` 与 Web `ENV_NOTICE_SCOPES` 里都认得
 *   （卡头标签走 i18n `chat.env.scope.model`，en / zh-CN）；
 * - 值裁长口径与 agent `self-card-delta.ts` 的 `valueText` 一致（≤60 字符，防脏数据撑爆行）。
 *
 * 与 `self-card-delta` 的 model 卡语义区分：那张说「本具 body 仍用旧值，下一具才用新值」
 * （body 存活期内的 pin 变更）；本卡说「切换已从本次 run 生效」（EU（重）建后的首个 run
 * 比较存档指纹 `SessionState.prompt_context.model` 与当前 model）。因此本卡首行直接是
 * 过渡本身，而 self-card-delta 的首行是固定摘要、过渡在明细行 —— 文本键去重不会互相误判。
 *
 * 本文件只有文案与形状，无 IO。文案 en（模型侧默认，与其它环境卡一致）。
 */

import type { Message } from '../types/provider.js';

/**
 * 明细行线格式前缀：两个空格 + `·`。**字面量副本**，对拍义务见文件头注释。
 */
export const MODEL_CHANGE_DETAIL_MARK = '  · ';

/** 单个 model 值的最大长度（口径同 self-card-delta 的 VALUE_MAX：名字都很短，防脏数据）。 */
const MODEL_VALUE_MAX = 60;

/** 值 → 行内文本：压成一行 + 裁长（同 self-card-delta `valueText` 的口径）。 */
function modelValueText(value: string): string {
  const flat = value.replace(/\s+/g, ' ');
  return flat.length <= MODEL_VALUE_MAX ? flat : `${flat.slice(0, MODEL_VALUE_MAX)}…`;
}

/** 过渡键：首行渲染与去重共用同一份裁长后的值，长 model 名也能命中去重。 */
function modelTransition(from: string, to: string): string {
  return `${modelValueText(from)} → ${modelValueText(to)}`;
}

/**
 * 「跨重启模型变更」环境信息卡正文。
 *
 * 首行 `model: <A> → <B>`（Web 按行首词认 scope、决定卡头标签）；明细写清生效点：
 * 之前的轮次用 A，本次 run 用 B —— EU 的 model 是构造期只读快照，变更正是在这具
 * （重）建 body 的续接 run 生效，卡如实说明，不改 system 前缀、不开新段。
 */
export function renderModelChangeNotice(from: string, to: string): string {
  return [
    `model: ${modelTransition(from, to)}`,
    `${MODEL_CHANGE_DETAIL_MARK}earlier turns in this session ran on ${modelValueText(from)}; this run uses ${modelValueText(to)}`,
  ].join('\n');
}

/**
 * 文本键去重（restart-card 同族）：播种出的消息里已有 `vessel:notice` 首行以 `model: `
 * 开头且含同一 `<A> → <B>` 过渡 ⇒ 已宣告过，跳过。
 *
 * 指纹只在 run 发布 `prompt.system_context` 时推进，所以「连续两次重启、中间没跑 run」
 * 与「上一 run 注入了卡但没走到发布就终止」都靠这条文本键兜住：同一过渡只报一次；
 * 回滚（A→B→A）的过渡键不同，照样报。
 */
export function modelChangeAlreadyAnnounced(
  messages: readonly Message[],
  from: string,
  to: string,
): boolean {
  const transition = modelTransition(from, to);
  for (const message of messages) {
    if (message.name !== 'vessel:notice' || typeof message.content !== 'string') continue;
    const head = message.content.split('\n', 1)[0] ?? '';
    if (head.startsWith('model: ') && head.includes(transition)) return true;
  }
  return false;
}
