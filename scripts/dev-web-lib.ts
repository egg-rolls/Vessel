/**
 * `dev:web` 的纯函数（DX2，PLAN-0.18-dev-dx §4.2）。
 *
 * relay 只做一件事：浏览器首帧 `{kind:'auth'}` 里的占位 token 换成真实 token。
 * 其余帧（req/pong/二进制）必须逐字节透传，不能重新序列化。
 *
 * @module vessel/scripts/dev-web-lib
 */

/** Vite → relay 的本机鉴权头（每次运行随机 secret，绝不写入 URL） */
export const DEV_RELAY_HEADER = 'x-vessel-dev-relay';

/** 允许使用 dev relay 的页面 Origin（固定 Vite 端口，仅回环） */
export const DEV_WEB_ORIGINS = [
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://[::1]:5173',
] as const;

/**
 * relay 的浏览器来源校验：无 Origin（curl / 本机进程）放行；
 * 有 Origin 时必须来自 Vite dev server，防止任意网页借用代理的 token。
 */
export function isAllowedDevOrigin(origin: string | null): boolean {
  if (origin === null) return true;
  return (DEV_WEB_ORIGINS as readonly string[]).includes(origin.toLowerCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 仅替换 `{kind:'auth'}` 帧的 `token` 字段；保留 `v`/`since`/`tenant_id` 等其余字段。
 * 非法 JSON、非对象、非 auth 帧原样返回（调用方负责原样转发）。
 */
export function injectTokenIntoAuthFrame(raw: string, token: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!isRecord(parsed) || parsed.kind !== 'auth') return raw;
  return JSON.stringify({ ...parsed, token });
}
