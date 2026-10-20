import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  AgentRuntime,
  createStderrLogger,
  type LLMProvider,
  type Logger,
  MemoryContextManager,
  MemoryEventStream,
  MemoryLLMProvider,
  MemoryPluginHost,
  MemorySessionBackend,
} from '../src/index';

async function createRuntime(provider: LLMProvider, logger?: Logger): Promise<AgentRuntime> {
  return AgentRuntime.create({
    provider,
    model: 'test-model',
    pluginHost: new MemoryPluginHost(),
    context: new MemoryContextManager(),
    events: new MemoryEventStream(),
    limits: { requestLimit: 10, toolCallsLimit: 5 },
    termination: { maxIterations: 10 },
    session: new MemorySessionBackend(),
    ...(logger !== undefined ? { logger } : {}),
  });
}

/** 收集写入的行（write 的 chunk 可能是 string / Buffer） */
function linesOf(calls: unknown[][]): string[] {
  return calls.map((args) => String(args[0]));
}

describe('createStderrLogger (0.10 R2-14)', () => {
  it('writes structured JSON to stderr and filters by level', () => {
    const stderr = spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    try {
      const logger = createStderrLogger({ level: 'info' });
      logger.debug('hidden');
      logger.info('visible', { run_id: 'r1', count: 2 });

      const lines = linesOf(stderr.mock.calls);
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
      expect(parsed.level).toBe('info');
      expect(parsed.message).toBe('visible');
      expect(parsed.fields).toEqual({ run_id: 'r1', count: 2 });
      expect(typeof parsed.time).toBe('string');
    } finally {
      stderr.mockRestore();
    }
  });

  it('redacts message and fields with the trace redactor', () => {
    const stderr = spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    try {
      const logger = createStderrLogger();
      logger.info('got sk-abcdef123456 from upstream', {
        authorization: 'Bearer abcdefghijklmnop',
        note: 'payload eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk',
        aws: 'AKIAIOSFODNN7EXAMPLE',
        normal: 'keep-me',
      });

      const line = linesOf(stderr.mock.calls)[0] as string;
      expect(line).not.toContain('sk-abcdef123456');
      expect(line).not.toContain('abcdefghijklmnop');
      expect(line).not.toContain('eyJhbGciOiJIUzI1NiJ9');
      expect(line).not.toContain('AKIAIOSFODNN7EXAMPLE');
      const parsed = JSON.parse(line) as { message: string; fields: Record<string, unknown> };
      expect(parsed.message).toBe('***');
      expect(parsed.fields.authorization).toBe('***');
      expect(parsed.fields.note).toBe('***');
      expect(parsed.fields.aws).toBe('***');
      expect(parsed.fields.normal).toBe('keep-me');
    } finally {
      stderr.mockRestore();
    }
  });

  it('can opt out of redaction and survives sink failures', () => {
    const stderr = spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    try {
      createStderrLogger({ redact: false }).info('sk-abcdef123456');
      expect(linesOf(stderr.mock.calls)[0]).toContain('sk-abcdef123456');
    } finally {
      stderr.mockRestore();
    }

    const failing = spyOn(process.stderr, 'write').mockImplementation(() => {
      throw new Error('sink down');
    });
    try {
      expect(() => createStderrLogger().error('boom')).not.toThrow();
    } finally {
      failing.mockRestore();
    }
  });
});

describe('VESSEL_DEBUG logging (0.10 R2-13)', () => {
  const previous = process.env.VESSEL_DEBUG;

  afterEach(() => {
    if (previous === undefined) delete process.env.VESSEL_DEBUG;
    else process.env.VESSEL_DEBUG = previous;
  });

  it('writes metadata to stderr instead of the prompt to stdout', async () => {
    process.env.VESSEL_DEBUG = '1';
    const stdout = spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
    const stderr = spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    const consoleLog = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const runtime = await createRuntime(new MemoryLLMProvider());
      await runtime.run('PROMPT-BODY-XYZZY');

      expect(stdout.mock.calls).toHaveLength(0);
      expect(consoleLog.mock.calls).toHaveLength(0);
      const output = linesOf(stderr.mock.calls).join('\n');
      expect(output).toContain('llm request');
      expect(output).toContain('message_count');
      expect(output).toContain('estimated_tokens');
      // 正文绝不能出现在 debug 输出里
      expect(output).not.toContain('PROMPT-BODY-XYZZY');
      expect(output).not.toContain('Echo: PROMPT');
    } finally {
      consoleLog.mockRestore();
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it('does not log when no logger is injected and VESSEL_DEBUG is unset', async () => {
    delete process.env.VESSEL_DEBUG;
    const stdout = spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
    const stderr = spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    const consoleLog = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const runtime = await createRuntime(new MemoryLLMProvider());
      await runtime.run('quiet');
      expect(stdout.mock.calls).toHaveLength(0);
      expect(stderr.mock.calls).toHaveLength(0);
      expect(consoleLog.mock.calls).toHaveLength(0);
    } finally {
      consoleLog.mockRestore();
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});
