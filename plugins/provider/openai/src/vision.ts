/**
 * OpenAI 兼容传输的视觉后端（0.56 P0 的第一份实现）
 *
 * ## 为什么它在插件里（宪法第十三条）
 *
 * 核心只立形状（`VisionBackend` 接口 + `provider.vision` 注册点 + 计划机制），
 * **块长什么样、哪些字节算 png、一张图多少钱**都是能力。deepseek-flash 用的就是这个形状
 * （`{type:'image_url', image_url:{url: dataURL, detail}}`），所以它只是本文件的一个实例，
 * 不是基座本身。
 *
 * ## 三件事必须逐字节确定（否则前缀守卫报警）
 *
 * 1. `toRequestPart` 是**纯函数**：同一 `CanonicalImagePart` ⇒ 同一对象内容。base64 由
 *    Node 的 `Buffer.toString('base64')` 生成（确定性），不插入任何时间 / 随机 / 环境；
 * 2. 不重新编码、不缩放（P0 预处理 = identity）：provider 自己把图缩到 ~1300×1300；
 * 3. `detail` 只在后端闭集里出现时才带（不同传输的精度语义不同，别把 OpenAI 的词硬塞给别家）。
 *
 * ## 计价
 *
 * deepseek 文档：单图 ≤1024 token（与 `detail` 无关）。所以 `tokenCost = 1024 × 张数`。
 * 永不按 base64 字符数（1 MiB ≈ 1,398,104 字符，字符口径 ≈ 432k token —— 420 倍误差）。
 */

import type {
  CanonicalImagePart,
  RequestContentPart,
  VisionBackend,
} from '@vessel-agent/core';

/** deepseek / OpenAI 兼容端点的单图 token 上界（文档值，只许高报）。 */
export const OPENAI_COMPAT_TOKENS_PER_IMAGE = 1024;

/** 接受的格式闭集（内容嗅探的**结果**必须落在里面，否则明确拒绝）。 */
const FORMATS = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

/** 精度闭集（deepseek / OpenAI 的 `detail` 枚举）。 */
const DETAIL_LEVELS = ['low', 'high', 'auto', 'original'] as const;

/**
 * magic bytes 嗅探（**格式知识只在这里**，core 一个字都不认识）。
 *
 * 只读前 32 字节，不解码像素 —— 于是既不会有解压炸弹，也不需要任何编解码依赖。
 * 判据：PNG `89 50 4E 47`、JPEG `FF D8 FF`、GIF `GIF87a|GIF89a`、WEBP `RIFF....WEBP`。
 */
export function sniffImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.length < 12) return undefined;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  // 'G' 'I' 'F' 8 (7|9) 'a'
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return 'image/gif';
  }
  // 'R' 'I' 'F' 'F' .... 'W' 'E' 'B' 'P'
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return undefined;
}

export interface OpenAiCompatVisionOptions {
  /** 稳定标识（日志 / `[refs]` 尾注用）；缺省 `openai-compat` */
  id?: string;
  /** 单请求张数上限；缺省 32（**安全上限**：配置 `vision.maxImagesPerRequest` 只能收到这个数以下；deepseek 文档允许 600，实际按窗口预算走） */
  maxImagesPerRequest?: number;
  /** 单图字节上限；缺省 8 MiB */
  maxBytesPerImage?: number;
  /** 整包字节上限；缺省 24 MiB（deepseek 48 MiB 的一半，留一半给文本与工具 schema） */
  maxBytesPerRequest?: number;
  /** 单图 token 数；缺省 1024 */
  tokensPerImage?: number;
}

/**
 * 构造一份 OpenAI 兼容的视觉后端。
 *
 * 描述符实例是**不可变**的：所有方法都只读构造参数 —— 于是「同一 provider 实例」在整条
 * run 里给出的能力是同一个答案（`agent.model` 覆盖会换 provider 实例，能力自动跟着走）。
 */
export function createOpenAiCompatVision(
  options: OpenAiCompatVisionOptions = {},
): VisionBackend {
  const id = options.id ?? 'openai-compat';
  const maxImages = options.maxImagesPerRequest ?? 32;
  const maxBytesPerImage = options.maxBytesPerImage ?? 8 * 1024 * 1024;
  const maxBytesPerRequest = options.maxBytesPerRequest ?? 24 * 1024 * 1024;
  const tokensPerImage = options.tokensPerImage ?? OPENAI_COMPAT_TOKENS_PER_IMAGE;
  return {
    id,
    kind: 'native',
    supportsImage: () => true,
    formats: () => FORMATS,
    maxImagesPerRequest: () => maxImages,
    maxBytesPerImage: () => maxBytesPerImage,
    maxBytesPerRequest: () => maxBytesPerRequest,
    detailLevels: () => DETAIL_LEVELS,
    tokenCost: (images: number) => (images > 0 ? Math.ceil(images) * tokensPerImage : 0),
    sniffImageMime,
    toRequestPart(part: CanonicalImagePart): RequestContentPart {
      const data = Buffer.from(part.bytes).toString('base64');
      return {
        type: 'image_url',
        image_url: {
          url: `data:${part.media_type};base64,${data}`,
          ...(part.detail !== undefined ? { detail: part.detail } : {}),
        },
      };
    },
  };
}
