/**
 * Node 面板的 Team 表单（create / edit）。
 *
 * 只做输入与校验，写操作交给 `TeamControl`（`teams.create` / `teams.update`）。
 * edit 时 workspace 不可改；用户清空的 nullable 字段显式发送 `null`（DECISION-040），
 * 未改动的字段省略。
 */
import { type FormEvent, useRef, useState } from 'react';
import { ModalShell } from '../../components/Modal';
import { useToast } from '../../components/ToastProvider';
import type { TeamControl } from '../../gateway/team-control';
import type { TeamCreateInput, TeamSummary, TeamUpdateInput } from '../../gateway/types';
import { t, useLocale } from '../../i18n';

export interface TeamFormDialogProps {
  mode: 'create' | 'edit';
  team?: TeamSummary;
  control: TeamControl;
  hasToken: boolean;
  onClose: () => void;
  onSaved: (team: TeamSummary) => void;
}

function trimmedOrUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** nullable 字段：改动才返回；清空 → null。 */
function nullableChange(
  value: string,
  initial: string,
): { changed: boolean; value: string | null } {
  const trimmed = value.trim();
  if (trimmed === initial.trim()) return { changed: false, value: null };
  return { changed: true, value: trimmed === '' ? null : trimmed };
}

export function TeamFormDialog({
  mode,
  team,
  control,
  hasToken,
  onClose,
  onSaved,
}: TeamFormDialogProps) {
  useLocale();
  const toast = useToast();
  const title = mode === 'create' ? t('team.form.createTitle') : t('team.form.editTitle');
  const initial = useRef({
    name: team?.name ?? '',
    description: team?.description ?? '',
    defaultPrincipal: team?.default_principal ?? '',
    handoffPath: team?.handoff_path ?? '',
  });

  const [workspace, setWorkspace] = useState(team?.workspace ?? '');
  const [name, setName] = useState(initial.current.name);
  const [description, setDescription] = useState(initial.current.description);
  const [defaultPrincipal, setDefaultPrincipal] = useState(initial.current.defaultPrincipal);
  const [handoffPath, setHandoffPath] = useState(initial.current.handoffPath);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestClose = () => {
    if (!busy) onClose();
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !hasToken) return;
    setError(null);

    const workspaceValue = workspace.trim();
    if (mode === 'create' && workspaceValue === '') {
      setError(t('team.form.required'));
      return;
    }
    setBusy(true);
    try {
      let saved: TeamSummary;
      if (mode === 'edit') {
        if (!team) {
          setError(t('team.form.updateFailed'));
          return;
        }
        const input: TeamUpdateInput = { team_id: team.team_id };
        const nextName = trimmedOrUndefined(name);
        if (nextName !== undefined && nextName !== initial.current.name.trim()) {
          input.name = nextName;
        }
        const descriptionChange = nullableChange(description, initial.current.description);
        if (descriptionChange.changed) input.description = descriptionChange.value;
        const principalChange = nullableChange(defaultPrincipal, initial.current.defaultPrincipal);
        if (principalChange.changed) input.default_principal = principalChange.value;
        const handoffChange = nullableChange(handoffPath, initial.current.handoffPath);
        if (handoffChange.changed) input.handoff_path = handoffChange.value;
        saved = await control.updateTeam(input);
      } else {
        const input: TeamCreateInput = { workspace: workspaceValue };
        const nameValue = trimmedOrUndefined(name);
        const descriptionValue = trimmedOrUndefined(description);
        const principalValue = trimmedOrUndefined(defaultPrincipal);
        const handoffValue = trimmedOrUndefined(handoffPath);
        if (nameValue !== undefined) input.name = nameValue;
        if (descriptionValue !== undefined) input.description = descriptionValue;
        if (principalValue !== undefined) input.default_principal = principalValue;
        if (handoffValue !== undefined) input.handoff_path = handoffValue;
        saved = await control.createTeam(input);
      }
      toast.success(`${title}: ${saved.name || saved.team_id}`);
      onSaved(saved);
      onClose();
    } catch (caught) {
      const code = (caught as { code?: unknown }).code;
      if (code === 'forbidden') {
        setError(t('team.form.forbidden'));
      } else {
        const message = caught instanceof Error ? caught.message : String(caught);
        const prefix =
          mode === 'create' ? t('team.form.createFailed') : t('team.form.updateFailed');
        setError(`${prefix}: ${message}`);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell label={title} onClose={requestClose} closeOnBackdrop={!busy}>
      <h2 className="modal-title">{title}</h2>
      <form className="team-form" onSubmit={submit}>
        <div className="form-grid">
          {mode === 'edit' ? (
            <label className="field">
              <span className="field-label">{t('team.form.workspace')}</span>
              <input className="input" value={team?.workspace ?? ''} readOnly placeholder="—" />
              <span className="field-hint">{t('team.form.workspaceHint')}</span>
            </label>
          ) : (
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
          )}

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
        </div>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={requestClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !hasToken}>
            {busy
              ? t('common.processing')
              : mode === 'create'
                ? t('team.form.submitCreate')
                : t('team.form.submitEdit')}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
