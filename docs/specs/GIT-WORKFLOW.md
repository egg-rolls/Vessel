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
| `CLAUDE.md` | §4 工程规范、§5 能力分层、§6 红线 |

**检查清单**（由 AI Agent 执行并输出结论）：

```
[ ] 依赖方向：core 未引用 tui/config/plugins
[ ] 能力分层：新代码按决策树正确分类（core/插件/应用层）
[ ] 红线：未触碰 CLAUDE.md §6 的 10 条红线
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
3. 对照 CLAUDE.md §4-6 检查规范+红线
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

- 分支推送后通知egg-rolls审查
- 审查对照 AI Agent 检查清单（CLAUDE.md §9.1）+ 安全检查（§2.3）
- CI（lint/typecheck/test/build）四灯全绿后方可合并
- egg-rolls执行合并 → 删除远程分支

---

## 六、反面模式（Anti-Patterns）

| 模式 | 说明 | 为什么错 |
|------|------|----------|
| "先合后改" | 合并有已知问题的代码，承诺 follow-up 分支 | follow-up 永不来，main 积累债务 |
| "太大了审查不了" | 一个分支几千行，审查者放弃 | 拆成多个小分支，逐一审查 |
| "就改一行" | 跳过 CI/审查，直接推 main | 一行也可能 break everything |
| "CI 红了但我知道为什么" | 忽略 CI 失败，强行合并 | CI 反映的状态才是真相 |
| "晚上合，没人看到" | 利用时差逃避审查 | lint 和 test 24/7 在线 |

---

## 七、分支生命周期

```
创建：git checkout -b feature/xxx main
开发：正常 commit + push
同步：git rebase main（解决冲突）
推送：git push --force-with-lease（rebase 后）
通知：告诉egg-rolls分支已就绪
审查：AI Agent 架构检查 + egg-rolls最终审查
合并：通过所有门禁后egg-rolls执行 merge
清理：egg-rolls删除远程 feature 分支
```
