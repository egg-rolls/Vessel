/**
 * 成员快照：`<dataDir>/agents/<tenant>.json`（0600 原子写）。
 *
 * 快照只含成员状态，不含消息队列（重启后未处理消息丢失）。
 * 加载失败不抛错：返回空列表并记录，避免损坏文件阻塞服务启动。
 *
 * @module @vessel-agent/agent
 */

import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { atomicWrite, type Logger, noopLogger } from '@vessel-agent/core';
import type { MemberState, MemberStatus, MemberVisibility } from './types.js';

/** 快照文件版本；形状变化时递增并按旧版本降级为空 */
export const AGENT_SNAPSHOT_VERSION = 1;

/** 快照文件形状（E2） */
export interface AgentSnapshotFile {
  version: number;
  tenant_id: string;
  updated_at: number;
  members: MemberStatus[];
}

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

/** 单条成员校验；字段非法返回 undefined（整条丢弃） */
function parseMember(value: unknown): MemberStatus | undefined {
  if (!isRecord(value)) return undefined;
  if (!nonEmptyString(value.id) || !nonEmptyString(value.session_id)) return undefined;
  if (!nonEmptyString(value.owner) || !nonEmptyString(value.visibility)) return undefined;
  if (!nonEmptyString(value.state)) return undefined;
  if (!VISIBILITIES.includes(value.visibility as MemberVisibility)) return undefined;
  if (!MEMBER_STATES.includes(value.state as MemberState)) return undefined;

  const status: MemberStatus = {
    id: value.id,
    session_id: value.session_id,
    owner: value.owner,
    visibility: value.visibility as MemberVisibility,
    state: value.state as MemberState,
  };
  const name = optionalString(value.name);
  if (name !== undefined) status.name = name;
  const parentId = optionalString(value.parent_id);
  if (parentId !== undefined) status.parent_id = parentId;
  const currentTool = optionalString(value.current_tool);
  if (currentTool !== undefined) status.current_tool = currentTool;
  if (typeof value.last_seen === 'number' && Number.isFinite(value.last_seen)) {
    status.last_seen = value.last_seen;
  }
  if (isRecord(value.usage)) status.usage = value.usage;
  return status;
}

/** 快照读写；写失败只记录不抛出 */
export class AgentSnapshotStore {
  private readonly logger: Logger;
  private readonly throttleMs: number;
  private readonly mode: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: (() => MemberStatus[]) | undefined;
  private chain: Promise<void> = Promise.resolve();

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

  /** 读取；缺失 / 损坏 / 版本不符都返回空列表 */
  async load(): Promise<MemberStatus[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.logger.error('agent.snapshot.load_failed', {
          path: this.filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return [];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      this.logger.error('agent.snapshot.load_failed', {
        path: this.filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }

    if (!isRecord(parsed) || parsed.version !== AGENT_SNAPSHOT_VERSION) {
      this.logger.error('agent.snapshot.load_failed', {
        path: this.filePath,
        error: `unsupported snapshot version: ${String(isRecord(parsed) ? parsed.version : 'n/a')}`,
      });
      return [];
    }

    if (!Array.isArray(parsed.members)) {
      this.logger.error('agent.snapshot.load_failed', {
        path: this.filePath,
        error: 'members is not an array',
      });
      return [];
    }

    const members: MemberStatus[] = [];
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

  /** 原子写；任何失败返回 false，不向上抛 */
  async write(members: MemberStatus[]): Promise<boolean> {
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
  schedule(getMembers: () => MemberStatus[]): void {
    this.pending = getMembers;
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.throttleMs);
    this.timer.unref?.();
  }

  /** 立即写入待写快照；写入串行，失败不抛 */
  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const getMembers = this.pending;
    this.pending = undefined;
    if (getMembers === undefined) {
      await this.chain;
      return;
    }
    const members = getMembers();
    this.chain = this.chain.then(async () => {
      await this.write(members);
    });
    await this.chain;
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
