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
