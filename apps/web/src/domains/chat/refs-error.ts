/**
 * `runs.start` 的引用拒绝 → 面向用户的文案（0.52）。
 *
 * 服务端只返回结构（`invalid_params` + `details.reason` + `details.path`），
 * 文案在 Web 侧按 reason 选 i18n key：同一条拒绝在 CLI / TUI 上不需要一句人话，
 * 而人看到的必须是「哪个路径、为什么」。
 *
 * 唯一 reason 是 `refs_invalid`（形状：非绝对路径 / 超长 / 超条数）。路径边界
 *（deny 目录 / `allowed_roots`）**不在加引用时判**，权限校验发生在模型读文件
 * 那一刻（`read` / `media` 的 `evaluatePath`），所以这里没有 denied / outside 分支。
 */
import { t } from '../../i18n';

/** 服务端会发的唯一引用拒绝 reason；其余 reason 一律当普通错误回退。 */
const REFS_INVALID = 'refs_invalid';

/** 从错误对象上取引用拒绝的结构化信息（HTTP RPC 与 WS `res` 都可能携带）。 */
function refsReasonOf(error: unknown): { reason: string; path?: string } | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  if (code !== 'invalid_params') return null;
  const details = (error as { details?: unknown }).details;
  if (typeof details !== 'object' || details === null) return null;
  const reason = (details as { reason?: unknown }).reason;
  if (typeof reason !== 'string' || reason !== REFS_INVALID) return null;
  const path = (details as { path?: unknown }).path;
  return typeof path === 'string' ? { reason, path } : { reason };
}

/** 拒绝原因 → 文案；不是引用拒绝时返回 `null`（调用方回退到原始错误）。 */
export function refsErrorText(error: unknown): string | null {
  const rejection = refsReasonOf(error);
  if (rejection === null) return null;
  return t('chat.refs.reject.invalid', { name: rejection.path ?? '' });
}
