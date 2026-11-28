/**
 * 洞登记区（0.54 A 阶段，ADR-105 §3 I3 补充条款）。
 *
 * 一条写失败的事件**必须落盘成可声明的洞**：
 *
 * ```
 * <sessions>/<sid>/holes.ndjson
 * {"v":1,"from_seq":7,"to_seq":7,"reason":"wal_append_failed: ...","at":...,"crc":"..."}\n
 * {"v":1,"kind":"hole_retired","from_seq":7,"to_seq":7,"reason":"...","at":...,
 *  "evidence":"reread_ok:7-7:verified=1/1:timeline=0,blocks=0,wal=1","crc":"..."}\n
 * ```
 *
 * - append-only：只追加、不改历史行（登记行**没有** `kind`，退役行有 `kind:'hole_retired'`）；
 * - 行尾 CRC32：坏行可识别，不会把半行当成洞；
 * - 跨重启可读：`TimelineWriter.open()` 用 `from_seq/to_seq` 重建 `wal_head` 的连续性，
 *   因此「模拟 fsync 失败 → 重启 → holes 包含该区间、tainted=true」可断言。
 *
 * **退役（第二刀）**：洞不再是「只增不减」，但退役的**前提是自证**：`retire()` 先把
 * `[from_seq,to_seq]` 从 `wal.log` / `wal.blocks/*.wblk` / `timeline.ndjson` 三处重读一遍，
 * 区间内**每一个 seq 都必须逐条 CRC 通过**；缺一条或坏一条 ⇒ **拒绝退役、一个字节都不写**。
 * 于是「盘上出现 `hole_retired`」等价于「这段数据在被退役的那一刻逐条可读」——
 * 不需要相信任何人的签字。
 *
 * 三条硬约束（都在本模块里成立，改动前先读 ADR-105 §11.1）：
 *
 * 1. **绝不在 `open()` 里自动退役 / 自动全量重读**：退役只有一个入口 `retire()`
 *    （写者 `TimelineWriter.retireHoles()` 显式调用）。打开时扫全量重读会让启动变慢，
 *    还会把「坏块」悄悄洗白 —— 那正是洞要暴露的东西。
 * 2. **当前状态 = 物理行序上最后一条声明**（last-wins，`applyDeclaration()` 按文件行序折叠）。
 *    `at` 只作审计：时钟回退会把「按 `at` 排序」的结果搞反，一次都不许用它定序。
 * 3. **退役不动 `maxSeq()`**：已退役区间里的 seq 依旧是「用过的号」（`nextSeq` 不回收），
 *    只从存活洞集合（`list()` / `covers()`）里消失。
 *
 * @module @vessel-agent/core/timeline
 */

import { type FileHandle, open } from 'node:fs/promises';
import { join } from 'node:path';
import {
  TIMELINE_LAYOUT,
  type TimelineHole,
  type TimelineHoleDeclarationLine,
  type TimelineHoleRetiredLine,
  type TimelineSyncKind,
} from './types.js';
import {
  parseWithCrc,
  readAllBlocks,
  readCrcNdjsonFile,
  readNdjsonFile,
  truncateFile,
  withCrc,
} from './wal.js';

export interface HoleRegistryOptions {
  /** 测试缝：每次真正 fsync 之前调用；抛错 = 模拟 fsync 失败。 */
  beforeSync?: (kind: TimelineSyncKind) => void;
  /** 测试缝：登记时刻。 */
  now?: () => number;
}

/** 一个区间**折叠后**的当前状态（物理行序上最后一条声明说的算）。 */
export interface HoleDeclarationState {
  from_seq: number;
  to_seq: number;
  reason: string;
  at: number;
  /** 最后一条声明是不是 `hole_retired`。`true` ⇒ 这个区间不再压制 `tainted`。 */
  retired: boolean;
  /** 退役行里的自证摘要（只有 `retired` 时才有）。 */
  evidence?: string;
}

/** 区间重读（退役前的自证）结果。 */
export interface HoleIntervalVerification {
  ok: boolean;
  from_seq: number;
  to_seq: number;
  /** `[from_seq,to_seq]` 里逐条 CRC 通过的条数。 */
  verified: number;
  /** 读不回来（缺记录 / CRC 不符 / 块帧损坏）的 seq。 */
  missing: number[];
  /** 自证摘要（通过时原样落到退役行的 `evidence`）。 */
  evidence: string;
}

/**
 * 退役被拒的两个**稳定 code**（上层按 code 映射/给退出码，不解析 `reason` 文本）。
 *
 * - `hole_not_registered`：没有精确匹配的**存活**登记（已退役 / 从未登记 / 区间不匹配）；
 * - `hole_interval_not_readable`：区间重读没通过（仍有 seq 缺记录或 CRC 不符）。
 */
export type HoleRetirementRefusalCode = 'hole_not_registered' | 'hole_interval_not_readable';

/** 一次退役的结果。`ok=false` ⇒ 拒绝，且 `holes.ndjson` **一个字节都没写**。 */
export interface HoleRetirementResult {
  ok: boolean;
  from_seq: number;
  to_seq: number;
  /** 成功时的自证摘要（同一份也写进了退役行的 `evidence`）。 */
  evidence?: string;
  /** 被拒时的稳定 code（`ok=false` 必有）。 */
  code?: HoleRetirementRefusalCode;
  /** 被拒时的细节（缺哪些 seq / 为什么没有可退役的登记）。 */
  reason?: string;
}

/** 区间键：`from:to`。退役必须**精确匹配**一个已登记区间（不支持半段退役）。 */
function intervalKey(fromSeq: number, toSeq: number): string {
  return `${fromSeq}:${toSeq}`;
}

/** 缺号摘要：只列前 8 个，后面用 `+N` 收尾（拒绝原因不该被 10 万个号撑爆）。 */
function summarizeSeqs(seqs: readonly number[], total = seqs.length): string {
  const head = seqs.slice(0, 8).join(',');
  const rest = total - Math.min(8, seqs.length);
  return rest > 0 ? `${head},+${String(rest)}` : head;
}

/** `missing` 列表的封顶（区间上界来自声明本身，列表长度必须有自己的上界）。 */
const MISSING_LIST_LIMIT = 1_000;

/**
 * 解析一条洞声明行。
 *
 * 与 `wal.ts#validateHoleLine`（**本单逐字节未改**，它就是「旧 reader」）的区别只有一条：
 * 这里认 `kind:'hole_retired'`。未知 `kind` 一律返回 `undefined` ⇒ 该行被忽略（不抛错、
 * 不截断文件），语义上等价于「保守地认为这个洞还在」。
 */
export function validateHoleDeclarationLine(
  parsed: unknown,
): TimelineHoleDeclarationLine | undefined {
  const line = parseWithCrc<TimelineHoleDeclarationLine>(parsed);
  if (line === undefined || line.v !== 1) return undefined;
  if (!Number.isSafeInteger(line.from_seq) || line.from_seq < 1) return undefined;
  if (!Number.isSafeInteger(line.to_seq) || line.to_seq < line.from_seq) return undefined;
  if (typeof line.reason !== 'string' || typeof line.at !== 'number') return undefined;
  if (line.kind === undefined || line.kind === 'hole') return line;
  if (line.kind !== 'hole_retired') return undefined;
  if (line.evidence !== undefined && typeof line.evidence !== 'string') return undefined;
  return line;
}

/**
 * 把一条声明折进状态表：**同区间后写的赢**（last-wins，物理行序）。
 *
 * 折叠顺序 = 文件行序（`HoleRegistry.open()` 逐行喂进来），**不看 `at`**：时钟回退会让
 * 「`hole_retired` 的 `at` 比它要退役的登记行还小」，按 `at` 排序就会把退役无声丢掉。
 * `Map` 的插入顺序在覆盖已有键时保持不变 ⇒ `declarations()` 恒为首次出现顺序。
 */
function applyDeclaration(
  states: Map<string, HoleDeclarationState>,
  line: TimelineHoleDeclarationLine,
): HoleDeclarationState {
  const retired = line.kind === 'hole_retired';
  const state: HoleDeclarationState = {
    from_seq: line.from_seq,
    to_seq: line.to_seq,
    reason: line.reason,
    at: line.at,
    retired,
    ...(retired && typeof line.evidence === 'string' ? { evidence: line.evidence } : {}),
  };
  states.set(intervalKey(line.from_seq, line.to_seq), state);
  return state;
}

/**
 * 区间重读：**退役的唯一前提**（ADR-105 §3 I3 补充条款）。
 *
 * 把 `[from_seq,to_seq]` 从三个可能的位置各读一遍（`timeline.ndjson` 归档副本 /
 * `wal.blocks/*.wblk` 块帧 / `wal.log` WAL 原文），逐个 seq 要求**至少有一个来源**给出
 * 同 seq 的记录。判据不许只看「条数对不对」：`present` 只收**逐条 CRC 通过**的记录
 * （三个来源的解析器各自校验 CRC，坏行/坏帧根本进不了 `records`），所以「区间内每个 seq
 * 都在 `present` 里」等价于「区间逐条可读」。缺一个就 `ok=false`，并把缺的 seq 列出来
 * （最多列 {@link MISSING_LIST_LIMIT} 个，尾部用 `+N` 收口 —— 区间上界来自声明本身，
 * 不许让它把进程拖死）。
 *
 * **只有显式退役才调它**（`HoleRegistry.retire`），`open()` 一次都不许调：打开时做全量
 * 重读会让启动变慢，并把「坏块本该被暴露」这件事掩盖掉。
 *
 * 成本 O(三个文件的字节数 + 实际记录条数)：退役是人工低频命令，不在热路径上。
 */
export async function verifyHoleIntervalReadable(
  sessionDir: string,
  fromSeq: number,
  toSeq: number,
): Promise<HoleIntervalVerification> {
  const sources: Array<{ name: string; seqs: readonly number[] }> = [
    {
      name: 'timeline',
      seqs: (await readNdjsonFile(join(sessionDir, TIMELINE_LAYOUT.timeline))).records.map(
        (record) => record.seq,
      ),
    },
    {
      name: 'blocks',
      seqs: (await readAllBlocks(sessionDir)).flatMap((block) =>
        block.decode.records.map((record) => record.seq),
      ),
    },
    {
      name: 'wal',
      seqs: (await readNdjsonFile(join(sessionDir, TIMELINE_LAYOUT.walLog))).records.map(
        (record) => record.seq,
      ),
    },
  ];
  const present = new Set<number>();
  const counts: string[] = [];
  for (const source of sources) {
    let count = 0;
    for (const seq of source.seqs) {
      if (seq < fromSeq || seq > toSeq) continue;
      count += 1;
      present.add(seq);
    }
    counts.push(`${source.name}=${String(count)}`);
  }
  // 缺号只沿着**真实存在**的 seq 走（不按 [from,to] 逐号自增）：区间上界由声明决定，
  // 一个手写的巨大区间不该把进程拖成一个 1e9 次的循环。
  const seqs = [...present].sort((left, right) => left - right);
  const missing: number[] = [];
  let cursor = fromSeq;
  for (const seq of seqs) {
    while (cursor < seq && missing.length < MISSING_LIST_LIMIT) {
      missing.push(cursor);
      cursor += 1;
    }
    cursor = seq + 1;
  }
  while (cursor <= toSeq && missing.length < MISSING_LIST_LIMIT) {
    missing.push(cursor);
    cursor += 1;
  }
  const expected = toSeq - fromSeq + 1;
  const verified = present.size;
  const missingCount = expected - verified;
  const detail = `${String(fromSeq)}-${String(toSeq)}:verified=${String(verified)}/${String(expected)}:${counts.join(',')}`;
  return {
    ok: missingCount === 0,
    from_seq: fromSeq,
    to_seq: toSeq,
    verified,
    missing,
    evidence:
      missingCount === 0
        ? `reread_ok:${detail}`
        : `reread_failed:${detail}:missing=${summarizeSeqs(missing, missingCount)}`,
  };
}

export class HoleRegistry {
  private constructor(
    private readonly sessionDir: string,
    private readonly states: Map<string, HoleDeclarationState>,
    private readonly handle: FileHandle,
    private readonly options: HoleRegistryOptions,
  ) {}

  /**
   * 打开一个会话的洞登记区。
   *
   * 末尾无换行的半行会被截断（它从未完整写出，不构成声明）；坏行跳过。
   * **不做任何区间重读**：退役状态直接信盘上的声明（只有 `retire()` 能写出它，而它写之前
   * 已经自证过）。这是「打开不扫全量」那条硬约束的落地位置。
   */
  static async open(sessionDir: string, options: HoleRegistryOptions = {}): Promise<HoleRegistry> {
    const path = join(sessionDir, TIMELINE_LAYOUT.holes);
    const result = await readCrcNdjsonFile<TimelineHoleDeclarationLine>(
      path,
      validateHoleDeclarationLine,
    );
    if (result.truncateTo !== undefined) await truncateFile(path, result.truncateTo);
    const states = new Map<string, HoleDeclarationState>();
    for (const line of result.items) applyDeclaration(states, line);
    const handle = await open(path, 'a', 0o600);
    return new HoleRegistry(sessionDir, states, handle, options);
  }

  /**
   * **存活的**洞（未被退役；首次出现顺序）。
   *
   * 这是对外口径：`heads()` 报的就是它，`tainted` 的判据也是它非空。历史登记行还在文件里
   * （审计），但已退役的区间不再算「当前不可读」。
   */
  list(): readonly TimelineHole[] {
    const live: TimelineHole[] = [];
    for (const state of this.states.values()) {
      if (state.retired) continue;
      live.push({
        from_seq: state.from_seq,
        to_seq: state.to_seq,
        reason: state.reason,
        at: state.at,
      });
    }
    return live;
  }

  /** 折叠后的全部区间状态（**含已退役**；审计与门禁用）。 */
  declarations(): readonly HoleDeclarationState[] {
    return [...this.states.values()].map((state) => ({ ...state }));
  }

  /** 该区间当前是否已退役（从未声明过 ⇒ `false`）。 */
  isRetired(fromSeq: number, toSeq: number): boolean {
    return this.states.get(intervalKey(fromSeq, toSeq))?.retired === true;
  }

  /** `seq` 是否落在某个**存活**洞内。 */
  covers(seq: number): boolean {
    for (const state of this.states.values()) {
      if (state.retired) continue;
      if (seq >= state.from_seq && seq <= state.to_seq) return true;
    }
    return false;
  }

  /** 声明过的最大 seq（**含已退役**：seq 号永不回收，`nextSeq` 沿用它）。 */
  maxSeq(): number {
    let max = 0;
    for (const state of this.states.values()) max = Math.max(max, state.to_seq);
    return max;
  }

  /**
   * 登记一个洞并 fsync。
   *
   * 调用方（写者）只在写失败后调用；登记失败会把错误抛回，写者会同时置内存污点
   * 并尽力在主 manifest 里留 `tainted` 行（ADR-105 §3 I3）。
   *
   * 「又登记一次」= 该区间重新变成**存活**（last-wins：这条声明物理上在最后）。这正是
   * 「退役之后同一区间又坏了」的正确表达，不需要任何回改。
   */
  async add(fromSeq: number, toSeq: number, reason: string): Promise<TimelineHole> {
    if (!Number.isSafeInteger(fromSeq) || fromSeq < 1) {
      throw new Error(`invalid_hole_from_seq: ${String(fromSeq)}`);
    }
    if (!Number.isSafeInteger(toSeq) || toSeq < fromSeq) {
      throw new Error(`invalid_hole_to_seq: ${String(toSeq)}`);
    }
    const at = this.options.now?.() ?? Date.now();
    const line: TimelineHoleDeclarationLine = {
      v: 1,
      from_seq: fromSeq,
      to_seq: toSeq,
      reason,
      at,
    };
    await this.appendLine(line);
    applyDeclaration(this.states, line);
    return { from_seq: fromSeq, to_seq: toSeq, reason, at };
  }

  /**
   * 退役一段洞：**唯一入口，且必须先自证**。
   *
   * 步骤（任一不满足 ⇒ 返回 `ok:false`，**一个字节都不写**）：
   * ① 该区间必须存在一条**存活**登记（`[from_seq,to_seq]` 精确匹配）。不许凭空退役没人
   *    声明过的区间；也不支持「半段退役」—— 半段会把区间语义拆碎，审计也读不懂；
   * ② `verifyHoleIntervalReadable()` 把区间从归档 / 块 / WAL 三处重读，**每个 seq 都要有
   *    CRC 通过的记录**；缺一条或坏一条就拒绝（`reason` 前缀 `hole_interval_not_readable`）。
   *
   * 通过后追加一行 `kind:'hole_retired'`（带 `evidence` 自证摘要）并 fsync。历史登记行
   * 一个字都不改 —— 当前状态靠 last-wins 生效。
   */
  async retire(fromSeq: number, toSeq: number, reason: string): Promise<HoleRetirementResult> {
    if (!Number.isSafeInteger(fromSeq) || fromSeq < 1) {
      throw new Error(`invalid_hole_from_seq: ${String(fromSeq)}`);
    }
    if (!Number.isSafeInteger(toSeq) || toSeq < fromSeq) {
      throw new Error(`invalid_hole_to_seq: ${String(toSeq)}`);
    }
    if (typeof reason !== 'string' || reason.length === 0) {
      throw new Error('invalid_hole_retire_reason');
    }
    const current = this.states.get(intervalKey(fromSeq, toSeq));
    if (current === undefined || current.retired) {
      return {
        ok: false,
        from_seq: fromSeq,
        to_seq: toSeq,
        code: 'hole_not_registered',
        reason: current === undefined ? 'interval was never declared' : 'interval already retired',
      };
    }
    const verification = await verifyHoleIntervalReadable(this.sessionDir, fromSeq, toSeq);
    if (!verification.ok) {
      return {
        ok: false,
        from_seq: fromSeq,
        to_seq: toSeq,
        code: 'hole_interval_not_readable',
        reason: verification.evidence,
      };
    }
    const at = this.options.now?.() ?? Date.now();
    const line: TimelineHoleRetiredLine = {
      v: 1,
      kind: 'hole_retired',
      from_seq: fromSeq,
      to_seq: toSeq,
      reason,
      at,
      evidence: verification.evidence,
    };
    await this.appendLine(line);
    applyDeclaration(this.states, line);
    return { ok: true, from_seq: fromSeq, to_seq: toSeq, evidence: verification.evidence };
  }

  async close(): Promise<void> {
    // benign: 关闭路径尽力释放句柄，失败不抛（声明已 fsync）。
    await this.handle.close().catch(() => {});
  }

  /** 追加一行声明并 fsync（登记与退役共用；两者都是 append-only）。 */
  private async appendLine(line: TimelineHoleDeclarationLine): Promise<void> {
    const stamped = withCrc(line);
    const buffer = Buffer.from(`${JSON.stringify(stamped)}\n`, 'utf8');
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesWritten } = await this.handle.write(buffer, offset, buffer.length - offset);
      if (bytesWritten <= 0) throw new Error('holes_write_failed');
      offset += bytesWritten;
    }
    this.options.beforeSync?.('holes');
    await this.handle.sync();
  }
}
