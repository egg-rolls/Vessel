# 文档管理：动静分离与生命周期

> 适用：本仓库 `docs/**` 与根目录长期文档。
> 本文是共享侧文档归属与生命周期的**唯一权威**；文件放哪里、谁能写、分支与发布规则见
> [FILE-MANAGEMENT.md](FILE-MANAGEMENT.md)。两者冲突时，路径归属以 FILE-MANAGEMENT 为准，
> 文档分类与写法以本文为准。

## 0. 一句话

**当前态用单文件覆盖，历史用只追加记录；规则不写状态，临时产物有保质期。**

## 1. 动静分离

| 维度 | 静态（S）                                                             | 动态-当前（O(1)）                          | 动态-历史（O(n)）                                             |
| ---- | --------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------- |
| 内容 | 规则、架构、约定                                                      | 现在进行到哪                               | 为什么这么定、当时落了什么                                    |
| 变化 | 很少                                                                  | 每个版本 / 任务                            | 每个版本 / 决策                                               |
| 写法 | 就地维护                                                              | **整文件覆盖**                             | **只追加，不改写**                                            |
| 体积 | 有界                                                                  | 有界（硬上限）                             | 随时间增长，必须有索引                                        |
| 例子 | `AGENTS.md`、`README.md`、`docs/FILE-MANAGEMENT.md`、`docs/WEB-UI.md` | `docs/versions/CURRENT.md`、`CHANGELOG.md` | `docs/versions/*.md` + `INDEX.md`、`docs/adr/*` + `README.md` |

判断一个文件属于哪类，不看它“重不重要”，看**下一个读它的人需要什么**。

静态文档可以按模块拆分（`docs/architecture/**`、`docs/agents/**`），但必须有 `INDEX.md` + frontmatter；拆出的 `current` 文档仍禁版本叙事（见 §3.4）。

## 2. 判定顺序（从上往下，命中即停）

1. 不读它，下一个人会不会做错？会 → **当前态 O(1)**。
2. 它约束未来的实现/接口吗？是 → **决策 O(n)**。
3. 它是过去结果的证据或版本快照，可能被追溯吗？是 → **记录 O(n)**。
4. 只是这次任务的草稿/探针/截图？→ **临时产物，收口删除**。
5. 以上都不是 → **删除**。

反例：把“0.14 做了什么”写进 `AGENTS.md`；把“为什么选 A”写进 `CHANGELOG.md`；
把“当前基线”写进 ADR 索引——都是把不同类塞进一个容器。

**历史只有两个容器：`docs/versions/`（版本快照）与 `docs/adr/`（决策）；不新建第二个历史目录。**

## 3. O(1)：当前态

### 3.1 允许的文件

| 文件                       | 回答什么                     | 硬上限           |
| -------------------------- | ---------------------------- | ---------------- |
| `docs/versions/CURRENT.md` | 当前版本、已合入能力、下一步 | ≤60 行           |
| `CHANGELOG.md`             | 当前版本的变更摘要           | 只保留当前版本段 |
| `AGENTS.md`                | AI 行为约定与硬规矩          | ≤150 行；不写版本状态 |
| `README.md`                | 是什么 / 怎么跑 / 边界       | 不写版本状态     |
| `docs/FILE-MANAGEMENT.md`  | 文件放哪里、路径归属         | 不写版本状态     |
| `docs/DESIGN.md`           | 跨外壳设计系统规则           | 不写版本状态     |
| `docs/WEB-UI.md`           | Web 组件与视觉约定           | 不写版本状态     |

### 3.2 硬规则

1. **整文件重写**：每次更新先删掉所有与当前基线不符的段落，再写当前事实。禁止追加。
2. **唯一基线**：一个文件只能有一个当前版本。旧版本段落删除，不保留“历史对照表”。
3. **不写历史**：不写版本结果章节、交接记录、commit 清单、已完成版本的细节。
4. **有界**：`CURRENT.md` ≤60 行；超出就写 `docs/versions/<version>.md`，当前态只留一行指针。
5. **只写事实与下一步**：路径、命令、证据、决定、阻塞。不写“差不多了”“基本完成”。
6. **版本号单源**：manifest 版本以根 `package.json` 为准，文档不维护第二份副本。
7. **禁版本叙事**：不得出现 `## 0.x` / `### 0.x`、逐版本“已实现 / 未发布”章节或“自 0.x 起”历史。版本结果写 `docs/versions/<version>.md`，原因写 `docs/adr/ADR-<NNN>-<slug>.md`；current 文档只留当前事实与指针。

### 3.3 历史往哪搬

| 内容                             | 去处                             |
| -------------------------------- | -------------------------------- |
| 某个版本落了什么、breaking、遗留 | `docs/versions/<version>.md`     |
| 为什么做这个选择、冻结了什么契约 | `docs/adr/ADR-<NNN>-<slug>.md`   |
| 当前版本摘要                     | `CHANGELOG.md`（只保留当前版本） |

### 3.4 可检索静态文档（拆分规则）

`current` 文档超过 **300 行**或 **100 KB** 时，必须按模块拆分到 `docs/architecture/**` 或 `docs/agents/**`，不得继续整篇常驻（`target` 不适用本句，见下）。

- 目录必须有 `INDEX.md`：`docs/architecture/INDEX.md` 与 `docs/agents/INDEX.md` 各 ≤60 行，列为「模块（含链接）| 一句话 | triggers | paths」；`INDEX.md` 自身为 **guide**（`kind: guide` + `children`）；guide / target 模块在模块名后标注 kind。
- `current` 模块 ≤110 行（`advisory` ≤60 行，`guide` ≤60 行只导航不落事实）；`target` 允许长文档（上限 600 行，人工守）；一个事实只有一个家，其余位置用链接，不复制。
- frontmatter 必填 `title` / `kind` / `triggers`；`kind` 只允许 `current` / `advisory` / `target` / `guide`。leaf（`current` / `advisory`）必填 `paths`（代码锚点）；`guide` 必填 `children`（下层文档相对路径），**children 与 paths 互斥**；`advisory` 另加 `applies_to`（`N` / `M`）。`triggers` 写任务里会出现的词，`paths` 是 glob，命中优先于关键词。

```yaml
---
title: Gateway RPC
kind: current
triggers: [gateway, rpc, websocket, token, permission]
paths: [packages/serve/**, apps/web/src/gateway/**]
---
```

#### `target` 文档类

`target` 描述**目标 / 迁移态**，不是现态。只允许放在 `docs/architecture/**`，并满足：

1. 顶部必须有 banner：声明「目标 / 迁移态，非现态」，并链接决策 ADR（如 ADR-098）。
2. 只写目标模型与迁移分期；不得把目标态写成「已实现」，也不得替代架构页正文。
3. 随 Stage 更新，git 历史即版本；Stage 落地后由对应 `current` 架构页承接。
4. 允许长文档（上限 600 行，人工守），不按 `current` 的 100 行模块规则拆分。
5. `INDEX.md` 为 `guide`；target 模块在索引行的模块名后标注 `kind: target`。

`current` 的 110 行模块规则与 300 行拆分规则不变。

- 未拆分的存量文档在迁移完成前 grandfather；新增或重构的 `current` 文档立即适用。
- frontmatter、INDEX 覆盖、行数与链接**没有自动校验**（`check-docs` 已按宪法删除），reviewer 逐项核对；新增/重构文档立即生效，存量在迁移完成前 grandfather。

### 3.5 同步契约（绑代码叶子 ↔ 代码）

- **需同步文档 = 绑代码叶子**：`kind: current / advisory` 且有代码 `paths`。`paths` = 同步范围，**收窄到事实锚点**（具体文件优先，单一子系统 glob 次之；禁包根/全仓宽 glob）；共享锚点（如 `execution-unit.ts`）允许多叶同挂，各管一个侧面。
- **guide 排除代码同步**：`kind: guide` 只有 `children`（下层文档相对路径），无 paths、无 churn；正文只导航不落事实（事实在叶子），≤60 行。义务 = 叶子增删时维护 children 登记；`INDEX.md` 即根/目录 guide。导航允许多父，**事实家唯一**。
- **自绑稳定页（快照类）**：无代码锚点的稳定知识/裁定规则 `paths: [自身]`，churn 恒 0，不需同步不管。`kind: target`、历史容器（`versions/`、`adr/`）与 `specs/`（冻结定稿）同样排除。根 O(1) 文件（AGENTS/README/CHANGELOG）需同步，范围 = 全仓命令/路径/版本事实（无 frontmatter 是设计如此，§3.1）。
- **同步基线 = 最近一次触碰该文档的 commit**（git 历史是唯一记录；不加字段、不存状态文件）。文档同步 commit 带 `Synced-to: <sha>` trailer，供 `git log --grep=Synced-to -- <doc>` 查验证基线。
- **检测**：`bun run scripts/doc-sync.ts [--threshold N] [--json] [--doc <path>] [--all] [--quiet]`。原理 = `git log -1 --format=%h -- <doc>` 取基线 + `git diff <sha>..HEAD -- <paths>` 列变更；churn 只是上界，语义确认与更新判断归人。`treeGaps` 信息性浮现未登记叶子 / children 死链。`--quiet` = 订阅脚本契约（仅滞后清单，无滞后 stdout 全空）。**「确认无需改」标记**（q-subscription-script-p1）：语义确认者把 `{ "<leaf>": { "sha", "reason"(必填), "at" } }` 写入 `docs/doc-lag-marks.json`（扫描集之外，commit 标记不触叶子基线）；doc-sync 双向 ancestor 校验（基线→sha→HEAD）通过后 lag 只数 sha 之后 churn（精确抑制虚高段，非清零）——这是语义确认登记，不是基线状态（基线仍以 git 历史为唯一记录）。
- **工具分类**：信息性 sync 检测工具（docs-find 类）允许；gate/test/probe 仍禁（宪法第三/四条）。被删的 check-docs 是正确性校验器（断言合规、红绿阻塞）；doc-sync 是 churn 信息辅助（浮现候选、不校验对错、不阻塞、exit 恒 0），不同类——不重造 check-docs，不接 CI / pre-commit。
- **义务落叶子**：合并某叶子 paths 下代码变更时，同切片同步该叶子或显式向 1 报告滞后由 1 裁决延期；guide 不因代码合并触发；检查点跑 doc-sync 复核。
- **specs 容器**：`docs/specs` = 定稿规格（实现前读、实现后冻结；允许 `kind: design` + `status`；退场转历史按宪法 09）；不需同步。
- 引用优先 `file:symbol`；行号仅在必要时写，同步时重锚。

## 4. O(n)：历史记录

### 4.1 只追加，不改写

- 已写下的决策与版本记录**不重写结论**。
  新决定推翻旧决定 → 新写一条 ADR，并在 frontmatter 标注 `supersedes`。
- 允许的修改只有两类：**修死链**（路径因归档变化）和**补索引行**。正文事实不改。
- 每条记录必须有：标识（版本 / ADR 编号 / 日期）、一句话结论、指针（相关 ADR / 版本）。

### 4.2 命名与目录

```text
docs/
├── versions/
│   ├── INDEX.md                 # 版本索引：新的在前
│   ├── CURRENT.md               # O(1) 当前态
│   ├── <version>.md             # 0.25.0 / 0.9.0 / 0.2.0
│   └── ...
└── adr/
    ├── README.md                # ADR 索引 + 编写约定
    └── ADR-<NNN>-<kebab-slug>.md
```

- 版本号取 `X.Y` 或 `X.Y.Z`，`X.Y` 一律归一为 `X.Y.0`；文件名只增不改。
- 一个版本一个文件；同一版本的多个切片（如 0.19 S2 / S3）写入同一个版本文件。
- ADR 文件名固定 `ADR-<三位序号>-<kebab-slug>.md`；编号不复用。
- 超过一屏的记录拆成“结论 + 指针”，细节留在对应版本文件或 ADR。

### 4.3 索引是硬要求

每个 O(n) 目录必须有索引：
- `docs/versions/INDEX.md`：一行一条，版本 | 日期 | 主题 | 状态（merged / unreleased）| 链接；
  新的在前。
- `docs/adr/README.md`：一行一条，编号 | 标题 | 状态（proposed / accepted / superseded）| 链接；
  编号升序；索引与文件是否一致靠 reviewer 逐条核对（原校验脚本已按宪法删除）。
- **没有索引的 O(n) 目录视为违规**：读者只能靠列目录猜，等于没有组织。

## 5. 临时产物（TTL）

- 探针、截图、草稿、一次性脚本放**个人侧**（外层仓 `docs/dev/tmp/`，已 gitignore）或系统临时目录；
  禁止写进仓库根、`docs/` 或提交到 git。dev 文档（plans/reports/research/design/specs/审计）一律写个人侧
  外层仓 `D:/Application/APP/Vessel/docs/dev/`；代码仓无 `docs/dev/`（见 [FILE-MANAGEMENT.md](FILE-MANAGEMENT.md) §2）。
- 不跨检查点保留。收口时删除；需要留证的，先转成 `docs/versions/<version>.md`
  里的结论或一条 ADR。
- 删除前列清单；临时目录不是知识库。

## 6. 代码注释

代码注释只解释**值、坑、约束**，不是文档索引：
- 写：为什么必须这样、不能怎样、边界与不变量、对应的 ADR。
- 不写：版本快照路径、个人侧报告等指针；CHANGELOG 指针；
  “0.x 时改成……”一类版本叙事。
- **ADR 引用允许**：ADR 是稳定契约，注释可以指向 `ADR-<NNN>`。
- 版本号只作为有意义的常量 / 协议值出现（如协议版本、数据布局版本），
  不写成“本文件在 0.x 做过什么”。

## 7. 阅读顺序

**冷启动（要知道现在是什么）：**
1. `README.md`
2. `AGENTS.md` — **硬安全规则只来自这里**
3. `docs/versions/CURRENT.md`
4. `docs/architecture/INDEX.md` → 命中的模块；不整读 >300 行的 current 文档

**按目标检索：** 先写目标 + 目标路径，再按 INDEX 的 `triggers` / `paths` 命中模块；不整读 >300 行的 `current` 文档。无命中时回落 `AGENTS.md`，不把“没搜到”当成“没规则”。

**机器检索：** `bun run scripts/docs-find.ts --goal "<目标>" [--paths <路径>] [--json]`；读 top 3 + `AGENTS.md`；退出码 1 表示无命中，必须回落 `AGENTS.md` 硬规则。

扫描范围：`docs/architecture`、`docs/agents`（共享侧），加上最近祖先目录下的 `docs/constitution`、`docs/lessons`、`docs/roles`（个人侧；个人侧根目录跑时输出 `../../docs/...`，找不到时静默跳过，CI 与单独 clone 不受影响）。**每篇规则文档都必须有非空 `triggers`**，否则永远不被召回。

**溯源（要知道为什么 / 当时落了什么）：**
1. `docs/adr/README.md` — 先找约束
2. `docs/versions/INDEX.md` — 再找版本快照
3. `docs/operations/**` — 最后看运维细节

**禁止**用“列目录 + 逐个打开”代替索引。

## 8. 维护责任

| 文件                                                                               | 谁写                               |
| ---------------------------------------------------------------------------------- | ---------------------------------- |
| `docs/DOC-MANAGEMENT.md`、`docs/FILE-MANAGEMENT.md`、`docs/DESIGN.md`、`docs/WEB-UI.md` | `gov`                         |
| `docs/adr/**` 与 `docs/adr/README.md`                                              | `gov`；提案人起草，`gov` 登记索引  |
| `docs/versions/<version>.md`、`docs/versions/INDEX.md`、`docs/versions/CURRENT.md` | 版本收口人（`1`）在合并/收口时更新 |
| `AGENTS.md`、`README.md`                                                           | `gov` 主笔；各角色提需求           |
| `CHANGELOG.md`                                                                     | 版本收口人（`1`）                  |
- 写索引时先看同类最新一条，保持格式一致；不要新建“第二套写法”。
- 并行开发时索引由收口人统一更新，避免多人同时改同一文件。
- **doc forge 独立 worktree**：批量文档改动走独立 worktree + 合 doc 分支入 main，禁直写 main 工作树（防共享 index 互扫）；≤2 叶豁免须 pathspec 提交（`git commit -- <paths>`）且即完即提（2026-11-28 doc-refresh 批教训成文）。

## 9. 反模式（见到就改）

- 在 `AGENTS.md` / `README.md` / `CHANGELOG.md` 里追加“0.x 结果”“版本状态”段落。
- 一个当前态文件保留多个基线 / 多个版本段落。
- 为每个版本复制一份当前态文件，或建 `README-<date>.md`。
- 把历史摘要、已完成待办、旧分支状态留在当前态文件里。
- O(n) 目录没有 `INDEX.md`，或索引与文件不一致。
- 改写旧 ADR / 版本记录的结论；应新写一条并标 `supersedes`。
- 临时产物跨检查点保留，或把临时目录当证据库。
- 代码注释指向版本快照、个人侧文档或 CHANGELOG。
- 在 `current` 文档里写 `## 0.x` / `### 0.x`、逐版本“已实现 / 未发布”章节或“自 0.x 起”历史。
- 拆分了文档却没有 `INDEX.md` / frontmatter，或 INDEX 与模块不一致。
- 把 >300 行的 `current` 文档整篇读进上下文，而不是 INDEX + 命中模块。

## 10. 检查清单

收口前：
- [ ] `docs/versions/CURRENT.md` ≤60 行，只有一个当前版本，无历史章节
- [ ] `AGENTS.md` / `README.md` / `docs/FILE-MANAGEMENT.md` / `docs/DESIGN.md` / `docs/WEB-UI.md` 无版本状态
- [ ] `current` 文档无 `## 0.x` / `### 0.x`、无逐版本“已实现 / 未发布”章节与“自 0.x 起”叙事
- [ ] 拆分后的模块有 INDEX 与 frontmatter：模块 ≤110 行、INDEX ≤60 行、链接无死链
- [ ] current/advisory 文档与 paths 下代码同步（doc-sync 检测 + 语义确认；滞后已报 1 裁决）
- [ ] 检索走 INDEX 的 `triggers` / `paths`，未整读 >300 行的 `current` 文档
- [ ] 任务开工跑过 `docs-find`（有命中读 top 3；无命中已回落 AGENTS.md 并记录）
- [ ] 本批次版本事实已写入 `docs/versions/<version>.md`，并有一行 `INDEX.md`
- [ ] 新增 ADR 已进 `docs/adr/README.md`
- [ ] `CHANGELOG.md` 只保留当前版本段
- [ ] 代码注释无版本文件 / 个人侧文档指针
- [ ] 临时产物已清空或只在个人侧
