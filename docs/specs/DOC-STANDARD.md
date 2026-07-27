# 文档书写规范（DOC-STANDARD）

> 本文档约束 Vessel 仓库中所有文档的编写规则。AI Agent 和人类贡献者共同遵守。
> 违反本规范的分支不得合并。

---

## 一、文档分层与不变性约定

```
docs/
├── specs/      ← 永久规格：不出现时间/状态/进度信息
├── guides/     ← 永久指南：只写可用的，不写"暂未实现"
├── api/        ← 永久参考：只写已实现的接口
└── dev/        ← 临时产物：可以有时间/状态/进度信息
```

### 核心原则

> **specs/guides/api 是仓库的宪法——讲设计是什么，不讲做到哪了。**

| 区域 | 允许 | 禁止 |
|------|------|------|
| `specs/` | 接口定义、架构描述、设计决策、`[plan]` 标记 | 时间标签、进度描述、"当前/暂/延后"等状态词 |
| `guides/` | 可执行的命令、可用的流程、已验证的步骤 | "暂不实现"、"待后续"、未实现功能的占位 |
| `api/` | 已实现的公开接口 | 未实现的接口声明、"coming soon" |
| `dev/` | 审查报告、调试记录、阶段总结 | —（无限制，这里是临时产物的家） |

---

## 二、禁用词与替换

### 2.1 状态标签（绝对禁止在 specs/guides/api 中出现）

| 禁用 | 原因 | 替换 |
|------|------|------|
| `pre-MVP` | 时间标签，阶段过了就过期 | 删除；或改为 `[plan]` 标记具体接口 |
| `MVP 范围内/外` | 同上 | `核心范围（IN/OUT）` |
| `Phase N 实现时` | 某个阶段才做的事不应写在永久规范里 | `实现时`（去掉 Phase 限定） |
| `暂不启用` | 读者不知道"暂"到何时 | 删除；或移到 `dev/` 做记录 |
| `延后到 Phase N` | 决策动作词 | ROADMAP 中用声明式：`Phase N 范围`；不允许在其他文档出现 |

### 2.2 时间词（禁止在 specs/guides/api 中出现）

| 禁用 | 替换 |
|------|------|
| `当前` | 删除，或描述设计意图本身 |
| `目前` | 同上 |
| `现在` | 同上 |
| `近期` | 删除；如需记录，放入 `dev/` |
| `以后` | 同上 |
| `暂时` | 同上 |

### 2.3 项目进度描述（仅允许在以下文档中）

以下描述只能出现在 `docs/dev/` 或 `CHANGELOG.md` 中：
- "已知问题"
- "Phase N 审查报告"
- "当前任务分工"（`processes/task-assignment.md`）
- "Bug 修复记录"

---

## 三、例外文档

| 文档 | 特殊规则 |
|------|----------|
| `docs/specs/ROADMAP.md` | 可以描述 Phase 分期（这是它存在的目的）。使用声明式语言（"Phase 2 范围"），不使用"延后/暂缓"等动作词 |
| `docs/specs/ADR.md` | ADR 记录历史决策，决策措辞按决策时原样保留。"当前"指决策时的判断，"延后"指当时的决策动作。不在此列限制 |
| `CHANGELOG.md` | 天生是时间文档，可使用版本号和日期 |
| `docs/dev/*` | 无限制——可自由使用时间/状态/进度描述 |
| `processes/*` | 可描述当前团队、当前流程、当前任务 |
| `CLAUDE.md` | 可引用 `docs/specs/` 中的 Phase 信息作为组织上下文，但本身不应在 §1-§8 中添加新时间标签 |

---

## 四、`[plan]` 标记规范

`[plan]` 是唯一允许在 specs/guides/api 中表示"尚未实现"的标记。

### 正确用法

```markdown
### 4.9 SessionBackend [plan]
interface SessionBackend {
  load(session_id: string): Promise<RunState | null>;
  save(state: RunState): Promise<void>;
}
```

- 标记在具体的接口/条目上，而不是整个文档
- 表示"设计已锚定，实现按 ROADMAP 分期交付"

### 错误用法

```markdown
> 状态：pre-MVP，很多东西还没实现         ← 禁止
> 当前只实现了 core 包                    ← 禁止
> 待后续版本完善                          ← 禁止
```

---

## 五、交叉引用规范

- 所有文档间引用使用相对路径
- specs/guides/api 之间的引用不受限制
- specs/guides/api **不得引用** `docs/dev/` 中的文档
- `docs/dev/` 可以引用 specs/guides/api
- `processes/` 可以引用 `docs/` 下所有文档

---

## 六、AI Agent 提交前自检

修改任何 `docs/specs/`、`docs/guides/`、`docs/api/` 下的文件后，AI Agent 必须执行：

```
grep -rn "当前\|目前\|现在\|暂时\|暂不\|延后\|近期\|以后\|pre-MVP\|MVP 范围\|Phase.*实现时" docs/specs/ docs/guides/ docs/api/
```

命中任一即违规，修改后方可提交。
