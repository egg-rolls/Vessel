/**
 * 成员快照：`<dataDir>/agents/<tenant>.json`（0600 原子写）。
 *
 * 快照只含成员状态，不含消息队列（重启后未处理消息丢失）。
 * 文件损坏时先隔离为 `<path>.corrupt-<timestamp>` 再按空列表加载：
 * 不阻塞启动，也不让下一次状态写覆盖唯一恢复副本。
 *
 * @module @vessel-agent/agent
 */

import { access, copyFile, mkdir, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { atomicWrite, type Logger, noopLogger } from '@vessel-agent/core';
import {
  type AgentBodyHistoryEntry,
  type AgentBodyPointer,
  MAX_BODY_HISTORY,
  type MemberMembership,
  type MemberState,
  type MemberVisibility,
  type PersistedAgentRecord,
} from './types.js';

/** 快照文件版本；当前写入 2，读取兼容 1 */
export const AGENT_SNAPSHOT_VERSION = 2;

/** 快照文件形状（v2；v1 的 members 是旧 MemberStatus 形状，读时归一） */
export interface AgentSnapshotFile {
  version: number;
  tenant_id: string;
  updated_at: number;
  members: PersistedAgentRecord[];
}

/** v1 备份后缀（首次写 v2 前创建，供旧二进制回滚） */
const V1_BACKUP_SUFFIX = '.v1.bak';

const MEMBER_STATES: readonly MemberState[] = [
  'created',
  'idle',
  'running',
  'waiting_permission',
  'completed',
  'failed',
  'cancelled',
  'closed',
  'stale',
];

const VISIBILITIES: readonly MemberVisibility[] = ['private', 'team', 'tenant'];

/** 快照路径 */
export function snapshotPath(dataDir: string, tenantId: string): string {
  return join(dataDir, 'agents', `${tenantId}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function optionalString(value: unknown): string | undefined {
  return nonEmptyString(value) ? value : undefined;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** current_body：session_id 非空、epoch 为 >=0 整数、started_at 为有限数字才保留 */
function parseBody(value: unknown): AgentBodyPointer | undefined {
  if (!isRecord(value)) return undefined;
  if (!nonEmptyString(value.session_id)) return undefined;
  if (typeof value.epoch !== 'number' || !Number.isInteger(value.epoch) || value.epoch < 0) {
    return undefined;
  }
  if (typeof value.started_at !== 'number' || !Number.isFinite(value.started_at)) return undefined;
  return { session_id: value.session_id, epoch: value.epoch, started_at: value.started_at };
}

/**
 * body_history：逐条校验（Body 指针 + 有限 retired_at），非法条目单独跳过；
 * 最多保留最后 MAX_BODY_HISTORY 条。无有效条目返回 undefined。
 */
function parseBodyHistory(value: unknown): AgentBodyHistoryEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: AgentBodyHistoryEntry[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const body = parseBody(item);
    if (body === undefined) continue;
    if (typeof item.retired_at !== 'number' || !Number.isFinite(item.retired_at)) continue;
    entries.push({ ...body, retired_at: item.retired_at });
  }
  if (entries.length === 0) return undefined;
  return entries.slice(-MAX_BODY_HISTORY);
}

/**
 * 单条成员校验；字段非法返回 undefined（整条丢弃）。
 * v1 / v2 共用：membership 缺省按 state === 'closed' 推断；presence / rotation 不读。
 */
function parseMember(value: unknown): PersistedAgentRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (!nonEmptyString(value.id) || !nonEmptyString(value.session_id)) return undefined;
  // owner 可选（peer 缺省）；显式给出则必须是非空字符串。
  const owner = optionalString(value.owner);
  if (value.owner !== undefined && owner === undefined) return undefined;
  if (!nonEmptyString(value.visibility)) return undefined;
  if (!nonEmptyString(value.state)) return undefined;
  if (!VISIBILITIES.includes(value.visibility as MemberVisibility)) return undefined;
  if (!MEMBER_STATES.includes(value.state as MemberState)) return undefined;

  const state = value.state as MemberState;
  const membership: MemberMembership =
    value.membership === 'present' || value.membership === 'left'
      ? value.membership
      : state === 'closed'
        ? 'left'
        : 'present';

  const record: PersistedAgentRecord = {
    id: value.id,
    session_id: value.session_id,
    ...(owner !== undefined ? { owner } : {}),
    visibility: value.visibility as MemberVisibility,
    state,
    membership,
  };
  const name = optionalString(value.name);
  if (name !== undefined) record.name = name;
  // 0.19 S3：additive 字段；仍写 version 2（旧二进制忽略未知键）
  const teamId = optionalString(value.team_id);
  if (teamId !== undefined) record.team_id = teamId;
  const parentId = optionalString(value.parent_id);
  if (parentId !== undefined) record.parent_id = parentId;
  const model = optionalString(value.model);
  if (model !== undefined) record.model = model;
  const systemPrompt = optionalString(value.system_prompt);
  if (systemPrompt !== undefined) record.system_prompt = systemPrompt;
  const currentBody = parseBody(value.current_body);
  if (currentBody !== undefined) record.current_body = currentBody;
  const bodyHistory = parseBodyHistory(value.body_history);
  if (bodyHistory !== undefined) record.body_history = bodyHistory;
  const forkedFrom = optionalString(value.forked_from);
  if (forkedFrom !== undefined) record.forked_from = forkedFrom;
  const currentTool = optionalString(value.current_tool);
  if (currentTool !== undefined) record.current_tool = currentTool;
  if (typeof value.last_seen === 'number' && Number.isFinite(value.last_seen)) {
    record.last_seen = value.last_seen;
  }
  if (isRecord(value.usage)) record.usage = value.usage;
  return record;
}

/** 快照读写；写失败只记录不抛出 */
export class AgentSnapshotStore {
  private readonly logger: Logger;
  private readonly throttleMs: number;
  private readonly mode: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: (() => PersistedAgentRecord[]) | undefined;
  /** 写入串行链；值表示该次 write 是否成功 */
  private chain: Promise<boolean> = Promise.resolve(true);
  /** 读到 v1 且尚未成功备份时置位；write 前必须补做，否则放弃写入（避免无回滚） */
  private backupPending = false;
  /** 损坏文件隔离失败时置位：write 直接放弃，避免覆盖唯一恢复副本 */
  private writeBlocked = false;

  constructor(
    private readonly filePath: string,
    private readonly tenantId: string,
    options: {
      throttleMs?: number;
      mode?: number;
      logger?: Logger;
      now?: () => number;
    } = {},
  ) {
    this.throttleMs = Math.max(0, options.throttleMs ?? 0);
    this.mode = options.mode ?? 0o600;
    this.logger = options.logger ?? noopLogger;
    this.now = options.now ?? Date.now;
  }

  get path(): string {
    return this.filePath;
  }

  /** 读取；缺失返回空列表；损坏 / 版本不符先隔离再返回空列表；v1 可读并在首次写 v2 前备份 */
  async load(): Promise<PersistedAgentRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        const detail = error instanceof Error ? error.message : String(error);
        this.logger.error('agent.snapshot.load_failed', {
          path: this.filePath,
          error: detail,
        });
        await this.quarantine(detail);
      }
      return [];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error('agent.snapshot.load_failed', {
        path: this.filePath,
        error: detail,
      });
      await this.quarantine(detail);
      return [];
    }

    if (!isRecord(parsed) || (parsed.version !== 1 && parsed.version !== AGENT_SNAPSHOT_VERSION)) {
      const detail = `unsupported snapshot version: ${String(isRecord(parsed) ? parsed.version : 'n/a')}`;
      this.logger.error('agent.snapshot.load_failed', {
        path: this.filePath,
        error: detail,
      });
      await this.quarantine(detail);
      return [];
    }

    if (!Array.isArray(parsed.members)) {
      this.logger.error('agent.snapshot.load_failed', {
        path: this.filePath,
        error: 'members is not an array',
      });
      await this.quarantine('members is not an array');
      return [];
    }

    // R1：旧二进制无法读 v2；首次写 v2 前先留一份 v1 备份。
    if (parsed.version === 1) {
      this.backupPending = true;
      await this.ensureV1Backup();
    }

    const members: PersistedAgentRecord[] = [];
    let skipped = 0;
    for (const entry of parsed.members) {
      const member = parseMember(entry);
      if (member === undefined) {
        skipped += 1;
        continue;
      }
      members.push(member);
    }
    if (skipped > 0) {
      this.logger.warn('agent.snapshot.members_skipped', { path: this.filePath, count: skipped });
    }
    return members;
  }

  /**
   * 把损坏文件移到 `<path>.corrupt-<timestamp>`；隔离失败时禁止后续写入。
   * 隔离是保留唯一恢复副本的手段，不是修复：不删除、不改写原字节。
   */
  private async quarantine(reason: string): Promise<void> {
    const base = `${this.filePath}.corrupt-${this.now()}`;
    let target = base;
    let suffix = 1;
    while (await fileExists(target)) {
      target = `${base}-${suffix}`;
      suffix += 1;
    }
    try {
      await rename(this.filePath, target);
      this.logger.error('agent.snapshot.corrupt_quarantined', {
        path: this.filePath,
        quarantine_path: target,
        error: reason,
      });
    } catch (error) {
      // 已被其它进程移走：恢复副本仍在，允许后续写入新文件。
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
      this.writeBlocked = true;
      this.logger.error('agent.snapshot.corrupt_quarantine_failed', {
        path: this.filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 确保 v1 备份存在。返回 false 表示备份失败；调用方据此决定是否放弃写 v2。
   * 备份已存在视为完成（幂等）。
   */
  private async ensureV1Backup(): Promise<boolean> {
    if (!this.backupPending) return true;
    const backupPath = `${this.filePath}${V1_BACKUP_SUFFIX}`;
    try {
      if (!(await fileExists(backupPath))) {
        await copyFile(this.filePath, backupPath);
      }
      this.backupPending = false;
      return true;
    } catch (error) {
      this.logger.error('agent.snapshot.backup_failed', {
        path: this.filePath,
        backup_path: backupPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /** 原子写；任何失败返回 false，不向上抛 */
  async write(members: PersistedAgentRecord[]): Promise<boolean> {
    // 损坏文件没能隔离：写入会覆盖唯一恢复副本，放弃本次写并记录失败。
    if (this.writeBlocked) {
      this.logger.error('agent.snapshot.write_failed', {
        path: this.filePath,
        error: 'quarantine_failed',
      });
      return false;
    }
    // 读到 v1 但备份失败过：写入会失去回滚点，放弃本次写。
    if (!(await this.ensureV1Backup())) return false;
    const file: AgentSnapshotFile = {
      version: AGENT_SNAPSHOT_VERSION,
      tenant_id: this.tenantId,
      updated_at: this.now(),
      members,
    };
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await atomicWrite(this.filePath, `${JSON.stringify(file, null, 2)}\n`, {
        mode: this.mode,
      });
      return true;
    } catch (error) {
      this.logger.error('agent.snapshot.write_failed', {
        path: this.filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /** 合并写入；同一窗口内多次调用只落最后一次快照 */
  schedule(getMembers: () => PersistedAgentRecord[]): void {
    this.pending = getMembers;
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.throttleMs);
    this.timer.unref?.();
  }

  /**
   * 立即写入待写快照；写入串行，失败不抛。
   * 无待写时返回 true（不返回上一次写入的结果），有待写时返回本次 write 的结果。
   */
  async flush(): Promise<boolean> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const getMembers = this.pending;
    this.pending = undefined;
    if (getMembers === undefined) {
      await this.chain;
      return true;
    }
    const members = getMembers();
    const write = this.chain.then(() => this.write(members));
    this.chain = write;
    return write;
  }

  /** 取消待写快照（进程退出用；不落盘） */
  dispose(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending = undefined;
  }
}
