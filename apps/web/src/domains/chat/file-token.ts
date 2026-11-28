/**
 * 用户正文 vessel-ref token 提升（q-block-cardshell-unify，用户新 UI 方向①）。
 *
 * token 形状唯一：`[name](<vessel-ref:path>)`（RichComposer buildAtomicToken 与
 * file-refs 插件 drop-handler 同形的 canonical 尖括号形）。用户气泡正文是**纯文本**
 * 渲染（MessageFold，不经 Markdown / link-enhancers），token 原文露出是可见性对等
 * 缺口 —— 这里把正文里的完整 token 提升成文件卡，剥出正文。
 *
 * 硬约束（与 lift-blocks 管线同口径）：
 * - 只认**完整** token（正则不命中半截形状 ⇒ 原文保留，流式逐字不闪）；
 * - 历史只读：只解析投影，不回填不改写 `Message.content`；
 * - 与结构化 refs 的去重**镜像 composer**（ComposerChrome#refsToAttachmentsFiltered）：
 *   token occurrence 按 path 计数消费 ref —— 被消费的 ref 不再出 chip（卡即其视图），
 *   剩余 refs 照旧 chip。每个 ref occurrence 恰好渲染一次（卡或 chip），不重复。
 */
import type { ImageDelivery, MessageRef, MessageRefKind } from '../../gateway/types';

/** canonical token（尖括号目标形；name 可空，path 非空，均不含换行）。 */
const TOKEN_RE = /\[([^\]\n]*)\]\(<vessel-ref:([^>\n]*)>\)/g;

/** 正文里解析出的一个 token（name 空时回落 basename）。 */
export interface FileToken {
  name: string;
  path: string;
}

/** 路径 → 文件名（Windows / POSIX 分隔符都认，不引入 node:path）。 */
export function pathBasename(target: string): string {
  const parts = target.split(/[\\/]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? target;
}

/** 图片 / 文档扩展名只看形状（与 `addRef` 一样不做真实类型探测）。 */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
  'avif',
  'ico',
]);

const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  'pdf',
  'doc',
  'docx',
  'rtf',
  'txt',
  'md',
  'csv',
  'tsv',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'json',
  'yaml',
  'yml',
  'html',
  'xml',
]);

/** 扩展名 → `MessageRef.kind`（粗判；`kind` 只影响卡 / chip 的图标 / 文案）。 */
export function refKindForPath(target: string): MessageRefKind {
  const name = pathBasename(target);
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (DOCUMENT_EXTENSIONS.has(extension)) return 'document';
  return 'file';
}

/**
 * 正文 → token 列表 + 剥掉 token 的剩余正文。无完整 token ⇒ null（正文原样）。
 *
 * 剥法：token 就地移除；**整行只有 token**（移除后空白）的行整行去掉，避免留下
 * 空行；行内其余文字逐字节保留（不塌缩空格、不动未命中部分）。token 不跨行
 * （正则排除 \n），逐行处理安全。
 */
export function liftFileTokens(body: string): { tokens: FileToken[]; body: string } | null {
  const tokens: FileToken[] = [];
  const lines = body.split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    TOKEN_RE.lastIndex = 0;
    if (!TOKEN_RE.test(line)) {
      kept.push(line);
      continue;
    }
    TOKEN_RE.lastIndex = 0;
    const stripped = line.replace(TOKEN_RE, (match, name: string, path: string) => {
      if (path.length === 0) return match;
      tokens.push({ name: name.trim() || pathBasename(path), path });
      return '';
    });
    // 整行只有 token ⇒ 不留空行；行内还有文字 ⇒ 保留剩余（逐字节）。
    if (stripped.trim().length > 0) kept.push(stripped);
    TOKEN_RE.lastIndex = 0;
  }
  if (tokens.length === 0) return null;
  return { tokens, body: kept.join('\n') };
}

/** 一张 token 卡：token 本身 + 匹配到的结构化 ref（可缺）+ 该 ref 的投递状态。 */
export interface FileTokenCard extends FileToken {
  /** 同 path 的结构化 ref（按 occurrence 消费）；有它才有 sha256 / 权威 kind / 字节数。 */
  ref?: MessageRef;
  /** 匹配 ref 为 image 时的投递状态（与 refs 的 image 项同序消费后转挂到这里）。 */
  delivery?: ImageDelivery;
}

export interface FileTokenMatch {
  cards: FileTokenCard[];
  /** 未被 token 消费的 refs（照旧走 MessageRefs chip）。 */
  refs: MessageRef[];
  /** 剩余 refs 中 image 项的投递状态（同序；入参缺省时缺省）。 */
  imageDelivery?: ImageDelivery[];
}

/**
 * token ↔ refs 按 path occurrence 匹配（镜像 composer 的 refsToAttachmentsFiltered：
 * 每个 token 消费一条同 path 的 ref，先到先配）。投递状态按**完整 refs** 的 image
 * 同序消费后再分流：被消费的转挂到卡，剩余的留给 chip —— 与服务端下发口径一致。
 */
export function matchFileTokens(
  tokens: readonly FileToken[],
  refs: readonly MessageRef[],
  imageDelivery?: readonly ImageDelivery[],
): FileTokenMatch {
  const cards: FileTokenCard[] = tokens.map((token) => ({ ...token }));
  const remainingRefs: MessageRef[] = [];
  const remainingDelivery: ImageDelivery[] = [];
  let imageIndex = 0;
  for (const ref of refs) {
    const delivery =
      ref.kind === 'image' && imageDelivery !== undefined ? imageDelivery[imageIndex++] : undefined;
    const card = cards.find(
      (candidate) => candidate.ref === undefined && candidate.path === ref.path,
    );
    if (card !== undefined) {
      card.ref = ref;
      if (delivery !== undefined) card.delivery = delivery;
      continue;
    }
    remainingRefs.push(ref);
    if (delivery !== undefined) remainingDelivery.push(delivery);
  }
  return {
    cards,
    refs: remainingRefs,
    ...(imageDelivery !== undefined ? { imageDelivery: remainingDelivery } : {}),
  };
}
