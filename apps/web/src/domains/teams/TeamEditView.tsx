/**
 * Team 编辑页（canonical `teams.update`）。
 *
 * 独立整页而不是弹窗；workspace 创建后不可改。归档 Team 只读。
 */
import { type FormEvent, type ReactNode, useRef, useState } from 'react';
import { PageHeader } from '../../components/PageHeader';
import { ErrorState, LoadingState, NotEnabledState } from '../../components/States';
import { useToast } from '../../components/ToastProvider';
import { Button } from '../../components/ui';
import { useConnection } from '../../gateway/ConnectionProvider';
import { type NodeView, useNodes } from '../../gateway/NodeProvider';
import { nodeKeyOf } from '../../gateway/nodes';
import type { TeamDetail, TeamSummary, TeamUpdateInput } from '../../gateway/types';
import { t, useLocale } from '../../i18n';
import { resourceData, useResource } from '../../state/useResource';
import { nullableChange, parsePolicyText, policyText, trimmedOrUndefined } from './team-form';

export interface TeamEditViewProps {
  node: NodeView;
  teamId: string;
  onBack: () => void;
  onSaved: () => void;
}

export function TeamEditView({ node, teamId, onBack, onSaved }: TeamEditViewProps) {
  useLocale();
  const { epoch, tenantEpoch, tenantId } = useConnection();
  const { teamControl, hasTokenFor } = useNodes();
  const control = teamControl(node);
  const hasToken = hasTokenFor(node);

  const resource = useResource({
    load: () => control.getTeam(teamId, { limit: 1, members_limit: 1 }),
    enabled: hasToken,
    deps: [epoch, tenantEpoch, nodeKeyOf(node), teamId],
  });
  const detail = resourceData(resource.state);

  let body: ReactNode;
  if (!hasToken) {
    body = (
      <NotEnabledState title={t('team.error.noToken')} reason={t('team.error.noTokenReason')} />
    );
  } else if (resource.state.status === 'error' && !detail) {
    body = <ErrorState message={resource.state.error} onRetry={resource.reload} />;
  } else if (!detail) {
    body = <LoadingState label={t('common.loading')} rows={2} />;
  } else if (detail.team.archived_at !== undefined) {
    body = <NotEnabledState title={t('team.form.archivedReadonly')} />;
  } else {
    body = (
      <TeamEditForm
        key={detail.team.team_id}
        detail={detail}
        onSave={async (input) => {
          const saved = await control.updateTeam(input);
          onSaved();
          return saved;
        }}
        onBack={onBack}
      />
    );
  }

  return (
    <div className="domain-view">
      <PageHeader
        title={detail?.team.name || teamId}
        tenantId={tenantId}
        actions={<Button onClick={onBack}>{t('teams.edit.back')}</Button>}
      />
      <div className="domain-content">{body}</div>
    </div>
  );
}

function TeamEditForm({
  detail,
  onSave,
  onBack,
}: {
  detail: TeamDetail;
  onSave: (input: TeamUpdateInput) => Promise<TeamSummary>;
  onBack: () => void;
}) {
  useLocale();
  const toast = useToast();
  const team = detail.team;
  const initial = useRef({
    name: team.name ?? '',
    description: team.description ?? '',
    defaultPrincipal: team.default_principal ?? '',
    handoffPath: team.handoff_path ?? '',
    policyText: policyText(team.policy),
  });
  const [name, setName] = useState(initial.current.name);
  const [description, setDescription] = useState(initial.current.description);
  const [defaultPrincipal, setDefaultPrincipal] = useState(initial.current.defaultPrincipal);
  const [handoffPath, setHandoffPath] = useState(initial.current.handoffPath);
  const [policy, setPolicy] = useState(initial.current.policyText);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setError(null);

    const parsedPolicy = parsePolicyText(policy);
    if (!parsedPolicy.ok) {
      setError(t('teams.form.policyInvalid'));
      return;
    }

    const input: TeamUpdateInput = { team_id: team.team_id };
    const nextName = trimmedOrUndefined(name);
    if (nextName !== undefined && nextName !== initial.current.name.trim()) input.name = nextName;
    const descriptionChange = nullableChange(description, initial.current.description);
    if (descriptionChange.changed) input.description = descriptionChange.value;
    const principalChange = nullableChange(defaultPrincipal, initial.current.defaultPrincipal);
    if (principalChange.changed) input.default_principal = principalChange.value;
    const handoffChange = nullableChange(handoffPath, initial.current.handoffPath);
    if (handoffChange.changed) input.handoff_path = handoffChange.value;
    if (policy.trim() !== initial.current.policyText.trim() && parsedPolicy.value !== undefined) {
      input.policy = parsedPolicy.value;
    }

    setBusy(true);
    try {
      const saved = await onSave(input);
      toast.success(`${t('team.form.editTitle')}: ${saved.name || saved.team_id}`);
      onBack();
    } catch (caught) {
      const code = (caught as { code?: unknown }).code;
      if (code === 'forbidden') {
        setError(t('team.form.forbidden'));
      } else if (code === 'conflict') {
        setError(t('team.form.archivedReadonly'));
      } else {
        const message = caught instanceof Error ? caught.message : String(caught);
        setError(`${t('team.form.updateFailed')}: ${message}`);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <form className="team-form" onSubmit={submit}>
        <div className="form-grid">
          <label className="field">
            <span className="field-label">{t('team.form.workspace')}</span>
            <input className="input" value={team.workspace ?? ''} readOnly placeholder="—" />
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
              rows={3}
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
              rows={6}
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

        <div className="form-actions">
          <button type="button" className="btn" onClick={onBack} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? t('common.processing') : t('team.form.submitEdit')}
          </button>
        </div>
      </form>
    </section>
  );
}
