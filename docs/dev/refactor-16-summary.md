# 重构总结：删除 readline REPL + 拆分 cli.ts (#16)

## 完成日期
2026-07-31

## 目标
1. 删除 readline 版本的 REPL，只保留 Ink 版本（React 组件式 UI）
2. 拆分 cli.ts，提取 Bootstrap 模块和 PluginRegistry（#16 issue）

## 变更清单

### 新增文件

1. **`src/plugin-registry.ts`** - 插件注册表
   - 管理插件名称到模块路径的映射
   - 支持动态加载和配置
   - 从 cli.ts 中提取的 `PLUGIN_IMPORT_MAP`

2. **`src/bootstrap.ts`** - 应用引导模块
   - 负责：config → provider → plugins → runtime → ReplContext
   - 从 cli.ts 中提取的核心启动逻辑
   - 提供 `bootstrap()` 函数和 `newSessionId()` 工具函数

3. **`src/headless-runner.ts`** - Headless 运行器
   - 处理 `--run` 模式的单轮对话
   - 从 cli.ts 中提取的 `runHeadless()` 和 `seedFromMessagesFile()`

4. **`packages/tui/src/error-classifier.ts`** - 错误分类器
   - 从 `repl.ts` 中提取的 `classifyError()` 函数
   - 保持向后兼容

### 修改文件

1. **`packages/tui/src/index.ts`** - 更新导出
   - 移除 `startRepl` 导出
   - 添加 `classifyError` 和相关类型导出
   - 更新注释说明

2. **`packages/tui/src/repl/ink-repl.tsx`** - 增强 Ink REPL
   - 添加非 TTY 环境支持
   - 实现简单的行模式作为 fallback
   - 保持与原 readline 版本相同的功能

3. **`src/cli.ts`** - 重构为入口分发器
   - 从 458 行减少到 ~120 行
   - 移除所有业务逻辑，只保留 argv 解析和入口分发
   - 导入并使用新模块：bootstrap、headless-runner

4. **`packages/tui/__tests__/error-classify.test.ts`** - 更新测试引用
   - 从 `../src/repl/repl.js` 改为 `../src/error-classifier.js`

### 删除文件

1. **`packages/tui/src/repl/repl.ts`** - readline REPL 实现
   - 被 Ink 版本完全替代

## 架构改进

### 之前
```
cli.ts (458 行)
├── config 加载
├── provider 注册
├── 插件加载
├── runtime 构造
├── ReplContext 装配
└── headless 分发
```

### 之后
```
cli.ts (~120 行) - 入口分发器
├── argv 解析
├── bootstrap() - 应用引导
│   ├── config 加载
│   ├── provider 注册
│   ├── 插件加载
│   ├── runtime 构造
│   └── ReplContext 装配
└── runHeadless() / startInkRepl() - 模式分发

plugin-registry.ts - 插件注册表
headless-runner.ts - Headless 运行器
ink-repl.tsx - Ink REPL（支持 TTY 和非 TTY）
```

## 测试结果

```
152 pass
0 fail
331 expect() calls
```

所有测试通过，包括：
- Headless 模式测试
- REPL 命令测试
- 错误分类测试
- 工具权限确认测试

## 向后兼容性

1. **API 兼容**：
   - `startInkRepl(ctx)` 函数签名保持不变
   - `classifyError()` 函数保持不变
   - `ReplContext` 接口保持不变

2. **行为兼容**：
   - TTY 环境：使用完整的 Ink UI（与之前相同）
   - 非 TTY 环境：使用简单的行模式（与原 readline 版本行为一致）

3. **配置兼容**：
   - 所有环境变量保持不变
   - `vessel.yaml` 配置格式保持不变

## 解决的问题

1. **#16 issue**：cli.ts 职责过多
   - ✅ 拆分为 4 个模块，每个模块职责单一
   - ✅ 移除硬编码的 `PLUGIN_IMPORT_MAP`
   - ✅ 提高可测试性

2. **代码重复**：
   - ✅ 删除 readline 版本，只保留 Ink 版本
   - ✅ 消除两套 REPL 实现的维护负担

3. **非 TTY 支持**：
   - ✅ Ink REPL 现在支持非 TTY 环境
   - ✅ 管道输入正常工作

## 后续工作

1. **文档更新**：
   - 更新 `docs/api/tui.md` 反映新的模块结构
   - 更新 `CLAUDE.md` 中的相关说明

2. **测试增强**：
   - 为 `bootstrap.ts` 添加单元测试
   - 为 `plugin-registry.ts` 添加单元测试
   - 为 `headless-runner.ts` 添加单元测试

3. **功能扩展**：
   - 支持 `vessel.yaml` 的 `plugins` 字段动态加载
   - 支持插件热重载

## 总结

本次重构成功完成了两个目标：
1. 删除了 readline 版本的 REPL，统一使用 Ink 版本
2. 拆分了 cli.ts，提高了代码的可维护性和可测试性

重构后的代码结构更清晰，模块职责更单一，同时保持了完全的向后兼容性。
