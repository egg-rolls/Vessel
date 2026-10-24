/**
 * Add node 弹窗：终端配对 / 加入命令 + 从浏览器连接额外节点。
 *
 * 命令块从 Hub 页移入；Web 只展示 hub 命令，不代管 hub token。
 * 额外节点的元数据与 token 走 NodeProvider → sessionStorage（token 不回显）。
 */
import { type FormEvent, useState } from 'react';
import { CopyButton } from '../../components/CopyButton';
import { ModalShell } from '../../components/Modal';
import { useToast } from '../../components/ToastProvider';
import { useNodes } from '../../gateway/NodeProvider';
import type { NodeDraftError } from '../../gateway/nodes';
import { t, useLocale } from '../../i18n';

/** 与 Hub 页一致的终端命令；第 4 组本身就是命令，不重复标签。 */
const ADD_COMMANDS: readonly { id: string; label?: string; command: string }[] = [
  { id: 'pair', label: 'hub.add.pairNode', command: 'hub.add.pairCommand' },
  { id: 'add', label: 'hub.add.addToHub', command: 'hub.add.addCommand' },
  { id: 'join-code', label: 'hub.add.joinCode', command: 'hub.add.joinCodeCommand' },
  { id: 'join', command: 'hub.add.joinCommand' },
];

export function AddNodeDialog({ onClose }: { onClose: () => void }) {
  useLocale();
  const toast = useToast();
  const { addNode } = useNodes();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<NodeDraftError | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = addNode({ name, url, token });
    if (!result.ok) {
      setError(result.error ?? null);
      return;
    }
    toast.info(t('settings.multinode.added', { name: name.trim() }));
    onClose();
  };

  return (
    <ModalShell
      label={t('hub.add.title')}
      onClose={onClose}
      closeLabel={t('common.close')}
      className="add-node-dialog"
    >
      <h2 className="modal-title">{t('hub.add.title')}</h2>
      <p className="section-desc">{t('hub.add.description')}</p>

      <section className="add-node-section" aria-label={t('nodes.add.commands')}>
        <h3 className="add-node-section-title">{t('nodes.add.commands')}</h3>
        <ul className="net-commands">
          {ADD_COMMANDS.map((row) => (
            <li className="net-command" key={row.id}>
              <span className="net-command-label">{row.label ? t(row.label) : ''}</span>
              <code className="net-command-text mono">{t(row.command)}</code>
              <CopyButton
                text={t(row.command)}
                label={t('common.copy')}
                toast={t('common.copied')}
              />
            </li>
          ))}
        </ul>
      </section>

      <section className="add-node-section" aria-label={t('nodes.add.connect')}>
        <h3 className="add-node-section-title">{t('nodes.add.connect')}</h3>
        <form className="form-grid" onSubmit={submit}>
          <label className="field">
            <span className="field-label">{t('settings.multinode.name')}</span>
            <input
              className={`input ${
                error === 'name_required' || error === 'name_duplicate' ? 'invalid' : ''
              }`.trim()}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
              placeholder={t('settings.multinode.namePlaceholder')}
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <label className="field">
            <span className="field-label">{t('settings.multinode.url')}</span>
            <input
              className={`input ${error === 'url_invalid' ? 'invalid' : ''}`.trim()}
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                setError(null);
              }}
              placeholder={t('settings.multinode.urlPlaceholder')}
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <label className="field">
            <span className="field-label">{t('settings.multinode.token')}</span>
            <input
              className={`input ${error === 'token_required' ? 'invalid' : ''}`.trim()}
              type="password"
              value={token}
              onChange={(event) => {
                setToken(event.target.value);
                setError(null);
              }}
              placeholder={t('settings.multinode.tokenPlaceholder')}
              spellCheck={false}
              autoComplete="new-password"
            />
            <span className="field-hint">{t('settings.multinode.storageHint')}</span>
          </label>
          <div className="form-actions add-node-actions">
            <button type="button" className="btn" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!name.trim() || !token.trim()}
            >
              {t('settings.multinode.add')}
            </button>
          </div>
        </form>
        {error && (
          <p className="field-error" role="alert">
            {t(`settings.multinode.error.${error}`)}
          </p>
        )}
      </section>
    </ModalShell>
  );
}
