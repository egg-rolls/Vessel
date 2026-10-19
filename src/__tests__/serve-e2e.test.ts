import { expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * `--serve` 远程/TLS 的 CLI 端到端测试。
 * TLS 使用仓库内自签 fixture（仅测试读取）。
 */

const repoRoot = path.resolve(import.meta.dir, '..', '..');
const cliPath = path.join(repoRoot, 'src', 'cli.ts');
const tlsDir = path.join(repoRoot, 'packages', 'serve', '__tests__', 'fixtures', 'tls');

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-serve-e2e-'));
}

async function runCli(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, cliPath, ...args], {
    cwd,
    env: { ...process.env, VESSEL_MOCK: '1', USERPROFILE: cwd, HOME: cwd },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

/**
 * 等待子进程输出匹配；超时返回到目前为止的输出。
 * 只用**一个**后台 reader 消费流：并发 read() 会互相抢 chunk。
 */
async function waitForOutput(
  proc: { stdout: ReadableStream<Uint8Array> },
  pattern: RegExp,
  timeoutMs = 8000,
): Promise<string> {
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let stopped = false;

  const pump = (async () => {
    try {
      while (!stopped) {
        const result = await reader.read();
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
      }
    } catch {
      // 进程退出导致流关闭
    }
  })();

  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pattern.test(buffer)) return buffer;
      await Bun.sleep(50);
    }
    return buffer;
  } finally {
    stopped = true;
    await reader.cancel().catch(() => {});
    void pump;
  }
}

it('非回环 + 未 allow-remote：启动失败 exit 1', async () => {
  const dir = tmpDir();
  try {
    const { stderr, exitCode } = await runCli(['--serve', '0', '--serve-host', '0.0.0.0'], dir);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('non-loopback');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('TLS 文件缺失：启动失败 exit 1', async () => {
  const dir = tmpDir();
  try {
    const { stderr, exitCode } = await runCli(
      [
        '--serve',
        '0',
        '--tls-cert',
        path.join(dir, 'missing-cert.pem'),
        '--tls-key',
        path.join(dir, 'missing-key.pem'),
      ],
      dir,
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain('not found');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('mcp_servers 经 bootstrap 安装并在 /v1/mcp/servers 可见', async () => {
  const dir = tmpDir();
  const serverScript = path.join(repoRoot, 'examples', 'mcp-echo-server.ts').replaceAll('\\', '/');
  fs.writeFileSync(
    path.join(dir, 'vessel.yaml'),
    [
      'mcp_servers:',
      '  demo:',
      '    transport: stdio',
      `    command: ${JSON.stringify(process.execPath.replaceAll('\\', '/'))}`,
      '    args:',
      `      - ${JSON.stringify(serverScript)}`,
      '',
    ].join('\n'),
  );

  const token = 'e2e-gateway-token';
  const proc = Bun.spawn([process.execPath, cliPath, '--serve', '0'], {
    cwd: dir,
    env: {
      ...process.env,
      VESSEL_MOCK: '1',
      VESSEL_GATEWAY_TOKEN: token,
      USERPROFILE: dir,
      HOME: dir,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  try {
    const output = await waitForOutput(proc, /Gateway\s+http/);
    const gatewayUrl = /Gateway\s+(http[^\s]+)/.exec(output)?.[1];
    expect(gatewayUrl).toBeDefined();

    const health = (await (await fetch(`${gatewayUrl}/v1/health`)).json()) as {
      protocol?: { features?: string[] };
    };
    expect(health.protocol?.features).toContain('mcp-status');

    const res = await fetch(`${gatewayUrl}/v1/mcp/servers?token=${token}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      servers: Array<{ name: string; status: string; tools: string[] }>;
    };
    expect(body.servers).toHaveLength(1);
    expect(body.servers[0]).toMatchObject({ name: 'demo', status: 'connected' });
    expect(body.servers[0]?.tools).toContain('mcp__demo__echo');
  } finally {
    proc.kill();
    await proc.exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('durable store/resume 注入 gateway：列表可见且 resume 返回 202', async () => {
  const dir = tmpDir();
  const runsDir = path.join(dir, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(
    path.join(runsDir, 'resume-gw.json'),
    JSON.stringify({
      run_id: 'resume-gw',
      session_id: 'session-gw',
      status: 'interrupted',
      messages: [{ role: 'user', content: 'hello-gateway' }],
      created_at: 1000,
      updated_at: 2000,
    }),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(dir, 'vessel.yaml'),
    [
      'durable:',
      '  enabled: true',
      '  backend: file',
      `  path: ${runsDir.replaceAll('\\', '/')}`,
      '',
    ].join('\n'),
  );

  const token = 'e2e-gateway-token';
  const proc = Bun.spawn([process.execPath, cliPath, '--serve', '0'], {
    cwd: dir,
    env: {
      ...process.env,
      VESSEL_MOCK: '1',
      VESSEL_GATEWAY_TOKEN: token,
      USERPROFILE: dir,
      HOME: dir,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  try {
    const output = await waitForOutput(proc, /Gateway\s+http/);
    const gatewayUrl = /Gateway\s+(http[^\s]+)/.exec(output)?.[1];

    const health = (await (await fetch(`${gatewayUrl}/v1/health`)).json()) as {
      protocol?: { features?: string[] };
    };
    expect(health.protocol?.features).toContain('durable-resume');

    const listRes = await fetch(`${gatewayUrl}/v1/durable/runs?status=interrupted&token=${token}`);
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as { runs: Array<{ run_id: string }> };
    expect(listed.runs.map((run) => run.run_id)).toContain('resume-gw');

    const resumeRes = await fetch(`${gatewayUrl}/v1/durable/runs/resume-gw/resume?token=${token}`, {
      method: 'POST',
    });
    expect(resumeRes.status).toBe(202);
  } finally {
    proc.kill();
    await proc.exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('loopback + TLS：gateway.url 为 https 且 hello 声明 tls', async () => {
  const dir = tmpDir();
  const proc = Bun.spawn(
    [
      process.execPath,
      cliPath,
      '--serve',
      '0',
      '--tls-cert',
      path.join(tlsDir, 'localhost-cert.pem'),
      '--tls-key',
      path.join(tlsDir, 'localhost-key.pem'),
    ],
    {
      cwd: dir,
      env: { ...process.env, VESSEL_MOCK: '1', USERPROFILE: dir, HOME: dir },
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    },
  );

  try {
    const output = await waitForOutput(proc, /Gateway\s+(https:\/\/[^\s]+)/);
    const match = /Gateway\s+(https:\/\/[^\s]+)/.exec(output);
    expect(match).not.toBeNull();
    const url = match?.[1];
    expect(url?.startsWith('https://127.0.0.1:')).toBe(true);

    const res = await fetch(`${url}/v1/health`, {
      // 自签证书仅用于本地测试
      tls: { rejectUnauthorized: false },
    } as RequestInit);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { protocol?: { features?: string[] } };
    expect(body.protocol?.features).toContain('tls');
    expect(output).toContain('TLS');
  } finally {
    proc.kill();
    await proc.exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
