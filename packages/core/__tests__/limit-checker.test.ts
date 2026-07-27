import { beforeEach, describe, expect, it } from 'bun:test';
import { MemoryLimitChecker } from '../src/limits/limit-checker';
import type { TerminationPolicy, UsageLimits, UsageStats } from '../src/types/limits';

describe('MemoryLimitChecker', () => {
  let checker: MemoryLimitChecker;
  let stats: UsageStats;

  beforeEach(() => {
    checker = new MemoryLimitChecker();
    stats = {
      request_count: 0,
      tool_calls_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      total_cost: 0,
      start_time: Date.now(),
    };
  });

  describe('checkLimits', () => {
    it('should return true when within limits', () => {
      const limits: UsageLimits = {
        request_limit: 10,
        tool_calls_limit: 5,
      };

      expect(checker.checkLimits(stats, limits)).toBe(true);
    });

    it('should return false when request limit exceeded', () => {
      const limits: UsageLimits = {
        request_limit: 10,
      };

      stats.request_count = 10;
      expect(checker.checkLimits(stats, limits)).toBe(false);
    });

    it('should return false when tool calls limit exceeded', () => {
      const limits: UsageLimits = {
        tool_calls_limit: 5,
      };

      stats.tool_calls_count = 5;
      expect(checker.checkLimits(stats, limits)).toBe(false);
    });

    it('should return false when token limit exceeded', () => {
      const limits: UsageLimits = {
        input_tokens_limit: 1000,
      };

      stats.input_tokens = 1000;
      expect(checker.checkLimits(stats, limits)).toBe(false);
    });

    it('should return false when cost limit exceeded', () => {
      const limits: UsageLimits = {
        total_cost_limit: 10.0,
      };

      stats.total_cost = 10.0;
      expect(checker.checkLimits(stats, limits)).toBe(false);
    });
  });

  describe('checkTermination', () => {
    it('should return true when max iterations reached', () => {
      const policy: TerminationPolicy = {
        max_iterations: 10,
      };

      stats.request_count = 10;
      expect(checker.checkTermination(stats, policy)).toBe(true);
    });

    it('should return false when within limits', () => {
      const policy: TerminationPolicy = {
        max_iterations: 10,
      };

      stats.request_count = 5;
      expect(checker.checkTermination(stats, policy)).toBe(false);
    });

    it('should return true when max runtime exceeded', () => {
      const policy: TerminationPolicy = {
        max_iterations: 100,
        max_runtime_seconds: 1,
      };

      stats.start_time = Date.now() - 2000; // 2 seconds ago
      expect(checker.checkTermination(stats, policy)).toBe(true);
    });
  });

  describe('increment and add methods', () => {
    it('should increment request count', () => {
      checker.incrementRequest(stats);
      expect(stats.request_count).toBe(1);

      checker.incrementRequest(stats);
      expect(stats.request_count).toBe(2);
    });

    it('should increment tool call count', () => {
      checker.incrementToolCall(stats);
      expect(stats.tool_calls_count).toBe(1);

      checker.incrementToolCall(stats);
      expect(stats.tool_calls_count).toBe(2);
    });

    it('should add tokens', () => {
      checker.addTokens(stats, 100, 50);

      expect(stats.input_tokens).toBe(100);
      expect(stats.output_tokens).toBe(50);
      expect(stats.total_tokens).toBe(150);
    });

    it('should add cost', () => {
      checker.addCost(stats, 0.5);
      expect(stats.total_cost).toBe(0.5);

      checker.addCost(stats, 0.3);
      expect(stats.total_cost).toBe(0.8);
    });
  });
});
