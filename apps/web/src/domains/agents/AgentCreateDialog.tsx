/**
 * Create agent 弹窗（canonical `agents.create`，单条批量形状）。
 *
 * 选择节点 → 可选绑定该节点已有 Team（或 unbound）→ 名称 / model / system prompt。
 * model 与 system prompt 从下一个 Body 生效；文案不承诺立即生效。
 */
import { type FormEvent, useState } from 'react';
import { ModalShell } from '../../components/Modal';
import { useToast } from '../../components/ToastProvider';
import { type NodeView, useNodes } from '../../gateway/NodeProvider';
import { nodeKeyOf } from '../../gateway/nodes';
import type { TeamSummary } from '../../gateway/types';
import { t, useLocale } from '../../i18n';
import { agentErrorText } from './agent-errors';
import { type AgentDraft, buildAgentCreateInput } from './agent-form';

export interface AgentCreateDialogProps {
  nodes: readonly NodeView[];
  teamsForNode: (nodeKey: string) => readonly TeamSummary[];
  initialNodeKey?: string;
  onClose: () => void;
  onSaved: () => void;
}

const EMPTY_DRAFT: AgentDraft = { name: '', model: '', systemPrompt: '', teamId: '' };

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

  const set = (key: keyof AgentDraft) => (value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setError(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !node) return;
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
      <form className="team-form" onSubmit={submit}>
        <div className="form-grid">
          <label className="field">
            <span className="field-label">{t('agents.filter.node')}</span>
            <select
              className="input"
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
                  {item.name}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="field-label">{t('agents.filter.team')}</span>
            <select
              className="input"
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
            </select>
          </label>

          <label className="field">
            <span className="field-label">{t('team.form.name')}</span>
            <input
              className="input"
              value={draft.name}
              onChange={(event) => set('name')(event.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </label>

          <label className="field">
            <span className="field-label">{t('agents.form.model')}</span>
            <input
              className="input mono"
              value={draft.model}
              onChange={(event) => set('model')(event.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </label>

          <label className="field field-wide">
            <span className="field-label">{t('agents.form.systemPrompt')}</span>
            <textarea
              className="input team-policy-input"
              value={draft.systemPrompt}
              onChange={(event) => set('systemPrompt')(event.target.value)}
              rows={5}
              spellCheck={false}
            />
            <span className="field-hint">{t('agents.form.systemPromptHint')}</span>
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
