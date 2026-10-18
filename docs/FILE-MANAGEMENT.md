# 文件管理守则

> 本文件规定 Vessel 工作区内「什么内容放哪里、谁能改、怎样进入共享侧」。
> `AGENTS.md` 只引用本文件，不重复细节。任何新文件落盘前，先按本守则选位置。

## 0. 一句话原则

**共享侧只放「对项目使用者、贡献者、AI 有长期价值的成品」；个人侧放「过程产物」。**
过程产物包括 handoff、计划、报告、决策草稿、临时脚本、worktree、日志、会话库。
只有经过审查的过程产物，才能被提炼成文档或代码进入共享侧。

## 1. 两侧边界

| | 个人侧（personal） | 共享侧（shared） |
|---|---|---|
| 物理路径 | 工作区根（本仓库的上一级，非 git） | 本仓库根（`Vessel/`） |
| 是否 git 仓库 | 否 | 是 |
| 放什么 | handoff / plan / report / decision / worktree / 临时文件 / 私有笔记 | 源码 / 测试 / 公开文档 / CI / 发布配置 |
| 谁能写 | 1 与各 N 均可 | 各 N 只能写自己独占路径，经 1 合并 |
| 审查 | 不需要 | 必须：三件套 + 路径归属 + 内容审查 |

> 判断口诀：**「删掉它会不会影响别人使用或理解项目？」**
> 会 → 共享侧；不会 → 个人侧。

## 2. 个人侧目录结构

```text
<workspace>\                               # 个人侧根（本仓库的上一级，非 git）
├── CLAUDE.md                              # 个人侧工作区说明（Claude 会话入口）
├── docs\
│   ├── roles\
│   │   └── HANDOFF-SPEC.md                # N 领域 handoff 手册规范
│   ├── handoff\
│   │   ├── HANDOFF-main.md                # 1（总协调）的接续状态
│   │   ├── HANDOFF-core.md                # D1 内核
│   │   ├── HANDOFF-ext.md                 # D2 能力生态
│   │   ├── HANDOFF-asm.md                 # D3 装配与配置
│   │   ├── HANDOFF-tui.md                 # D4 终端产品
│   │   ├── HANDOFF-web.md                 # D5 远程控制面
│   │   └── HANDOFF-gov.md                 # D6 工程治理
│   ├── plans\
│   │   └── PLAN-<version>-<role>.md       # 待审批/执行中的方案
│   ├── reports\
│   │   └── REPORT-<version>-<role>-<slug>.md   # N 的完整回报（消息里只放摘要）
│   └── decisions\
│       └── DECISION-<seq>-<slug>.md       # 1 的裁决与跨部门协商记录
├── worktrees\
│   ├── 0.3.0-core\                        # git worktree，对应分支 0.3.0-core
│   ├── 0.3.0-ext\
│   ├── 0.3.0-asm\
│   ├── 0.3.0-tui\
│   ├── 0.3.0-web\
│   └── 0.3.0-gov\
└── Vessel\                                # 共享侧（git 仓库）
```

约定：

- **一个角色一个 worktree**，worktree 路径固定为 `worktrees/<version>-<role>`，分支同名。
- **个人产物永不提交到共享侧**。共享侧 `.gitignore` 已忽略 `.claude/`、`.vessel/`、`.codegraph/`、`.env`、`node_modules/`、`dist/`。
- 临时脚本放个人侧 `docs/tmp/`（需要时自建），不要放共享侧 `scripts/`。
- 长期个人笔记可放个人侧 `docs/notes/`，同样不进共享侧。

## 3. 共享侧目录结构

```text
Vessel\                                    # 共享侧（git）
├── README.md                              # 项目入口：是什么 / 怎么跑 / 边界
├── AGENTS.md                              # AI 行为约定（引用本守则）
├── CLAUDE.md                              # 仅一行：@AGENTS.md
├── CONTRIBUTING.md                        # 贡献流程
├── SECURITY.md / CODE_OF_CONDUCT.md       # 社区规范
├── CHANGELOG.md                           # 版本变更
├── LICENSE
├── docs\
│   ├── ARCHITECTURE.md                    # 架构：怎么做的
│   ├── ADR.md                             # 决策记录：为什么这么做（只追加）
│   ├── FILE-MANAGEMENT.md                 # 本文件：文件放哪里
│   └── operations\                        # 运维/发布类文档（按需新增）
│       ├── RELEASE.md                     # 发布流程
│       └── CI-CD.md                       # CI / 用户侧 CD / 自动更新
├── packages\
│   ├── core\                              # D1
│   ├── config\                            # D3
│   ├── permission\                        # D3
│   ├── tui\                               # D4
│   └── serve\                             # D5
├── plugins\
│   ├── tools\                             # D2
│   ├── security\                          # D2
│   ├── observability\                     # D2
│   ├── provider\                          # D2
│   ├── mcp\                               # D2：MCP client（0.3）
│   ├── workflow\                          # D2：workflow 引擎（0.4）
│   ├── evals\                             # D2：eval harness（0.4）
│   └── im\                                # D2：IM 渠道（0.4：飞书）
├── src\                                   # D3：装配层 / CLI / headless
├── apps\web\                              # D5：浏览器控制台
├── examples\                              # D3：可运行示例
├── scripts\                               # D3/D6：项目级自动化
├── skills\                                # 项目级技能（纯 markdown）
└── .github\                               # D6：CI / release / labels / PR 模板
```

### 3.1 根目录

只允许以下文件：`README.md`、`AGENTS.md`、`CLAUDE.md`、`CONTRIBUTING.md`、`SECURITY.md`、`CODE_OF_CONDUCT.md`、`CHANGELOG.md`、`LICENSE`、`.gitignore`、`.env.example`、构建/工具配置（`package.json`、`bun.lock`、`tsconfig.json`、`biome.json`）。

**禁止**：`HANDOFF-*.md`、`PLAN-*.md`、`REPORT-*.md`、`TODO.md`、`NOTES.md`、草稿文件、个人目录。

### 3.2 `docs/`

只放**长期有效**的知识，按「问题类型」分类，不按日期、不按人名：

| 目录/文件 | 回答的问题 | 维护者 |
|---|---|---|
| `ARCHITECTURE.md` | 系统怎么工作 | core 主笔，各 N 补充 |
| `ADR.md` | 为什么做这个选择（只追加） | 1 审批后写入 |
| `FILE-MANAGEMENT.md` | 文件放哪里 | gov |
| `operations/RELEASE.md` | 怎么发版 | gov |
| `operations/CI-CD.md` | CI / CD / 自动更新怎么跑 | gov |

**禁止**：handoff、计划、报告、验收过程表、日期命名的文档、截图、数据库、日志。

### 3.3 代码与测试

- 代码按事业部独占（见 §5）。
- 测试与代码同包：`src/**/__tests__/**` 或包级 `__tests__/`；fixture 放 `__tests__/fixtures/`。
- 新增包必须进入根 `package.json` 的 workspaces（`packages/*`、`plugins/*/*`）。
- 新增插件放 `plugins/<category>/<name>/`，目录即注册；进程启动时扫描一次。

### 3.4 `scripts/`

只放**可复用**的项目自动化（构建、校验、发布）。一次性迁移/清洗脚本放个人侧，用完即弃。

### 3.5 `.github/`

CI、release、labels、PR 模板、CODEOWNERS。任何改动都会影响所有人，必须由 gov 提交并经 1 审查。

## 4. 命名规范

### 4.1 角色名（短英文，固定）

| 代号 | 事业部 | 独占路径 |
|---|---|---|
| `main` | 总协调（1），不是事业部 | 无独占代码路径；管 handoff / 合并 / 裁决 |
| `core` | D1 内核 | `packages/core/**` |
| `ext` | D2 能力生态 | `plugins/**` |
| `asm` | D3 装配与配置 | `src/**`、`packages/config/**`、`packages/permission/**`、`scripts/build.ts`、`examples/**`、根 `package.json` |
| `tui` | D4 终端产品 | `packages/tui/**` |
| `web` | D5 远程控制面 | `packages/serve/**`、`apps/web/**` |
| `gov` | D6 工程治理 | `docs/**`、根 `*.md`、`.github/**`、`tsconfig.json`、`biome.json`、`skills/**`、`scripts/**`（`build.ts` 除外）、`.gitignore`、`.env.example` |
| `qa` | 质量与交叉验证（staff，不是事业部） | 无独占写路径；只读审查、跑测试、写个人侧报告 |

### 4.2 版本、分支、worktree

采用业界常用的 **trunk-based + release branch** 混合模型：`main` 常绿，`release/x.y` 维护一条版本线，角色分支只活一个版本周期。**发布由 tag 触发，不由分支名触发。**

| 分支 | 用途 | 谁写 | 生命周期 |
|---|---|---|---|
| `main` | 稳定主干，始终可发布 | 只有 1 合并 `release/*` / `hotfix/*` | 永久 |
| `release/0.1` | 0.1.x 版本集成分支（开发基线） | 1 | 该 minor 线存续 |
| `0.4.0-<role>` | 角色长期分支，对应一个 worktree | 该角色 N | 一个版本周期 |
| `feat/<role>-<slug>` | 单个任务分支（可选，风险大时用） | 该角色 N | 合并后删除 |
| `hotfix/<slug>` | 线上紧急修复，从 `main` 拉出 | 1 指派 | 合并后删除 |

- **版本周期**：目标版本 `0.4.0` → 集成分支 `release/0.4` → 角色分支 `0.4.0-<role>` → worktree `worktrees/0.4.0-<role>`。
- **下一周期**：从 `main` 新建 `release/0.5`，角色分支改为 `0.5.0-<role>`；补丁周期用 `release/0.4` + `0.4.1-<role>`。
- **任务分支**：`<type>/<role>-<slug>`，`type` 取 `feat|fix|refactor|chore|docs|test|ci|perf|build`。
- **提交信息**：Conventional Commits，scope 用角色代号，如 `feat(core): ...`、`fix(tui): ...`。
- **tag**：只在发布时创建，`v<major>.<minor>.<patch>`；预发布 `v0.4.0-beta.1`。tag 与分支分离，不建 `v1.2.3` 分支。
- **基线**：`release/0.4` 分支即版本基线；tag 在该周期验收通过后由 1 决定是否打（0.4 只干跑，不打 tag）。

### 4.3 文件命名

- 共享侧顶层文档：`UPPER-KEBAB.md`（如 `ARCHITECTURE.md`）。
- 共享侧子目录文档：`UPPER-KEBAB.md` 或 `kebab-case.md`，同一目录内保持一致。
- 个人侧 handoff：`HANDOFF-<role>.md`。
- 个人侧计划：`PLAN-<version>-<role>.md`。
- 个人侧报告：`REPORT-<version>-<role>-<slug>.md`。
- 个人侧裁决：`DECISION-<seq>-<slug>.md`。
- 命名只用 ASCII，避免中文、空格、括号；中文写在文件内容里。

## 5. 角色与路径独占

| 角色 | 可写路径 | 只读但可提需求 |
|---|---|---|
| `core` | `packages/core/**` | 全部下游 |
| `ext` | `plugins/**` | `packages/core/**` 的公开接口 |
| `asm` | `src/**`、`packages/config/**`、`packages/permission/**`、`scripts/build.ts`、`examples/**`、根 `package.json` | 所有上游包的公开导出 |
| `tui` | `packages/tui/**` | `packages/core`、`packages/config` 的公开接口 |
| `web` | `packages/serve/**`、`apps/web/**` | `packages/core` 的公开接口 |
| `gov` | `docs/**`、根 `*.md`、`.github/**`、`tsconfig.json`、`biome.json`、`skills/**`、`scripts/**`（`scripts/build.ts` 除外）、`.gitignore`、`.env.example` | 全部（只读审查，不改业务代码） |
| `qa` | 无（只读） | 全部；输出到个人侧 reports / decisions |

规则：

- **跨路径改动只能提 PR 或消息协商，不能直接改。**
- `scripts/version.ts` 的写模式**只在发布收口由 1 执行**，机械改写各包 `package.json`；不属于日常跨路径改动，N 不运行写模式。
- `packages/core/src/types/**` 的接口主权归 `core`；任何接口变更必须同步 `docs/ARCHITECTURE.md` + `docs/ADR.md`，并通知全部 N。
- 依赖方向单向：`core` ← 其它。`core` 的 `dependencies` 永远为空。
- 并行开发必须 worktree 隔离，禁止共享工作目录。

## 6. 产物生命周期

```text
1 写 HANDOFF-<role>.md（角色、路径、当前任务、验收标准）
        ↓
N 读 handoff → 写 PLAN-<version>-<role>.md（方案 / 影响面 / 风险）
        ↓
用户或 1 审批方案
        ↓
N 在 worktree 实现 → 自测三件套 → 写 REPORT-<version>-<role>-<slug>.md
        ↓
N 在自己的分支提交（只含共享侧成品）
        ↓
1 审查 → 决定合并到哪个版本 → 冲突与相关 N 协商 → 合并
        ↓
1 更新 HANDOFF-main.md 与对应 HANDOFF-<role>.md
```

### 进入共享侧的审查清单

- [ ] 对使用者/贡献者/AI 有长期价值，不是过程产物。
- [ ] 放在正确分类与正确路径。
- [ ] 不含个人路径、会话 ID、密钥、临时数据、日志。
- [ ] `bun test` / `bun run typecheck` / `bunx @biomejs/biome ci .` 全绿（代码改动）。
- [ ] 文档与代码一致；未实现的能力明确标注。
- [ ] 没有半成品 stub、没有指向已删除目录的链接。

## 7. Git 与发布规则

### 7.1 分支保护

- `main`：禁止直接 push；只接受 `release/*` 与 `hotfix/*` 合并；CI 必须绿；squash merge。
- `release/*`：只有 1 能合并；N 不直接写。
- `0.x.y-<role>`：只有该角色 N 写；其他 N 只读。
- tag `v*`：只有 1 或 CI 创建；已发布 tag 禁止删除或移动。

### 7.2 合并流程

1. N 在 `0.4.0-<role>` 完成一个任务，跑三件套，提交。
2. N 在 `REPORT-*` / `HANDOFF-*` 写清：改了什么、影响哪些路径、需要谁复核。
3. 1 审查 diff，决定目标版本（通常 `release/0.1`）。
4. 冲突：1 召集相关 N，双方给出理由，1 裁决；裁决写入个人侧 `docs/decisions/`。
5. 1 合并到 `release/0.1`。
6. 版本收口：1 把 `release/0.4` 合并到 `main` 并打 tag，触发 release workflow。**0.4 只干跑：不合并 `main`、不打 tag、不 publish。**

### 7.3 发布

- **触发**：push tag `v*`（稳定版）或 `v*-beta.*`（预发布）。不用分支名触发发布——分支管开发，tag 管发布。
- **发布前检查**：tag 在 `main` 上；tag 与所有 package 版本一致；CI 全绿；`CHANGELOG.md` 已更新。
- **npm**：稳定 tag → `latest`；预发布 → `beta` / `next`；带 `--provenance --access public`。
- **GitHub Release**：自动生成 notes，附 `latest.json` 更新清单；0.4.0 无二进制与 sha256（且 0.4 不触发发布）。
- **回滚**：不删 tag、不 force-push；发新 patch，或用 revert commit 回退 `main`。
- **共享侧工作树**：除当前任务改动外，`git status` 必须干净，无未跟踪垃圾。

## 8. 迁移记录（已完成）

| 项 | 结果 |
|---|---|
| `HANDOFF-MAIN.md` | 已移到个人侧 `docs/handoff/HANDOFF-main.md`，从 git 移除 |
| `.claude/plans/streaming-core.md` | 已从 git 移除（`.claude/` 本身被忽略） |
| `.codegraph/` | 已移入 `Vessel/.codegraph/`，保持被忽略 |
| `.vessel/sessions.db` | 保持忽略，只属个人运行数据 |
| `.env.example` | 保留（模板，不含密钥） |
| 版本基线 | `release/0.1` 已建立（基线 `81970bf`）；`v0.1.0` tag 留到发布时 |
| 角色分支 | 6 条 `0.1.0-<role>` 分支与 worktree 已建立 |
| 个人产物 | `git ls-files` 未发现 handoff / plan / report / `.claude` / `.vessel` 残留 |

## 9. CI / CD 与发布

### 9.1 CI（`.github/workflows/ci.yml`）

触发：`pull_request` / `push` 到 `main`、`release/**`，以及 `workflow_dispatch`。

| Job | 内容 |
|---|---|
| `quality`（ubuntu） | 复用 `.github/actions/quality`：`bun install --frozen-lockfile` → `bun run lint` → `bun run typecheck` → `bun test` → `bun run build` |
| `architecture`（ubuntu） | `scripts/check-deps.ts` → `scripts/smoke-subpaths.ts` → `scripts/check-docs.ts` → `scripts/version.ts --check` |
| `offline-integration`（ubuntu） | MCP / gateway + 0.4 能力：`bun test plugins/mcp/client` → `bun test packages/serve` → `bun test plugins/workflow/engine` → `bun test plugins/evals/harness` → `bun test plugins/im/feishu` → `bun test packages/core`；全部使用 mock，不依赖外网 |
| `release-dry-run`（ubuntu） | 仅 PR + `release/**` push：`bun run scripts/release-dry-run.ts`；打包到 OS 临时目录，不上传、不 publish、不 tag |
| `cross-platform`（matrix：ubuntu / windows / macos） | `bun run typecheck` + `bun test`；PR 只跑 ubuntu，`main` / `release/**` 跑全矩阵 |
| `web` | `apps/web`：`npm ci` → `npm run build` |
| `examples` | `bunx tsc -p examples/tsconfig.json --noEmit` → `bun run demo`（`examples/tsconfig.json` 随仓库提供） |
| `smoke` | 仅 `main` / `release/**` push：headless 文本、stdin、`@file`、`/help`、`/exit`（mock） |

- 同一 ref 的旧 run 自动取消；缓存 Bun / npm。
- 三件套任何一项红，禁止合并。

### 9.2 Release（`.github/workflows/release.yml`）

触发：push tag `v*`（含预发布）。**0.4 不触发本流程。**

1. 校验 tag 在 `main` 上，且所有可发布 workspace `package.json` 版本一致、`CHANGELOG.md` 含该版本。
2. 复跑 quality（发布前再验一次）。
3. `npm publish` 所有公开包：稳定版 `latest`，预发布 `beta`；`--provenance --access public`。**不发布根 CLI**。
4. 创建 GitHub Release：自动 notes + `latest.json`（0.4.0 的 `assets` 为空）。
5. **不构建二进制**（ADR-006 继续有效）；后续再评估。
6. 发布失败不自动重试；修版本后重新打 tag（旧 tag 保留，不覆盖）。

### 9.3 用户侧 CD / 自动更新

- `vessel update [--check] [--channel latest|beta]`：读取 GitHub Release 的 `latest.json` 对比当前版本，只提示版本与安装命令（check-only）。
- REPL 启动时后台检查（24h 节流、失败静默、可配置关闭），只提示、不打断。
- npm 安装：`vessel update` 提示升级命令，不自动替换。
- **不提供独立二进制，也不做二进制自更新**；后续再评估。
- 预发布通道：`--channel beta` 或 `VESSEL_CHANNEL=beta`。
- `latest.json` 由 release workflow 生成；0.4.0 只含 `version` / `channel` / `released_at` / `assets: {}`（0.4 不生成、不发布）。

### 9.4 版本与变更日志

- **Phase 1（当前）**：Conventional Commits + 1 定版本 + tag 驱动发布；`CHANGELOG.md` 由 release 汇总。
- **Phase 2（包可发布后）**：引入 Changesets 或 Release Please 管理多包版本与 changelog，减少手工。
- **0.x 语义**：breaking → minor，feature → minor，fix → patch；预发布加 `-beta.N`。

## 10. 违规判定

出现以下任一情况即视为违规，由 `gov` 记录、`1` 要求整改：

- 共享侧出现 handoff / plan / report / 临时脚本 / 个人目录。
- 代码改到别人独占路径而未协商。
- 提交里含密钥、会话库、日志、构建产物。
- 文档描述了不存在的能力，或链接指向已删除目录。
- 未经三件套就提交或合并。
