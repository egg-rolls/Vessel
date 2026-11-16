# 文档结构审计 + 分类/检索方案（提案）

```
owner: docs-audit（main 采纳后改为 main）
生效版本: 0.54
优先级: P2（在飞，本版内分批执行）
用途: 两个仓 docs 的现状病灶 + P0-P4 分类 + 10 秒检索入口 + 可分批执行的迁移清单
```

方法：只采集路径 / 字节 / 行数(`wc -l`) / mtime / 命名模式，**未读取任何现有文档内容**。
基线：`3f72a2ca` @ `0.54-docs-audit`。范围：代码仓 `Vessel/docs/**`、个人仓 `docs/**`。
**本次未移动 / 未改名 / 未删除任何现有文件**，全部动作以清单形式交 main 决定。

## 概览：三条结论

1. 个人仓 docs 有 174.1 MB，其中 **165.4 MB（95%）不是文档**（probe 证据 + 运行时 dump），目录最深 **15 层**。
2. 两个仓各有一个 `dev/handoff/`，**同名反义**；而检索工具 `scripts/docs-find.ts` **两个都不扫**。
3. 「必读」的 `HANDOFF-main.md` = **133,890 B / 1235 行**，是「状态+决策+计划+待办+历史」的合订本——每具身体每次接手先付 ~33k token。

## ① 现状清单

### 1.1 两个仓的量级差

| 仓 | 位置 | tracked | 实际文件 | 体积 | `.md` 数 | `.md` 体积 |
|---|---|---|---|---|---|---|
| 代码仓 | `Vessel/docs/` | 244 | 244 | 2.03 MB | 244 | 2.03 MB |
| 个人仓 | `docs/` | 2525 | **7786** | **174.1 MB** | 922 | 8.79 MB |

个人仓 7786 个文件里 6864 个（165.4 MB，95%）不是 md：`json` 2441、`pile` 1037、`log` 569、`jsonl` 475、`ts` 316、`pid` 304、`lock` 277、`bat` 177、`exit` 181。
深度直方图 `d10=1446, d11=709, d12=709, d13=614, d14=586, d15=58`；代码仓最深 4 层。
`<1 KB` 文件 4210 个（54%），零字节 63 个；`.md` 中 >50 KB 的 17 个。

### 1.2 个人仓 `docs/` 按目录

| 目录 | 文件 | md | 字节 | 最大三个 | 前缀族 | 备注 |
|---|---|---|---|---|---|---|
| `dev/tmp/` | 5041 | 29 | 149.1 MB | bun cache `.pile` 926 KB ×N | 无 | **gitignored，tracked=0**；`_quarantine-0.50/` 仍在 |
| `dev/reports/` | 1991 | 299 | 18.9 MB | evidence 树 | `REPORT`、`SUMMARY`×86、`HANDOFF` | tracked **1850**，其中 876 个非 md |
| `dev/plans/` | 318 | 318 | 4.6 MB | PLAN-0.19-s4 83.6 KB / PLAN-0.5.0-asm 80.6 KB / PLAN-0.6-web-console-v2 79.7 KB | `PLAN` 242 | `archive/` 304 个，67 个子目录 |
| `dev/evals/` | 277 | 121 | 0.75 MB | — | `EVAL` | `results/` 下 60+ 时间戳目录 |
| `dev/decisions/` | 56 | 56 | 0.38 MB | — | `DECISION-NNN` 55 | 不可变决策记录 |
| `dev/handoff/` | 10 | 7 | 0.22 MB | **HANDOFF-main 133.9 KB / 1235 行** | `HANDOFF`、`DECISIONS`、`plan` | P1 主场，见 1.4 S1/S2 |
| `dev/versions/` | 20 | 20 | 52 KB | — | `VERSION-x.y.z` 18 | 与代码仓 `versions/` 重叠 |
| `dev/notes/`6 + `dev/issues/`3 + `dev/roadmap/`1 + `dev/*.md`3 | 13 | 13 | 0.13 MB | — | 混合 | `BUGS`/`DEPRECATIONS`/`README` 挤在 `dev/` 根 |
| `lessons/` | 42 | 42 | 117 KB | L-011 6.5 KB | `L-NNN-` 41 | 有 README 入口 |
| `constitution/` + `CONSTITUTION.md` | 13 | 13 | 26 KB | 10-no-unnecessary-entities 4.1 KB | 数字前缀 | 有 INDEX |
| `roles/` | 4 | 4 | 23 KB | TEAM-PLAYBOOK 10.8 KB | 大写族名 | — |
| `design/` | **0** | 0 | 0 | — | — | **空目录**（2026-10-22 后未用） |

### 1.3 代码仓 `docs/` 按目录

| 目录 | 文件 | 字节 | 最大三个 | 入口文件 |
|---|---|---|---|---|
| `adr/` | 106 | 644.8 KB | ADR-104 89 KB / ADR-105 42 KB / ADR-091 33 KB | `adr/README.md` 143 行 |
| `architecture/` | 32 | 335.6 KB | gateway-rpc 28.9 / events 28.1 / member-team 23.9 KB | `architecture/INDEX.md` 55 行 |
| `versions/` | 60 | 284.7 KB | 0.19.0 13 KB | `versions/INDEX.md` 28 行 |
| `dev/handoff/` | 14 | 310.2 KB | projection-card-spec 51.6 / refresh-gap-design 51 / replay-gap-findings 29.4 KB | **无** |
| `operations/` | 6 | 125.4 KB | CONFIG 60.1 KB | **无** |
| `dev/research/` | 7 | 198.5 KB | web-search-fetch 73 KB | **无** |
| `dev/reports/0.54/` | 4 | 70.7 KB | proj-readback-15 26 KB | **无** |
| `agents/` | 8 | 61.1 KB | serve 15.5 / agent 15.2 KB | `agents/INDEX.md` 28 行 |
| 根 | 7 | 101.3 KB | WEB-UI 38.3 / FILE-MANAGEMENT 24.8 / PRODUCT 16 KB | `ARCHITECTURE.md` 仅 18 行（指针） |

### 1.4 命名前缀分布（两仓，已剔除 tmp/evidence/evals）

| 前缀族 | 个人仓 | 代码仓 | 一致? |
|---|---|---|---|
| `PLAN-` | 242 | 2 | 个人仓另有 1 个小写 `plan-` |
| `REPORT-` | 137 | 0 | — |
| `DECISION-` | 55 | 0 | 另有两个 `DECISIONS-<x.y>.md`（只差一个 S） |
| `ADR-` | 0 | 105 | — |
| `L-`（lessons） | 41 | 0 | — |
| `CONTRACT-` | 39 | 0 | — |
| `DESIGN-` | 27 | 0 | 代码仓根另有 `DESIGN.md` 同名 |
| `HANDOFF` | 24 | 0 | 一个词四种含义（见 S3） |
| `VERSION-` | 18 | 0 | 代码仓用裸 semver `0.19.0.md` |
| `INDEX` / `README` | 6 / 6 | 3 / 1 | 目录入口两种约定并存 |
| 无前缀 | 126 | 68 | 最大一块在 `dev/reports/*` |

### 1.5 三个最严重的结构问题

**S1 —— 两份 `dev/handoff/`：同名反义，且检索工具一个都扫不到。**
- 代码仓 `docs/dev/handoff/`（14 个 / 310 KB）：内容是 `*-spec`、`*-design`、`*-findings`、`*-brief`、`plan-*`、`task-*`——**没有一个是真的交接**。
- 个人仓 `docs/dev/handoff/`（10 个 / 218 KB）：`HANDOFF-main.md`（1235 行）+ `DECISIONS-0.53/0.54` + `PRINCIPLES` + 2 个 `.patch` 备份 + 1 个 `.txt`。
- `scripts/docs-find.ts --help` 自述扫描范围只有 `docs/{architecture,agents,operations,adr,versions}` + 根文档，个人侧只有 `docs/{constitution,lessons,roles}`。**实测** `--goal "handoff 交接 状态"` 首选返回 `../docs/roles/HANDOFF-SPEC.md`（讲手册该怎么写），真正的 `HANDOFF-main.md` 不出现。→ 最重要的一份文档在检索面之外。

**S2 —— `HANDOFF-main.md` 133,890 B / 1235 行，P1「必读」本身超载。**
它是全仓第二大活文档（37 KB 的 `WEB-UI.md`）的 3.6 倍，且职责与 `DECISIONS-0.54.md`(116 行)、`plan-remaining-053.md`(94 行) 重叠。旁证：`dev/reports/0.50/doc-audit/drafts/HANDOFF-main.draft.md`（6,273 B）在**两处各存一份**，是 0.50 没做完的压缩尝试。

**S3 —— 命名一物多名，十族互踩。**
- `PLAN` 242 vs 小写 `plan-` 1（`dev/handoff/plan-remaining-053.md`）。
- `DECISION-NNN-*`（不可变记录）vs `DECISIONS-<x.y>.md`（滚动日志）——差一个字母，含义相反。
- `HANDOFF` 四义：活交接 1 / 历史交接 22（`reports/*/handoffs/`）/ 手册规范 1（`roles/HANDOFF-SPEC.md`）/ 未闭环草稿 2。
- 版本说明两处两写法：代码仓 `versions/0.19.0.md`（59）vs 个人仓 `dev/versions/VERSION-0.19.0.md`（18），**0.18–0.50 区间两边都有**。
- 版本目录 `X.Y` vs `X.Y.Z` 混用：`plans/archive/` 40 个三段 + 22 个二段；`reports/` 同时有 `0.26.2`、`0.27`、`0.33.0`、`0.34`。跨目录对齐要两套拼法。
- 两仓有 3 组同名文件（`DESIGN.md` / `INDEX.md` / `README.md`），粘贴路径无法区分。

（附带发现：代码仓根有 3 个零字节垃圾文件 `1`、`一句话：「此刻的事实」由三份来源拼出来`、`名字@primary`，疑似 shell 重定向误建。）

## ② 分类方案

判定只用两问，先 1 后 2：

1. **读者是谁？** 外部贡献者/未来的我 → **代码仓**（有远端、随代码走）；只服务当下这具身体或事后取证 → **个人仓**（无远端）。
2. **还活不活？** 现在生效 → P0/P1；本版在飞 → P2/P3；只有史料价值 → P4。

| 类 | 判定 | 家（唯一） | 命名规范 | 可变性 |
|---|---|---|---|---|
| **P0 规则与准则** | 「永远要遵守」 | 代码仓 `docs/rules/`（constitution 迁入）+ `docs/adr/` + 个人仓 `docs/dev/decisions/` | `NN-<kebab>.md` / `ADR-NNN-<kebab>.md` / `DECISION-NNN-<kebab>.md` | ADR、DECISION **不可变**；改了写新条 |
| **P1 交接与状态** | 「此刻的事实」 | 个人仓 `docs/state/` | `HANDOFF-main.md` / `DECISIONS-<x.y>.md` / `CURRENT.md` | 每版重写，**≤200 行** |
| **P2 计划与任务** | 「在飞的活」 | 代码仓 `docs/dev/plans/` + 个人仓 `docs/dev/plans/` | `PLAN-<x.y>-<slice>.md` / `TASK-<x.y>-<slug>.md` | 版本关版时整体 `git mv` 进 `archive/<x.y.z>/` |
| **P3 规格与设计** | 「某功能的定稿」 | 代码仓 `docs/specs/`（由 `dev/handoff/` **改名**）+ `docs/architecture/` | `*-spec.md` / `*-design.md` / `*-brief.md` / `CONTRACT-*` / `INTERFACES-*` | 冻结；退场即转 P4 |
| **P4 报告与归档** | 「只查不读」 | 个人仓 `docs/dev/reports/<x.y.z>/`，**只放 `.md`** | `REPORT-<x.y>-<topic>.md` / `*-findings.md` / `AUDIT-<x.y>-<topic>.md` | 只追加 |

三条设计理由：
- **P0 必须进代码仓**：个人仓无远端，规则只留在那里等于外部贡献者/新机器永远看不到；constitution 只有 12 个文件 25.7 KB，搬迁成本极低。
- **P3 用改名而不是新建**：直接给现有 `Vessel/docs/dev/handoff/` 改名成 `specs/`，14 个文件**零移动**、只改目录名——全案性价比最高的一步。
- **P2 两个仓都留**：仓的选择跟读者走（团队并行的进代码仓，单身体推进的进个人仓），但**命名与归档规则完全一致**，跨仓只看名字就知道是什么。

目标布局：

```
代码仓 Vessel/docs/                    个人仓 docs/
  INDEX.md          ← 新增（总入口）     state/              ← P1 新家（3+1 文件）
  rules/            ← P0（constitution     ├ HANDOFF-main.md      ≤200 行
    INDEX.md           12 个迁入）         ├ DECISIONS-0.54.md
    01-doc-placement.md                    └ archive/DECISIONS-0.5x.md
    …                                   lessons/            ← P0.5 不动（42）
  adr/              ← P0 不动（106）     roles/              ← P0.5 不动（4）
  architecture/     ← P3 不动（32）      dev/decisions/      ← P0 历史（55）
  specs/            ← P3（原 dev/handoff） dev/plans/          ← P2（14 + archive）
  dev/plans/        ← P2（从 specs 拆出 plan-/task-）  dev/reports/<x.y.z>/ ← P4 只放 md
  operations/ agents/ versions/          dev/BACKLOG.md      ← BUGS+DEPRECATIONS+issues 合并
  dev/research/     ← P4 不动             dev/NOTES/         ← notes 4 篇（带日期）
```

迁移成本：

| 批次 | 内容 | 人时 | 单位 |
|---|---|---|---|
| B0 | `docs/INDEX.md` + 4 处缺失 INDEX + 元信息块 | 0.5 h | 1 |
| B1 | 清 `dev/tmp/`（149 MB，tracked=0） | 0.2 h | 0.5 |
| B2 | `dev/reports/` 非 md 出库（876 个 tracked） | 3 h（含审清单） | 1.5 |
| B3 | 代码仓 `dev/handoff` → `dev/specs` + 3 个 plan/task 移 `dev/plans` | 1 h | 1 |
| B4 | `HANDOFF-main.md` 拆分（唯一需要写内容的批次） | 4–6 h | 2（main 主持） |
| B5 | 命名归一 + 版本目录补 `.0` + 两仓 versions 合并 | 2 h | 1 |
| 合计 | | **~11 h** | **~7 单位** |

## ③ 检索方案（目标：10 秒内回答「我该读哪个」）

### 3.1 每类一个入口文件

| 类 | 入口 | 形态 |
|---|---|---|
| 全部 | `Vessel/docs/INDEX.md`（新增） | 5 行表：类 → 入口 → 一句话 |
| P0 | `docs/rules/INDEX.md`（由 `constitution/INDEX.md` 迁入）+ `docs/adr/README.md`（已有） | 编号目录 |
| P1 | `docs/state/HANDOFF-main.md` 的**前 30 行** | 现状 + 下一步；其余折叠到下方 |
| P2 | `docs/dev/plans/INDEX.md`（已有，138 行） | 一版一行等宽表 |
| P3 | `docs/specs/INDEX.md`（新增，14 行够） | 文件名 + owner + 生效版本 |
| P4 | `docs/dev/reports/INDEX.md`（新增，替代 57 个子目录盲搜） | 版本 → 主题 → 一句话结论 |

### 3.2 文件头必填元信息（标题下第 3 行，一行 4 字段）

```
> owner: main ｜ 生效版本: 0.54 ｜ 优先级: P1 ｜ 用途: 当前身体的状态与下一步
```

好处是索引可机械重建：`find docs -name "*.md" -exec sed -n 3p {} +` 一条命令出全量目录，不用人维护。
**注意**：`docs-find.ts --help` 明确写了它「用标题/文件名做无 frontmatter 兜底」，所以这行只能当人类可读 + 索引生成源；要让检索按优先级排序，得让 docs-find 读第 3 行（约 5 行代码）。

### 3.3 前缀 ↔ 目录 一一对应（硬约定，写进 `rules/01-doc-placement.md`）

| 前缀/形态 | 必须在这个目录 | 禁止出现 |
|---|---|---|
| `ADR-NNN-` | `docs/adr/` | 其它任何目录 |
| `DECISION-NNN-` | 个人仓 `docs/dev/decisions/` | 其它任何目录 |
| `HANDOFF-main.md` / `DECISIONS-<x.y>.md` / `CURRENT.md` | 个人仓 `docs/state/` | `dev/` 下任何子目录 |
| `PLAN-` / `TASK-` | 两仓的 `dev/plans/`（含 `archive/<x.y.z>/`） | `state/`、`specs/`、`reports/` |
| `*-spec.md` / `*-design.md` / `*-brief.md` / `CONTRACT-` / `INTERFACES-` | `docs/specs/` | `reports/` |
| `REPORT-` / `*-findings.md` / `AUDIT-` | 个人仓 `docs/dev/reports/<x.y.z>/` | 活目录 |
| `L-NNN-` | 个人仓 `docs/lessons/` | 其它任何目录 |
| `NN-<kebab>.md` | `docs/rules/` | 其它任何目录 |

版本目录统一 **`<x.y.z>` 三段**（`0.27` → `0.27.0`）。

### 3.4 「我现在该读什么」决策树

```
你要干什么？
├─ 新身体第一次接手
│   → docs/state/HANDOFF-main.md（前 30 行）
│   → Vessel/docs/rules/INDEX.md（12 条约束）
│   → docs/state/DECISIONS-<当前版本>.md
│   → 动手前：Vessel/AGENTS.md
├─ 要改某个模块
│   → Vessel/docs/architecture/INDEX.md 定位模块页
│   → Vessel/docs/specs/INDEX.md 找该模块的定稿
│   → Vessel/docs/adr/README.md 查是否被某条 ADR 锁死
├─ 要找某个决策为什么这么定
│   → docs/state/DECISIONS-<x.y>.md（本期）
│   → docs/dev/decisions/INDEX.md（长期 DECISION-NNN）
│   → Vessel/docs/adr/README.md（架构级）
│   → 三处都没有 = 没记录，当场补一张
├─ 查历史事故 / 为什么不能这么写
│   → docs/lessons/README.md（42 条，按症状）
│   → docs/dev/reports/<x.y.z>/*-findings.md
└─ 接手某一版在飞的活
    → docs/dev/plans/INDEX.md 或 Vessel/docs/dev/plans/INDEX.md
    → 对应 PLAN-<x.y>-*.md
```

## ④ 迁移建议清单（分批，每批可独立停下）

| # | 动作 | 对象 | 为什么 | 风险 | 改引用？ |
|---|---|---|---|---|---|
| B0 | 新增 | `Vessel/docs/INDEX.md` | 代码仓 docs 根只有指针（`ARCHITECTURE.md` 18 行），没有总入口 | 无 | 否 |
| B0 | 新增 | `docs/rules/INDEX.md`、`docs/specs/INDEX.md`、`docs/dev/reports/INDEX.md` | 这三个是唯一完全没有入口的高频目录（`specs` 即现 `dev/handoff`，14 个文件无 INDEX） | 无 | 否 |
| B0 | 闭环前次审计 | `docs/dev/reports/0.50/doc-audit/`（57 个文件：`inventory.tsv` 107 KB、`delete-manifest.tsv` 41 KB、`archive-move-manifest.tsv` 31 KB、`PLAN-0.50-doc-cleanup.md` 13.9 KB） | 上一轮审计已出清单但目录还在、drafts 还在，等于两套方案并存 | 无 | 否 |
| B1 | 删 | 个人仓 `dev/tmp/**`（5041 个 / 149 MB，**tracked=0**，`.gitignore` 第 49 行 `/docs/dev/tmp/`） | 95% 体积、0 历史风险、0 文档价值 | 无（不可回滚）。**删前确认** `_quarantine-0.50/{roles,design-delivery}/` 下 2 个 md 是否仍有效 | 否 |
| B2 | 出库/删 | `dev/reports/**` 里 876 个 tracked 非 md（json/log/tsv/ndjson） | 证据树把 `reports` 从「8 个版本页」变成 1991 个文件 | 中：证据是判断依据，删了下次争议无据 | 否 |
| B2 | 删 | `reports/**` 下 86 个 `SUMMARY.md`、63 个零字节文件 | 纯噪音 | 低 | 否 |
| B3 | **改名** | `Vessel/docs/dev/handoff/` → `Vessel/docs/specs/` | 目录名与内容不符（S1）；个人仓有同名目录 | 低 | **是**：`AGENTS.md`、`README.md` 有 `docs/dev/handoff` 字面量 |
| B3 | 移 | `specs/plan-054-timeline-migration.md`、`specs/plan-projection-no-materialize.md`、`specs/task-*.md` → `Vessel/docs/dev/plans/` | 按 ② 属 P2 | 低 | 否 |
| B3 | 归档 | `specs/replay-gap-findings.md`、`timeline-writer-report.md`、`handoff-to-claude.md` → `Vessel/docs/dev/reports/0.54/` | 结论型文档不该留在 P3 目录 | 低 | 否 |
| B4 | **拆分** | `docs/dev/handoff/HANDOFF-main.md` 1235 行 → `state/HANDOFF-main.md` ≤200 行；迁出 3 块：滚动决策→`DECISIONS-0.54.md`、计划→`dev/plans/`、历史→`reports/0.54/` | S2 根因；每具身体每次接手付 ~33k token | **高**：唯一 live 读路径，拆错即断档。**必须 main 主持**，拆完逐条核对「原来能查到的现在在哪个文件」 | 否（代码仓 grep `HANDOFF-main` 0 命中） |
| B4 | 删 | `HANDOFF-main.draft.md`（2 份）、`BUGS.draft.md`、`DEPRECATIONS.draft.md`、`ROADMAP.draft.md`、`CLAUDE.compressed.draft.md` | 与 live 文件并存；`BUGS.draft.md` 与 `dev/BUGS.md` 字节数完全相同（3307），谁是对的读不出来 | 低 | 否 |
| B5 | 改名 | `dev/handoff/plan-remaining-053.md` → `dev/plans/PLAN-0.53-remaining.md`；`C1h-research-brief.md` → `dev/reports/0.53/REPORT-0.53-c1h-research.md` | 大小写 + 类目归位（S3） | 低 | 否 |
| B5 | 改名 | `plans/archive/` 22 个 `X.Y` → `X.Y.0`；`reports/` 同步 | 版本目录两套拼法，跨目录对不齐 | 中：INDEX 里是字面路径，漏改即 404 | **是**：`dev/plans/INDEX.md`(138 行)、`dev/versions/INDEX.md`、`Vessel/docs/versions/INDEX.md` |
| B5 | 合并 | 个人仓 `dev/versions/VERSION-x.y.z.md`(18) → 代码仓 `docs/versions/x.y.z.md` | 同一版本说明两处两写法，0.18–0.50 重叠 | 中：哪边是定稿需读内容判断 | 是：`dev/versions/INDEX.md` |
| B5 | **改工具** | `Vessel/scripts/docs-find.ts` 扫描列表加 `docs/rules`、`docs/specs` 与个人侧 `docs/state` | 任何目录搬迁不配套改这里，检索会**静默**丢文件（已实测 `HANDOFF-main.md` 搜不到） | 低（5 行常量） | 是（唯一需要改的代码） |
| B6 | 删空目录 | 个人仓 `docs/design/`（0 文件） | 让 `ls` 多一层无效选择 | 无 | 否 |

**执行顺序**：B0 → B1 → B3 → B5(改工具) → B5(改名/合并) → B2 → B4 → B6。
理由：先把入口和工具修好再动目录，否则中间态谁都搜不到；B4 拆分放最后，因为要等状态类文档归位后才能判断哪块该留。

**需要 main 拍板的两个点**（要读内容才能定，我按规则没读）：
1. `dev/reports/` 的 876 个 tracked 证据：删、还是出库到仓库外（影响「下次争议有没有据可查」）。
2. `VERSION-*.md` 与 `versions/*.md` 的 18 个重叠版本，哪边是定稿。

## ⑤ 限制

- 未读任何现有文档内容 → 所有「谁是对的不明确」只能靠字节数 / mtime / 命名间接推断，故 B2、B4、B5(合并) 都标了「需 main 确认」。
- 未校验现有文档间的链接有效性（需读内容），改名断链目前只覆盖了 `AGENTS.md` / `README.md` / 各 `INDEX.md` 的字面路径。
- 未评估 `dev/reports/0.50/doc-audit/` 里那份 0.50 审计的**结论**，只比了文件名与尺寸；B0 应把它当输入而不是重来。
