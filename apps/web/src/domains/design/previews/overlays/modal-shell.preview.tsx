/**
 * 对话框壳（components/Modal）：遮罩 + 居中面板 + Esc / 焦点圈 / 滚动锁。
 * 只渲染：关闭即卸载，不触发任何业务动作。
 */
import { Button } from '@vessel-agent/plugin-ui';
import { useState } from 'react';
import { ModalShell } from '../../../../components/Modal';
import { t } from '../../../../i18n';
import type { PreviewMeta } from '../../preview-registry';

export const preview: PreviewMeta = {
  title: 'ModalShell',
  descriptionKey: 'designLab.preview.modal.desc',
  group: 'overlays',
  order: 20,
};

export default function ModalShellPreview() {
  const [open, setOpen] = useState(false);
  const [size, setSize] = useState<'sm' | 'md' | 'lg'>('md');

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="plain" onClick={() => setSize('sm')}>
        sm
      </Button>
      <Button variant="plain" onClick={() => setSize('md')}>
        md
      </Button>
      <Button variant="plain" onClick={() => setSize('lg')}>
        lg
      </Button>
      <span className="font-mono text-2xs text-faint">{t('designLab.preview.modal.hint')}</span>
      {open ? null : (
        <Button variant="primary" onClick={() => setOpen(true)}>
          {t('designLab.preview.modal.open')}
        </Button>
      )}
      {open && (
        <ModalShell
          label={t('designLab.preview.modal.title')}
          onClose={() => setOpen(false)}
          closeLabel={t('common.close')}
          size={size}
        >
          <h2 className="modal-title">{t('designLab.preview.modal.title')}</h2>
          <p className="m-0 text-md leading-relaxed text-muted">
            {t('designLab.preview.modal.body')}
          </p>
          <div className="modal-actions">
            <Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={() => setOpen(false)}>
              {t('common.confirm')}
            </Button>
          </div>
        </ModalShell>
      )}
    </div>
  );
}
