/**
 * @vessel-agent/plugin-skills — 索引 / 信任 / 加载态存储
 * @module @vessel-agent/skills/store
 *
 * 设计 §5.3 存储布局（插件私有目录 `<dataDir>/plugins/skills/`）：
 * - index.json：派生缓存，整文件覆盖（可整文件重建）；
 * - trust.json：TOFU 哈希锁，宿主侧写，唯一真相；损坏 → fail-closed 全部
 *   unknown（R11：重新确认，不静默放行）；
 * - loads/<sessionId>.json：会话加载状态（工具 handler 写，UI 读），追加式
 *   上限 200 条。
 *
 * 写纪律：trust.json / loads/* 经临时文件 + rename 原子写；并发写以进程内
 * 单写队列串行化（in-process 无跨进程竞争；多 node 各自 dataDir 天然隔离）。
 * 读侧全程防御：损坏 / 形状非法降级为空态，不崩溃。
 */

import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
  emptyIndex,
  emptySessionLoads,
  emptyTrustStore,
  MAX_LOADS_PER_SESSION,
  MAX_LOADS_SESSIONS,
  type SessionLoad,
  type SessionLoads,
  type SkillEntry,
  type SkillIndex,
  type TrustRecord,
  type TrustStore,
} from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

const SOURCES = new Set(['project', 'user', 'library']);
const FRONTMATTER_STATES = new Set(['ok', 'partial', 'none', 'invalid']);

/** 索引条目防御解析：必填字段缺失 / 非法即丢弃该条（索引是可重建缓存） */
function normalizeEntry(value: unknown): SkillEntry | undefined {
  if (!isRecord(value)) return undefined;
  const id = readString(value, 'id');
  const name = readString(value, 'name');
  const source = readString(value, 'source');
  const relPath = readString(value, 'relPath');
  const absPath = readString(value, 'absPath');
  const format = readString(value, 'format');
  const frontmatter = readString(value, 'frontmatter');
  if (
    id === undefined ||
    name === undefined ||
    source === undefined ||
    !SOURCES.has(source) ||
    relPath === undefined ||
    absPath === undefined ||
    (format !== 'flat' && format !== 'dir') ||
    frontmatter === undefined ||
    !FRONTMATTER_STATES.has(frontmatter)
  ) {
    return undefined;
  }
  const tags = Array.isArray(value.tags)
    ? value.tags.filter((tag): tag is string => typeof tag === 'string')
    : [];
  const warnings = Array.isArray(value.warnings)
    ? value.warnings.filter((item): item is string => typeof item === 'string')
    : [];
  const auxFiles = Array.isArray(value.auxFiles)
    ? value.auxFiles.filter((item): item is string => typeof item === 'string')
    : undefined;
  const entry: SkillEntry = {
    id,
    name,
    description: readString(value, 'description') ?? '',
    tags,
    source: source as SkillEntry['source'],
    relPath,
    absPath,
    format,
    bytes: readNumber(value, 'bytes') ?? 0,
    mtimeMs: readNumber(value, 'mtimeMs') ?? 0,
    sha256: readString(value, 'sha256') ?? '',
    frontmatter: frontmatter as SkillEntry['frontmatter'],
  };
  const version = readString(value, 'version');
  if (version !== undefined) entry.version = version;
  if (auxFiles !== undefined && auxFiles.length > 0) entry.auxFiles = auxFiles;
  if (warnings.length > 0) entry.warnings = warnings;
  return entry;
}

/** 索引防御解析：结构非法 → 空索引（派生缓存，重建即可） */
function normalizeIndex(parsed: unknown): SkillIndex {
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    return emptyIndex();
  }
  const entries: SkillEntry[] = [];
  for (const value of parsed.entries) {
    const entry = normalizeEntry(value);
    if (entry !== undefined) entries.push(entry);
  }
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    version: 1,
    generatedAt: readString(parsed, 'generatedAt') ?? new Date(0).toISOString(),
    entries,
  };
}

/** 信任记录防御解析：非法记录丢弃（fail-closed → 该技能回 unknown）。
 * sha256 允许空串（仅撤销记录可能无哈希；trusted 空哈希永不匹配，方向安全）。 */
function normalizeTrustRecord(value: unknown): TrustRecord | undefined {
  if (!isRecord(value)) return undefined;
  const sha256 = typeof value.sha256 === 'string' ? value.sha256 : undefined;
  const recordedAt = readString(value, 'recordedAt');
  const origin = readString(value, 'origin');
  const state = readString(value, 'state');
  if (
    sha256 === undefined ||
    recordedAt === undefined ||
    (origin !== 'local' && origin !== 'import' && origin !== 'marketplace') ||
    (state !== 'trusted' && state !== 'revoked')
  ) {
    return undefined;
  }
  return { sha256, recordedAt, origin, state };
}

/** 信任库防御解析：顶层非法 → 空库 + 告警（R11） */
function normalizeTrustStore(parsed: unknown): { store: TrustStore; corrupted: boolean } {
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.skills)) {
    return { store: emptyTrustStore(), corrupted: true };
  }
  const skills: Record<string, TrustRecord> = {};
  for (const [id, value] of Object.entries(parsed.skills)) {
    const record = normalizeTrustRecord(value);
    if (record !== undefined) skills[id] = record;
  }
  return { store: { version: 1, skills }, corrupted: false };
}

/** 加载记录防御解析 */
function normalizeLoad(value: unknown): SessionLoad | undefined {
  if (!isRecord(value)) return undefined;
  const id = readString(value, 'id');
  const sha256 = readString(value, 'sha256');
  const loadedAt = readString(value, 'loadedAt');
  const runId = readString(value, 'runId');
  if (id === undefined || sha256 === undefined || loadedAt === undefined || runId === undefined) {
    return undefined;
  }
  return { id, sha256, loadedAt, runId };
}

/** 会话加载态防御解析：非法 → 空态；上限 200 条（保留最新） */
function normalizeSessionLoads(sessionId: string, parsed: unknown): SessionLoads {
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.loaded)) {
    return emptySessionLoads(sessionId);
  }
  const loaded: SessionLoad[] = [];
  for (const value of parsed.loaded) {
    const load = normalizeLoad(value);
    if (load !== undefined) loaded.push(load);
  }
  return {
    version: 1,
    sessionId,
    loaded: loaded.slice(-MAX_LOADS_PER_SESSION),
  };
}

/** 原子写：同目录临时文件 + rename；失败清理临时文件并抛出 */
async function atomicWrite(target: string, content: string): Promise<void> {
  const dir = path.dirname(target);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(temp, content, { encoding: 'utf-8', mode: 0o600 });
    await rename(temp, target);
  } catch (error) {
    try {
      await unlink(temp);
    } catch {
      // 临时文件可能未创建
    }
    throw error;
  }
}

/** 索引 / 信任 / 加载态存储（插件私有目录） */
export class SkillsStore {
  private readonly stateDir: string;
  /** 每个目标文件一条写队列，避免同进程内并发写交错 */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(stateDir: string) {
    this.stateDir = stateDir;
  }

  /** 插件私有目录（index/trust/loads/library 的根） */
  get dir(): string {
    return this.stateDir;
  }

  /** 收集库根（导入落地处；装配层把它追加进 basic-tools deny_paths） */
  get libraryDir(): string {
    return path.join(this.stateDir, 'library');
  }

  get indexPath(): string {
    return path.join(this.stateDir, 'index.json');
  }

  get trustPath(): string {
    return path.join(this.stateDir, 'trust.json');
  }

  loadsPath(sessionId: string): string {
    return path.join(this.stateDir, 'loads', `${encodeURIComponent(sessionId)}.json`);
  }

  /** 串行化写：同目标文件的写按调用顺序落盘 */
  private enqueue(target: string, write: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(target) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(write);
    this.chains.set(target, next);
    return next.finally(() => {
      if (this.chains.get(target) === next) this.chains.delete(target);
    });
  }

  /** 读索引；ENOENT / 损坏 / 形状非法 → 空索引 */
  async readIndex(): Promise<SkillIndex> {
    let raw: string;
    try {
      raw = await readFile(this.indexPath, 'utf-8');
    } catch {
      return emptyIndex();
    }
    try {
      return normalizeIndex(JSON.parse(raw));
    } catch {
      return emptyIndex();
    }
  }

  /** 整文件覆盖索引（派生缓存，O(1) 当前态） */
  async writeIndex(index: SkillIndex): Promise<void> {
    await this.enqueue(this.indexPath, () =>
      atomicWrite(this.indexPath, `${JSON.stringify(index)}\n`),
    );
  }

  /** 读信任库；损坏 → fail-closed 空库 + corrupted 标记（调用方告警） */
  async readTrust(): Promise<{ store: TrustStore; corrupted: boolean }> {
    let raw: string;
    try {
      raw = await readFile(this.trustPath, 'utf-8');
    } catch {
      return { store: emptyTrustStore(), corrupted: false };
    }
    try {
      return normalizeTrustStore(JSON.parse(raw));
    } catch {
      return { store: emptyTrustStore(), corrupted: true };
    }
  }

  /** 原子写信任库（唯一写口：工具 handler / RPC handler） */
  async writeTrust(store: TrustStore): Promise<void> {
    await this.enqueue(this.trustPath, () =>
      atomicWrite(this.trustPath, `${JSON.stringify(store)}\n`),
    );
  }

  /** 读单会话加载态；缺失 / 损坏 → 空态 */
  async readLoads(sessionId: string): Promise<SessionLoads> {
    let raw: string;
    try {
      raw = await readFile(this.loadsPath(sessionId), 'utf-8');
    } catch {
      return emptySessionLoads(sessionId);
    }
    try {
      return normalizeSessionLoads(sessionId, JSON.parse(raw));
    } catch {
      return emptySessionLoads(sessionId);
    }
  }

  /** 追加一条加载记录（上限 200 条，超出丢最旧）；读改写经写队列串行化 */
  async appendLoad(sessionId: string, load: SessionLoad): Promise<void> {
    await this.enqueue(this.loadsPath(sessionId), async () => {
      const state = await this.readLoads(sessionId);
      state.loaded.push(load);
      if (state.loaded.length > MAX_LOADS_PER_SESSION) {
        state.loaded = state.loaded.slice(-MAX_LOADS_PER_SESSION);
      }
      await atomicWrite(this.loadsPath(sessionId), `${JSON.stringify(state)}\n`);
    });
  }

  /** 列出全部会话加载态（上限 100 会话，按 sessionId 排序；损坏文件跳过） */
  async listLoads(): Promise<SessionLoads[]> {
    let names: string[];
    try {
      names = await readdir(path.join(this.stateDir, 'loads'));
    } catch {
      return [];
    }
    const sessionIds = names
      .filter((name) => name.endsWith('.json'))
      .map((name) => decodeURIComponent(name.slice(0, -'.json'.length)))
      .sort()
      .slice(0, MAX_LOADS_SESSIONS);
    const out: SessionLoads[] = [];
    for (const sessionId of sessionIds) {
      out.push(await this.readLoads(sessionId));
    }
    return out;
  }
}
