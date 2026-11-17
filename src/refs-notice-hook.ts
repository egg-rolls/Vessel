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
 * ## 0.56 P1：三档文案（「图已经在你眼前了」）
 *
 * 旧文案只有一句「用 media 读」——可 0.56 起图片会**随请求内联**，模型已经亲眼看到图，
 * 再让它 `media: read` 一遍就是**双倍花费**（还白占上下文）。所以尾注分三档：
 *
 * 1. **已发送**（视觉可用且这批图已入池 ⇒ 会随本条消息附上）：明说「你已经在看它，
 *    **不要再读**」；只有「没附上的那些」（超预算被丢 / 不是图片 / 文档）才给 media 的读法；
 * 2. **未发送 / 被丢**（视觉可用但这批图没入池：没有内容地址 ⇒ 一定不会被内联）：照旧点名
 *    media 读本地文件；
 * 3. **无视觉能力**（provider 没有 `VisionBackend` / kill switch 打开）：**0.55 老文案逐字
 *    不变**（`tailFor(media)` 那一套，一个字符都不动）。
 *
 * 判据只用**事实**：视觉能力来自装配层探针（`provider.vision` 是否存在 + `disabled`），
 * 「会不会内联」看这张图有没有 `sha256`（没有 = 从没入池 = 一定不内联）。**不猜**本轮
 * 预算会不会刚好把它挤掉：档 1 的文案自带兜底半句（「没附上的那些用 media 读」），所以
 * 即使某张图被预算/格式挡下，模型也不会读到一句与事实相反的话。
 *
 * ## 前缀不变（旧会话逐字节不变）
 *
 * 尾注是 `vessel:notice` 尾消息，属于**前缀守卫**比较的那串字节。所以新文案必须只对
 * 「新会话 / 还没发出的请求」生效，机制是三条（不是靠自觉）：
 * - 注入永远是**在末尾追加**一条消息（`ctx.messages = [...ctx.messages, notice]`），
 *   从不改写既有消息 —— 前缀守卫要求「新序列以旧序列为前缀」，追加天然满足；
 * - 历史里的 notice 永远不会被**重新渲染**：`projectMessages` 只从事件投影，
 *   带 `name` 的提示行（`vessel:notice`）不可能由事件产生（`isCacheOnlyMessage`），
 *   它们只来自会话壳缓存；`reconcileCachedProjection` 对缓存专属消息是**原地保留**
 *   （只追加日志多出来的尾部），因此重启 / 刷新 / 补投影都不会重算旧文案；
 * - 同一批引用在本进程内按签名去重（`signatureOf`），不会「先旧文案后新文案」同批两次。
 * 结论：升级后旧会话的请求字节**一个字节都不变**；新文案只出现在**首次**注入的批次上
 *（新会话、或从没发出去过的请求）。真正会重算文案的只有显式分段（压缩 / 撤回），
 * 那本来就是带 `reason` 的允许变更。
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
 * 三档 → 尾注文案（唯一的老文案判定处；**0.55 行为逐字保留**）。
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

/**
 * 视觉面（0.56 P1）：这批图会不会**随本条消息**一起给模型。
 *
 * 判据与 `vision/plan.ts` 同一组前提，但只声明能确定的那部分：
 * - `inline`：provider 有 `VisionBackend` 且 kill switch 没打开 ⇒ 已入池的图会被内联；
 * - `off`：没有视觉后端 / 被 `vision.disabled` 或 env 关掉 ⇒ 图一定不会内联 ⇒ 老文案。
 */
export type VisionSurface = { readonly availability: 'inline' } | { readonly availability: 'off' };

export const VISION_SURFACE_INLINE: VisionSurface = { availability: 'inline' };
export const VISION_SURFACE_OFF: VisionSurface = { availability: 'off' };

/** 「还没附上、要自己读」的那半句：有点名工具的动作列表就点名，否则退中性表述。 */
function tailNeedsReading(media: MediaSurface | undefined): string {
  if (media !== undefined && media.availability === 'actions' && media.actions.length > 0) {
    return `use media: action=${[...new Set(media.actions)].join('|')}`;
  }
  return 'read it with your tools';
}

/**
 * 档 1（已发送）：图**就在本条消息里**，明说不要再读（双倍花费）。
 *
 * `rest` 指「同批里没被附上的那些」（没入池的图 / 文档 / 其它文件）：它们照样要自己读。
 */
function tailInlined(media: MediaSurface | undefined, rest: boolean): string {
  const head = 'images attached to this message \u2014 do not read them again';
  return rest ? `(${head}; the rest: ${tailNeedsReading(media)})` : `(${head})`;
}

/**
 * 档 2（未发送 / 被丢）：这批图**没有内容地址**，一定不会被内联 ⇒ 只能读本地文件。
 */
function tailWithheld(media: MediaSurface | undefined): string {
  if (media !== undefined && media.availability === 'absent') return TAIL_MEDIA_UNAVAILABLE;
  return `(content not attached \u2014 ${tailNeedsReading(media)})`;
}

/** 这批引用里，哪些还需要模型自己读（图已入池不算）。 */
interface RefsTailNeeds {
  /** 至少一张图已入池（配合 `inline` ⇒ 会随本条消息附上） */
  inlinableImage: boolean;
  /** 还有别的要自己读的东西（没入池的图 / 文档 / 其它文件种类） */
  rest: boolean;
}

function tailNeedsOf(refs: readonly MessageRef[], vision: VisionSurface): RefsTailNeeds {
  let inlinableImage = false;
  let rest = false;
  for (const ref of refs) {
    if (ref.kind === 'file') continue;
    if (ref.kind === 'image' && vision.availability === 'inline' && ref.sha256 !== undefined) {
      inlinableImage = true;
      continue;
    }
    rest = true;
  }
  return { inlinableImage, rest };
}

/**
 * 三档判定（0.56 P1；**唯一的判定处**）。
 *
 * 顺序即语义：无视觉能力 ⇒ 老文案**逐字不变**（连档 2 的措辞都不进这条路）；
 * 有视觉能力时，看这批图有没有能内联的：有 ⇒ 档 1，没有 ⇒ 档 2。
 */
function tailForBatch(
  refs: readonly MessageRef[],
  media: MediaSurface | undefined,
  vision: VisionSurface,
): string {
  if (vision.availability === 'off') return tailFor(media);
  const needs = tailNeedsOf(refs, vision);
  if (needs.inlinableImage) return tailInlined(media, needs.rest);
  return tailWithheld(media);
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
 * [refs] 1 attachment: image /home/a.png (images attached to this message — do not read them again)
 * [refs] 2 attachments: image /a.png, document /b.pdf (images attached to this message — do not read them again; the rest: use media: action=read|ocr|describe)
 * [refs] 1 attachment: image /home/a.png (content not attached — use media: action=read|ocr|describe)
 * [refs] 1 attachment: image /home/a.png (use media: action=read|ocr|describe)
 * [refs] 1 attachment: image /home/a.png (content not injected; enable the media plugin to read image/document)
 * [refs] 1 attachment: image /home/a.png (content not injected; read it with your tools)
 * [refs] 5 attachments: image /a.png, document /b.pdf, file /c.md, +2 more (use media: action=read|describe)
 * ```
 *
 * 前三行是 0.56 P1 的三档；后四行是 0.55 的老文案（无视觉能力时逐字不变）。
 *
 * 尾注只在**有非 `file` 种类**（image / document）时加：纯 `file` 批次用内置 `read`
 * 就能读，尾注纯属 token 税，而且正是最容易说错的那半句。
 *
 * @param media 媒体工具面三档（`readMediaSurface` 的结果）：`actions` 点名真实动作，
 *   `absent` 说明怎么启用，`unknown` / 缺省走中性文案。
 * @param vision 视觉面（缺省 = `off` ⇒ 老文案，这是一条**故意的**保守缺省：
 *   不知道有没有视觉时，宁可让模型多读一次，也不要骗它「你已经在看了」）。
 */
export function formatRefsLine(
  refs: readonly MessageRef[],
  media?: MediaSurface,
  vision: VisionSurface = VISION_SURFACE_OFF,
): string {
  const shown = refs.slice(0, REFS_NOTICE_LIST_MAX);
  const rest = refs.length - shown.length;
  const items = shown.map((ref) => `${kindWord(ref.kind)} ${ref.path}`);
  if (rest > 0) items.push(`+${rest} more`);
  const noun = refs.length === 1 ? 'attachment' : 'attachments';
  const head = `[refs] ${refs.length} ${noun}: ${items.join(', ')}`;
  // 判断用**全部**引用（不只是列出来的前 3 条）：第 5 条是图片，尾注照样需要。
  if (!refs.some((ref) => ref.kind !== 'file')) return head;
  return `${head} ${tailForBatch(refs, media, vision)}`;
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
  /**
   * 视觉面探针（0.56 P1，`VisionSurface`）：这张图会不会随本条消息内联给模型。
   *
   * - 函数：实时探针（配置热应用打开 kill switch 之后，下一批引用就回落老文案）；
   * - 缺省 = `off`（老文案逐字不变）。**故意的保守缺省**：不知道有没有视觉时，
   *   宁可让模型多读一次图，也不要骗它「你已经在看了」—— 猜「已发送」是最坏的一类错。
   */
  visionSurface?: VisionSurface | (() => VisionSurface);
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

/** 解析 `visionSurface`；探针自己抛错也退化成 `off`（老文案），绝不让一轮请求失败。 */
function resolveVisionSurface(option: RefsNoticeOptions['visionSurface']): VisionSurface {
  if (option === undefined) return VISION_SURFACE_OFF;
  if (typeof option !== 'function') return option;
  try {
    const value = option();
    return value?.availability === 'inline' ? value : VISION_SURFACE_OFF;
  } catch {
    return VISION_SURFACE_OFF;
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
        content: formatRefsLine(
          refs,
          resolveMediaSurface(options.mediaSurface),
          resolveVisionSurface(options.visionSurface),
        ),
        timestamp: Date.now(),
      };
      ctx.messages = [...(ctx.messages ?? []), message];
      remember(key, signature);
    },
  };
}
