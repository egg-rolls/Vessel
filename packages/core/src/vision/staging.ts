/**
 * 附件暂存区（file-ref-ux，A2/A3）：浏览器 drop/paste/选择框的 `File` 拿不到用户机
 * 绝对路径 ⇒ 字节上传到 node 落一份**临时副本**，引用指向这份副本（「暂存引用」）。
 *
 * 与 blob 池（`blobs.ts`）的分工：
 * - blob 池 = 内容寻址、只写一次、永不重写（视觉内联的字节真相源）；
 * - 暂存区 = **带原文件名**的可读副本（`media` 工具按路径读的就是它），有 TTL，
 *   过期由 GC 回收（`src/data/attachment-staging.ts`）。图片上传时同时入 blob 池
 *   （同 sha 去重），暂存副本与 blob 是同一份字节的两个名字。
 *
 * 布局：`<dataDir>/attachments/staging/<sha256前2>/<sha256>/<原文件名>`。
 * 目录口径与 `imageBlobRoot()` 完全一致（同一个 dataDir 下多一个 `attachments/`）。
 *
 * 本模块只做**路径与形状**（纯函数，无 IO）：落盘 / 读取 / GC 在装配层
 * （`src/data/attachment-staging.ts`），边界判定复用 basic-tools 单实现
 * （`buildPathBoundary` 在 allowedRoots 非空时把暂存根追加进去 —— media / ingest /
 * attachments.list 全部自动放行，deny 仍优先）。
 *
 * @module @vessel-agent/core/vision
 */

import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 暂存区根目录：显式 env → `VESSEL_DATA_DIR` → 默认数据目录。
 * 与 `imageBlobRoot()` 同一套 dataDir 解析（不写第二套）。
 */
export function attachmentStagingRoot(): string {
  const explicit = process.env.VESSEL_ATTACHMENT_STAGING_DIR;
  if (typeof explicit === 'string' && explicit.trim() !== '') return path.resolve(explicit);
  const dataDir = process.env.VESSEL_DATA_DIR;
  if (typeof dataDir === 'string' && dataDir.trim() !== '') {
    return path.join(path.resolve(dataDir), 'attachments', 'staging');
  }
  return path.join(os.homedir(), '.vessel', 'data', 'attachments', 'staging');
}

/** 暂存引用默认存活（毫秒）：60 分钟，足够 AI 在当轮用 media 读取（A2 裁定）。 */
export const STAGING_TTL_MS = 60 * 60 * 1000;

/** GC 宽限（毫秒）：TTL 之后再留 1 小时，防「读到一半被删」（A2 裁定 +1h）。 */
export const STAGING_GRACE_MS = 60 * 60 * 1000;

/** 控制字符（文件名里必须剔除；用转义写法，源码里不放裸控制字符）。 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 剔除文件名控制字符是安全 sanitize 的本意
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

/**
 * 原文件名 → 可安全落盘的单段文件名：
 * 去掉路径分隔符 / 控制字符 / 首尾空白与点；空了回退 `file`。
 * 保留扩展名（media / 种类粗判都看它）。**不参与任何边界判定**。
 */
export function sanitizeStagedName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(CONTROL_CHARS, '')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .trim();
  if (cleaned.length === 0) return 'file';
  // 单段上限 200 字符：够长文件名用，又不让单条目撑爆目录枚举。
  return cleaned.length > 200 ? cleaned.slice(0, 200) : cleaned;
}

/** 该 sha256 的暂存目录（前 2 位分桶，与 blob 池同口径）。 */
export function stagingBucketDir(root: string, sha256: string): string {
  return path.join(root, sha256.slice(0, 2), sha256);
}

/** 该 sha256 + 文件名的暂存副本绝对路径。 */
export function stagingPathFor(root: string, sha256: string, name: string): string {
  return path.join(stagingBucketDir(root, sha256), sanitizeStagedName(name));
}

/** 候选路径是否落在暂存根内（按路径段，不按字符串前缀；与 basic-tools isWithin 同口径）。 */
export function isInsideStagingRoot(target: string, root: string): boolean {
  const resolvedTarget = path.resolve(target);
  const resolvedRoot = path.resolve(root);
  if (resolvedTarget === resolvedRoot) return true;
  return resolvedTarget.startsWith(resolvedRoot + path.sep);
}
