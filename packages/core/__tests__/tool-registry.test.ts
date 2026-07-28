import { beforeEach, describe, expect, it } from 'bun:test';
import { MemoryToolRegistry } from '../src/tools/tool-registry';
import type { ToolDefinition } from '../src/types/tool';

describe('MemoryToolRegistry', () => {
  let registry: MemoryToolRegistry;

  beforeEach(() => {
    registry = new MemoryToolRegistry();
  });

  const createTool = (name: string): ToolDefinition => ({
    name,
    description: `Test tool ${name}`,
    inputSchema: { type: 'object', properties: {} },
    handler: async () => `Result from ${name}`,
  });

  it('should register and retrieve tools', () => {
    const tool = createTool('test-tool');
    registry.register(tool);

    expect(registry.has('test-tool')).toBe(true);
    expect(registry.get('test-tool')).toEqual(tool);
  });

  it('should list all tools', () => {
    const tool1 = createTool('tool-1');
    const tool2 = createTool('tool-2');

    registry.register(tool1);
    registry.register(tool2);

    const tools = registry.list();
    expect(tools).toHaveLength(2);
    expect(tools).toContain(tool1);
    expect(tools).toContain(tool2);
  });

  it('should generate schemas for LLM', () => {
    const tool = createTool('test-tool');
    registry.register(tool);

    const schemas = registry.schemas();
    expect(schemas).toHaveLength(1);
    expect(schemas[0]).toEqual({
      type: 'function',
      function: {
        name: 'test-tool',
        description: 'Test tool test-tool',
        parameters: { type: 'object', properties: {} },
      },
    });
  });

  it('should invoke tools', async () => {
    const tool = createTool('test-tool');
    registry.register(tool);

    const result = await registry.invoke(
      {
        id: 'call-1',
        type: 'function',
        function: {
          name: 'test-tool',
          arguments: '{}',
        },
      },
      {
        run_id: 'run-1',
        messages: [],
      },
    );

    expect(result).toBe('Result from test-tool');
  });

  it('should throw on duplicate registration', () => {
    const tool = createTool('test-tool');
    registry.register(tool);

    expect(() => registry.register(tool)).toThrow('Tool "test-tool" is already registered');
  });

  it('should throw on missing tool invocation', async () => {
    await expect(
      registry.invoke(
        {
          id: 'call-1',
          type: 'function',
          function: {
            name: 'missing-tool',
            arguments: '{}',
          },
        },
        {
          run_id: 'run-1',
          messages: [],
        },
      ),
    ).rejects.toThrow('Tool "missing-tool" not found');
  });

  it('should report tool count', () => {
    expect(registry.size).toBe(0);

    registry.register(createTool('tool-1'));
    expect(registry.size).toBe(1);

    registry.register(createTool('tool-2'));
    expect(registry.size).toBe(2);
  });
});
