import { beforeEach, describe, expect, it } from 'bun:test';
import {
  evaluateTermination,
  evaluateUsageLimits,
  MemoryLimitChecker,
} from '../src/limits/limit-checker';
import type { TerminationPolicy, UsageLimits, UsageStats } from '../src/types/limits';

describe('evaluateUsageLimits', () => {
  let stats: UsageStats;

  beforeEach(() => {
    stats = {
      requestCount: 0,
      toolCallsCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalCost: 0,
      startTime: Date.now(),
    };
  });

  it('reports the tripped key, current/max, source and hint for every limit', () => {
    const cases: Array<{
      stats: Partial<UsageStats>;
      limits: UsageLimits;
      key: string;
      current: number;
      max: number;
      source: string;
    }> = [
      {
        stats: { requestCount: 3 },
        limits: { requestLimit: 3 },
        key: 'request_limit',
        current: 3,
        max: 3,
        source: 'limits.requestLimit',
      },
      {
        stats: { toolCallsCount: 4 },
        limits: { toolCallsLimit: 4 },
        key: 'tool_calls_limit',
        current: 4,
        max: 4,
        source: 'limits.toolCallsLimit',
      },
      {
        stats: { inputTokens: 100235 },
        limits: { inputTokensLimit: 100000 },
        key: 'input_tokens_limit',
        current: 100235,
        max: 100000,
        source: 'limits.inputTokensLimit',
      },
      {
        stats: { outputTokens: 500 },
        limits: { outputTokensLimit: 500 },
        key: 'output_tokens_limit',
        current: 500,
        max: 500,
        source: 'limits.outputTokensLimit',
      },
      {
        stats: { totalCost: 1.5 },
        limits: { totalCostLimit: 1.5 },
        key: 'total_cost_limit',
        current: 1.5,
        max: 1.5,
        source: 'limits.totalCostLimit',
      },
    ];

    const base = { ...stats };
    for (const testCase of cases) {
      stats = { ...base, ...testCase.stats };
      const block = evaluateUsageLimits(stats, testCase.limits);
      expect(block).toMatchObject({
        scope: 'run',
        key: testCase.key,
        current: testCase.current,
        max: testCase.max,
        source: testCase.source,
        retryable: false,
      });
      expect(typeof block?.hint).toBe('string');
      expect(block?.hint.length).toBeGreaterThan(0);
    }
  });

  it('returns null within limits and reports the first tripped key when several are exceeded', () => {
    expect(evaluateUsageLimits(stats, { requestLimit: 10 })).toBeNull();

    stats.requestCount = 5;
    stats.toolCallsCount = 5;
    expect(evaluateUsageLimits(stats, { requestLimit: 5, toolCallsLimit: 5 })?.key).toBe(
      'request_limit',
    );
  });
});

describe('evaluateTermination', () => {
  let stats: UsageStats;

  beforeEach(() => {
    stats = {
      requestCount: 0,
      toolCallsCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalCost: 0,
      startTime: Date.now(),
    };
  });

  it('reports max_iterations with source and max when requests reach the cap', () => {
    stats.requestCount = 50;

    expect(evaluateTermination(stats, { maxIterations: 50 })).toMatchObject({
      scope: 'run',
      key: 'max_iterations',
      current: 50,
      max: 50,
      source: 'termination.maxIterations',
      retryable: false,
    });
    expect(evaluateTermination(stats, { maxIterations: 50 })?.hint.length).toBeGreaterThan(0);
  });

  it('reports max_runtime with source and elapsed seconds', () => {
    stats.startTime = Date.now() - 2000;

    const block = evaluateTermination(stats, { maxIterations: 100, maxRuntimeSeconds: 1 });
    expect(block).toMatchObject({
      scope: 'run',
      key: 'max_runtime',
      max: 1,
      source: 'termination.maxRuntimeSeconds',
      retryable: false,
    });
    expect(block?.current).toBeGreaterThanOrEqual(1);
    expect(block?.hint.length).toBeGreaterThan(0);
  });

  it('returns null within budget and checks iterations before runtime', () => {
    expect(evaluateTermination(stats, { maxIterations: 10 })).toBeNull();

    stats.requestCount = 10;
    stats.startTime = Date.now() - 5000;
    expect(evaluateTermination(stats, { maxIterations: 10, maxRuntimeSeconds: 1 })?.key).toBe(
      'max_iterations',
    );
  });
});

describe('MemoryLimitChecker', () => {
  let checker: MemoryLimitChecker;
  let stats: UsageStats;

  beforeEach(() => {
    checker = new MemoryLimitChecker();
    stats = {
      requestCount: 0,
      toolCallsCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalCost: 0,
      startTime: Date.now(),
    };
  });

  describe('checkLimits', () => {
    it('should return true when within limits', () => {
      const limits: UsageLimits = {
        requestLimit: 10,
        toolCallsLimit: 5,
      };

      expect(checker.checkLimits(stats, limits)).toBe(true);
    });

    it('should return false when request limit exceeded', () => {
      const limits: UsageLimits = {
        requestLimit: 10,
      };

      stats.requestCount = 10;
      expect(checker.checkLimits(stats, limits)).toBe(false);
    });

    it('should return false when tool calls limit exceeded', () => {
      const limits: UsageLimits = {
        toolCallsLimit: 5,
      };

      stats.toolCallsCount = 5;
      expect(checker.checkLimits(stats, limits)).toBe(false);
    });

    it('should return false when token limit exceeded', () => {
      const limits: UsageLimits = {
        inputTokensLimit: 1000,
      };

      stats.inputTokens = 1000;
      expect(checker.checkLimits(stats, limits)).toBe(false);
    });

    it('should return false when cost limit exceeded', () => {
      const limits: UsageLimits = {
        totalCostLimit: 10.0,
      };

      stats.totalCost = 10.0;
      expect(checker.checkLimits(stats, limits)).toBe(false);
    });
  });

  describe('checkTermination', () => {
    it('should return true when max iterations reached', () => {
      const policy: TerminationPolicy = {
        maxIterations: 10,
      };

      stats.requestCount = 10;
      expect(checker.checkTermination(stats, policy)).toBe(true);
    });

    it('should return false when within limits', () => {
      const policy: TerminationPolicy = {
        maxIterations: 10,
      };

      stats.requestCount = 5;
      expect(checker.checkTermination(stats, policy)).toBe(false);
    });

    it('should return true when max runtime exceeded', () => {
      const policy: TerminationPolicy = {
        maxIterations: 100,
        maxRuntimeSeconds: 1,
      };

      stats.startTime = Date.now() - 2000; // 2 seconds ago
      expect(checker.checkTermination(stats, policy)).toBe(true);
    });
  });

  describe('increment and add methods', () => {
    it('should increment request count', () => {
      checker.incrementRequest(stats);
      expect(stats.requestCount).toBe(1);

      checker.incrementRequest(stats);
      expect(stats.requestCount).toBe(2);
    });

    it('should increment tool call count', () => {
      checker.incrementToolCall(stats);
      expect(stats.toolCallsCount).toBe(1);

      checker.incrementToolCall(stats);
      expect(stats.toolCallsCount).toBe(2);
    });

    it('should add tokens', () => {
      checker.addTokens(stats, 100, 50);

      expect(stats.inputTokens).toBe(100);
      expect(stats.outputTokens).toBe(50);
      expect(stats.totalTokens).toBe(150);
    });

    it('should add cost', () => {
      checker.addCost(stats, 0.5);
      expect(stats.totalCost).toBe(0.5);

      checker.addCost(stats, 0.3);
      expect(stats.totalCost).toBe(0.8);
    });
  });
});
