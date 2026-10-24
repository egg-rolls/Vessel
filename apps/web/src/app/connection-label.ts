import { t } from '../i18n';

/** gateway 连接状态 → 统一文案（AppBar 与 Gateway 页共用）。 */
export function connectionLabel(state: string): string {
  switch (state) {
    case 'open':
      return t('nav.conn.online');
    case 'connecting':
      return t('nav.conn.connecting');
    case 'reconnecting':
      return t('nav.conn.reconnecting');
    case 'closed':
      return t('nav.conn.closed');
    case 'error':
      return t('nav.conn.error');
    default:
      return t('nav.conn.idle');
  }
}
