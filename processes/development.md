# 标准开发流程

> 三段闭环：**解决方案工程师**（PRD）→ **架构师**（SPEC + Epic + Issues）→ **开发者**（认领 + PR）。
> 单点修复（修 bug、加参数、小调 UI）跳过前两段，直接走 [collaboration.md](collaboration.md) 快速通道。

## 全貌

```
用户需求
  │
  ▼
┌─────────────────────────────────────────────────────────┐
│ 阶段 1：需求 → PRD                                       │
│ 角色：   解决方案工程师（docs/guides/SOLUTION-ARCHITECT.md） │
│ 输入：   用户模糊需求                                     │
│ 输出：   docs/dev/<module>/prd.md                         │
│ 动作：   追问边界 → 确定 IN/OUT → 写验收标准               │
│ 门禁：   用户确认 PRD 后才进入阶段 2                       │
└────────────────────┬────────────────────────────────────┘
                     │ PRD 确认
                     ▼
┌─────────────────────────────────────────────────────────┐
│ 阶段 2：PRD → SPEC + Epic + Issues                       │
│ 角色：   架构师（docs/guides/ARCHITECT.md）                │
│ 输入：   docs/dev/<module>/prd.md（阶段 1 产出）          │
│ 输出：   docs/dev/<module>/spec.md                        │
│         + Epic Issue（依赖图）                            │
│         + 子 Issues（每线一个，可独立认领）                 │
│ 动作：   拆模块 → 定接口契约 → 画依赖图 → 生成 Issues      │
│ 门禁：   用户确认 SPEC + 依赖图后才开放认领                 │
└────────────────────┬────────────────────────────────────┘
                     │ SPEC 确认 + Issues 就位
                     ▼
┌─────────────────────────────────────────────────────────┐
│ 阶段 3：Issues → PR                                      │
│ 角色：   开发者（docs/guides/DEVELOPER.md                 │
│         + processes/collaboration.md）                   │
│ 输入：   子 Issues（阶段 2 产出）                          │
│ 输出：   合并的 PR（原子可审查）                           │
│ 动作：   认领 Issue → worktree 并行 → PR → 审查 → 合并    │
│ 门禁：   所有子 Issue 的 PR 合并后，模块可以稳定运行        │
└─────────────────────────────────────────────────────────┘
```

## 模块产物路径

每个模块在 `docs/dev/<module-name>/` 下统一管理：

```
docs/dev/<module-name>/
  ├── prd.md     ← 阶段 1 产出（解决方案工程师）
  └── spec.md    ← 阶段 2 产出（架构师）
```

`<module-name>` 在阶段 1 确定后全程不变，所有角色用同一文件夹名。Epic 和子 Issues 在 GitHub 上追踪，不放在文件夹内。

## 三条不可跳过的规则

### 1. 每个阶段的产出必须经用户确认

PRD 未经用户审阅 → 不进阶段 2。SPEC 未经用户审阅 → 不开放 Issue 认领。

**反面**：写完 PRD 就自己开始拆 SPEC、写代码。用户回头看 PRD，发现 IN/OUT 全理解错了——但代码已经写了。返工成本翻三倍。

**自问**：这个阶段的产出，用户看过并点头了吗？

### 2. 模块文件夹在阶段 1 确定，全程不改名

PRD、SPEC、Epic 引用都依赖一致的文件夹名。中途改名的代价是所有引用断裂。

**反面**：阶段 1 取名 `plugin-hot-reload`，阶段 2 觉得 `dynamic-plugin` 更好——改了文件夹名，PRD 和 SPEC 的路径引用全断。

**自问**：这个模块名在三个阶段都用同一个吗？

### 3. 单点修复不走流程

修一个 bug、加一个参数、小调 UI——不需要解决方案工程师和架构师。直接走 Issue → PR。

**判断线**：这个改动涉及的代码，一个人能在一小时内独立完成吗？能 → 跳过阶段 1 和 2。

## 各阶段角色文档

| 阶段 | 角色 | 入口文档 |
|------|------|---------|
| 1 | 解决方案工程师 | [docs/guides/SOLUTION-ARCHITECT.md](../docs/guides/SOLUTION-ARCHITECT.md) |
| 2 | 架构师 | [docs/guides/ARCHITECT.md](../docs/guides/ARCHITECT.md) |
| 3 | 开发者 | [docs/guides/DEVELOPER.md](../docs/guides/DEVELOPER.md) + [collaboration.md](collaboration.md) |

## 单点修复的快速通道

单点修复仍走 [collaboration.md](collaboration.md)：Issue → 认领 → PR → 审查 → 合并。分支命名、Commit 格式、审查门禁不变。
