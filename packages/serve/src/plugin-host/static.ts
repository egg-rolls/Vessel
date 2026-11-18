/**
 * plugin UI 静态路由 `/plugins/<id>/<entry>`（CONTRACT-0.43 §2.1 / §7）。
 *
 * realpath containment：先 realpath 根目录，再 realpath 目标；目标必须仍在
 * 根目录内（防 symlink 逃逸）。拒绝 `.` / `..` / 反斜杠 / 空段；未知 plugin
 * 或未知 entry 一律 404，不回落主 Web 的 index.html。
 *
 * plugin-embed 契约 §4：`/plugins/<id>/ui/<path>` 是 embed 静态命名空间，
 * parsePath 剥掉首段 `ui` 后服务 `uiDir/<path>`；`ui` 段对 contributes.http
 * 保留（manifest 校验），动态路由不会遮蔽这里。
 *
 * @module @vessel-agent/serve/plugin-host
 */

import { realpath } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { PLUGIN_ID_PATTERN } from './registry.js';
import type { PluginStaticMount } from './types.js';

/** contract §7 的 iframe CSP（HTML 响应头） */
export const PLUGIN_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:";

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

/** 单个路径段是否安全（不允许编码后的分隔符 / 目录穿越）。 */
function isSafeSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment !== '.' &&
    segment !== '..' &&
    !segment.includes('\\') &&
    !segment.includes('/') &&
    !segment.includes('\0')
  );
}

function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

function parsePath(pathname: string): { id: string; segments: string[] } | null {
  if (!pathname.startsWith('/plugins/')) return null;
  const raw = pathname.slice('/plugins/'.length);
  const parts = raw.split('/');
  const rawId = parts.shift();
  if (rawId === undefined || rawId.length === 0) return null;
  let id: string;
  let segments: string[];
  try {
    id = decodeURIComponent(rawId);
    segments = parts.map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
  if (!PLUGIN_ID_PATTERN.test(id)) return null;
  if (segments.length === 0) return { id, segments: ['index.html'] };
  // `/plugins/<id>/` → index.html
  if (segments.length === 1 && segments[0] === '') return { id, segments: ['index.html'] };
  if (segments.some((segment) => segment === '')) return null;
  if (!segments.every(isSafeSegment)) return null;
  // plugin-embed 契约 §4：`/plugins/<id>/ui/<path>` → `uiDir/<path>`。
  // 只剥首段 `ui`（`/plugins/<id>/ui` 本身仍是 iframe 命名空间的普通文件路径）。
  if (segments.length > 1 && segments[0] === 'ui') return { id, segments: segments.slice(1) };
  return { id, segments };
}

/**
 * 缓存头（plugin-embed 契约 §5）：HTML no-cache + PLUGIN_CSP；embed 入口 /
 * CSS no-cache（入口必须带 `?v=<hash>` 加载，双保险）；其余非 HTML 保持
 * immutable（chunk 文件名带哈希）。
 */
function headersFor(
  path: string,
  relativePath: string,
  mount: PluginStaticMount,
): Record<string, string> {
  const extension = extname(path).toLowerCase();
  const contentType = MIME[extension] ?? 'application/octet-stream';
  const isHtml = extension === '.html' || extension === '.htm';
  const isEmbedEntry =
    relativePath === mount.embedEntry ||
    (mount.embedCss !== undefined && relativePath === mount.embedCss);
  return {
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': isHtml || isEmbedEntry ? 'no-cache' : 'public, max-age=31536000, immutable',
    ...(isHtml ? { 'Content-Security-Policy': PLUGIN_CSP } : {}),
  };
}

/** 静态路由里的 plugin id；非法路径 / 越界段 → null。 */
export function pluginStaticId(pathname: string): string | null {
  return parsePath(pathname)?.id ?? null;
}

/**
 * 返回静态响应；`null` = 非 plugin 路由或未知 plugin / entry（由 gateway 404）。
 * 调用方应先判断 `pathname.startsWith('/plugins/')`。
 */
export async function servePluginAsset(
  pathname: string,
  mounts: readonly PluginStaticMount[],
): Promise<Response | null> {
  const parsed = parsePath(pathname);
  if (parsed === null) return null;
  const mount = mounts.find((item) => item.id === parsed.id);
  if (mount === undefined) return null;

  let root: string;
  try {
    root = await realpath(mount.uiDir);
  } catch {
    return null;
  }
  const target = resolve(root, ...parsed.segments);
  if (!isWithin(root, target)) return null;

  let resolvedTarget: string;
  try {
    resolvedTarget = await realpath(target);
  } catch {
    return null;
  }
  if (!isWithin(root, resolvedTarget)) return null;

  const file = Bun.file(resolvedTarget);
  let isDirectory: boolean;
  try {
    if (!(await file.exists())) return null;
    isDirectory = (await file.stat()).isDirectory();
  } catch {
    return null;
  }
  if (isDirectory) return null;
  // 相对 uiDir realpath 根的路径（`/` 分隔）；与 mount 的 embedEntry/embedCss 比对。
  const relativePath = resolvedTarget
    .slice(root.length + 1)
    .split(sep)
    .join('/');
  return new Response(file, { headers: headersFor(resolvedTarget, relativePath, mount) });
}
