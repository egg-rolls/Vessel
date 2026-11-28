/** Agent CRUD 错误映射：稳定 code 优先，其它保留服务端 message。
 * q-error-e3（§3.9）：details.candidates 存在时追加「你是不是想选 X」（既有文本位）。 */
import { t } from '../../i18n';

/** 从错误对象读 details.candidates（只收非空字符串）。 */
function candidatesOf(error: unknown): string[] {
  if (typeof error !== 'object' || error === null) return [];
  const details = (error as { details?: unknown }).details;
  if (typeof details !== 'object' || details === null) return [];
  const candidates = (details as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return [];
  return candidates.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

export function agentErrorText(error: unknown, fallbackKey: string): string {
  const code = (error as { code?: unknown }).code;
  let text: string;
  if (code === 'forbidden') text = t('agents.error.forbidden');
  else if (code === 'not_found') text = t('agents.error.notFound');
  else {
    const message = error instanceof Error ? error.message : String(error);
    text = `${t(fallbackKey)}: ${message}`;
  }
  const candidates = candidatesOf(error);
  if (candidates.length > 0) {
    text += ` ${t('agents.error.candidates', { list: candidates.join(', ') })}`;
  }
  return text;
}
