/**
 * Web Search Plugin Tests
 */

import type { PluginHost, ToolDefinition } from '@vessel/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebSearchPlugin } from '../index.js';

describe('Web Search Plugin', () => {
  let mockHost: PluginHost;
  let registeredTools: ToolDefinition[];

  beforeEach(() => {
    registeredTools = [];
    mockHost = {
      registerTool: vi.fn((tool: ToolDefinition) => {
        registeredTools.push(tool);
      }),
      registerProvider: vi.fn(),
      registerGuardrail: vi.fn(),
      registerHook: vi.fn(),
      getTool: vi.fn(),
      getProvider: vi.fn(),
      getGuardrails: vi.fn().mockReturnValue([]),
      getHooks: vi.fn().mockReturnValue([]),
      listTools: vi.fn().mockReturnValue([]),
      listProviders: vi.fn().mockReturnValue([]),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Plugin Registration', () => {
    it('should register web-search tool with correct properties', () => {
      const plugin = createWebSearchPlugin({ apiKey: 'test-key' });
      plugin.install(mockHost);

      expect(mockHost.registerTool).toHaveBeenCalledTimes(1);
      expect(registeredTools).toHaveLength(1);

      const tool = registeredTools[0];
      expect(tool.name).toBe('web-search');
      expect(tool.description).toContain('web search');
      expect(tool.default).toBe(true);
      expect(tool.timeout).toBe(30000);
    });

    it('should have correct input schema', () => {
      const plugin = createWebSearchPlugin({ apiKey: 'test-key' });
      plugin.install(mockHost);

      const tool = registeredTools[0];
      expect(tool.inputSchema).toEqual({
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query to find information about',
          },
          max_results: {
            type: 'number',
            description: 'Maximum number of results to return (default: 5)',
            minimum: 1,
            maximum: 20,
          },
        },
        required: ['query'],
      });
    });
  });

  describe('API Key Configuration', () => {
    it('should use config apiKey when provided', () => {
      const plugin = createWebSearchPlugin({ apiKey: 'config-key' });
      plugin.install(mockHost);

      expect(registeredTools).toHaveLength(1);
    });

    it('should use environment variable when config not provided', () => {
      process.env.VESSEL_WEB_SEARCH_API_KEY = 'env-key';
      const plugin = createWebSearchPlugin();
      plugin.install(mockHost);

      expect(registeredTools).toHaveLength(1);
      delete process.env.VESSEL_WEB_SEARCH_API_KEY;
    });

    it('should use TAVILY_API_KEY as fallback', () => {
      process.env.TAVILY_API_KEY = 'tavily-key';
      const plugin = createWebSearchPlugin();
      plugin.install(mockHost);

      expect(registeredTools).toHaveLength(1);
      delete process.env.TAVILY_API_KEY;
    });
  });

  describe('Tool Handler', () => {
    it('should return error when no API key configured', async () => {
      const plugin = createWebSearchPlugin();
      plugin.install(mockHost);

      const tool = registeredTools[0];
      const result = await tool.handler({ query: 'test' }, { run_id: 'test-run', messages: [] });

      expect(result).toContain('No API key configured');
    });

    it('should return error for empty query', async () => {
      const plugin = createWebSearchPlugin({ apiKey: 'test-key' });
      plugin.install(mockHost);

      const tool = registeredTools[0];
      const result = await tool.handler({ query: '' }, { run_id: 'test-run', messages: [] });

      expect(result).toContain('Query cannot be empty');
    });

    it('should return error for whitespace-only query', async () => {
      const plugin = createWebSearchPlugin({ apiKey: 'test-key' });
      plugin.install(mockHost);

      const tool = registeredTools[0];
      const result = await tool.handler({ query: '   ' }, { run_id: 'test-run', messages: [] });

      expect(result).toContain('Query cannot be empty');
    });

    it('should call Tavily API with correct parameters', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          results: [
            {
              title: 'Test Result',
              url: 'https://example.com',
              content: 'Test content',
              score: 0.95,
            },
          ],
          query: 'test query',
        }),
      });

      globalThis.fetch = mockFetch;

      const plugin = createWebSearchPlugin({ apiKey: 'test-key' });
      plugin.install(mockHost);

      const tool = registeredTools[0];
      await tool.handler(
        { query: 'test query', max_results: 3 },
        { run_id: 'test-run', messages: [] },
      );

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.tavily.com/search',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: expect.stringContaining('"query":"test query"'),
        }),
      );
    });

    it('should format search results correctly', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          results: [
            {
              title: 'Test Result',
              url: 'https://example.com',
              content: 'Test content',
              score: 0.95,
            },
          ],
          answer: 'Test answer',
          query: 'test query',
        }),
      });

      globalThis.fetch = mockFetch;

      const plugin = createWebSearchPlugin({ apiKey: 'test-key' });
      plugin.install(mockHost);

      const tool = registeredTools[0];
      const result = await tool.handler(
        { query: 'test query' },
        { run_id: 'test-run', messages: [] },
      );

      expect(result).toContain('## Answer');
      expect(result).toContain('Test answer');
      expect(result).toContain('## Search Results');
      expect(result).toContain('Test Result');
      expect(result).toContain('https://example.com');
    });

    it('should handle API errors gracefully', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: vi.fn().mockResolvedValue('Unauthorized'),
      });

      globalThis.fetch = mockFetch;

      const plugin = createWebSearchPlugin({ apiKey: 'invalid-key' });
      plugin.install(mockHost);

      const tool = registeredTools[0];
      const result = await tool.handler({ query: 'test' }, { run_id: 'test-run', messages: [] });

      expect(result).toContain('Error performing web search');
      expect(result).toContain('401');
    });

    it('should handle network errors gracefully', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));

      globalThis.fetch = mockFetch;

      const plugin = createWebSearchPlugin({ apiKey: 'test-key' });
      plugin.install(mockHost);

      const tool = registeredTools[0];
      const result = await tool.handler({ query: 'test' }, { run_id: 'test-run', messages: [] });

      expect(result).toContain('Error performing web search');
      expect(result).toContain('Network error');
    });

    it('should use custom baseUrl when provided', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          results: [],
          query: 'test',
        }),
      });

      globalThis.fetch = mockFetch;

      const plugin = createWebSearchPlugin({
        apiKey: 'test-key',
        baseUrl: 'https://custom-api.example.com/search',
      });
      plugin.install(mockHost);

      const tool = registeredTools[0];
      await tool.handler({ query: 'test' }, { run_id: 'test-run', messages: [] });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://custom-api.example.com/search',
        expect.any(Object),
      );
    });
  });
});
