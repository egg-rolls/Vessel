/**
 * 文件后端 Team 存储（0.19 S3）。
 *
 * 布局（与 `<dataDir>/agents/<tenant>.json` 同级，不引入 core 的 TenantPaths）：
 *   <dataDir>/teams/<tenant>/<team_id>/
 *     team.json    # 元数据，atomicWrite 0600
 *     log.ndjson   # 只追加日志，0600
 *
 * 纪律：
 * - `ready()` 加载全部 `team.json`，缺失目录 = 空；损坏 / 非法 / v!==1 只 warning 后跳过，
 *   启动永不抛错；
 * - `seed()` 只补写缺失的 `team.json`，冲突只 warning，永不覆盖既有 name / policy；
 * - `ensureForWorkspace()` 全局串行 + 同 workspace 单飞，幂等：两次并发只会建一个目录；
 * - 不建第二个 roster 真相源；roster 由 Agent 记录派生（不在本文件）。
 *
 * @module @vessel-agent/agent
 */

import type { Dirent } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { TeamPolicy } from '@vessel-agent/config';
import { atomicWrite, type Logger, noopLogger } from '@vessel-agent/core';
import { TeamLogWriter } from './team-log.js';
import { normalizeWorkspace, teamIdForWorkspace, workspaceKey } from './team-slug.js';
import type { TeamBinder, TeamDeclaration, TeamLogEntry, TeamRecord, TeamStore } from './types.js';

/** `ensureForWorkspace` 入参（与 TeamBinder 端口一致） */
export type EnsureWorkspaceInput = Parameters<TeamBinder['ensureForWorkspace']>[0];

/** 构造选项 */
export interface FileTeamStoreOptions {
  /** dataDir 根（与 Agent 快照同级） */
  dataDir: string;
  tenantId: string;
  now?: () => number;
  logger?: Logger;
  /** 日志与 team.json 的 fsync；缺省 true（测试可关） */
  durable?: boolean;
}

/** `<dataDir>/teams/<tenant>` */
export function teamsDirPath(dataDir: string, tenantId: string): string {
  return join(dataDir, 'teams', tenantId);
}

/** `<dataDir>/teams/<tenant>/<team_id>` */
export function teamDirPath(dataDir: string, tenantId: string, teamId: string): string {
  return join(teamsDirPath(dataDir, tenantId), teamId);
}

/** `<dataDir>/teams/<tenant>/<team_id>/team.json` */
export function teamMetadataPath(dataDir: string, tenantId: string, teamId: string): string {
  return join(teamDirPath(dataDir, tenantId, teamId), 'team.json');
}

/** `<dataDir>/teams/<tenant>/<team_id>/log.ndjson` */
export function teamLogPath(dataDir: string, tenantId: string, teamId: string): string {
  return join(teamDirPath(dataDir, tenantId, teamId), 'log.ndjson');
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cloneRecord(record: TeamRecord): TeamRecord {
  return { ...record, policy: { ...record.policy } };
}

/** 严格校验一份 `team.json`；非法返回 null（调用方 warning 后跳过） */
function parseTeamRecord(raw: string, dirName: string, tenantId: string): TeamRecord | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.v !== 1) return null;
    if (typeof parsed.team_id !== 'string' || parsed.team_id === '') return null;
    if (parsed.team_id !== dirName) return null;
    if (typeof parsed.name !== 'string') return null;
    if (typeof parsed.tenant_id !== 'string' || parsed.tenant_id !== tenantId) return null;
    if (typeof parsed.workspace !== 'string' || parsed.workspace === '') return null;
    if (
      typeof parsed.policy !== 'object' ||
      parsed.policy === null ||
      Array.isArray(parsed.policy)
    ) {
      return null;
    }
    if (typeof parsed.created_at !== 'number' || !Number.isFinite(parsed.created_at)) return null;
    const record: TeamRecord = {
      v: 1,
      team_id: parsed.team_id,
      name: parsed.name,
      tenant_id: parsed.tenant_id,
      workspace: parsed.workspace,
      policy: parsed.policy as Record<string, unknown>,
      created_at: parsed.created_at,
    };
    if (typeof parsed.handoff_path === 'string') record.handoff_path = parsed.handoff_path;
    return record;
  } catch {
    return null;
  }
}

/**
 * 文件后端 `TeamStore`。
 *
 * 所有同步方法（`get` / `list`）只读内存映射；调用方应先 `await ready()`。
 * `ensureForWorkspace` 内部会自行等待 `ready()`。
 */
export class FileTeamStore implements TeamStore {
  readonly dataDir: string;
  readonly tenantId: string;
  private readonly nowFn: () => number;
  private readonly logger: Logger;
  private readonly durable: boolean;
  /** team_id -> 元数据 */
  private readonly teams = new Map<string, TeamRecord>();
  /** workspaceKey -> team_id */
  private readonly workspaceIndex = new Map<string, string>();
  /** team_id -> 日志写者（懒创建） */
  private readonly logWriters = new Map<string, TeamLogWriter>();
  private readyPromise?: Promise<void>;
  /** ensure / seed 的全局串行尾链 */
  private chainTail: Promise<void> = Promise.resolve();
  /** workspaceKey -> 进行中的 ensure（同 workspace 单飞） */
  private readonly inflight = new Map<string, Promise<TeamRecord>>();

  constructor(options: FileTeamStoreOptions) {
    if (typeof options.dataDir !== 'string' || options.dataDir === '') {
      throw new Error('FileTeamStore requires a non-empty dataDir');
    }
    if (typeof options.tenantId !== 'string' || options.tenantId === '') {
      throw new Error('FileTeamStore requires a non-empty tenantId');
    }
    this.dataDir = options.dataDir;
    this.tenantId = options.tenantId;
    this.nowFn = options.now ?? Date.now;
    this.logger = options.logger ?? noopLogger;
    this.durable = options.durable ?? true;
  }

  /** 加载 `<dataDir>/teams/<tenant>/<team_id>/team.json`；缺失 = 空，损坏 = warning + 跳过 */
  ready(): Promise<void> {
    if (this.readyPromise === undefined) {
      this.readyPromise = this.loadAll();
    }
    return this.readyPromise;
  }

  /** 配置声明：只补写缺失的 `team.json`；已有文件优先，冲突只 warning */
  async seed(declarations: readonly TeamDeclaration[]): Promise<void> {
    await this.ready();
    if (declarations.length === 0) return;
    await this.enqueue(async () => {
      const seen = new Set<string>();
      for (const declaration of declarations) {
        let workspace: string;
        let key: string;
        try {
          workspace = normalizeWorkspace(declaration.workspace);
          key = workspaceKey(workspace);
        } catch (error) {
          this.logger.warn('team.declaration.invalid', {
            workspace: declaration.workspace,
            error: errorMessage(error),
          });
          continue;
        }
        if (seen.has(key)) continue;
        seen.add(key);

        const existingId = this.workspaceIndex.get(key);
        if (existingId !== undefined) {
          const existing = this.teams.get(existingId);
          if (existing) {
            this.warnNameConflict(existing, declaration.name);
            continue;
          }
          this.workspaceIndex.delete(key);
        }

        const teamId = teamIdForWorkspace(workspace, (id) => this.teams.get(id)?.workspace);
        const occupant = this.teams.get(teamId);
        if (occupant) {
          if (workspaceKey(occupant.workspace) !== key) {
            this.logger.warn('team.metadata.conflict', { team_id: teamId, field: 'workspace' });
          } else {
            this.warnNameConflict(occupant, declaration.name);
          }
          continue;
        }

        const record = this.buildRecord(teamId, workspace, {
          workspace,
          name: declaration.name,
          handoff_path: declaration.handoff_path,
          policy: declaration.policy,
        });
        await this.persist(record);
        this.register(record);
      }
    });
  }

  /**
   * 确保 workspace 有 Team（幂等）。
   *
   * 同一 workspace 的并发调用共享同一个 Promise，只会创建一份目录 / `team.json`；
   * 不同 workspace 的相同 slug 由 `teamIdForWorkspace` 追加哈希后缀，绝不合并。
   */
  async ensureForWorkspace(input: EnsureWorkspaceInput): Promise<TeamRecord> {
    await this.ready();
    const key = workspaceKey(input.workspace);
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const task = this.enqueue(() => this.ensureLocked(key, input));
    this.inflight.set(key, task);
    try {
      return await task;
    } finally {
      if (this.inflight.get(key) === task) this.inflight.delete(key);
    }
  }

  get(teamId: string): TeamRecord | undefined {
    const record = this.teams.get(teamId);
    return record ? cloneRecord(record) : undefined;
  }

  /** 0.19 S4；解析器由 team-policy 提供，非法子结构在解析时忽略 */
  policy(teamId: string): TeamPolicy | undefined {
    const record = this.teams.get(teamId);
    return record ? (record.policy as TeamPolicy) : undefined;
  }

  list(): TeamRecord[] {
    return [...this.teams.values()]
      .map(cloneRecord)
      .sort((left, right) => left.team_id.localeCompare(right.team_id));
  }

  /** 未知 Team 返回空（调用方应先判存在性） */
  async readLog(teamId: string, options: { limit?: number } = {}): Promise<TeamLogEntry[]> {
    await this.ready();
    return this.writerFor(teamId).read(options);
  }

  /** 串行追加；失败 reject（由调用方映射 team_log_write_failed） */
  async appendLog(entry: TeamLogEntry): Promise<void> {
    await this.ready();
    await this.writerFor(entry.team_id).append(entry);
  }

  /** 等待所有日志写链与 ensure / seed 串行链排空 */
  async flush(): Promise<void> {
    await this.ready();
    await this.chainTail.catch(() => {});
    await Promise.all([...this.logWriters.values()].map((writer) => writer.flush()));
  }

  private async loadAll(): Promise<void> {
    const dir = teamsDirPath(this.dataDir, this.tenantId);
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return;
      this.logger.warn('team.metadata.corrupt', { path: dir, error: errorMessage(error) });
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name, 'team.json');
      let raw: string;
      try {
        raw = await readFile(path, 'utf8');
      } catch (error) {
        if (isNotFound(error)) continue;
        this.logger.warn('team.metadata.corrupt', { path, error: errorMessage(error) });
        continue;
      }
      const record = parseTeamRecord(raw, entry.name, this.tenantId);
      if (!record) {
        this.logger.warn('team.metadata.corrupt', { path });
        continue;
      }
      this.register(record);
    }
  }

  private async ensureLocked(key: string, input: EnsureWorkspaceInput): Promise<TeamRecord> {
    const existingId = this.workspaceIndex.get(key);
    if (existingId !== undefined) {
      const existing = this.teams.get(existingId);
      if (existing) return existing;
      this.workspaceIndex.delete(key);
    }

    const workspace = normalizeWorkspace(input.workspace);
    const teamId = teamIdForWorkspace(workspace, (id) => this.teams.get(id)?.workspace);
    const occupant = this.teams.get(teamId);
    if (occupant) {
      // 同一 id 但 workspace 不同：绝不合并（正常由哈希后缀避免）。
      if (workspaceKey(occupant.workspace) !== key) {
        throw new Error(`team_id_collision: ${teamId}`);
      }
      return occupant;
    }

    const record = this.buildRecord(teamId, workspace, input);
    await this.persist(record);
    this.register(record);
    return record;
  }

  private buildRecord(teamId: string, workspace: string, input: EnsureWorkspaceInput): TeamRecord {
    const name =
      input.name !== undefined && input.name !== '' ? input.name : basename(workspace) || teamId;
    const record: TeamRecord = {
      v: 1,
      team_id: teamId,
      name,
      tenant_id: this.tenantId,
      workspace,
      policy: { ...(input.policy ?? {}) },
      created_at: this.nowFn(),
    };
    if (input.handoff_path !== undefined && input.handoff_path !== '') {
      record.handoff_path = input.handoff_path;
    }
    return record;
  }

  private async persist(record: TeamRecord): Promise<void> {
    await mkdir(teamDirPath(this.dataDir, this.tenantId, record.team_id), {
      recursive: true,
      mode: 0o700,
    });
    await atomicWrite(
      teamMetadataPath(this.dataDir, this.tenantId, record.team_id),
      `${JSON.stringify(record, null, 2)}\n`,
      { mode: 0o600, durable: this.durable },
    );
  }

  private register(record: TeamRecord): void {
    this.teams.set(record.team_id, record);
    let key: string;
    try {
      key = workspaceKey(record.workspace);
    } catch {
      return;
    }
    if (!this.workspaceIndex.has(key)) this.workspaceIndex.set(key, record.team_id);
  }

  private warnNameConflict(record: TeamRecord, declaredName: string | undefined): void {
    if (declaredName !== undefined && declaredName !== '' && declaredName !== record.name) {
      this.logger.warn('team.metadata.conflict', { team_id: record.team_id, field: 'name' });
    }
  }

  private writerFor(teamId: string): TeamLogWriter {
    let writer = this.logWriters.get(teamId);
    if (writer === undefined) {
      writer = new TeamLogWriter({
        path: teamLogPath(this.dataDir, this.tenantId, teamId),
        logger: this.logger,
        durable: this.durable,
      });
      this.logWriters.set(teamId, writer);
    }
    return writer;
  }

  /** 全局串行链：上一任务失败也继续执行下一个 */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chainTail.then(fn, fn);
    this.chainTail = run.then(
      () => {},
      () => {},
    );
    return run;
  }
}
