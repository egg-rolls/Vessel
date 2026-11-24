/**
 * @vessel-agent/plugin-skills — 索引服务（扫描 / 索引 / 读文件 / 信任访问）
 * @module @vessel-agent/skills/service
 *
 * 设计 §4/§5.4：install 期异步全量扫描；watch 去抖增量重扫；rescan 手动全量。
 * **索引是缓存不是真相**：load 永远经 readSkillFile 重读文件并重算 sha256，
 * 索引过期只影响 list/search 时效，不影响信任判定。
 *
 * 并发：扫描 / 索引写经进程内单队列串行化（watch 事件与手动 rescan 不交错）。
 */

import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import type { PathBoundary } from '@vessel-agent/basic-tools';
import type { SkillsConfig } from './config.js';
import { scanSkillRoot } from './scanner.js';
import type { SkillsStore } from './store.js';
import { trustStateOf } from './trust.js';
import {
  emptyIndex,
  emptyTrustStore,
  MAX_SKILL_ENTRIES,
  MAX_SKILL_FILE_BYTES,
  type SkillEntry,
  type SkillIndex,
  type SkillSource,
  type TrustRecord,
  type TrustState,
  type TrustStore,
} from './types.js';
import { type SkillsWatcher, watchSkillRoots } from './watch.js';

/** rescan 结果（RPC DTO；added/removed/changed 按 id） */
export interface RescanResult {
  added: string[];
  removed: string[];
  changed: string[];
  total: number;
  warnings: string[];
}

/** 读文件结果：成功带内容与重算哈希；oversize / 不可读带错误（不静默） */
export type ReadSkillResult =
  | { ok: true; content: string; sha256: string; bytes: number; mtimeMs: number }
  | { ok: false; error: 'oversize' | 'unreadable'; bytes: number; message: string };

/** 索引服务构造选项 */
export interface SkillsServiceOptions {
  config: SkillsConfig;
  boundary: PathBoundary;
  store: SkillsStore;
  warn?: (message: string) => void;
}

export class SkillsService {
  readonly config: SkillsConfig;
  readonly boundary: PathBoundary;
  readonly store: SkillsStore;
  private readonly warn: (message: string) => void;
  private index: SkillIndex = emptyIndex();
  private trust: TrustStore = emptyTrustStore();
  private trustCorrupted = false;
  private watcher: SkillsWatcher | undefined;
  private readonly readyPromise: Promise<void>;
  /** 扫描 / 索引写单队列 */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: SkillsServiceOptions) {
    this.config = options.config;
    this.boundary = options.boundary;
    this.store = options.store;
    this.warn = options.warn ?? ((message) => console.warn(message));
    this.readyPromise = this.initialize();
  }

  /** 首次扫描完成（工具 / RPC 调用前 await） */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  private async initialize(): Promise<void> {
    // 先读持久化缓存（list 立即可用旧快照），再全量重扫（文件是真相源）
    this.index = await this.store.readIndex();
    const trustRead = await this.store.readTrust();
    this.trust = trustRead.store;
    this.trustCorrupted = trustRead.corrupted;
    if (trustRead.corrupted) {
      this.warn('[skills] trust.json corrupted; all skills fall back to unknown (re-confirm)');
    }
    await this.rescan();
    if (this.config.watch) {
      this.watcher = watchSkillRoots(
        this.enabledRoots().map((item) => item.root),
        (root) => {
          const match = this.enabledRoots().find((item) => item.root === root);
          if (match === undefined) return;
          void this.enqueue(() => this.rescanRoot(match.source));
        },
        this.warn,
      );
    }
  }

  /** 启用中的来源根（sources 开关过滤） */
  enabledRoots(): Array<{ source: SkillSource; root: string }> {
    const roots: Array<{ source: SkillSource; root: string }> = [];
    if (this.config.sources.project) {
      roots.push({ source: 'project', root: this.config.projectRoot });
    }
    if (this.config.sources.user) roots.push({ source: 'user', root: this.config.userRoot });
    if (this.config.sources.library) {
      roots.push({ source: 'library', root: this.config.libraryRoot });
    }
    return roots;
  }

  /** 串行化扫描任务 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.catch(() => {}).then(task);
    this.chain = next;
    return next;
  }

  /** 当前索引快照（内存态） */
  getIndex(): SkillIndex {
    return this.index;
  }

  /** 当前信任库快照（内存态） */
  getTrustStore(): TrustStore {
    return this.trust;
  }

  /** trust.json 是否损坏（UI / 诊断可追溯） */
  isTrustCorrupted(): boolean {
    return this.trustCorrupted;
  }

  entryById(id: string): SkillEntry | undefined {
    return this.index.entries.find((entry) => entry.id === id);
  }

  /** 信任态派生（单一口径 trust.ts） */
  trustState(entry: SkillEntry): TrustState {
    return trustStateOf(entry, this.trust);
  }

  /** 写一条信任记录（内存 + 原子落盘；唯一写口经此） */
  async putTrustRecord(id: string, record: TrustRecord): Promise<void> {
    await this.enqueue(async () => {
      this.trust = { version: 1, skills: { ...this.trust.skills, [id]: record } };
      await this.store.writeTrust(this.trust);
    });
  }

  /** 全量重建索引（手动 rescan / 初始化）；diff 旧索引产出 added/removed/changed */
  async rescan(): Promise<RescanResult> {
    return this.enqueue(async () => {
      const old = new Map(this.index.entries.map((entry) => [entry.id, entry.sha256]));
      const entries: SkillEntry[] = [];
      const warnings: string[] = [];
      for (const { source, root } of this.enabledRoots()) {
        const result = await scanSkillRoot({
          root,
          source,
          boundary: this.boundary,
          budget: MAX_SKILL_ENTRIES - entries.length,
        });
        entries.push(...result.entries);
        warnings.push(...result.warnings.map((item) => `${source}: ${item}`));
        if (entries.length >= MAX_SKILL_ENTRIES) break;
      }
      entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const next: SkillIndex = {
        version: 1,
        generatedAt: new Date().toISOString(),
        entries,
      };
      const added: string[] = [];
      const changed: string[] = [];
      for (const entry of entries) {
        const previous = old.get(entry.id);
        if (previous === undefined) added.push(entry.id);
        else if (previous !== entry.sha256) changed.push(entry.id);
      }
      const current = new Set(entries.map((entry) => entry.id));
      const removed = [...old.keys()].filter((id) => !current.has(id));
      this.index = next;
      await this.persistIndex();
      return { added, removed, changed, total: entries.length, warnings };
    });
  }

  /** 单根增量重扫（watch 去抖回调）：替换该来源条目，其余保留 */
  async rescanRoot(source: SkillSource): Promise<void> {
    const match = this.enabledRoots().find((item) => item.source === source);
    if (match === undefined) return;
    const result = await scanSkillRoot({
      root: match.root,
      source,
      boundary: this.boundary,
      budget: MAX_SKILL_ENTRIES,
    });
    for (const warning of result.warnings) this.warn(`[skills] ${source}: ${warning}`);
    const others = this.index.entries.filter((entry) => entry.source !== source);
    const entries = [...others, ...result.entries].slice(0, MAX_SKILL_ENTRIES);
    entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.index = { version: 1, generatedAt: new Date().toISOString(), entries };
    await this.persistIndex();
  }

  /** load 成功后更新索引条目（哈希 / mtime 时效；索引只是缓存） */
  async updateEntry(entry: SkillEntry): Promise<void> {
    await this.enqueue(async () => {
      const entries = this.index.entries.map((item) => (item.id === entry.id ? entry : item));
      this.index = { version: 1, generatedAt: new Date().toISOString(), entries };
      await this.persistIndex();
    });
  }

  private async persistIndex(): Promise<void> {
    try {
      await this.store.writeIndex(this.index);
    } catch (error) {
      // 索引是派生缓存：写失败只告警，内存态仍可用
      this.warn(
        `[skills] index write failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * 重读技能文件并重算 sha256（load / get / trust_set 共用；不信任索引）。
   * oversize 拒绝读取（可 list 不可 load）；不可读如实报错。
   */
  async readSkillFile(entry: SkillEntry): Promise<ReadSkillResult> {
    let info: Stats;
    try {
      info = await stat(entry.absPath);
    } catch (error) {
      return {
        ok: false,
        error: 'unreadable',
        bytes: 0,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (info.size > MAX_SKILL_FILE_BYTES) {
      return { ok: false, error: 'oversize', bytes: info.size, message: 'exceeds scan cap' };
    }
    let content: string;
    try {
      content = await readFile(entry.absPath, 'utf-8');
    } catch (error) {
      return {
        ok: false,
        error: 'unreadable',
        bytes: info.size,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    return {
      ok: true,
      content,
      sha256: createHash('sha256').update(content, 'utf-8').digest('hex'),
      bytes: info.size,
      mtimeMs: info.mtimeMs,
    };
  }

  /** 关闭 watcher（dispose 用） */
  dispose(): void {
    this.watcher?.close();
    this.watcher = undefined;
  }
}
