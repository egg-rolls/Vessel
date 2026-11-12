/**
 * 破坏性动作确认（components/ConfirmDialog）：初始焦点在「取消」，Enter 不会误触发危险动作。
 * 只渲染：确认回调只关掉弹窗，不发任何请求。
 */
import { Button } from '@vessel-agent/plugin-ui';
import { useState } from 'react';
import { ConfirmDialog } from '../../../../components/ConfirmDialog';
import { t } from '../../../../i18n';
import type { PreviewMeta } from '../../preview-registry';

export const preview: PreviewMeta = {
  title: 'ConfirmDialog',
  descriptionKey: 'designLab.preview.confirm.desc',
  group: 'overlays',
  order: 10,
};

type Mode = 'plain' | 'danger' | null;

export default function ConfirmDialogPreview() {
  const [mode, setMode] = useState<Mode>(null);
  const close = () => setMode(null);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="plain" onClick={() => setMode('plain')}>
        {t('designLab.preview.confirm.openPlain')}
      </Button>
      <Button variant="danger" onClick={() => setMode('danger')}>
        {t('designLab.preview.confirm.openDanger')}
      </Button>
      {mode === 'plain' && (
        <ConfirmDialog
          title={t('designLab.preview.confirm.title')}
          body={<p className="m-0">{t('designLab.preview.confirm.body')}</p>}
          onConfirm={close}
          onCancel={close}
        />
      )}
      {mode === 'danger' && (
        <ConfirmDialog
          danger
          title={t('designLab.preview.confirm.dangerTitle')}
          body={<p className="m-0">{t('designLab.preview.confirm.dangerBody')}</p>}
          confirmLabel={t('designLab.preview.confirm.dangerConfirm')}
          onConfirm={close}
          onCancel={close}
        />
      )}
    </div>
  );
}
