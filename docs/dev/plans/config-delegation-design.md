# agent 配置权限有限让渡设计（q-config-delegate）

- 状态：设计稿（纯设计，不含实现）
- 分支：`design/q-config-delegate`（基线 redblue-dev `79764db7`，已含 q-tool-perm 合并 `422bad6f`）
- 任务来源：用户提问「很多操作需人介入，要不要把 config 操作权限以某些方式让渡给 agent」；main 裁决方向 = **有限让渡，非全开放**。
- 关联：q-tool-perm（工具权限统一，inbox 纳管全局权限面）、ADR-026（工具自描述自判）、ADR-058（统一工具执行管道，鉴权落最终工具+参数）、ADR-075（gateway reload scope）、ADR-055/083（路径边界 / bash denylist 是合作式边界，不是沙箱）、ADR-050/057（YAML-first 配置 / 单一解析器）。

## 0. 结论速览

**让渡方案一句话**：在现有 `config.set` 标量白名单之内，再划一个**代码硬上限的 agent 可写子集**（纯展示 / 可观测性键），由新配置块 `permission.config_delegation`（默认关、只有人能写）按成员收窄；命中子集的写入走 vessel `op=set_config` 显式 allow + **append-only 审计落盘**，其余键维持现状（ask）或硬 deny（敏感键）。不新建第二套权限机制，全部落在 q-tool-perm 统一权限面的既有接缝上。

**三个不可让渡的硬边界**：
1. 敏感键（凭据 / 权限策略 / 联邦 / 插件启用 / 资源限制等，§3.2 T2 清单）对 agent **任何通路**硬 deny，配置不可放开。
2. 让渡配置块本身属于权限策略，**不在 agent 可写子集内**——agent 不能给自己扩权。
3. 白名单 RPC 路径的让渡必须与**原始文件写面**（write/edit/bash 直改 `config.yaml`）一起治理，否则白名单形同虚设（§3.6，需用户裁定）。

## 1. 背景与问题陈述

用户观察：agent 不能改自己的本地 config，很多无害操作（调日志级别、改 UI 偏好）也要人介入。问题是「要不要让渡、让渡多少、怎么防提权」。

main 裁决方向（本设计细化）：
1. agent 可写**安全配置子集**（ui/display 偏好、observability 等无害键），白名单 + 审计落盘。
2. 敏感键**绝不开放**：provider api_key/base_url、permission policy、federation token/peers、plugins 启用（防提权 / 防自我解限）。
3. 复用现有 `config.set` 标量白名单机制（gateway-config-control），给 agent 一个受限子集 + 成员级权限校验。

## 2. 现状调查（证据索引见 §7）

### 2.1 配置写面：`config.set` RPC 与标量白名单

写路径只有一条 canonical RPC：`config.set`（`packages/serve/src/gateway/methods/config.ts:356-397`），方法级权限声明为 `permission: 'write'`。链路：

```
config.set handler
  → normalizeConfigValue(key, value)          # serve 侧白名单 + 类型/枚举/值域校验
  → control.set({tenantId, key, value, scope}) # ConfigGatewayOptionsLike.set
  → createGatewayConfigSet(...)                # src/gateway/gateway-config-control.ts
      - 非 default tenant → forbidden
      - isSettableConfigKey(key) 再验一次（纵深防御）
      - scope: 'user' | 'project'（S5 additive；project 未注入路径 → not_found）
  → setUserConfigValue(key, value, {configPath})  # src/config/ui-settings.ts
      - 按键二次校验（语言枚举 / 布尔 / 枚举 / 整数界 / 非空字符串）
      - withConfigLock 跨进程写锁 → readUserConfigRoot → 只改目标键 → writeUserConfigRoot
        （同目录临时文件 + rename 原子写，0600，保留其它键）
  → createWrittenConfigApplier()               # src/config/config-write-apply.ts
      - 写后同步触发唯一热应用入口 ConfigWatchHandle.trigger()
      - 单飞行 / 2s 上界 / apply 失败不回 ok:false（落盘已成功）
```

**白名单现状**（两处手工保持一致，见 §2.6 漂移风险）：

| 类别 | 键 | 值约束 |
|---|---|---|
| 布尔 | `ui.showReasoning` `ui.showInternalEvents` `ui.showArchived` `ui.askUser` `ui.expandCards` `observability.showProcessErrors` `emptyResponse.enabled` `emptyResponse.seamless` | boolean（接受 'true'/'false' 字符串） |
| 枚举 | `ui.language`(zh-CN/en) `ui.statusBars`(top/bottom/both/none) `ui.verbosity`(minimal/normal/debug) `ui.errorLevel`(user/all) `observability.log.level`(debug/info/warn/error) `observability.log.color`(auto/always/never) `observability.log.format`(pretty/json) `observability.log.time`(auto/none/clock/iso) | 枚举内字符串 |
| 整数 | `emptyResponse.maxRetries` | [0,10] |
| 字符串 | `agent.cwd`（非空路径）`emptyResponse.nudge`（非空文案） | trim 非空 |

即：**白名单已经全是标量、全部有值校验**；`observability.log.modules`（map）明确不进 `config.set`。敏感键（provider / permission / federation / plugins / mcpServers / auth / security / limits …）**从来不在白名单里**，RPC 路径对它们一律 `invalid_params`。

另有 `plugins.config.set`（S4，`permission: 'write'`）：按插件 manifest `contributes.settings` 声明校验类型/枚举/min-max，object/array 只读；child 模式返回 `restartRequired`。**插件设置可能含凭据**（如 feishu app_secret），这是 §3.7 T6 的提权面。

### 2.2 agent 侧入口：vessel 元工具 `op=set_config`

模型面只有一个 `vessel` 工具（用户裁定 2026-11-18，`src/runtime/vessel-meta.ts`）。三种 op：

- `op=call_tool`：vessel-bridge guardrail（priority 40，先于 tool-policy 50）改写成目标 ToolCall，鉴权落**最终目标工具 + args**；vessel 自身 handler 对 call_tool fail-closed。
- `op=rpc` / `op=set_config`：guardrail 原样放行，vessel 自执行，经晚绑定的 `localDispatcher`（bootstrap `src/runtime/bootstrap.ts:2001/2177`）分发。**方法级鉴权在 `vessel.checkPermission`**（ADR-026 工具自判）：
  - `rpcMethodDecision`（vessel-meta.ts:112-122）：manifest 里 `read→allow / write→ask / admin→deny / 未知→deny`（fail-closed）。
  - `RPC_SELF_SERVICE_DENYLIST` 硬禁名单：`permission.respond` / `ask.respond` / `permissions.setToolPolicy`——自审批 / 自改权限策略的方法，模型经任何通路不得触碰。
  - `op=set_config` 等价于 `config.set` → **write → ask**（vessel-meta.ts:264-268）。键白名单/值校验复用 handler，不另造一份。

**所以 agent 今天「能调」set_config，但每次都要人批**；且 `op=rpc method=config.set` 与 `op=set_config` 是同一扇门的两个把手（都落 `rpcMethodDecision('config.set')`），任何让渡改造必须同时覆盖两个把手（§3.4）。

### 2.3 权限校验链（四层闸门）与成员收口

`packages/agent/src/runtime.ts:69-90` 明确四层：

1. **成员选择层**（agent/runtime.ts）：0.51 用户裁定「节点有的 agent 都可以用」——成员工具面 = 父宿主全量，**不再按工具名长白名单**（L-011 教训：漏加是静默能力缺失）。只剩两条例外：deny 档收只读集合（read/media/subscribe）、`ask` 类工具要求 bridge。
2. **注册侧**（tenant-tools）：tenant 级 allow/deny。
3. **单次调用判定**（core PermissionPolicy，`packages/core/src/runtime/permission-policy.ts:129-214）：
   - 工具自带 `checkPermission` → 用工具判定；返回 `ask` 时若 `autoApprove.has(tool.name)` 或 remember-always 命中 → allow。
   - `neverAutoApprove`：exact 工具名把**任何** allow 降级 ask；scoped `tool.action` 只降级 auto 来源的 allow（读 `args.action`）。
   - ask → 发 `tool.permission.request` 事件，无限等待（显式 timeoutMs 才计时），用户 allow/deny/remember。
   - **粒度注意**：`autoApprove` / remember-always 都是**工具名**粒度。对 vessel 点「always」= 放开 vessel 的**全部 write 方法**（含 plugins.config.set），不是只放开 set_config——这是现存的粗粒度风险（§3.7 T7）。
4. **持久化策略**（`src/data/permission-store.ts`）：REPL「always」写回 `permission.auto_approve`；`permissions.setToolPolicy` RPC（write）是唯一 canonical 写方法，但在 vessel 硬禁名单里。

**成员侧 ask 的收口**（`restrictPermissions`，agent/runtime.ts:2160-2186）：

```
工具判定 ask →
  1. autoApprove 命中（且非 never）⇒ allow（用户事前授权优先）
  2. mode=bridge 且有父事件流 ⇒ ask 转发父级（人类权限卡片）
  3. 其余 ⇒ deny（记 agent.member.permission_ask_denied，避免 run 永久等待）
```

成员 permissionMode 缺省：headless → `allow`，交互 → `bridge`（`src/agent/agent-wiring.ts:42`）；非空 team 成员在 `forceBridgeForTeams` 下 allow 提升为 bridge（runtime.ts:1996-2011）。成员恒定免确认 `agent` 工具（`withMemberAutoApprove`，runtime.ts:123-128）。

### 2.4 为什么 agent 当前「不能改 config」——精确回答

把入口逐条摆开：

| 入口 | 现状 | 结论 |
|---|---|---|
| vessel `op=set_config` / `op=rpc config.set`（白名单键） | write→ask；owner REPL 每次人批；team 成员经 bridge 每次人批；**无 bridge 成员（headless/无 team）ask 折 deny** | 能调，但无人批就写不了；无成员级/键级免批 |
| vessel `op=rpc` 敏感方法（permission.respond / setToolPolicy 等） | 硬禁名单 deny | 永不可 |
| vessel `op=set_config` 敏感键（provider.* / permission.* …） | 不在白名单 → invalid_params | 永不可（RPC 路径） |
| write/edit/bash 直改 `~/.vessel/config.yaml` | **2026-11-16 用户裁定已把 config.yaml 从内置 denylist 移除**（basic-tools/src/index.ts:292-299，原话「不怕 agent 会改坏，不要对 agent 做过多限制」）；剩 ~/.ssh ~/.aws ~/.gnupg。受 allowed_roots / 各工具 ask 约束 | 理论上可达，但是**无校验、无审计、可触敏感键**的原始写面（§3.6） |
| `plugins.config.set` | write→ask，不在任何让渡里 | 人批 |

两点澄清：
- 「agent 不能改 config」的准确表述是：**RPC 正门每次要人批（无 bridge 成员直接 deny），而文件旁门在代码上已开但没有护栏**。生产部署的 bash 工具描述仍把 `~/.vessel/config.yaml` 列为拒绝路径——那是旧构建或配置 `deny_paths` 追加所致，与本分支代码已漂移（§6 风险 R6）。
- 无 bridge 成员今天连「请求人批」的资格都没有（ask→deny）。让渡设计必须给这类成员一条**有界、可审计**的自助路径，否则「有限让渡」对最常被卡住的群体（headless contractor）无效。

### 2.5 审计现状

- `src/config` / `packages/config` 无任何 config 写审计（grep audit 零命中）。
- 现有可观测痕迹只有：热应用 `runtime.notice`（config-watch）、`config.set.apply_failed` warn 日志、权限请求事件流。**没有「谁在何时把哪个键从什么改成什么」的落盘记录**。
- 对照物：run journal / timeline archive-audit 已有 append-only 落盘先例可复用模式。

### 2.6 q-tool-perm 统一权限面（衔接基线）

q-tool-perm（合并 `422bad6f`）把 inbox 纳管为通用成员级工具：`commonToolSurface`（`src/agent/agent-control.ts:322` → `packages/serve/src/agent-control.ts:418`）透传执行内核判据，`tools.list` 节点口径 = 宿主工具 + 通用成员工具去重合并。**含义**：权限判据只有一份（执行内核真实注册路径），serve 不拼第二份清单。本设计的让渡判定同样只放在 vessel.checkPermission 一处，不在 serve / Web / TUI 各长一套。

已存在的白名单漂移隐患：serve `methods/config.ts` 的 BOOLEAN/ENUM/NUMBER 集合与 asm `ui-settings.ts` 的 CONFIG_SET_TARGETS/值校验是**两份手工同步的表**（注释互指「一致」）。让渡上限表必须单真源（§3.3），不再加第三份。

### 2.7 热应用与重启边界

`config.set` 写后同步热应用（§2.1）；`gateway.reload` 的 permission/tools/mcp applier（`src/config/hot-apply-appliers.ts`）对所有存活 runtime（owner + 成员 EU）整体替换规则。port 等键 requires restart（ADR-075）。**白名单内的键全部可热应用**——让渡不需要碰重启面。