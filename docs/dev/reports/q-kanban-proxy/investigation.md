# q-kanban-proxy 调研：proxy 白名单缺 kanban + board_path 只读

日期：2026-11-25 · 分支 fix/q-kanban-proxy（基于 redblue-dev 2a728c19）

## 问题

用户报告看板加载失败 `proxy_method_not_allowed`。q-kanban-view 已落
`kanban.get` / `kanban.archive`（node 侧），但平台代理的方法白名单没有 kanban
命名空间，fail-closed 拒绝（非透传）。追加需求：agent 可经 RPC 帮用户设置/切换
看板路径（config `kanban.board_path`）。

## ① proxy 白名单（根因确认）

- **唯一策略表**：`packages/serve/src/platform/proxy-config.ts`
  - `ALLOWED_RPC_NAMESPACES`（L72-98）：agents/ask/attachments/capabilities/
    config/evals/events/feishu/gateway/health/interactions/mcp/metrics/
    permission/permissions/plugin/plugins/runs/sessions/teams/tools/trace。
    **无 `kanban`**。
  - `checkRpcMethod()`（L349-377）：命名空间不在表里 → 403
    `proxy_method_not_allowed`，文案与用户报告逐字一致（「代理只转发已知命名
    空间的 node 方法…平台侧白名单缺失（fail-closed，不是透传）」）。
  - 消费方两处，同一判据：`proxy.ts:388`（HTTP POST `/nodes/<id>/v1/rpc` 体）
    与 `proxy.ts:661`（WS req 帧）。**加一个命名空间条目即修两个面**。
- 设计注释明示按命名空间而非逐条方法（稳定集合，未知命名空间仍 fail-closed）。
  kanban.get（read）/ kanban.archive（write，仅用户验收勾选触发）均不涉及进程
  生死/服务安装 → 无需进 `DENIED_RPC_METHODS`。
- node 侧方法已就位：`packages/serve/src/gateway/methods/kanban.ts`
  （createKanbanMethods），`gateway.ts:2741` 注册进方法表。

**修法**：additive 加 `'kanban'` 进 `ALLOWED_RPC_NAMESPACES`（带注释）。

## ② board_path 现状（只读，三层白名单均缺）

- **配置键**：YAML `kanban.board_path` → TS `config.kanban.boardPath`
  （loader 通用 snake→camel）。`KanbanConfig`（config/types.ts:371-375）；
  validator.ts:518-530 校验非空字符串；`kanban` 已在已知块列表（L4299）。
- **装配**：`src/cli.ts:1548-1552` 启动时一次性解析
  `path.resolve(expandHome(config.kanban?.boardPath?.trim() || 'docs/dev/kanban/board.json'))`
  → `gatewayOptions.kanban.boardPath` → `createKanbanMethods(deps)` 闭包。
  handler 每次调用读 `deps.boardPath` → **原地改 deps 对象即活生效**
  （kanban.ts 读路径零改动）。
- **config.set 写面（三层白名单，均无 kanban）**：
  1. serve `SETTABLE_KEYS`（gateway/methods/config.ts:71-78）；
  2. asm `isSettableConfigKey`（gateway-config-control.ts:43）；
  3. `SettableConfigKey` + `CONFIG_SET_TARGETS`（src/config/ui-settings.ts:126/162，
     camelCase 键 → YAML block/snake_key 映射 + 按键值校验）。
  CLI `vessel config set` 与 Web 写路径共用 3（config-command.ts:187）。
- **热应用缺口**：config.set 落盘 → `applyWrittenConfig`（cli.ts:1054/1071）→
  `configWatch.trigger()` → reloadRunner `['config','log','permission','tools','mcp']`。
  config scope（gateway-reload-wiring.ts:208-278）只处理
  allowedOrigins/provider/models/federation；kanban 既不在 `RESTART_FIELDS`
  也无 applier → **今天手改 YAML 也静默不生效**（连 requires_restart 都不报）。
- **agent 面已就位**：`vessel op=set_config` → `config.set` RPC
  （src/runtime/vessel-meta.ts:278-283，方法级鉴权 + 审批闸门）。
  复用 config.set 即自动获得 agent 能力，无需新工具面。

## 方案（步骤②实施）

1. **proxy-config.ts**：`ALLOWED_RPC_NAMESPACES` additive 加 `'kanban'`。
2. **config.set 加键 `kanban.boardPath`**（RPC 键用 camelCase，与
   ui.showReasoning / emptyResponse.* 先例一致；落盘 YAML `kanban.board_path`）：
   - serve SETTABLE_KEYS 加键（通用 string 路径：trim 非空已覆盖）；
   - ui-settings：SettableConfigKey 联合 + CONFIG_SET_TARGETS
     `{ block:'kanban', yamlKey:'board_path' }` + 非空字符串校验（agent.cwd 先例）。
3. **热应用（applyFederation 先例，config scope 内部，不新增 reload scope）**：
   - `GatewayReloadWiringOptions` 加可选注入 `applyKanban?: (next) => lines`；
     config scope 里 kanban 块变化（stableValue 比较）→ 调 applier；未注入 →
     `requires_restart` 加 'kanban'（不假装生效）。
   - cli.ts：kanban deps 提为可变对象（同一引用进 gatewayOptions.kanban）；
     applyKanban 用与启动同一表达式重解析路径，原地改 `deps.boardPath`，
     返回摘要行 `kanban: board path → <path>`。
   - 效果：config.set 返回时板路径已活生效（写后热应用单飞行 ≤2s 兜底）；
     手改 YAML 经 config-watch 同样生效。

不新增 kanban.set_path 独立 RPC（任务书允许复用 config.set；少一个新面，
CLI/Web/agent 三入口免费获得）。不动 kanban.ts 读/归档逻辑。

## 门禁

零测试/探针；`bun run build` exit code + 日志实证（步骤③）。