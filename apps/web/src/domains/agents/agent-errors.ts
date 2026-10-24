/** Agent CRUD 错误映射：稳定 code 优先，其它保留服务端 message。 */
import { t } from '../../i18n';

export function agentErrorText(error: unknown, fallbackKey: string): string {
  const code = (error as { code?: unknown }).code;
  if (code === 'forbidden') return t('agents.error.forbidden');
  if (code === 'not_found') return t('agents.error.notFound');
  const message = error instanceof Error ? error.message : String(error);
  return `${t(fallbackKey)}: ${message}`;
}
