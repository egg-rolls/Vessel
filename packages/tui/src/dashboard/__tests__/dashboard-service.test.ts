import { beforeEach, describe, expect, it } from 'bun:test';
import type { ReplContext } from '../../repl-context';
import { DashboardService } from '../dashboard-service';

describe('DashboardService', () => {
  let service: DashboardService;
  let mockCtx: ReplContext;

  beforeEach(() => {
    mockCtx = {
      // biome-ignore lint/suspicious/noExplicitAny: mock object for testing
      runtime: {} as any,
      tools: {
        list: () => [
          {
            name: 'test-tool',
            description: 'Test tool',
            inputSchema: {},
            // biome-ignore lint/suspicious/noExplicitAny: mock object for testing
            handler: (() => {}) as any,
          },
        ],
        // biome-ignore lint/suspicious/noExplicitAny: mock object for testing
        register: (() => {}) as any,
        // biome-ignore lint/suspicious/noExplicitAny: mock object for testing
        invoke: (() => {}) as any,
        schemas: () => [],
        get: () => undefined,
        has: () => false,
      },
      // biome-ignore lint/suspicious/noExplicitAny: mock object for testing
      session: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: mock object for testing
      events: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: mock object for testing
      context: {} as any,
      currentSessionId: 'test-session-123',
      onSessionChange: () => {},
      provider: {
        name: 'test-provider',
        model: 'test-model',
        baseUrl: 'http://test.com',
      },
      plugins: ['plugin1', 'plugin2'],
      // biome-ignore lint/suspicious/noExplicitAny: mock object for testing
      config: {} as any,
      newSessionId: () => 'new-session-123',
      onExit: () => {},
    };
    service = new DashboardService(mockCtx);
  });

  it('should get config info', async () => {
    const config = await service.getConfig();
    expect(config.model).toBe('test-model');
    expect(config.provider).toBe('test-provider');
    expect(config.baseUrl).toBe('http://test.com');
  });

  it('should get session info', async () => {
    const session = await service.getSession();
    expect(session.sessionId).toBe('test-session-123');
  });

  it('should get health status', async () => {
    const health = await service.getHealth();
    expect(health.status).toBe('healthy');
    expect(health.uptime).toBeGreaterThanOrEqual(0);
    expect(health.memoryUsage).toBeGreaterThan(0);
  });

  it('should get assets', async () => {
    const assets = await service.getAssets();
    expect(assets.plugins).toHaveLength(2);
    expect(assets.tools).toHaveLength(1);
    expect(assets.tools[0]?.name).toBe('test-tool');
    expect(assets.mcpServers).toHaveLength(0);
  });

  it('should infer MCP servers from tool names', async () => {
    // Mock tools with MCP naming convention
    mockCtx.tools = {
      list: () => [
        {
          name: 'mcp__filesystem__read_file',
          description: 'Read file',
          inputSchema: {},
          // biome-ignore lint/suspicious/noExplicitAny: mock object for testing
          handler: (() => {}) as any,
        },
        {
          name: 'mcp__filesystem__write_file',
          description: 'Write file',
          inputSchema: {},
          // biome-ignore lint/suspicious/noExplicitAny: mock object for testing
          handler: (() => {}) as any,
        },
        {
          name: 'mcp__github__create_issue',
          description: 'Create issue',
          inputSchema: {},
          // biome-ignore lint/suspicious/noExplicitAny: mock object for testing
          handler: (() => {}) as any,
        },
        {
          name: 'test-tool',
          description: 'Regular tool',
          inputSchema: {},
          // biome-ignore lint/suspicious/noExplicitAny: mock object for testing
          handler: (() => {}) as any,
        },
      ],
      // biome-ignore lint/suspicious/noExplicitAny: mock object for testing
      register: (() => {}) as any,
      // biome-ignore lint/suspicious/noExplicitAny: mock object for testing
      invoke: (() => {}) as any,
      schemas: () => [],
      get: () => undefined,
      has: () => false,
    };
    const service = new DashboardService(mockCtx);
    const assets = await service.getAssets();
    expect(assets.mcpServers).toHaveLength(2);
    expect(assets.mcpServers.map((s) => s.name)).toContain('filesystem');
    expect(assets.mcpServers.map((s) => s.name)).toContain('github');
    expect(assets.mcpServers.find((s) => s.name === 'filesystem')?.tools).toBe(2);
    expect(assets.mcpServers.find((s) => s.name === 'github')?.tools).toBe(1);
    expect(assets.tools).toHaveLength(4);
  });

  it('should get tool info', async () => {
    const tools = await service.getTools();
    expect(tools.registered).toBe(1);
  });

  it('should get full data', async () => {
    const data = await service.getFullData();
    expect(data.config).toBeDefined();
    expect(data.session).toBeDefined();
    expect(data.health).toBeDefined();
    expect(data.assets).toBeDefined();
    expect(data.tools).toBeDefined();
  });
});
