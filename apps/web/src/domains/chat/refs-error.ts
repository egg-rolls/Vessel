/**
 * `runs.start` 的引用拒绝 → 面向用户的文案（0.52）。
 *
 * 服务端只返回结构（`invalid_params` + `details.reason` + `details.path`），
 * 文案在 Web 侧按 reason 选 i18n key：同一条拒绝在 CLI / TUI 上不需要一句人话，
 * 而人看到的必须是「哪个路径、为什么」。
 *
 * 本版本只有 `refs_invalid`（形状：非绝对路径 / 超长 / 超条数）：路径边界
 *（deny 目录 / `allowed_roots`）**不在加引用时判**，改到模型读文件那一刻。
 * `refs_denied` / `refs_outside_roots` 两个分支留着只为兼容旧 gateway 的响应，
 * 当前服务端不会再发（对应的 i18n key 也还在，删 key 走 1 的裁决）。
 */
import { t } from '../../i18n';

const REFS_REASONS = new Set(['refs_invalid', 'refs_denied', 'refs_outside_roots']);

/** 从错误对象上取引用拒绝的结构化信息（HTTP RPC 与 WS `res` 都可能携带）。 */
function refsReasonOf(error: unknown): { reason: string; path?: string } | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  if (code !== 'invalid_params') return null;
  const details = (error as { details?: unknown }).details;
  if (typeof details !== 'object' || details === null) return null;
  const reason = (details as { reason?: unknown }).reason;
  if (typeof reason !== 'string' || !REFS_REASONS.has(reason)) return null;
  const path = (details as { path?: unknown }).path;
  return typeof path === 'string' ? { reason, path } : { reason };
}

/** 拒绝原因 → 文案；不是引用拒绝时返回 `null`（调用方回退到原始错误）。 */
export function refsErrorText(error: unknown): string | null {
  const rejection = refsReasonOf(error);
  if (rejection === null) return null;
  const name = rejection.path ?? '';
  switch (rejection.reason) {
    case 'refs_denied':
      return t('chat.refs.reject.denied', { name });
    case 'refs_outside_roots':
      return t('chat.refs.reject.outside', { name });
    default:
      return t('chat.refs.reject.invalid', { name });
  }
}
