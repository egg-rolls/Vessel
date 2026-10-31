import { CommandPalette } from '../components/CommandPalette';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ModalShell } from '../components/Modal';
import { Button } from '../components/ui';
import { t } from '../i18n';
import type { PaletteItem } from '../state/palette';

/** 外壳级浮层：命令面板、帮助、破坏性动作二次确认。 */
export function ShellOverlays({
  paletteOpen,
  paletteItems,
  entities,
  paletteQuery,
  onClosePalette,
  onExecutePalette,
  helpOpen,
  onCloseHelp,
  pendingAction,
  onClearPending,
  onConfirmPending,
}: {
  paletteOpen: boolean;
  paletteItems: PaletteItem[];
  entities: PaletteItem[];
  paletteQuery: string;
  onClosePalette: () => void;
  onExecutePalette: (item: PaletteItem) => void;
  helpOpen: boolean;
  onCloseHelp: () => void;
  pendingAction: PaletteItem | null;
  onClearPending: () => void;
  onConfirmPending: () => void;
}) {
  return (
    <>
      {paletteOpen && (
        <CommandPalette
          items={paletteItems}
          entities={entities}
          initialQuery={paletteQuery}
          onClose={onClosePalette}
          onExecute={onExecutePalette}
        />
      )}

      {helpOpen && (
        <ModalShell label={t('app.help.title')} onClose={onCloseHelp}>
          <h2 className="modal-title">{t('app.help.title')}</h2>
          <dl className="shortcut-list">
            <dt>
              <kbd className="kbd">Ctrl/Cmd</kbd> + <kbd className="kbd">K</kbd>
            </dt>
            <dd>{t('app.help.openClose')}</dd>
            <dt>
              <kbd className="kbd">/</kbd>
            </dt>
            <dd>{t('app.help.actionMode')}</dd>
            <dt>
              <kbd className="kbd">↑</kbd> / <kbd className="kbd">↓</kbd>
            </dt>
            <dd>{t('app.help.move')}</dd>
            <dt>
              <kbd className="kbd">Enter</kbd>
            </dt>
            <dd>{t('app.help.execute')}</dd>
            <dt>
              <kbd className="kbd">Esc</kbd>
            </dt>
            <dd>{t('app.help.close')}</dd>
          </dl>
          <div className="modal-actions">
            <Button variant="primary" data-autofocus onClick={onCloseHelp}>
              {t('common.close')}
            </Button>
          </div>
        </ModalShell>
      )}

      {pendingAction?.confirm && (
        <ConfirmDialog
          title={pendingAction.confirm.title}
          body={<p>{pendingAction.confirm.body}</p>}
          confirmLabel={pendingAction.confirm.confirmLabel}
          danger
          onConfirm={onConfirmPending}
          onCancel={onClearPending}
        />
      )}
    </>
  );
}
