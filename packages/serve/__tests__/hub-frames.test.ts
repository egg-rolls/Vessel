import { describe, expect, it } from 'bun:test';
import {
  buildHubAuthFrame,
  buildHubHelloFrame,
  buildHubPointerFrame,
  buildHubSnapshotFrame,
  parseHubAuthFrame,
  parseHubHelloFrame,
  parseHubPointerFrame,
  parseHubSnapshotFrame,
  readHubEnvelope,
} from '../src/hub-frames.js';

describe('vessel.hub/1 frame helpers', () => {
  it('accepts a node dialer auth frame and rejects a hub dialer on a node-only endpoint', () => {
    const frame = buildHubAuthFrame({
      dialer: 'node',
      token: 'secret',
      hubId: 'hub-1',
      nodeId: 'node-1',
      tenantId: 'default',
      incarnation: 'inc-1',
    });
    expect(parseHubAuthFrame(frame, 'node')).toEqual({ ok: true, frame });

    const wrongDirection = parseHubAuthFrame(frame, 'hub');
    expect(wrongDirection.ok).toBe(false);
    if (!wrongDirection.ok) expect(wrongDirection.reason).toBe('unsupported');
  });

  it('requires node identity on a node dialer auth frame', () => {
    const result = parseHubAuthFrame({
      v: 1,
      kind: 'auth',
      protocol: 'vessel.hub/1',
      dialer: 'node',
      token: 'secret',
      hub_id: 'hub-1',
    });
    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('parses a hub-acceptor hello without node-only fields', () => {
    const frame = buildHubHelloFrame({
      dialer: 'node',
      hubId: 'hub-1',
      nodeId: 'node-1',
      tenantId: 'default',
    });
    const parsed = parseHubHelloFrame(frame, { hub_id: 'hub-1', node_id: 'node-1' }, 'node');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.frame.hub_id).toBe('hub-1');
      expect(parsed.frame.node_id).toBe('node-1');
      expect(parsed.frame.revision).toBeUndefined();
    }
  });

  it('rejects a hello whose identity does not match the expected pairing', () => {
    const frame = buildHubHelloFrame({
      dialer: 'node',
      hubId: 'hub-1',
      nodeId: 'other-node',
      tenantId: 'default',
    });
    const parsed = parseHubHelloFrame(frame, { hub_id: 'hub-1', node_id: 'node-1' }, 'node');
    expect(parsed).toEqual({ ok: false, reason: 'identity_mismatch' });
  });

  it('builds a whitelisted snapshot and never carries provider extras', () => {
    const frame = buildHubSnapshotFrame(
      {
        truncated: false,
        counts: { teams: 1, agents: 2, live_agents: 1 },
        teams: [
          {
            team_id: 'core',
            name: 'Core',
            member_count: 2,
            agent_count: 2,
            workspace: '/secret/path',
          } as never,
        ],
        agents: [
          {
            agent_id: 'a1',
            team_id: 'core',
            membership: 'present',
            presence: 'live',
            session_id: 'secret-session',
          } as never,
        ],
      },
      {
        dialer: 'node',
        nodeId: 'node-1',
        hubId: 'hub-1',
        incarnation: 'inc-1',
        revision: 3,
        observedAt: 100,
      },
    );
    const serialized = JSON.stringify(frame);
    expect(serialized).not.toContain('/secret/path');
    expect(serialized).not.toContain('secret-session');
    expect(frame.teams).toEqual([
      { team_id: 'core', name: 'Core', member_count: 2, agent_count: 2 },
    ]);
    expect(frame.agents).toEqual([
      { agent_id: 'a1', team_id: 'core', membership: 'present', presence: 'live' },
    ]);
    expect(parseHubSnapshotFrame(frame, { node_id: 'node-1', hub_id: 'hub-1' }).ok).toBe(true);
  });

  it('drops a pointer with an unknown reason or empty team_id', () => {
    expect(
      buildHubPointerFrame(
        { team_id: '', reason: 'team.message' },
        { dialer: 'node', nodeId: 'node-1', hubId: 'hub-1', now: 1 },
      ),
    ).toBeNull();
    expect(
      buildHubPointerFrame(
        { team_id: 'core', reason: 'content.leak' },
        { dialer: 'node', nodeId: 'node-1', hubId: 'hub-1', now: 1 },
      ),
    ).toBeNull();
  });

  it('parses a pointer without content fields', () => {
    const pointer = buildHubPointerFrame(
      { team_id: 'core', reason: 'team.message', request_id: 'm1', content: 'secret' },
      { dialer: 'node', nodeId: 'node-1', hubId: 'hub-1', now: 5 },
    );
    expect(pointer).not.toBeNull();
    if (pointer === null) return;
    expect(JSON.stringify(pointer)).not.toContain('secret');
    const parsed = parseHubPointerFrame(pointer, { node_id: 'node-1', hub_id: 'hub-1' });
    expect(parsed.ok).toBe(true);
  });

  it('classifies unsupported envelopes separately from invalid frames', () => {
    expect(
      readHubEnvelope({ v: 2, kind: 'auth', protocol: 'vessel.hub/1', dialer: 'node' }),
    ).toEqual({ ok: false, reason: 'unsupported' });
    expect(readHubEnvelope(null)).toEqual({ ok: false, reason: 'invalid' });
    expect(readHubEnvelope('nope')).toEqual({ ok: false, reason: 'invalid' });
  });
});
