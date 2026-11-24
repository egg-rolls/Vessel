/**
 * @vessel-agent/plugin-skills — 技能扫描器
 * @module @vessel-agent/skills/scanner
 *
 * 设计 §5.1：三根各自扫描，containment fail-closed——
 * 根 realpath 钉死 + 路径边界判定（越界根不扫描、告警）；symlink 条目跳过
 * （目标可被无痕替换，ui-bundle 哈希锁同款口径）；单文件 1 MiB（超限标
 * oversize，可 list 不可 load）；条目总数 / 目录深度 / 附件清单都有硬上限。
 *
 * 两种形态：flat = `<root>/<name>.md`（可嵌套子目录，id 含相对路径）；
 * dir = `<root>/<name>/SKILL.md` + 附件（只列清单，插件不代读、不执行）。
 */

import { createHash } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { canonicalPath, evaluatePath, type PathBoundary } from '@vessel-agent/basic-tools';
import { capDescription, deriveDescription, parseFrontmatter } from './frontmatter.js';
import {
  MAX_AUX_FILES,
  MAX_SCAN_DEPTH,
  MAX_SKILL_FILE_BYTES,
  type SkillEntry,
  type SkillSource,
} from './types.js';

/** 单根扫描结果 */
export interface ScanRootResult {
  entries: SkillEntry[];
  warnings: string[];
}

/** 扫描选项：根路径 / 来源标签 / 路径边界 / 剩余条目预算 */
export interface ScanRootOptions {
  root: string;
  source: SkillSource;
  boundary: PathBoundary;
  /** 本根最多产出多少条目（三根合计不超 MAX_SKILL_ENTRIES） */
  budget: number;
}

/** 相对路径统一 '/' 分隔（id 与 relPath 的确定性口径） */
function toRelPath(fromRoot: string, absolute: string): string {
  return path.relative(fromRoot, absolute).split(path.sep).join('/');
}

/** 技能 id：`<source>/<relpath 去扩展名>` */
function skillId(source: SkillSource, relPath: string): string {
  return `${source}/${relPath.replace(/\.md$/i, '')}`;
}

/** 名字回落：flat 取文件名去扩展名；dir 取目录名 */
function fallbackName(relPath: string, format: 'flat' | 'dir'): string {
  const base = format === 'dir' ? path.posix.dirname(relPath) : relPath.replace(/\.md$/i, '');
  const name = path.posix.basename(base);
  return name === '' || name === '.' ? relPath : name;
}

/** 收集 dir 形态附件清单（相对技能目录；symlink 跳过；上限截断标注） */
async function collectAuxFiles(
  skillDir: string,
  warnings: string[],
): Promise<string[] | undefined> {
  const aux: string[] = [];
  let truncated = false;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (truncated || depth > MAX_SCAN_DEPTH) return;
    let items: Dirent[];
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of [...items].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (truncated) return;
      if (item.isSymbolicLink() || item.name.startsWith('.')) continue;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        await walk(full, depth + 1);
      } else if (item.isFile()) {
        if (full === path.join(skillDir, 'SKILL.md')) continue;
        if (aux.length >= MAX_AUX_FILES) {
          truncated = true;
          return;
        }
        aux.push(toRelPath(skillDir, full));
      }
    }
  };
  await walk(skillDir, 1);
  if (aux.length === 0) return undefined;
  if (truncated) {
    warnings.push(`auxiliary file list truncated to ${MAX_AUX_FILES} entries`);
  }
  return aux;
}

/** 读一个技能文件成条目（oversize 不读内容：sha256 为空，load 侧拒绝） */
async function buildEntry(options: {
  file: string;
  relPath: string;
  source: SkillSource;
  format: 'flat' | 'dir';
  auxFiles?: string[];
}): Promise<SkillEntry> {
  const { file, relPath, source, format } = options;
  const info = await stat(file);
  const warnings: string[] = [];
  const base: SkillEntry = {
    id: skillId(source, relPath),
    name: fallbackName(relPath, format),
    description: '',
    tags: [],
    source,
    relPath,
    absPath: canonicalPath(file),
    format,
    bytes: info.size,
    mtimeMs: info.mtimeMs,
    sha256: '',
    frontmatter: 'none',
  };
  if (options.auxFiles !== undefined) base.auxFiles = options.auxFiles;

  if (info.size > MAX_SKILL_FILE_BYTES) {
    warnings.push(
      `oversize: ${info.size} bytes exceeds the ${MAX_SKILL_FILE_BYTES} byte scan cap; list-only`,
    );
    base.warnings = warnings;
    return base;
  }

  let raw: string;
  try {
    raw = await readFile(file, 'utf-8');
  } catch (error) {
    warnings.push(`unreadable: ${error instanceof Error ? error.message : String(error)}`);
    base.warnings = warnings;
    return base;
  }
  base.sha256 = createHash('sha256').update(raw, 'utf-8').digest('hex');
  const fm = parseFrontmatter(raw);
  base.frontmatter = fm.state;
  if (fm.name !== undefined && fm.name !== '') base.name = fm.name;
  base.description = capDescription(fm.description ?? deriveDescription(fm.body));
  if (fm.tags !== undefined) base.tags = fm.tags;
  if (fm.version !== undefined) base.version = fm.version;
  warnings.push(...fm.warnings);
  if (warnings.length > 0) base.warnings = warnings;
  return base;
}

/**
 * 扫描单个来源根。根不存在 → 空结果（约定目录可以缺席）；根越界 / 不是目录 →
 * 告警 + 空结果。条目按 id 排序（确定性序列化）。
 */
export async function scanSkillRoot(options: ScanRootOptions): Promise<ScanRootResult> {
  const { root, source, boundary, budget } = options;
  const warnings: string[] = [];
  const entries: SkillEntry[] = [];

  let rootInfo: Stats;
  try {
    rootInfo = await stat(root);
  } catch {
    return { entries, warnings };
  }
  if (!rootInfo.isDirectory()) {
    warnings.push(`skill root "${root}" is not a directory; not scanned`);
    return { entries, warnings };
  }
  const canonicalRoot = canonicalPath(root);
  const decision = evaluatePath(canonicalRoot, boundary);
  if (decision !== 'allow') {
    warnings.push(`skill root "${root}" is outside the path boundary (${decision}); not scanned`);
    return { entries, warnings };
  }

  let capped = false;
  let symlinkSkips = 0;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (capped) return;
    if (depth > MAX_SCAN_DEPTH) {
      warnings.push(`directory depth cap (${MAX_SCAN_DEPTH}) reached under "${dir}"; skipped`);
      return;
    }
    let items: Dirent[];
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      warnings.push(
        `cannot read "${dir}": ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    for (const item of [...items].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (capped) return;
      if (item.isSymbolicLink()) {
        symlinkSkips += 1;
        continue;
      }
      if (item.name.startsWith('.')) continue;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        // dir 形态：目录里有 SKILL.md 即技能目录，附件只列清单，不再下钻找技能。
        // lstat 不跟随 symlink：SKILL.md 本身是 symlink 时不算技能（fail-closed）。
        let skillFile: string | undefined;
        try {
          const candidate = path.join(full, 'SKILL.md');
          const info = await lstat(candidate);
          if (info.isFile()) skillFile = candidate;
        } catch {
          // 无 SKILL.md：普通子目录，继续下钻
        }
        if (skillFile !== undefined) {
          if (entries.length >= budget) {
            capped = true;
            return;
          }
          const relDir = toRelPath(canonicalRoot, full);
          const aux = await collectAuxFiles(full, warnings);
          entries.push(
            await buildEntry({
              file: skillFile,
              relPath: `${relDir}/SKILL.md`,
              source,
              format: 'dir',
              ...(aux !== undefined ? { auxFiles: aux } : {}),
            }),
          );
        } else {
          await walk(full, depth + 1);
        }
      } else if (item.isFile() && item.name.toLowerCase().endsWith('.md')) {
        if (entries.length >= budget) {
          capped = true;
          return;
        }
        entries.push(
          await buildEntry({
            file: full,
            relPath: toRelPath(canonicalRoot, full),
            source,
            format: 'flat',
          }),
        );
      }
    }
  };

  await walk(canonicalRoot, 0);
  if (symlinkSkips > 0) {
    warnings.push(`skipped ${symlinkSkips} symlink entries (fail-closed)`);
  }
  if (capped) {
    warnings.push(`skill entry budget (${budget}) reached; further entries skipped`);
  }
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { entries, warnings };
}
