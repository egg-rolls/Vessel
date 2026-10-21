import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryEventStream, type RunEvent } from '../../packages/core/src/index';
import { type Gateway, startGateway } from '../../packages/serve/src/gateway';
import { type BootstrapResult, bootstrap } from '../bootstrap';

const CERT = fileURLToPath(
  new URL('../../packages/serve/__tests__/fixtures/tls/localhost-cert.pem', import.meta.url),
);
const KEY = fileURLToPath(
  new URL('../../packages/serve/__tests__/fixtures/tls/localhost-key.pem', import.meta.url),
);

const tempDirs: string[] = [];
const gateways: Gateway[] = [];
const results: BootstrapResult[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-connect-'));
  tempDirs.push(dir);
  return dir;
}

function tmpYaml(content: string): string {
  const file = path.join(tempDir(), 'config.yaml');
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function missingPath(): string {
  return path.join(tempDir(), 'missing.yaml');
}

// 等的是真实 gateway 进程内的事件（启动 + 鉴权 + RPC 往返）。CI 慢机上 3s
// 偏紧，放宽到 10s；仍是有界轮询，不会掩盖挂死。
async function waitFor(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await Bun.sleep(10);
  }
}

afterEach(async () => {
  for (const result of results.splice(0)) {
    await result.shutdown();
  }
  for (const gateway of gateways.splice(0)) {
    gateway.stop();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

function startTestGateway(auth?: Parameters<typeof startGateway>[0]['auth']): Gateway {
  const gateway = startGateway({
    events: new MemoryEventStream(),
    port: 0,
    hostname: '127.0.0.1',
    token: 'connect-token',
    ...(auth ? { auth } : {}),
  });
  gateways.push(gateway);
  return gateway;
}

async function connect(
  gateway: Gateway,
  options: { connectToken?: string; tenantId?: string; caFile?: string } = {},
): Promise<BootstrapResult> {
  const dataDir = tempDir();
  const result = await bootstrap({
    useMock: true,
    headless: true,
    interactive: false,
    acquireLock: true,
    dataDir,
    userConfigPath: tmpYaml('api_key: sk-test\n'),
    configPath: missingPath(),
    connect: gateway.url,
    connectToken: options.connectToken ?? 'connect-token',
    ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
    ...(options.caFile !== undefined ? { caFile: options.caFile } : {}),
  });
  results.push(result);
  return result;
}

describe('connect e2e (0.6 A1/A2/A4)', () => {
  it('health.get 展示远端 tenant/node', async () => {
    const gateway = startTestGateway();
    const result = await connect(gateway);

    expect(result.remote).toEqual({
      tenantId: 'default',
      nodeId: gateway.nodeId,
      endpoint: gateway.url,
    });
    expect(result.ctx.tenant?.tenant_id).toBe('default');
    expect(result.tenantId).toBe('default');
  });

  it('gateway 事件经 WS 转成本地 events，permission response 走 RPC 回远端', async () => {
    const events = new MemoryEventStream();
    const gateway = startGateway({
      events,
      port: 0,
      hostname: '127.0.0.1',
      token: 'connect-token',
    });
    gateways.push(gateway);
    const result = await connect(gateway);

    const seen: RunEvent[] = [];
    result.ctx.events.subscribe((event) => {
      seen.push(event);
    });

    events.publish({
      type: 'tool.permission.request',
      run_id: 'run-1',
      data: { requestId: 'perm-1', tool: 'bash', input: {} },
      ts: Date.now(),
    });
    await waitFor(() => seen.some((event) => event.type === 'tool.permission.request'));

    // 模拟 TUI 发布回答（子组件行为），bootstrap 应转成 permission.respond。
    result.ctx.events.publish({
      type: 'tool.permission.response',
      run_id: 'run-1',
      data: { requestId: 'perm-1', decision: 'allow' },
      ts: Date.now(),
    });
    // 第一条是 TUI 本地发布，第二条是 gateway 处理 permission.respond 后的回声；
    // 等到两条都出现，证明 RPC 回路真的到达了远端。
    const responses = () =>
      seen.filter(
        (event) =>
          event.type === 'tool.permission.response' &&
          (event.data as { requestId?: string }).requestId === 'perm-1',
      );
    await waitFor(() => responses().length > 1);
    const echoed = responses()[1];
    expect(echoed?.data).toMatchObject({ requestId: 'perm-1', decision: 'allow' });
  });

  it('自签 CA 文件对 fetch 与 wss 都生效', async () => {
    const events = new MemoryEventStream();
    const gateway = startGateway({
      events,
      port: 0,
      hostname: '127.0.0.1',
      token: 'connect-token',
      tls: { certFile: CERT, keyFile: KEY },
    });
    gateways.push(gateway);
    expect(gateway.url.startsWith('https://')).toBe(true);

    const result = await connect(gateway, { caFile: CERT });
    expect(result.remote?.tenantId).toBe('default');

    const seen: RunEvent[] = [];
    result.ctx.events.subscribe((event) => {
      seen.push(event);
    });
    events.publish({
      type: 'run.started',
      run_id: 'run-tls',
      data: {},
      ts: Date.now(),
    });
    await waitFor(() => seen.some((event) => event.type === 'run.started'));
  });

  it('admin --tenant 通过请求 tenant_id 覆盖 principal 的默认 tenant', async () => {
    const gateway = startTestGateway({
      configured: true,
      authenticate: (token) => (token === 'admin-token' ? { tenant_id: '*', role: 'admin' } : null),
    });
    const result = await connect(gateway, {
      connectToken: 'admin-token',
      tenantId: 'tenant-b',
    });

    expect(result.remote?.tenantId).toBe('tenant-b');
    expect(result.ctx.tenant?.tenant_id).toBe('tenant-b');
  });
});
