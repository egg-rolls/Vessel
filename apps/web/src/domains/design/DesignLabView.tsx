/**
 * #/designLab —— 设计实验室整页（q-design-lab-restore 恢复）。
 *
 * 页面壳只做脚手架（标题 + 滚动容器）；内容**复用** DesignLabContent
 * （token + 预览 + 组件清单），与设置弹窗视觉分区内嵌的是同一份。
 * 本视图由 ShellRouteView 懒加载，不进首屏 chunk；不连 gateway（纯静态样例）。
 */
import { PageScaffold } from '@vessel-agent/plugin-ui';
import { t } from '../../i18n';
import { DesignLabContent } from './DesignLabContent';

export function DesignLabView() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto overscroll-contain">
      <PageScaffold title={t('designLab.title')} subtitle={t('designLab.subtitle')}>
        <DesignLabContent />
      </PageScaffold>
    </div>
  );
}
