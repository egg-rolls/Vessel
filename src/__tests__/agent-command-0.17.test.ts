/**
 * 0.17 Phase A `vessel agent` CLI。
 *
 * 守：`--json` 被人类文案污染、端点错误码没映射到 exit 1、
 * 无 owner 时静默成功（脚本会以为成员已创建）。
 */

import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAgentCommand } from '../agent-command';
import { writeAgentOwnerRecord } from '../agent-owner-server';
import { parseArgs } from '../cli-args';

const dirs: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  while (servers.length > 0) servers.pop()?.stop(true);
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-agent-cli-'));
  dirs.push(dir);
  return dir;
}

interface RecordedCall {
  method: string;
  params: Record<string, unknown>;
  token: string | undefined;
}

function statusBody(id: string) {
  return {
    id,
    session_id: id,
    owner: 'main',
    visibility: 'private',
    state: 'idle',
  };
}

function rotatedBody() {
  return {
    status: 'rotated',
    agent_id: 'worker',
    from_session_id: 'old-session',
    to_session_id: 'new-session',
    epoch: 1,
  };
}

async function mockOwner(rotateResult: unknown = rotatedBody()): Promise<{
  dataDir: string;
  calls: RecordedCall[];
}> {
  const dataDir = tmpDir();
  const calls: RecordedCall[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as {
        method?: string;
        params?: Record<string, unknown>;
      };
      const authorization = request.headers.get('authorization') ?? '';
      calls.push({
        method: body.method ?? '',
        params: body.params ?? {},
        token: authorization.replace(/^Bearer\s+/i, ''),
      });
      if (body.method === 'agent.new') return Response.json({ ok: true, result: statusBody('m1') });
      if (body.method === 'agent.send') {
        return Response.json({
          ok: true,
          result: { queued: true, message_id: 'msg1', state: 'idle' },
        });
      }
      if (body.method === 'agent.close') {
        return Response.json({ ok: true, result: { state: 'closed' } });
      }
      if (body.method === 'agent.list') {
        return Response.json({ ok: true, result: [statusBody('m1')] });
      }
      if (body.method === 'agent.rotate') {
        return Response.json({ ok: true, result: rotateResult });
      }
      if (body.method === 'agent.dispatch') {
        return Response.json({
          ok: true,
          result: {
            status: 'queued',
            message_id: 'msg1',
            resolved_to: 'm2',
            resolution: 'forked',
          },
        });
      }
      return Response.json(
        { ok: false, error: { code: 'agent_owner_unknown_method', message: 'unknown' } },
        { status: 404 },
      );
    },
  });
  servers.push(server);
  await writeAgentOwnerRecord(dataDir, {
    pid: process.pid,
    host: '127.0.0.1',
    port: server.port ?? 0,
    token: 'owner-token',
    started_at: new Date().toISOString(),
    tenant_id: 'default',
  });
  return { dataDir, calls };
}

function parse(argv: string[]) {
  const result = parseArgs(argv);
  if (!result.ok) throw new Error(`parse failed: ${result.error}`);
  if (!result.args.agentCommand) throw new Error('agentCommand missing');
  return result.args.agentCommand;
}

describe('vessel agent CLI', () => {
  it('new --json prints the raw member status', async () => {
    const { dataDir, calls } = await mockOwner();
    const result = await runAgentCommand(
      parse([
        'agent',
        'new',
        '--name',
        'worker',
        '--model',
        'm',
        '--visibility',
        'private',
        '--system-prompt',
        'be brief',
        '--json',
      ]),
      { dataDir },
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ id: 'm1', state: 'idle' });
    expect(calls[0]?.method).toBe('agent.new');
    expect(calls[0]?.params).toEqual({
      name: 'worker',
      model: 'm',
      visibility: 'private',
      system_prompt: 'be brief',
    });
    expect(calls[0]?.token).toBe('owner-token');
  });

  it('send prints a human line and forwards content', async () => {
    const { dataDir, calls } = await mockOwner();
    const result = await runAgentCommand(
      parse(['agent', 'send', 'm1', 'hello', 'agent', 'world']),
      { dataDir },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('m1');
    expect(result.stdout).toContain('msg1');
    expect(calls[0]?.params).toEqual({ to: 'm1', content: 'hello agent world' });
  });

  it('dispatch --allow-fork forwards allow_fork (a dropped override silently disables manual fork)', async () => {
    const { dataDir, calls } = await mockOwner();
    const result = await runAgentCommand(
      parse(['agent', 'dispatch', 'm1', 'hello', '--allow-fork']),
      {
        dataDir,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(calls[0]?.method).toBe('agent.dispatch');
    expect(calls[0]?.params).toEqual({ to: 'm1', content: 'hello', allow_fork: true });
  });

  it('close --json prints the batch result', async () => {
    const { dataDir, calls } = await mockOwner();
    const result = await runAgentCommand(parse(['agent', 'close', 'm1', 'm2', '--json']), {
      dataDir,
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ state: 'closed' });
    expect(calls[0]?.params).toEqual({ members: ['m1', 'm2'] });
  });

  it('list filters and renders human rows', async () => {
    const { dataDir, calls } = await mockOwner();
    const result = await runAgentCommand(
      parse(['agent', 'list', '--visibility', 'private', '--state', 'idle']),
      { dataDir },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Agents (1)');
    expect(result.stdout).toContain('m1');
    expect(calls[0]?.params).toEqual({ visibility: 'private', state: 'idle' });
  });

  it('list --json prints the raw status array', async () => {
    const { dataDir } = await mockOwner();
    const result = await runAgentCommand(parse(['agent', 'list', '--json']), { dataDir });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([statusBody('m1')]);
  });

  it('reports agent_owner_unavailable when no owner record exists', async () => {
    const result = await runAgentCommand(parse(['agent', 'list']), { dataDir: tmpDir() });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('agent_owner_unavailable');
  });

  it('reports agent_owner_unavailable for a stale pid', async () => {
    const dataDir = tmpDir();
    await writeAgentOwnerRecord(dataDir, {
      pid: 999999,
      host: '127.0.0.1',
      port: 1,
      token: 'dead',
      started_at: new Date().toISOString(),
      tenant_id: 'default',
    });
    const result = await runAgentCommand(parse(['agent', 'list']), { dataDir });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('agent_owner_unavailable');
  });

  it('rotate posts snake_case params and renders the rotated line', async () => {
    const { dataDir, calls } = await mockOwner();
    const result = await runAgentCommand(
      {
        kind: 'rotate',
        json: false,
        to: 'worker',
        startupPrompt: 'go',
        handoffPath: 'h.md',
      },
      { dataDir },
    );

    expect(result.exitCode).toBe(0);
    expect(calls[0]?.method).toBe('agent.rotate');
    expect(calls[0]?.params).toEqual({
      to: 'worker',
      startup_prompt: 'go',
      handoff_path: 'h.md',
    });
    expect(result.stdout).toContain('rotated');
    expect(result.stdout).toContain('epoch 1');
    expect(result.stdout).toContain('->');
  });

  it('rotate failure exits 1 and prints the code', async () => {
    const { dataDir } = await mockOwner({
      status: 'failed',
      code: 'rotate_failed',
      reason: 'x',
    });
    const result = await runAgentCommand(
      { kind: 'rotate', json: false, to: 'worker', startupPrompt: 'go' },
      { dataDir },
    );

    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('rotate_failed');
  });

  it('rotate --json prints the raw result with matching exit codes', async () => {
    const ok = await mockOwner();
    const rotated = await runAgentCommand(
      { kind: 'rotate', json: true, to: 'worker', startupPrompt: 'go' },
      { dataDir: ok.dataDir },
    );
    expect(rotated.exitCode).toBe(0);
    expect(JSON.parse(rotated.stdout)).toEqual(rotatedBody());
    // 无 --handoff 时 params 不带 handoff_path
    expect(ok.calls[0]?.params).toEqual({ to: 'worker', startup_prompt: 'go' });

    const failedBody = { status: 'failed', code: 'rotate_failed', reason: 'x' };
    const failed = await mockOwner(failedBody);
    const rejected = await runAgentCommand(
      { kind: 'rotate', json: true, to: 'worker', startupPrompt: 'go' },
      { dataDir: failed.dataDir },
    );
    expect(rejected.exitCode).toBe(1);
    expect(JSON.parse(rejected.stdout)).toEqual(failedBody);
    expect(rejected.stderr).toBe('');
  });

  it('surfaces endpoint error codes', async () => {
    const { dataDir } = await mockOwner();
    const result = await runAgentCommand(
      {
        kind: 'list',
        json: false,
      },
      {
        dataDir,
        fetchImpl: (async () =>
          Response.json(
            { ok: false, error: { code: 'unknown_member', message: 'nope' } },
            { status: 400 },
          )) as unknown as typeof fetch,
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown_member');
  });
});
