/**
 * 视觉基座的能力形状与注册点（0.56 P0）
 * @module @vessel-agent/core/provider
 *
 * ## 这个文件里为什么**没有**任何一种 provider 的块形状
 *
 * 宪法第十三条（插件优先）：核心拥有「形状与注册」，不拥有任何一种实现。所以这里只有
 * 三件东西 —— ① `VisionBackend`（能力描述 + 一个把规范部件翻成请求块的出口）；
 * ② 规范部件（`CanonicalImagePart`，三家都有对应物的三个事实）；③ `AttachmentPlan`
 * （「这一轮要发哪几张图」的决策结果，只活在**一次请求**里）。
 *
 * deepseek 的 `{type:'image_url'}` / Anthropic 的 `{type:'image', source:{…}}` /
 * Gemini 的 `inline_data` **一个字都不在这里**：它们是各插件的 `toRequestPart` 实现。
 * 连「哪些字节算 png」也不在这里（`sniffImageMime` 由后端提供），因为格式嗅探是能力，
 * 不是不变量。
 *
 * ## 三条不变量（改这里之前先读）
 *
 * 1. **图片字节永不进 `Message`**：`Message.content` 仍是 `string`，图只有 `refs` 里的
 *    一条引用（`{kind:'image', path, sha256}`）。字节只出现在 `CanonicalImagePart` 与
 *    请求体的块里 —— 于是 `prompt-prefix-guard.ts` 的 `JSON.stringify(message)`
 *    （逐字节比）与 8 KiB 线上裁剪（`tool-events.ts`）都不受影响。
 * 2. **同一 sha256 ⇒ 同一字节 ⇒ 同一 base64**：`AttachmentPlan` 是**确定性**函数
 *    （输入 = `messages` + 后端描述符 + 预算；I/O 只有一个「按 sha256 读 blob」）。
 *    这条是「同一条带图消息连续 3 次请求逐字节相同」的实现基础。
 * 3. **计价只认 `tokenCost()`**：图片 token 永远不按 base64 字符数估
 *    （1 MiB 图 ≈ 1,398,104 个 base64 字符，字符口径 ≈ 432k token，provider 只收 ≤1024
 *    —— 420 倍误差）。见 `context/request-view.ts` 的 `attachments` 入参。
 */

/**
 * 后端的处置方式：`native` = 真把像素给主模型；`derived` = 转成文字（OCR / describe）。
 *
 * P0 只接 `native`；`derived` 的类型先立着（P1 的 tesseract / describe-bridge 直接用，
 * 不重新发明形状）。
 */
export type VisionBackendKind = 'native' | 'derived';

/**
 * 规范部件：**一张图**。刻意只有「三家都有对应物」的字段。
 *
 * 不抄 OpenAI 的 `{type:'image_url', image_url:{url, detail}}`：那个 `url` 字段会诱导把
 * dataURL 拼进字符串（就是 420 倍误差的入口）。`detail` 也只保留「意图」这一层语义，
 * 闭集由后端 `detailLevels()` 给（Anthropic 没有这个字段、Gemini 是 `media_resolution`）。
 */
export interface CanonicalImagePart {
  /** 内容嗅探得到的 MIME（**不信**扩展名与 `refs[].mime`） */
  media_type: string;
  /** 字节（来自 blob，只读副本） */
  bytes: Uint8Array;
  /** 64 位十六进制；blob 名、去重、GC 引用集合与「同一串字节」的唯一依据 */
  sha256: string;
  /** 精度意图；只能取 `detailLevels()` 里的值（不在闭集里就不带） */
  detail?: string;
  /** 来源引用（审计用：哪条 `MessageRef` 来的） */
  source?: { path: string; name?: string };
}

/**
 * provider 请求块：形状由后端决定，core 只当不透明值搬运。
 *
 * 之所以是 `unknown` 而不是联合类型：一联合就变成「core 认识 N 家的形状」，
 * 加第 N+1 家就要改 core —— 那正是本设计要避免的（§12 的扩展成本判据）。
 */
export type RequestContentPart = Record<string, unknown>;

/**
 * 视觉后端（能力描述符 + 一个出口）。实现**必须在插件里**（宪法第十三条）。
 *
 * 8 个方法 + 2 个标识字段。缺省/降级规则见各方法注释；「不知道怎么答」时一律
 * 走**更保守**的那一支（不支持 / 0 张 / 0 字节），让调用方明确拒绝而不是静默降级。
 */
export interface VisionBackend {
  /** 稳定标识（`openai-compat` / `anthropic` / `tesseract` / …）。日志与 `[refs]` 尾注用。 */
  readonly id: string;
  /** `native`（真把图给主模型）/ `derived`（转成文字） */
  readonly kind: VisionBackendKind;
  /** 是否接收图块。`false` ⇒ 一条都不内联（不是「试试看」）。 */
  supportsImage(): boolean;
  /** 接受的 MIME 闭集（小写，`image/png` 形式）。空集 = 不接受任何图。 */
  formats(): readonly string[];
  /** 单请求最多几张；0 = 一张都不发。 */
  maxImagesPerRequest(): number;
  /** 单图字节上限；0 = 不设限（由 `maxBytesPerRequest` 兜）。 */
  maxBytesPerImage(): number;
  /** 整包字节上限（含其它内容的余量由调用方留）；0 = 不设限。 */
  maxBytesPerRequest(): number;
  /** 精度闭集（`low|high|auto` 之类）；空集 = 该传输没有精度概念。 */
  detailLevels(): readonly string[];
  /**
   * **计价函数**：`images` 张图的 token 上界。
   *
   * 只许高报（`context/request-view.ts` 合同 5）。缺省实现见
   * `conservativeTokenCost`（1024/张 × 2）；具体公式属于后端（deepseek 是 1024×N）。
   */
  tokenCost(images: number): number;
  /**
   * 按内容嗅探 MIME（magic bytes）。不认识 / 不是图片 ⇒ `undefined`。
   *
   * 为什么在后端而不在 core：**格式知识是能力**（宪法第十三条）。core 只负责
   * 「嗅探结果与 `formats()` 不符 ⇒ 明确拒绝」，不负责知道 PNG 的头是 `89 50 4E 47`。
   */
  sniffImageMime?(bytes: Uint8Array): string | undefined;
  /**
   * 规范部件 → 该传输的请求块。
   *
   * **不许静默当文本**：后端不支持时必须抛错（由 plan 在调用前用 `formats()` 保证
   * 不会发生）；把它降级成 `{type:'text'}` 就是「图没发出去但没人知道」。
   */
  toRequestPart(part: CanonicalImagePart): RequestContentPart;
  /** 需要的环境变量**名**（`describe-bridge` 之类旁路后端用；只存名字，不存值）。 */
  readonly keyEnv?: string;
}

/**
 * 一条图**没发出去**的原因（闭集；GUI 三态 chip 的「已丢弃 / 未发送」文案就按它分档）。
 *
 * 分成两组是为了 GUI 的两个状态：
 * - `dropped`（预算 / 格式 / 字节 / 缺 blob）：这一轮**算过、决定不发**；
 * - `not_sent`（kill switch / 无视觉后端 / 没入池）：**根本没进这条通路**。
 */
export type ImageDropReason =
  | 'budget'
  | 'bytes_budget'
  | 'unsupported_format'
  | 'not_an_image'
  | 'too_large'
  | 'blob_missing'
  | 'not_ingested'
  | 'vision_disabled'
  | 'no_vision'
  | 'placeholder'
  | 'compaction';

/** 一张被丢弃的图（`AttachmentPlan.dropped`） */
export interface DroppedImage {
  /** 该图所在消息在**本次请求视图**里的下标 */
  message_index: number;
  /** 入池过的图有 sha256；没入池（旧数据 / 未落 blob）就缺省 */
  sha256?: string;
  path: string;
  reason: ImageDropReason;
}

/** 一张真要发出去的图（已由后端翻成请求块，字节已冻结） */
export interface PlannedImage {
  message_index: number;
  sha256: string;
  media_type: string;
  /** 字节数（不是字符数、不是 base64 长度） */
  bytes: number;
  path: string;
  name?: string;
  /** 后端算出的线上块（确定性：同一 sha256 + 同一 detail ⇒ 同一对象内容） */
  part: RequestContentPart;
}

/**
 * 一次请求的图片计划。**只活在 `ChatRequest` 到 `fetch` 之间**：
 * 不进 `Message`、不进 session、不进事件（事件只记 sha8 / tokens / 原因）。
 */
export interface AttachmentPlan {
  /** 消息下标 → 这条消息要带的图（顺序 = `refs` 里的顺序，逐字节稳定） */
  readonly byMessageIndex: ReadonlyMap<number, readonly PlannedImage[]>;
  /** `tokenCost(张数)`：**唯一**的图片计价口径（进 `estimateRequestViewTokens`） */
  readonly tokens: number;
  /** 实际内联的张数 */
  readonly images: number;
  /** 合计字节（整包预算用） */
  readonly bytes: number;
  /** 没发出去的（含原因）；GUI 三态 chip 与事件的数据源 */
  readonly dropped: readonly DroppedImage[];
  /** 后端标识（`native`/`derived` + id）；无后端时缺省 */
  readonly backend?: { id: string; kind: VisionBackendKind };
  /** kill switch 命中（`vision.disabled` / `VESSEL_DISABLE_VISION=1`）：一律不内联 */
  readonly disabled?: boolean;
}

/** 空的计划（无图 / 未启用）：`estimateRequestViewTokens` 要显式传它，不许省略。 */
export const EMPTY_ATTACHMENT_PLAN: AttachmentPlan = {
  byMessageIndex: new Map(),
  tokens: 0,
  images: 0,
  bytes: 0,
  dropped: [],
};

/**
 * 视觉的运行期设置（**不是**能力）：能力问后端，设置问配置。
 *
 * 刻意没有 `enable` 这个键：决策 1 = 支持即直通，`disabled` 只是**运行时 kill switch**
 * （出事了先停住），不是默认门。见 design §0.1 / §4.4。
 */
export interface VisionSettings {
  /** kill switch：`vision.disabled: true` 或 `VESSEL_DISABLE_VISION=1` */
  disabled?: boolean;
  /** 单请求张数上限（与后端描述符取 `min`）；缺省 6 */
  maxImagesPerRequest?: number;
  /** 精度意图（必须落在后端 `detailLevels()` 里，否则不带） */
  detail?: string;
  /** P0 = `none`（identity）。`fit:1300` 属 P1：产出新字节必须写回 `refs.sha256`。 */
  preprocess?: string;
}

/** 保守计价（后端没给公式时）：1024/张 × 2，只许高报（合同 5）。 */
export function conservativeTokenCost(images: number): number {
  if (!Number.isFinite(images) || images <= 0) return 0;
  return Math.ceil(images) * 1024 * 2;
}
