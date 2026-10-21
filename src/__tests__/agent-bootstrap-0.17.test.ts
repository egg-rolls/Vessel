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
  it('interactive default: bash/read/edit/ask_user without the agent service', async () => {
    const { result } = await boot({ headless: false, interactive: true });

    expect(result.agent).toBeUndefined();
    const tools = toolNames(result);
    for (const name of ['bash', 'read', 'edit', 'ask_user']) {
      expect(tools).toContain(name);
    }
    expect(tools).not.toContain('agent');
    expect(tools.filter((name) => name.startsWith('team_'))).toEqual([]);
    expect(tools).not.toContain('delegate_task');
    const pluginNames = result.bundle?.plugins.map((plugin) => plugin.name) ?? [];
    expect(pluginNames).not.toContain('team');
    expect(pluginNames).not.toContain('delegate-task');
  });

  it('interactive with agent.enabled exposes agent and a live owner endpoint', async () => {
    const { result, dataDir } = await boot({
      headless: false,
      interactive: true,
      config: 'agent:\n  enabled: true\n',
    });

    expect(result.agent).toBeDefined();
    expect(result.agent?.owner.id).toBe('main');
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

    const listed = await callAgentOwner(record, 'agent.list');
    expect(Array.isArray(listed)).toBe(true);
    expect((listed as Array<{ id: string }>).map((member) => member.id)).toContain('main');
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

  it('headless default: no agent service and no legacy lifecycle tools', async () => {
    const { result } = await boot({ headless: true, interactive: false });
    expect(result.agent).toBeUndefined();
    const tools = toolNames(result);
    expect(tools).not.toContain('agent');
    expect(tools).not.toContain('delegate_task');
    expect(tools.filter((name) => name.startsWith('team_'))).toEqual([]);
  });

  it('headless with agent.enabled=true starts the agent service', async () => {
    const { result } = await boot({
      headless: true,
      interactive: false,
      config: 'agent:\n  enabled: true\n',
    });
    expect(result.agent).toBeDefined();
    expect(toolNames(result)).toContain('agent');
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
      await expect(callAgentOwner(record, 'agent.list')).rejects.toBeDefined();
    }
  });
});
