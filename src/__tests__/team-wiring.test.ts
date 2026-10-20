import { describe, expect, it } from 'bun:test';
import { planTeamWiring } from '../team-wiring';

describe('planTeamWiring', () => {
  it('默认（team off、无 gateway）零输出、不接 team', () => {
    expect(planTeamWiring({ config: {}, hasGateway: false, hasHost: false })).toEqual({
      attachToGateway: false,
      useLoopback: false,
      useRemote: false,
      warnings: [],
    });
  });

  it('team off + serve + loopback：告警忽略，不接 team', () => {
    const plan = planTeamWiring({
      config: { transport: { kind: 'loopback' } },
      hasGateway: true,
      hasHost: true,
    });
    expect(plan.attachToGateway).toBe(false);
    expect(plan.useLoopback).toBe(false);
    expect(plan.warnings[0]).toContain('team.enabled is false');
  });

  it('team on + 未 serve + loopback：降级 in-process 并告警', () => {
    const plan = planTeamWiring({
      config: { team: { enabled: true }, transport: { kind: 'loopback' } },
      hasGateway: false,
      hasHost: true,
    });
    expect(plan.attachToGateway).toBe(false);
    expect(plan.useLoopback).toBe(false);
    expect(plan.warnings[0]).toContain('requires --serve');
  });

  it('team on + serve 但 host off：不接 gateway team 端点', () => {
    const plan = planTeamWiring({
      config: { team: { enabled: true }, transport: { kind: 'loopback' } },
      hasGateway: true,
      hasHost: false,
    });
    expect(plan.attachToGateway).toBe(false);
    expect(plan.useLoopback).toBe(false);
    expect(plan.warnings[0]).toContain('host.enabled=false');
  });

  it('team on + serve + host + in-process：接团队端点，不建 loopback', () => {
    const plan = planTeamWiring({
      config: { team: { enabled: true } },
      hasGateway: true,
      hasHost: true,
    });
    expect(plan).toEqual({
      attachToGateway: true,
      useLoopback: false,
      useRemote: false,
      warnings: [],
    });
  });

  it('team on + serve + host + loopback：接团队端点并建 loopback', () => {
    const plan = planTeamWiring({
      config: { team: { enabled: true }, transport: { kind: 'loopback' } },
      hasGateway: true,
      hasHost: true,
    });
    expect(plan).toEqual({
      attachToGateway: true,
      useLoopback: true,
      useRemote: false,
      warnings: [],
    });
  });

  it('team on + serve + host + remote：接团队端点并建 remote', () => {
    const plan = planTeamWiring({
      config: {
        team: { enabled: true },
        transport: {
          kind: 'remote',
          nodes: [{ id: 'node-b', url: 'https://b.example.com', token: 't' }],
        },
      },
      hasGateway: true,
      hasHost: true,
    });
    expect(plan).toEqual({
      attachToGateway: true,
      useLoopback: false,
      useRemote: true,
      warnings: [],
    });
  });

  it('team on + 未 serve + remote：降级 in-process 并告警', () => {
    const plan = planTeamWiring({
      config: { team: { enabled: true }, transport: { kind: 'remote', nodes: [] } },
      hasGateway: false,
      hasHost: true,
    });
    expect(plan.attachToGateway).toBe(false);
    expect(plan.useRemote).toBe(false);
    expect(plan.warnings[0]).toContain('requires --serve');
  });
});
