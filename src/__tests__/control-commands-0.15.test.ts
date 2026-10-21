/**
 * 0.15 `doctor --deep` / `gateway status --rpc`：连接、runtime、queue 可诊断。
 *
 * 故障形态：gateway 进程在但 RPC 不通/health 字段缺失时仍报 ok；
 * 或 queue 永远显示为空。
 */

import { describe, expect, it } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VesselConfig } from '../../packages/config/src/index';
import type { ControlPlaneTarget } from '../control-plane-target';
import { doctorCommand } from '../doctor-command';
import { gatewayStatus } from '../gateway-command';

function fakeTarget(
  handler: (method: string) => Promise<unknown>,
  instance = 'default',
): ControlPlaneTarget {
  return {
    kind: 'local',
    baseUrl: 'http://127.0.0.1:1',
    token: '',
    instance,
    request: <T = unknown>(method: string) => handler(method) as Promise<T>,
    close: async () => undefined,
  };
}

describe('doctor --deep', () => {
  it('reports attach / runtime / mcp from live RPC', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'vessel-doctor-deep-'));
    const target = fakeTarget(async (method) => {
      if (method === 'health.get') {
        return {
          node: { node_id: 'node-1', status: 'running' },
          current_run_id: 'run-1',
          provider: 'openai',
          model: 'gpt-x',
        };
      }
      if (method === 'mcp.list') return { servers: [] };
      throw new Error(`unexpected method ${method}`);
    });
    const result = await doctorCommand({
      json: true,
      deep: true,
      target,
      configPath: join(dataDir, 'missing.yaml'),
      userConfigPath: join(dataDir, 'missing-user.yaml'),
      env: { VESSEL_API_KEY: 'test-key' },
    });
    const payload = JSON.parse(result.stdout) as {
      checks: Array<{ name: string; status: string; message: string }>;
    };
    const byName = new Map(payload.checks.map((check) => [check.name, check]));
    expect(byName.get('attach')?.status).toBe('ok');
    expect(byName.get('runtime')?.message).toContain('current_run=run-1');
    expect(byName.get('mcp_rpc')?.status).toBe('ok');
  });

  it('fails the attach check when health.get rejects', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'vessel-doctor-deep-fail-'));
    const target = fakeTarget(async () => {
      throw new Error('connection refused');
    });
    const result = await doctorCommand({
      json: true,
      deep: true,
      target,
      configPath: join(dataDir, 'missing.yaml'),
      userConfigPath: join(dataDir, 'missing-user.yaml'),
      env: { VESSEL_API_KEY: 'test-key' },
    });
    const payload = JSON.parse(result.stdout) as {
      checks: Array<{ name: string; status: string; message: string }>;
    };
    const attach = payload.checks.find((check) => check.name === 'attach');
    expect(attach?.status).toBe('fail');
    expect(attach?.message).toContain('connection refused');
    expect(result.exitCode).toBe(1);
  });
});

describe('gateway status --rpc', () => {
  it('reports health and queue counts', async () => {
    const lines: string[] = [];
    const target = fakeTarget(async (method) => {
      if (method === 'health.get') {
        return { node: { node_id: 'node-1', status: 'running' }, current_run_id: 'run-1' };
      }
      if (method === 'runs.list') {
        return {
          runs: [
            { status: 'queued' },
            { status: 'queued' },
            { status: 'running' },
            { status: 'completed' },
          ],
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const code = await gatewayStatus({
      rpc: true,
      json: true,
      rpcTarget: target,
      config: {} as VesselConfig,
      dataDir: await mkdtemp(join(tmpdir(), 'vessel-status-rpc-')),
      env: {},
      print: (line) => lines.push(line),
      printErr: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    const payload = JSON.parse(lines.join('\n')) as {
      instances: Array<{ ok: boolean; queue?: { queued: number; running: number } }>;
    };
    expect(payload.instances[0]?.ok).toBe(true);
    expect(payload.instances[0]?.queue).toEqual({ queued: 2, running: 1 });
  });
});
