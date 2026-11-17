/**
 * 图片 blob 池（0.56，内容寻址）：`<dataDir>/blobs/sha256/xx/<sha256>[.ext]`
 * @module @vessel-agent/core/vision
 *
 * ## 为什么这一层**必须**在核心（宪法第十三条的唯一例外情形）
 *
 * 「同一张图第二次请求必须是同一串字节」是三条硬约束的交点：前缀守卫逐条
 * `JSON.stringify(message)` 比字节（`runtime/prompt-prefix-guard.ts:75`）、prompt cache
 * 命中率、append-only。把它做成插件，等于「谁都可以用另一份实现另存一次」，而失败表现
 * 只是日志里多几条 `prompt.prefix_changed` —— 没人会发现。所以「写一次、永不重写、
 * 按内容寻址」这条规则留在核心（与出口闸、前缀守卫同一类：不做成核心就会有人绕过）。
 *
 * ## 规则（三条，缺一条就不成立）
 *
 * 1. **内容寻址**：文件名 = sha256 前 2 位目录 + 全名。同一张图被 N 个会话引用 ⇒ **一份字节**；
 * 2. **只写一次、永不重写**：先 `stat`，命中就直接返回（连 mtime 都不动）。会话壳的
 *    `atomicWrite` 与它无关 —— blob 有独立的生命周期（GC 见 `collectImageBlobs`）；
 * 3. **扩展名只是给人看的**：判定一律读 magic bytes（那是**后端**的能力，见
 *    `types/vision.ts#sniffImageMime`）；这里只负责「尽量给个后缀」。
 *
 * ## 目录与权限
 *
 * 目录 0700 / 文件 0600（图可能含证件、凭据，比会话壳更敏感）。`blobs/` 不在
 * `src/data-paths.ts#assertRootTenantLayout` 的检查名单里（它只查 `tenants/` 与
 * `.t2-migrating-*`），所以新增这个目录**不会**触发 fail-fast。
 */

import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * blob 池根目录：显式 env → `VESSEL_DATA_DIR` → 默认数据目录。
 *
 * 口径与 `runtime/tool-result-gate.ts#toolOutputRoot` 完全一致（同一个 dataDir 下多一个
 * `blobs/`）：core 不认识「租户布局」，只认识「数据目录在哪」。
 */
export function imageBlobRoot(): string {
  const explicit = process.env.VESSEL_BLOB_DIR;
  if (typeof explicit === 'string' && explicit.trim() !== '') return path.resolve(explicit);
  const dataDir = process.env.VESSEL_DATA_DIR;
  if (typeof dataDir === 'string' && dataDir.trim() !== '') {
    return path.join(path.resolve(dataDir), 'blobs', 'sha256');
  }
  return path.join(os.homedir(), '.vessel', 'data', 'blobs', 'sha256');
}

/** 64 位小写十六进制的 sha256（形状校验的唯一口径：blob 名、GC 引用集合、`refs.sha256`）。 */
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** 是否是合法的 sha256（全小写十六进制、64 位）。 */
export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

/** 一段字节的 sha256（小写十六进制）。 */
export function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 前 8 位：事件 / chip 上只印这么长（够区分，又不把 64 位塞满 UI）。 */
export function sha8Of(sha256: string): string {
  return sha256.slice(0, 8);
}

/** 一次入池的结果 */
export interface BlobRecord {
  /** 64 位十六进制 */
  sha256: string;
  /** 绝对路径（`<root>/xx/<sha256>[.ext]`） */
  path: string;
  /** 字节数 */
  bytes: number;
  /** 命中已有 blob（没有写盘）= `true`；本次写入 = `false` */
  deduped: boolean;
}

/**
 * 后缀白名单（**只影响文件名，不参与任何判定**）。
 *
 * 刻意不在这里嗅探：MIME 判定是后端能力（`sniffImageMime`）。调用方把「它以为是啥」
 * 传进来做提示即可；不认识的 MIME 就不带后缀。
 */
const EXT_BY_MIME: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

/** MIME → 后缀（不认识 = 空串）。 */
export function imageExtOf(mime: string | undefined): string {
  if (mime === undefined) return '';
  return EXT_BY_MIME[mime.toLowerCase()] ?? '';
}

/** 分桶目录（前 2 位）：单目录几万文件的 `readdir` 会慢，2 位 = 256 桶。 */
function bucketDir(root: string, sha256: string): string {
  return path.join(root, sha256.slice(0, 2));
}

/** 该 sha256 的 blob 路径（带后缀）。找不到时调用方应扫桶（后缀可能不同）。 */
function blobPath(root: string, sha256: string, ext: string): string {
  return path.join(bucketDir(root, sha256), `${sha256}${ext}`);
}

/**
 * 找已经存在的 blob（**任一后缀**）：同一张图第一次以 `.png` 落过，第二次带了别的
 * mime 提示时也必须复用它（否则同一 sha256 会有两份字节 = 前缀抖动的入口）。
 */
async function existingBlobPath(
  root: string,
  sha256: string,
  ext: string,
): Promise<string | undefined> {
  const exact = blobPath(root, sha256, ext);
  const found = await stat(exact).then(
    (info) => (info.isFile() ? exact : undefined),
    () => undefined,
  );
  if (found !== undefined) return found;
  // 后缀不同：扫一次本桶（256 桶之一，最多几十个文件）。
  const dir = bucketDir(root, sha256);
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    if (name === sha256 || name.startsWith(`${sha256}.`)) return path.join(dir, name);
  }
  return undefined;
}

/**
 * 入池：算 sha256 → 存在即复用 → 否则写一次。
 *
 * **永不重写**：命中时连 `mtime` 都不动（P0-03 的判据之一：重启后再发一次，blob 不变）。
 * 写盘用 `writeFile(file, bytes, { flag: 'wx' })`：并发两次入池同一张图时，后到的
 * `EEXIST` 直接当「别人已经写好了」，不覆盖。
 *
 * 权限：目录 0700、文件 0600（`mode` 只在新建时生效，命中已有文件不会去改它）。
 */
export async function putImageBlob(payload: {
  bytes: Uint8Array;
  /** 「它以为是啥」的 MIME（只用来挑后缀；**不参与判定**） */
  mimeHint?: string;
  root?: string;
}): Promise<BlobRecord> {
  const root = payload.root ?? imageBlobRoot();
  const sha256 = sha256Of(payload.bytes);
  const ext = imageExtOf(payload.mimeHint);
  const existing = await existingBlobPath(root, sha256, ext);
  if (existing !== undefined) {
    return { sha256, path: existing, bytes: payload.bytes.length, deduped: true };
  }
  const dir = bucketDir(root, sha256);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = blobPath(root, sha256, ext);
  try {
    await writeFile(target, payload.bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    // 并发写同一张图：别人先写好了，复用它（内容寻址下内容必然相同）。
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return { sha256, path: target, bytes: payload.bytes.length, deduped: true };
  }
  // 兜底：个别文件系统忽略 `mode`（或 umask 更宽）时显式收一次。
  await chmod(target, 0o600).catch(() => undefined);
  return { sha256, path: target, bytes: payload.bytes.length, deduped: false };
}

/**
 * 读 blob（**唯一**的图片字节读口）。
 *
 * 只按 sha256 读：不拼 `refs[].path`、不扫目录、不读 URL、不递归。缺 blob 返回
 * `undefined`（调用方记 `blob_missing`，**不是**静默变成文字）。
 */
export async function readImageBlob(
  sha256: string,
  root?: string,
): Promise<Uint8Array | undefined> {
  if (!isSha256(sha256)) return undefined;
  const base = root ?? imageBlobRoot();
  const found = await existingBlobPath(base, sha256, '');
  if (found === undefined) return undefined;
  return readFile(found).catch(() => undefined);
}

/** blob 池的一次统计（GC / 上限判定的输入）。 */
export interface ImageBlobStats {
  root: string;
  files: number;
  bytes: number;
  /** 每个 blob 的 (sha256, bytes, mtimeMs)，按 mtime 升序（GC 的「最旧」口径） */
  entries: Array<{ sha256: string; bytes: number; mtimeMs: number; path: string }>;
}

/** 扫描 blob 池（不做判定，只报事实；空池 / 目录不存在 = 全零）。 */
export async function scanImageBlobs(root?: string): Promise<ImageBlobStats> {
  const base = root ?? imageBlobRoot();
  const stats: ImageBlobStats = { root: base, files: 0, bytes: 0, entries: [] };
  const buckets = await readdir(base, { withFileTypes: true }).catch(() => []);
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue;
    const dir = path.join(base, bucket.name);
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      const file = path.join(dir, name);
      const info = await stat(file).catch(() => undefined);
      if (info === undefined || !info.isFile()) continue;
      const sha256 = name.split('.')[0] ?? '';
      if (!isSha256(sha256)) continue;
      stats.files += 1;
      stats.bytes += info.size;
      stats.entries.push({ sha256, bytes: info.size, mtimeMs: info.mtimeMs, path: file });
    }
  }
  stats.entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return stats;
}

/**
 * blob 池上限（默认 **2 GiB**）：超限**不静默** —— 写一条 `vessel:notice` 环境卡
 * （「图片池已满，新图不会内联」），GUI chip 显示同一句原因。
 */
export const IMAGE_BLOB_POOL_MAX_BYTES = 2 * 1024 ** 3;

/** 孤儿宽限窗的缺省（小时）与上界（design §13.2 #1：够用但可配，上限 168）。 */
export const DEFAULT_ORPHAN_GRACE_HOURS = 24;
export const MAX_ORPHAN_GRACE_HOURS = 168;
/** 死线（天）：超过即**必删**，与宽限窗成对（缺一条 = 永不回收或误删草稿）。 */
export const DEFAULT_IMAGE_BLOB_TTL_DAYS = 30;

/** 一次 GC 的输入 */
export interface CollectImageBlobsOptions {
  /** 引用集合：所有会话壳 + 事件日志里出现过的 `refs.sha256` */
  referenced: ReadonlySet<string>;
  /** 现在（毫秒）；缺省 `Date.now()`（注入是为了可验证） */
  now?: number;
  /** 宽限窗小时数（默认 24，夹到 [0, MAX_ORPHAN_GRACE_HOURS]） */
  orphanGraceHours?: number;
  /** 死线天数（默认 30） */
  ttlDays?: number;
  /** 池上限字节（默认 2 GiB） */
  maxBytes?: number;
  /** 只算不删（dry-run；每次 GC 都有一次计数） */
  dryRun?: boolean;
  root?: string;
}

/** 一次 GC 的结果（事件 `gc.reclaimed` 的载荷） */
export interface CollectImageBlobsResult {
  /** 删掉（或 dry-run 下「会删」）的文件数 */
  reclaimed: number;
  /** 释放的字节数 */
  bytes: number;
  /** 仍在引用中的 blob 数 */
  referenced: number;
  /** 没到宽限窗的孤儿数（活着，但没人引用） */
  orphans: number;
  /** 超过死线被删的（`age > ttlDays`）数 */
  expired: number;
  /** 上限触顶（删完孤儿后仍超）⇒ 新图不内联 */
  overLimit: boolean;
  /** 删除后的池字节数 */
  totalBytes: number;
}

/**
 * 引用集合 GC。
 *
 * 规则（design §5.4，两条都要）：
 * - `refcount == 0 && age > orphanGraceHours` ⇒ **可**删（淘汰候选）；
 * - `refcount == 0 && age > ttlDays` ⇒ **必删**（死线）；
 * - 删除后仍超 `maxBytes` ⇒ `overLimit: true`（调用方写环境卡；**不重写会话、不删在用图**）。
 *
 * 只按「引用集合 + 年龄」算，**不按最近访问**（访问时间会被读放大污染）。最严重的失败
 * 形态是「删掉还在用的图」—— 所以 `referenced` 必须由调用方把**会话壳 + 事件日志**都扫
 * 进去（漏扫事件日志 = 本设计最严重的一类故障）。
 */
export async function collectImageBlobs(
  options: CollectImageBlobsOptions,
): Promise<CollectImageBlobsResult> {
  const now = options.now ?? Date.now();
  const graceMs =
    Math.min(Math.max(options.orphanGraceHours ?? DEFAULT_ORPHAN_GRACE_HOURS, 0), 168) * 3_600_000;
  const ttlMs = Math.max(options.ttlDays ?? DEFAULT_IMAGE_BLOB_TTL_DAYS, 1) * 86_400_000;
  const maxBytes = options.maxBytes ?? IMAGE_BLOB_POOL_MAX_BYTES;
  const stats = await scanImageBlobs(options.root);
  const result: CollectImageBlobsResult = {
    reclaimed: 0,
    bytes: 0,
    referenced: 0,
    orphans: 0,
    expired: 0,
    overLimit: false,
    totalBytes: stats.bytes,
  };
  const doomed: Array<{ path: string; bytes: number; sha256: string }> = [];
  for (const entry of stats.entries) {
    if (options.referenced.has(entry.sha256)) {
      result.referenced += 1;
      continue;
    }
    const age = now - entry.mtimeMs;
    if (age > ttlMs) {
      result.expired += 1;
      doomed.push(entry);
      continue;
    }
    if (age > graceMs) {
      doomed.push(entry);
      continue;
    }
    result.orphans += 1;
  }
  // 引用集合里但已经不存在的：不算错（会话可能引用了从未落盘的图）。
  let live = stats.bytes;
  for (const entry of doomed) {
    result.reclaimed += 1;
    result.bytes += entry.bytes;
    live -= entry.bytes;
    if (options.dryRun === true) continue;
    await rm(entry.path, { force: true }).catch(() => undefined);
  }
  result.totalBytes = Math.max(live, 0);
  result.overLimit = result.totalBytes > maxBytes;
  return result;
}
