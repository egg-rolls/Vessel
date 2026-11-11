/**
 * 附件引用的环境信息行（0.52）：`[refs] N attachments: kind path, … (use media.read)`。
 *
 * 为什么需要这一行：refs **不进请求体**（只有路径，没有正文）。不给模型任何提示，
 * 它就不知道这一轮带了附件，多模态解析工具永远没人调 —— 附件等于摆设。
 *
 * 为什么只有一行、且只在变化时注入：
 * - 正文进上下文是每轮固定 token 税，refs 的内容必须由工具按需读，不能在这里预读；
 * - 同一批引用在后续轮次（同一 run 的多次 LLM 请求、以及重复发送同一条消息）不该
 *   反复追加同样的行 —— 历史里已经在，重复只烧 token 还把窗口越堆越乱；
 * - 超过 3 条只列前 3 条 + `+N more`：路径本身也是 token，28 条路径会把这一行变成一大段。
 *
 * 注入通道是既有的 `vessel:notice` 尾消息（`runtime-notice-hook` 同族，走 BeforeLlm 的
 * `ctx.messages`，不新建事件、不动 system 前缀）：Web 按 `env-notice.ts` 渲成环境信息卡，
 * scope 落到兜底 `context`。refs 本身仍不进 `RunOptions.messages`（契约 §0.2）。
 *
 * @module vessel/refs-notice-hook
 */

import { type Hook, HookType, type Message, type MessageRef } from '../packages/core/src/index';

/** 注册名（幂等注册用） */
export const REFS_NOTICE_HOOK = 'refs-notice';

/** 一行里最多列几条路径（其余用 `+N more` 折叠）。 */
export const REFS_NOTICE_LIST_MAX = 3;

/** 记住多少个 session 的上一次引用签名（防长期运行无界增长）。 */
const MAX_TRACKED_SESSIONS = 200;

/** 引用种类 → 行内词（与 web 的 `chat.refs.kind.*` 同一套词，但这里给模型看）。 */
function kindWord(kind: MessageRef['kind']): string {
  return kind === 'image' ? 'image' : kind === 'document' ? 'document' : 'file';
}

/**
 * 一批引用 → 一行环境信息（纯函数，便于单独读「这一行到底长什么样」）。
 *
 * 样例：
 * ```
 * [refs] 1 attachment: image /home/a.png (use media.read)
 * [refs] 5 attachments: image /a.png, document /b.pdf, file /c.md, +2 more (use media.read)
 * ```
 */
export function formatRefsLine(refs: readonly MessageRef[]): string {
  const shown = refs.slice(0, REFS_NOTICE_LIST_MAX);
  const rest = refs.length - shown.length;
  const items = shown.map((ref) => `${kindWord(ref.kind)} ${ref.path}`);
  if (rest > 0) items.push(`+${rest} more`);
  const noun = refs.length === 1 ? 'attachment' : 'attachments';
  // 工具名写死在文案里：这一行的唯一目的就是让模型知道「用哪个工具读」。
  return `[refs] ${refs.length} ${noun}: ${items.join(', ')} (use media.read)`;
}

/** 一次判定用的签名：种类 + 路径按顺序（同一路径两次引用也算两处）。 */
function signatureOf(refs: readonly MessageRef[]): string {
  return refs.map((ref) => `${ref.kind}:${ref.path}`).join('\u0000');
}

export function createRefsNoticeHook(): Hook {
  /** session_id → 上一次注入的引用签名；`''` 表示「上一轮没有引用」。 */
  const lastBySession = new Map<string, string>();

  const remember = (key: string, signature: string): void => {
    lastBySession.delete(key);
    lastBySession.set(key, signature);
    while (lastBySession.size > MAX_TRACKED_SESSIONS) {
      const oldest = lastBySession.keys().next().value;
      if (oldest === undefined) break;
      lastBySession.delete(oldest);
    }
  };

  return {
    name: REFS_NOTICE_HOOK,
    type: HookType.BeforeLlm,
    async run(ctx): Promise<void> {
      const key = ctx.session_id ?? '';
      const refs = ctx.refs;
      if (refs === undefined || refs.length === 0) {
        // 本轮没有引用：忘掉上一次的签名。下一批同样的引用必须再报一次
        //（中间隔了一条没有附件的消息，模型看到的那一行已经不在「最近」的位置上）。
        lastBySession.delete(key);
        return;
      }
      const signature = signatureOf(refs);
      if (lastBySession.get(key) === signature) return;
      const message: Message = {
        role: 'user',
        name: 'vessel:notice',
        content: formatRefsLine(refs),
        timestamp: Date.now(),
      };
      ctx.messages = [...(ctx.messages ?? []), message];
      remember(key, signature);
    },
  };
}
