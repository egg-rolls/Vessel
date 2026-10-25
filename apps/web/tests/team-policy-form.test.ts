import { describe, expect, test } from 'bun:test';
import {
  buildPolicy,
  emptyPolicyForm,
  policyChanged,
  policyToForm,
} from '../src/domains/teams/team-policy-form';

describe('team policy form', () => {
  test('reads known policy fields and ignores unknown ones', () => {
    const form = policyToForm({
      permission: { unattended: 'deny-after', denyAfterSeconds: 300 },
      budget: {
        maxHops: 20,
        maxTurns: 40,
        maxTokens: 200000,
        maxWallClockSeconds: 3600,
        warningThreshold: 0.8,
        cycle: { maxRepeats: 2, cooldownSeconds: 60 },
      },
      allowFork: true,
      federation: { accept: 'log' },
      unknown: { a: 1 },
    });

    expect(form).toEqual({
      unattended: 'deny-after',
      denyAfterSeconds: '300',
      maxHops: '20',
      maxTurns: '40',
      maxTokens: '200000',
      maxWallClockSeconds: '3600',
      warningThreshold: '0.8',
      cycleMaxRepeats: '2',
      cycleCooldownSeconds: '60',
      allowFork: true,
      federationAccept: 'log',
    });
  });

  test('empty create form builds an empty policy', () => {
    expect(buildPolicy(undefined, emptyPolicyForm())).toEqual({ ok: true, policy: {} });
  });

  test('builds values and preserves unknown top-level and nested keys', () => {
    const base = {
      customTop: { keep: true },
      permission: { customPermission: 'keep' },
      budget: {
        maxHops: 5,
        customBudget: 'keep',
        cycle: { maxRepeats: 2, customCycle: 'keep' },
      },
      federation: { accept: 'principal', customFederation: 'keep' },
    };
    const result = buildPolicy(base, {
      ...emptyPolicyForm(),
      unattended: 'hold',
      maxHops: '5',
      maxTurns: '7',
      cycleMaxRepeats: '2',
      cycleCooldownSeconds: '0',
      federationAccept: 'log',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.policy).toEqual({
      customTop: { keep: true },
      permission: { customPermission: 'keep', unattended: 'hold' },
      budget: {
        maxHops: 5,
        customBudget: 'keep',
        maxTurns: 7,
        cycle: { maxRepeats: 2, customCycle: 'keep', cooldownSeconds: 0 },
      },
      federation: { accept: 'log', customFederation: 'keep' },
    });
  });

  test('clearing a known field deletes it while preserving unknown keys', () => {
    const base = {
      permission: { unattended: 'hold' },
      budget: { maxHops: 20, customBudget: 'keep', cycle: { cooldownSeconds: 60 } },
      allowFork: true,
    };
    const result = buildPolicy(base, {
      ...emptyPolicyForm(),
      maxHops: '',
      cycleCooldownSeconds: '',
      allowFork: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // unattended 未设置时删除；空字段同样删除。
    expect(result.policy).toEqual({ budget: { customBudget: 'keep' } });
  });

  test('deny-after requires a 1..86400 integer', () => {
    const required = buildPolicy(undefined, {
      ...emptyPolicyForm(),
      unattended: 'deny-after',
    });
    expect(required).toEqual({
      ok: false,
      errors: { denyAfterSeconds: { code: 'denyAfterRequired' } },
    });

    for (const value of ['0', '86401', '1.5', 'abc']) {
      const result = buildPolicy(undefined, {
        ...emptyPolicyForm(),
        unattended: 'deny-after',
        denyAfterSeconds: value,
      });
      expect(result).toEqual({
        ok: false,
        errors: { denyAfterSeconds: { code: 'denyAfterRange' } },
      });
    }

    const ok = buildPolicy(undefined, {
      ...emptyPolicyForm(),
      unattended: 'deny-after',
      denyAfterSeconds: '300',
    });
    expect(ok).toEqual({
      ok: true,
      policy: { permission: { unattended: 'deny-after', denyAfterSeconds: 300 } },
    });
  });

  test('hold drops a stale denyAfterSeconds value', () => {
    const result = buildPolicy(undefined, {
      ...emptyPolicyForm(),
      unattended: 'hold',
      denyAfterSeconds: '300',
    });
    expect(result).toEqual({ ok: true, policy: { permission: { unattended: 'hold' } } });
  });

  test('budget integers must be >= 1 and cycle cooldown >= 0', () => {
    const result = buildPolicy(undefined, {
      ...emptyPolicyForm(),
      maxHops: '0',
      maxTurns: '1.5',
      maxTokens: '-1',
      maxWallClockSeconds: 'abc',
      cycleMaxRepeats: '0',
      cycleCooldownSeconds: '-1',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual({
      maxHops: { code: 'integerMin', min: 1 },
      maxTurns: { code: 'integerMin', min: 1 },
      maxTokens: { code: 'integerMin', min: 1 },
      maxWallClockSeconds: { code: 'integerMin', min: 1 },
      cycleMaxRepeats: { code: 'integerMin', min: 1 },
      cycleCooldownSeconds: { code: 'integerMin', min: 0 },
    });
  });

  test('warningThreshold is exclusive between 0 and 1', () => {
    for (const value of ['0', '1', '-0.1', '1.1', 'abc']) {
      const result = buildPolicy(undefined, {
        ...emptyPolicyForm(),
        warningThreshold: value,
      });
      expect(result).toEqual({
        ok: false,
        errors: { warningThreshold: { code: 'threshold' } },
      });
    }

    expect(buildPolicy(undefined, { ...emptyPolicyForm(), warningThreshold: '0.5' })).toEqual({
      ok: true,
      policy: { budget: { warningThreshold: 0.5 } },
    });
  });

  test('allowFork writes true, removes when unchecked, and preserves explicit false', () => {
    expect(buildPolicy(undefined, { ...emptyPolicyForm(), allowFork: true })).toEqual({
      ok: true,
      policy: { allowFork: true },
    });
    expect(buildPolicy({ allowFork: true }, { ...emptyPolicyForm(), allowFork: false })).toEqual({
      ok: true,
      policy: {},
    });
    expect(buildPolicy({ allowFork: false }, { ...emptyPolicyForm(), allowFork: false })).toEqual({
      ok: true,
      policy: { allowFork: false },
    });
  });

  test('federation accept is omitted when unset', () => {
    expect(
      buildPolicy({ federation: { accept: 'principal', keep: 1 } }, emptyPolicyForm()),
    ).toEqual({ ok: true, policy: { federation: { keep: 1 } } });
  });

  test('policyChanged compares serialized policies', () => {
    expect(policyChanged(undefined, {})).toBe(false);
    expect(policyChanged({ allowFork: true }, { allowFork: true })).toBe(false);
    expect(policyChanged({ allowFork: true }, {})).toBe(true);
  });
});
