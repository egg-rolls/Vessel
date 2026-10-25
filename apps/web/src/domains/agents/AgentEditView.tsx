/**
 * Agent 编辑整页（canonical `agents.update`，单条批量形状）。
 *
 * name 立即生效；model / system_prompt 从下一个 Body 生效。Web 没有读取当前
 * model / system prompt 的稳定字段，因此这两项留空表示不修改，不伪造现值。
 */
import { type FormEvent, useState } from 'react';
import { PageHeader } from '../../components/PageHeader';
import { useToast } from '../../components/ToastProvider';
import { Button, Field, Input, Section, Textarea } from '../../components/ui';
import { useConnection } from '../../gateway/ConnectionProvider';
import { type NodeView, useNodes } from '../../gateway/NodeProvider';
import { nodeKeyOf } from '../../gateway/nodes';
import type { RosterAgent } from '../../gateway/team-roster';
import { t, useLocale } from '../../i18n';
import { useNodeNames } from '../nodes/useNodeNames';
import { agentErrorText } from './agent-errors';
import { type AgentDraft, buildAgentUpdateInput } from './agent-form';
import { agentDisplayName } from './agent-search';

export function AgentEditView({
  node,
  agent,
  onBack,
  onSaved,
}: {
  node: NodeView;
  agent: RosterAgent;
  onBack: () => void;
  onSaved: () => void;
}) {
  useLocale();
  const toast = useToast();
  const { tenantId } = useConnection();
  const { teamControl } = useNodes();
  const nodeNames = useNodeNames();
  const member = agent.member;
  const displayName = agentDisplayName(member);
  const [draft, setDraft] = useState<AgentDraft>({
    name: member.name?.trim() ?? '',
    model: '',
    systemPrompt: '',
    teamId: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (key: keyof AgentDraft) => (value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setError(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const result = buildAgentUpdateInput(
      member.agent_id,
      { name: member.name ?? '', model: '', systemPrompt: '' },
      draft,
    );
    if (!result.ok || !result.input) {
      setError(t('agents.form.noChange'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await teamControl(node).updateAgent(result.input);
      toast.success(
        t('agents.form.updated', {
          name: saved.name?.trim() || draft.name.trim() || displayName,
        }),
      );
      onSaved();
      onBack();
    } catch (caught) {
      setError(agentErrorText(caught, 'agents.form.updateFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="domain-view">
      <PageHeader
        title={t('agents.edit.title')}
        tenantId={tenantId}
        actions={<Button onClick={onBack}>{t('agents.back')}</Button>}
      />
      <div className="domain-content">
        <Section>
          <p className="mt-1.5 max-w-prose text-md leading-relaxed text-muted">
            {nodeNames.get(nodeKeyOf(node)) ?? '—'} · {agent.team.name || agent.team.team_id} ·{' '}
            {displayName}
          </p>
          <form className="flex flex-col gap-2" onSubmit={submit}>
            <div className="form-grid mt-1">
              <Field label={t('team.form.name')} htmlFor="agent-edit-name">
                <Input
                  id="agent-edit-name"
                  value={draft.name}
                  onChange={(event) => set('name')(event.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                />
              </Field>

              <Field
                label={t('agents.form.model')}
                htmlFor="agent-edit-model"
                hint={t('agents.form.modelHint')}
              >
                <Input
                  id="agent-edit-model"
                  className="font-mono"
                  value={draft.model}
                  onChange={(event) => set('model')(event.target.value)}
                  placeholder="—"
                  spellCheck={false}
                  autoComplete="off"
                />
              </Field>

              <Field
                className="col-span-full"
                label={t('agents.form.systemPrompt')}
                htmlFor="agent-edit-system-prompt"
                hint={t('agents.form.systemPromptHint')}
              >
                <Textarea
                  id="agent-edit-system-prompt"
                  className="min-h-24 resize-y text-sm leading-normal"
                  value={draft.systemPrompt}
                  onChange={(event) => set('systemPrompt')(event.target.value)}
                  rows={6}
                  spellCheck={false}
                />
              </Field>
            </div>

            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}

            <div className="form-actions">
              <Button onClick={onBack} disabled={busy}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" variant="primary" disabled={busy}>
                {busy ? t('common.processing') : t('team.form.submitEdit')}
              </Button>
            </div>
          </form>
        </Section>
      </div>
    </div>
  );
}
