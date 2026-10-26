/**
 * Create agent 弹窗（canonical `agents.create`，单条批量形状）。
 *
 * 选择节点 → 可选绑定该节点已有 Team（或 unbound）→ 名称 / model / system prompt。
 * model 与 system prompt 从下一个 Body 生效；文案不承诺立即生效。
 */
import { type FormEvent, useState } from 'react';
import { ModalShell } from '../../components/Modal';
import { useToast } from '../../components/ToastProvider';
import { Button, Field, Input, Select, Textarea } from '../../components/ui';
import { type NodeView, useNodes } from '../../gateway/NodeProvider';
import { nodeKeyOf } from '../../gateway/nodes';
import type { TeamSummary } from '../../gateway/types';
import { t, useLocale } from '../../i18n';
import { useNodeNames } from '../nodes/useNodeNames';
import { agentErrorText } from './agent-errors';
import {
  type AgentDraft,
  type AgentKind,
  agentCreateError,
  buildAgentCreateInput,
} from './agent-form';

export interface AgentCreateDialogProps {
  nodes: readonly NodeView[];
  teamsForNode: (nodeKey: string) => readonly TeamSummary[];
  initialNodeKey?: string;
  onClose: () => void;
  onSaved: () => void;
}

const EMPTY_DRAFT: AgentDraft = {
  name: '',
  model: '',
  systemPrompt: '',
  teamId: '',
  kind: 'peer',
};

export function AgentCreateDialog({
  nodes,
  teamsForNode,
  initialNodeKey,
  onClose,
  onSaved,
}: AgentCreateDialogProps) {
  useLocale();
  const toast = useToast();
  const { teamControl } = useNodes();
  const nodeNames = useNodeNames();
  const preferredKey =
    initialNodeKey !== undefined && nodes.some((item) => nodeKeyOf(item) === initialNodeKey)
      ? initialNodeKey
      : undefined;
  const [nodeKey, setNodeKey] = useState(preferredKey ?? (nodes[0] ? nodeKeyOf(nodes[0]) : ''));
  const [draft, setDraft] = useState<AgentDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const node = nodes.find((item) => nodeKeyOf(item) === nodeKey);
  const teams = node ? teamsForNode(nodeKeyOf(node)) : [];
  const title = t('agents.create.title');
  const peerNeedsTeam = agentCreateError(draft) === 'peer_requires_team';

  const set = (key: keyof AgentDraft) => (value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setError(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !node || peerNeedsTeam) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await teamControl(node).createAgent(buildAgentCreateInput(draft));
      const label = saved.name?.trim() || saved.agent_id || saved.id || draft.name.trim();
      toast.success(t('agents.form.created', { name: label || '—' }));
      onSaved();
      onClose();
    } catch (caught) {
      setError(agentErrorText(caught, 'agents.form.createFailed'));
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
          <Field label={t('agents.filter.node')} htmlFor="agent-create-node">
            <Select
              id="agent-create-node"
              value={nodeKey}
              onChange={(event) => {
                setNodeKey(event.target.value);
                setDraft((prev) => ({ ...prev, teamId: '' }));
                setError(null);
              }}
              aria-label={t('agents.filter.node')}
            >
              {nodes.map((item) => (
                <option key={nodeKeyOf(item)} value={nodeKeyOf(item)}>
                  {nodeNames.get(nodeKeyOf(item)) ?? '—'}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t('agents.form.kind')} htmlFor="agent-create-kind">
            <Select
              id="agent-create-kind"
              value={draft.kind ?? 'peer'}
              onChange={(event) => {
                setDraft((prev) => ({ ...prev, kind: event.target.value as AgentKind }));
                setError(null);
              }}
              aria-label={t('agents.form.kind')}
            >
              <option value="peer">{t('agents.form.kindPeer')}</option>
              <option value="contractor">{t('agents.form.kindContractor')}</option>
            </Select>
          </Field>

          <Field
            label={t('agents.filter.team')}
            htmlFor="agent-create-team"
            required={(draft.kind ?? 'peer') === 'peer'}
            hint={peerNeedsTeam ? t('agents.form.peerRequiresTeam') : undefined}
          >
            <Select
              id="agent-create-team"
              value={draft.teamId}
              onChange={(event) => set('teamId')(event.target.value)}
              aria-label={t('agents.filter.team')}
            >
              <option value="">{t('agents.form.unbound')}</option>
              {teams.map((team) => (
                <option key={team.team_id} value={team.team_id}>
                  {team.name || team.team_id}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t('team.form.name')} htmlFor="agent-create-name">
            <Input
              id="agent-create-name"
              value={draft.name}
              onChange={(event) => set('name')(event.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </Field>

          <Field label={t('agents.form.model')} htmlFor="agent-create-model">
            <Input
              id="agent-create-model"
              className="font-mono"
              value={draft.model}
              onChange={(event) => set('model')(event.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </Field>

          <Field
            className="col-span-full"
            label={t('agents.form.systemPrompt')}
            htmlFor="agent-create-system-prompt"
            hint={t('agents.form.systemPromptHint')}
          >
            <Textarea
              id="agent-create-system-prompt"
              className="min-h-24 resize-y text-sm leading-normal"
              value={draft.systemPrompt}
              onChange={(event) => set('systemPrompt')(event.target.value)}
              rows={5}
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
          <Button onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !node || peerNeedsTeam}>
            {busy ? t('common.processing') : t('team.form.submitCreate')}
          </Button>
        </div>
      </form>
    </ModalShell>
  );
}
