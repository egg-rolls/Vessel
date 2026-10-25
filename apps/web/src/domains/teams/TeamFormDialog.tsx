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

          <Field
            label={t('team.form.defaultPrincipal')}
            htmlFor="team-create-principal"
            hint={t('team.form.defaultPrincipalHint')}
          >
            <Input
              id="team-create-principal"
              value={defaultPrincipal}
              onChange={(event) => setDefaultPrincipal(event.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </Field>

          <Field label={t('team.form.handoffPath')} htmlFor="team-create-handoff">
            <Input
              id="team-create-handoff"
              value={handoffPath}
              onChange={(event) => setHandoffPath(event.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </Field>

          <Field
            className="col-span-full"
            label={t('teams.form.policy')}
            htmlFor="team-create-policy"
            hint={t('teams.form.policyHint')}
          >
            <Textarea
              id="team-create-policy"
              className="min-h-24 resize-y text-sm leading-normal font-mono"
              value={policy}
              onChange={(event) => setPolicy(event.target.value)}
              rows={4}
              spellCheck={false}
            />
          </Field>
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
