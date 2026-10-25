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
import { Button, Field, Input } from '../../components/ui';
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
    <ModalShell label={t('hub.add.title')} onClose={onClose} closeLabel={t('common.close')}>
      <h2 className="modal-title">{t('hub.add.title')}</h2>
      <p className="mt-2 max-w-prose text-md leading-relaxed text-muted">
        {t('hub.add.description')}
      </p>

      <section className="mt-5 flex flex-col gap-2" aria-label={t('nodes.add.commands')}>
        <h3 className="m-0 text-sm font-semibold text-ink">{t('nodes.add.commands')}</h3>
        <ul className="net-commands">
          {ADD_COMMANDS.map((row) => (
            <li className="net-command" key={row.id}>
              <span className="net-command-label">{row.label ? t(row.label) : ''}</span>
              <code className="net-command-text font-mono">{t(row.command)}</code>
              <CopyButton
                text={t(row.command)}
                label={t('common.copy')}
                toast={t('common.copied')}
              />
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-5 flex flex-col gap-2" aria-label={t('nodes.add.connect')}>
        <h3 className="m-0 text-sm font-semibold text-ink">{t('nodes.add.connect')}</h3>
        <form className="form-grid mt-0" onSubmit={submit}>
          <Field label={t('settings.multinode.name')} htmlFor="add-node-name">
            <Input
              id="add-node-name"
              invalid={error === 'name_required' || error === 'name_duplicate'}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
              placeholder={t('settings.multinode.namePlaceholder')}
              spellCheck={false}
              autoComplete="off"
            />
          </Field>
          <Field label={t('settings.multinode.url')} htmlFor="add-node-url">
            <Input
              id="add-node-url"
              invalid={error === 'url_invalid'}
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                setError(null);
              }}
              placeholder={t('settings.multinode.urlPlaceholder')}
              spellCheck={false}
              autoComplete="off"
            />
          </Field>
          <Field
            label={t('settings.multinode.token')}
            htmlFor="add-node-token"
            hint={t('settings.multinode.storageHint')}
          >
            <Input
              id="add-node-token"
              invalid={error === 'token_required'}
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
          </Field>
          <div className="form-actions col-span-full justify-end mt-0">
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" variant="primary" disabled={!name.trim() || !token.trim()}>
              {t('settings.multinode.add')}
            </Button>
          </div>
        </form>
        {error && (
          <p className="text-xs text-danger leading-snug" role="alert">
            {t(`settings.multinode.error.${error}`)}
          </p>
        )}
      </section>
    </ModalShell>
  );
}
