/**
 * 附件引用的环境信息行（0.52）：`[refs] N attachments: kind path, … (use media: action=read|ocr)`。
 * （动作那段是**本机实测的**，不是全集 —— 见下面「动作列表也不是全集」。）
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
 *   （`createRefsNoticeHook({ mediaSurface })`），本模块不猜。
 * - **动作列表也不是全集**（0.51 #7）：media 插件按**实测到的后端**决定 schema 里
 *   `action` 的 enum（`supportedActions`：没装 tesseract 就没有 `ocr`，没配多模态桥
 *   就没有 `describe`）。写死 `action=read|ocr|describe` 等于让模型去填一个 schema 里
 *   不存在的值 —— 与当年写死 `media.read` 是同一类错。所以动作名由
 *   `readMediaSurface(host.listTools())` 从**宿主真实工具面**读，读不到就退中性档。
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

import {
  type Hook,
  HookType,
  type Message,
  type MessageRef,
  type ToolDefinition,
} from '../packages/core/src/index';

/** 注册名（幂等注册用） */
export const REFS_NOTICE_HOOK = 'refs-notice';

/** 一行里最多列几条路径（其余用 `+N more` 折叠）。 */
export const REFS_NOTICE_LIST_MAX = 3;

/**
 * 媒体工具的**工具名**（不是方法名）：media 插件只暴露这一个工具，
 * 动作靠 `action: read | ocr | describe` 区分。
 *
 * `readMediaSurface` 用它从 `host.listTools()` 里挑工具（装配层不必自己认工具名）。
 */
export const MEDIA_TOOL_NAME = 'media';

/**
 * 媒体工具面的**三档事实**（装配层每轮 BeforeLlm 现算一次后传进来）。
 *
 * 为什么是三档而不是布尔：`media` 工具存在 ≠ 能读出动作列表。schema 是插件自描述的
 * `Record<string, unknown>`（见 core `ToolDefinition.inputSchema`），读不到时必须能说
 * 「不知道」—— 硬判「不可用」会撒谎（工具明明在），硬列全集又会指一个不存在的动作。
 */
export type MediaSurface =
  /** 工具在，且 schema 里读到了非空动作列表（按 schema 里的真实顺序） */
  | { readonly availability: 'actions'; readonly actions: readonly string[] }
  /** 工具不在（插件没启用 / 零可用后端因此没注册工具） */
  | { readonly availability: 'absent' }
  /** 说不清：没有探针、schema 没有 enum、或探针自己抛错 */
  | { readonly availability: 'unknown' };

/** 三档里不带 payload 的两档（共用常量，省得每轮新建对象）。 */
export const MEDIA_SURFACE_ABSENT: MediaSurface = { availability: 'absent' };
export const MEDIA_SURFACE_UNKNOWN: MediaSurface = { availability: 'unknown' };

/** 值是否为「非数组对象记录」（读 schema 前必须先收窄）。 */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * `inputSchema.properties.action.enum` → 动作名列表；任何一环缺失都返回空数组。
 *
 * 空数组的含义是「读不到」，由调用方决定退中性档 —— 这里**不猜**（不回落全集，
 * 也不拿 `description` 里的 `read | ocr | describe` 当数据）。
 */
function actionEnumOf(schema: Record<string, unknown>): string[] {
  const properties = recordOf(schema.properties);
  const action = properties === undefined ? undefined : recordOf(properties.action);
  const values = action === undefined ? undefined : action.enum;
  if (!Array.isArray(values)) return [];
  return values.filter(
    (value): value is string => typeof value === 'string' && value.trim() !== '',
  );
}

/**
 * 宿主工具面 → 媒体三档（纯函数，装配层只负责把 `host.listTools()` 递进来）。
 *
 * 判据是**模型看到的同一份工具面**：`ExecutionUnit.listToolSchemas()` 也是
 * `pluginHost.listTools()`，所以断言与事实同源（插件名单、插件目录都不算数）。
 */
export function readMediaSurface(tools: readonly ToolDefinition[]): MediaSurface {
  try {
    const tool = tools.find((candidate) => candidate.name === MEDIA_TOOL_NAME);
    if (tool === undefined) return MEDIA_SURFACE_ABSENT;
    const actions = actionEnumOf(tool.inputSchema);
    // 工具在但读不到 enum：不断言「不可用」，也不编动作名。
    return actions.length === 0 ? MEDIA_SURFACE_UNKNOWN : { availability: 'actions', actions };
  } catch {
    // `inputSchema` 带 getter / Proxy 之类，读的时候可能抛；探针抛错绝不能连累这一轮
    // LLM 请求，退中性档（与 `resolveMediaSurface` 的 catch 同一口径）。
    return MEDIA_SURFACE_UNKNOWN;
  }
}

/**
 * media 确定不可用（插件没启用 / 没装后端因此没注册工具）：
 * 只说明「正文没进上下文」和怎么开，**绝不点名一个不存在的工具**。
 */
const TAIL_MEDIA_UNAVAILABLE =
  '(content not injected; enable the media plugin to read image/document)';

/**
 * 可用性未知（没有探针 / schema 读不到动作）：中性表述。
 *
 * 为什么不默认点名 media：不知道就别断言。指向一个可能不存在的工具，模型必然
 * 调用失败（2026-11 事故就是这样）；反过来断言「media 不可用」也可能假。中性文案
 * 两边都不撒谎，且仍然告诉模型「路径是路径，正文得自己读」。
 */
const TAIL_MEDIA_UNKNOWN = '(content not injected; read it with your tools)';

/**
 * media 确定可用：点名工具 + schema 里的**真 action**（**不写 `media.read`**）。
 *
 * 顺序沿用 schema（插件按 `supportedActions` 的稳定顺序拼），去重只防脏 schema 把
 * 同一动作写两遍。
 */
function tailWithActions(actions: readonly string[]): string {
  return `(use media: action=${[...new Set(actions)].join('|')})`;
}

/**
 * 三档 → 尾注文案（唯一的判定处）。
 *
 * `undefined` 也走中性档：旧调用点 / 单测没给探针时，宁可不说也不说谎。
 */
function tailFor(media: MediaSurface | undefined): string {
  if (media === undefined) return TAIL_MEDIA_UNKNOWN;
  if (media.availability === 'absent') return TAIL_MEDIA_UNAVAILABLE;
  if (media.availability === 'actions' && media.actions.length > 0) {
    return tailWithActions(media.actions);
  }
  return TAIL_MEDIA_UNKNOWN;
}

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
 * [refs] 1 attachment: image /home/a.png (use media: action=read|ocr)
 * [refs] 1 attachment: image /home/a.png (content not injected; enable the media plugin to read image/document)
 * [refs] 1 attachment: image /home/a.png (content not injected; read it with your tools)
 * [refs] 5 attachments: image /a.png, document /b.pdf, file /c.md, +2 more (use media: action=read|describe)
 * ```
 *
 * 尾注只在**有非 `file` 种类**（image / document）时加：纯 `file` 批次用内置 `read`
 * 就能读，尾注纯属 token 税，而且正是最容易说错的那半句。
 *
 * @param media 媒体工具面三档（`readMediaSurface` 的结果）：`actions` 点名真实动作，
 *   `absent` 说明怎么启用，`unknown` / 缺省走中性文案。
 */
export function formatRefsLine(refs: readonly MessageRef[], media?: MediaSurface): string {
  const shown = refs.slice(0, REFS_NOTICE_LIST_MAX);
  const rest = refs.length - shown.length;
  const items = shown.map((ref) => `${kindWord(ref.kind)} ${ref.path}`);
  if (rest > 0) items.push(`+${rest} more`);
  const noun = refs.length === 1 ? 'attachment' : 'attachments';
  const head = `[refs] ${refs.length} ${noun}: ${items.join(', ')}`;
  // 判断用**全部**引用（不只是列出来的前 3 条）：第 5 条是图片，尾注照样需要。
  if (!refs.some((ref) => ref.kind !== 'file')) return head;
  return `${head} ${tailFor(media)}`;
}

/** 一次判定用的签名：种类 + 路径按顺序（同一路径两次引用也算两处）。 */
function signatureOf(refs: readonly MessageRef[]): string {
  return refs.map((ref) => `${ref.kind}:${ref.path}`).join('\u0000');
}

/** `createRefsNoticeHook` 的装配参数。 */
export interface RefsNoticeOptions {
  /**
   * 媒体工具面探针（`MediaSurface`，见 `readMediaSurface`）。
   *
   * - 函数：实时探针，每轮 BeforeLlm 求值一次。装配层应传函数——插件工具面会被
   *   热应用改写（cli 的 tools applier 在同一 host 上增删工具），快照会过期；
   *   快照还会把「上一版 schema 的 action 列表」永远留在尾注里；
   * - 直接给值：注册时的快照（只有确定不变的场景才这么用）；
   * - 缺省：不知道 → 中性文案（见 `TAIL_MEDIA_UNKNOWN`）。
   */
  mediaSurface?: MediaSurface | (() => MediaSurface);
}

/** 解析 `mediaSurface`；探针自己抛错也退化成「不知道」，绝不让一轮 LLM 请求失败。 */
function resolveMediaSurface(option: RefsNoticeOptions['mediaSurface']): MediaSurface {
  if (option === undefined) return MEDIA_SURFACE_UNKNOWN;
  if (typeof option !== 'function') return option;
  try {
    // `??` 只为防非 TS 调用点返回 undefined（类型上探针不该返回它）。
    return option() ?? MEDIA_SURFACE_UNKNOWN;
  } catch {
    return MEDIA_SURFACE_UNKNOWN;
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
      // 尾注按**当前**工具面求值（不是注册时定格）：热应用启用/停用 media（或换掉
      // 后端、schema 的 action enum 跟着变）之后，新的一批引用会用当时的真实工具面
      // 说话，不会继续指着一个已经不存在的工具或动作。
      // 注意：去重仍只看引用签名（signatureOf 语义不变），同一批引用不会因为
      // 工具面变化而重报 —— 那是刻意保留的「只报一次」不变量。
      const message: Message = {
        role: 'user',
        name: 'vessel:notice',
        content: formatRefsLine(refs, resolveMediaSurface(options.mediaSurface)),
        timestamp: Date.now(),
      };
      ctx.messages = [...(ctx.messages ?? []), message];
      remember(key, signature);
    },
  };
}
