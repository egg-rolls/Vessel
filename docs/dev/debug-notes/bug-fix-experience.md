# Bug 修复经验总结

## 问题现象

```
用户: 你有什么技能
AI: 我的技能库是空的（错误）
```

**核心问题**：AI 调用了工具，工具返回了正确结果，但 AI 不理解返回内容。

---

## 调试过程

| 阶段 | 尝试 | 结果 |
|------|------|------|
| 1 | 简化工具返回格式 | ❌ 效果不明显 |
| 2 | 优化 system prompt | ❌ 效果不明显 |
| 3 | 添加工具调用次数限制 | ⚠️ 避免了无限循环 |
| 4 | 优化消息格式（OpenAI/Anthropic） | ❌ 效果不明显 |
| 5 | **优化上下文管理** | ✅ 解决了主要问题 |
| 6 | **添加工具返回摘要** | ✅ 彻底解决问题 |

---

## 根本原因

### 原因 1：上下文累积

**问题**：每次调用工具后，消息都被添加到上下文，导致上下文越来越长。

**代码问题**：
```typescript
// 之前：从数据库加载历史消息
if (this.session) {
  const saved = await this.session.load(currentSessionId);
  if (saved && saved.messages.length > 0) {
    for (const msg of saved.messages) {
      this.context.add(msg);
    }
  }
}
```

**修复**：
```typescript
// 现在：每次 run() 调用时重置上下文
this.context.clear();
```

---

### 原因 2：AI 不理解工具返回

**问题**：AI 看到了 `role: 'tool'` 的消息，但没有理解这是工具返回的结果。

**修复**：在工具返回后，添加一个"助手消息"，告诉 AI 工具返回了什么：

```typescript
// 添加助手消息，告诉 AI 工具返回了什么
this.context.add({
  role: 'assistant',
  content: `工具 ${toolCall.function.name} 返回了结果：${result}`,
});
```

---

## 关键经验

### 经验 1：先分析，再动手

**错误做法**：看到问题就改代码，反复尝试。

**正确做法**：
1. 先分析问题现象
2. 添加调试信息，了解实际流程
3. 找到根本原因
4. 再动手修复

---

### 经验 2：调试信息很重要

**添加的调试信息**：
```typescript
console.log('[Debug] Messages sent to AI:');
for (const msg of messages) {
  console.log(`  [${msg.role}]: ${msg.content?.substring(0, 100)}...`);
}
```

**作用**：看到 AI 实际收到的消息，发现了上下文累积问题。

---

### 经验 3：对比分析

**对比 Claude Code/OpenCode**：
- 它们接入 MiMo 也能正常工作
- 说明问题不在 MiMo 模型，而在我们的实现

**关键发现**：上下文管理和工具返回处理是关键。

---

### 经验 4：一次只改一个地方

**错误做法**：同时修改多个地方，不知道哪个有效。

**正确做法**：一次只改一个地方，测试效果，再决定是否继续。

---

## 修改的文件

| 文件 | 修改内容 |
|------|----------|
| `packages/core/src/runtime/agent-runtime.ts` | 优化上下文管理 + 添加工具返回摘要 |
| `packages/core/src/provider/providers.ts` | 优化消息格式（OpenAI/Anthropic） |
| `start.ts` | 优化 system prompt |
| `plugins/skills-loader/src/index.ts` | 简化工具返回格式 |

---

## 一句话总结

**关键经验**：调试时要先分析问题根源，添加调试信息，对比成功案例，一次只改一个地方。

**根本原因**：上下文累积 + AI 不理解工具返回。

**解决方案**：重置上下文 + 添加工具返回摘要。
