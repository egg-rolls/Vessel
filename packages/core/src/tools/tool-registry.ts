/**
 * ToolRegistry 实现
 * @module @vessel/core/tools
 */

import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolRegistry,
  ToolSchema,
} from '../types/tool.js';

/**
 * 内存工具注册表实现
 */
export class MemoryToolRegistry implements ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  /**
   * 注册工具
   * @param def 工具定义
   * @throws 如果工具名已存在则抛出错误
   */
  register(def: ToolDefinition): void {
    if (this.tools.has(def.name)) {
      throw new Error(`Tool "${def.name}" is already registered`);
    }
    this.tools.set(def.name, def);
  }

  /**
   * 调用工具
   * @param call 工具调用请求
   * @param ctx 工具上下文
   * @returns 工具执行结果
   * @throws 如果工具不存在或执行失败
   */
  async invoke(call: ToolCall, ctx: ToolContext): Promise<string> {
    const tool = this.tools.get(call.function.name);
    if (!tool) {
      throw new Error(`Tool "${call.function.name}" not found`);
    }

    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments);
    } catch {
      throw new Error(
        `Invalid arguments for tool "${call.function.name}": ${call.function.arguments}`,
      );
    }

    // 如果设置了超时，使用 Promise.race 实现超时
    if (tool.timeout && tool.timeout > 0) {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`Tool "${call.function.name}" timed out after ${tool.timeout}ms`)),
          tool.timeout,
        );
      });
      return Promise.race([tool.handler(args, ctx), timeoutPromise]);
    }

    return tool.handler(args, ctx);
  }

  /**
   * 获取所有工具的 schema（用于 LLM）
   * @returns 工具 schema 数组
   */
  schemas(): ToolSchema[] {
    return Array.from(this.tools.values()).map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }

  /**
   * 获取工具定义
   * @param name 工具名称
   * @returns 工具定义或 undefined
   */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * 检查工具是否存在
   * @param name 工具名称
   * @returns 是否存在
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * 列出所有工具
   * @returns 工具定义数组
   */
  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * 获取工具数量
   */
  get size(): number {
    return this.tools.size;
  }
}

export type { ToolContext, ToolDefinition, ToolRegistry, ToolSchema };
