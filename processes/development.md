# 标准开发流程

> 适用于功能开发和模块重构。单点修复（修 bug、加参数、小调 UI）可直接走 [collaboration.md](collaboration.md) 的快速通道——单 Issue → PR，跳过蓝图和编排层。

## 为什么需要三层

Issue + PR 是**原子交付单元**——它假设"一个改动能独立理解、独立合并"。这对小改动成立。但当改动涉及多个子任务、多条依赖线时，默认会退化成流水线（A 合了才能做 B，B 合了才能做 C），变成纯线性推进。

加两层：先想清楚做什么（蓝图）、再切成可并行的子任务（编排），然后每个子任务仍走 Issue→PR。

```
蓝图层   ADR + Design Doc     定方向 + 接口契约        不写代码
编排层   Epic Tracker Issue    子任务清单 + 依赖图      统筹全局
交付层   Issue → PR           原子可合并切片           保持小（见 collaboration.md）
```

- **蓝图层**：选型 / 边界决策走 [ADR](../docs/specs/ADR.md)；接口契约 + 拆分方案写 Design Doc，放 `docs/dev/`。
- **编排层**：开一个 Epic Issue，body 用 GitHub task list + 子 Issue 引用画依赖图。Epic 只追踪状态，不写代码。
- **交付层**：每个子任务仍是一个 Issue + PR，完全复用 [collaboration.md](collaboration.md)。

## 三个杠杆

### 1. 接口先行，而非实现先行

**概念**：子任务 B 依赖子任务 A → 必然等 A 合并，线性。把依赖从"等实现"改成"等接口契约" → 解锁并行：先开一个只定义类型 / 签名的接口 PR，合并后各线基于 mock 独立推进。

**正面**：定好跨模块接口之后，上下游、前后端、不同开发者可以同时开工——上游变 API 不影响下游的开发节奏，只需对齐契约。

**反面**：先写实现再抽接口。下游全部卡在上游，一条线推到底。上游返工一次，下游全部重来。

**自问**：这个任务的 blocker 是"接口没定"还是"实现没写"？如果是后者，先抽接口 PR。

### 2. 正交拆分，而非流水线拆分

**概念**：按"步骤"拆（A→B→C）必然串行。正交拆法：找最小耦合点，定共享接口，各线从接口辐射出去并发。

**正面**：把一个功能拆成多条**独立推进**的子任务线——壳层 / 核心逻辑 / UI / 配置各自独立，共享接口契约。一条线卡住不阻塞其他线。

**反面**：按阶段拆——先搭框架、再写逻辑、再做 UI、最后打包。每一步都是下一步的前置。

**自问**：有没有两个子任务能同时开工、互不需要对方代码？一个都没有 → 拆的是流水线，重新找正交维度。

### 3. worktree 物理并行

**概念**："并行"不只是在纸上——多个无依赖子任务开多个 git worktree 同时推进，互不干扰。每个子任务独立工作目录，一个分支的改动不污染另一个。

**正面**：接口契约合并后，各子任务分到独立 worktree 并发。一个卡住不阻塞其他。

**反面**：在一个分支里串行做多件事——即使逻辑能并行，物理仍然是线性的。

**自问**：是在一个分支里串行做多件事，还是在多个 worktree 里并发做？逻辑可并行但物理串行 = 浪费。

## 操作流程

1. **判断规模**：这个改动能一个 Issue → PR 搞定吗？能 → 走 [collaboration.md](collaboration.md) 快速通道。
2. **蓝图**：写 ADR（选型 / 边界决策）+ Design Doc（接口契约 + 拆分方案，放 `docs/dev/`）。Design Doc 必须含接口契约。
3. **编排**：开 Epic Issue，body 用 GitHub task list + 子 Issue 引用画依赖图：

   ```
   epic-0  接口契约 PR              ← 阻塞一切
     ├── 线A  子 Issue #xx
     ├── 线B  子 Issue #xx
     └── 线C  子 Issue #xx
   ```

4. **拆分**：刻意找正交线，接口先行。用杠杆 2 的自问检验。
5. **执行**：每条线仍走 [collaboration.md](collaboration.md) 的 Issue → PR。无依赖的线开 worktree 并发。
6. **收口**：Epic Issue 跟踪各线进度，全部合并后关闭 Epic。

## 与 collaboration.md 的关系

- **本文件**是标准开发流程——蓝图层（想清楚）+ 编排层（拆开）+ 交付层（Issue→PR）。
- **[collaboration.md](collaboration.md)** 是快速通道——单点修复 / 小改动直接从 Issue 到 PR，跳过蓝图和编排。
- **交付层完全复用** collaboration.md：分支命名、PR 创建、审查、合并门禁不变。
- **命名仍走** [conventions.md](conventions.md)。
- **蓝图层的 ADR** 走 [ADR.md](../docs/specs/ADR.md)；Design Doc 放 `docs/dev/`。
- **[task-assignment.md](task-assignment.md)** 是手工编排层的实例（梯队 / 节点 / 依赖图）；本文件是其方法论。
