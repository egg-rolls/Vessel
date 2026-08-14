# Dashboard 设计文档

> 关联 Issue：#10, #11, #13
> 状态：设计阶段
> 创建时间：2026-08-14

## 1. 概述

本设计文档描述 Vessel TUI 仪表盘系统的统一实现方案，整合以下三个功能：

- **#10**: 启动欢迎仪表盘（ASCII art + 系统信息）
- **#11**: 资产管理斜杠命令（`/assets`、`/plugins`、`/mcp`、`/skills`、`/tools`）
- **#13**: 工具显示接口和 Spinner 状态显示

## 2. 设计决策

| 决策项 | 选择 | 理由 |
|--------|------|------|
| 设计风格 | Hermes风格（简洁） | 信息密度高，视觉干扰少 |
| 颜色方案 | 蓝色系 | 技术感强，视觉舒适 |
| ASCII art | 精美版 | 参考 Hermes/Claude Code 风格 |
| 架构模式 | 插件化设计 | 可扩展性好，三个功能独立 |
| 数据获取 | 统一数据服务 | 避免重复获取，保证数据一致性 |

## 3. 目录结构

```
packages/tui/src/dashboard/
├── index.ts                    # 导出入口
├── types.ts                    # 类型定义
├── dashboard-service.ts        # 统一数据服务
├── dashboard-manager.ts        # 插件管理器
├── plugins/
│   ├── welcome/
│   │   ├── index.ts           # Welcome 插件
│   │   ├── components/
│   │   │   ├── AsciiArt.tsx   # ASCII art 组件
│   │   │   ├── ConfigInfo.tsx # 配置信息组件
│   │   │   └── HealthStatus.tsx # 健康状态组件
│   │   └── default-config.ts  # 默认配置
│   ├── assets/
│   │   ├── index.ts           # AssetManager 插件
│   │   └── components/
│   │       ├── PluginList.tsx # 插件列表
│   │       ├── McpList.tsx    # MCP 服务器列表
│   │       ├── SkillsList.tsx # Skills 列表
│   │       └── ToolsList.tsx  # 工具列表
│   └── tools/
│       ├── index.ts           # ToolDisplay 插件
│       └── components/
│           ├── ToolCard.tsx   # 工具卡片
│           └── Spinner.tsx    # Spinner 状态
└── __tests__/
    ├── dashboard-service.test.ts
    └── plugins/
        ├── welcome.test.ts
        ├── assets.test.ts
        └── tools.test.ts
```

## 4. 核心接口设计

### 4.1 DashboardPlugin 接口

```typescript
// packages/tui/src/dashboard/types.ts

export interface DashboardPlugin {
  /** 插件名称 */
  name: string;
  
  /** 优先级（数字越小越优先） */
  priority: number;
  
  /** 渲染组件 */
  render(data: DashboardData): React.ReactNode;
  
  /** 获取插件数据 */
  getData(service: DashboardService): Promise<PluginData>;
  
  /** 获取优先级 */
  getPriority(): number;
}

export interface PluginData {
  [key: string]: unknown;
}
```

### 4.2 DashboardData 类型

```typescript
export interface DashboardData {
  /** 配置信息 */
  config: ConfigInfo;
  
  /** 会话信息 */
  session: SessionInfo;
  
  /** 健康状态 */
  health: HealthInfo;
  
  /** 资产信息 */
  assets: AssetInfo;
  
  /** 工具状态 */
  tools: ToolInfo;
}

export interface ConfigInfo {
  model: string;
  provider: string;
  baseUrl: string;
  workspace: string;
}

export interface SessionInfo {
  sessionId: string;
  createdAt: Date;
}

export interface HealthInfo {
  status: 'healthy' | 'warning' | 'error';
  uptime: number;
  memoryUsage: number;
}

export interface AssetInfo {
  plugins: PluginAsset[];
  mcpServers: McpAsset[];
  skills: SkillAsset[];
  tools: ToolAsset[];
}

export interface ToolInfo {
  registered: number;
  active: number;
}
```

### 4.3 DashboardService

```typescript
export class DashboardService {
  constructor(private ctx: ReplContext) {}
  
  /** 获取全量数据 */
  async getFullData(): Promise<DashboardData>;
  
  /** 获取配置信息 */
  async getConfig(): Promise<ConfigInfo>;
  
  /** 获取会话信息 */
  async getSession(): Promise<SessionInfo>;
  
  /** 获取健康状态 */
  async getHealth(): Promise<HealthInfo>;
  
  /** 获取资产信息 */
  async getAssets(): Promise<AssetInfo>;
  
  /** 获取工具状态 */
  async getTools(): Promise<ToolInfo>;
}
```

### 4.4 DashboardManager

```typescript
export class DashboardManager {
  private plugins: Map<string, DashboardPlugin> = new Map();
  private service: DashboardService;
  
  constructor(service: DashboardService) {}
  
  /** 注册插件 */
  registerPlugin(plugin: DashboardPlugin): void;
  
  /** 卸载插件 */
  unregisterPlugin(name: string): void;
  
  /** 渲染仪表盘 */
  async renderDashboard(): Promise<React.ReactNode>;
  
  /** 按优先级排序插件 */
  private getSortedPlugins(): DashboardPlugin[];
}
```

## 5. 插件实现

### 5.1 Welcome 插件

**功能**：启动时显示欢迎仪表盘

**组件**：
- `AsciiArt.tsx`: Vessel ASCII art 图标
- `ConfigInfo.tsx`: 模型、Provider、Session 等配置信息
- `HealthStatus.tsx`: 健康状态、内存使用

**显示效果**：
```
   ██╗   ██╗███████╗███████╗███████╗███████╗██╗
   ██║   ██║██╔════╝██╔════╝██╔════╝██╔════╝██║
   ██║   ██║█████╗  ███████╗███████╗█████╗  ██║
   ╚██╗ ██╔╝██╔══╝  ╚════██║╚════██║██╔══╝  ██║
    ╚████╔╝ ███████╗███████║███████║███████╗███████╗
     ╚═══╝  ╚══════╝╚══════╝╚══════╝╚══════╝╚══════╝

🚀 Self-organizing Agent Harness

┌─ Configuration ──────────────────────────────────────┐
│  Model      │ claude-sonnet-4-20250514                │
│  Provider   │ Anthropic                               │
│  Session    │ 20260814_123456_ab12cd                  │
│  Workspace  │ /path/to/project                        │
├─ Health ──────────────────────────────────────────────┤
│  Status     │ ✅ Healthy                               │
│  Uptime     │ 2h 34m                                  │
│  Memory     │ 45 MB                                   │
└───────────────────────────────────────────────────────┘
```

### 5.2 AssetManager 插件

**功能**：资产管理斜杠命令

**命令**：
- `/assets`: 资产总览仪表盘
- `/plugins`: 插件浏览器
- `/mcp`: MCP 服务器浏览器
- `/skills`: Skills 浏览器
- `/tools`: 工具浏览器

**组件**：
- `PluginList.tsx`: 插件列表（状态、配置）
- `McpList.tsx`: MCP 服务器列表（连接状态、工具数）
- `SkillsList.tsx`: Skills 列表（详情）
- `ToolsList.tsx`: 工具列表（详情、测试）

**交互模式**：
```
┌─ [Title] ─────────────────────────────────────────────┐
│                                                        │
│  [列表内容]                                            │
│                                                        │
│  [↑↓] Navigate  [Enter] Details  [快捷键...]          │
└────────────────────────────────────────────────────────┘
```

### 5.3 ToolDisplay 插件

**功能**：工具显示接口和 Spinner 状态

**组件**：
- `ToolCard.tsx`: 工具调用卡片
- `Spinner.tsx`: Spinner 状态显示

**Spinner 模式**：
- `thinking`: 思考中
- `tool`: 工具执行中
- `idle`: 空闲

**显示效果**：
```
✻ Thinking...                            2.3s
✻ Reading src/foo.ts...                  5.1s
✻ Completed                              8.2s
```

## 6. 配置结构

```yaml
tui:
  dashboard:
    enabled: true
    welcome:
      enabled: true
      style: full  # full | minimal
      show_ascii_art: true
      show_health: true
      show_config: true
    assets:
      enabled: true
      show_plugins: true
      show_mcp: true
      show_skills: true
      show_tools: true
    tools:
      enabled: true
      show_status: true
      show_spinner: true
```

## 7. 实现计划

### Phase 1: 基础框架（预计 2 小时）
- [ ] 创建 `packages/tui/src/dashboard/` 目录结构
- [ ] 实现 `types.ts`（DashboardPlugin 接口等）
- [ ] 实现 `dashboard-service.ts`（统一数据服务）
- [ ] 实现 `dashboard-manager.ts`（插件管理器）
- [ ] 编写单元测试

### Phase 2: Welcome 插件（预计 3 小时）
- [ ] 实现 `AsciiArt.tsx` 组件
- [ ] 实现 `ConfigInfo.tsx` 组件
- [ ] 实现 `HealthStatus.tsx` 组件
- [ ] 实现 Welcome 插件主组件
- [ ] 集成到 DashboardManager
- [ ] 编写单元测试

### Phase 3: AssetManager 插件（预计 4 小时）
- [ ] 实现 `PluginList.tsx` 组件
- [ ] 实现 `McpList.tsx` 组件
- [ ] 实现 `SkillsList.tsx` 组件
- [ ] 实现 `ToolsList.tsx` 组件
- [ ] 实现 AssetManager 插件主组件
- [ ] 集成到 DashboardManager
- [ ] 编写单元测试

### Phase 4: ToolDisplay 插件（预计 3 小时）
- [ ] 实现 `ToolCard.tsx` 组件
- [ ] 实现 `Spinner.tsx` 组件
- [ ] 实现 ToolDisplay 插件主组件
- [ ] 集成到 DashboardManager
- [ ] 编写单元测试

### Phase 5: 集成测试（预计 2 小时）
- [ ] 集成到 TUI 启动流程
- [ ] 测试配置开关功能
- [ ] 测试插件加载/卸载
- [ ] 端到端测试

**总计预计**：14 小时

## 8. 与其他 Issue 的关联

### 与 #11 的关联
- AssetManager 插件实现 #11 的斜杠命令功能
- 共享 DashboardService 数据获取逻辑
- 统一交互界面风格

### 与 #13 的关联
- ToolDisplay 插件实现 #13 的工具显示和 Spinner 功能
- 复用 EventStream 事件订阅
- 统一组件设计模式

### PR 关联
创建单个 PR，在描述中关联：
- Closes #10
- Closes #11
- Closes #13

## 9. 技术约束

1. **不改 Core**：所有实现在 TUI 层，不动 `packages/core/src/**`
2. **依赖方向**：`tui -> config -> core`，不反向引用
3. **事件名**：开放字符串字面量（ADR-030）
4. **类型安全**：TS strict，减少 `as` 断言
5. **函数复杂度**：单函数 ≤ 50 行

## 10. 验收标准

1. **功能完整**：三个 Issue 的验收标准全部满足
2. **配置生效**：所有配置开关正常工作
3. **插件化**：三个功能独立，可单独启用/禁用
4. **测试覆盖**：单元测试覆盖率 ≥ 80%
5. **文档同步**：`docs/api/tui.md` 已更新
6. **CI 全绿**：lint / typecheck / test / build 全通过
