/**
 * Gateway 静态资源响应 — 不持有 startGateway 闭包。
 *
 * @module @vessel-agent/serve/gateway/static
 */

import { extname, resolve, sep } from 'node:path';

/**
 * 解析静态目录内的目标路径。
 * 返回 null 表示 URL 解码失败；越界检查由调用方完成。
 */
export function resolveStaticPath(root: string, pathname: string): string | null {
  let relative = pathname;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  relative = relative.replace(/^\/+/, '');
  return resolve(root, relative || 'index.html');
}

/** 静态资源响应（同源托管 apps/web/dist） */
export async function serveStatic(
  pathname: string,
  staticDir: string | undefined,
): Promise<Response | null> {
  if (!staticDir) return null;
  const root = resolve(staticDir);
  const target = resolveStaticPath(root, pathname);
  if (target === null) return null;
  if (target !== root && !target.startsWith(root + sep)) {
    return new Response('Forbidden', { status: 403 });
  }
  const file = Bun.file(target);
  if (await file.exists()) {
    const stat = await file.stat();
    if (!stat.isDirectory()) return fileResponse(file, target);
  }
  if (!extname(target)) {
    const index = Bun.file(resolve(root, 'index.html'));
    if (await index.exists()) return fileResponse(index, resolve(root, 'index.html'));
  }
  return null;
}

/**
 * 内容哈希文件名（Vite 产物 `name-HASH.ext`，HASH ≥8 位 base64url）。
 * 只有文件名自带内容哈希的资产才配 immutable 一年缓存；publicDir 直拷的
 * 无哈希资产（/Vessel.svg、/favicon.ico、/apple-touch-icon.png 等）内容随
 * 版本变化，immutable 会让存量浏览器升级后永远拿旧 icon（q-icon-cache-hash），
 * 必须降档为可再验证。
 */
const HASHED_ASSET_PATTERN = /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;

export function fileResponse(file: Bun.BunFile, path: string): Response {
  const isHtml = path.toLowerCase().endsWith('.html');
  const immutable = !isHtml && HASHED_ASSET_PATTERN.test(path);
  const headers: Record<string, string> = {
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  };
  return new Response(file, { headers });
}
