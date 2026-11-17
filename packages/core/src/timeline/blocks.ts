/**
 * chunk 块格式与写入（0.54 A 阶段起步，0.57 改成**可追加块**；ADR-105 §4）。
 *
 * chunk 不逐条写 ndjson（一次长 run 上千条、~200 B/条编码开销），而是进块：
 *
 * ```
 * wal.blocks/000007.wblk   [u64 LE seq][u32 LE len][utf8 JSON record]  × N   ← chunk 帧
 *                          [u64 LE seq][u32 LE 0xffffffff]             × M   ← 事实标记帧
 * wal.manifest            {"v":1,"kind":"block","block":"000007.wblk","start_seq":…,…}\n
 * ```
 *
 * ## 0.57：块从「定长容器」变成「run 级容器（可追加）」
 *
 * 旧口径：块攒满 `BLOCK_MAX_BYTES`（32 KiB）/ 空闲 150 ms / 遇见非 chunk 事件就封，
 * 于是一次长 run 被切成几十个块（实测真身 20 万 seq → **13,177 个块**，p50 只有 2.6 KiB）。
 * 运行期开销全在「块数」上：一次范围读要枚举、定位、逐块开文件。
 *
 * 新口径：**一个 run 一个块**。第一条 chunk 到达时建块文件，之后每条 chunk 都往**块尾
 * append**，只有四件事让它收口（{@link ChunkBlockStore.seal}）：
 *
 * | 时机 | 谁触发 | 为什么 |
 * | --- | --- | --- |
 * | run 换人（chunk 的 `run_id` 变了） | `writer.ts#chunkStep` | 「一个 run 一个块」的边界 |
 * | 撞上硬上限 `BLOCK_MAX_BYTES`（4 MiB） | `writer.ts#chunkStep` | 单块读的上界（一个 run 写爆也要能读） |
 * | `close()` | `writer.ts#close` | 关闭即收口 |
 * | 崩溃后 `open()` 补记账 | {@link ChunkBlockStore.sealTrailingUnrecordedBlocks} | 「写了但没记账」的尾块 |
 *
 * 空闲定时器**不再封块**，只做「落盘 + 发布」（{@link ChunkBlockStore.flushActive}）：
 * 发布延迟仍然是 `≤ chunk_flush_ms`（ADR-105 I2 的 P95 预算不变），块却不再被切碎。
 *
 * ## 块区间里为什么会夹着事实行（以及事实标记帧）
 *
 * 块只装 chunk，但每个 run 的 chunk 流中间夹着事实行（`llm.request` / `llm.response` /
 * `tool.call.*` …），它们是 `wal.log` 的行、按 seq 与 chunk 交错分配。所以一个块的覆盖
 * 区间 `[start_seq, end_seq]` 会横跨若干事实行。为了让块**自描述覆盖**——`[start,end]` 里
 * 每个 seq 都能在块文件里找到一句「它在这」——写事实行的同时在块尾追加一个 12 字节的
 * **事实标记帧**（`wal.ts#FACT_MARKER_LENGTH`）：它只声明「这个 seq 是事实、载荷不在这里」。
 *
 * 三件事因此不必改口径：
 * 1. 恢复时 `missingRanges` 把标记帧当「合法缺席」，不会把段内事实判成丢帧（假洞）；
 * 2. 撕裂尾帧的识别不变（标记帧也是定长帧头）；
 * 3. 块区间仍然**逐号自描述**：`frames + markers == manifest.count`，少一个就是坏块。
 *
 * 「事实先于 chunk 可见」的顺序**没变**：事实内容仍然只写 `wal.log`，而且写它之前
 * `flushActive` 已经把更早的 chunk fsync 过（严格交错只从「封块」降级成「落盘」，见
 * `writer.ts#factStep`）。标记帧不带任何载荷，所以它不改变任何可见性。
 *
 * ## 前缀守卫（append-only）
 *
 * 块文件建好之后**只允许在块尾 append**：已发出的字节一个都不重写（`handle.write` 顺序追加，
 * 从不 seek 回去）。manifest 条目只在最后一次 fsync 之后写一次，描述整块的
 * `[start_seq,end_seq] / bytes / crc32 / count`；写失败 ⇒ 回滚到上次记账的长度
 * （{@link ChunkBlockStore.rollbackFlush}），回滚不了就放弃这个块（不写条目 ⇒ 恢复按撕裂
 * 尾帧截断），绝不把半截字节算进任何账。
 *
 * 本模块只提供「加帧 / 落盘 / 封块 / 恢复」四件事，外加「**哪些 chunk 配进块**」的唯一判据
 * （{@link isTransientChunkEvent}，0.54 chunk-slim）。
 *
 * @module @vessel-agent/core/timeline
 */

import { type FileHandle, mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { blockEnumerationCounters } from './enum-stats.js';
import {
  BLOCK_MAX_BYTES,
  isChunkEventType,
  TIMELINE_LAYOUT,
  type TimelineBlockEntry,
  type TimelineRecord,
  type TimelineSyncKind,
  type WalManifestLine,
} from './types.js';
import {
  type BlockEvidence,
  blockNumber,
  CHUNK_FRAME_HEADER_BYTES,
  type ChunkBlockDecode,
  type Crc32State,
  crc32Final,
  crc32Hex,
  crc32State,
  crc32Update,
  decodeChunkBlock,
  encodeChunkFrame,
  encodeFactMarker,
  findLineStartBefore,
  fsyncDirectory,
  type LineReadBudget,
  listBlockFiles,
  parseWithCrc,
  readCrcNdjsonFile,
  readFileWindow,
  readNdjsonLineAt,
  readNdjsonTail,
  truncateFile,
  withCrc,
} from './wal.js';

/**
 * `wal.manifest` 尾窗预算（只服务 `recovery: 'tail'`）。
 *
 * 一行 ≈ 150 B，64 KiB ≈ 400 个条目 —— 足够覆盖「最后一个块的条目」以及它前面若干条；
 * 上限 1 MiB。**超过就不猜**：拿不到尾窗就没有互校结论（`manifestCrossChecked = false`），
 * 写者退回全量恢复。
 */
const WAL_MANIFEST_TAIL_BYTES = 64 * 1024;
const WAL_MANIFEST_TAIL_MAX_BYTES = 1024 * 1024;

/*
 * ── 路由政策：哪些 chunk 配进块（0.54 chunk-slim） ─────────────────────────
 *
 * 「chunk 家族」不是一个整体。按**有没有持久化价值**，它分两类：
 *
 * | 子类型 | 是什么 | 刷新后从哪复原 |
 * | --- | --- | --- |
 * | `text_delta` / `reasoning_delta` | 正文 / 思考的正文增量 | 没有别的地方有 ⇒ **必须进块** |
 * | `tool_call_delta` / `finish` | 工具参数的画图增量 / 本次响应的收口 | `tool.call.started` 的 `arguments` + `tool.call.completed` 的产物 / `llm.response` |
 *
 * 后两类是**瞬时 UI 提示**，不是时间线事实（web 侧也早就这么判：`producesTimelineItem()`
 * 对它们恒 false，连环都不进）。它们原本仍然照写进块，代价是实测 69,159 帧
 * `tool_call_delta` 只承载 208 KB 参数片段，却因为每帧固定元数据（`v/seq/session_id/
 * run_id×2/ts/type/crc` + 12 B 帧头）占了 23 MB —— 单会话 83% 的块字节。
 *
 * 于是它们**退回「非持久化」那一类**，但**不是**退回老口子（`NON_PERSISTED_EVENT_TYPES`
 * 那条「一行一条写进 `events.ndjson`」，`subagent.llm.stream.chunk` 曾经就那么漏进去过）：
 * 它们停留在**实时通道**（hub 环）里，**从不请求 `timeline_seq`**。
 *
 * 为什么判据放在这里（而不是 `types.ts`）：`types.ts` 的 `isChunkEventType()` 回答
 * 「是不是 chunk 家族」（ADR-105 §8.1 规则 ④ 的白名单口径，一条都不能多）；本判据回答
 * 「这个 chunk 该不该进块」——那是**块格式**自己的政策，判据跟着块走，两件事不混。
 */
export const TRANSIENT_CHUNK_SUBTYPES: ReadonlySet<string> = new Set(['tool_call_delta', 'finish']);

/** 取 `llm.stream.chunk` 载荷里的子类型（`data.chunk.type`）；取不到 ⇒ `undefined`。 */
export function chunkSubtypeOf(event: { type: string; data?: unknown }): string | undefined {
  const data = event.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const chunk = (data as { chunk?: unknown }).chunk;
  if (typeof chunk !== 'object' || chunk === null || Array.isArray(chunk)) return undefined;
  const subtype = (chunk as { type?: unknown }).type;
  return typeof subtype === 'string' ? subtype : undefined;
}

/**
 * 这条事件是不是**瞬时 chunk**（`tool_call_delta` / `finish`）：不占 `timeline_seq`、
 * 不进块、不进 `events.ndjson`，只走实时通道。
 *
 * 必须**同时**满足「是 chunk 家族」+「子类型在 {@link TRANSIENT_CHUNK_SUBTYPES} 里」：
 * 只判子类型的话，将来别的事件类型里出现同名 `chunk.type` 会被误判成 chunk。
 *
 * 与 ADR-105 §3 I2 的关系（这是本判据存在的全部理由）：**不落盘 ⇒ 不许取 seq**。
 * 「照取 seq、只是不写进块」会让 `count` 里凭空多出被发布却不可读的 seq（= 洞），
 * 所以调用点必须在这条事件**进入 seq 分配之前**分叉（`run-journal.ts#appendFact`
 * 是第一刀，`writer.ts#validateInput` 是第二道闸门）。
 */
export function isTransientChunkEvent(event: { type: string; data?: unknown }): boolean {
  if (!isChunkEventType(event.type)) return false;
  const subtype = chunkSubtypeOf(event);
  return subtype !== undefined && TRANSIENT_CHUNK_SUBTYPES.has(subtype);
}

export interface ChunkBlockStoreOptions {
  maxBytes?: number;
  /** 测试缝：每次真正 fsync 之前调用；抛错 = 模拟 fsync 失败。 */
  beforeSync?: (kind: TimelineSyncKind) => void;
  /**
   * 恢复范围（第十一条：启动路径有界）。
   *
   * | 取值 | 解哪些块 | 用在哪 |
   * | --- | --- | --- |
   * | `'full'`（缺省） | **全部**块文件 + 全量 `wal.manifest` 互校 | 显式修复 / 索引不可信 / 尾窗不自洽 |
   * | `'tail'` | 只解**最后一个**块 + `wal.manifest` 尾窗互校 | 写者 `open()` 的增量路径 |
   *
   * `'tail'` 只是**少读**，不放松判定：最后一个块的撕裂尾帧照样截断、坏帧照样报
   * `invalid`、manifest 说写完但帧缺/块不在照样报（只是范围限制在尾部）。写者拿到
   * `manifestCrossChecked = false` 或非空 `invalid` 时必须退回 `'full'` —— 尾窗没看全的
   * 部分，只有全量恢复能下结论。
   */
  recovery?: 'full' | 'tail';
}

export interface ChunkBlockSeal {
  entry: TimelineBlockEntry;
  records: TimelineRecord[];
}

/** 恢复时解出来的一个块文件（补记账用；不长期持有整个 buffer）。 */
interface DecodedBlockFile {
  name: string;
  decode: ChunkBlockDecode;
  /** 截断撕裂尾帧之后的字节数（= 盘上现在真实的前缀长度）。 */
  bytes: number;
}

export interface ChunkBlockRecovery {
  records: TimelineRecord[];
  /** 完整但 CRC/形状不符的帧：seq 可读，写者必须登记成洞。 */
  invalid: Array<{ from_seq: number; to_seq: number; reason: string }>;
  /** 被截断过的块文件名（撕裂尾帧清理）。 */
  truncated: string[];
  /**
   * 本次恢复有没有把 `wal.manifest` 与本趟解出来的块**互校过**。
   *
   * `'full'` 恒 `true`。`'tail'` 下只有在「manifest 尾窗读得出来」且「尾窗覆盖到 manifest
   * 起点或至少含最后一个块的条目」时才是 `true`；否则为 `false` ⇒ 调用方**不许**用这次
   * 恢复的结论走增量路径（退回 `'full'`）。
   */
  manifestCrossChecked: boolean;
}

/** `wal.manifest` 一行的形状校验（crc 之外还要形状对，才配当「完整性证明」）。 */
function validateManifestLine(parsed: unknown): WalManifestLine | undefined {
  const line = parseWithCrc<WalManifestLine>(parsed);
  if (line === undefined || line.v !== 1 || line.kind !== 'block') return undefined;
  if (typeof line.block !== 'string' || line.block.length === 0) return undefined;
  if (!Number.isSafeInteger(line.start_seq) || line.start_seq < 1) return undefined;
  if (!Number.isSafeInteger(line.end_seq) || line.end_seq < line.start_seq) return undefined;
  if (!Number.isSafeInteger(line.count) || line.count < 1) return undefined;
  if (!Number.isSafeInteger(line.bytes) || line.bytes < 0) return undefined;
  if (typeof line.crc32 !== 'string' || line.crc32.length === 0) return undefined;
  return line;
}

/**
 * `wal.manifest` 尾窗里一行文本 → 条目（坏行 ⇒ `undefined`，与全量读同口径忽略）。
 *
 * 尾窗读给的是**原始行**（`wal.ts#readNdjsonTail` 不解析 JSON），所以这里补上「解析 +
 * 形状校验」，判据仍然只有 {@link validateManifestLine} 一份。
 */
function parseManifestText(text: string): WalManifestLine | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return validateManifestLine(parsed);
}

/**
 * 把 `[from..to]` 里不在 `present` 的 seq 压成连续区间。
 *
 * 单块最多 `BLOCK_MAX_BYTES / 12` 个 seq（≈2.7k），逐 seq 扫一遍完全可以接受；只在
 * **恢复**路径上跑一次，不在写路径上。
 */
function missingRanges(
  from: number,
  to: number,
  present: ReadonlySet<number>,
): Array<{ from_seq: number; to_seq: number }> {
  const ranges: Array<{ from_seq: number; to_seq: number }> = [];
  let start: number | undefined;
  for (let seq = from; seq <= to; seq += 1) {
    if (present.has(seq)) {
      if (start !== undefined) {
        ranges.push({ from_seq: start, to_seq: seq - 1 });
        start = undefined;
      }
      continue;
    }
    start ??= seq;
  }
  if (start !== undefined) ranges.push({ from_seq: start, to_seq: to });
  return ranges;
}

/**
 * **活动块**（0.57 可追加块）：一个块文件在「run 存活期间」一直开着，后面的 chunk 帧接着
 * 往块尾追加，直到 run 换人 / 撞硬上限 / `flush()` / `close()` 才封。
 *
 * 字段全部是**已落盘**的账（`flushActive` 写成功之后才更新），用来在封块时一次性写出
 * manifest 条目，以及交给 {@@link ChunkBlockStore.sealTrailingUnrecordedBlocks} 在崩溃
 * 恢复时补记账。
 */
interface ActiveBlock {
  readonly name: string;
  readonly handle: FileHandle;
  readonly runId: string;
  /** 块首帧的 seq（块永远以一条 chunk 帧开头：只有 push() 才建块）。 */
  readonly startSeq: number;
  /** 最后一个被覆盖的 seq（帧或事实标记帧）。 */
  endSeq: number;
  /** 已落盘字节数。 */
  bytes: number;
  /** 已落盘字节的 CRC32 累加状态（封块时收敛成 `crc32` 字段）。 */
  crc: Crc32State;
  /** 落盘的帧数（chunk 帧）与标记帧数（事实 seq）。 */
  frames: number;
  markers: number;
  /** 目录项是否已经 fsync 过（新块第一次落盘后做一次）。 */
  dirSynced: boolean;
}

/** chunk 块写入器（每会话一个，串行队列由 `TimelineWriter` 保证）。 */
export class ChunkBlockStore {
  private readonly pendingFrames: Buffer[] = [];
  private readonly pendingRecords: TimelineRecord[] = [];
  private readonly pendingManifests = new Set<Promise<void>>();
  private pendingBytes = 0;
  /** 待落盘帧所属的 run（`pendingRecords` 为空时 `undefined`）。 */
  private pendingRunId: string | undefined;
  /** 可追加的活动块；`undefined` = 现在没有开着的块。 */
  private active: ActiveBlock | undefined;
  private nextBlockNumber: number;
  private closed = false;

  private constructor(
    private readonly blocksDir: string,
    private readonly manifestPath: string,
    private readonly maxBytes: number,
    private readonly options: ChunkBlockStoreOptions,
    nextBlockNumber: number,
  ) {
    this.nextBlockNumber = nextBlockNumber;
  }

  /**
   * 打开块目录并恢复。
   *
   * - 每个块都解码；撕裂尾帧截断到最后一个完整帧（这些 seq 从未发布，可重新分配）；
   * - 完整但坏掉的帧进 `invalid`，由写者登记为洞；
   * - **manifest 是完整性证明**：`wal.manifest` 的行只在块文件 fsync **之后**才写，
   *   所以「有 manifest 行、seq 却读不到」= 发布过的数据真的丢了（归 manifest 或
   *   外部损坏），必须登记成洞（ADR-105 §3 I4：回退区间必须出现在 `holes` 里）。
   *   没有 manifest 行 = 崩在「块已 fsync、manifest 还没写」之间，帧本身都在，
   *   因此不参与这条判定（避免把正常崩溃误判成丢数据）；
   * - 下一个块号从现有最大块号 + 1 开始（崩溃留下的半块不会被续写）。
   *
   * `options.recovery` 决定**解几个块**（见 {@link ChunkBlockStoreOptions.recovery}）：
   * `'full'` 全解，`'tail'` 只解最后一个 + 只拿 manifest 尾窗互校。`'tail'` 存在的唯一
   * 理由是写者 `open()` 要满足第十一条（启动路径不许 O(会话大小)）—— 12,900 个块文件
   * 88 MB 也只在「最后一个块」这一小块上花时间，判定口径一个字都不放松。
   */
  static async open(
    sessionDir: string,
    options: ChunkBlockStoreOptions = {},
  ): Promise<{ store: ChunkBlockStore; recovery: ChunkBlockRecovery }> {
    const blocksDir = join(sessionDir, TIMELINE_LAYOUT.walBlocks);
    await mkdir(blocksDir, { recursive: true });
    const names = await listBlockFiles(blocksDir);
    const tailOnly = options.recovery === 'tail';
    // 上界：`'tail'` 只解 1 个块文件（≤ `maxBytes` + 一帧），`'full'` 解全部。
    const decodedNames = tailOnly ? names.slice(-1) : names;
    const records: TimelineRecord[] = [];
    const invalid: ChunkBlockRecovery['invalid'] = [];
    const truncated: string[] = [];
    /** 每个块里「被覆盖」的 seq（chunk 帧 / 坏帧 / 事实标记帧）：manifest 比对用。 */
    const coveredByBlock = new Map<string, Set<number>>();
    /** 解出来的尾部块（补记账用：见 {@link sealTrailingUnrecordedBlocks}）。 */
    const decodedBlocks: DecodedBlockFile[] = [];
    let maxNumber = 0;
    for (const name of names) maxNumber = Math.max(maxNumber, blockNumber(name));
    for (const name of decodedNames) {
      const path = join(blocksDir, name);
      const buffer = await readFile(path).catch(() => undefined);
      if (buffer === undefined) continue;
      // 空块文件（崩在「建文件」与「第一次落盘」之间）：一个字节的数据都没有，删掉它。
      // 留着会让块号序列出现一个「空档」，而且 `lastBlockSeq` 会读到 0（尾部看起来像没有
      // 任何数据）。删它不违反 append-only：里面从来没有过内容。
      if (buffer.length === 0) {
        await unlink(path).catch(() => {});
        continue;
      }
      const decode = decodeChunkBlock(buffer);
      records.push(...decode.records);
      invalid.push(...decode.invalid);
      const covered = new Set<number>();
      for (const record of decode.records) covered.add(record.seq);
      // 坏帧自己已经登记进 `invalid`（写者会为它建洞），不重复算成「丢了」。
      for (const item of decode.invalid) {
        for (let seq = item.from_seq; seq <= item.to_seq; seq += 1) covered.add(seq);
      }
      // **事实标记帧**（0.57）：这些 seq 是故意不在本块里的事实行（载荷在 `wal.log`）。
      // 不把它们算进覆盖集合，`missingRanges` 就会把块区间里每一件事实都判成丢帧
      // （= 往 `holes.ndjson` 里写假洞，读侧会把可读的事实行当成不可读）。
      for (const seq of decode.markers) covered.add(seq);
      coveredByBlock.set(name, covered);
      let bytes = buffer.length;
      if (decode.torn) {
        await truncateFile(path, decode.validBytes);
        truncated.push(name);
        bytes = decode.validBytes;
      }
      decodedBlocks.push({ name, decode, bytes });
    }

    // manifest ↔ 块文件互相校验（I4 对块内丢帧同样适用）。
    const manifestPath = join(sessionDir, TIMELINE_LAYOUT.walManifest);
    let manifestCrossChecked = true;
    /** manifest 里出现过的**最大块号**（补记账的边界：只补它之后的连续尾部块）。 */
    let entryMaxNumber = 0;
    if (tailOnly) {
      const exists = await stat(manifestPath).catch(() => undefined);
      const last = decodedNames[decodedNames.length - 1];
      if (exists !== undefined) {
        // manifest 是目录、可由扫描重建：不整份读，只看尾部（有界）。
        const window = await readNdjsonTail(
          manifestPath,
          WAL_MANIFEST_TAIL_BYTES,
          WAL_MANIFEST_TAIL_MAX_BYTES,
        );
        if (window === undefined) {
          manifestCrossChecked = false;
        } else {
          // 崩在「manifest 追加中途」会留下半行；截掉它，否则下一次追加会接在半行后面。
          if (window.truncateTo !== undefined) {
            await truncateFile(manifestPath, window.truncateTo);
          }
          for (const text of window.lines) {
            const entry = parseManifestText(text);
            if (entry === undefined) continue; // 坏行：与全量读同一口径忽略
            entryMaxNumber = Math.max(entryMaxNumber, blockNumber(entry.block));
            const covered = coveredByBlock.get(entry.block);
            if (covered === undefined) {
              // 只对「比最后解出来的块更新」的条目下结论（更早的块本趟没解，留给显式修复）。
              if (last !== undefined && entry.block <= last) continue;
              invalid.push({
                from_seq: entry.start_seq,
                to_seq: entry.end_seq,
                reason: 'chunk_block_file_missing',
              });
              continue;
            }
            for (const range of missingRanges(entry.start_seq, entry.end_seq, covered)) {
              invalid.push({ ...range, reason: 'chunk_block_short_of_manifest' });
            }
          }
        }
      }
    } else {
      const manifest = await readCrcNdjsonFile<WalManifestLine>(
        manifestPath,
        validateManifestLine,
      ).catch(() => undefined);
      // 崩在「manifest 追加中途」会留下半行；截掉它，否则下一次追加的行会接在半行后面
      // 变成一行坏 JSON —— 一条条目丢失就等于一条完整性证明丢失（目录是派生数据，可截）。
      if (manifest?.truncateTo !== undefined) {
        await truncateFile(manifestPath, manifest.truncateTo);
      }
      for (const entry of manifest?.items ?? []) {
        entryMaxNumber = Math.max(entryMaxNumber, blockNumber(entry.block));
        const covered = coveredByBlock.get(entry.block);
        if (covered === undefined) {
          // manifest 说这个块写完了，块文件却不在 ⇒ 整段丢失（块只写一次、永不重写）。
          invalid.push({
            from_seq: entry.start_seq,
            to_seq: entry.end_seq,
            reason: 'chunk_block_file_missing',
          });
          continue;
        }
        for (const range of missingRanges(entry.start_seq, entry.end_seq, covered)) {
          invalid.push({ ...range, reason: 'chunk_block_short_of_manifest' });
        }
      }
    }
    invalid.sort((a, b) => a.from_seq - b.from_seq);

    const store = new ChunkBlockStore(
      blocksDir,
      join(sessionDir, TIMELINE_LAYOUT.walManifest),
      options.maxBytes ?? BLOCK_MAX_BYTES,
      options,
      maxNumber + 1,
    );
    // 「写了、但 manifest 还没记上」的尾部块：在这里补一条条目。
    //
    // 这是可追加块的**崩溃平义**落点：块在 run 存活期间一直开着，封块（= 写 manifest 行）
    // 只发生在 run 换人 / 撞硬上限 / flush / close。所以进程被杀之后，最后一个块几乎必然
    // 处于「字节都在、目录没记」的状态。不补的话它会**永久**缺一条目录行，而
    // `ManifestNameSource` 按行序枚举（只往前走），中间缺一条就会静默少枚举一个块 ——
    // 覆盖算术随后报 `coverage_gap` 并降级整份读：正确但每次都慢。
    //
    // 补记账只补**尾部连续**的那一段（块号 > manifest 已有的最大块号）：行序必须跟着块号走。
    await store.sealTrailingUnrecordedBlocks(decodedBlocks, entryMaxNumber);
    return { store, recovery: { records, invalid, truncated, manifestCrossChecked } };
  }

  /** 当前待落盘的记录数。 */
  pendingCount(): number {
    return this.pendingRecords.length;
  }

  /** 当前待落盘的字节数。 */
  pendingSize(): number {
    return this.pendingBytes;
  }

  /** 有没有「开着的块」或「还没落盘的帧」（`false` = 封块无事可做）。 */
  hasOpenBlock(): boolean {
    return this.active !== undefined || this.pendingRecords.length > 0;
  }

  /** 活动块已落盘的字节数（封块上限判断 / 诊断用）。 */
  activeBytes(): number {
    return this.active?.bytes ?? 0;
  }

  /** 活动块（或待落盘帧）属于哪个 run；都没有 ⇒ `undefined`。 */
  currentRun(): string | undefined {
    return this.active?.runId ?? this.pendingRunId;
  }

  /**
   * 把一帧放进**待落盘缓冲**（同步；不落盘）。
   *
   * 写者必须在**同一个串行队列里**接着调用 {@link flushActive}（让 chunk 变 durable、
   * 之后才发布）或 {@link seal}（块收口），这样不会有两个追加并发。
   */
  push(record: TimelineRecord): void {
    if (this.closed) throw new Error('chunk_block_store_closed');
    const frame = Buffer.from(encodeChunkFrame(record));
    this.pendingFrames.push(frame);
    this.pendingRecords.push(record);
    this.pendingBytes += frame.length;
    this.pendingRunId ??= record.run_id;
  }

  /**
   * 活动块（含待落盘帧）是否撞上硬上限（封块时机 ①）。
   *
   * 可追加块之后这是**唯一**的尺寸类封块条件：空闲定时器不再封块，改成「落盘 + 发布」
   * （见 {@link flushActive}），否则又会变回「每 150 ms 一个块」。
   */
  shouldSeal(): boolean {
    return (
      this.pendingRecords.length > 0 &&
      (this.active?.bytes ?? 0) + this.pendingBytes >= this.maxBytes
    );
  }

  /**
   * 把待落盘的帧**追加**到活动块尾 + fsync，返回这一批切片（供发布）。
   *
   * 这是可追加块的核心：块文件从第一条 chunk 起就开着（`open(..., 'wx')` 只创建一次），
   * 之后每条 chunk 都只往后 append，**前面已经发出去的字节一个都不动**（前缀守卫）。
   *
   * 三条纪律：
   * 1. **记账只在 `write` + `fsync` 成功之后**（I2：publish 只能在 WAL fsync 之后），
   *    所以 `bytes` / `crc` / `endSeq` 永远描述「盘上真实存在的前缀」；
   * 2. 失败 ⇒ 回滚到这次追加之前的长度（见 {@link rollbackFlush}）；回滚不了就放弃这个块
   *    （不写条目 ⇒ 恢复时按撕裂尾帧截断），绝不把半截字节算进任何账；
   * 3. 新块第一次落盘后 fsync 一次目录：**块文件先于事实行可见**是 `selectBlocksForSnapshot`
   *    的快照前提（见 `wal.ts` 那段长注释）。
   */
  async flushActive(): Promise<ChunkBlockSeal | undefined> {
    if (this.closed) throw new Error('chunk_block_store_closed');
    if (this.pendingRecords.length === 0) return undefined;
    const buffer = Buffer.concat(this.pendingFrames);
    const records = this.pendingRecords.slice();
    const previousBytes = this.active?.bytes ?? 0;
    const created = this.active === undefined;
    let active = this.active;
    try {
      if (active === undefined) {
        const name = `${String(this.nextBlockNumber).padStart(6, '0')}.wblk`;
        const handle = await open(join(this.blocksDir, name), 'wx', 0o600);
        active = {
          name,
          handle,
          runId: records[0]?.run_id ?? '',
          startSeq: records[0]?.seq ?? 0,
          endSeq: records[records.length - 1]?.seq ?? 0,
          bytes: 0,
          crc: crc32State(),
          frames: 0,
          markers: 0,
          dirSynced: false,
        };
      }
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesWritten } = await active.handle.write(buffer, offset, buffer.length - offset);
        if (bytesWritten <= 0) throw new Error('chunk_block_write_failed');
        offset += bytesWritten;
      }
      this.options.beforeSync?.('block');
      await active.handle.sync();
      if (!active.dirSynced) {
        await fsyncDirectory(this.blocksDir);
        active.dirSynced = true;
      }
    } catch (error) {
      await this.rollbackFlush(active, created, previousBytes);
      throw error;
    }

    crc32Update(active.crc, buffer);
    active.bytes += buffer.length;
    active.endSeq = records[records.length - 1]?.seq ?? active.endSeq;
    active.frames += records.length;
    this.active = active;
    this.pendingFrames.length = 0;
    this.pendingRecords.length = 0;
    this.pendingBytes = 0;
    this.pendingRunId = undefined;

    const entry: TimelineBlockEntry = {
      block: active.name,
      start_seq: records[0]?.seq ?? 0,
      end_seq: records[records.length - 1]?.seq ?? 0,
      offset: previousBytes,
      bytes: buffer.length,
      count: records.length,
      crc32: crc32Hex(buffer),
    };
    return { entry, records };
  }

  /**
   * 在活动块尾追加一个**事实标记帧**（12 B，见 `wal.ts#FACT_MARKER_LENGTH`）。
   *
   * 为什么需要它：块只装 chunk，但块的覆盖区间会横跨事实行（同一个 run 的 chunk 之间夹着
   * `llm.request` / `llm.response` / `tool.call.*` 这些事实）。标记帧就是「这个 seq 是事实，
   * 本块故意不含它」的**自描述**声明 —— 恢复时据此把段内事实算作「合法缺席」，
   * 而不是丢帧（否则每件事实都会被登记成一个假洞）。
   *
   * **不 fsync**：块在没封块之前没有 manifest 条目，没人会拿条目跟它对账；而任何一次
   * 后续帧的 fsync 都会把这个标记一起刷下去。封块时（{@link seal}）此前必然还有一次
   * fsync，所以条目描述的永远是「标记也在盘上」的那份字节。
   *
   * 写失败 ⇒ 抛；调用方必须**立刻封块**（封到最后一个已落盘帧为止，于是这条事实落在区间外），
   * 不能再往这个块里追加。
   */
  async markFact(seq: number): Promise<void> {
    if (this.closed) throw new Error('chunk_block_store_closed');
    const active = this.active;
    if (active === undefined) return; // 没有开着的块 ⇒ 这条事实不属于任何块区间
    if (this.pendingRecords.length > 0) {
      throw new Error('chunk_block_marker_with_pending_frames');
    }
    const frame = Buffer.from(encodeFactMarker(seq));
    try {
      let offset = 0;
      while (offset < frame.length) {
        const { bytesWritten } = await active.handle.write(frame, offset, frame.length - offset);
        if (bytesWritten <= 0) throw new Error('chunk_block_write_failed');
        offset += bytesWritten;
      }
    } catch (error) {
      // 半截标记帧留在块尾：截回已记账的长度（截不动就只能放弃这个块）。
      await this.rollbackFlush(active, false, active.bytes);
      throw error;
    }
    crc32Update(active.crc, frame);
    active.bytes += frame.length;
    active.endSeq = seq;
    active.markers += 1;
  }

  /**
   * 封块：把待落盘帧追加落盘（若有）→ 关闭块文件 → 追加 manifest 条目。
   *
   * 条目描述**整个块**（首帧 seq … 最后一个覆盖到的 seq、总字节、总 crc、帧数 + 标记数），
   * 只在最后一次 fsync 之后写；manifest 依旧是「目录」、可扫描重建，因此追加失败不影响
   * 正确性（恢复会补记账，见 `open()` 里的 `sealTrailingUnrecordedBlocks`）。
   *
   * 返回**最后一次追加**的切片（供发布）；没有待落盘帧 ⇒ `undefined`。
   */
  async seal(): Promise<ChunkBlockSeal | undefined> {
    if (this.closed) throw new Error('chunk_block_store_closed');
    const tail = await this.flushActive();
    const active = this.active;
    if (active === undefined) return tail;
    await active.handle.close().catch(() => {});
    this.active = undefined;
    this.nextBlockNumber += 1;
    const entry: TimelineBlockEntry = {
      block: active.name,
      start_seq: active.startSeq,
      end_seq: active.endSeq,
      offset: 0,
      bytes: active.bytes,
      count: active.frames + active.markers,
      crc32: crc32Final(active.crc),
    };
    const manifestWrite = this.appendManifest(entry).catch(() => {});
    this.pendingManifests.add(manifestWrite);
    void manifestWrite.then(() => this.pendingManifests.delete(manifestWrite));
    return tail;
  }

  /**
   * 一次追加失败的回滚（把块文件恢复到这次追加之前的长度）。
   *
   * 为什么必须回滚：调用方会把这一批 seq 登记成洞；这些帧的字节若留在块里，洞就与
   * 「可读记录」重叠（读侧看到「声明坏了却能读」的同一段）。回滚失败 ⇒ **放弃这个块**
   * （`active = undefined`，也绝不写 manifest 条目）：下次恢复按撕裂尾帧截断它，
   * 它不会被当成一个完好块。
   */
  private async rollbackFlush(
    active: ActiveBlock | undefined,
    created: boolean,
    previousBytes: number,
  ): Promise<void> {
    if (active === undefined) return;
    await active.handle.close().catch(() => {});
    const path = join(this.blocksDir, active.name);
    if (created) {
      await unlink(path).catch(() => {});
      return;
    }
    if (this.active !== undefined) {
      // 已经落盘的那一段还完整 ⇒ 缩回原长度，块继续可用。
      try {
        const handle = await open(path, 'r+');
        try {
          await handle.truncate(previousBytes);
        } finally {
          await handle.close().catch(() => {});
        }
        this.active = {
          ...this.active,
          handle: await open(path, 'a', 0o600),
        };
        return;
      } catch {
        // 缩不回去：块尾留着半截帧，放弃它（条目缺失 ⇒ 恢复按撕裂尾帧截断）。
      }
    }
    this.active = undefined;
  }

  /**
   * 打开时给「写了、manifest 还没记账」的尾部块补一条条目（0.57 崩溃平义）。
   *
   * 只补块号 > `entryMaxNumber` 的**尾部连续块**：manifest 的行序必须跟着块号走
   * （`ManifestNameSource` 只往前走），乱序补行等于往枚举里塞坏数据。条目的每一项都从
   * 块文件本身算出来（`coveredFirst` / `coveredLast` / 字节数 / crc32 / 帧账），
   * 所以它描述的是**盘上真实存在的那个块**，而不是谁的记忆。
   */
  private async sealTrailingUnrecordedBlocks(
    decoded: readonly DecodedBlockFile[],
    entryMaxNumber: number,
  ): Promise<void> {
    for (const item of decoded) {
      const number = blockNumber(item.name);
      if (!Number.isSafeInteger(number) || number <= entryMaxNumber) continue;
      const start = item.decode.coveredFirst;
      const end = item.decode.coveredLast;
      if (start === undefined || end === undefined) continue; // 空块：没有可记的区间
      // crc 必须覆盖**整个块文件字节**（与封块时同一口径）。这里重读一次：尾部块只有
      // 一两个，字节数有界，不值得为了省这次读把全文缓冲留在内存里。
      const bytes = await readFile(join(this.blocksDir, item.name)).catch(() => undefined);
      if (bytes === undefined) continue;
      const entry: TimelineBlockEntry = {
        block: item.name,
        start_seq: start,
        end_seq: end,
        offset: 0,
        bytes: bytes.length,
        count: item.decode.evidence.frames + item.decode.evidence.markers,
        crc32: crc32Hex(bytes),
      };
      try {
        await this.appendManifest(entry);
      } catch {
        // 补记账失败不影响正确性：块字节都在，读写都不靠这一行（只是枚举快路径要退一档）。
      }
    }
  }

  /** 等所有后台 manifest 追加落盘（flush / close 时调用）。 */
  async flushManifests(): Promise<void> {
    while (this.pendingManifests.size > 0) {
      const pending = [...this.pendingManifests];
      this.pendingManifests.clear();
      await Promise.allSettled(pending);
    }
  }

  /**
   * 放弃待落盘的帧（写失败后调用）：返回尚未落盘的记录并清空缓冲。
   *
   * 调用方负责把这些 seq 登记成洞、拒绝等待中的 append promise。
   */
  takePending(): TimelineRecord[] {
    const records = this.pendingRecords.slice();
    this.pendingFrames.length = 0;
    this.pendingRecords.length = 0;
    this.pendingBytes = 0;
    this.pendingRunId = undefined;
    return records;
  }

  /** 关闭（不再写；未封的块由调用方先 `seal()` 或 `takePending()`）。 */
  close(): void {
    this.closed = true;
    void this.active?.handle.close().catch(() => {});
    this.active = undefined;
  }

  private async appendManifest(entry: TimelineBlockEntry): Promise<void> {
    const line: WalManifestLine = withCrc({ v: 1 as const, kind: 'block' as const, ...entry });
    const buffer = Buffer.from(`${JSON.stringify(line)}\n`, 'utf8');
    const handle = await open(this.manifestPath, 'a', 0o600);
    try {
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
        if (bytesWritten <= 0) throw new Error('wal_manifest_write_failed');
        offset += bytesWritten;
      }
      this.options.beforeSync?.('manifest');
      await handle.sync();
    } finally {
      await handle.close().catch(() => {});
    }
  }
}

/*
 * ── 范围读的定位与自证（0.56 · 时间线范围读） ────────────────────────────────
 *
 * 这一节只服务「按 `sinceSeq` 读一页」那一件事，回答两个问题：
 *
 * 1. **从哪个块开始开？**（{@link locateRangeAnchor}）
 *    - 首选 `wal.manifest` 锚点：对该文件做**按字节的行二分**，不整份解析（169 ms）。
 *      它只是**目录**，追加是 best-effort（{@link ChunkBlockStore.seal} 里 `.catch(() => {})`），
 *      所以它只负责「给出一个起点」，**块的全集永远以 `readdir` 为准**；
 *    - 退路（manifest 缺失 / 不可信 / 命中条目邻域不自洽）：**文件名二分 + 首帧 12 B**
 *      （{@link lastBlockAtOrBefore}）。这条依据只依赖三条写侧不变量：块只写一次
 *      （`open('wx')`）、块号单调（`maxNumber + 1`）、seq 单调分配 —— 一个落盘元数据都不用。
 * 2. **这个块配不配当证据？**（{@link verifyBlockAgainstManifest}）
 *    ①首末 seq ②条数 ③整块 crc32 ④完整性（撕裂）。
 *
 * **纪律（0.56 设计 §3.1 / §9）**：判据不成立只许**放宽**（多读一个块、降级整份读），
 * 永不许缩窄。所以本模块的函数**只回答事实**，不做 `if (crc 不符) continue` 这种决定 ——
 * 「不通过」的块照样被读出来，是否降级由上层的**覆盖算术**（`wal.ts#readTimelineRange`）说。
 */

/** manifest 锚点定位的总读字节预算（一行约 150 B；超过它就说「不知道」，换退路）。 */
const MANIFEST_PROBE_BUDGET_BYTES = 512 * 1024;

/** 二分探针次数上限（实测 13,177 行只用 12 次；五倍余量之后就说「不知道」）。 */
const ANCHOR_PROBE_LIMIT = 64;

/** 首帧探测读的字节数：帧头是 `[u64 seq][u32 len]`，8 B 足够取 seq，12 B 顺带把 len 一起读进来。 */
const FIRST_FRAME_BYTES = 12;

/** manifest 一行的物理上限（行长超过它就不是这个文件该有的形状，不猜）。 */
const MANIFEST_LINE_MAX_BYTES = 64 * 1024;

/** 邻域检查窗口（查「下一条的 start_seq > 本条的 end_seq」）。 */
const MANIFEST_NEIGHBOR_BYTES = 4 * 1024;

/** 逐块比对时 manifest 的顺序读窗（8 KiB ≈ 54 行，一次块打开最多读一窗）。 */
const MANIFEST_STREAM_WINDOW = 8 * 1024;

/** manifest 条目 ↔ 块文件的匹配滑动上限（条目比块多时最多跳这么多条就放弃比对）。 */
const MANIFEST_MATCH_SKIP_LIMIT = 64;

/** `wal.manifest` 里定位到的锚点条目（含它在文件里的字节区间，供邻域检查与顺序读用）。 */
export interface ManifestAnchor {
  entry: WalManifestLine;
  /** 该行在文件里的起点（含行首）。 */
  lineStart: number;
  /** 该行之后（含行尾换行）的偏移。 */
  lineEnd: number;
}

/**
 * 在 `wal.manifest` 里二分出**第一条 `end_seq >= sinceSeq` 的条目**（按字节行二分）。
 *
 * 为什么是「`end_seq >= sinceSeq`」而不是「区间包含 `sinceSeq`」：`sinceSeq` 可能落在
 * 一段**事实行**里（块不覆盖它），此时正确的起点是「它之后第一个块」。
 *
 * 判据只有一份：{@link validateManifestLine}（坏行跳过，不当锚点也不当证据）。
 * 取不到（文件缺失 / 空 / 全无有效行 / 探针用尽）⇒ `undefined`，由调用方换退路。
 */
async function locateManifestAnchor(
  manifestPath: string,
  sinceSeq: number,
): Promise<ManifestAnchor | undefined> {
  // 判据只有一份：{@link locateManifestEntry}（键 = `end_seq`，见那里的长注释）。
  return locateManifestEntry(manifestPath, sinceSeq, 'end_seq');
}

/**
 * 邻域自洽：`上一条.end_seq < 本条.start_seq <= 本条.end_seq < 下一条.start_seq`。
 *
 * 这是在验 0.56 设计 §2.1 的前提「manifest 行序 = 块号序 = `start_seq` 单调」。不成立
 * ⇒ 不拿它当锚点（换文件名二分），**不是**拿它当「附近找找」的起点。读不出来的邻域
 * （文件短 / 行坏）算「没有证据」而不是「有证据说它错」。
 */
async function manifestNeighborhoodOk(
  manifestPath: string,
  anchor: ManifestAnchor,
  size: number,
): Promise<boolean> {
  // 上一条：读 [lineStart - 4 KiB, lineStart)，它的最后一整行必须以换行结束在 lineStart。
  if (anchor.lineStart > 0) {
    const from = Math.max(0, anchor.lineStart - MANIFEST_NEIGHBOR_BYTES);
    const buffer = await readFileWindow(manifestPath, from, anchor.lineStart - from);
    if (buffer !== undefined) {
      const lastNewline = buffer.lastIndexOf(0x0a, buffer.length - 2);
      const start = lastNewline + 1;
      if (lastNewline >= 0 || from === 0) {
        const previous = parseManifestText(buffer.toString('utf8', start, buffer.length));
        if (previous !== undefined && previous.end_seq >= anchor.entry.start_seq) return false;
      }
    }
  }
  // 下一条：从 lineEnd 往后读一窗，取第一整行。
  if (anchor.lineEnd < size) {
    const length = Math.min(MANIFEST_NEIGHBOR_BYTES, size - anchor.lineEnd);
    const buffer = await readFileWindow(manifestPath, anchor.lineEnd, length);
    if (buffer !== undefined) {
      const newline = buffer.indexOf(0x0a);
      if (newline !== -1) {
        const next = parseManifestText(buffer.toString('utf8', 0, newline));
        if (next !== undefined && next.start_seq <= anchor.entry.end_seq) return false;
      }
    }
  }
  return true;
}

/** 一个块文件的首帧 seq（读 12 B 就够）；读不到（空文件 / 短于帧头）⇒ `undefined`。 */
async function readFirstFrameSeq(path: string): Promise<number | undefined> {
  const buffer = await readFileWindow(path, 0, FIRST_FRAME_BYTES);
  if (buffer === undefined || buffer.length < CHUNK_FRAME_HEADER_BYTES) return undefined;
  const seq = Number(buffer.readBigUInt64LE(0));
  if (!Number.isSafeInteger(seq) || seq < 1) return undefined;
  return seq;
}

/**
 * 沿**文件名序**二分，找**最后一个首帧 seq <= `sinceSeq`** 的块下标（`-1` = 所有块都更靠后）。
 *
 * 依据只有三条写侧不变量（块只写一次、块号单调、seq 单调分配）：名字序 = 写入序 =
 * seq 序。`manifest` 缺失 / 被删 / 内容不可信时，这是**唯一**还能定位的根据，而它
 * 不需要任何落盘元数据 —— 这正是 0.56 设计 §5 最后一格「既不整份读也不跳过」的解法。
 */
async function lastBlockAtOrBefore(
  blocksDir: string,
  names: readonly string[],
  sinceSeq: number,
): Promise<number | undefined> {
  let lo = 0;
  let hi = names.length - 1;
  let probes = 0;
  let best = -1;
  while (lo <= hi && probes < ANCHOR_PROBE_LIMIT) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const name = names[mid];
    if (name === undefined) return undefined;
    const first = await readFirstFrameSeq(join(blocksDir, name));
    probes += 1;
    if (first === undefined) return undefined; // 首帧读不出来：不猜（空块 / 坏块）
    if (first <= sinceSeq) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** 一个块文件的首帧 seq（供范围读判断「起点是否已在事实边界之后」）；读不到 ⇒ `undefined`。 */
export async function blockFirstFrameSeq(
  sessionDir: string,
  name: string,
): Promise<number | undefined> {
  return readFirstFrameSeq(join(sessionDir, TIMELINE_LAYOUT.walBlocks, name));
}

/**
 * 「事实边界之后的第一个块」在 `names[]` 里的下标 —— 也就是连续尾块链的**链首**。
 *
 * 范围读为什么需要它：`selectBlocksForSnapshot` 对 `start_seq > factBoundary` 的块只认
 * 「紧接 `cursor + 1`」的连续尾块。一页若从尾链**中段**开始，光看那一段无法判断链在前面
 * 有没有断过（断过的块整段都不属于本趟快照，给出来就是**多给**）。所以链必须从
 * `factBoundary` 那一端重新验一遍。
 *
 * 返回 `undefined` = 二分不可判（首帧读不出来），由调用方降级。
 */
export async function locateTailChainStart(
  sessionDir: string,
  names: readonly string[],
  factBoundary: number,
): Promise<number | undefined> {
  if (names.length === 0) return 0;
  const last = await lastBlockAtOrBefore(
    join(sessionDir, TIMELINE_LAYOUT.walBlocks),
    names,
    factBoundary,
  );
  if (last === undefined) return undefined;
  return last + 1;
}

/** 范围读的起始块（`names[]` 里的下标）+ 它凭什么被选中（留痕）。 */
export interface BlockAnchor {
  index: number;
  block: string;
  /** `manifest` = 行二分命中；`first_frame` = 文件名二分 + 首帧 seq */
  source: 'manifest' | 'first_frame';
  /**
   * manifest 命中条目之后第一条待消费条目的字节偏移（逐块比对从这里往后顺序读）。
   * 没有可信条目（退路 / 邻域不自洽 / 命中条目不在目录里）⇒ `undefined`。
   */
  manifestPosition?: number;
}

/**
 * 定位「`[sinceSeq, …]` 从这个块开始开」。
 *
 * 顺序：`manifest` 锚点（**含邻域自洽 + 文件真的在 `names[]` 里**）→ 退路「文件名二分」。
 * 两条都不成立才返回 `undefined`（调用方降级整份读），**绝不**在中间挑一个「差不多」的。
 */
export async function locateRangeAnchor(
  sessionDir: string,
  names: readonly string[],
  sinceSeq: number,
): Promise<BlockAnchor | undefined> {
  const blocksDir = join(sessionDir, TIMELINE_LAYOUT.walBlocks);
  const manifestPath = join(sessionDir, TIMELINE_LAYOUT.walManifest);
  const anchor = await locateManifestAnchor(manifestPath, sinceSeq);
  if (anchor !== undefined) {
    const index = names.indexOf(anchor.entry.block);
    const size = (await stat(manifestPath).catch(() => undefined))?.size ?? 0;
    if (index >= 0 && (await manifestNeighborhoodOk(manifestPath, anchor, size))) {
      return {
        index,
        block: anchor.entry.block,
        source: 'manifest',
        manifestPosition: anchor.lineStart,
      };
    }
  }
  const fallback = await lastBlockAtOrBefore(blocksDir, names, sinceSeq);
  if (fallback === undefined) return undefined;
  // 所有块都比 `sinceSeq` 靠后 ⇒ 起点就是第一个块（`lastBlockAtOrBefore` 给 -1）。
  const index = Math.max(0, fallback);
  const block = names[index];
  if (block === undefined) return undefined;
  return { index, block, source: 'first_frame' };
}

/** 一个块与它 manifest 条目的四项比对结果（`failed` 空 = 全通过）。 */
export interface BlockSelfCheck {
  /** ①首末 seq ②条数 ③整块 crc32 ④完整性 全部成立 */
  ok: boolean;
  /** 不成立的项（稳定短名，留痕用）：`seq_range` / `count` / `crc32` / `torn`。 */
  failed: string[];
}

/**
 * 块 ↔ manifest 条目的四项比对（0.56 设计 §3.2 ①②③④）。
 *
 * **它只是证据，不是过滤条件**：不通过的块照样要被读出来（整份读根本不看 manifest），
 * 是否降级由「窗口覆盖算术」决定 —— 见 `wal.ts#readTimelineRange`。把这里写成
 * `if (!ok) continue` 就是 0.56 设计 §9 点名的那个「变快了、少几条、零报错」的写法。
 *
 * 0.57 可追加块带来的两处口径变化：
 * - 首末 seq 用「被覆盖的 seq」（含事实标记帧），不再只看最后一个**有效**记录 ——
 *   否则「块尾是标记帧」会被误判成区间不符；
 * - 条数把标记帧一起算（`frames + markers`），漏算标记帧就会把「标记丢了」误判成条数不符。
 *
 * `evidence` 来自 {@link summarizeChunkBlock}（只走帧头）或整块解码的 `decode.evidence`：
 * 两种来源的口径**逐字段相同**，所以范围读不必为了自证去解析上万条载荷。
 */
export function verifyBlockAgainstManifest(
  buffer: Uint8Array,
  evidence: BlockEvidence,
  entry: WalManifestLine,
): BlockSelfCheck {
  const failed: string[] = [];
  if (evidence.coveredFirst !== entry.start_seq || evidence.coveredLast !== entry.end_seq) {
    failed.push('seq_range');
  }
  if (evidence.frames + evidence.markers !== entry.count) failed.push('count');
  if (crc32Hex(buffer) !== entry.crc32) failed.push('crc32');
  // 有 manifest 条目的块必须完整：条目只在块 fsync 之后才追加。
  if (evidence.torn) failed.push('torn');
  return { ok: failed.length === 0, failed };
}

/**
 * `wal.manifest` 的**顺序**读器（逐块比对用）：只往前读，每次一窗，读完即止。
 *
 * 为什么不整份解析：13,177 行 / 2 MB / 169 ms，一页读付不起。为什么不重新二分：
 * 块是按名字升序打开的，条目也是按封块顺序追加的 ⇒ 一条顺序游标就够，每开一个块最多
 * 读一窗。条目缺失（追加失败）或坏行（跳过）都只是「这个块没有证据」，不影响读数据。
 */
export class ManifestForwardReader {
  private position: number;
  private readonly queue: WalManifestLine[] = [];
  private finished = false;
  /**
   * 本次顺序读里**过不了校验**的行数（非空行 + `parseManifestText` 失败）。
   *
   * 只用来回答一个问题：「这条 manifest 在我读到的这一段里可信吗？」块名枚举
   * （{@link ManifestNameSource}）据此整条退回 readdir —— 跳过一条坏行继续枚举等于
   * 押注「那一条本来就不该有」，而这一点无法验证。
   */
  badLines = 0;

  /**
   * @param path `wal.manifest` 的路径
   * @param position 起始字节偏移（必须是**一行行首**）
   * @param size 文件字节数（可选）。给了就把窗口**夹到文件尾**：
   *   `readFileWindow` 是「读不满就说不知道」的口径，而尾页的锚点往往落在最后 8 KiB 内 ——
   *   不夹的话那里会读不满、被当成「读不动」，于是**尾页一条条目都拿不到**
   *   （0.56 尾部读实测踩到：13,177 块的会话上，`since=209335` 的页拿不到任何条目）。
   */
  constructor(
    private readonly path: string,
    position: number,
    private readonly size?: number,
  ) {
    this.position = position;
  }

  /** 预读下一条（不消费）；读到文件尾 / 读不动 ⇒ `undefined`。 */
  async peek(): Promise<WalManifestLine | undefined> {
    while (this.queue.length === 0) {
      if (this.finished) return undefined;
      if (this.size !== undefined && this.position >= this.size) {
        this.finished = true;
        return undefined;
      }
      const length =
        this.size === undefined
          ? MANIFEST_STREAM_WINDOW
          : Math.min(MANIFEST_STREAM_WINDOW, this.size - this.position);
      const buffer = await readFileWindow(this.path, this.position, length);
      if (buffer === undefined) {
        this.finished = true;
        return undefined;
      }
      let cursor = 0;
      let consumed = 0;
      while (cursor < buffer.length) {
        const newline = buffer.indexOf(0x0a, cursor);
        if (newline === -1) break;
        const text = buffer.toString('utf8', cursor, newline);
        cursor = newline + 1;
        consumed = cursor;
        const entry = parseManifestText(text);
        if (entry !== undefined) this.queue.push(entry);
        else if (text.trim().length > 0) this.badLines += 1;
      }
      if (consumed === 0) {
        // 一行比整窗还长（正常 manifest 一行 ≈ 150 B）：不猜，停止比对。
        this.finished = true;
        return undefined;
      }
      this.position += consumed;
    }
    return this.queue[0];
  }

  /** 消费一条（与 {@link peek} 成对使用）。 */
  take(): WalManifestLine | undefined {
    return this.queue.shift();
  }

  /**
   * 取下一条（不按块名匹配）：读到文件尾 / 读不动 ⇒ `undefined`。
   *
   * 与 {@link entryFor} 共用同一份窗口与队列：`entryFor` 是「按名字对齐的消费」，
   * 这里是「顺序消费」—— 块名枚举（`blocks.ts#ManifestNameSource`）用后者。
   */
  async takeNext(): Promise<WalManifestLine | undefined> {
    const next = await this.peek();
    if (next === undefined) return undefined;
    return this.take();
  }

  /**
   * 取 `block` 的条目：按名字升序消费，跳过比它小的（那些条目对应的块本趟没开）。
   *
   * 返回 `undefined` = 这个块**没有条目**（追加 best-effort 落后 / 文件被外部改过）——
   * 这是「证据弱一档」，不是「块不可读」。
   */
  async entryFor(block: string): Promise<WalManifestLine | undefined> {
    for (let skip = 0; skip < MANIFEST_MATCH_SKIP_LIMIT; skip += 1) {
      const next = await this.peek();
      if (next === undefined) return undefined;
      if (next.block === block) return this.take();
      if (next.block > block) return undefined; // 后面的条目更靠后 ⇒ 这个块没有条目
      this.take();
    }
    return undefined;
  }
}

/*
 * ── 块名枚举（0.56 尾部读的**固定定位**开销） ──────────────────────────────────
 *
 * ## 它解决什么
 *
 * 0.56 的范围读每读一页都先 `listBlockFiles()`（`readdir` 整个 `wal.blocks/`）：
 * `d813eaea` 13,177 个块名 **10–13 ms**、`09f82ac6` 6,225 个 **3–4 ms**，而且这笔钱与
 * 「这一页要几条」无关 —— 一页 100 条只开 6 个块，却先枚举了全部 13,177 个。
 * 实测（同一台机器、同一份只读拷贝）：一页 100 条热态 27–37 ms，其中 13 ms 是枚举。
 *
 * ## 怎么省
 *
 * `wal.manifest` 本来就是「块号 → seq 区间 + 记账」，**行序 = 块号序 = seq 序**（写侧
 * `seal()` 先 fsync 块再追加条目、块号取 `maxNumber + 1`）。所以只要：
 *
 * 1. 在 manifest 里二分出**第一条 `end_seq >= sinceSeq` 的条目**（{@link locateManifestEntry}）；
 * 2. 从那里**顺序往前读**，每读一个条目就开那个块（{@link ManifestNameSource}）——
 *    一页只需要窗口内那几个条目，最多读几个 8 KiB 窗，**不枚举全量**。
 *
 * 目录只在两种情况下被 `readdir`：
 * - **兜底**：manifest 缺失 / 短到不像大会话 / 锚点定位不到 / 邻域不自洽 / 锚点块不在
 *   目录里 ⇒ 整条回退今天的 `listBlockFiles + 文件名二分`（{@link ArrayNameSource}）；
 * - **尾部核对**：manifest 读完、而这一页**没填满**（要声称「后面真的没有块了」）时，
 *   按块号往后 `stat` 探测（`last+1…`，见 {@link ManifestNameSource.probeTail}）——
 *   这一步只 stat 几个文件，不 readdir。
 *
 * ## 凭什么仍然「逐条等价」
 *
 * 枚举**不是**判据，覆盖算术才是（`wal.ts#readTimelineRange` 的
 * `coverage_gap` / `window_incomplete`）。所以：
 *
 * - **少枚举**一个块 ⇒ 窗口里那条 seq 既不在结果里也没声明成洞 ⇒ `coverage_gap` ⇒ 降级整份读
 *   （输出不变，只是慢）；若那一页在它之前就填满了，它的 seq 全在 `hi` 之外，本来也不该出现；
 * - **多枚举**一个不存在的块 ⇒ 读文件失败 ⇒ 记 `unverified` 并跳过（与今天「目录里有但读不出来」同口径）；
 * - **声称「到尾」太早** ⇒ `window_incomplete` ⇒ 降级整份读。
 *
 * 三条都只影响**快慢**，不影响**给了什么**。这与 0.56 §3 的纪律一致：只许放宽，绝不窄化。
 */

/** `wal.manifest` 一行的**长度下界**（字节）。
 *
 * 一个块条目的密钥全集固定（`v/kind/block/start_seq/end_seq/offset/bytes/count/crc32` + `crc`），
 * 最短的真实写法仍 > 120 B；这里取 96 B（两成余量），只用它回答一个问题：
 * 「这个 manifest 里**有没有可能**有 `RANGE_READ_MIN_BLOCKS` 条以上的条目」。
 * 判大了的后果是「小会话也走 manifest 路」（快、且输出等价）；判小了只是退回 readdir。
 */
const MANIFEST_LINE_MIN_BYTES = 96;

/** 尾部核对：连续这么多个块号都不存在 ⇒ 认为已经到目录尾（单写者每封一块才分配下一个块号）。 */
const TAIL_PROBE_MISSES = 3;

/** 尾部核对的探针总上限（超过就停止核对 ⇒ 这一页不许声称「到尾」⇒ 上层降级）。 */
const TAIL_PROBE_MAX = 32;

/** 读 manifest 尾巴找「最后一条块条目」的窗口（末尾 4 KiB ≈ 27 条；不够再放大）。 */
const MANIFEST_TAIL_WINDOW_BYTES = 4 * 1024;
const MANIFEST_TAIL_MAX_BYTES = 64 * 1024;

/**
 * 目录里**最后一块**的文件名 —— 不 `readdir`（0.56：`sessions.get` 每页两次整目录枚举）。
 *
 * 为什么只值这么点钱：`lastSeq()`（`event_cursor.last_seq`）与 `watermark()`（上下文用量 /
 * 系统上下文的缓存键）都只要这一个名字，而它们每次 `sessions.get` 都要算一遍。6,225 个块名
 * 的 `readdir` 实测 3–4 ms、13,177 个的 10–13 ms，长寿进程里还要再放大。
 *
 * 口径：**manifest 尾条目 + 按块号往后 `stat` 探测**（与 {@link ManifestNameSource} 的
 * 尾部核对同一套纪律）——
 * - 写侧封块时才分配下一个块号（`maxNumber + 1`），所以「manifest 没记上的块」只可能是
 *   紧接其后的那几块；连续 {@link TAIL_PROBE_MISSES} 个块号都不存在 ⇒ 到头了；
 * - 最后定位到的那个块**必须真的在**（`stat`），否则（manifest 领先于目录 / 块被删）
 *   一律退回 `listBlockFiles`（今天的行为），绝不给一个不存在的名字；
 * - manifest 缺失 / 尾条目读不出 / 探针预算用尽 ⇒ 同样退回 `listBlockFiles`。
 *
 * 也就是说：快路径只在「能证明」的时候用，证不了就回到那条慢而确定的老路。
 */
export async function lastBlockName(sessionDir: string): Promise<string | undefined> {
  const blocksDir = join(sessionDir, TIMELINE_LAYOUT.walBlocks);
  const manifestPath = join(sessionDir, TIMELINE_LAYOUT.walManifest);
  const slow = async (): Promise<string | undefined> => {
    const names = await listBlockFiles(blocksDir);
    return names[names.length - 1];
  };

  const tail = await readNdjsonTail(
    manifestPath,
    MANIFEST_TAIL_WINDOW_BYTES,
    MANIFEST_TAIL_MAX_BYTES,
  ).catch(() => undefined);
  if (tail === undefined) return slow();
  let lastEntry: WalManifestLine | undefined;
  for (let index = tail.lines.length - 1; index >= 0; index -= 1) {
    lastEntry = parseManifestText(tail.lines[index] ?? '');
    if (lastEntry !== undefined) break;
  }
  if (lastEntry === undefined) return slow();
  const firstNumber = blockNumber(lastEntry.block);
  if (!Number.isSafeInteger(firstNumber) || firstNumber <= 0) return slow();

  let lastNumber = firstNumber;
  let candidate = firstNumber;
  let misses = 0;
  let probes = 0;
  while (misses < TAIL_PROBE_MISSES && probes < TAIL_PROBE_MAX) {
    probes += 1;
    const number = candidate + 1;
    candidate = number;
    blockEnumerationCounters.tailProbes += 1;
    if (await blockFileExists(blocksDir, blockNameOf(number))) {
      lastNumber = number;
      misses = 0;
      continue;
    }
    misses += 1;
  }
  if (misses < TAIL_PROBE_MISSES) return slow();
  const name = blockNameOf(lastNumber);
  if (!(await blockFileExists(blocksDir, name))) return slow();
  return name;
}

/**
 * manifest 在**被枚举到的那一段**里出现了过不了校验的行 ⇒ 这一份 manifest 不可信。
 *
 * 由 {@link ManifestNameSource} 抛、由 `wal.ts#readTimelineRange` 接住并**整条改走
 * readdir 兜底重来一次**（不是降级整份读、也不是跳过着一条继续）。
 */
export class ManifestUntrustedError extends Error {
  constructor(readonly block: string | undefined) {
    super(
      block === undefined
        ? 'wal.manifest 里有坏行：块名枚举不可信'
        : `wal.manifest 在 ${block} 附近有坏行：块名枚举不可信`,
    );
    this.name = 'ManifestUntrustedError';
  }
}

/** 一次范围读的块名来源（按**下标**取名字：与今天的 `names[index]` 用法一一对应）。 */ export interface BlockNameSource {
  /** `manifest` = 快路径（不枚举全量）；`readdir` = 兜底 / 本身就只有一份目录快照 */
  readonly kind: 'manifest' | 'readdir';
  /**
   * 下标 `index` 处的块（`index` 从 0 起、按块名升序）；枚举到头 ⇒ `undefined`。
   *
   * `manifest` 源在「到手了」之前会把 manifest 往前读到够；读完了还要做一次尾部核对，
   * 才允许返回 `undefined`（那才是「真的没有更多块」）。
   */
  at(index: number): Promise<EnumeratedBlock | undefined>;
  /**
   * 「后面没有更多块了」这个声称**有没有据**。
   *
   * `readdir` 源恒 `true`（它就是目录快照）。`manifest` 源只有在尾部核对**走完一整窗
   * 都不存在的块号**之后才是 `true`；探针用尽仍在冒（很反常的形状）⇒ `false`，
   * 上游按「窗口没盖满」降级整份读 —— 宁可慢一次，也不把「没枚举完」说成「没有块了」。
   */
  readonly tailProven: boolean;
}

/** 枚举出来的一个块（`entry` 是 manifest 记账；没有 = 这个块没有证据，照样读）。 */
export interface EnumeratedBlock {
  name: string;
  /** manifest 条目（尾部核对/兜底补进来的块没有条目 ⇒ `undefined`） */
  entry?: WalManifestLine;
}

/** `readdir` 快照里的块名（兜底路 / 小会话）：`at()` 就是数组下标。 */
export class ArrayNameSource implements BlockNameSource {
  readonly kind = 'readdir' as const;
  /** `readdir` 拿到的就是目录快照 ⇒ 「后面没有了」永远有据。 */
  readonly tailProven = true;
  private readonly names: readonly string[];
  private readonly offset: number;

  /**
   * @param names `listBlockFiles()` 的全量名字（升序）
   * @param offset 从第几个名字开始给（今天的 `startIndex`）
   */
  constructor(names: readonly string[], offset: number) {
    this.names = names;
    this.offset = Math.max(0, Math.floor(offset));
  }

  at(index: number): Promise<EnumeratedBlock | undefined> {
    const name = this.names[this.offset + index];
    return Promise.resolve(name === undefined ? undefined : { name });
  }
}

/** 块号 → 块文件名（`7` → `000007.wblk`，与写侧 `blockName()` 同一个格式）。 */
function blockNameOf(number: number): string {
  return `${String(number).padStart(6, '0')}.wblk`;
}

/** `wal.blocks/` 里有没有这个块文件（`stat`；失败一律当「没有」）。 */
async function blockFileExists(blocksDir: string, name: string): Promise<boolean> {
  try {
    return (await stat(join(blocksDir, name))).isFile();
  } catch {
    return false;
  }
}

/**
 * manifest 驱动的块名源：从 `startPosition` 起**顺序**读 `wal.manifest`，一个条目一个块。
 *
 * 三条纪律：
 * 1. **只往前走**：条目块名不严格递增 ⇒ 跳过（写侧块只写一次；重复条目是坏数据，
 *    不能让它把同一块开两遍 —— 那会撞上今天的 `order_broken` 判定）；
 * 2. **读不出就说不知道**：坏行跳过（与全量读同口径），但**不猜**「后面没有了」——
 *    manifest 读完只代表 manifest 读完，{@link probeTail} 还要按块号核对目录尾；
 * 3. **不新增落盘格式、不写任何文件**。
 */
export class ManifestNameSource implements BlockNameSource {
  readonly kind = 'manifest' as const;
  private readonly reader: ManifestForwardReader;
  private readonly blocksDir: string;
  private readonly collected: EnumeratedBlock[] = [];
  private lastNumber = 0;
  private manifestDone = false;
  private tailChecked = false;
  /** 尾部核对是否给出了结论（见 {@link tailProven}） */
  private tailProvenFlag = false;

  /**
   * @param manifestPath `wal.manifest` 的路径
   * @param blocksDir `wal.blocks/` 的目录（尾部核对 + 兜底 stat 用）
   * @param startPosition 起始字节偏移（manifest **条目行的行首**；锚点或链首）
   * @param size manifest 的字节数（窗口夹到文件尾；尾页锚点常落在最后 8 KiB 内）
   */
  constructor(manifestPath: string, blocksDir: string, startPosition: number, size?: number) {
    this.reader = new ManifestForwardReader(manifestPath, startPosition, size);
    this.blocksDir = blocksDir;
  }

  get tailProven(): boolean {
    return this.tailProvenFlag;
  }

  async at(index: number): Promise<EnumeratedBlock | undefined> {
    while (index >= this.collected.length) {
      if (!this.manifestDone) {
        const entry = await this.reader.takeNext();
        if (this.reader.badLines > 0) {
          // 这一段 manifest 有坏行 ⇒ 不猜它本来该覆盖哪些块，整条交给 readdir 兜底。
          throw new ManifestUntrustedError(entry?.block);
        }
        if (entry === undefined) {
          this.manifestDone = true;
          continue;
        }
        const number = blockNumber(entry.block);
        if (!Number.isSafeInteger(number) || number <= this.lastNumber) continue; // 只往前走
        this.lastNumber = number;
        this.collected.push({ name: entry.block, entry });
        continue;
      }
      // manifest 读完了：还要一次尾部核对（页没填满时上游要能声称「后面真的没有块了」）。
      if (this.tailChecked) return undefined;
      this.tailChecked = true;
      const extended = await this.probeTail();
      if (extended) continue; // 核对补了块：回到上面接着给
      return undefined;
    }
    return this.collected[index];
  }

  /**
   * 尾部核对：manifest 的最后一条之后，按块号往后 `stat` 探测。
   *
   * 为什么是探测而不是 `readdir`：单写者封块时块号取 `maxNumber + 1`，所以「manifest
   * 没记上的块」最多是**紧接其后的那一个**（活动块 / 追加失败的那一块）。
   * 连续 {@link TAIL_PROBE_MISSES} 个块号都不存在 ⇒ `tailProven = true`（目录尾到了）；
   * 探测到 {@link TAIL_PROBE_MAX} 个还在冒 ⇒ `tailProven = false`（**不声称**到尾，
   * 上游按 `window_incomplete` 降级整份读）—— 宁可慢一次，也不许把「没枚举完」
   * 说成「没有块了」。
   */
  private async probeTail(): Promise<boolean> {
    let misses = 0;
    let probes = 0;
    let extended = false;
    while (misses < TAIL_PROBE_MISSES && probes < TAIL_PROBE_MAX) {
      probes += 1;
      const number = this.lastNumber + 1;
      const name = blockNameOf(number);
      this.lastNumber = number;
      blockEnumerationCounters.tailProbes += 1;
      if (await blockFileExists(this.blocksDir, name)) {
        misses = 0;
        extended = true;
        this.collected.push({ name });
        continue;
      }
      misses += 1;
    }
    this.tailProvenFlag = misses >= TAIL_PROBE_MISSES;
    if (extended) blockEnumerationCounters.tailExtended += 1;
    return extended;
  }
}

/** `wal.manifest` 二分的比较键：按块尾 `end_seq` 还是块首 `start_seq`。 */
type ManifestOrderField = 'end_seq' | 'start_seq';

/**
 * 在 `wal.manifest` 里二分出**第一条 `field >= target` 的条目**（按字节行二分）。
 *
 * 为什么需要两个键：确定「从哪个块开始开」用 `end_seq >= sinceSeq`（`sinceSeq` 可能
 * 落在一段**事实行**里，块不覆盖它）；确定「连续尾块链的链首」用
 * `start_seq > factBoundary`（第一条**整块都在事实边界之后**的块）。
 *
 * 判据只有一份：`validateManifestLine`（坏行跳过，不当锚点也不当证据）；取不到
 * （文件缺失 / 空 / 全无有效行 / 探针用尽）⇒ `undefined`，由调用方换退路。
 */
async function locateManifestEntry(
  manifestPath: string,
  target: number,
  field: ManifestOrderField,
): Promise<ManifestAnchor | undefined> {
  const size = (await stat(manifestPath).catch(() => undefined))?.size ?? 0;
  if (size <= 0) return undefined;
  // 不变式（`lo` / `hi` 都是**行首**的字节偏移）：
  // - `[0, lo)` 里的行，`field` 全部 `< target`（太小）；
  // - `[hi, size)` 里的行，`field` 全部 `>= target`（够大）。
  // 每次探针都让区间**严格**收窄，不会有「同一个行首被反复探到」的空转 —— 第一版就死在
  // 那里：命中候选后把 `hi` 收成行首、而中点仍落在同一条跨行的长行里，`hi` 再也不前进，
  // 探针用尽后把第 3 行当成锚点，于是开头 1..49 那一段被静默跳过（只剩一个降级信号）。
  const budget: LineReadBudget = { bytes: 0, maxBytes: MANIFEST_PROBE_BUDGET_BYTES };
  let lo = 0;
  let hi = size;
  let probes = 0;
  let best: ManifestAnchor | undefined;
  while (lo < hi) {
    if (probes >= ANCHOR_PROBE_LIMIT) return undefined; // 不猜：调用方换文件名二分
    probes += 1;
    const mid = lo + Math.floor((hi - lo) / 2);
    // 探**中点所在的那一行**：往回找行首，再整行读出来（两半都严格推进）。
    const lineStart = await findLineStartBefore(
      manifestPath,
      lo,
      mid,
      budget,
      MANIFEST_LINE_MAX_BYTES,
    );
    if (lineStart === undefined) return undefined;
    const line = await readNdjsonLineAt(
      manifestPath,
      lineStart,
      size,
      budget,
      false,
      MANIFEST_LINE_MAX_BYTES,
    );
    if (line === undefined) return undefined;
    const entry = parseManifestText(line.text);
    if (entry === undefined || entry[field] < target) {
      // 坏行 / 太小：跳过它继续往右找（坏行不是锚点，也不是判据）。
      lo = Math.max(line.next, lo + 1);
      continue;
    }
    best = { entry, lineStart: line.start, lineEnd: line.next };
    if (line.start <= lo) return best; // 不可能再往左：它就是第一条
    hi = line.start;
  }
  return best;
}

/** 一次范围读为什么走 / 不走 manifest 快路径（稳定 code；只进 debug 日志与计数）。 */
export type BlockEnumerationFallbackReason =
  | 'manifest_missing'
  | 'manifest_too_small'
  | 'manifest_untrusted'
  | 'anchor_unavailable'
  | 'neighborhood_broken'
  | 'anchor_block_missing'
  | 'chain_head_unavailable'
  | 'probe_budget_exhausted';

/** {@link openManifestNameSource} 的结果：要么给源，要么给「为什么退回 readdir」。 */
export type ManifestNameSourceResult =
  | { ok: true; source: ManifestNameSource; anchor: ManifestAnchor }
  | { ok: false; reason: BlockEnumerationFallbackReason };

/**
 * 尝试给出 manifest 驱动的块名源（**不做任何 readdir**）；任何一条判据不成立 ⇒
 * 返回 `{ ok:false }`，调用方整条回退到 `listBlockFiles + 文件名二分`（今天的行为）。
 *
 * 六条判据（全成立才用快路径）：
 * 1. `wal.manifest` 存在且**不只是几行**（`size / MANIFEST_LINE_MIN_BYTES >= RANGE_READ_MIN_BLOCKS`
 *    —— 小会话本来就走整份读，别让它们多一条会漂的路径）；
 * 2. 二分定位得到「第一条 `end_seq >= sinceSeq`」；
 * 3. 锚点邻域自洽（`上一条.end_seq < 本条.start_seq <= 本条.end_seq < 下一条.start_seq`）；
 * 4. 锚点块**真的在目录里**（`stat`）—— manifest 是目录的 best-effort 副本，不能凭它认块存在；
 * 5. 起点块的**首帧**读得出来（判断它是否已落在事实边界之后）；
 * 6. 需要从连续尾块链链首重验时，链首定位得到（`start_seq > factBoundary` 的第一条）。
 */
export async function openManifestNameSource(args: {
  sessionDir: string;
  sinceSeq: number;
  factBoundary: number;
  /** 块数门槛（与 `wal.ts#RANGE_READ_MIN_BLOCKS` 同值；由调用方传，避免跨模块常量依赖） */
  minBlocks: number;
}): Promise<ManifestNameSourceResult> {
  const blocksDir = join(args.sessionDir, TIMELINE_LAYOUT.walBlocks);
  const manifestPath = join(args.sessionDir, TIMELINE_LAYOUT.walManifest);
  const size = (await stat(manifestPath).catch(() => undefined))?.size ?? 0;
  if (size <= 0) return { ok: false, reason: 'manifest_missing' };
  if (size / MANIFEST_LINE_MIN_BYTES < args.minBlocks) {
    return { ok: false, reason: 'manifest_too_small' };
  }
  const anchor = await locateManifestEntry(manifestPath, args.sinceSeq, 'end_seq');
  if (anchor === undefined) return { ok: false, reason: 'anchor_unavailable' };
  if (!(await manifestNeighborhoodOk(manifestPath, anchor, size))) {
    return { ok: false, reason: 'neighborhood_broken' };
  }
  if (!(await blockFileExists(blocksDir, anchor.entry.block))) {
    return { ok: false, reason: 'anchor_block_missing' };
  }
  const anchorFirstSeq = await readFirstFrameSeq(join(blocksDir, anchor.entry.block));
  if (anchorFirstSeq === undefined) return { ok: false, reason: 'anchor_unavailable' };

  let startPosition = anchor.lineStart;
  if (anchorFirstSeq > args.factBoundary + 1) {
    // 起点已经在事实边界之后的**尾链中段**：链必须从边界那一端重新验（否则会把
    // 「链早就断了」的块当成可读 —— 那是多给，与整份读不等价）。
    const chainHead = await locateManifestEntry(manifestPath, args.factBoundary + 1, 'start_seq');
    if (chainHead === undefined) return { ok: false, reason: 'chain_head_unavailable' };
    startPosition = Math.min(startPosition, chainHead.lineStart);
  }
  return {
    ok: true,
    source: new ManifestNameSource(manifestPath, blocksDir, startPosition, size),
    anchor,
  };
}
