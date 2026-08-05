# Git 协作原则与合并门禁

> 本文档定义 Vessel 项目的 Git 工作流、AI 合并审查规范、以及合并前必须通过的验证门禁。
> **核心信条：合并前验证，不合并后修复。**

---

## 一、分支模型

```
main          ──●────●────●────●──  始终可部署；受保护
                 \   /    \   /
feature/xxx   ──●──●──    ─●──    功能分支
fix/xxx       ──●──               修复分支
docs/xxx      ──●                 纯文档分支
```

### 规则

| 规则 | 说明 |
|------|------|
| `main` 始终可部署 | 不允许 `main` 上有已知缺陷 |
| 一个分支一个关注点 | 禁止一个分支混杂 feature + refactor + fix |
| 从 `main` 切分支 | 不从其他 feature 分支切 |
| 合并前 rebase | 保持线性历史；解决冲突在 feature 分支上 |
| 禁止 force push main | 永远禁止 |
| 禁止合并后修复 | merge-then-fix 模式不允许；有问题在分支上修完再合 |

---

## 二、合并门禁（Merge Gate）

以下 **全部** 通过后，方可合并到 `main`：

### 2.1 AI 架构规范检查（必须）

合并前，AI Agent 必须对照以下全部文档逐条检查：

| 文档 | 检查内容 |
|------|----------|
| `docs/specs/SPEC.md` | 新代码是否违反接口契约、模块边界 |
| `docs/specs/ADR.md` | 是否违反已有架构决策 |
| `docs/specs/ROADMAP.md` | 是否超出 ROADMAP 定义的范围 |
| `CLAUDE.md` + `../role/DEVELOPER.md` | 工程规范、能力分层、红线 |

**检查清单**（由 AI Agent 执行并输出结论）：

```
[ ] 依赖方向：core 未引用 tui/config/plugins
[ ] 能力分层：新代码按决策树正确分类（core/插件/应用层）
[ ] 红线：未触碰 AGENTS.md §4 红线
[ ] 扩展机制：未新增第二套扩展路径（ADR-004）
[ ] 事件类型：未使用散落字符串发事件（ADR-008）
[ ] 同步调用：未在异步路径中混入同步阻塞调用
[ ] 半成品：无 NotImplementedError / 空实现进 core
[ ] 文档诚实：未在文档中声称未实现功能
```

### 2.2 CI 自动化检查（必须）

| 检查项 | 命令 | 说明 |
|--------|------|------|
| Lint + Format | `bun run lint` | Biome 检查 |
| Typecheck | `bun run typecheck` | `tsc --noEmit` |
| 单元测试 | `bun test` | 全部测试通过 |
| 构建 | `bun run build` | 构建成功 |

**四项必须全绿，任一不通过则阻断合并。**

### 2.3 安全检查（必须）

```bash
# AI Agent 必须执行
grep -rE "(sk-[a-zA-Z0-9]{20,}|api_key\s*[:=]\s*['\"][^'\"\s]{20,})" packages/ plugins/ src/ 2>/dev/null
```

- 不允许硬编码 API Key / Token / 密钥
- `.env` 必须在 `.gitignore` 中
- 仅 `.env.example`（模板，无真实值）可提交

### 2.4 回归确认（必须）

- 不影响已有功能的正确性（由 `bun test` 和手动抽查覆盖）
- 公共 API 变更必须有对应测试更新

---

## 三、AI Agent 合并审查流程

当人类请求"合并 feature 分支到 main"时，AI Agent 按以下流程执行：

```
1. 获取分支 diff
2. 对照 docs/specs/ 全部文档检查架构合规
3. 对照 ../role/DEVELOPER.md（工程规范+能力分层）+ AGENTS.md §4 红线 检查规范
4. 检查硬编码密钥
5. 确认 CI 状态（lint/typecheck/test/build）
6. 输出审查结论（通过/阻断 + 原因；发现问题时给出修复建议）
7. 全部通过 → 执行合并
8. 合并后删除远程 feature 分支
```

### 关键原则

```
禁止在 main 上直接修改 → 先切修复分支 → 审查 → 合并
禁止跳过门禁合并且口头承诺"稍后修复" → 稍后永远不会发生
禁止 AI Agent 自行决定放宽门禁 → 任何豁免需人类明确确认
```

---

## 四、Commit 规范

```
<type>(<scope>): <subject>

type:     feat | fix | docs | refactor | test | chore
scope:    core | config | tui | plugins | docs | ci
subject:  中文或英文，简短描述（≤ 72 字符）
```

示例：
```
feat(core): 添加 AgentRuntime.toolCallingLoop 实现
fix(config): 修复 YAML 解析器嵌套键处理
chore(ci): 添加 Biome lint 到 CI 流水线
```

---

## 五、合并审查规范

- 推送分支后创建 PR，CODEOWNERS 自动请求 Reviewer 审查
- 审查对照 AI Agent 检查清单（../role/REVIEWER.md）+ 安全检查（§2.3）
- CI（lint/typecheck/test/build）四灯全绿后方可合并
- Reviewer 在 PR 页面点击 "Squash and merge" 执行合并

---

## 六、反面模式（Anti-Patterns）

### 6.1 流程级

| 模式 | 说明 | 为什么错 |
|------|------|----------|
| "先合后改" | 合并有已知问题的代码，承诺 follow-up 分支 | follow-up 永不来，main 积累债务 |
| "太大了审查不了" | 一个分支几千行，审查者放弃 | 拆成多个小分支，逐一审查 |
| "就改一行" | 跳过 CI/审查，直接推 main | 一行也可能 break everything |
| "CI 红了但我知道为什么" | 忽略 CI 失败，强行合并 | CI 反映的状态才是真相 |
| "晚上合，没人看到" | 利用时差逃避审查 | lint 和 test 24/7 在线 |

### 6.2 代码级（设计质量）

> 审查时不仅仅看"功能对不对"，还要看"结构能不能扛住未来的变化"。
> 短期的正确 ≠ 长期的健康。以下不是 checklist——是审查时引导判断的方向。

**核心标准**：代码应该经得起"3 个月后的改动"。一个模块今天能跑不是终点，3 个月后加新功能时能不能只改一小块、其余不碰，才是真质量。

**审查视角**（审查代码时问自己的问题）：

- 这段逻辑能**独立于应用启动**被测试吗？如果不能，是不是缺少了某个可提取的纯函数边界？
- 新增一个 case / 事件 / 工具需要改**几处代码**？如果能只加不改（开闭原则）——这是好设计。如果每次都要趟一遍核心分发路径——这是脆弱的信号。
- 改这段代码时，有没有**意外的副作用**波及不相关功能？有，说明耦合没拆开。
- 类型系统在**帮你还是你在骗它**？代码中大量 `as` 断言意味着类型在关键路径上被绕过，重构时这些点最可能静默断裂。

**常见"抄近路"信号**（不是罪，是提醒多看一眼）：

- 任一函数/组件超过 ~50 行 → 职责可能不止一个
- 同一模式在 3 处以上重复 → 值得提取
- switch/if-else 链条超过 5 个分支 → 考虑查表或策略
- 顶层的 `let` 变量 / 模块级可变状态 → 应限定到实例作用域

以上不是禁令。有时 55 行的函数就是比拆成 3 个更清晰。关键是**你有意识地做了这个判断**，而不是任由代码长成没人修剪的灌木。

> 人类审查者有最终裁量权。AI 审查者应标记信号并给出重构建议，但不硬性阻断——除非信号指向明确的正确性问题。

---

## 七、分支生命周期

```
创建：git checkout -b feature/xxx main
开发：正常 commit + push
同步：git rebase main（解决冲突）
推送：git push --force-with-lease（rebase 后）
创建 PR：gh pr create 或 GitHub Web UI（CODEOWNERS 自动请求审查）
审查：AI Agent 架构检查 + Reviewer 最终审查
合并：通过所有门禁后，在 PR 页面点击 "Squash and merge"
清理：合并时勾选 "Delete branch" 自动删除远程分支
```

### 7.1 Rebase 最佳实践——避免"一直 rebase"

**核心原则：rebase 的痛和分支的生命周期成正比。分支活得越久、改动越大，rebase 越痛。治本之道不是"更频繁地 rebase"，而是"让分支更短命"。**

| 做法 | 为什么 |
|------|--------|
| **分支保持小而短** | 一个分支一个关注点，几百行以内，1-2 天合入。小分支的 rebase 通常零冲突 |
| **只在需要时 rebase** | 不是 main 每前进一个 commit 就要 rebase。只在以下时机 rebase：(1) 创建 PR 前；(2) 已知 main 有你需要的修复；(3) PR 审查通过、合并前最后同步 |
| **rebase 前先拉最新 main** | `git checkout main && git pull --ff-only && git checkout -` 再 `git rebase main`。不要用本地的旧 main |
| **冲突太多 → 分支太大了** | 一次 rebase 超过 5 个冲突？说明这个分支塞了太多东西。考虑拆成多个小 PR |
| **协作分支用 merge 不用 rebase** | 多人共用一个 feature 分支时，用 `git merge main` 而非 `git rebase main`。rebase 会改写历史，协作场景下是灾难 |
| **rebase 后 force-with-lease** | 永远用 `--force-with-lease`，不用 `--force`。前者会在远程有他人提交时拒绝推送，保护协作者的工作 |

### 7.2 分支同步策略速查

| 场景 | 命令 | 理由 |
|------|------|------|
| main 拉取 | `git pull --ff-only` | main 上不应有本地提交；有则报错暴露问题，而非静默生成 merge 提交 |
| feature 同步 main | `git rebase main` | 保持线性历史；PR 最终 Squash merge 为一个 commit，中途不必制造分叉形状 |
| 多人共用分支 | `git merge main` | rebase 改写历史会导致协作者本地与远程不一致，是协作灾难 |

> **为什么是 Squash merge？** 每个 PR 合入 main 时压缩为一个 commit，保证 `git log --oneline main` 每个 ● 对应一个 PR。好处：git bisect 不会落在半成品 commit 上；revert 只需一条命令；blame 指向有意义的 PR 而非 "fix typo"。

**设置**：每个贡献者在本地执行 `git config pull.ff only`，确保 main 拉取走 fast-forward-only 策略。
