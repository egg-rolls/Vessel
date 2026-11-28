/**
 * 附件暂存的装配层实现（file-ref-ux A2/A3/A4）：
 * `attachments.stage` 落盘 + `attachments.preview` 读回 / 过期探针 + TTL GC。
 *
 * ## 边界与入池同一份
 *
 * 配置从 `basic-tools` 来（`buildPluginConfigMap` 合并顺序一致），判定只用
 * `buildPathBoundary` / `evaluatePath` / `canonicalPath`。暂存根已由
 * `buildPathBoundary` 追加进允许根（core `attachmentStagingRoot()`），所以
 * media / ingest / attachments.list 对暂存路径的放行是**同一份边界**的自动结果。
 * **ask 与 deny 都不读**（preview fail-closed，与入池同口径）。
 *
 * ## 暂存语义（诚实区分）
 *
 * - 暂存引用 = 用户经浏览器上传的临时副本（drop/paste/选择框），TTL 60min + 1h 宽限；
 * - 节点路径引用（粘贴路径 / 浏览）不经这里，无 TTL、不复制。
 * - 同 sha256 重传 ⇒ 复用副本 + 刷新 mtime（续期）；图片同时入 blob 池（内容寻址去重）。
 *
 * ## GC
 *
 * 按 mtime 判定（`mtime + TTL + 宽限 < now` ⇒ 删），周期扫描，口径与
 * `image-blob-gc` 同族（第一趟 dry-run、定时器 unref、在途不叠）。
 * 宽限窗本身就是「读到一半被删」的缓冲；更严的在途保护（按进行中 run 的
 * admit 快照跳过）留作演进接缝（`referencedPaths` 入参已留）。
 *
 * @module vessel/attachment-staging
 */

import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { VesselConfig } from '../../packages/config/src/index';
import {
  attachmentStagingRoot,
  isInsideStagingRoot,
  putImageBlob,
  STAGING_GRACE_MS,
  STAGING_TTL_MS,
  sha256Of,
  stagingBucketDir,
  stagingPathFor,
} from '../../packages/core/src/index';
import type {
  AttachmentPreviewer,
  AttachmentPreviewRequest,
  AttachmentPreviewResult,
  AttachmentStageRequest,
  AttachmentStageResult,
  AttachmentStager,
} from '../../packages/serve/src/index';
import { ATTACHMENT_PREVIEW_MAX_BYTES } from '../../packages/serve/src/index';
import {
  buildPathBoundary,
  canonicalPath,
  evaluatePath,
  type PathBoundary,
  parseBasicToolsConfig,
} from '../../plugins/tools/basic-tools/src/index';
import { buildPluginConfigMap, declarativePluginEntries } from '../plugin/plugin-config';
import { resolveAgentCwd } from './path-resolution';

export interface AttachmentStagingOptions {
  /** 当前活配置（getter：热应用后下一次判定就用新边界）。 */
  getConfig: () => VesselConfig;
  /** 暂存根（缺省 core `attachmentStagingRoot()`）。 */
  root?: string;
}

/** 图片扩展名（种类粗判，与 web AttachDialog 同一口径的节点侧副本）。 */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
  'ico',
  'avif',
  'tiff',
  'tif',
]);

/** 文档扩展名（粗判；其余一律 file）。 */
const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'md',
  'txt',
  'csv',
  'rtf',
  'odt',
  'ods',
  'odp',
  'json',
  'yaml',
  'yml',
  'xml',
  'log',
]);

/**
 * 可预览扩展名 → MIME 白名单（preview 的 data URL 用；不认识 = `not_image`）。
 * 闭集 = image/* + application/pdf（q-pdf-preview-channel）：PDF 走浏览器原生
 * 查看器，与图片同一条读字节路径 / 边界闸 / size 上限，不另开通道。
 */
const PREVIEW_MIME_BY_EXT: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  avif: 'image/avif',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  pdf: 'application/pdf',
};

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** 种类粗判：MIME 提示优先，其次扩展名（与 addRef 一样不做真实类型探测）。 */
function kindOf(name: string, mime: string | undefined): 'file' | 'image' | 'document' {
  if (mime !== undefined && mime.toLowerCase().startsWith('image/')) return 'image';
  const ext = extensionOf(name);
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (DOCUMENT_EXTENSIONS.has(ext)) return 'document';
  return 'file';
}

/** 边界快照（与 attachment-ingest / attachments-list 同口径）。 */
function boundaryOf(config: VesselConfig): PathBoundary {
  const merged = buildPluginConfigMap(
    config.plugins,
    declarativePluginEntries(config),
    resolveAgentCwd(config),
  )['basic-tools'];
  return buildPathBoundary(parseBasicToolsConfig(merged));
}

/**
 * 构造 `attachments.stage` 的落盘函数。
 *
 * 写盘顺序：算 sha → 图片入 blob 池（去重）→ 暂存副本（存在即续期，否则 `wx` 写一次）。
 * 暂存目录 0700 / 文件 0600（与 blob 池同口径：上传内容可能含证件 / 凭据）。
 */
export function createConfigAttachmentStager(options: AttachmentStagingOptions): AttachmentStager {
  const root = options.root ?? attachmentStagingRoot();
  return async (request: AttachmentStageRequest): Promise<AttachmentStageResult> => {
    const sha256 = sha256Of(request.bytes);
    const kind = kindOf(request.name, request.mime);
    const target = stagingPathFor(root, sha256, request.name);
    const name = path.basename(target);
    // 图片同时入 blob 池：同一张图第二次上传不重写字节（内容寻址）；
    // 非图片只落暂存副本（blob 池是视觉内联的字节池，不收任意文件）。
    if (kind === 'image') {
      await putImageBlob({
        bytes: request.bytes,
        ...(request.mime !== undefined ? { mimeHint: request.mime } : {}),
      });
    }
    const dir = stagingBucketDir(root, sha256);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const now = Date.now();
    const existing = await stat(target).catch(() => undefined); // benign: 存在性探针——缺失走新建。
    if (existing !== undefined && existing.isFile()) {
      // 同 sha 重传：复用副本 + 刷新 mtime（TTL 续期）。
      await utimes(target, new Date(now), new Date(now)).catch(() => undefined); // benign: 触活尽力而为——失败下轮 GC 按 mtime 保守判定。
    } else {
      try {
        await writeFile(target, request.bytes, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        // 并发写同一份：别人先写好了，复用它（内容寻址下内容必然相同）。
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await utimes(target, new Date(now), new Date(now)).catch(() => undefined); // benign: 触活尽力而为——失败下轮 GC 按 mtime 保守判定。
      }
    }
    return {
      path: target,
      sha256,
      bytes: request.bytes.byteLength,
      kind,
      name,
      ...(request.mime !== undefined ? { mime: request.mime } : {}),
      expiresAt: now + STAGING_TTL_MS,
    };
  };
}

/**
 * 构造 `attachments.preview` 的读回 / 探针函数。
 *
 * 边界 ask/deny ⇒ `denied`（不读）；不存在 ⇒ `gone`（过期态）；
 * 白名单外（image/* + application/pdf 之外）⇒ `not_image`；超上限 ⇒ `too_large`；
 * 其余读字节出 data URL（PDF 与图片同路，fail-closed 语义不变）。
 * 暂存根内的路径附带 `staging: true` + `expiresAt`（「临时」徽标 / 过期态的数据源）。
 */
export function createConfigAttachmentPreviewer(
  options: AttachmentStagingOptions,
): AttachmentPreviewer {
  const root = options.root ?? attachmentStagingRoot();
  let cachedConfig: VesselConfig | undefined;
  let cachedBoundary: PathBoundary | undefined;
  return async (request: AttachmentPreviewRequest): Promise<AttachmentPreviewResult> => {
    const config = options.getConfig();
    if (cachedBoundary === undefined || cachedConfig !== config) {
      cachedConfig = config;
      cachedBoundary = boundaryOf(config);
    }
    const canonical = canonicalPath(path.resolve(request.path));
    const staging = isInsideStagingRoot(canonical, canonicalPath(root));
    if (evaluatePath(canonical, cachedBoundary) !== 'allow') {
      return { status: 'denied', ...(staging ? { staging: true } : {}) };
    }
    const info = await stat(canonical).catch(() => undefined); // benign: 存在性探针——缺失按 gone。
    if (info === undefined || !info.isFile()) {
      return { status: 'gone', ...(staging ? { staging: true } : {}) };
    }
    const stagingFields = staging
      ? { staging: true, expiresAt: Math.floor(info.mtimeMs) + STAGING_TTL_MS }
      : {};
    const mime = PREVIEW_MIME_BY_EXT[extensionOf(canonical)];
    if (mime === undefined) {
      return { status: 'not_image', bytes: info.size, ...stagingFields };
    }
    if (info.size > ATTACHMENT_PREVIEW_MAX_BYTES) {
      return { status: 'too_large', bytes: info.size, mime, ...stagingFields };
    }
    const bytes = await readFile(canonical).catch(() => undefined); // benign: 读探针——失败按 gone（状态可见，非静默）。
    if (bytes === undefined) {
      return { status: 'gone', ...stagingFields };
    }
    return {
      status: 'ok',
      bytes: bytes.byteLength,
      mime,
      dataUrl: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`,
      ...stagingFields,
    };
  };
} // ── TTL GC ──────────────────────────────────────────────────────────────

export interface StagingGcReport {
  dryRun: boolean;
  scanned: number;
  reclaimed: number;
  bytes: number;
}

export interface StagingGcOptions {
  root?: string;
  now?: number;
  dryRun?: boolean;
  /** 在途保护：这些路径本轮跳过（进行中 run 的 admit 快照；缺省空）。 */
  referencedPaths?: ReadonlySet<string>;
}

/** 扫一趟暂存区，删过期副本（`mtime + TTL + 宽限 < now`），顺带清空目录。 */
export async function collectStagingAttachments(
  options: StagingGcOptions = {},
): Promise<StagingGcReport> {
  const root = options.root ?? attachmentStagingRoot();
  const now = options.now ?? Date.now();
  const report: StagingGcReport = {
    dryRun: options.dryRun === true,
    scanned: 0,
    reclaimed: 0,
    bytes: 0,
  };
  const buckets = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const bucket of buckets) {
    // 只认内容寻址布局（2 位 hex 桶 / 64 位 hex 目录）；别的目录不碰。
    if (!bucket.isDirectory() || !/^[0-9a-f]{2}$/.test(bucket.name)) continue;
    const bucketDir = path.join(root, bucket.name);
    const shaDirs = await readdir(bucketDir, { withFileTypes: true }).catch(() => []);
    for (const shaDir of shaDirs) {
      if (!shaDir.isDirectory() || !/^[0-9a-f]{64}$/.test(shaDir.name)) continue;
      const dir = path.join(bucketDir, shaDir.name);
      const names = await readdir(dir).catch(() => [] as string[]);
      for (const name of names) {
        const file = path.join(dir, name);
        const info = await stat(file).catch(() => undefined); // benign: GC 探针——stat 失败跳过。
        if (info === undefined || !info.isFile()) continue;
        report.scanned += 1;
        if (options.referencedPaths?.has(file)) continue;
        if (info.mtimeMs + STAGING_TTL_MS + STAGING_GRACE_MS >= now) continue;
        report.reclaimed += 1;
        report.bytes += info.size;
        if (report.dryRun) continue;
        await rm(file, { force: true }).catch(() => undefined); // benign: GC 尽力删除——残留下轮再收。
      }
      // 空目录顺手收掉（非空 / 并发写入时失败静默：下一趟再来）。
      if (!report.dryRun) {
        const left = await readdir(dir).catch(() => ['x']);
        if (left.length === 0)
          await rm(dir, { recursive: true, force: true }).catch(() => undefined); // benign: GC 空桶清理尽力而为。
      }
    }
    if (!report.dryRun) {
      const left = await readdir(bucketDir).catch(() => ['x']);
      if (left.length === 0) {
        await rm(bucketDir, { recursive: true, force: true }).catch(() => undefined); // benign: GC 桶清理尽力而为。
      }
    }
  }
  return report;
}

export interface StagingGcScheduleOptions extends StagingGcOptions {
  /** 间隔分钟（默认 15，夹到 [5, 120]）。 */
  intervalMinutes?: number;
  onReport: (report: StagingGcReport) => void;
  /** 定时器工厂（测试缝；缺省 setInterval）。 */
  setInterval?: (fn: () => void, ms: number) => { unref?: () => void };
}

export interface StagingGcRunner {
  runOnce(dryRun?: boolean): Promise<StagingGcReport>;
  stop(): void;
}

/**
 * 启动暂存 GC 定时器：**第一趟永远 dry-run**（与 image-blob-gc 同一保护口径），
 * 之后按间隔真删；定时器 unref（一次性 CLI 不该被 GC 拖着不退）。
 */
export function startStagingGc(options: StagingGcScheduleOptions): StagingGcRunner {
  const minutes = Math.min(Math.max(options.intervalMinutes ?? 15, 5), 120);
  const schedule = options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  let stopped = false;
  let first = true;
  let inFlight = false;

  const runOnce = async (dryRun?: boolean): Promise<StagingGcReport> => {
    if (inFlight) return { dryRun: true, scanned: 0, reclaimed: 0, bytes: 0 };
    inFlight = true;
    try {
      const report = await collectStagingAttachments({
        ...options,
        dryRun: dryRun ?? (first || options.dryRun === true),
      });
      first = false;
      options.onReport(report);
      return report;
    } finally {
      inFlight = false;
    }
  };

  const timer = schedule(() => {
    if (stopped) return;
    void runOnce().catch(() => undefined); // benign: 定时 GC 防未处理拒绝；失败下轮重试。
  }, minutes * 60_000);
  timer.unref?.();
  const firstPass = setTimeout(() => {
    if (stopped) return;
    void runOnce(true).catch(() => undefined); // benign: 同上（force 趟）。
  }, 0);
  firstPass.unref?.();

  return {
    runOnce,
    stop() {
      stopped = true;
      clearInterval(timer as unknown as ReturnType<typeof setInterval>);
      clearTimeout(firstPass as unknown as ReturnType<typeof setTimeout>);
    },
  };
}
