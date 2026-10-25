/**
 * Create Team 弹窗（canonical `teams.create`）。
 *
 * 选择节点 + workspace + 名称 + policy；复用 NodeProvider 的 `teamControl`，
 * 额外节点走各自的 sessionStorage 人类 token。创建成功后由调用方刷新列表。
 */
import { type FormEvent, useState } from 'react';
import { ModalShell } from '../../components/Modal';
import { useToast } from '../../components/ToastProvider';
import { Button, Field, Input, Select, Textarea } from '../../components/ui';
import { type NodeView, useNodes } from '../../gateway/NodeProvider';
import { nodeKeyOf } from '../../gateway/nodes';
import type { TeamCreateInput, TeamSummary } from '../../gateway/types';
import { t, useLocale } from '../../i18n';
import { useNodeNames } from '../nodes/useNodeNames';
import { TeamPolicyFields } from './TeamPolicyFields';
import { trimmedOrUndefined } from './team-form';
import {
  buildPolicy,
  emptyPolicyForm,
  type PolicyErrorField,
  type PolicyErrors,
  type PolicyFormState,
} from './team-policy-form';

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
  const [policyForm, setPolicyForm] = useState<PolicyFormState>(emptyPolicyForm);
  const [policyErrors, setPolicyErrors] = useState<PolicyErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const updatePolicy = (patch: Partial<PolicyFormState>) => {
    setPolicyForm((current) => ({ ...current, ...patch }));
    setPolicyErrors((current) => {
      const next = { ...current };
      for (const key of Object.keys(patch)) delete next[key as PolicyErrorField];
      return next;
    });
  };

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
    const builtPolicy = buildPolicy(undefined, policyForm);
    if (!builtPolicy.ok) {
      setPolicyErrors(builtPolicy.errors);
      return;
    }
    setPolicyErrors({});

    const input: TeamCreateInput = { workspace: workspaceValue };
    const nameValue = trimmedOrUndefined(name);
    const descriptionValue = trimmedOrUndefined(description);
    if (nameValue !== undefined) input.name = nameValue;
    if (descriptionValue !== undefined) input.description = descriptionValue;
    if (Object.keys(builtPolicy.policy).length > 0) input.policy = builtPolicy.policy;

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
      <form className="flex flex-col gap-2" onSubmit={submit}>
        <div className="form-grid mt-1">
          <Field label={t('teams.filter.node')} htmlFor="team-create-node">
            <Select
              id="team-create-node"
              value={nodeKey}
              onChange={(event) => setNodeKey(event.target.value)}
              aria-label={t('teams.filter.node')}
            >
              {nodes.map((item) => (
                <option key={nodeKeyOf(item)} value={nodeKeyOf(item)}>
                  {nodeNames.get(nodeKeyOf(item)) ?? '—'}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label={t('team.form.workspace')}
            htmlFor="team-create-workspace"
            hint={t('team.form.workspaceHint')}
          >
            <Input
              id="team-create-workspace"
              invalid={error === t('team.form.required')}
              value={workspace}
              onChange={(event) => setWorkspace(event.target.value)}
              placeholder="/absolute/workspace"
              spellCheck={false}
              autoComplete="off"
              required
            />
          </Field>

          <Field label={t('team.form.name')} htmlFor="team-create-name">
            <Input
              id="team-create-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </Field>

          <Field label={t('team.form.description')} htmlFor="team-create-description">
            <Textarea
              id="team-create-description"
              className="min-h-16 resize-y font-sans"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={2}
            />
          </Field>

          <TeamPolicyFields
            idPrefix="team-create"
            form={policyForm}
            errors={policyErrors}
            onChange={updatePolicy}
          />
        </div>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <div className="modal-actions">
          <Button type="button" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !node}>
            {busy ? t('common.processing') : t('team.form.submitCreate')}
          </Button>
        </div>
      </form>
    </ModalShell>
  );
}
