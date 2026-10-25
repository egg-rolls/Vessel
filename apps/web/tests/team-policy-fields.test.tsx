import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { TeamPolicyFields } from '../src/domains/teams/TeamPolicyFields';
import { emptyPolicyForm } from '../src/domains/teams/team-policy-form';
import { t } from '../src/i18n';

describe('TeamPolicyFields', () => {
  test('hides deny-after seconds until deny-after is selected', () => {
    const markup = renderToStaticMarkup(
      <TeamPolicyFields
        idPrefix="x"
        form={emptyPolicyForm()}
        errors={{}}
        onChange={() => undefined}
      />,
    );
    expect(markup).toContain('x-policy-unattended');
    expect(markup).toContain('x-policy-max-hops');
    expect(markup).toContain('x-policy-federation-accept');
    expect(markup).not.toContain('x-policy-deny-after-seconds');
  });

  test('shows deny-after seconds with a field-level error', () => {
    const markup = renderToStaticMarkup(
      <TeamPolicyFields
        idPrefix="x"
        form={{ ...emptyPolicyForm(), unattended: 'deny-after' }}
        errors={{ denyAfterSeconds: { code: 'denyAfterRequired' } }}
        onChange={() => undefined}
      />,
    );
    expect(markup).toContain('x-policy-deny-after-seconds');
    expect(markup).toContain(t('team.form.policyErrorDenyAfterRequired'));
  });
});
