/**
 * 附件目录浏览的边界实现（0.52）：`attachments.list` 的唯一刷选口径。
 *
 * 与 `runs.start` 的 `createConfigRefsGate`（`refs-gate.ts`）**同一份边界**：
 * 配置从 `basic-tools` 的安装配置来（`buildPluginConfigMap` 的合并顺序一致），
 * 判定只用 `buildPathBoundary` / `evaluatePath` / `canonicalPath`，
 * 不写第二套前缀比较。放装配层而不是 serve：边界属于 app（serve 只认结论）。
 *
 * 三条不变量（与方案 3 的安全面一致）：
 * - **只列单层**：不递归、不 watch、不返回内容，只有名字 / 真实路径 / 大小 / mtime；
 * - **deny 目录不出现**：命中的条目在列举时就被丢掉，不是列出来再标红；
 * - **符号链接按 realpath 判**：链接名可以骗人，判定用解析后的目标（越界的目标同样不出现）。
 *
 * 返回的 `path` 一律是**解析后的真实路径**：它要能过 `runs.start` 的闸门
 * （闸门按 `canonicalPath` 判），把链接路径交出去等于让人以为附上了、实际被拒。
 *
 * @module vessel/attachments-list
 */

import type { Dirent } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { VesselConfig } from '../packages/config/src/index';
import type {
  AttachmentListEntry,
  AttachmentLister,
  AttachmentListRequest,
  AttachmentListResult,
} from '../packages/serve/src/index';
import {
  buildPathBoundary,
  canonicalPath,
  evaluatePath,
  type PathBoundary,
  parseBasicToolsConfig,
} from '../plugins/tools/basic-tools/src/index';
import { resolveAgentCwd } from './path-resolution';
import { buildPluginConfigMap, declarativePluginEntries } from './plugin-config';

export interface AttachmentsListOptions {
  /**
   * 当前活配置（getter 而不是快照）：热应用（`gateway.reload` / `plugins.reload`）
   * 只改配置对象，gateway 实例不重建，列举必须自己看到新值。
   */
  getConfig: () => VesselConfig;
}

/** 一次列举要用的边界快照（配置指纹变了才重建，`buildPathBoundary` 会做 realpath）。 */
interface BoundarySnapshot {
  boundary: PathBoundary;
  /** 允许浏览的根（对外的 `roots`）。 */
  roots: string[];
  /** 相对路径的解析基准（与 basic-tools 的 `cwd` 同源）。 */
  baseCwd: string;
}

/** 只展开开头的 `~`（与工具的 `expandHomePrefix` 同口径；相对路径不解析）。 */
function expandHomePrefix(entry: string): string {
  if (entry === '~') return os.homedir();
  if (entry.startsWith('~/') || entry.startsWith('~\\')) {
    return path.join(os.homedir(), entry.slice(2));
  }
  return entry;
}

/**
 * 从 `basic-tools` 配置算边界与根。
 *
 * `roots` 的取法：配了 `allowed_roots` 就是它（canonical）；
 * 没配时给一个**安全默认**根 —— `agent.cwd`（与工具同一份 `cwd` 兜底），
 * 连它也没有时退回 `home`：绝不把 `/` 当默认根（daemon 的进程 cwd 可能就是它）。
 *
 * 默认根同时**参与判定**：`allowed_roots` 为空时 `evaluatePath` 会「不限制根」，
 * 所以这里把默认根塞进边界副本，越界仍然折成 `ask` —— 两套语义只留一个出口。
 */
function resolveBoundary(config: Record<string, unknown> | undefined): BoundarySnapshot {
  const parsed = parseBasicToolsConfig(config);
  const boundary = buildPathBoundary(parsed);
  const configuredCwd =
    parsed.cwd === undefined ? undefined : path.resolve(expandHomePrefix(parsed.cwd));
  const baseCwd = configuredCwd ?? process.cwd();
  if (boundary.allowedRoots.length > 0) return { boundary, roots: boundary.allowedRoots, baseCwd };
  const fallbackRoot = canonicalPath(configuredCwd ?? os.homedir());
  return {
    boundary: { ...boundary, allowedRoots: [fallbackRoot] },
    roots: [fallbackRoot],
    baseCwd,
  };
}

/** 目录先、再按名字（数字按数值比，大小写不敏感）。 */
function compareEntries(a: AttachmentListEntry, b: AttachmentListEntry): number {
  if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

/** mtime 是毫秒整数（`st.mtimeMs` 可能是小数 / NaN）。 */
function mtimeOf(value: number): number | undefined {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : undefined;
}

/** `dir` 参数 → 绝对路径（支持 `~`；相对路径按 basic-tools 的 cwd 解析）。 */
function resolveDir(dir: string, baseCwd: string): string {
  const expanded = expandHomePrefix(dir);
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(baseCwd, expanded);
}

async function listDirectory(
  snapshot: BoundarySnapshot,
  request: AttachmentListRequest,
): Promise<AttachmentListResult> {
  const { boundary, roots, baseCwd } = snapshot;
  // 不带 dir = 只要根（面板第一屏）。
  if (request.dir === undefined) return { roots, entries: [], truncated: false };

  const canonicalDir = canonicalPath(resolveDir(request.dir, baseCwd));
  const verdict = evaluatePath(canonicalDir, boundary);
  // deny / 越界都折成空列表 + 稳定码：列目录失败不该是 500。
  if (verdict !== 'allow') {
    return {
      roots,
      dir: canonicalDir,
      entries: [],
      truncated: false,
      reason: verdict === 'deny' ? 'refs_denied' : 'refs_outside_roots',
    };
  }

  try {
    const info = await stat(canonicalDir);
    if (!info.isDirectory()) throw new Error('not a directory');
  } catch {
    // 不存在 / 不是目录 / 读不了：同一个稳定码（与 refs 的 refs_invalid 同组）。
    return { roots, dir: canonicalDir, entries: [], truncated: false, reason: 'refs_invalid' };
  }

  let dirents: Dirent[];
  try {
    dirents = await readdir(canonicalDir, { withFileTypes: true });
  } catch {
    return { roots, dir: canonicalDir, entries: [], truncated: false, reason: 'refs_invalid' };
  }

  const collected: AttachmentListEntry[] = [];
  let truncated = false;
  for (const dirent of dirents) {
    // 隐藏项缺省不出现（不逐个报警，也不占 limit 名额）。
    if (!request.include_hidden && dirent.name.startsWith('.')) continue;
    const full = path.join(canonicalDir, dirent.name);
    let real: string;
    try {
      real = await realpath(full);
    } catch {
      // 悬空符号链接 / 解析失败：不出现（交不出能过闸门的路径）。
      continue;
    }
    // deny 与越界目标都不出现 —— 符号链接按 realpath 判，链接名骗不了这一关。
    if (evaluatePath(real, boundary) !== 'allow') continue;
    let info;
    try {
      info = await stat(real);
    } catch {
      continue;
    }
    const mtime = mtimeOf(info.mtimeMs);
    if (info.isDirectory()) {
      collected.push({
        name: dirent.name,
        path: real,
        kind: 'dir',
        ...(mtime !== undefined ? { mtime_ms: mtime } : {}),
      });
    } else if (info.isFile()) {
      collected.push({
        name: dirent.name,
        path: real,
        kind: 'file',
        bytes: info.size,
        ...(mtime !== undefined ? { mtime_ms: mtime } : {}),
      });
    } else {
      // 套接字 / 设备 / FIFO：既不能引用也不该出现在列表里。
      continue;
    }
    // 多收一条就足以判定「还有更多」，不必数完整棵树。
    if (collected.length > request.limit) {
      truncated = true;
      break;
    }
  }

  const rootHit = roots.includes(canonicalDir);
  const parentDir = rootHit ? undefined : path.dirname(canonicalDir);
  const parent =
    parentDir !== undefined &&
    parentDir !== canonicalDir &&
    evaluatePath(parentDir, boundary) === 'allow'
      ? parentDir
      : undefined;

  return {
    roots,
    dir: canonicalDir,
    ...(parent !== undefined ? { parent } : {}),
    entries: collected.sort(compareEntries).slice(0, request.limit),
    truncated,
  };
}

/** 从活配置构造列举器（装配层唯一入口；热应用后按新配置重建边界）。 */
export function createConfigAttachmentLister(options: AttachmentsListOptions): AttachmentLister {
  let fingerprint: string | undefined;
  let snapshot: BoundarySnapshot | undefined;

  const snapshotOf = (): BoundarySnapshot => {
    const config = options.getConfig();
    const pluginConfig = buildPluginConfigMap(
      config.plugins,
      declarativePluginEntries(config),
      resolveAgentCwd(config),
    )['basic-tools'];
    const next = JSON.stringify(pluginConfig ?? {});
    if (snapshot === undefined || fingerprint !== next) {
      snapshot = resolveBoundary(pluginConfig);
      fingerprint = next;
    }
    return snapshot;
  };

  return (request) => listDirectory(snapshotOf(), request);
}
