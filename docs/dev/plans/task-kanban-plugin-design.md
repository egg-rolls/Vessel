# 任务看板插件（kanban）设计

> 状态：设计中（q-kanban，design/q-kanban 分支）
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
| settings 写路径 | `config.set` 白名单**不含 plugins[]**；先例：model-registry 自持 write RPC，经 `withConfigLock` 读改写 config.yaml 自己的块 | kanban P1 同模式自持 `settings.set`；P2 提宿主通用 `plugins.settings.set`（§5.4） |
| 文件监听 | `src/plugin-watch.ts`（插件目录+config.yaml，300ms 去抖）、`src/config-watch.ts`；**无任意文件监听、无插件→UI 事件推送通道**（events 只有宿主→插件转发） | 刷新 P1 = 手动 + 可见期轮询（ifMtime 廉价比对）；推送列 P3 候选（§8） |
| 参考插件 | `plugins/provider/model-registry`（in-process + rpc + embed 双页 + fs 声明 + config.yaml 写）；`plugins/observability/usage`（embed 双产线样本） | kanban 目录 / 构建 / 装配全部照这两个先例 |
| 导航 | 内置组 chat/network/runs/integrations/status/observe/settings/top/plugins + 自定义 `plugin:<id>` 组；图标白名单 | 看板页挂 `status` 组，icon `runs`（§7.1） |
| 版本 | 仓库 0.56.0；plugin-sdk 1.0.0（独立版本线） | `engines.vessel: ">=0.56.0 <1.0.0"`，`runtime: { react: "^19", sdk: "^1" }` |

## 2. 形态决策

**决定：builtin in-process 只读插件 + embed 页面**，落位 `plugins/observability/kanban`，id `kanban`。

- in-process：需要直接读宿主文件系统上「配置的路径」；child 插件只有 data-dir 注入，读任意配置路径要另开缝，得不偿失。
- 只读：不注册 tool / provider / hook / guardrail，不影响 run 与模型输入；只贡献 pages / rpc(read) / settings / i18n。唯一 write RPC 是 `settings.set`（写的是 config.yaml 的 kanban 配置块，**不是看板文件**）。
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
│      │ （仅 settings.set，P1）        ┌───────────────────────────────┐                  │
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
│        │                                        │ host.rpc('board.get'…)（SDK 白名单）   │
│        └──isolated 回退──▶ PluginFrame(iframe)  │ host.theme/toast/i18n                  │
│                                                 ▼                                        │
│                          看板列视图 / 任务卡片 / 归档 tab / 设置节（§7）                 │
│                                                                                          │
│  q-settings 设置页 ──「任务看板」域──▶ schema: catalog.manifest.contributes.settings     │
│                                       现值: config.get → plugins[kanban].config          │
│                                       写入: P1 plugin.kanban.settings.set                │
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

兼容别名：`paths: string[]`（只给路径的简写）在解析时归一化为 `boards`；两者同时存在时 `boards` 优先。settings 声明只写 `boards`（别名不进 manifest schema，避免 q-settings 渲染出两个入口）。

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
          path: D:/Application/APP/Vessel/Vessel/docs/dev/kanban/board.json
        - path: ./docs/dev/kanban/board.json     # 相对项目根（node 宿主 cwd）
      refreshIntervalMs: 10000
      showArchive: true
```

- 下发链路（现成机制，零新缝）：in-process 经 `buildPluginConfigMap` → `install(host, {config})`；contributions/settings 快照经 `pluginSettingsFor(config, 'kanban')`。未声明键告警丢弃、类型不符 `plugin_config_invalid`（现有校验）。
- **运行期改配置不重启**：kanban 的 rpc handler 每次调用经 `loadConfig()` 读当前合并配置（model-registry `readRegistry` 同模式），config-watch 触发后下一次 RPC 即用新路径；不依赖 install 时的一次性快照。install config 只作缺省兜底。

### 5.3 路径解析与读边界（安全核心）

1. **绝对路径**原样用；**相对路径**相对 node 宿主项目根（`process.cwd()`，与 basic-tools 缺省 cwd 同口径）解析。路径是**宿主 OS 路径**（Windows 节点写 `D:/…`，WSL 里跑节点写 `/mnt/d/…`）；不做跨 OS 路径翻译（风险见 §13）。
2. 规范化：`path.resolve` + 去重（同一 realpath 只留一个板 id）；**不支持 glob / 目录扫描 / `~` 展开**（一期显式文件路径，避免误配目录把一堆文件拉进 UI）。
3. **读白名单 = 配置的 boards 路径集合**。`board.get` 只接受板 `id` 参数，不接受自由路径；id 未命中 → `invalid_params`。插件代码内再校验一次解析后路径 ∈ 白名单（防配置热更与缓存错位）。
4. **archive 指针 containment**：`archive.path` 来自**文件内容**（不可信输入），必须解析后落在 board.json 所在目录之内（词法 + realpath 双检），且扩展名 ∈ {.json, .md}；越界 → 忽略指针 + warning，绝不读。这条挡住「恶意板文件把 archive 指向敏感文件诱导读展示」的路径。
5. 只读纪律：插件对板文件 / 归档文件只有 `readFile` / `stat`；无任何写 / 删 / 改名代码路径。`permissions.fs` 声明 `["user-config", "board-files"]`（in-process 的 fs 声明是声明性的，实际边界由上述白名单自持；`user-config` 覆盖 settings.set 写 config.yaml）。

### 5.4 设置写路径（两期）

- **P1：插件自持 `plugin.kanban.settings.set`（permission write）**——model-registry 先例：`withConfigLock` 内 read-modify-write，只改 `plugins[name=kanban].config` 块，其余键原样保留；写前按 §5.1 schema 自校验（fail-fast，不落无效配置）；返回写后读回。config-watch 随后触发热应用。此路径**零宿主改动**，kanban 独立可交付。
- **P2：宿主通用 `plugins.settings.set {id, config}`（additive，与 q-settings 共建）**——`config.set` 白名单今天不含 plugins[]（embed 契约 §1 明言一期无 RPC 写路径）。VSCode 式设置页要能保存**任意**插件的设置，需要一条通用写缝：只允许写目标插件 manifest `contributes.settings` 声明过的键、按声明类型校验、**禁止**经此路径写 `enabled / trust_ui / expose`（那些是信任/授权面，保持手改 config.yaml 或既有 CLI）。kanban 届时把 `settings.set` 标记 deprecated 并转发同一落盘逻辑。此缝属宿主改动，**不在本插件设计内实施**，列 §10 协同契约供 q-settings / main 裁定。

## 6. RPC 接口契约

canonical 前缀 `plugin.kanban.`（SDK 侧裸名）。全部经 `PluginRpcRegistry` 同一 DTO 校验；read 方法对 gateway read token 开放，write 方法需 write 权限。

### 6.1 方法表

| 裸名 | 权限 | 参数 | 结果 | 说明 |
| --- | --- | --- | --- | --- |
| `boards.list` | read | `{}` | `{ boards: BoardMeta[], settings: EffectiveSettings }` | 配置侧板清单 + 生效设置；每项含存在性/mtime，不含板内容 |
| `board.get` | read | `{ id: string, ifMtimeMs?: number, ifSizeBytes?: number }` | `BoardGetResult`（见下） | 读+解析+归一化一个板；条件命中返回 unchanged |
| `archive.get` | read | `{ id: string, offset?: number, limit?: number, query?: string }` | `{ entries: ArchivedTaskDTO[], total: number, offset: number }` | 归档分页读（P2）；query 对 title/owner/branch/cycle 子串过滤 |
| `settings.get` | read | `{}` | `{ settings: EffectiveSettings, source: 'config' }` | 生效设置回显（q-settings 现值也可走 config.get，此口供插件页自足） |
| `settings.set` | write | `{ boards?, refreshIntervalMs?, showArchive? }` | `{ ok: true, settings: EffectiveSettings }` | §5.4 P1 写路径；整块替换传入键，未传键保留 |

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
| `config_write_failed` | settings.set 落盘失败（锁/权限） | toast error，设置表单保留草稿 |

### 6.4 事件与推送

一期**不声明 contributes.events**（无宿主→插件事件需求），也不依赖插件→UI 推送（现契约无此通道，§8）。`permissions.events: []`。

## 7. UI 设计（页面 + 弹窗路线）

（待扩充：线框、卡片、归档视图、错误/空态、样式与 i18n 契约、弹窗分期）

## 8. 刷新机制

（待扩充：手动 / 可见期轮询 / focus；fs.watch+事件推送为何列后期）

## 9. 归档策略

（待扩充：维护者约定、archive.json schema、containment、插件只读归档视图）

## 10. 与 q-settings 的协同

（待扩充：设置域注册、schema/现值/写路径三件套、检索与视觉分区、过渡期 fallback）

## 11. manifest 示例与工程结构

（待扩充：package.json vessel 块全文、目录树、build:ui 双产线、装配接线点）

## 12. 分期计划

（待扩充：P1 最小闭环 / P2 归档+设置协同 / P3 弹窗+推送，各期交付与验收）

## 13. 风险与缓解

（待扩充）

## 14. 参考

- `docs/architecture/plugins.md` / `docs/architecture/plugin-embed.md` / `docs/adr/ADR-102-host-level-ui-mount.md`
- `packages/plugin-sdk/src/index.ts`、`src/plugin-manifest.ts`、`src/plugin-host-assembly.ts`、`src/plugin-config.ts`
- `packages/serve/src/plugin-host/registry.ts`、`packages/serve/src/gateway/methods/config.ts`
- `plugins/provider/model-registry/**`、`plugins/observability/usage/**`
- `redblue-dev:docs/dev/kanban/board.json`