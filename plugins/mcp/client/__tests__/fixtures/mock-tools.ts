/**
 * 测试 fixture 共用工具集（stdio 与 HTTP mock server 共享）。
 */

export interface MockTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MockCallResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export const MOCK_TOOLS: MockTool[] = [
  {
    name: 'echo',
    description: 'Echo the arguments as JSON',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
    },
  },
  {
    name: 'add',
    description: 'Add two numbers',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
  {
    name: 'fail',
    description: 'Always return a tool-level error',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'slow',
    description: 'Return after a delay',
    inputSchema: { type: 'object', properties: {} },
  },
];

/** 未知工具返回 undefined；slow 由调用方处理延迟 */
export function callMockTool(name: string, args: unknown): MockCallResult | undefined {
  const record =
    typeof args === 'object' && args !== null && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};

  if (name === 'echo') {
    return { content: [{ type: 'text', text: JSON.stringify(record) }] };
  }
  if (name === 'add') {
    const a = Number(record.a);
    const b = Number(record.b);
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      return { content: [{ type: 'text', text: 'Error: a and b must be numbers' }], isError: true };
    }
    return { content: [{ type: 'text', text: String(a + b) }] };
  }
  if (name === 'fail') {
    return { content: [{ type: 'text', text: 'boom' }], isError: true };
  }
  return undefined;
}

/** slow 工具名 */
export const SLOW_TOOL = 'slow';

/** 是否为已知工具 */
export function isMockToolName(name: string): boolean {
  return MOCK_TOOLS.some((tool) => tool.name === name);
}
