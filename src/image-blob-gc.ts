/**
 * 图片 blob GC 的接线（0.56 P1）：引用集合 = **会话壳 + 事件日志**，两处都扫。
 *
 * ## 为什么「算错」的代价不对称
 *
 * refcount 算少了 = **删掉在用的图**（用户回看历史看到空白、模型再也读不到那张图），
 * 这是本模块唯一不能接受的故障；算多了只是漏水（浪费磁盘）。所以每条路径都朝「漏水」
 * 方向偏：
 * - 引用按**内容寻址的字面量**收集（扫 64 位十六进制串），不做 schema 解析 ——
 *   一段字节里出现过这个 sha256 就算被引用；
 * - **两处都扫**：会话壳（`<sessions>/<id>.json`，`refs` 的出处）与事件日志
 *   （`<sessions>/<id>/`，时间线的真相源）。漏扫一处就是本设计最严重的一类故障；
 * - 会话事件整份读不出来（旧格式会话 / 损坏）⇒ 记一条 warn 并且**这一趟继续**，
 *   但只在这个前提成立时继续：0.56 之前没有 blob 池，旧会话不可能引用它；
 * - 读盘本身失败（readdir / 会话壳读不出）⇒ 抛，调用方**整趟放弃**（`aborted`），
 *   一个字节都不删。
 *
 * ## 先 dry-run
 *
 * 进程启动后的**第一趟**只报不删（「将删 N 个 / 共 M 个」），给人一次看数字的机会；
 * 之后按 `intervalHours` 定时真删。宽限窗（默认 24h，夹到 168）与死线（默认 30d）
 * 由 core 的 `collectImageBlobs` 算，本模块只喂引用集合与预算。
 *
 * @module vessel/image-blob-gc
 */

import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  type CollectImageBlobsResult,
  collectImageBlobs,
  IMAGE_BLOB_POOL_MAX_BYTES,
  isSha256,
} from '../packages/core/src/index';

/** 64 位小写十六进制（与 `isSha256` 同一口径；`matchAll` 要求全局标志）。 */
const SHA256_IN_TEXT = /[0-9a-f]{64}/g;

/**
 * 会话目录里当**文本**扫的文件名。
 *
 * 块文件（`wal.blocks/*.wblk`）是二进制压缩，按文本扫不但可能漏，还会读进一大堆
 * 无用字节；它们的内容由 `log.read()` 解码后的事件覆盖（外置 blob 取不回时留下的
 * 那个引用也能被下面这轮文本扫兜住）。
 */
const TEXT_FILES: readonly string[] = ['events.ndjson', 'timeline.ndjson', 'wal.log', 'index.json'];

/** 把一段文本里的 sha256 收进集合。 */
function shasIn(text: string, out: Set<string>): void {
  for (const match of text.matchAll(SHA256_IN_TEXT)) {
    if (isSha256(match[0])) out.add(match[0]);
  }
}

/** 事件日志读口（结构类型对齐 `TimelineEventLog`）：只需要「整份读」。 */
export interface BlobGcEventReader {
  read(sessionId: string): Promise<readonly unknown[]>;
}

/** 一次引用集合扫描的结果（dry-run 报告里也带上，方便对账）。 */
export interface BlobReferenceScan {
  /** 所有出现过的 sha256（**超集**：宁可多，不可少）。 */
  referenced: Set<string>;
  /** 扫了多少个事件日志目录。 */
  sessions: number;
  /** 扫了多少个会话壳文件。 */
  shells: number;
  /** 事件日志整份读不出来的会话（它们的引用只靠文本扫兜底）。 */
  unreadable: string[];
}

/** 事件一条 → 参与扫描的字节（不认 schema，只认字面量）。 */
function eventText(event: unknown): string {
  try {
    return JSON.stringify(event) ?? '';
  } catch {
    return '';
  }
}

/** 扫一个会话目录里的文本文件；读不出就当没有（`log.read` 已覆盖主要事实）。 */
async function scanSessionTextFiles(dir: string, out: Set<string>): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    if (!TEXT_FILES.includes(name)) continue;
    const text = await readFile(join(dir, name), 'utf8').catch(() => undefined);
    if (text === undefined) continue;
    shasIn(text, out);
  }
}

/**
 * 收集引用集合（会话壳 + 事件日志，两处都扫）。
 *
 * 抛错 = 「证明不了没有人用这些 blob」。调用方必须整趟放弃（`aborted`），
 * 一个字都不删 —— 那是本设计唯一安全的失败方式。
 */
export async function collectBlobReferences(input: {
  /** `tenantPaths.sessions_dir` */
  sessionsDir: string;
  log: BlobGcEventReader;
  /** 读不出来的会话（缺省吞掉；装配层传 warn，**不静默**）。 */
  onUnreadable?: (sessionId: string, error: unknown) => void;
}): Promise<BlobReferenceScan> {
  const referenced = new Set<string>();
  const scan: BlobReferenceScan = { referenced, sessions: 0, shells: 0, unreadable: [] };
  const entries = await readdir(input.sessionsDir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(input.sessionsDir, entry.name);
    if (entry.isFile() && entry.name.endsWith('.json')) {
      // 会话壳：`refs.sha256` 的出处。按**文本**扫而不是 `JSON.parse`：壳损坏 / 旧形状
      // 时也要能收到引用（解析失败就丢引用 = 删在用图）。
      const text = await readFile(full, 'utf8').catch(() => undefined);
      if (text === undefined) continue;
      scan.shells += 1;
      shasIn(text, referenced);
      continue;
    }
    if (!entry.isDirectory()) continue;
    scan.sessions += 1;
    const sessionId = decodeURIComponent(entry.name);
    try {
      for (const event of await input.log.read(sessionId)) {
        shasIn(eventText(event), referenced);
      }
    } catch (error) {
      scan.unreadable.push(sessionId);
      input.onUnreadable?.(sessionId, error);
    }
    await scanSessionTextFiles(full, referenced);
  }
  return scan;
}

/** 一趟 GC 的输入（全部可选：缺省值就是产品缺省）。 */
export interface ImageBlobGcOptions {
  sessionsDir: string;
  log: BlobGcEventReader;
  /** 只算不删（dry-run） */
  dryRun?: boolean;
  /** 现在（毫秒）；缺省 `Date.now()` */
  now?: number;
  /** 孤儿宽限窗（小时，默认 24，夹到 [0, 168]） */
  orphanGraceHours?: number;
  /** 死线（天，默认 30） */
  ttlDays?: number;
  /** 池上限（字节，默认 2 GiB） */
  maxBytes?: number;
  /** blob 池根目录（缺省核心的 `imageBlobRoot()`） */
  root?: string;
  onUnreadable?: (sessionId: string, error: unknown) => void;
}

/** 一趟 GC 的结果：core 的账 + 引用集合的账 + 有没有放弃。 */
export interface ImageBlobGcReport {
  /** 这一趟到底删没删 */
  dryRun: boolean;
  /** 引用集合的规模（对账：少了就是扫漏了） */
  scanned: { sessions: number; shells: number; referenced: number; unreadable: number };
  /** core 算出来的账（`aborted` 时是 undefined —— 没算就是没算，不补 0） */
  result?: CollectImageBlobsResult;
  /** 证明不了引用集合 ⇒ 整趟放弃 */
  aborted?: { reason: string };
}

/**
 * 跑一趟 GC（先扫引用集合，再交给 core 算账）。
 *
 * 返回 `aborted` 时**没有删任何东西**，调用方照实报告（「这一趟没做」不是「0 个孤儿」）。
 */
export async function runImageBlobGc(options: ImageBlobGcOptions): Promise<ImageBlobGcReport> {
  let scan: BlobReferenceScan;
  try {
    scan = await collectBlobReferences({
      sessionsDir: options.sessionsDir,
      log: options.log,
      ...(options.onUnreadable !== undefined ? { onUnreadable: options.onUnreadable } : {}),
    });
  } catch (error) {
    return {
      dryRun: options.dryRun !== false,
      scanned: { sessions: 0, shells: 0, referenced: 0, unreadable: 0 },
      aborted: { reason: error instanceof Error ? error.message : String(error) },
    };
  }
  const result = await collectImageBlobs({
    referenced: scan.referenced,
    dryRun: options.dryRun !== false,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.orphanGraceHours !== undefined
      ? { orphanGraceHours: options.orphanGraceHours }
      : {}),
    ...(options.ttlDays !== undefined ? { ttlDays: options.ttlDays } : {}),
    ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    ...(options.root !== undefined ? { root: options.root } : {}),
  });
  return {
    dryRun: options.dryRun !== false,
    scanned: {
      sessions: scan.sessions,
      shells: scan.shells,
      referenced: scan.referenced.size,
      unreadable: scan.unreadable.length,
    },
    result,
  };
}

/**
 * blob 池是不是落在**这个数据目录**里（GC 的安全闸）。
 *
 * `VESSEL_BLOB_DIR` 可以把池指到别的地方（多节点 / 多租户共享一份池）。那时本进程能扫到的
 * 引用集合只是**本目录**的会话，删任何东西都可能是「删别人还在用的图」—— 所以宁可不做
 *（漏水），也不猜。Windows 上路径比较要按小写（同一目录两种写法很常见）。
 */
export function isBlobRootInsideDataDir(dataDir: string, blobRoot: string): boolean {
  const from = resolve(dataDir);
  const to = resolve(blobRoot);
  const rel = relative(from, to);
  if (rel === '' || isAbsolute(rel)) return false;
  const lowered = rel.toLowerCase();
  if (lowered === '..' || lowered.startsWith('..\\') || lowered.startsWith('../')) return false;
  return process.platform === 'win32' ? to.toLowerCase().startsWith(from.toLowerCase()) : true;
}

/** 一行人类可读的读数（日志 / 启动自证 / dry-run 报告共用同一句话）。 */
export function formatImageBlobGcReport(report: ImageBlobGcReport): string {
  const window = report.dryRun ? 'dry-run' : 'apply';
  if (report.aborted !== undefined) {
    return `image blob gc (${window}): aborted, nothing deleted (${report.aborted.reason})`;
  }
  const result = report.result;
  if (result === undefined) return `image blob gc (${window}): no result`;
  const verb = report.dryRun ? 'would delete' : 'deleted';
  const tail = result.overLimit
    ? `; OVER the ${Math.floor(IMAGE_BLOB_POOL_MAX_BYTES / 1024 ** 3)} GiB pool limit (new images will not be inlined)`
    : '';
  return (
    `image blob gc (${window}): ${verb} ${result.reclaimed} / ${scanTotal(report)} blobs ` +
    `(${result.bytes} bytes; referenced ${result.referenced}, orphans ${result.orphans}, ` +
    `expired ${result.expired}, pool ${result.totalBytes} bytes after)` +
    tail
  );
}

/** 「共 M 个」：删除前的池规模 = 删掉的 + 留下的（core 只报「删后」）。 */
function scanTotal(report: ImageBlobGcReport): number {
  const result = report.result;
  if (result === undefined) return 0;
  return result.reclaimed + result.referenced + result.orphans;
}

/** 定时执行的参数 */
export interface ImageBlobGcScheduleOptions extends ImageBlobGcOptions {
  /** 间隔小时（默认 6，夹到 [1, 168]） */
  intervalHours?: number;
  /** 每趟的报告（装配层接日志 / 事件 / 环境卡） */
  onReport: (report: ImageBlobGcReport) => void;
  /** 定时器工厂（测试缝；缺省 `setInterval`） */
  setInterval?: (fn: () => void, ms: number) => { unref?: () => void };
}

/** 定时间隔的缺省与上下界。 */
export const DEFAULT_BLOB_GC_INTERVAL_HOURS = 6;
export const MIN_BLOB_GC_INTERVAL_HOURS = 1;
export const MAX_BLOB_GC_INTERVAL_HOURS = 168;

/** 定时执行器（`stop()` 之后不再触发；在飞的这一趟照旧跑完）。 */
export interface ImageBlobGcRunner {
  /** 手动跑一趟（`dryRun` 缺省跟随参数） */
  runOnce(dryRun?: boolean): Promise<ImageBlobGcReport>;
  stop(): void;
}

/**
 * 启动 GC 定时器：**第一趟永远 dry-run**（只报「将删 N / 共 M」），之后按间隔真删。
 *
 * 为什么第一趟固定 dry-run：刚启动的进程最可能把引用集合算错（装配不完整 / 数据目录
 * 刚挂上），而删除不可逆。给人一次看数字的机会，比事后解释便宜得多。
 *
 * 定时器 `unref()`：GC 不该让一个本该退出的进程（一次性 CLI）活着。
 */
export function startImageBlobGc(options: ImageBlobGcScheduleOptions): ImageBlobGcRunner {
  const intervalHours = Math.min(
    Math.max(options.intervalHours ?? DEFAULT_BLOB_GC_INTERVAL_HOURS, MIN_BLOB_GC_INTERVAL_HOURS),
    MAX_BLOB_GC_INTERVAL_HOURS,
  );
  const schedule = options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  let stopped = false;
  let first = true;
  let inFlight = false;

  const runOnce = async (dryRun?: boolean): Promise<ImageBlobGcReport> => {
    // 上一趟还没跑完就不叠（扫全库是重活，叠加只会互相拖慢）。
    if (inFlight) {
      return {
        dryRun: true,
        scanned: { sessions: 0, shells: 0, referenced: 0, unreadable: 0 },
        aborted: { reason: 'previous pass still running' },
      };
    }
    inFlight = true;
    try {
      const report = await runImageBlobGc({
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
    void runOnce().catch(() => undefined);
  }, intervalHours * 3_600_000);
  timer.unref?.();

  // 启动后的第一趟（dry-run）立刻排进队列：**不阻塞首帧**（`setTimeout 0`），
  // 但必须在第一趟真删之前把「将删 N / 共 M」报出来 —— 这是给人看的唯一一次机会。
  const firstPass = setTimeout(() => {
    if (stopped) return;
    void runOnce(true).catch(() => undefined);
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
