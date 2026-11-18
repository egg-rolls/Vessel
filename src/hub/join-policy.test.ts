import { describe, expect, test } from 'bun:test';
import { decideJoinRegistration, hasLiveNodeToken } from './join-policy.js';
import type { HubNodeTokenRecord } from './types.js';

function token(overrides: Partial<HubNodeTokenRecord> = {}): HubNodeTokenRecord {
  return {
    token_id: 'token-1',
    token_hash: 'a'.repeat(64),
    scope: 'node',
    hub_id: 'hub-1',
    node_id: 'node-1',
    issued_by: 'join',
    created_at: 1_000,
    expires_at: 2_000,
    ...overrides,
  };
}

describe('hasLiveNodeToken', () => {
  test('未吊销且未过期才算活', () => {
    expect(hasLiveNodeToken([token()], 'node-1', 1_500)).toBe(true);
    expect(hasLiveNodeToken([token()], 'node-1', 2_000)).toBe(false);
    expect(hasLiveNodeToken([token({ revoked_at: 1_200 })], 'node-1', 1_500)).toBe(false);
    expect(hasLiveNodeToken([token()], 'node-2', 1_500)).toBe(false);
    expect(hasLiveNodeToken([], 'node-1', 1_500)).toBe(false);
  });

  test('旧 token 不影响新 token 的判定', () => {
    const tokens = [token({ token_id: 'old', expires_at: 1_100 }), token({ token_id: 'new' })];
    expect(hasLiveNodeToken(tokens, 'node-1', 1_500)).toBe(true);
  });
});

describe('decideJoinRegistration', () => {
  test('带 code：首次注册与轮转都放行', () => {
    expect(
      decideJoinRegistration({ hasCode: true, hasLiveToken: false, loopbackPeer: false }),
    ).toEqual({ ok: true, rotate: false });
    expect(
      decideJoinRegistration({ hasCode: true, hasLiveToken: true, loopbackPeer: false }),
    ).toEqual({ ok: true, rotate: true });
  });

  test('无 code + 无有效 token：必须出码', () => {
    const decision = decideJoinRegistration({
      hasCode: false,
      hasLiveToken: false,
      loopbackPeer: true,
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.code).toBe('code_required');
  });

  test('无 code + 有有效 token + 回环 peer：允许同机自助重连', () => {
    expect(
      decideJoinRegistration({ hasCode: false, hasLiveToken: true, loopbackPeer: true }),
    ).toEqual({ ok: true, rotate: true });
  });

  test('无 code + 有有效 token + 非回环：拒绝（防跨机顶替身份）', () => {
    const decision = decideJoinRegistration({
      hasCode: false,
      hasLiveToken: true,
      loopbackPeer: false,
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.code).toBe('node_exists');
  });
});
