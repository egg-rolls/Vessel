/**
 * 附件引用的环境信息行（0.52）：`[refs] N attachments: kind path, … (use media: action=read|ocr|describe)`。
 *
 * 为什么需要这一行：refs **不进请求体**（只有路径，没有正文）。不给模型任何提示，
 * 它就不知道这一轮带了附件，多模态解析工具永远没人调 —— 附件等于摆设。
 *
 * 尾注只描述**真实存在**的工具面（2026-11 事故）：
 * - media 是**单个工具 `media` + `action` 参数**（`action: read | ocr | describe`，
 *   见 `plugins/media/media/src/tool.ts`），**不是** `media.read` 这种点号方法名。
 *   曾经这里写死 `(use media.read)`，模型照字面调 → 「工具不存在」，附件永远读不到。
 *   **不要再把工具名写成 media.read**（2026-11 真实误用过）。
 * - media 是 opt-in 插件（`OPT_IN_PLUGINS`），未启用时模型侧**根本没有**这个工具；
 *   此时再让它「use media」是把它推向必然失败。所以尾注分三档，且可用性由装配层传入
 *   （`createRefsNoticeHook({ mediaAvailable })`），本模块不猜。
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

/**
 * 媒体工具的**工具名**（不是方法名）：media 插件只暴露这一个工具，
 * 动作靠 `action: read | ocr | describe` 区分。
 *
 * 装配层用它判「媒体工具是否真的可用」（见 `registerRefsNoticeHook`）。
 */
export const MEDIA_TOOL_NAME = 'media';

/** media 确定可用：点名工具 + 说明动作走 `action` 参数（**不写 `media.read`**）。 */
const TAIL_MEDIA_AVAILABLE = '(use media: action=read|ocr|describe)';

/**
 * media 确定不可用（插件没启用 / 没装后端因此没注册工具）：
 * 只说明「正文没进上下文」和怎么开，**绝不点名一个不存在的工具**。
 */
const TAIL_MEDIA_UNAVAILABLE =
  '(content not injected; enable the media plugin to read image/document)';

/**
 * 可用性未知（旧调用点 / 单测没传参数）：中性表述。
 *
 * 为什么不默认点名 media：不知道就别断言。指向一个可能不存在的工具，模型必然
 * 调用失败（2026-11 事故就是这样）；反过来断言「media 不可用」也可能假。中性文案
 * 两边都不撒谎，且仍然告诉模型「路径是路径，正文得自己读」。
 */
const TAIL_MEDIA_UNKNOWN = '(content not injected; read it with your tools)';

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
 * [refs] 1 attachment: file /home/a.md
 * [refs] 1 attachment: image /home/a.png (use media: action=read|ocr|describe)
 * [refs] 1 attachment: image /home/a.png (content not injected; enable the media plugin to read image/document)
 * [refs] 1 attachment: image /home/a.png (content not injected; read it with your tools)
 * [refs] 5 attachments: image /a.png, document /b.pdf, file /c.md, +2 more (use media: action=read|ocr|describe)
 * ```
 *
 * 尾注只在**有非 `file` 种类**（image / document）时加：纯 `file` 批次用内置 `read`
 * 就能读，尾注纯属 token 税，而且正是最容易说错的那半句。
 *
 * @param mediaAvailable 媒体工具是否可用：`true` / `false` 按事实说话；`undefined`
 *   （旧调用点、单测）走中性文案。
 */
export function formatRefsLine(refs: readonly MessageRef[], mediaAvailable?: boolean): string {
  const shown = refs.slice(0, REFS_NOTICE_LIST_MAX);
  const rest = refs.length - shown.length;
  const items = shown.map((ref) => `${kindWord(ref.kind)} ${ref.path}`);
  if (rest > 0) items.push(`+${rest} more`);
  const noun = refs.length === 1 ? 'attachment' : 'attachments';
  const head = `[refs] ${refs.length} ${noun}: ${items.join(', ')}`;
  // 判断用**全部**引用（不只是列出来的前 3 条）：第 5 条是图片，尾注照样需要。
  if (!refs.some((ref) => ref.kind !== 'file')) return head;
  const tail =
    mediaAvailable === true
      ? TAIL_MEDIA_AVAILABLE
      : mediaAvailable === false
        ? TAIL_MEDIA_UNAVAILABLE
        : TAIL_MEDIA_UNKNOWN;
  return `${head} ${tail}`;
}

/** 一次判定用的签名：种类 + 路径按顺序（同一路径两次引用也算两处）。 */
function signatureOf(refs: readonly MessageRef[]): string {
  return refs.map((ref) => `${ref.kind}:${ref.path}`).join('\u0000');
}

/** `createRefsNoticeHook` 的装配参数。 */
export interface RefsNoticeOptions {
  /**
   * 媒体工具（`media`，单工具 + `action` 参数）是否可用。
   *
   * - 布尔值：注册时的快照；
   * - 函数：实时探针，每轮 BeforeLlm 求值一次。装配层应传函数——插件工具面会被
   *   热应用改写（cli 的 tools applier 在同一 host 上增删工具），快照会过期；
   * - 缺省：不知道 → 中性文案（见 `TAIL_MEDIA_UNKNOWN`）。
   */
  mediaAvailable?: boolean | (() => boolean);
}

/** 解析 `mediaAvailable`；探针自己抛错也退化成「不知道」，绝不让一轮 LLM 请求失败。 */
function resolveMediaAvailable(option: RefsNoticeOptions['mediaAvailable']): boolean | undefined {
  if (option === undefined) return undefined;
  if (typeof option !== 'function') return option;
  try {
    return option();
  } catch {
    return undefined;
  }
}

export function createRefsNoticeHook(options: RefsNoticeOptions = {}): Hook {
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
      // 尾注按**当前**工具面求值（不是注册时定格）：热应用启用/停用 media 之后，
      // 新的一批引用会用当时的真实工具面说话，不会继续指着一个已经不存在的工具。
      // 注意：去重仍只看引用签名（signatureOf 语义不变），同一批引用不会因为
      // 工具面变化而重报 —— 那是刻意保留的「只报一次」不变量。
      const message: Message = {
        role: 'user',
        name: 'vessel:notice',
        content: formatRefsLine(refs, resolveMediaAvailable(options.mediaAvailable)),
        timestamp: Date.now(),
      };
      ctx.messages = [...(ctx.messages ?? []), message];
      remember(key, signature);
    },
  };
}
