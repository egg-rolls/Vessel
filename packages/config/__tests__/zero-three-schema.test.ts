import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_CONFIG,
  DEFAULT_DURABLE_OPTIONS,
  DEFAULT_MCP_SERVER_OPTIONS,
  DEFAULT_SERVE_OPTIONS,
} from '../src/defaults';
import { loadConfig, loadConfigFromFile, preserveMcpMapKeys, snakeToCamel } from '../src/loader';
import type { McpServerConfig, VesselConfig } from '../src/types';
import {
  findUnknownNestedKeys,
  isLoopbackHostname,
  validateConfig,
  validateServeSettings,
} from '../src/validator';

// 隔离 VESSEL_* 环境变量
const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('VESSEL_')) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete savedEnv[k];
  }
});

function tmpYaml(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-03-cfg-'));
  const file = path.join(dir, 'vessel.yaml');
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

function missingPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-03-missing-'));
  return path.join(dir, 'does-not-exist.yaml');
}

function errorsOf(config: VesselConfig) {
  return validateConfig(config).errors;
}

function pathsOf(config: VesselConfig) {
  return errorsOf(config).map((e) => e.path);
}

describe('0.3 默认值（保持 0.2 行为）', () => {
  it('DEFAULT_CONFIG 不注入 mcpServers/durable/serve', () => {
    expect(DEFAULT_CONFIG.mcpServers).toBeUndefined();
    expect(DEFAULT_CONFIG.durable).toBeUndefined();
    expect(DEFAULT_CONFIG.serve).toBeUndefined();
  });

  it('新默认值常量固定', () => {
    expect(DEFAULT_MCP_SERVER_OPTIONS).toEqual({
      enabled: true,
      connectTimeoutMs: 10000,
      toolTimeoutMs: 60000,
      toolPrefix: true,
    });
    expect(DEFAULT_DURABLE_OPTIONS).toEqual({
      enabled: false,
      backend: 'file',
      path: '~/.vessel/runs',
      checkpointEvery: 'iteration',
    });
    expect(DEFAULT_SERVE_OPTIONS).toEqual({
      hostname: '127.0.0.1',
      port: 8642,
      allowRemote: false,
    });
  });

  it('全缺省加载：新键为 undefined，校验无 error', async () => {
    const { config, validation } = await loadConfig({
      configPath: missingPath(),
      userConfigPath: missingPath(),
    });
    expect(config.mcpServers).toBeUndefined();
    expect(config.durable).toBeUndefined();
    expect(config.serve).toBeUndefined();
    expect(validation.errors).toHaveLength(0);
  });
});

describe('snake_case → camelCase 的 map 键保留', () => {
  it('保留 mcpServers 的 server 名与 env/headers 键，配置键正常转换', () => {
    const input = {
      mcp_servers: {
        my_server: {
          transport: 'stdio',
          command: 'node',
          connect_timeout_ms: 500,
          auto_approve_tools: ['echo'],
          env: { MY_KEY: '1', my_key: '2' },
          headers: { 'X-Api-Key': 'v' },
        },
      },
    };

    const parsed = snakeToCamel<Record<string, unknown>>(input, {
      preserveKey: preserveMcpMapKeys,
    });
    const servers = parsed.mcpServers as Record<string, Record<string, unknown>>;
    const server = servers.my_server;

    expect(server).toBeDefined();
    expect(server?.connectTimeoutMs).toBe(500);
    expect(server?.autoApproveTools).toEqual(['echo']);
    expect(server?.env).toEqual({ MY_KEY: '1', my_key: '2' });
    expect(server?.headers).toEqual({ 'X-Api-Key': 'v' });
  });

  it('加载 YAML 时同样保留（项目配置文件路径）', async () => {
    const file = tmpYaml(
      [
        'mcp_servers:',
        '  my_server:',
        '    transport: stdio',
        '    command: node',
        '    tool_timeout_ms: 1000',
        '    env:',
        '      MY_KEY: value',
      ].join('\n'),
    );

    const config = await loadConfigFromFile(file);
    const server = config.mcpServers?.my_server as Record<string, unknown> | undefined;

    expect(server).toBeDefined();
    expect(server?.toolTimeoutMs).toBe(1000);
    expect(server?.env).toEqual({ MY_KEY: 'value' });
  });

  it('不传 preserveKey 时保持旧行为', () => {
    expect(snakeToCamel<Record<string, unknown>>({ mcp_servers: { my_server: {} } })).toEqual({
      mcpServers: { myServer: {} },
    });
  });
});

describe('mcpServers 校验', () => {
  it('合法的 stdio / http 配置无 error', () => {
    const config: VesselConfig = {
      mcpServers: {
        local: {
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
          env: { A: '1' },
          enabled: true,
          connectTimeoutMs: 1000,
          toolTimeoutMs: 2000,
          toolPrefix: true,
          autoApproveTools: ['echo'],
        },
        remote: {
          transport: 'http',
          url: 'http://127.0.0.1:9999/mcp',
          headers: { Authorization: 'Bearer x' },
        },
      },
    };
    expect(errorsOf(config)).toHaveLength(0);
  });

  it('缺 transport / stdio 缺 command / http 缺 url', () => {
    const config: VesselConfig = {
      mcpServers: {
        no_transport: {} as unknown as McpServerConfig,
        no_command: { transport: 'stdio' },
        no_url: { transport: 'http' },
      },
    };
    const paths = pathsOf(config);
    expect(paths).toContain('mcpServers.no_transport.transport');
    expect(paths).toContain('mcpServers.no_command.command');
    expect(paths).toContain('mcpServers.no_url.url');
  });

  it('非法 server 名、timeout、args/env 类型', () => {
    const config: VesselConfig = {
      mcpServers: {
        'bad name': { transport: 'stdio', command: 'node' },
        bad: {
          transport: 'stdio',
          command: 'node',
          connectTimeoutMs: 0,
          toolTimeoutMs: -1,
          args: [1 as unknown as string],
          env: { A: 1 as unknown as string },
          headers: ['x'] as unknown as Record<string, string>,
          autoApproveTools: [1 as unknown as string],
          enabled: 'yes' as unknown as boolean,
          toolPrefix: 'no' as unknown as boolean,
        },
      },
    };
    const paths = pathsOf(config);
    expect(paths).toContain('mcpServers.bad name');
    expect(paths).toContain('mcpServers.bad.connectTimeoutMs');
    expect(paths).toContain('mcpServers.bad.toolTimeoutMs');
    expect(paths).toContain('mcpServers.bad.args');
    expect(paths).toContain('mcpServers.bad.env');
    expect(paths).toContain('mcpServers.bad.headers');
    expect(paths).toContain('mcpServers.bad.autoApproveTools');
    expect(paths).toContain('mcpServers.bad.enabled');
    expect(paths).toContain('mcpServers.bad.toolPrefix');
  });

  it('stdio 给 url / http 给 command 只告警', () => {
    const { errors, warnings } = validateConfig({
      mcpServers: {
        a: { transport: 'stdio', command: 'node', url: 'http://x' },
        b: { transport: 'http', url: 'http://127.0.0.1/x', command: 'node' },
      },
    });
    expect(errors).toHaveLength(0);
    expect(warnings.map((w) => w.path)).toContain('mcpServers.a.url');
    expect(warnings.map((w) => w.path)).toContain('mcpServers.b.command');
  });

  it('mcpServers 不是 map 时报错', () => {
    expect(pathsOf({ mcpServers: [] as unknown as Record<string, McpServerConfig> })).toContain(
      'mcpServers',
    );
  });
});

describe('durable 校验', () => {
  it('合法配置无 error', () => {
    expect(
      errorsOf({
        durable: {
          enabled: true,
          backend: 'memory',
          path: '/tmp/runs',
          checkpointEvery: 'iteration',
        },
      }),
    ).toHaveLength(0);
  });

  it('非法 backend / 空 path / checkpointEvery', () => {
    const paths = pathsOf({
      durable: {
        enabled: 'yes' as unknown as boolean,
        backend: 'redis' as unknown as 'file',
        path: '  ',
        checkpointEvery: 'round' as unknown as 'iteration',
      },
    });
    expect(paths).toContain('durable.enabled');
    expect(paths).toContain('durable.backend');
    expect(paths).toContain('durable.path');
    expect(paths).toContain('durable.checkpointEvery');
  });
});

describe('serve 校验', () => {
  it('默认与回环 + TLS 合法', () => {
    expect(errorsOf({ serve: {} })).toHaveLength(0);
    expect(errorsOf({ serve: { hostname: '127.0.0.1', allowRemote: true } })).toHaveLength(0);
    expect(
      errorsOf({
        serve: {
          hostname: '127.0.0.1',
          tls: { certFile: 'cert.pem', keyFile: 'key.pem' },
        },
      }),
    ).toHaveLength(0);
  });

  it('非回环未 allowRemote 报错；非回环 + allowRemote 通过', () => {
    expect(pathsOf({ serve: { hostname: '0.0.0.0' } })).toContain('serve.allowRemote');
    expect(errorsOf({ serve: { hostname: '0.0.0.0', allowRemote: true } })).toHaveLength(0);
  });

  it('非法 port / hostname / allowRemote', () => {
    const paths = pathsOf({
      serve: {
        hostname: 'http://example.com/x',
        port: 70000,
        allowRemote: 'yes' as unknown as boolean,
      },
    });
    expect(paths).toContain('serve.hostname');
    expect(paths).toContain('serve.port');
    expect(paths).toContain('serve.allowRemote');
  });

  it('TLS 必须 cert/key 成对', () => {
    expect(pathsOf({ serve: { tls: { certFile: 'cert.pem' } } })).toContain('serve.tls.keyFile');
    expect(pathsOf({ serve: { tls: { keyFile: 'key.pem' } } })).toContain('serve.tls.certFile');
    expect(pathsOf({ serve: { tls: {} } })).toContain('serve.tls.certFile');
  });

  it('isLoopbackHostname 覆盖 127.0.0.0/8 与 ::1', () => {
    expect(isLoopbackHostname('127.0.0.1')).toBe(true);
    expect(isLoopbackHostname('127.10.0.5')).toBe(true);
    expect(isLoopbackHostname('localhost')).toBe(true);
    expect(isLoopbackHostname('::1')).toBe(true);
    expect(isLoopbackHostname('[::1]')).toBe(true);
    expect(isLoopbackHostname('0.0.0.0')).toBe(false);
    expect(isLoopbackHostname('192.168.1.1')).toBe(false);
    expect(isLoopbackHostname('127.0.0.999')).toBe(false);
  });

  it('validateServeSettings 可直接调用并返回错误', () => {
    const errors = validateServeSettings({ hostname: '0.0.0.0' });
    expect(errors.map((e) => e.path)).toContain('serve.allowRemote');
  });
});

describe('未知键（含嵌套）', () => {
  it('顶层未知键仍报错并给建议', async () => {
    const file = tmpYaml('mcp_server:\n  x: {}\n');
    const { validation } = await loadConfig({
      configPath: file,
      userConfigPath: missingPath(),
    });
    const error = validation.errors.find((e) => e.path === 'mcpServer');
    expect(error).toBeDefined();
    expect(error?.message).toContain('Did you mean "mcpServers"');
  });

  it('durable / serve / serve.tls / mcpServers 内的未知键报错', async () => {
    const file = tmpYaml(
      [
        'durable:',
        '  enabled: true',
        '  checkpointevery: iteration',
        'serve:',
        '  hostname: 127.0.0.1',
        '  tls:',
        '    cert: a.pem',
        'mcp_servers:',
        '  demo:',
        '    transport: stdio',
        '    command: node',
        '    unknown_key: 1',
      ].join('\n'),
    );
    const { validation } = await loadConfig({
      configPath: file,
      userConfigPath: missingPath(),
    });
    const paths = validation.errors.map((e) => e.path);
    expect(paths).toContain('durable.checkpointevery');
    expect(paths).toContain('serve.tls.cert');
    expect(paths).toContain('mcpServers.demo.unknownKey');
  });

  it('findUnknownNestedKeys 只检查已知块', () => {
    const unknown = findUnknownNestedKeys({
      durable: { foo: 1 },
      mcpServers: { demo: { transport: 'stdio', bar: 1 } },
      serve: { tls: { baz: 1 } },
    });
    expect(unknown.map((u) => u.path)).toEqual([
      'durable.foo',
      'serve.tls.baz',
      'mcpServers.demo.bar',
    ]);
  });
});
