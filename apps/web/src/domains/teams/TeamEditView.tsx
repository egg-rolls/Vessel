/**
 * Team 编辑页（canonical `teams.update`）。
 *
 * 独立整页而不是弹窗；workspace 创建后不可改。归档 Team 只读。
 */
import { type FormEvent, type ReactNode, useRef, useState } from 'react';
import { PageHeader } from '../../components/PageHeader';
import { ErrorState, LoadingState, NotEnabledState } from '../../components/States';
import { useToast } from '../../components/ToastProvider';
import { Button, Field, Input, Section, Textarea } from '../../components/ui';
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
    <Section>
      <form className="flex flex-col gap-2" onSubmit={submit}>
        <div className="form-grid mt-1">
          <Field
            label={t('team.form.workspace')}
            htmlFor="team-edit-workspace"
            hint={t('team.form.workspaceHint')}
          >
            <Input
              id="team-edit-workspace"
              className="bg-deep text-muted"
              value={team.workspace ?? ''}
              readOnly
              placeholder="—"
            />
          </Field>

          <Field label={t('team.form.name')} htmlFor="team-edit-name">
            <Input
              id="team-edit-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </Field>

          <Field label={t('team.form.description')} htmlFor="team-edit-description">
            <Textarea
              id="team-edit-description"
              className="min-h-16 resize-y font-sans"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
            />
          </Field>

          <Field
            label={t('team.form.defaultPrincipal')}
            htmlFor="team-edit-principal"
            hint={t('team.form.defaultPrincipalHint')}
          >
            <Input
              id="team-edit-principal"
              value={defaultPrincipal}
              onChange={(event) => setDefaultPrincipal(event.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </Field>

          <Field label={t('team.form.handoffPath')} htmlFor="team-edit-handoff">
            <Input
              id="team-edit-handoff"
              value={handoffPath}
              onChange={(event) => setHandoffPath(event.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </Field>

          <Field
            className="col-span-full"
            label={t('teams.form.policy')}
            htmlFor="team-edit-policy"
            hint={t('teams.form.policyHint')}
          >
            <Textarea
              id="team-edit-policy"
              className="min-h-24 resize-y text-sm leading-normal font-mono"
              value={policy}
              onChange={(event) => setPolicy(event.target.value)}
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
          <Button type="button" onClick={onBack} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? t('common.processing') : t('team.form.submitEdit')}
          </Button>
        </div>
      </form>
    </Section>
  );
}
