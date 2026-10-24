/**
 * 0.17 Phase A bootstrap 装配。
 *
 * 守：交互 REPL 仍暴露旧 team_* / delegate_task（模型看到两套生命周期）、
 * headless 默认启动 owner 端点（无 TTY 也会抢 dataDir owner）、
 * shutdown 后 token 文件残留把 CLI 指到已关闭端口。
 */

import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { callAgentOwner } from '../agent-owner-client';
import { agentOwnerPath, readAgentOwnerRecord } from '../agent-owner-server';
import { type BootstrapResult, bootstrap } from '../bootstrap';

const dirs: string[] = [];
const results: BootstrapResult[] = [];

afterEach(async () => {
  while (results.length > 0) {
    await results.pop()?.shutdown();
  }
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-agent-boot-'));
  dirs.push(dir);
  return dir;
}

function writeFile(name: string, content: string): string {
  const file = path.join(tmpDir(), name);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function toolNames(result: BootstrapResult): string[] {
  return result.ctx.pluginHost.listTools().map((tool) => tool.name);
}

async function boot(options: {
  headless: boolean;
  interactive: boolean;
  config?: string;
}): Promise<{ result: BootstrapResult; dataDir: string }> {
  const dataDir = tmpDir();
  const result = await bootstrap({
    useMock: true,
    headless: options.headless,
    interactive: options.interactive,
    acquireLock: true,
    dataDir,
    userConfigPath: writeFile('config.yaml', 'api_key: sk-test\n'),
    configPath:
      options.config !== undefined
        ? writeFile('vessel.yaml', options.config)
        : writeFile('vessel.yaml', ''),
  });
  results.push(result);
  return { result, dataDir };
}

describe('agent bootstrap 0.17', () => {
  it('interactive default: agent service and agent tool are on (0.24)', async () => {
    const { result } = await boot({ headless: false, interactive: true });

    expect(result.agent).toBeDefined();
    const tools = toolNames(result);
    for (const name of ['bash', 'read', 'edit', 'ask_user', 'agent']) {
      expect(tools).toContain(name);
    }
    expect(tools.filter((name) => name.startsWith('team_'))).toEqual([]);
    expect(tools).not.toContain('delegate_task');
    const pluginNames = result.bundle?.plugins.map((plugin) => plugin.name) ?? [];
    expect(pluginNames).not.toContain('team');
    expect(pluginNames).not.toContain('delegate-task');
  });

  it('explicit agent.enabled=false keeps the service and agent tool off', async () => {
    const { result } = await boot({
      headless: false,
      interactive: true,
      config: 'agent:\n  enabled: false\n',
    });

    expect(result.agent).toBeUndefined();
    const tools = toolNames(result);
    expect(tools).toContain('ask_user');
    expect(tools).not.toContain('agent');
  });

  it('interactive with agent.enabled exposes agent and a live owner endpoint', async () => {
    const { result, dataDir } = await boot({
      headless: false,
      interactive: true,
      config: 'agent:\n  enabled: true\n',
    });

    expect(result.agent).toBeDefined();
    expect(result.agent?.owner.id).toBe('main');
    expect(result.agent?.team).toBeDefined();
    expect(await result.agent?.team.list()).toEqual([]);
    const owner = await result.agent?.service.list({ viewer: 'main' });
    expect(owner?.map((member) => member.id)).toContain('main');

    const tools = toolNames(result);
    for (const name of ['bash', 'read', 'edit', 'ask_user', 'agent']) {
      expect(tools).toContain(name);
    }

    const record = await readAgentOwnerRecord(dataDir);
    expect(record?.pid).toBe(process.pid);
    expect(record?.tenant_id).toBe('default');
  });

  it('CLI attach works through the started owner endpoint', async () => {
    const { dataDir } = await boot({
      headless: false,
      interactive: true,
      config: 'agent:\n  enabled: true\n',
    });
    const record = await readAgentOwnerRecord(dataDir);
    expect(record).not.toBeNull();
    if (!record) throw new Error('owner record missing');

    const listed = (await callAgentOwner(record, 'agents.list')) as {
      agents: Array<{ id: string }>;
    };
    expect(listed.agents.map((member) => member.id)).toContain('main');
  });

  it('wires the real TeamService into the hub snapshot', async () => {
    const { result, dataDir } = await boot({
      headless: false,
      interactive: true,
      config: 'agent:\n  enabled: true\n',
    });
    const agent = result.agent;
    if (!agent) throw new Error('agent control missing');

    const created = await agent.service.new({
      name: 'a1',
      workspace: path.join(dataDir, 'alpha'),
    });
    const snapshot = await agent.hubControl?.snapshot('default');

    expect(snapshot).toBeDefined();
    expect(snapshot?.teams.map((team) => team.team_id)).toContain('alpha');
    expect(snapshot?.agents.some((member) => member.agent_id === created.id)).toBe(true);
  });

  it('member auto-reply does not mark the REPL owner failed', async () => {
    const { result } = await boot({
      headless: false,
      interactive: true,
      config: 'agent:\n  enabled: true\n',
    });
    const service = result.agent?.service;
    if (!service) throw new Error('agent service missing');

    const created = await service.new({ owner: 'main', parentId: 'main', name: 'worker' });
    await service.send({ to: created.id, content: 'hi' });

    const deadline = Date.now() + 5000;
    let members: Array<{ id: string; state: string }> = [];
    while (Date.now() < deadline) {
      members = await service.list({ viewer: 'main' });
      if (members.find((member) => member.id === created.id)?.state === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(members.find((member) => member.id === created.id)?.state).toBe('completed');
    expect(members.find((member) => member.id === 'main')?.state).toBe('idle');
  });

  it('member lifecycle events reach the parent event stream', async () => {
    const { result } = await boot({
      headless: false,
      interactive: true,
      config: 'agent:\n  enabled: true\n',
    });
    const service = result.agent?.service;
    if (!service) throw new Error('agent service missing');

    const seen: string[] = [];
    const unsubscribe = result.ctx.events.subscribe((event) => {
      if (event.type.startsWith('agent.')) seen.push(event.type);
    });

    const created = await service.new({ owner: 'main', parentId: 'main', name: 'worker' });
    await service.send({ to: created.id, content: 'hi' });

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const members = await service.list({ viewer: 'main' });
      if (members.find((member) => member.id === created.id)?.state === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await service.close({ member: created.id });
    unsubscribe();

    expect(seen).toContain('agent.spawned');
    expect(seen.some((type) => type.startsWith('agent.turn.'))).toBe(true);
    expect(seen).toContain('agent.closed');
  });

  it('headless default: agent/team are on but no owner endpoint is served', async () => {
    const { result, dataDir } = await boot({ headless: true, interactive: false });
    expect(result.agent).toBeDefined();
    expect(await result.agent?.team.list()).toEqual([]);
    // 一次性进程不监听 owner HTTP 端口，也不写 agent-owner.json。
    expect(result.agent?.ownerServer).toBeUndefined();
    expect(await readAgentOwnerRecord(dataDir)).toBeNull();
    const tools = toolNames(result);
    expect(tools).toContain('agent');
    expect(tools).not.toContain('delegate_task');
    expect(tools.filter((name) => name.startsWith('team_'))).toEqual([]);
  });

  it('headless with agent.enabled=true keeps the service without an owner endpoint', async () => {
    const { result, dataDir } = await boot({
      headless: true,
      interactive: false,
      config: 'agent:\n  enabled: true\n',
    });
    expect(result.agent).toBeDefined();
    expect(result.agent?.ownerServer).toBeUndefined();
    expect(await readAgentOwnerRecord(dataDir)).toBeNull();
    expect(toolNames(result)).toContain('agent');
  });

  it('agent dispose tears down the team subscription and log chain without throwing', async () => {
    const { result } = await boot({
      headless: false,
      interactive: true,
      config: 'agent:\n  enabled: true\n',
    });
    const agent = result.agent;
    if (!agent) throw new Error('agent control missing');

    await expect(agent.dispose()).resolves.toBeUndefined();
    // dispose 后 store 仍可读；再次 dispose 也必须幂等。
    expect(await agent.team.list()).toEqual([]);
    await expect(agent.dispose()).resolves.toBeUndefined();
  });

  it('shutdown stops the owner endpoint and removes the token file', async () => {
    const { result, dataDir } = await boot({
      headless: false,
      interactive: true,
      config: 'agent:\n  enabled: true\n',
    });
    const record = await readAgentOwnerRecord(dataDir);
    expect(record).not.toBeNull();
    expect(fs.existsSync(agentOwnerPath(dataDir))).toBe(true);

    await result.shutdown();
    expect(fs.existsSync(agentOwnerPath(dataDir))).toBe(false);
    expect(await readAgentOwnerRecord(dataDir)).toBeNull();
    if (record) {
      await expect(callAgentOwner(record, 'agents.list')).rejects.toBeDefined();
    }
  });
});
