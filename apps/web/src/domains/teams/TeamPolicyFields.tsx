/** Team policy 结构化控件：create / edit 共用，只暴露已知 policy 字段。 */

import { Field, Input, Select } from '../../components/ui';
import { t } from '../../i18n';
import type {
  PolicyError,
  PolicyErrorField,
  PolicyErrors,
  PolicyFormState,
} from './team-policy-form';

export interface TeamPolicyFieldsProps {
  idPrefix: string;
  form: PolicyFormState;
  errors: PolicyErrors;
  onChange: (patch: Partial<PolicyFormState>) => void;
}

function errorText(error: PolicyError | undefined): string | undefined {
  if (error === undefined) return undefined;
  switch (error.code) {
    case 'integerMin':
      return t('team.form.policyErrorIntegerMin', { min: error.min });
    case 'denyAfterRange':
      return t('team.form.policyErrorDenyAfterRange');
    case 'denyAfterRequired':
      return t('team.form.policyErrorDenyAfterRequired');
    case 'threshold':
      return t('team.form.policyErrorThreshold');
  }
}

function fieldError(errors: PolicyErrors, field: PolicyErrorField): string | undefined {
  return errorText(errors[field]);
}

export function TeamPolicyFields({ idPrefix, form, errors, onChange }: TeamPolicyFieldsProps) {
  const id = (name: string) => `${idPrefix}-policy-${name}`;

  return (
    <div className="col-span-full flex flex-col gap-2">
      <div>
        <h3 className="font-mono text-2xs uppercase tracking-widest text-faint">
          {t('teams.form.policy')}
        </h3>
        <p className="mt-1 text-xs text-faint">{t('teams.form.policyHint')}</p>
      </div>

      <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
        <legend className="font-mono text-2xs uppercase tracking-widest text-faint">
          {t('team.form.policyPermission')}
        </legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Field label={t('team.form.policyUnattended')} htmlFor={id('unattended')}>
            <Select
              id={id('unattended')}
              value={form.unattended}
              onChange={(event) =>
                onChange({ unattended: event.target.value as PolicyFormState['unattended'] })
              }
            >
              <option value="">{t('team.form.policyUnset')}</option>
              <option value="hold">{t('team.form.policyHold')}</option>
              <option value="deny-after">{t('team.form.policyDenyAfter')}</option>
            </Select>
          </Field>
          {form.unattended === 'deny-after' ? (
            <Field
              label={t('team.form.policyDenyAfterSeconds')}
              htmlFor={id('deny-after-seconds')}
              error={fieldError(errors, 'denyAfterSeconds')}
            >
              <Input
                id={id('deny-after-seconds')}
                type="number"
                min={1}
                max={86400}
                step={1}
                value={form.denyAfterSeconds}
                onChange={(event) => onChange({ denyAfterSeconds: event.target.value })}
              />
            </Field>
          ) : null}
        </div>
      </fieldset>

      <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
        <legend className="font-mono text-2xs uppercase tracking-widest text-faint">
          {t('team.form.policyBudget')}
        </legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Field
            label={t('team.form.policyMaxHops')}
            htmlFor={id('max-hops')}
            error={fieldError(errors, 'maxHops')}
          >
            <Input
              id={id('max-hops')}
              type="number"
              min={1}
              step={1}
              value={form.maxHops}
              onChange={(event) => onChange({ maxHops: event.target.value })}
            />
          </Field>
          <Field
            label={t('team.form.policyMaxTurns')}
            htmlFor={id('max-turns')}
            error={fieldError(errors, 'maxTurns')}
          >
            <Input
              id={id('max-turns')}
              type="number"
              min={1}
              step={1}
              value={form.maxTurns}
              onChange={(event) => onChange({ maxTurns: event.target.value })}
            />
          </Field>
          <Field
            label={t('team.form.policyMaxTokens')}
            htmlFor={id('max-tokens')}
            error={fieldError(errors, 'maxTokens')}
          >
            <Input
              id={id('max-tokens')}
              type="number"
              min={1}
              step={1}
              value={form.maxTokens}
              onChange={(event) => onChange({ maxTokens: event.target.value })}
            />
          </Field>
          <Field
            label={t('team.form.policyMaxWallClockSeconds')}
            htmlFor={id('max-wall-clock-seconds')}
            error={fieldError(errors, 'maxWallClockSeconds')}
          >
            <Input
              id={id('max-wall-clock-seconds')}
              type="number"
              min={1}
              step={1}
              value={form.maxWallClockSeconds}
              onChange={(event) => onChange({ maxWallClockSeconds: event.target.value })}
            />
          </Field>
          <Field
            label={t('team.form.policyWarningThreshold')}
            htmlFor={id('warning-threshold')}
            hint={t('team.form.policyWarningThresholdHint')}
            error={fieldError(errors, 'warningThreshold')}
          >
            <Input
              id={id('warning-threshold')}
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={form.warningThreshold}
              onChange={(event) => onChange({ warningThreshold: event.target.value })}
            />
          </Field>
        </div>
      </fieldset>

      <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
        <legend className="font-mono text-2xs uppercase tracking-widest text-faint">
          {t('team.form.policyCycle')}
        </legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Field
            label={t('team.form.policyCycleMaxRepeats')}
            htmlFor={id('cycle-max-repeats')}
            error={fieldError(errors, 'cycleMaxRepeats')}
          >
            <Input
              id={id('cycle-max-repeats')}
              type="number"
              min={1}
              step={1}
              value={form.cycleMaxRepeats}
              onChange={(event) => onChange({ cycleMaxRepeats: event.target.value })}
            />
          </Field>
          <Field
            label={t('team.form.policyCycleCooldownSeconds')}
            htmlFor={id('cycle-cooldown-seconds')}
            error={fieldError(errors, 'cycleCooldownSeconds')}
          >
            <Input
              id={id('cycle-cooldown-seconds')}
              type="number"
              min={0}
              step={1}
              value={form.cycleCooldownSeconds}
              onChange={(event) => onChange({ cycleCooldownSeconds: event.target.value })}
            />
          </Field>
        </div>
      </fieldset>

      <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
        <legend className="font-mono text-2xs uppercase tracking-widest text-faint">
          {t('team.form.policyFederation')}
        </legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Field label={t('team.form.policyFederationAccept')} htmlFor={id('federation-accept')}>
            <Select
              id={id('federation-accept')}
              value={form.federationAccept}
              onChange={(event) =>
                onChange({
                  federationAccept: event.target.value as PolicyFormState['federationAccept'],
                })
              }
            >
              <option value="">{t('team.form.policyUnset')}</option>
              <option value="principal">{t('team.form.policyAcceptPrincipal')}</option>
              <option value="log">{t('team.form.policyAcceptLog')}</option>
            </Select>
          </Field>
        </div>
      </fieldset>

      <Field
        label={t('team.form.policyAllowFork')}
        htmlFor={id('allow-fork')}
        hint={t('team.form.policyAllowForkHint')}
      >
        <input
          id={id('allow-fork')}
          type="checkbox"
          className="h-4 w-4 accent-accent"
          checked={form.allowFork}
          onChange={(event) => onChange({ allowFork: event.target.checked })}
        />
      </Field>
    </div>
  );
}
