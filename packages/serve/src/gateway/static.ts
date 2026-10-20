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

export function fileResponse(file: Bun.BunFile, path: string): Response {
  const isHtml = path.toLowerCase().endsWith('.html');
  const headers: Record<string, string> = {
    'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  };
  return new Response(file, { headers });
}
