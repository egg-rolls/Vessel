/**
 * 工具执行权限确认
 * @module @vessel/tui
 */

import * as readline from 'node:readline';
import type { Guardrail, GuardrailContext, GuardrailResult } from '@vessel/core';
import { GuardrailStage } from '@vessel/core';

/** 权限确认配置 */
export interface ToolPermissionConfig {
  /** 是否启用权限确认 */
  enabled?: boolean;
  /** 需要确认的工具列表（为空则全部确认） */
  tools?: string[];
  /** 自动批准的工具列表 */
  autoApprove?: string[];
  /** 确认超时时间（秒） */
  timeout?: number;
}

/** 权限确认结果 */
export interface PermissionResult {
  approved: boolean;
  remember?: boolean;
}

/** 默认配置 */
const DEFAULT_CONFIG: ToolPermissionConfig = {
  enabled: true,
  tools: [],
  autoApprove: [],
  timeout: 30,
};

/**
 * 工具权限确认器
 */
export class ToolPermissionChecker {
  private config: ToolPermissionConfig;
  private approvedTools: Set<string> = new Set();
  /**
   * 自定义 prompt 函数。REPL 注入以复用其 readline--避免 confirm 自建第二个
   * readline 抢 stdin 导致用户的 y/n 泄漏进对话上下文。未注入时退回自建 readline。
   */
  promptFn?: (question: string) => Promise<string>;

  constructor(config: ToolPermissionConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 检查是否需要确认
   */
  needsConfirmation(toolName: string): boolean {
    if (!this.config.enabled) {
      return false;
    }

    // 检查是否已批准
    if (this.approvedTools.has(toolName)) {
      return false;
    }

    // 检查是否在自动批准列表中
    if (this.config.autoApprove?.includes(toolName)) {
      return false;
    }

    // 如果指定了工具列表，只确认列表中的工具
    if (this.config.tools && this.config.tools.length > 0) {
      return this.config.tools.includes(toolName);
    }

    // 默认全部需要确认
    return true;
  }

  /**
   * 请求用户确认
   */
  async confirm(toolName: string, args: unknown): Promise<PermissionResult> {
    if (!this.needsConfirmation(toolName)) {
      return { approved: true };
    }

    console.log(`\n${'='.repeat(50)}`);
    console.log('🔧 Tool Execution Request');
    console.log('='.repeat(50));
    console.log(`Tool: ${toolName}`);
    console.log(`Arguments: ${JSON.stringify(args, null, 2)}`);
    console.log('='.repeat(50));

    const answer = await this.prompt('\nAllow execution? (y/n/always): ');
    const normalized = answer.toLowerCase().trim();

    if (normalized === 'always') {
      this.approvedTools.add(toolName);
      return { approved: true, remember: true };
    }

    return { approved: normalized === 'y' || normalized === 'yes' };
  }

  /**
   * 提示用户输入。注入了 promptFn（REPL 复用其 readline）时用之；否则自建 readline。
   */
  private prompt(question: string): Promise<string> {
    if (this.promptFn) {
      return this.promptFn(question);
    }
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });

      // 超时处理
      if (this.config.timeout) {
        setTimeout(() => {
          rl.close();
          console.log('\nTimeout - auto-denied');
          resolve('n');
        }, this.config.timeout * 1000);
      }
    });
  }

  /**
   * 重置已批准的工具
   */
  resetApprovals(): void {
    this.approvedTools.clear();
  }

  /**
   * 获取已批准的工具列表
   */
  getApprovedTools(): string[] {
    return Array.from(this.approvedTools);
  }
}

/**
 * 创建权限确认 Guardrail
 * 用于在工具执行前进行权限确认。
 * 返回符合 core Guardrail 接口的对象——可由 PluginHost.registerGuardrail 注册。
 */
export function createPermissionGuardrail(
  checker: ToolPermissionChecker,
  autoApprove: string[] = [],
): Guardrail {
  return {
    name: 'tool-permission',
    stage: GuardrailStage.ToolCall,
    priority: 10, // 其他 ToolCall guardrail 之前执行
    check: async (value: unknown, _ctx: GuardrailContext): Promise<GuardrailResult> => {
      if (typeof value === 'object' && value !== null) {
        const toolCall = value as { function?: { name?: string; arguments?: string } };
        const toolName = toolCall.function?.name;
        if (toolName) {
          // autoApprove 列表中的工具跳过确认
          if (autoApprove.includes(toolName)) {
            return { allowed: true };
          }

          const args = toolCall.function?.arguments ? JSON.parse(toolCall.function.arguments) : {};

          const result = await checker.confirm(toolName, args);

          if (!result.approved) {
            return {
              allowed: false,
              reason: 'Tool execution denied by user',
            };
          }
        }
      }
      return { allowed: true };
    },
  };
}
