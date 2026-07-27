# 测试指南

## 哲学

- 每模块配单测（CLAUDE.md §4）
- 测试不依赖真实 LLM API（用 `MemoryLLMProvider`）
- 不依赖外部服务（数据库用 SQLite in-memory）
- 快速、可并行、确定性

## 测试命令

```bash
bun test                          # 全部
bun test packages/core            # 仅 core
bun test --watch                  # watch 模式
bun test --coverage               # 覆盖率
```

## 测试结构

```
packages/core/__tests__/
├── agent-runtime.test.ts    # AgentRuntime 集成
├── context-manager.test.ts  # 上下文管理
├── event-stream.test.ts     # 事件流
├── limit-checker.test.ts    # 限制检查
├── plugin-host.test.ts      # 插件宿主
├── provider.test.ts         # LLM Provider
├── session-backend.test.ts  # 会话后端
└── tool-registry.test.ts    # 工具注册表
```

## 写测试的规则

### 1. 用 `bun:test`

```typescript
import { describe, it, expect, beforeEach } from 'bun:test';
```

### 2. MemoryXxx 优先

不 mock 外部 API，用内置的 Memory 实现：

```typescript
const provider = new MemoryLLMProvider();       // 而非 mock fetch
const session = new MemorySessionBackend();      // 而非 mock 数据库
```

### 3. 测试结构

```typescript
describe('AgentRuntime', () => {
  let runtime: AgentRuntime;

  beforeEach(() => {
    // 每个 test 独立的干净状态
    runtime = new AgentRuntime({ ... });
  });

  it('should handle simple text response', async () => {
    const response = await runtime.run('Hello');
    expect(response).toBe('Echo: Hello');
  });

  it('should handle tool calls', async () => {
    // 注册工具 → 构造带 tool_calls 的响应 → 验证工具被调用
  });

  it('should handle errors gracefully', async () => {
    // 注入错误场景 → 验证错误事件和状态
  });
});
```

### 4. 覆盖要求

| 层级 | 要求 |
|------|------|
| 类型定义 | 不需要测试 |
| 纯逻辑工具 | 每个 handler 分支至少一个 case |
| Runtime 核心路径 | 正常 / 错误 / 边界（空输入、超限） |
| 插件 | 每个插件至少一个集成测试 |

### 5. 不要做的

- ❌ 调用真实 LLM API
- ❌ 依赖网络/文件系统（除非模块本就处理 FS）
- ❌ 测试间共享可变状态
- ❌ 用 `setTimeout` 等不确定性的等待（用 Memory 实现替代）
