/**
 * Create Team 弹窗（canonical `teams.create`）。
 *
 * 选择节点 + workspace + 名称 + policy；复用 NodeProvider 的 `teamControl`，
 * 额外节点走各自的 sessionStorage 人类 token。创建成功后由调用方刷新列表。
 */
import { type FormEvent, useState } from 'react';
import { ModalShell } from '../../components/Modal';
import { useToast } from '../../components/ToastProvider';
import { type NodeView, useNodes } from '../../gateway/NodeProvider';
import { nodeKeyOf } from '../../gateway/nodes';
import type { TeamCreateInput, TeamSummary } from '../../gateway/types';
import { t, useLocale } from '../../i18n';
import { useNodeNames } from '../nodes/useNodeNames';
import { parsePolicyText, trimmedOrUndefined } from './team-form';

export interface TeamFormDialogProps {
  nodes: readonly NodeView[];
  initialNodeKey?: string;
  onClose: () => void;
  onSaved: (team: TeamSummary) => void;
}

export function TeamFormDialog({ nodes, initialNodeKey, onClose, onSaved }: TeamFormDialogProps) {
  useLocale();
  const toast = useToast();
  const { teamControl } = useNodes();
  const nodeNames = useNodeNames();
  const preferredKey =
    initialNodeKey !== undefined && nodes.some((item) => nodeKeyOf(item) === initialNodeKey)
      ? initialNodeKey
      : undefined;
  const [nodeKey, setNodeKey] = useState(preferredKey ?? (nodes[0] ? nodeKeyOf(nodes[0]) : ''));
  const [workspace, setWorkspace] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [defaultPrincipal, setDefaultPrincipal] = useState('');
  const [handoffPath, setHandoffPath] = useState('');
  const [policy, setPolicy] = useState('{}');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const node = nodes.find((item) => nodeKeyOf(item) === nodeKey);
  const title = t('team.form.createTitle');

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !node) return;
    setError(null);

    const workspaceValue = workspace.trim();
    if (workspaceValue === '') {
      setError(t('team.form.required'));
      return;
    }
    const parsedPolicy = parsePolicyText(policy);
    if (!parsedPolicy.ok) {
      setError(t('teams.form.policyInvalid'));
      return;
    }

    const input: TeamCreateInput = { workspace: workspaceValue };
    const nameValue = trimmedOrUndefined(name);
    const descriptionValue = trimmedOrUndefined(description);
    const principalValue = trimmedOrUndefined(defaultPrincipal);
    const handoffValue = trimmedOrUndefined(handoffPath);
    if (nameValue !== undefined) input.name = nameValue;
    if (descriptionValue !== undefined) input.description = descriptionValue;
    if (principalValue !== undefined) input.default_principal = principalValue;
    if (handoffValue !== undefined) input.handoff_path = handoffValue;
    if (parsedPolicy.value !== undefined) input.policy = parsedPolicy.value;

    setBusy(true);
    try {
      const saved = await teamControl(node).createTeam(input);
      toast.success(`${title}: ${saved.name || saved.team_id}`);
      onSaved(saved);
      onClose();
    } catch (caught) {
      const code = (caught as { code?: unknown }).code;
      if (code === 'forbidden') {
        setError(t('team.form.forbidden'));
      } else {
        const message = caught instanceof Error ? caught.message : String(caught);
        setError(`${t('team.form.createFailed')}: ${message}`);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      label={title}
      onClose={() => {
        if (!busy) onClose();
      }}
      closeOnBackdrop={!busy}
      closeLabel={t('common.close')}
    >
      <h2 className="modal-title">{title}</h2>
      <form className="team-form" onSubmit={submit}>
        <div className="form-grid">
          <label className="field">
            <span className="field-label">{t('teams.filter.node')}</span>
            <select
              className="input"
              value={nodeKey}
              onChange={(event) => setNodeKey(event.target.value)}
              aria-label={t('teams.filter.node')}
            >
              {nodes.map((item) => (
                <option key={nodeKeyOf(item)} value={nodeKeyOf(item)}>
                  {nodeNames.get(nodeKeyOf(item)) ?? '—'}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="field-label">{t('team.form.workspace')}</span>
            <input
              className={`input ${error === t('team.form.required') ? 'invalid' : ''}`.trim()}
              value={workspace}
              onChange={(event) => setWorkspace(event.target.value)}
              placeholder="/absolute/workspace"
              spellCheck={false}
              autoComplete="off"
              required
              aria-invalid={error === t('team.form.required') ? true : undefined}
            />
            <span className="field-hint">{t('team.form.workspaceHint')}</span>
          </label>

          <label className="field">
            <span className="field-label">{t('team.form.name')}</span>
            <input
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </label>

          <label className="field">
            <span className="field-label">{t('team.form.description')}</span>
            <textarea
              className="input"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={2}
            />
          </label>

          <label className="field">
            <span className="field-label">{t('team.form.defaultPrincipal')}</span>
            <input
              className="input"
              value={defaultPrincipal}
              onChange={(event) => setDefaultPrincipal(event.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
            <span className="field-hint">{t('team.form.defaultPrincipalHint')}</span>
          </label>

          <label className="field">
            <span className="field-label">{t('team.form.handoffPath')}</span>
            <input
              className="input"
              value={handoffPath}
              onChange={(event) => setHandoffPath(event.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </label>

          <label className="field field-wide">
            <span className="field-label">{t('teams.form.policy')}</span>
            <textarea
              className="input mono team-policy-input"
              value={policy}
              onChange={(event) => setPolicy(event.target.value)}
              rows={4}
              spellCheck={false}
            />
            <span className="field-hint">{t('teams.form.policyHint')}</span>
          </label>
        </div>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !node}>
            {busy ? t('common.processing') : t('team.form.submitCreate')}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
