/**
 * 设计实验室 = view 型设置项（vscode-settings-design §5.2，S2）。
 *
 * 视觉分类内可折叠区块：展开时懒加载 DesignLabContent（token + 预览），
 * 内部独立滚动（max-h 60dvh）；[全屏打开] → 嵌套 ModalShell lg。
 *
 * R11 嵌套 Esc：两层 useModalA11y 都监听 document keydown（bubble），一次 Esc
 * 会关两层。全屏期间本组件挂 **capture 阶段** Esc 监听 + stopImmediatePropagation，
 * 只关全屏层；焦点圈由最上层 ModalShell 自己维护。
 */
import { lazy, Suspense, useEffect, useState } from 'react';
import { ModalShell } from '../../../components/Modal';
import { LoadingState } from '../../../components/States';
import { Button } from '../../../components/ui';
import { t } from '../../../i18n';

const LazyContent = lazy(() =>
  import('../../design/DesignLabContent').then((module) => ({ default: module.DesignLabContent })),
);

export function DesignLabSection({ defaultExpanded = false }: { defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!fullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopImmediatePropagation();
      setFullscreen(false);
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [fullscreen]);

  const content = (
    <Suspense fallback={<LoadingState label={t('settings.dialog.loading')} />}>
      <LazyContent />
    </Suspense>
  );

  return (
    <div className="flex flex-col gap-2 rounded-sm border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{t('settings.item.view.designLab.title')}</span>
        <Button variant="link" className="text-sm" onClick={() => setExpanded((value) => !value)}>
          {expanded ? t('common.collapse') : t('common.expand')}
        </Button>
        <Button variant="link" className="ml-auto text-sm" onClick={() => setFullscreen(true)}>
          {t('settings.dialog.fullscreen')} →
        </Button>
      </div>
      {expanded && (
        <div className="max-h-[60dvh] overflow-y-auto overscroll-contain">{content}</div>
      )}
      {fullscreen && (
        <ModalShell
          size="lg"
          label={t('designLab.title')}
          closeLabel={t('common.close')}
          onClose={() => setFullscreen(false)}
          className="h-[min(86dvh,var(--modal-max-h))]"
          bodyClassName="grow overflow-hidden"
        >
          <div className="min-h-0 grow overflow-y-auto overscroll-contain">{content}</div>
        </ModalShell>
      )}
    </div>
  );
}
