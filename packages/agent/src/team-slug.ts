/**
 * Team workspace 归一化与 `team_id` 生成（0.19 S3）。
 *
 * - workspace 是 Team 的唯一分组键；归一化不要求目录存在；
 * - 同一目录的不同写法（junction / symlink、大小写、8.3 短名、NFD / NFC）必须收敛成同一个
 *   workspace，否则同一块目录会被切成多个 team；
 * - `team_id` = slug(workspace basename)，冲突时追加 sha256 前 8 位；
 * - Windows 比较大小写不敏感，但存储保持原样（只影响比较键）。
 *
 * @module @vessel-agent/agent
 */

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, parse, resolve } from 'node:path';

/** `team_id` 基础 slug 的最大长度 */
export const MAX_TEAM_SLUG_LENGTH = 32;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** 可打印 ASCII（0x20–0x7e）；非 ASCII / 控制字符无法生成可读 slug */
function isPrintableAscii(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

/** 展开开头的 `~`（`~` / `~/` / `~\`）；不解析 `~user` */
function expandHome(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return join(homedir(), input.slice(2));
  return input;
}

/** 去掉尾部路径分隔符，但保留根（`/`、`C:\`） */
function stripTrailingSeparators(value: string): string {
  const root = parse(value).root;
  let result = value;
  while (
    result.length > root.length &&
    (result.endsWith('/') || result.endsWith('\\')) &&
    result !== root
  ) {
    result = result.slice(0, -1);
  }
  return result;
}

/**
 * NFC 归一化：Windows / macOS 文件系统不保证返回规范化过的名字，同一个视觉等价的名字
 * （如 `caf\u00e9` 的 precomposed 与 `cafe\u0301` 的组合写法）会算出不同 basename 与哈希。
 */
function toNfc(value: string): string {
  return value.normalize('NFC');
}

/**
 * 把路径解析成「这块目录的真实身份」。
 *
 * 取舍：
 * - **存在则 `realpathSync`**：junction / symlink / 大小写 / 8.3 短名 / `..` 都会收敛到同一串，
 *   否则同一块目录会因写法不同被切成多个 team（`team_id` 是分桶键，多切一刀就是两个 team）。
 *   用 `.native` 取操作系统原生结果——JS 实现不跟随 junction。
 * - **不存在则退回普通 `resolve`**：workspace 允许指向还没建的目录（`ensureForWorkspace`
 *   不要求目录存在），此时没有真实身份可查，只能按字面路径算；等目录建好后再次调用会
 *   收敛到真实路径，属已接受的取舍（首次调用者拿到的是字面 slug）。
 * - **失败也退回普通 `resolve`**：权限 / 路径非法 / 非法 UTF-16 等 `realpath` 抛错的场景，
 *   归一化不应当把调用方打断（这些函数的调用方遍布 store 的启动与读路径）。
 * - 前缀 `\\?\` 由 `realpathSync.native` 去掉，长路径写法与普通写法因此收敛。
 */
function resolveIdentity(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    return value;
  }
}

/**
 * 归一化 workspace：trim、展开 `~`、`path.resolve`、解析真实路径、NFC、去尾分隔符。
 * 不需要目录存在（不存在时按字面路径算）。空输入抛错。
 *
 * 顺序要点：先 `resolve` 消掉 `..` 与相对段，再 `realpath`（`\\?\` 前缀下 `..` 不被解析，
 * 必须先用普通 `resolve`）；`realpath` 之后再 NFC，最后才去掉尾分隔符——`realpath` 对根目录
 * 会返回 `C:\`，去尾必须放在它之后。
 */
export function normalizeWorkspace(input: string): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('invalid_workspace: workspace must be a non-empty string');
  }
  const absolute = resolve(expandHome(input.trim()));
  return stripTrailingSeparators(toNfc(resolveIdentity(absolute)));
}

/**
 * 比较键：归一化后的精确路径；Windows 上再小写。
 * 只用于相等比较，不用于存储 / 展示。
 */
export function workspaceKey(workspace: string): string {
  const normalized = normalizeWorkspace(workspace);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * workspace basename -> `team_id` 基础 slug。
 *
 * 小写、非 `[a-z0-9-]` 折叠为 `-`、去首尾 `-`、最长 32；
 * 数字开头加 `team-` 前缀；空 basename 或非 ASCII basename 用 `team-<6hex>` 兜底。
 */
export function slugifyWorkspace(workspace: string): string {
  const normalized = normalizeWorkspace(workspace);
  const base = basename(normalized);
  // 非 ASCII 或空 basename（根目录）无法得到可读 slug：用确定性短哈希兜底。
  if (base === '' || !isPrintableAscii(base)) {
    return `team-${sha256(normalized).slice(0, 6)}`;
  }
  let slug = base
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length > MAX_TEAM_SLUG_LENGTH) {
    slug = slug.slice(0, MAX_TEAM_SLUG_LENGTH).replace(/-+$/g, '');
  }
  if (slug === '') return `team-${sha256(normalized).slice(0, 6)}`;
  return /^[0-9]/.test(slug) ? `team-${slug}` : slug;
}

function sameWorkspace(owner: string, key: string): boolean {
  try {
    return workspaceKey(owner) === key;
  } catch {
    return false;
  }
}

/**
 * 生成 `team_id`：
 * - 基础 slug 未被占用 → 直接用；
 * - 已被**同一** workspace 占用 → 复用；
 * - 已被**不同** workspace 占用 → 追加 `-<sha256(workspace) 前 8 位>`，绝不合并。
 *
 * `taken(id)` 返回该 id 当前所属的 workspace（没有则 undefined）。
 */
export function teamIdForWorkspace(
  workspace: string,
  taken?: (id: string) => string | undefined,
): string {
  const normalized = normalizeWorkspace(workspace);
  const key = workspaceKey(normalized);
  const base = slugifyWorkspace(normalized);
  const baseOwner = taken?.(base);
  if (baseOwner === undefined || sameWorkspace(baseOwner, key)) return base;

  const suffixed = `${base}-${sha256(normalized).slice(0, 8)}`;
  const suffixedOwner = taken?.(suffixed);
  if (suffixedOwner === undefined || sameWorkspace(suffixedOwner, key)) return suffixed;
  // 同一 workspace 的哈希后缀被别的 workspace 占用：理论上不可达（同 hash 前缀），
  // 也绝不合并——由上层 persist 的 mkdir/写覆盖前再拒绝。
  return suffixed;
}
