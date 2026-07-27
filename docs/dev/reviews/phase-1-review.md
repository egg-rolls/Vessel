# Phase 1 代码审查报告

> 审查范围：`feature/phase-1` 合并后的全部 TypeScript 源码（54 文件，约 8800 行）
> 审查日期：2026-07-27
> 审查标准：SPEC / ADR / CLAUDE.md §4-6 / 专业 TypeScript 工程规范

## 一、总体评分

| 维度 | 评分 | 说明 |
|------|------|------|
| 架构符合度 | ⭐⭐⭐⭐⭐ | 三层架构、Plugin+PluginHost、EventType 枚举均正确 |
| 类型安全 | ⭐⭐⭐⭐ | 类型系统完整，部分 unknown 滥用 |
| 错误处理 | ⭐⭐⭐ | 基本覆盖，异步错误吞没问题 |
| 测试覆盖 | ⭐⭐⭐⭐ | 7 个测试文件，覆盖核心路径 |
| 代码干净度 | ⭐⭐⭐ | 调试日志散落、硬编码值 |
| 可扩展性 | ⭐⭐⭐⭐ | 插件架构正确，双重注册路径需统一 |
| **综合** | **B+ (原型) / C+ (生产)** | |

## 二、架构符合度（对照 SPEC）

| SPEC 要求 | 实现状态 |
|-----------|----------|
| 三层架构 core→config→tui，依赖单向向下 | ✅ 通过 |
| Plugin + PluginHost 统一扩展入口（ADR-004） | ⚠️ 双重路径 |
| EventType 枚举 + payload schema（ADR-008） | ✅ 通过 |
| 插件不进 runtime 构造函数（ADR-003） | ✅ 通过 |
| 全异步，禁止 sync-in-async | ✅ 通过 |
| core 不依赖 tui/config/plugins | ✅ 通过 |
| Stream 通过 EventStream（ADR-007） | ✅ 通过 |

## 三、问题清单

### 🔴 严重（合并前应修复）

#### 1. 双重工具注册路径——破坏统一心智模型

**位置**：`packages/core/src/runtime/agent-runtime.ts:268-277`

```typescript
// 两个来源拼接，SDK 用户困惑
const directToolSchemas = this.tools.schemas();       // ToolRegistry 直接注册
const pluginToolSchemas = this.pluginHost.listTools()  // PluginHost 插件注册
const toolSchemas = [...directToolSchemas, ...pluginToolSchemas];
```

**问题**：SPEC 要求工具统一经 PluginHost 投放。当前 `tools.register()` 和 `pluginHost.registerTool()` 是两个独立入口，查找也需要先 `tools.has()` 再 `pluginHost.getTool()`。

**修复方向**：内置工具也走 Plugin，ToolRegistry 合并到 PluginHost，或 PluginHost 作为工具的唯一真相来源。

#### 2. 调试 console.log 散落在生产路径

**位置**：`packages/core/src/runtime/agent-runtime.ts:279-283, 303-306`

```typescript
console.log('[Debug] Direct tools:', ...);
console.log('[Debug] Plugin tools:', ...);
console.log('[Debug] Total tools:', ...);
console.log('[Debug] Messages sent to AI:');
```

**问题**：每次 LLM 调用都输出，无法关闭，污染 TUI。

**修复方向**：用 `process.env.DEBUG` 守卫或 logger 接口注入。

#### 3. mock assistant 消息——workaround 进了核心

**位置**：`packages/core/src/runtime/agent-runtime.ts:468-473`

```typescript
// 工具返回后手动注入假 assistant 消息
this.context.add({
  role: 'assistant',
  content: `工具 ${toolCall.function.name} 返回了结果：${result}`,
});
```

**问题**：这是为兼容 mimo 等非标准模型（不理解 `role: tool` 消息）的 workaround。核心运行时不应包含 provider 特定的适配逻辑。

**修复方向**：抽成 `AfterTool` Hook 插件，或做成 Provider 的 `messageAdapter` 能力。

#### 4. installPlugin 吞异步错误

**位置**：`packages/core/src/runtime/agent-runtime.ts:78-83`

```typescript
private installPlugin(plugin: Plugin): void {
  const result = plugin.install(this.pluginHost);
  if (result instanceof Promise) {
    result.catch((err) => {
      console.error(`Failed to install plugin "${plugin.name}": ${err}`);
      // 错误被吞，runtime 静默继续
    });
  }
}
```

**问题**：如果插件安装失败（网络超时、配置错误等），Agent 缺失预期能力但不知情。

**修复方向**：改为 `async installPlugin` + `await`，失败时在构造函数中 throw 或返回安装结果。

#### 5. 硬编码限制值

| 位置 | 硬编码值 | 应为 |
|------|----------|------|
| `agent-runtime.ts:237` | `maxToolCalls = 5` | 从 `TerminationPolicy` 或 `AgentRuntimeOptions` 注入 |
| `context-manager.ts:20` | `maxTokens = 4096` | 已有 `Config` 参数但初始化时含硬编码 fallback |
| `event-stream.ts:18` | `maxHistorySize = 1000` | 构造函数已接收但缺默认值注入 |

### 🟡 中等

#### 6. start.ts 和 cli.ts 大量重复逻辑

两个文件都构造完整 Runtime + REPL 循环（~400 行重复）。
`cli.ts` 是正式入口但绑死 `MemoryLLMProvider`（line 113）。
`start.ts` 是开发脚本但需要手动改代码切换 provider。

**修复方向**：`cli.ts` 统一入口，`start.ts` 删除或改为引用 cli 的 thin wrapper。

#### 7. parseSimpleYaml 只支持单层解析

**位置**：`packages/config/src/loader.ts:230`

注释自认"生产环境应使用完整 YAML 解析库"。当前实现无法解析嵌套结构（如 `provider.base_url`），整个配置加载链路因此不可用于生产。

**修复方向**：引入 `js-yaml` 或 `yaml` 库替换。

#### 8. ToolCall 类型重复定义

**位置**：`types/provider.ts:19-26` 和 `types/tool.ts:39-46`

两个文件定义了完全相同的 `ToolCall` 接口（`id`, `type: 'function'`, `function: { name, arguments }`）。多处 import 混用两者。

**修复方向**：`provider.ts` 从 `tool.ts` re-export，或合并到一个文件。

#### 9. meta-tools 使用 new Function() 执行持久化代码

**位置**：`plugins/meta-tools/src/index.ts:51`

```typescript
const handler = new Function('args', toolData.handlerCode);
```

**问题**：`Function` 构造器等效 `eval`，持久化的 `handlerCode` 字符串有代码注入风险。

**修复方向**：限制为预定义工具模板 + 参数化；或加签名校验。

#### 10. SQLiteSessionBackend 无连接关闭

**位置**：`packages/core/src/session/sqlite-backend.ts`

`close()` 方法存在但未被任何调用方使用。进程退出时依赖 OS 回收，多实例场景会泄漏文件句柄。

**修复方向**：`AgentRuntime` 提供 `dispose()`/`close()` 生命周期方法。

### 🟢 轻微

11. **HookContext 索引签名丢失类型安全**（`types/hook.ts:19`：`[key: string]: unknown`）
12. **MemoryContextManager tokenCount 用字符长度估算**（`context-manager.ts:80-91`）
13. **Guardrail 事件中 guardrail_name 硬编码 `'unknown'`**（`agent-runtime.ts:548`）
14. **FileSessionBackend 未在 index.ts 中导出但被声明**

## 四、测试覆盖

| 测试文件 | 覆盖范围 | 状态 |
|----------|----------|------|
| `agent-runtime.test.ts` | Run 生命周期、事件流、工具调用 | ✅ |
| `context-manager.test.ts` | 消息管理、压缩、多会话 | ✅ |
| `event-stream.test.ts` | 订阅/发布/历史 | ✅ |
| `limit-checker.test.ts` | 限制检查、终止策略 | ✅ |
| `plugin-host.test.ts` | 工具/Provider/Guardrail/Hook 注册 | ✅ |
| `provider.test.ts` | LLM Provider | ✅ |
| `session-backend.test.ts` | 会话持久化 | ✅ |
| `tool-registry.test.ts` | 工具注册/调用/超时 | ✅ |

**缺失**：
- 无 config 包测试
- 无 TUI 包测试
- 无插件测试
- 无集成测试（端到端 CLI 测试）

## 五、帕累托改进路线

以下改进可独立执行，彼此不冲突，每一项都让代码更好而不损害任何其他维度：

| 优先级 | 改进项 | 工作量 | 对应问题 |
|--------|--------|--------|----------|
| 1 | 统一工具注册路径 | 中 | #1 |
| 2 | 移除/守卫 debug 日志 | 低 | #2 |
| 3 | mock assistant → Hook 插件 | 中 | #3 |
| 4 | installPlugin 改为 fail-fast | 低 | #4 |
| 5 | 硬编码值 → 配置注入 | 中 | #5 |
| 6 | 消除 cli.ts/start.ts 重复 | 中 | #6 |
| 7 | 替换 YAML 解析器 | 低 | #7 |
| 8 | 合并 ToolCall 类型 | 低 | #8 |
| 9 | new Function() 改为安全方案 | 中 | #9 |
| 10 | 添加生命周期管理 | 中 | #10 |

## 六、结论

作为 Phase 1 原型，架构骨架正确，核心 loop 可工作，插件系统设计合理。但距离生产就绪尚有距离。**建议下一个 Phase 按帕累托改进路线逐个修复后，再合入后续功能。**
