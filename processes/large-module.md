# 大模块协作流程

> 什么时候用这套：一个改动 Issue -> PR 装不下时--新 UI 层、Desktop、CLI 大重构。
> 日常小改动仍走 [collaboration.md](collaboration.md)。两套流程共享交付层（分支 / PR / 审查 / 合并门禁）。

## 为什么需要单独一套

Issue + PR 是**原子交付单元**--它假设"一个改动能独立理解、独立合并"。这个假设对修一个 bug、加一个命令成立。但对大模块不成立：它的各部分互相依赖，默认会退化成一条流水线（A 合了才能做 B，B 合了才能做 C），工作变成纯线性推进。

问题不在 PR 太大或太小，在于**缺了 PR 之上的两层**：

- **蓝图层**--想清楚做什么、接口怎么定（不写代码）
- **编排层**--把模块拆成可并行的子任务，统筹全局

补上这两层，线性流水线才能展开成并行扇面。

## 三层结构

```
蓝图层   ADR + Design Doc     定方向 + 接口契约        不写代码
编排层   Epic Tracker Issue    子任务清单 + 依赖图      统筹全局
交付层   Issue -> PR           原子可合并切片           保持小（见 collaboration.md）
```

- **蓝图层**：选型 / 边界决策走 [ADR](../docs/specs/ADR.md) 机制；接口契约 + 拆分方案写 Design Doc，放 `docs/dev/`。
- **编排层**：开一个 Epic Issue，body 用 GitHub task list + 子 Issue 引用画依赖图。Epic 只追踪状态，不写代码。
- **交付层**：每个子任务仍是一个 Issue + PR，完全复用 [collaboration.md](collaboration.md)。这一层不变。

## 三个杠杆

### 1. 接口先行，而非实现先行

**概念**：子任务 B 依赖子任务 A 的"实现" -> 必然线性（等 A 合并）。把依赖改成"依赖接口契约" -> 解锁并行：先开一个只定义类型 / 接口的 PR，合并后各线基于 mock 并行实现。

**正面**：Vessel 的 TUI 拆分--先定 `startRepl(ctx)` 接口契约，功能层与 Ink UI 层基于接口并行开发，互不阻塞（见 [task-assignment.md](task-assignment.md) 的 F 线节点表）。

**反面**：先实现再抽接口。每个下游都等上游实现稳定才能动，N 条潜在并行的线串成 1 条。一处返工，全链重做。

**自问**：这个子任务的 blocker 是"接口没定"还是"实现没写"？如果是后者，先抽接口契约 PR，不要等实现。

### 2. 正交拆分，而非流水线拆分

**概念**：按"步骤"拆（脚手架 -> 接 core -> 写 UI -> 打包）必然线性，每步等上步。正交拆法是找最小耦合点，定一个共享接口，各线从接口辐射出去并发。

**正面**：Desktop 可拆成四条正交线--壳 / 打包 (A) | core 嵌入 (B) | UI 层 (C) | 配置向导 (D)，共享一个 core 桥接口，四线独立推进。

**反面**：把 Desktop 拆成"先做脚手架，再做 core 接入，再做 UI，最后打包"。每一步都是下一步的前置，只能一条线推到底。

**自问**：这些子任务里，有没有两个能同时开 worktree 推进、互不需要对方代码？一个都没有 -> 拆的是流水线，重新找正交维度。

### 3. worktree 物理并行

**概念**："并行"不是文档里的概念，是物理动作。多个无依赖的子任务开多个 git worktree 同时推进，互不干扰。worktree 隔离给每个子任务独立工作目录，一个分支的改动不污染另一个。

**正面**：Desktop 四线接口契约合并后，A / B / C / D 各开一个 worktree 并发。线 C 的 UI 卡住不阻塞线 A 的打包。

**反面**：在一个分支里串行做四件事。即使逻辑上可并行，物理上还是线性--一次只推一条。

**自问**：我是在一个分支里串行做 N 件事，还是在 N 个 worktree 里并发做？逻辑可并行但物理串行 = 浪费。

## 操作流程

1. **判断规模**：这个改动一个 Issue -> PR 装得下吗？装得下走 [collaboration.md](collaboration.md)，到此为止。
2. **蓝图**：写 ADR（选型 / 边界决策）+ Design Doc（接口契约 + 拆分方案，放 `docs/dev/`）。Design Doc 必须含接口契约--它是并行的前提。
3. **编排**：开 Epic Issue，body 用 GitHub task list + 子 Issue 引用画依赖图：

   ```
   epic-0  接口契约 PR              ← 阻塞一切
     ├── 线A  子 Issue #xx
     ├── 线B  子 Issue #xx
     └── 线C  子 Issue #xx
   ```

4. **拆分**：刻意找正交线，接口先行。用杠杆 2 的自问检验--没有可并行的两线就重拆。
5. **执行**：每条线仍走 [collaboration.md](collaboration.md) 的 Issue -> PR。无依赖的线开 worktree 并发（杠杆 3）。
6. **收口**：Epic Issue 跟踪各线进度，全部合并后关闭 Epic。

## 与现有流程的关系

- **交付层完全复用** [collaboration.md](collaboration.md)：分支命名、PR 创建、审查、合并门禁不变。
- **命名仍走** [conventions.md](conventions.md)：Epic Issue 标题用 `feat(<scope>): <描述>`，子 Issue 同。
- **蓝图层的 ADR** 走 [ADR.md](../docs/specs/ADR.md) 机制；Design Doc 放 `docs/dev/`（临时产物，可含进度）。
- **[task-assignment.md](task-assignment.md)** 是手工编排层的实例（梯队 / 节点 / 依赖图）；本文件是其背后的方法论。
