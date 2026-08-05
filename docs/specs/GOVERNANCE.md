# 需求治理模型（GOVERNANCE）

> 本文档定义 Vessel 项目的需求入口、分层存储、外部贡献流程、模块生命周期。
> 永久规范：只描述治理体系是什么，不描述当前在处理哪些需求。
> 阶段状态见 `docs/dev/DEVELOPMENT-PLAN.md`。

---

## 一、五层需求存储模型

不是所有需求都进文档。按协作复杂度分层：

```
复杂度                           存储位置                操作角色
──────────────────────────────────────────────────────────────
L0  想法/建议             →  GitHub Discussions       任何人
L1  Bug 修复/小增强       →  GitHub Issue → PR        开发者
L2  单模块功能            →  GitHub Issue             需求分析师 +
                             → docs/dev/<module>/      架构师 +
                               prd.md + spec.md        开发者
L3  大模块/新方向         →  L2 + 更新                 架构师 +
                             docs/dev/                 维护者
                             DEVELOPMENT-PLAN.md
L4  改变 Phase 范围       →  L3 + 更新 ROADMAP.md     维护者 +
                             + 必要时 ADR              ADR
```

### 各层判定标准

| 层级 | 判定问题 | 典型场景 |
|------|---------|---------|
| **L0** | 不需要马上做，只是记录想法？ | "希望能支持 i18n"、"考虑支持 WebUI" |
| **L1** | 一个人一天能做完？不需要写接口契约？ | "fix: loadConfig 空文件抛异常"、"feat: 加一个 slash 命令参数" |
| **L2** | 需要多人协作？涉及接口契约？拆分后需 ≥2 个 PR？ | "MCP client 支持 HTTP 传输"、"skills-loader 支持远程 registry" |
| **L3** | 会影响"下一步做什么"的排期决策？需要公布路线图？ | "下个季度启动 A2A 模块"、"Phase 2 优先做 WebUI vs Desktop" |
| **L4** | 改变了 ROADMAP 定义的 IN/OUT 范围？增减了 Phase 内容？ | "Desktop App 从 OUT 移入 Phase 3"、"Phase 1 增加 headless 功能" |

---

## 二、外部贡献流程

外部贡献者只需提 Issue（L0/L1 级别）。维护者负责分类升级。

```
外部贡献者提 Issue
        │
        ▼
维护者 Triage
        │
        ├── 不做了 → 关闭（wontfix / 说明原因）
        ├── L1 直接做 → 认领 → PR
        ├── L2 要拆解 → 需求分析师介入
        │     → docs/dev/<module>/prd.md
        │     → 架构师 → spec.md + Epic Issues
        └── L3 要排期 → 更新 docs/dev/DEVELOPMENT-PLAN.md
              L4 要改范围 → 更新 ROADMAP.md + 必要时 ADR
```

### 维护者 Triage 操作清单

| 步骤 | 操作 |
|------|------|
| 1 | 读 Issue，理解需求本质（不是照搬标题） |
| 2 | 按 ISSUE-SPEC §2.2 贴上默认优先级 label |
| 3 | 判断层级（L0-L4），在 Issue 下留言告知分类结果 |
| 4 | L2+ → 需要 PRD/SPEC 时，建 `docs/dev/<module>/` 目录并指派 |
| 5 | L3+ → 更新 DEVELOPMENT-PLAN.md 候选模块表 |

### 外部贡献者不需要做的事

- 不需要遵循 ISSUE-SPEC 的 type 格式（维护者会修正标题）
- 不需要自己判断优先级（维护者会贴 label）
- 不需要写 PRD/SPEC（维护者判断是否需要，指派需求分析师/架构师）
- Issue 描述清晰即可，不要求任何模板

---

## 三、模块开发生命周期

当维护者判定某个需求为 L2 级别，启动标准模块开发流程：

```
L2 Issue 创建
  │
  ▼
阶段 1：需求分析（需求分析师角色）
  产物：docs/dev/<module>/prd.md
  内容：Problem Statement、MoSCoW、交互分支穷举、NFR 五维
  │
  ▼
阶段 2：架构设计（架构师角色）
  产物：docs/dev/<module>/spec.md + Epic Issue + 子 Issues
  内容：备选方案与权衡、接口契约（含错误模型）、正交拆分
  │
  ▼
阶段 3：开发实现（开发者角色）
  认领子 Issue → worktree → PR → DoD 七条
  │
  ▼
阶段 4：审查合并（审查者角色）
  架构合规 + CI 全绿 + 文档同步
```

角色文档与详细模板见：
- 需求分析师：`docs/role/REQUIREMENTS-ANALYST.md` + `docs/role/REQ-TODO.md`
- 架构师：`docs/role/ARCHITECT.md` + `docs/role/ARCH-TODO.md`
- 开发者：`docs/role/DEVELOPER.md` + `docs/role/DEV-TODO.md`
- 审查者：`docs/role/REVIEWER.md` + `docs/role/REVIEW-TODO.md`
- 完整流程：`processes/development.md`

---

## 四、存储介质选择指南

| 介质 | 适用 | 不适用 |
|------|------|--------|
| **GitHub Discussions** | 模糊想法、社区讨论、投票 | 确定要做的事（应转为 Issue） |
| **GitHub Issue** | 原子任务、bug、小增强（L0/L1）、模块入口（L2） | 需要多人协作理解"为什么"和"怎么拆"的设计细节 |
| **docs/dev/<module>/prd.md** | 问题的完整定义（为什么做、为谁做、验收标准） | 一句话想法（太重） |
| **docs/dev/<module>/spec.md** | 接口契约、备选方案与权衡、正交拆分 | 实现细节（那是代码的职责） |
| **docs/dev/DEVELOPMENT-PLAN.md** | 排期、优先级决策、当前阶段 | 具体模块设计（那是 PRD/SPEC 的职责） |
| **docs/specs/ROADMAP.md** | Phase 范围（IN/OUT）、跨阶段蓝图 | 当前进度、阶段状态（那是 dev/ 的职责） |

---

## 五、关联规范

- Issue 类型与优先级定义：`docs/specs/ISSUE-SPEC.md`
- 命名与消息规范：`processes/conventions.md`
- 开发阶段计划：`docs/dev/DEVELOPMENT-PLAN.md`
- 模块开发流程：`processes/development.md`
- 角色文档体系：`docs/role/README.md`
