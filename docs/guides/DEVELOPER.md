# 开发者须知

> **写/改代码前，必须先读完本文件。按顺序读，读完一项自检一项。**
> 跳过任何一项 = 写出的代码大概率违规，审查时会被打回。
> **开始前确认你已读过 [AGENTS.md](../../AGENTS.md)**——那是所有角色的通用基础。

## 动手前先做（60 秒，跳过必出事）

```
0. 读 Issue 完整内容             # gh issue view <number>，不知道 Issue 讲什么就开干 = 盲写
1. 技术可行性异议：如果 Issue 的技术方案与 Core 冻结约束（AGENTS.md §5）或 ADR 决策冲突 → 立刻停止认领，在 Issue 下留言提出技术异议，等待架构师调整方案
2. git branch --show-current    # 我在哪个分支？
3. git status --short            # 有别人的改动吗？
4. 确认：这是我的分支吗？        # 不是 → git checkout main，从 main 重开
```

**铁律**：永远不在别人的分支上干活。永远不从别人的分支切新分支。永远不 `git stash` 别人分支上的改动。每次动手前 60 秒确认——省下的是别人几小时的找回时间。

## 为什么必须先读这些

Vessel 有严格的架构约束（[AGENTS.md](../../AGENTS.md) §5 Core 冻结、§6 能力分层、§4 红线）和工程规范（事件枚举化、不可变优先、sync-in-async 禁止）。这些不是"建议"——是硬性门禁。不读就写 = 浪费自己时间 + 浪费审查者时间。

## 必读清单（按此顺序）

### 1. AGENTS.md（全篇）

通用概念手册——项目身份、文档索引、红线、反幻觉纪律、能力分层、Core 冻结。**所有角色基础。**

**自检**：Vessel 的三层是什么？红线有哪些？Core 只能因哪三种原因改？

### 2. docs/specs/SPEC.md

接口契约——所有模块的边界和接口定义。

**自检**：Core 的 9 个接口分别是什么？三层依赖方向是什么？

### 3. docs/specs/ADR.md

架构决策记录——知道历史决策，才不会重蹈覆辙。

**自检**：ADR-003（runtime 构造函数不注入插件）的理由是什么？ADR-004（统一扩展机制）解决了什么问题？

### 4. docs/specs/CORE.md

Core 接口快速参考——写代码时随时查阅。

**自检**：你要改的文件在 core 里吗？如果在，先读 AGENTS.md §5 Core 冻结的 checklist。

### 5. processes/conventions.md

分支命名、Commit message 格式、Issue/PR 命名规范。**写第一行代码前就该知道这些。**

**自检**：Commit message 的格式是什么？分支命名规则是什么？

### 6. processes/collaboration.md

Issue 认领、Draft PR 创建、gh CLI 操作技巧。**推送代码前必读。**

**自检**：创建 PR 的正确步骤是什么？为什么中文内容要用 `--body-file`？

### 7. docs/specs/GIT-WORKFLOW.md

分支模型、合并门禁（架构检查 + CI + 安全 + 回归确认）、反面模式、**§7.1 Rebase 最佳实践**。**知道什么会阻断你的 PR，以及如何避免 rebase 地狱。**

**自检**：合并前必须通过哪四类检查？"先合后改"为什么是反面模式？

### 8. 按场景补充

| 场景 | 补充阅读 |
|------|---------|
| 功能 / 模块开发 | `processes/development.md` |
| 单点修复（修 bug、加参数） | `processes/collaboration.md` |
| 加插件 | `docs/specs/PLUGINS.md` + `docs/guides/plugin-dev.md` |
| 改 TUI | `docs/api/tui.md` |
| 改配置 | `docs/specs/SPEC.md` §6 |
| 写测试 | `docs/guides/testing.md` |
| 改文档 | 停止——先读 `docs/guides/DOC-MANAGER.md`（你不是开发者角色了） |

---

## 工程规范

- TS strict；async/await 全异步，**禁止 sync-in-async**（旧项目教训6）。
- 不可变优先；构造时注入全部状态，**不外部改私有字段**（教训7）。
- 事件类型用枚举 + payload schema，**禁止散落字符串字面量**（教训8）。
- 文件/命名：包内小写 kebab；接口 PascalCase；遵循各包既有风格。
- 测试：每模块配单测；MVP 验收见 [ROADMAP.md](docs/specs/ROADMAP.md) Phase 1。
- 提交格式：`<type>(<scope>): <subject>`（feat/fix/docs/refactor/test/chore）。
- 依赖方向：tui -> config -> core；core 不反向引用。

### 代码设计硬规则

以下规则在 PR 审查时由 reviewer 强制执行。触发时 reviewer 必须手动提问——没有"酌情跳过"。

#### 类型安全

**触发条件：单个 `.ts` / `.tsx` 文件中 `as` 类型断言出现超过 3 次。**
- 审查动作：reviewer 必须在 PR 中对每个超过 3 次的文件逐条提问："第 N 行的 `as` 断言能否替换为工厂函数、类型守卫或 zod schema？"
- 纠正动作：用 `makeXxx(...)` 工厂函数替代 `as Xxx` 构造；用 `isXxx(arg)` 类型守卫替代 `as Xxx` 消费。类型在编译时验证，而非运行时崩溃。

#### 函数复杂度

**触发条件：单个函数/方法体超过 50 行（不含空行和注释）。**
- 审查动作：reviewer 必须在 PR 中提问："这个函数承担了几项职责？能否拆为 2 个以上可独立测试的纯函数？"
- 纠正动作：提取模块级纯函数——每个函数用一个动词命名其唯一职责。拆分后原函数变为编排函数（< 20 行），仅含函数调用序列。

**触发条件：else-if 链条超过 5 个分支。**
- 审查动作：reviewer 必须在 PR 中提问："这组分支能否改用查表（Map/Dictionary）或策略模式（对象字面量 key → 处理函数）？"
- 纠正动作：用 `switch(true)` 或 Map 映射替代 else-if 链。新增分支仅需在表中加一行，不触碰分发逻辑。

#### 代码复用

**触发条件：同一模式在同一文件的 3 处以上重复出现。**
- 审查动作：reviewer 必须在 PR 中提问："这段逻辑出现 3 次——提取为共享工具函数后，这 3 处能否只保留一次调用？"
- 纠正动作：提取为模块级纯函数，输入输出类型化。bug 修一次、三处受益。

#### 提交前自检（30 秒机械扫描）

每项必须能够明确回答"是"。任一为"否" → 不推送。

- 当前 PR 的 diff 超过 500 行（不含测试文件）吗？是 → 拆分。禁止超过 500 行。
- 新增一个 case / tool / event 需要改超过 2 个文件吗？是 → 先重构为"只加不改"再提交。
- 类型签名本身说清楚了这段代码做什么吗？否 → 重命名类型/函数/变量直到签名自明。
- 这段逻辑能不启动整个应用单独测试吗？否 → 提取纯函数边界。

---

## 校验命令

```bash
bun run lint       # biome lint+format 检查（ADR-013）
bun run typecheck  # tsc --noEmit 类型检查
bun test           # 测试
bun run build      # 构建
```

提交前四项全绿。docs-only 改动至少跑 lint。

---

## PR 描述模板

推送前，PR body 中必须包含以下四段。缺少任一段 → reviewer 有权拒绝审查。

```
## 改动摘要
（一句话——改了什么、为什么、影响范围）

## 验证方式
（终端操作截屏/录屏/REPL 输入输出记录。TUI 改动必须附录屏。Core 改动必须附 REPL 验证记录。）

## 关联 Issue
Closes #<number>

## 涉及文件
- packages/xxx/src/yyy.ts  ← 改动原因（一行一个文件）
- docs/specs/zzz.md         ← 文档同步原因
```

---

## 完成的定义（Definition of Done）

PR 合并前，以下全部必须满足。缺一项 = PR 不合并。

| # | 条件 | 验证方式 |
|---|------|----------|
| 1 | Issue 验收标准全部满足 | Reviewer 对照 Issue body 逐条确认 |
| 2 | CI 四灯全绿（lint / typecheck / test / build） | GitHub Actions 状态检查 |
| 3 | 至少 1 人审批通过 | GitHub review approval |
| 4 | 无未解决的合并冲突 | GitHub mergeability check |
| 5 | 涉及接口变更 → `docs/api/` 和 `docs/specs/` 已同步更新 | Reviewer 检查 PR diff 中是否包含对应文档变更 |
| 6 | 无遗留 TODO / FIXME 标记进入 main | `grep -rn "TODO\|FIXME"` 在变更文件中无新增命中 |
| 7 | 涉及公共 API 变更 → 向后兼容性已在 PR 描述中声明 | Reviewer 检查 PR body "改动摘要"段 |
