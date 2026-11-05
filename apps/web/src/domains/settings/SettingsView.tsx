/** Settings 顶层页（0.45 IA）：只保留配置视图，其余入口拆到独立路由。 */
import { t, useLocale } from '../../i18n';
import { ConfigView } from './ConfigView';
import { PageFrame } from './PageFrame';

export function SettingsView() {
  useLocale();
  return (
    <PageFrame title={t('settings.title')}>
      <ConfigView />
    </PageFrame>
  );
}
