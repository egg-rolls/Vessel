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
import { resourceData } from '../../state/useResource';
import { teamDetailKey, useTeamStore } from '../../stores/teamStore';
import { usePolledAction } from '../../stores/usePolledAction';
import { TeamPolicyFields } from './TeamPolicyFields';
import { nullableChange, trimmedOrUndefined } from './team-form';
import {
  buildPolicy,
  type PolicyErrorField,
  type PolicyErrors,
  type PolicyFormState,
  policyChanged,
  policyToForm,
} from './team-policy-form';

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

  const nodeKey = nodeKeyOf(node);
  const detailState = useTeamStore(
    (state) => state.details[teamDetailKey(nodeKey, teamId, 'summary')],
  );
  const loadDetail = useTeamStore((state) => state.loadDetail);
  const updateTeam = useTeamStore((state) => state.update);
  const reload = () => {
    void loadDetail(nodeKey, teamId, control, { limit: 1, members_limit: 1 }, 'summary');
  };
  usePolledAction(
    () => {
      void loadDetail(nodeKey, teamId, control, { limit: 1, members_limit: 1 }, 'summary');
    },
    { enabled: hasToken, deps: [epoch, tenantEpoch, nodeKey, teamId] },
  );
  const detail = resourceData(detailState);

  let body: ReactNode;
  if (!hasToken) {
    body = (
      <NotEnabledState title={t('team.error.noToken')} reason={t('team.error.noTokenReason')} />
    );
  } else if (detailState?.status === 'error' && !detail) {
    body = <ErrorState message={detailState.error} onRetry={reload} />;
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
          const saved = await updateTeam(control, input);
          onSaved();
          return saved;
        }}
        onBack={onBack}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto overscroll-contain p-6 pb-10 max-compact:px-3 max-compact:pt-4 max-compact:pb-7 [&>*]:mx-auto [&>*]:w-full [&>*]:max-w-[var(--content-max)]">
      <PageHeader
        title={detail?.team.name || teamId}
        tenantId={tenantId}
        actions={<Button onClick={onBack}>{t('teams.edit.back')}</Button>}
      />
      <div className="mt-5 flex flex-col gap-4">{body}</div>
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
  });
  const [name, setName] = useState(initial.current.name);
  const [description, setDescription] = useState(initial.current.description);
  const [policyForm, setPolicyForm] = useState<PolicyFormState>(() => policyToForm(team.policy));
  const [policyErrors, setPolicyErrors] = useState<PolicyErrors>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updatePolicy = (patch: Partial<PolicyFormState>) => {
    setPolicyForm((current) => ({ ...current, ...patch }));
    setPolicyErrors((current) => {
      const next = { ...current };
      for (const key of Object.keys(patch)) delete next[key as PolicyErrorField];
      return next;
    });
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setError(null);

    const builtPolicy = buildPolicy(team.policy, policyForm);
    if (!builtPolicy.ok) {
      setPolicyErrors(builtPolicy.errors);
      return;
    }
    setPolicyErrors({});

    const input: TeamUpdateInput = { team_id: team.team_id };
    const nextName = trimmedOrUndefined(name);
    if (nextName !== undefined && nextName !== initial.current.name.trim()) input.name = nextName;
    const descriptionChange = nullableChange(description, initial.current.description);
    if (descriptionChange.changed) input.description = descriptionChange.value;
    if (policyChanged(team.policy, builtPolicy.policy)) input.policy = builtPolicy.policy;

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

          <TeamPolicyFields
            idPrefix="team-edit"
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
