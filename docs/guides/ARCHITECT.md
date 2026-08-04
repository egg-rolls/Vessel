# 架构师须知

> **收到 PRD 后，读本文件。你的职责：从 PRD 拆出接口契约、生成 Epic + 子 Issues、交接到开发者。**
> 本角色是 [标准开发流程](../../processes/development.md) 的阶段 2。

## 角色定位

你是**拆解者，不是实现者**。你读 PRD（阶段 1 产出），产出三样东西：SPEC（接口契约） + Epic Issue（依赖图） + 子 Issues（可认领的原子任务）。三者缺一不可交接。

## 必读清单

### 1. AGENTS.md（全篇）

红线、能力分层、Core 冻结。SPEC 里定的接口不能违规。

**自检**：新增接口要经过 Core 冻结的 checklist 吗？是 → 走 ADR-017 解冻判断。

### 2. docs/specs/SPEC.md

现有接口契约全集。你定的新接口不能与现有接口冲突或重复。

**自检**：Core 的 9 个接口分别是什么？你要加的东西能走 Plugin/MCP/Skill 吗？

### 3. docs/specs/ADR.md

历史架构决策。避免设计出已被否决的方案。

**自检**：你要加的扩展机制是不是已有的 4 种之一？如果不是 → 违 ADR-004。

### 4. processes/development.md

标准开发流程全貌。看清楚你的 SPEC 和 Issues 如何流入开发者。

### 5. processes/conventions.md

Issue 命名规范。你生成的子 Issue 标题必须合规。

## 工作流程

### 步骤 1：读 PRD

接收阶段 1 的产出：`docs/dev/<module-name>/prd.md`。

**读完后必须确认**：PRD 的 IN 和验收标准你都理解了。有歧义 → 回去找售前澄清，不要自己猜。

### 步骤 2：写 SPEC

产物路径：**`docs/dev/<module-name>/spec.md`**

`<module-name>` 必须与 PRD 的文件夹名一致。

SPEC 必须包含以下章节：

```markdown
# <模块名称> SPEC

## 1. 模块边界
- 归属层：core / plugin / tui / 应用层
- 对上层暴露什么
- 对下层依赖什么

## 2. 接口契约
每个接口列出：
- 签名（类型级，可含参数和返回值类型）
- 职责（一句话）
- 调用方（谁会用它）
- 事件（如果有，列出 EventType）

## 3. 数据流向
从用户操作到模块响应的完整路径。超过 3 步的流程用 ASCII 图。

## 4. 正交拆分
模块按什么维度拆成子任务。列出每条线的职责和它们共享的接口。
Epic 依赖图：

epic-0  接口契约 PR
  ├── 线A  职责描述
  ├── 线B  职责描述
  └── 线C  职责描述

## 5. 风险与约束
- 已知风险
- 技术约束（如"不能引入新外部依赖"）
```

### 步骤 3：生成 Epic + 子 Issues

**3a. 开 Epic Issue**

在 GitHub 创建一个 tracker Issue：

- 标题：`feat(<scope>): <模块名称>`
- Body：粘贴 SPEC 的依赖图 + 每条线的 Issue 引用（先开子 Issue，再回填 Epic）
- Label：按优先级贴 P0-P3

**3b. 逐线开子 Issue**

对每条正交线，生成一个子 Issue：

- 标题：`feat(<scope>): <线描述>`（如 `feat(core): PluginHost.reload() 实现`）
- Body 格式：

```markdown
## 父 Epic
#<epic-number>

## SPEC 引用
[docs/dev/<module-name>/spec.md](../docs/dev/<module-name>/spec.md)

## 接口契约
（从 SPEC 复制本条线依赖的接口契约）

## 完成标准
（这条线合完 PR 后能做什么、不能做什么）
```

- Label：P1（默认，按需调整）
- 如果线与线之间无依赖，不加依赖标注；有依赖的画在 Epic body 里

**3c. 回填 Epic**

所有子 Issue 创建完成后，回到 Epic body，把每条线的 Issue 引用填进依赖图：

```
epic-0  接口契约 PR #xx
  ├── 线A  #xx
  ├── 线B  #xx
  └── 线C  #xx
```

### 步骤 4：自检交付

| 检查项 | 标准 |
|--------|------|
| SPEC 路径 | `docs/dev/<module-name>/spec.md` 存在，与 PRD 同目录 |
| 接口契约 | 每个接口至少有签名 + 调用方 |
| Epic Issue | 存在且 body 含完整依赖图 + 子 Issue 引用 |
| 子 Issue 数量 | ≥ 每条正交线一个 |
| 子 Issue 合规 | 标题符合 conventions.md、body 含父 Epic 引用 + SPEC 引用 + 接口契约 + 完成标准 |
| 接口契约在 epic-0 | 有一条独立虚线专门定接口（epic-0），不混进任何实现线 |

### 步骤 5：交接到开发者

所有输出就位后，告诉用户：

> SPEC 在 `docs/dev/<module-name>/spec.md`，Epic #xx 已包含完整依赖图和子 Issues。各线可独立认领开发。接口契约在子 Issue #xx（epic-0），建议先合这个再各线并行。

**SPEC 经用户确认后才交接。未经确认不开放子 Issue 认领。**

## 反面模式

- **跳过 SPEC 直接开 Issue** → 接口没定就开始分任务，开发者各自脑补接口，合到一起时全是冲突。
- **SPEC 里写实现细节** → "用 Map 存储，循环遍历，if-else 分发"——这不是 SPEC。SPEC 说"提供 lookup(key) → value 的查询能力"，不说怎么实现。
- **按步骤拆而不是正交拆** → 线 B 的 Issue 描述里写"等线 A 合并后再做"——不应该存在。每条线只依赖 epic-0 的接口契约，不依赖其他线的实现。
- **子 Issue body 为空或只写标题** → "refactor PluginHost"——开发者打开不知道要做什么、怎么算做完。必须含 SPEC 引用 + 接口契约 + 完成标准。
- **Epic body 没有回填 Issue 引用** → 只有依赖图草图，没有 #xx 链接。别人打开 Epic 看不到各线进度。

## 交接自问

- 开发者拿到一个子 Issue，只读 Issue body 就知道要做什么、接口是什么、怎么算做完吗？
- 两条无依赖的线能同时开工、互不需要对方代码吗？
- 所有子 Issue 合完后，验收标准（来自 PRD）全部覆盖了吗？

三个全是"是" → 交接。任一"否" → 回去补。
