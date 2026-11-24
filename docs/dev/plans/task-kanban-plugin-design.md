# 任务看板插件（kanban）设计

> 状态：设计完成（q-kanban，design/q-kanban 分支；待 main 评审，实施另派单）
> 任务书：main 派单「任务看板插件设计（只读文件弹窗+路径设置）」。
> 性质：**纯设计文档，不改代码**。实施按 §12 分期，另派单执行。
> 宪法约束：零测试 / 零探针 / 零临时进程；构建期检查只有 `bun run build`；行为验证由用户手动完成。

## 0. 用户意图（硬约束，全文贯彻）

1. **看板文件只存当前内容，不存历史消息**；历史（已完成）任务归档到**其他文件**（archive），板只留当前。
2. 插件**只读**「配置的文件路径」指向的文件，以**弹窗 / 页面**展示；插件不写看板文件。
3. 提供**设置项**：可添加 / 配置插件的展示文件路径，**支持多路径**。

参考实例：`redblue-dev` 分支 `docs/dev/kanban/board.json`（main 维护），现有形状：

```jsonc
{
  "board": "vessel 红蓝开发任务看板",
  "updated": "2026-11-23T23:30:00+08:00",
  "columns": ["待办", "进行中", "已完成", "阻塞"],
  "note": "本文件由 main 维护，任务看板插件只读此文件弹窗展示。历史完成任务归档至 archive.json，本板只留当前内容。",
  "tasks": [
    { "id": "q-validation", "title": "…", "column": "已完成", "owner": "q-validation",
      "branch": "fix/q-validation", "progress": "已合入 redblue-dev (merge 8694a681)，build exit 0" }
    // …
  ]
}
```

本设计以该形状为基线做 **additive 优化**（§4）：现有 board.json **零改动即可被插件读取**。

## 1. 调研结论（现有机制盘点）

| 机制 | 现状 | 对本设计的意义 |
| --- | --- | --- |
| 插件形态 | 一套 loader / manifest；能力插件 in-process，体验插件 child+iframe（`docs/architecture/plugins.md`） | kanban 选 **in-process + embed UI**（§2） |
| in-process RPC | `Plugin.rpc(name, params)`，装配层 `registerInProcessPlugin` 接进 `PluginRpcRegistry`，canonical `plugin.<id>.<name>`，read/write 权限 + DTO 校验（`src/plugin-host-assembly.ts`、`packages/serve/src/plugin-host/registry.ts`） | kanban 的数据面走同一机制，不自造注册路径 |
| embed UI | `ui.embed` + `pages[].component`，builtin 自动 `embedded` 档，宿主 import 插件 ESM 同源渲染；SDK `createPluginHost`（`docs/architecture/plugin-embed.md`、`packages/plugin-sdk`） | 看板页用 embed 档；iframe entry 保留作 isolated 回退 |
| 宿主 SDK 面 | P2 最小面：rpc / events.subscribe / theme / toast / i18n / log / permissions.has；**dialog / router / mounts 在 P3 未落地** | 「弹窗」一期不做宿主级 dialog，用页面承载（§7.3） |
| settings 贡献点 | `contributes.settings`：JSON Schema 子集（type/description/default…），**宿主 v1 不自动渲染表单**；值存 `config.yaml plugins[].config`，激活时下发（child 经 settingsFor，in-process 经 install config） | kanban 声明 settings 域；渲染交给 q-settings（§10），过渡期页面内置设置节 |
| settings 写路径 | `config.set` 白名单**不含 plugins[]**；先例：model-registry 自持 write RPC，经 `withConfigLock` 读改写 config.yaml 自己的块 | kanban P1 同模式自持 `settings_set`；P2 提宿主通用 `plugins.settings.set`（§5.4） |
| 文件监听 | `src/plugin-watch.ts`（插件目录+config.yaml，300ms 去抖）、`src/config-watch.ts`；**无任意文件监听、无插件→UI 事件推送通道**（events 只有宿主→插件转发） | 刷新 P1 = 手动 + 可见期轮询（ifMtime 廉价比对）；推送列 P3 候选（§8） |
| 参考插件 | `plugins/provider/model-registry`（in-process + rpc + embed 双页 + fs 声明 + config.yaml 写）；`plugins/observability/usage`（embed 双产线样本） | kanban 目录 / 构建 / 装配全部照这两个先例 |
| 导航 | 内置组 chat/network/runs/integrations/status/observe/settings/top/plugins + 自定义 `plugin:<id>` 组；图标白名单 | 看板页挂 `status` 组，icon `runs`（§7.1） |
| 版本 | 仓库 0.56.0；plugin-sdk 1.0.0（独立版本线） | `engines.vessel: ">=0.56.0 <1.0.0"`，`runtime: { react: "^19", sdk: "^1" }` |

## 2. 形态决策

**决定：builtin in-process 只读插件 + embed 页面**，落位 `plugins/observability/kanban`，id `kanban`。

- in-process：需要直接读宿主文件系统上「配置的路径」；child 插件只有 data-dir 注入，读任意配置路径要另开缝，得不偿失。
- 只读：不注册 tool / provider / hook / guardrail，不影响 run 与模型输入；只贡献 pages / rpc(read) / settings / i18n。唯一 write RPC 是 `settings_set`（写的是 config.yaml 的 kanban 配置块，**不是看板文件**）。
- embed：builtin → 自动 embedded 档，无 TOFU 确认负担；isolated iframe 回退保留（契约要求 entry 必填）。
- 备选与否决理由：
  - child 体验插件：读配置路径需要新权限缝 + 子进程开销，否决。
  - 纯 apps/web 域（不做插件）：违背「插件 + 设置贡献点」的任务书，且无法被 q-settings 以插件域统一收纳，否决。
  - 能力插件注册 `kanban` 工具给 agent：与用户「弹窗/页面展示」意图无关，徒增每轮 token 税，否决。

## 3. 架构图

```
┌────────────────────────── 维护侧（人 / main agent，插件不参与） ─────────────────────────┐
│  main 维护 board.json（只存当前任务）                                                    │
│  完成任务 ──移出 board.tasks──▶ 追加 archive.json（历史，append-only 约定）              │
└──────────────┬──────────────────────────────────────────────────────────────────────────┘
               │ 文件系统（只读）
               ▼
┌────────────────────────── Node 宿主进程（Bun，in-process） ─────────────────────────────┐
│                                                                                          │
│  config.yaml ──plugins[kanban].config──▶ install(host,{config}) / settingsFor            │
│      ▲                                        │                                          │
│      │ withConfigLock 读改写                  ▼                                          │
│      │ （仅 settings_set，P1）        ┌───────────────────────────────┐                  │
│      │                                │ kanban 插件                    │                  │
│      └────────────────────────────────│  · 路径白名单 = 配置的 boards  │                  │
│                                       │  · read+parse+normalize（§4）  │                  │
│                                       │  · mtime/size 缓存（§8）       │                  │
│                                       │  · Plugin.rpc(name,params)     │                  │
│                                       └───────────────┬───────────────┘                  │
│                                                       │ registerInProcessPlugin          │
│                                                       ▼                                  │
│                              PluginRpcRegistry（canonical plugin.kanban.*，DTO 校验）    │
│                                                       │                                  │
│                                               gateway RPC（read/write 权限）             │
└───────────────────────────────────────────────────────┼──────────────────────────────────┘
                                                        │ WS/HTTP（同源或平台代理 plugin 命名空间）
                                                        ▼
┌────────────────────────── apps/web（浏览器） ────────────────────────────────────────────┐
│  plugins.list/catalog ──▶ 导航「任务看板」（status 组）                                  │
│  PluginPageView ──ui_trust=embedded──▶ PluginEmbed ──import ESM──▶ KanbanView            │
│        │                                        │ host.rpc('board_get'…)（SDK 白名单）   │
│        └──isolated 回退──▶ PluginFrame(iframe)  │ host.theme/toast/i18n                  │
│                                                 ▼                                        │
│                          看板列视图 / 任务卡片 / 归档 tab / 设置节（§7）                 │
│                                                                                          │
│  q-settings 设置页 ──「任务看板」域──▶ schema: catalog.manifest.contributes.settings     │
│                                       现值: config.get → plugins[kanban].config          │
│                                       写入: P1 plugin.kanban.settings_set                │
│                                             P2 宿主 plugins.settings.set（§5.4/§10）     │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

边界要点：

- **真相源唯一**：看板内容的真相源是磁盘上的 board.json（main 维护）；插件内存只有派生只读缓存，不产生第二份真相。设置真相源是 config.yaml `plugins[kanban].config`（与所有插件同口径）。
- **插件对看板文件零写入**：读路径 `readFile` only；归档移动由维护者完成（§9）。
- **读边界**：插件只读「配置的路径白名单」内的文件 + 板内 archive 指针（同目录 containment，§5.3）；不接受 RPC 参数传入任意路径。
- **信任档**：builtin → embedded（服务端计算）；SDK 白名单只防误用不是沙箱（契约 §1 措辞照抄）。

## 4. 看板文件 schema（v1，兼容 v0）

设计原则：**现有 board.json 零改动可读**（v0）；新字段全部 additive、可缺省；插件宽进（容忍未知键）严出（DTO 形状固定）。

### 4.1 Board 文档（board.json）

```jsonc
{
  "schemaVersion": 1,                  // 可选；缺省按 v0 兼容解析。未来不兼容变更才 bump
  "board": "vessel 红蓝开发任务看板",   // 必填，string，板标题
  "updated": "2026-11-23T23:30:00+08:00", // 可选，ISO8601；维护者每次改板更新
  "note": "本文件由 main 维护……",      // 可选，string，板级说明（UI banner 展示）
  "columns": ["待办", "进行中", "已完成", "阻塞"],
  // v0：string[]（现状，列名即 id）。v1 可升级为对象数组（二选一，不可混用）：
  // "columns": [
  //   { "id": "todo", "title": "待办", "order": 0, "wipLimit": 5, "tone": "neutral" },
  //   { "id": "doing", "title": "进行中", "order": 1, "tone": "info" },
  //   { "id": "done", "title": "已完成", "order": 2, "tone": "success" },
  //   { "id": "blocked", "title": "阻塞", "order": 3, "tone": "danger" }
  // ],
  "archive": {                         // 可选；归档指针（§9）。缺省 = 无归档视图
    "path": "archive.json",            // 相对 board.json 所在目录；containment 校验
    "count": 12,                       // 可选，维护者维护的归档条数提示（UI 可不信，以实际读为准）
    "lastArchivedAt": "2026-11-23T23:30:00+08:00" // 可选
  },
  "tasks": [ /* Task[]，见 §4.2 */ ]
}
```

Column 对象字段：`id`（必填，板内唯一，`[a-z0-9][a-z0-9-]*` 建议但不强制——v0 中文列名直接当 id）、`title`（必填，展示名）、`order?`（缺省按数组序）、`wipLimit?`（正整数，超限列头警示，只提示不阻断）、`tone?`（`neutral|info|success|warning|danger`，映射宿主语义色 token，缺省 neutral）。

### 4.2 Task（板内当前任务）

```jsonc
{
  "id": "q-kanban",                    // 必填，板内唯一，非空 string
  "title": "任务看板插件设计（只读文件弹窗+路径设置）", // 必填，非空 string
  "column": "待办",                    // 必填，必须命中 columns（v0 列名 / v1 列 id 或 title）
  "owner": "q-kanban",                 // 可选，string（agent 名 / 人）
  "branch": "design/q-kanban",         // 可选，string（git 分支）
  "progress": "新单，派单中",           // 可选，string 自由文本（现状口径，保持）
  // ── 以下为 v1 additive 可选字段，现有板不写也完全合法 ──
  "priority": "high",                  // 可选，"low"|"normal"|"high"|"urgent"，缺省 normal
  "tags": ["design", "plugin"],        // 可选，string[]
  "links": [                           // 可选，关联链接（commit / PR / 文档）
    { "label": "merge 8694a681", "href": "…" }
  ],
  "createdAt": "…", "updatedAt": "…",  // 可选，ISO8601
  "doneAt": "…"                        // 可选，ISO8601；进入完成列的时间（归档候选依据）
}
```

**progress 保持自由文本**：现有板的 progress 是给人读的进度叙述（含 merge hash / build 读数），结构化百分比会丢信息。v1 不引入 `percent`；若未来要进度条，additive 加 `progressPercent?: 0..100`，与文本并存（文本仍是主展示）。

### 4.3 归档文档（archive.json，§9 详述）

```jsonc
{
  "schemaVersion": 1,
  "board": "vessel 红蓝开发任务看板",   // 与板同名，标识归属
  "entries": [                         // append-only 约定：只追加，不改写历史条目
    { /* Task 全字段 */ "archivedAt": "2026-11-23T23:30:00+08:00", "cycle": "redblue-0.56" }
  ]
}
```

`archivedAt` 必填（归档时刻）；`cycle?` 可选（迭代/版本标签，便于按轮次过滤）。归档条目是**历史快照**：归档后板内再发生什么与它无关。

### 4.4 归一化与校验策略

插件内部统一 DTO（RPC 返回形状，camelCase）：

```ts
interface BoardDTO {
  id: string;                 // 配置侧板 id（§5），不是文件字段
  title: string;              // board
  updated?: string;
  note?: string;
  columns: ColumnDTO[];       // string[] 归一化为 {id:title, title}
  tasks: TaskDTO[];           // 合法任务，按列分组由 UI 做
  archive?: { path: string; count?: number; lastArchivedAt?: string };
  source: { path: string; mtimeMs: number; sizeBytes: number; schemaVersion: number };
  warnings: string[];         // 任务级/字段级降级说明（见下）
}
```

校验分级（**宽进严出，坏任务不拖垮整板**）：

| 级别 | 情形 | 处理 |
| --- | --- | --- |
| 板级 fail-closed | 文件不存在 / 不可读 / JSON parse 失败 / 顶层不是对象 / 缺 board 或 tasks 不是数组 | RPC 返回结构化错误（§6 错误码），UI 错误态 + 原文预览（parse 错误带行列号） |
| 列级降级 | columns 缺省 / 空 | 从 tasks 的 column 值去重推导列（保持出现顺序），warning |
| 列级降级 | task.column 未命中 columns | 归入虚拟列「未分类」（UI 末尾灰列），warning，不丢任务 |
| 任务级降级 | 缺 id / title / column，或类型错 | 跳过该任务，warning 记 `tasks[i]: <原因>`；其余照常展示 |
| 字段级容忍 | 未知键、可选字段类型错 | 未知键忽略（前向兼容）；可选字段类型错 → 丢弃该字段 + warning |
| id 冲突 | 板内重复 id | 保留首个，后续跳过 + warning |

大小上限：单文件读取上限 **2 MiB**（超出报 `board_too_large`，防误配大文件打爆内存）；任务数软上限 2000（超出截断 + warning）。上限是插件自持常量，不走配置。

### 4.5 Markdown 板（P2，可选格式）

按扩展名分流：`.json` 走 §4.1；`.md` 走约定式解析（P2 实现，一期只留接口位）：

```markdown
# 板标题            ← 一级标题 = board
> 板说明            ← 引用块 = note（可选）
## 待办             ← 二级标题 = 列（出现顺序即列序）
- [ ] 任务标题 ^q-kanban @q-kanban (design/q-kanban)   ← 列表项 = 任务
      进度叙述缩进续行 = progress
- [x] 已完成任务 …   ← [x] 仅影响卡片勾选样式，列归属仍以 ## 为准
```

约定：`^id`（缺省由标题 slug 生成）、`@owner`、`(branch)`、`!high` 优先级、`#tag`。解析失败同样板级 fail-closed + 原文预览。**一期不实现**，避免把 markdown 方言做复杂；JSON 是唯一的一等格式。

## 5. 设置贡献与多路径配置

### 5.1 contributes.settings 键表（manifest 声明，q-settings 的 schema 源）

| 键 | 类型 | 缺省 | 说明 |
| --- | --- | --- | --- |
| `boards` | `array`（items: object `{path: string, title?: string, id?: string}`） | `[]` | 展示文件路径列表（多路径）。`path` 必填；`title` 缺省取文件内 `board` 字段；`id` 缺省由 path 派生（basename 去扩展名，冲突加序号） |
| `refreshIntervalMs` | `integer`（minimum 0） | `10000` | 页面可见期自动轮询间隔；`0` = 纯手动刷新 |
| `showArchive` | `boolean` | `true` | 是否显示归档 tab（板内有 archive 指针时才有内容） |

兼容别名：`paths: string[]`（只给路径的简写）在解析时归一化为 `boards`；两者同时存在时 `boards` 优先。settings 声明只写 `boards`（别名不进 manifest schema，避免 q-settings 渲染出两个入口）。P2 追加 `archiveHintDays`（integer，缺省 7，归档候选徽章阈值，§9.3）——additive，一期不声明。

manifest 片段（JSON Schema 子集，宿主 v1 不自动渲染表单，渲染是 q-settings 的事）：

```jsonc
"settings": {
  "boards": {
    "type": "array",
    "description": "看板文件路径列表（只读展示）。每项 {path, title?, id?}；path 支持绝对路径或相对项目根的路径",
    "default": [],
    "items": {
      "type": "object",
      "properties": {
        "path": { "type": "string", "description": "看板文件路径（.json；.md 二期）" },
        "title": { "type": "string", "description": "展示名（缺省取文件内 board 字段）" },
        "id": { "type": "string", "description": "板标识（缺省由文件名派生）" }
      },
      "required": ["path"]
    }
  },
  "refreshIntervalMs": { "type": "integer", "description": "自动刷新间隔（毫秒），0 = 手动", "default": 10000 },
  "showArchive": { "type": "boolean", "description": "显示归档视图", "default": true }
}
```

### 5.2 config.yaml 示例（设置真相源）

```yaml
plugins:
  - name: kanban
    enabled: true
    config:
      boards:
        - id: redblue
          title: 红蓝开发看板
          # board.json 由 main 在 redblue-dev 分支维护；路径指向其 worktree 检出
          path: D:/Application/APP/Vessel/worktrees/redblue-dev/docs/dev/kanban/board.json
        - path: ./docs/dev/kanban/board.json     # 相对项目根（node 宿主 cwd）
      refreshIntervalMs: 10000
      showArchive: true
```

- 下发链路（现成机制，零新缝）：in-process 经 `buildPluginConfigMap` → `install(host, {config})`；contributions/settings 快照经 `pluginSettingsFor(config, 'kanban')`。未声明键告警丢弃、类型不符 `plugin_config_invalid`（现有校验）。
- **运行期改配置不重启**：kanban 的 rpc handler 每次调用经 `loadConfig()` 读当前合并配置（model-registry `readRegistry` 同模式），config-watch 触发后下一次 RPC 即用新路径；不依赖 install 时的一次性快照。install config 只作缺省兜底。

### 5.3 路径解析与读边界（安全核心）

1. **绝对路径**原样用；**相对路径**相对 node 宿主项目根（`process.cwd()`，与 basic-tools 缺省 cwd 同口径）解析。路径是**宿主 OS 路径**（Windows 节点写 `D:/…`，WSL 里跑节点写 `/mnt/d/…`）；不做跨 OS 路径翻译（风险见 §13）。
2. 规范化：`path.resolve` + 去重（同一 realpath 只留一个板 id）；**不支持 glob / 目录扫描 / `~` 展开**（一期显式文件路径，避免误配目录把一堆文件拉进 UI）。
3. **读白名单 = 配置的 boards 路径集合**。`board_get` 只接受板 `id` 参数，不接受自由路径；id 未命中 → `invalid_params`。插件代码内再校验一次解析后路径 ∈ 白名单（防配置热更与缓存错位）。
4. **archive 指针 containment**：`archive.path` 来自**文件内容**（不可信输入），必须解析后落在 board.json 所在目录之内（词法 + realpath 双检），且扩展名 ∈ {.json, .md}；越界 → 忽略指针 + warning，绝不读。这条挡住「恶意板文件把 archive 指向敏感文件诱导读展示」的路径。
5. 只读纪律：插件对板文件 / 归档文件只有 `readFile` / `stat`；无任何写 / 删 / 改名代码路径。`permissions.fs` 声明 `["user-config", "board-files"]`（in-process 的 fs 声明是声明性的，实际边界由上述白名单自持；`user-config` 覆盖 settings_set 写 config.yaml）。

### 5.4 设置写路径（两期）

- **P1：插件自持 `plugin.kanban.settings_set`（permission write）**——model-registry 先例：`withConfigLock` 内 read-modify-write，只改 `plugins[name=kanban].config` 块，其余键原样保留；写前按 §5.1 schema 自校验（fail-fast，不落无效配置）；返回写后读回。config-watch 随后触发热应用。此路径**零宿主改动**，kanban 独立可交付。
- **P2：宿主通用 `plugins.settings.set {id, config}`（additive，与 q-settings 共建）**——`config.set` 白名单今天不含 plugins[]（embed 契约 §1 明言一期无 RPC 写路径）。VSCode 式设置页要能保存**任意**插件的设置，需要一条通用写缝：只允许写目标插件 manifest `contributes.settings` 声明过的键、按声明类型校验、**禁止**经此路径写 `enabled / trust_ui / expose`（那些是信任/授权面，保持手改 config.yaml 或既有 CLI）。kanban 届时把 `settings_set` 标记 deprecated 并转发同一落盘逻辑。此缝属宿主改动，**不在本插件设计内实施**，列 §10 协同契约供 q-settings / main 裁定。

## 6. RPC 接口契约

canonical 前缀 `plugin.kanban.`（SDK 侧裸名）。全部经 `PluginRpcRegistry` 同一 DTO 校验；read 方法对 gateway read token 开放，write 方法需 write 权限。

### 6.1 方法表

| 裸名 | 权限 | 参数 | 结果 | 说明 |
| --- | --- | --- | --- | --- |
| `boards_list` | read | `{}` | `{ boards: BoardMeta[], settings: EffectiveSettings }` | 配置侧板清单 + 生效设置；每项含存在性/mtime，不含板内容 |
| `board_get` | read | `{ id: string, ifMtimeMs?: number, ifSizeBytes?: number }` | `BoardGetResult`（见下） | 读+解析+归一化一个板；条件命中返回 unchanged |
| `archive_get` | read | `{ id: string, offset?: number, limit?: number, query?: string }` | `{ entries: ArchivedTaskDTO[], total: number, offset: number }` | 归档分页读（P2）；query 对 title/owner/branch/cycle 子串过滤 |
| `settings_get` | read | `{}` | `{ settings: EffectiveSettings, source: 'config' }` | 生效设置回显（q-settings 现值也可走 config.get，此口供插件页自足） |
| `settings_set` | write | `{ boards?, refreshIntervalMs?, showArchive? }` | `{ ok: true, settings: EffectiveSettings }` | §5.4 P1 写路径；整块替换传入键，未传键保留 |

### 6.2 DTO

```ts
interface BoardMeta {
  id: string; title: string; path: string;      // title 缺省 = 文件内 board，再缺省 = 文件名
  exists: boolean; mtimeMs?: number; sizeBytes?: number;
  error?: { code: string; message: string };    // 存在但读/解析失败时的摘要（list 不抛整表）
}
interface EffectiveSettings {
  boards: Array<{ id: string; path: string; title?: string }>;
  refreshIntervalMs: number; showArchive: boolean;
}
type BoardGetResult =
  | { unchanged: true; mtimeMs: number; sizeBytes: number }        // ifMtimeMs+ifSizeBytes 双命中
  | { unchanged: false; board: BoardDTO; mtimeMs: number; sizeBytes: number };
// BoardDTO 见 §4.4；ArchivedTaskDTO = TaskDTO & { archivedAt: string; cycle?: string }
```

轮询协议（§8）：UI 持上次 `mtimeMs/sizeBytes`，poll 时带 `ifMtimeMs/ifSizeBytes`；宿主只 `stat` 不读文件，命中即回 `{unchanged:true}`（一次 RPC ≈ 一次 stat，廉价）。不命中才读+解析。文件被替换但 mtime 精度不够的极端情形由 size 双条件兜底；仍漏则手动刷新必达（手动不带条件）。

### 6.3 错误码（插件侧 `Error('code: message')` → registry toRpcError）

| code | 触发 | UI 呈现 |
| --- | --- | --- |
| `invalid_params` | id 缺失/未命中白名单、参数类型错、settings 校验失败 | toast + 表单字段错误 |
| `board_not_found` | 配置路径不存在 | 板级空态：路径 + 「去设置」动作 |
| `board_unreadable` | EACCES / EISDIR 等 fs 错误 | 板级错误态 + errno 摘要 |
| `board_parse_error` | JSON parse 失败 / 顶层形状错 | 错误态 + 行列号 + 原文预览（截断 4 KiB） |
| `board_too_large` | > 2 MiB | 错误态 + 实际大小 |
| `archive_unavailable` | 无指针 / containment 拒绝 / 归档读失败 | 归档 tab 内错误态，不影响当前板 |
| `config_write_failed` | settings_set 落盘失败（锁/权限） | toast error，设置表单保留草稿 |

### 6.4 事件与推送

一期**不声明 contributes.events**（无宿主→插件事件需求），也不依赖插件→UI 推送（现契约无此通道，§8）。`permissions.events: []`。

## 7. UI 设计（页面 + 弹窗路线）

### 7.1 页面挂载

- `contributes.pages`：单页 `{ id: "kanban", title: "Task Board", titleKey: "nav.kanban", nav: "status", icon: "runs", order: 30, entry: "kanban.html", component: "KanbanView" }`。挂内置 `status` 组（看板是状态可视化，不新开导航组；单页不值得一个 `plugin:kanban` 组）。
- embed 档：`KanbanView` 是 `PluginMountProps` 组件（`{host, mount:'page', context}`），数据全走 `host.rpc`；iframe 回退页 `kanban.html` 复用同一份 web-src（usage 双产线模式）。
- 组件复用 `@vessel-agent/plugin-ui`：`Page` / `Section` / `Tabs` / `Badge` / `CountBadge` / `SearchInput` / `Button` / `Stat`；卡片自绘（plugin-ui 无现成 KanbanCard）。

### 7.2 线框（描述式）

```
┌────────────────────────────────────────────────────────────────────────────┐
│ 任务看板  [红蓝开发看板 ▾]        更新于 11-23 23:30 · ↻ 刷新 · ● 10s 自动   │  ← Page header：
│           (多板切换下拉/Tabs)      (updated 来自文件)  (手动)  (轮询状态点)   │     板切换器仅多板时显示
├────────────────────────────────────────────────────────────────────────────┤
│ ⓘ 本文件由 main 维护，任务看板插件只读此文件弹窗展示……                      │  ← note banner（可折叠）
├────────────────────────────────────────────────────────────────────────────┤
│ [当前板] [归档 (12)]                                    🔍 过滤 owner/分支/文本 │  ← Tabs + 过滤框
├────────────────────────────────────────────────────────────────────────────┤
│  待办 (5)      │  进行中 (2)     │  已完成 (2)     │  阻塞 (1)      │ ⋯      │  ← 列头：标题+计数
│ ┌────────────┐ │ ┌────────────┐ │ ┌────────────┐ │ ┌────────────┐ │        │     wipLimit 超限警示色
│ │ q-cli      │ │ │ q-modes    │ │ │ q-validation│ │ │ q-pool-…   │ │        │
│ │ CLI 规范架 │ │ │ S5/S6/S7 … │ │ │ O1 DTO语义… │ │ │ O4 pool …  │ │        │  ← 卡片：
│ │ 构文档     │ │ │            │ │ │             │ │ │            │ │        │     id 徽章 + 标题
│ │ 👤 q-cli   │ │ │ 👤 q-modes │ │ │ 👤 q-valid… │ │ │ 👤 q-pool… │ │        │     owner / branch
│ │ ⎇ design/… │ │ │ ⎇ fix/…    │ │ │ ⎇ fix/…     │ │ │ ⎇ fix/…    │ │        │     progress 摘要(2行截断)
│ │ 工作树已建 │ │ │ 主体完成…  │ │ │ 已合入…     │ │ │ 两次大文档…│ │        │     priority 左边条色
│ └────────────┘ │ └────────────┘ │ └────────────┘ │ └────────────┘ │        │
│ ┌────────────┐ │                │                │                │        │
│ │ q-redblue …│ │                │                │                │        │
│ └────────────┘ │                │                │                │        │
└────────────────────────────────────────────────────────────────────────────┘
  列区横向滚动（列多时）；列内纵向滚动；卡片点击 → 详情侧栏/展开（progress 全文、
  links、tags、时间戳）；「未分类」虚拟列灰显排最后（§4.4 降级）。
```

- **归档 tab**（P2）：同页 Tabs 第二页，`DataTable` 形态（title / owner / branch / cycle / doneAt / archivedAt），分页 + query 过滤；只读，无任何操作按钮。
- **设置节**（过渡期，q-settings 落地前）：页面底部折叠 `Section`「展示设置」——路径列表（增/删/排序，每行 path + title 输入）、刷新间隔、归档开关；保存调 `settings_set`，成功 toast + 立即重拉 `boards_list`。q-settings 落地后此节收起为「去设置 → 任务看板域」链接（§10）。
- **状态设计**：
  - 加载：固定尺寸骨架（embed 契约 §8，不顶动布局）。
  - 空配置（boards=[]）：空态插画 + 「添加看板文件路径」按钮直达设置节。
  - 板级错误（§6.3）：错误卡 = code + message + 路径 + 重试按钮 + 原文预览（parse 错误）。
  - 任务级 warnings：列头旁 ⚠ 徽章，点开列出降级明细（不弹窗打断）。
  - 轮询失败：状态点变灰 + 上次成功时间，不 toast 轰炸（连续 3 次失败才 toast 一次）。
- **主题/样式**：消费宿主 CSS 变量（tokens.css），暗色自动；CSS 包 `@layer plugin.kanban`，选择器 `[data-vessel-plugin="kanban"]` / `.vp-kanban-` 前缀；不自建 portal，提示统一 `host.toast`（embed 契约 §9）。
- **i18n**：`contributes.i18n` en / zh-CN 双份（nav.kanban / 列头兜底 / 错误文案 / 设置标签），key 集合 typecheck 对齐。

### 7.3 「弹窗」路线（用户意图②的弹窗/页面二选一）

- **P1 = 页面**（上文）。理由：SDK dialog / mounts / router 在 embed 契约 P3 才落地；宿主现有 `Modal.tsx` 是宿主私有组件，插件拿不到挂载口。一期用页面完整满足「展示」意图，不新造宿主缝。
- **P3 候选 = 快速看板弹窗**（与 §12 P3 同口径）：两条路线届时择一（依赖宿主进度，不在本插件内实施）：
  1. SDK `host.dialog`（embed 契约 P3）落地后，kanban 声明 command「打开看板弹窗」，任意页面经命令面板唤起，内容复用 KanbanView 的紧凑变体（只读列视图，无设置节）。
  2. 若 P3 未落地而用户急需：宿主侧 additive 一个「看板速览」Modal 挂点（宿主改动，需 main 裁定），插件仍只供数据 RPC。
- 结论：**弹窗是展示形态的增量，不是数据面的变化**——RPC/设置/刷新设计对两种形态完全通用。

## 8. 刷新机制

| 期 | 机制 | 说明 |
| --- | --- | --- |
| P1 | 手动刷新 | header ↻ 按钮，无条件 `board_get`（不带 ifMtime），必达 |
| P1 | 可见期轮询 | `refreshIntervalMs`（缺省 10s）；`document.visibilityState==='visible'` 才轮询，隐藏即停；带 `ifMtimeMs/ifSizeBytes` 条件（§6.2），命中 = 一次 stat 级 RPC |
| P1 | focus 补刷 | window focus / 路由切回本页时立即补一次条件轮询（切走再切回不 stale） |
| P1 | 设置热更 | config-watch 改 boards 后，下一次 `boards_list`/`board_get` 即用新配置（handler 每次 loadConfig，§5.2）；UI 在 settings_set 成功后主动重拉 |
| P3 候选 | 文件监听 + 推送 | 插件 in-process `fs.watch` 配置路径（去抖 300ms，照 plugin-watch 模式）→ 更新内存缓存；**推送需宿主新缝**（现契约 events 只有宿主→插件转发，无插件→UI 通道）：需 additive「插件发事件入 hub」贡献点（如 `plugin.<id>.changed` → web eventStore → SDK events.subscribe）。宿主改动，列 P3 与 embed P3 一起裁定 |

不做推送的理由：看板文件是低频变更（main 按任务节点改板），10s 轮询 + stat 条件比对的成本可忽略；为它先开宿主事件缝违背「机制在 harness、插件不自造」的次序。轮询间隔可配 0（纯手动）满足极简偏好。

缓存纪律：插件内存缓存只存「解析结果 + mtime/size」，stat 不一致即失效重读；**不跨 RPC 请求持有板内容真相**（真相源永远是磁盘，§3）。

## 9. 归档策略

### 9.1 职责划分（用户意图①的落点）

- **板文件 = 当前态**：board.json 只保留当前任务（含进行中的「已完成」列任务——它们是本轮当前态的一部分）。
- **归档 = 历史态**：完成任务在维护者判定的时点**移出板、追加进 archive.json**。移动是**维护者（main agent / 人）的动作**，插件只读两侧，绝不代写（一期硬约束）。
- 插件对归档的贡献：schema 支持（archive 指针 + entries 形状）+ 只读归档视图（P2）+ 归档候选提示（见下）。

### 9.2 维护者约定（写进 board.json note / 团队操作手册）

1. 任务完成 → 先移入「已完成」列（本轮可见成果）；轮次收尾（合入/验收后）→ 从 board.tasks 删除该条，**追加**到 archive.json `entries`，补 `archivedAt`（必填）、`doneAt`、`cycle`（建议）。
2. archive.json **append-only**：只追加不改写历史条目；文件损坏由维护者负责（插件报 `archive_unavailable` 不背锅）。
3. 板内 `archive.count / lastArchivedAt` 由维护者顺手更新（UI 以实际读到的 entries 为准，count 只是提示）。
4. 归档文件与板同目录（containment 要求，§5.3）；命名约定 `archive.json`（与现有 board.json note 一致）。
5. 大历史（>5000 条）可换 `archive.ndjson`（每行一条 ArchivedTask）——P3 候选，一期 JSON 单文件足够（2 MiB 上限内约数千条）。

### 9.3 插件侧辅助（只读，不越权）

- **归档候选提示**：UI 对「已完成列且 doneAt 超过 N 天（缺省 7，可配 `archiveHintDays`，P2）」的卡片显示 📦 徽章，提示维护者「可归档」；插件不执行移动。
- **归档视图**：`archive_get` 分页 + 过滤（§6.1），让历史可查而不占板面。
- **未来可选写路径（明确不在一期）**：若用户日后要求「插件内一键归档」，需新增 write RPC `task_archive`（板文件 + 归档文件双写、锁、回滚），**推翻只读硬约束，必须用户显式批准**后才设计。本设计预留 schema 兼容（entries 形状即归档写入的目标形状），不预留代码缝。

## 10. 与 q-settings 的协同（VSCode 式设置）

q-settings（design/q-settings，并行设计）目标：检索 / 插件设置域 / 视觉分区。kanban 作为**第一个消费方**注册一个设置域，协同契约如下（供 q-settings 设计对齐，双方都不需要私有缝）：

### 10.1 三件套（schema / 现值 / 写入）

| 件 | 来源 | kanban 侧义务 |
| --- | --- | --- |
| schema | `plugins.catalog` → `manifest.contributes.settings`（已有透传面） | 按 §5.1 声明完整 type/description/default/items；description 即设置页说明文案（en/zh 经 contributes.i18n 或 description 双语约定，由 q-settings 定口径） |
| 现值 | `config.get` → `plugins[kanban].config`（redactConfig 不掩路径类键）；或 `plugin.kanban.settings_get` | 保证生效值 = 磁盘值（handler 每次 loadConfig）；缺省值在 manifest default 声明，q-settings 渲染「未设置=缺省」态 |
| 写入 | P1：`plugin.kanban.settings_set`（插件自持）；P2：宿主通用 `plugins.settings.set`（§5.4） | P1 提供可被设置页调用的 write RPC；P2 迁移后 deprecated 转发 |

### 10.2 设置域注册与视觉分区

- 域 id = plugin id `kanban`；域标题取 `contributes.i18n` 的 `settings.domain`（「任务看板」/「Task Board」），fallback manifest name。
- q-settings 的域列表 = 宿主域（外观/连接/能力…）+ **每个声明了 contributes.settings 的插件一域**（catalog 驱动，无需插件注册动作——声明即注册）。kanban 不需要也不应该自建平行设置入口。
- 检索：q-settings 索引键名 + description；kanban 的 description 写足关键词（「路径」「看板」「刷新」「归档」「path」「board」），保证搜「路径」能命中。
- 视觉分区：boards 是 array-of-object，通用渲染为「列表编辑器」（增/删/排序行）；refreshIntervalMs 数字输入（0=手动提示）；showArchive 开关。若 q-settings 一期只做通用 JSON Schema 渲染，kanban 的 boards 行编辑退化为 JSON 文本域也可用（功能不丢，体验降级）——**不为此要求 q-settings 做定制渲染器**。

### 10.3 过渡期与依赖次序

- q-settings 未落地时：kanban 页面内置设置节（§7.2）自足交付，用户已可配路径。
- q-settings 落地后：kanban 设置节收起为跳转链接；两处写同一真相源（config.yaml kanban 块），无同步问题。
- 宿主通用写缝（plugins.settings.set）是 q-settings 的宿主依赖，不是 kanban 的交付依赖——kanban P1 不被它阻塞。

## 11. manifest 示例与工程结构

### 11.1 package.json（vessel 块全文示例）

```jsonc
{
  "name": "@vessel-agent/kanban",
  "version": "0.56.0",
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "files": ["src", "web"],
  "scripts": {
    "typecheck": "tsc --noEmit",
    "build:ui": "tsc -p tsconfig.web.json --noEmit && vite build && vite build --config vite.config.embed.ts"
  },
  "dependencies": {
    "@vessel-agent/config": "workspace:*",
    "@vessel-agent/core": "workspace:*",
    "@vessel-agent/plugin-sdk": "workspace:*",
    "@vessel-agent/plugin-ui": "workspace:*",
    "react": "^19.1.0", "react-dom": "^19.1.0"
  },
  "vessel": {
    "id": "kanban",
    "name": "Task Kanban",
    "version": "0.1.0",
    "engines": { "vessel": ">=0.56.0 <1.0.0" },
    "description": "任务看板：只读展示配置路径的看板文件（当前态），历史归档只读可查；多路径 + 设置域",
    "side": "both",
    "ui": {
      "dir": "web",
      "embed": { "entry": "embed/index.mjs", "css": "embed/index.css",
                 "runtime": { "react": "^19", "sdk": "^1" } }
    },
    "activationEvents": ["onPage:kanban"],
    "contributes": {
      "i18n": {
        "en": { "nav.kanban": "Task Board", "settings.domain": "Task Board" },
        "zh-CN": { "nav.kanban": "任务看板", "settings.domain": "任务看板" }
      },
      "pages": [
        { "id": "kanban", "title": "Task Board", "titleKey": "nav.kanban",
          "nav": "status", "icon": "runs", "order": 30,
          "entry": "kanban.html", "component": "KanbanView" }
      ],
      "settings": { /* §5.1 全文 */ },
      "rpc": [
        { "name": "boards_list", "description": "Configured boards metadata + effective settings", "permission": "read" },
        { "name": "board_get", "description": "Read/parse one board; conditional unchanged via ifMtimeMs/ifSizeBytes", "permission": "read" },
        { "name": "archive_get", "description": "Paged read-only archive entries", "permission": "read" },
        { "name": "settings_get", "description": "Effective kanban settings", "permission": "read" },
        { "name": "settings_set", "description": "Persist kanban config block (config.yaml, withConfigLock)", "permission": "write" }
      ]
    },
    "permissions": {
      "fs": ["user-config", "board-files"],
      "net": [], "process": false, "secrets": false, "events": []
    }
  }
}
```

注意：rpc 裸名一律 snake_case（`PLUGIN_RPC_NAME_RE = /^[a-z][a-z0-9_-]*$/` 不允许点号），canonical = `plugin.kanban.<裸名>`，全文 §6/§8/§10 同口径。宿主通用方法（`plugins.settings.set`、`config.get` 等）属宿主 RPC 命名空间，点号口径不变，两者不要混淆。

### 11.2 目录结构（照 model-registry / usage 先例）

```
plugins/observability/kanban/
├── package.json              # §11.1
├── src/
│   ├── index.ts              # Plugin 对象：install(host,{config}) 存兜底配置；rpc(name,params) 分发
│   ├── settings.ts           # loadConfig 读生效设置 + 归一化（paths 别名/缺省 id）+ withConfigLock 写
│   ├── board-store.ts        # 白名单校验 / stat / readFile / parse / normalize / mtime 缓存
│   ├── schema.ts             # §4 DTO 类型 + 校验分级（纯函数，无 IO）
│   └── archive.ts            # archive 指针 containment + 分页读（P2）
├── web-src/
│   ├── embed.tsx             # 具名导出 KanbanView（PluginMountProps）
│   ├── KanbanView.tsx        # 页面壳：板切换/Tabs/刷新/轮询 hook
│   ├── BoardColumns.tsx      # 列视图 + 卡片
│   ├── ArchiveView.tsx       # 归档 DataTable（P2）
│   ├── SettingsSection.tsx   # 过渡期设置节
│   ├── useBoard.ts           # board_get + ifMtime 轮询 + visibility/focus
│   ├── i18n.ts / styles.css  # 双语文案 + @layer plugin.kanban
│   └── kanban.html           # iframe 回退入口（classic-script 产线）
├── web/                      # 构建产物入库（iframe 产物 + embed/index.mjs + css + chunks）
├── vite.config.ts / vite.config.embed.ts / tsconfig.web.json
```

### 11.3 装配接线点（实施期改动清单，全部有先例）

1. `src/plugin-loader.ts` 默认内置名单 + `plugins/observability/kanban` 发现（builtin 目录扫描已覆盖，确认默认启用集包含 kanban）。
2. in-process 登记：走现有 `registerInProcessPluginEntries`（wiring 收集处加 kanban 条目，照 model-registry）。
3. 无新宿主缝：RPC registry / embed 加载 / catalog settings 透传 / config-watch 全部现成。
4. 构建：`build:ui` 双产线（iframe + embed lib 模式，external react/sdk，照 usage §10）；产物入库带 biome-ignore 头；根 `bun run build` typecheck 覆盖。

## 12. 分期计划

每期独立可交付、独立验收；后一期不阻塞前一期上线。实施另派单（本任务只交付设计）。

### P1 — 最小只读闭环（核心交付）

| 项 | 内容 |
| --- | --- |
| 插件骨架 | `plugins/observability/kanban`：Plugin 对象 + rpc 分发 + 装配登记（§11.3） |
| 数据面 | `boards_list` / `board_get`（含 ifMtime 条件、§4 校验分级、2 MiB 上限）；settings 读（loadConfig 每次现读） |
| 设置 | §5.1 三键声明 + `settings_set` 写 config.yaml（withConfigLock）+ 路径白名单/containment |
| UI | embed 页 KanbanView：板切换、列视图、卡片、note banner、手动刷新 + 可见期轮询 + focus 补刷、错误/空态、过渡期设置节；iframe 回退产物 |
| 不做 | 归档视图、markdown、弹窗、事件推送、宿主通用写缝 |
| 验收（用户手动） | ① 配置现有 redblue board.json 路径 → 页面渲染与文件内容一致（撰写时 4 列 11 任务）；② main 改板 → 10s 内自动更新；③ 配第二个路径 → 切换器出现；④ 配错误路径/坏 JSON → 对应错误态不崩宿主；⑤ 设置节增删路径 → config.yaml 落盘且页面即时生效；⑥ `bun run build` exit 0 |

### P2 — 归档 + 设置协同

- `archive_get` 分页读 + 归档 tab（DataTable + query）+ 归档候选徽章（`archiveHintDays`）。
- markdown 板解析（§4.5 约定式）。
- q-settings 落地后：设置节收起为域跳转；若宿主通用 `plugins.settings.set` 已落地则迁移（deprecated 转发）。
- 验收：归档 12 条可翻页可过滤；坏归档只影响归档 tab；q-settings 域内改路径与插件页行为一致。

### P3 — 弹窗 + 推送（依赖宿主进度，需 main 裁定）

- 快速看板弹窗：SDK dialog（embed 契约 P3）或宿主 Modal 挂点，二选一（§7.3）。
- 文件监听 + 插件→UI 事件推送（需宿主 additive 事件缝，§8）。
- `archive.ndjson` 大历史格式（可选）。
- 一键归档 write RPC：**仅当用户显式批准推翻只读约束**才启动设计（§9.3）。

## 13. 风险与缓解

| # | 风险 | 影响 | 缓解 |
| --- | --- | --- | --- |
| 1 | 配置路径指向敏感文件（误配/恶配），插件读并展示 | 信息泄露 | 只读白名单 = 显式配置路径（用户自己配的即授权）；archive 指针 containment（§5.3）挡文件内容诱导；UI 展示路径全名让用户可见可纠；不递归目录、不 glob |
| 2 | 板文件被并发写（main 正在改）读到半截 JSON | parse 错误闪烁 | 读失败保留上次成功渲染 + 状态点变灰，下次轮询自愈；维护者约定原子写（write 临时文件 + rename，插件侧不要求但文档建议） |
| 3 | mtime 精度不足致轮询漏更新 | 板面 stale | mtime+size 双条件；手动刷新必达；focus 补刷；P3 watch 兜底 |
| 4 | Windows / WSL 路径口径混淆（`D:/…` vs `/mnt/d/…`） | 配了路径读不到 | 路径 = 宿主 OS 口径（§5.3），错误态回显解析后的绝对路径 + exists=false，用户一眼可纠；不做跨 OS 翻译（避免第二套路径真相） |
| 5 | 大板 / 大归档打爆内存或 RPC 帧 | 宿主卡顿 | 2 MiB 文件上限 + 2000 任务软上限 + 归档分页（limit 缺省 50 上限 200） |
| 6 | in-process 插件崩溃拖垮 node 宿主 | 节点不可用 | 插件代码全 try/catch 收敛为结构化 RPC 错误（registry toRpcError 兜底）；无后台定时器（轮询在浏览器侧）；无子进程 / 无 net |
| 7 | settings_set 与 config.set / CLI 并发写 config.yaml | 配置丢失 | withConfigLock 跨进程锁 + lock 内 read-modify-write + 只改 kanban 块（model-registry 已验证模式） |
| 8 | q-settings 设计未定，协同契约漂移 | 返工 | §10 三件套全部走**现有** catalog/config.get 面，无私有缝；写路径 P1 自持不依赖 q-settings；通用写缝只是 P2 迁移项 |
| 9 | embed 契约 P3（dialog/mounts）延期 | 弹窗形态缺位 | 页面形态 P1 完整满足展示意图；弹窗是纯增量（§7.3），数据面零改动 |
| 10 | 现有 board.json 形状演进（main 加字段） | 解析降级 | 宽进严出 + 未知键容忍（§4.4）；schemaVersion 只在破坏性变更时 bump；v0 永远可读 |
| 11 | 插件被误当写入方（用户期待插件内拖拽改板） | 预期落差 | 文档 / UI 明示「只读 · 由 main 维护」note banner；拖拽编辑明确不在范围（推翻只读需用户批准，§9.3） |

## 14. 验收与宪法合规

- **零测试 / 零探针 / 零临时进程**：本设计不含任何测试计划；实施期构建期检查只有 `bun run build`（typecheck + biome ci）与构建产物读数；行为验证由用户按 §12 各期验收单手动完成。
- **不改代码（本任务）**：本分支只提交本文档；实施另派单。
- **机制在 harness**：不新造注册表 / 配置解析 / RPC 通道；全部复用 §1 盘点出的现有缝；唯一提议的宿主新缝（plugins.settings.set / 事件推送 / dialog）均标注为宿主侧 additive、需 main 裁定、不阻塞插件 P1。
- **真相源唯一**：板内容真相在磁盘文件（main 维护），设置真相在 config.yaml；插件内存只有派生只读缓存。
- **additive 纪律**：schema 新字段全可缺省；现有 board.json / 旧插件 / 旧客户端零影响。

## 15. 参考

- `docs/architecture/plugins.md` / `docs/architecture/plugin-embed.md` / `docs/adr/ADR-102-host-level-ui-mount.md`
- `packages/plugin-sdk/src/index.ts`、`src/plugin-manifest.ts`、`src/plugin-host-assembly.ts`、`src/plugin-config.ts`
- `packages/serve/src/plugin-host/registry.ts`、`packages/serve/src/gateway/methods/config.ts`
- `plugins/provider/model-registry/**`、`plugins/observability/usage/**`
- `redblue-dev:docs/dev/kanban/board.json`