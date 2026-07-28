import { beforeEach, describe, expect, it } from 'bun:test';
import { MemoryLimitChecker } from '../src/limits/limit-checker';
import type { TerminationPolicy, UsageLimits, UsageStats } from '../src/types/limits';

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
