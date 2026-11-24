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
## 3. 让渡设计

### 3.1 设计原则

1. **有限让渡，默认关**：新能力全部 additive，缺省配置下行为与今天逐字节一致（P1 行为零变化口径，与 bridge_deny 先例同）。
2. **代码硬上限，配置只收窄**：agent 可写键的**上限**是代码常量（哲学同 vessel 自身不可桥：「代码层硬排除，config 不可覆盖」）；用户配置只能在上限内再收窄，不能扩。
3. **敏感键任何通路硬 deny**：不是「不在白名单所以 invalid_params」，而是对 agent principal 显式 deny + 稳定 reason + 审计记录（deny 尝试本身是提权信号）。
4. **单一权限面**：让渡判定只落在 `vessel.checkPermission`（ADR-026），ask 仍走既有 PermissionPolicy / bridge / 权限卡片；不新建第二套审批机制，不在成员选择层重长工具白名单（0.51 裁定 + L-011）。
5. **鉴权落最终 args**（ADR-058 决策 2）：guardrail 改写 op/method/key 都逃不过对应门；`op=set_config` 与 `op=rpc method=config.set` 两个把手同判。
6. **凡让渡必审计**：auto 放行的每一次写入（含 deny 尝试）append-only 落盘；审计不可用时 auto 路径降级 ask（fail-safe）。

### 3.2 键分级（三级）

分级判据：**该键是否影响 ① 权限判定面 ② 凭据/身份 ③ 网络出口/入站 ④ 代码执行面 ⑤ 资源限制/自我约束**。命中任一 → T2；只影响行为且有硬值域 → T1；纯展示/可观测 → T0。

**T0 无害键（可让渡，delegation 命中时 auto allow + 审计）**——全部已在现有白名单内：

| 键 | 理由 |
|---|---|
| `ui.language` `ui.showReasoning` `ui.statusBars` `ui.verbosity` `ui.showInternalEvents` `ui.showArchived` `ui.errorLevel` `ui.askUser` `ui.expandCards` | 纯展示偏好；改坏只影响观感，不影响任何判定 |
| `observability.log.level` `observability.log.color` `observability.log.format` `observability.log.time` | 日志呈现；level 调 debug 只增日志量，不改权限/出口 |
| `observability.showProcessErrors` | 错误展示开关 |

**T1 受限键（可让渡但强制 ask，或加额外值约束）**：

| 键 | 风险 | 处置 |
|---|---|---|
| `agent.cwd` | 改变所有工具相对路径解析起点，间接影响路径边界判定 | 强制 ask；让渡配置显式列入才可达，且值必须落在 allowed_roots 内（additive 校验） |
| `emptyResponse.enabled` `emptyResponse.seamless` `emptyResponse.maxRetries` | 改变重试行为/成本，但有硬值域 [0,10] | 默认 ask；用户可在 delegation 里显式升为 auto（值域不变） |
| `emptyResponse.nudge` | 自由文本，会被注入模型上下文——**持久化 prompt injection 面** | 强制 ask + 长度上限（建议 ≤200 字符，additive 校验）；不可升 auto |

**T2 敏感键（绝不开放，硬 deny + 审计）**——按块枚举（VesselConfig 顶层，`packages/config/src/types.ts:1131-1243`）：

| 块 | 键示例 | 提权路径 |
|---|---|---|
| `provider.*` / `models.*` 凭据 | apiKey / apiKeyEnv / baseUrl / vendor credentials | 换出口窃取上下文、换模型绕过约束 |
| `permission.*` | autoApprove / neverAutoApprove / bridgeDeny / **config_delegation 本身** | 自我解限、自我扩权 |
| `plugins[]` | enabled / 安装 / 配置含 secret 的字段 | 启用代码执行面（插件=任意代码） |
| `mcpServers.*` | command / url / env | 同上，外部进程/出口 |
| `federation.*` / `hub.*` | token / peers / pairing | 接恶意节点、跨节点提权 |
| `auth.*` / `security.*` / `serve.*` / `gateway.*` / `node.*` / `connect.*` / `attention.*` | token / root secret / origins / 端口 | 身份与访问控制 |
| `guardrails[]` / `hooks[]` | 启用/配置 | 拆除护栏（vessel-bridge 本身是 guardrail） |
| `limits.*` / `termination.*` / `scheduler.*` / `lease.*` | maxIterations / maxRuntime / 预算 | 解除自我约束 |
| `teams[]` policy / `agent.permissionMode` | 成员策略 | 改成员权限档 |
| `dataDir` / `envFile` / `envInjection` / `http.allowedOrigins` | 数据根 / 环境注入 / 来源 | 改审计落点、注入凭据、开跨源 |
| `toolsEngine.*` / `transport.*` / `durable.*` | 执行模式 | 改执行面 |

T2 清单以**块前缀**表达（`provider.` `permission.` `plugins.` `mcp_servers.` `federation.` `hub.` `auth.` `security.` `serve.` `gateway.` `node.` `connect.` `attention.` `guardrails.` `hooks.` `limits.` `termination.` `scheduler.` `lease.` `teams.` `data_dir` `env_file` `env_injection` `http.` `tools_engine.` `transport.` `durable.` `pricing.` `session.` `context.` `vision.` `evals.` `feishu.` `update.` `host.`），**默认拒绝未知块**（fail-closed：新配置块出现时自动落 T2，直到人工评审进 T0/T1）。这避免「每加一个键要记得加清单」的 L-011 式静默漏洞——方向反过来：漏加 = 拒绝，不是放行。

> 注意 T2 里 `session.` / `context.` / `vision.` 等并非凭据，但能改压缩/预算/视觉 kill switch，属于自我约束与成本面，一期保守归 T2；后续可逐键评审降级，降级必须走人工代码变更（硬上限表），不走配置。

### 3.3 机制：硬上限表 + `permission.config_delegation` 配置块

**（a）代码硬上限表（单真源）**

新增 `src/config/agent-config-delegation.ts`（应用层，与 ui-settings 同域）：

```ts
/** agent 可让渡键的硬上限：T0 ∪ T1，⊆ SettableConfigKey。配置只能收窄。 */
export const AGENT_DELEGATION_CEILING: Readonly<Record<SettableConfigKey, 'auto' | 'ask'>> = {
  'ui.language': 'auto', /* …T0 全部 'auto'… */
  'agent.cwd': 'ask',
  'emptyResponse.enabled': 'ask',
  'emptyResponse.seamless': 'ask',
  'emptyResponse.maxRetries': 'ask',
  'emptyResponse.nudge': 'ask',
};
export function isAgentDelegatableKey(key: string): boolean;   // 上限判定
export function isSensitiveConfigKey(key: string): boolean;    // T2 块前缀判定（供审计/告警复用）
```

- 上限表**派生自** `SettableConfigKey` 类型（编译期保证 ⊆ 现有白名单）；serve 的 normalizeConfigValue 与 vessel 判定都 import 同一份，消除 §2.6 的第三份漂移。
- `isSensitiveConfigKey` 同时供 §3.6 原始写面守卫与 config-watch 告警复用——敏感块清单也只有一份。

**（b）用户配置块（YAML snake_case，loader 既有映射）**

```yaml
permission:
  config_delegation:
    enabled: false          # 总开关；缺省 false = 今天的行为
    keys:                   # 可选；缺省 = 全部 T0（不含 T1）；只能 ⊆ 硬上限
      - observability.log.level
      - ui.verbosity
    members: ['*']          # 可选；缺省 '*' = 所有成员；可列 member id / team:<name> 收窄
    audit: true             # 缺省 true；false 仅关闭 auto 放行（见下），不关闭记录
```

语义细则：
- `enabled: false`（缺省）：一切照旧——set_config 仍 write→ask，无 bridge 成员仍 deny。
- `keys` 出现硬上限外的键 → **配置校验报错**（validator 拒绝，不静默忽略；与 plugins.config.set「未声明键报错而非静默丢弃」同口径）。
- `members` 收窄到成员级：命中判据 = member id 精确或 `team:<name>` 或 `'*'`。**owner 交互入口不适用让渡**（人在场，维持 ask；让渡是给无人应答的成员身体的）。
- `audit: false` 不是「不记录」而是「不允许无审计的 auto」：auto 路径降级 ask，记录仍写（审计是让渡的对价，不可关）。
- 本块位于 `permission.*` → T2 → **agent 经任何通路不可写**；只能人经 WebUI / TUI / 手改文件写入。热应用走既有 permission applier（§2.7），改完下一轮工具调用即生效。

### 3.4 判定链改造（vessel.checkPermission，唯一改动点）

`op=set_config` 与 `op=rpc method=config.set` 共用同一段键级判定（在 `rpcMethodDecision` 之前插入）：

```
key = 最终 args.key（guardrail 改写后）
1. isSensitiveConfigKey(key)            → deny（稳定 reason: sensitive_config_key）+ 审计 deny
2. !isSettableConfigKey(key)            → 维持现状（ask 后由 handler invalid_params）
3. delegation 未启用 / 非成员身份 / 成员未命中 members / key ∉ keys
                                        → 维持现状：rpcMethodDecision('config.set') = ask
4. key ∈ 硬上限：
   - 档位 'auto'（T0 或用户显式升级的 T1）且审计可用
                                        → allow（source='tool' 显式 allow）+ 审计 allow
   - 档位 'ask'（T1 缺省）             → ask（走既有 PermissionPolicy / bridge）
   - 审计不可用                         → ask（fail-safe 降级）+ warn
```

要点：
- **成员身份解析**：`ToolContext.session_id` → 晚绑定 resolver `getMemberBySession(sessionId) → {member_id, team_id} | undefined`（与 `getLocalRpc` 同口径的 getter 注入；AgentService entries 已按 sessionId 索引，零 core 改动）。解析不到成员 = owner/headless 外壳入口 → 不适用让渡（第 3 步）。**不新增 ctx 字段**，ToolContext 不动。
- auto 是**工具显式 allow**（source='tool'）：`neverAutoApprove` 的 exact `vessel` 仍把它降级 ask（PermissionPolicy.hitsNeverExact 对任何 allow 生效）——用户保留一键收回的保险；scoped `vessel.xxx` 不降级显式 allow（与 agent.close 先例同语义）。
- **不把 vessel 加进 autoApprove**：那会放开全部 write RPC（§3.8 T7）。让渡的免批是键级判定，不是工具名级免批。
- deny/ask/allow 三态都经既有管道：ask 在无 bridge 成员处仍折 deny（restrictPermissions 不改）——但让渡命中的 T0 键在第 4 步已 allow，**不再进入 ask 收口**，这正是 headless 成员获得自助路径的方式。
- `op=rpc` 其它方法（plugins.config.set 等）判定不变：write→ask，硬禁名单不变。
- **让渡只作用 scope=user**：`scope=project` 的 config.set 维持 ask（项目 vessel.yaml 在工作区内，原始写面本就存在，RPC 路径不额外放开；且 project 层同样能写 permission 块，守卫口径必须一致）。
### 3.5 审计设计

**落点**：`<dataDir>/audit/config-writes.jsonl`（node 数据根，append-only，复用 run-journal / archive-audit 的落盘模式；不放工作区，避免成员 cwd 写锁/清理误伤）。

**记录形状**（每行一个 JSON）：

```json
{
  "ts": 1732000000000,
  "actor": { "kind": "member|owner|rpc-client", "member_id": "…", "session_id": "…",
             "run_id": "…", "tool_call_id": "…", "principal_role": "write" },
  "key": "observability.log.level", "scope": "user",
  "old_value": "info", "new_value": "debug",
  "decision": { "result": "allow|deny|ask-denied|error",
                "source": "delegation|approval|policy|whitelist",
                "request_id": "…（ask 路径）", "reason": "sensitive_config_key（deny 时）" },
  "apply": { "hot_applied": true, "restart_required": false }
}
```

细则：
- **统一审计面**：vessel 路径（actor=member/owner）与 gateway RPC 路径（actor=rpc-client，principal role 取自 gateway auth）都写同一份文件——「谁改了 config」只有一个查询入口。
- `old_value` 在 `withConfigLock` 临界区内读（setUserConfigValue 已持锁，审计钩子挂在锁内读-改-写之间），保证 old/new 配对正确。
- **deny 尝试也记录**（敏感键探测是提权信号）；ask 被用户拒绝记 `ask-denied`。
- 值脱敏：T0/T1 键值本身无害，原样记录；白名单外写不进，一期不存在敏感值入审计的路径。
- **失败策略**：auto 路径审计写失败 → 本次降级 ask（fail-safe）；人已批的路径审计失败 → warn 不阻断（落盘已成功，人已在场，与 config-write-apply「apply 失败不回 ok:false」同哲学）。
- 展示（P3 additive）：热应用同款 `runtime.notice` 一行摘要 + Web observe 面板读 jsonl；一期不做 UI。
- 保留：一期不自动清理；按大小轮转 `.1` 防无限增长，后续接 node 数据 prune 策略。

### 3.6 原始文件写面治理（关键前置，需用户裁定）

**问题**：§2.4 已述——config.yaml 不在内置 denylist（2026-11-16 裁定），agent 可经 write/edit/bash 直改 `permission.auto_approve` 等敏感块，config-watch 热应用后**自我解限**。RPC 白名单让渡若不管这扇门，等于给正门装锁、旁门大开。

**选项**：

| 选项 | 内容 | 代价 |
|---|---|---|
| A | config.yaml 重新加回 DEFAULT_DENY_PATHS | 直接推翻 2026-11-16 用户裁定（「不怕改坏」），且连读都受限；不推荐 |
| B | **敏感键写守卫**：write/edit 目标 = 用户配置路径时，解析新旧 YAML，敏感块（isSensitiveConfigKey 同源清单）有 diff → deny + 稳定 reason；无害键 diff 放行 | 合作式边界，只约束 write/edit；bash 直写仍 best-effort（ADR-083 口径：不解析 bash 的文件写，不是沙箱） |
| C | **config-watch 侧检测**：热应用发现敏感块变化且非 RPC 写面来源 → runtime.notice 告警（可选自动回滚到上一份已知良好快照） | 检测滞后一个 debounce；回滚需谨慎（可能吞掉人的合法手改） |

**推荐 B + C 组合**：read 保持全开（尊重原裁定「可以读写自己的配置」中的读）；write/edit 的敏感块 diff 拦截把「改坏无害键」与「自我解限」分开——前者继续放行，后者才是限制对象。这不是「对 agent 过多限制」，而是把 2026-11-16 裁定的信任边界精确到键级：**信任 agent 改偏好，不信任任何主体（含被注入的 agent）改权限策略**。bash 面诚实标注 best-effort，与 ADR-055/083 既有边界一致。

**裁定项**：B/C 都触碰「agent 可自由写 config.yaml」的现状，必须用户确认后才实施（§5）。若用户维持旁门全开，则本设计的 RPC 让渡仍然成立（正门有审计有边界），但必须在文档与运行时 notice 中明示残留风险：白名单不构成安全边界，只是便利通道。

### 3.7 与 q-tool-perm 统一权限面的衔接

- 让渡判定是 vessel 工具**自判**的一部分（ADR-026），不是第五层闸门：四层闸门（成员选择 / 注册侧 / PermissionPolicy / permission-store）原样保留，让渡只改变 vessel 自判的**输出**（键级 allow/ask/deny），后续管道（autoApprove 查表、never 降级、bridge 转发、remember）一概不动。
- q-tool-perm 把 inbox 纳管为 `commonToolSurface` 通用成员工具、`tools.list` 单口径——本设计沿用同一哲学：**判据只有一份**。让渡上限表、敏感块清单、审计钩子都单真源（§3.3），serve/Web/TUI 不复制。
- 成员工具面 = 节点全量（0.51 裁定）不受影响：让渡是**键级**收窄，不是工具级白名单，不触发 L-011「漏加静默缺失」问题（未知键默认拒绝，方向安全）。
- `tools.list` 的 `has_permission_check` 口径不变（vessel 本来就带 checkPermission）；Web ToolPolicyControl 对 vessel 的三档策略（auto/ask/never）继续有效——用户把 vessel 设 never = exact neverAutoApprove，让渡的 auto 也被降级 ask（§3.4），**人的策略永远压过让渡**。
- 权限热应用：`permission.config_delegation` 变更经既有 permission applier 广播到所有存活 EU（applyPermissionRules 整体替换语义），下一轮调用生效；无需新 reload scope。

### 3.8 提权防护（威胁模型）

| # | 攻击路径 | 防护 |
|---|---|---|
| T1 | agent 写 `permission.auto_approve` 加 vessel / 写 config_delegation 给自己扩权 | RPC：permission.* 属 T2 硬 deny + 不在白名单；原始面：§3.6 B 守卫 + C 告警；delegation 块本身 T2 |
| T2 | agent 启用 plugins / mcpServers（任意代码执行面） | T2 硬 deny；plugins.reload 是 write→ask 且不在让渡；注册侧 tenant allow/deny 不变 |
| T3 | agent 改 provider.baseUrl / apiKey 外泄上下文 | T2 硬 deny；凭据本就不在 config.set 白名单 |
| T4 | agent 改 federation/hub token、peers 接恶意节点 | T2 硬 deny；federation 写面（peer add）是 CLI/人类通路 |
| T5 | agent 抬 limits/termination 解除自我约束 | T2 硬 deny |
| T6 | agent 经 `plugins.config.set` 改插件 secret 字段（feishu app_secret 等）间接提权 | 该方法 write→ask 不进让渡；additive 加固（P3）：manifest settings 声明 `secret: true` 的字段对 agent principal 硬 deny（人仍可批） |
| T7 | 用户对 vessel 点 remember-always / auto_approve 加 vessel → 全部 write RPC 免批（粗粒度） | 现存风险，本设计不扩大它：让渡不依赖 autoApprove；文档明示「always on vessel ≠ 只放开 set_config」；P3 additive：scoped remember（`vessel.set_config` / 键级）；缓解：never_auto_approve: [vessel] |
| T8 | guardrail BeforeTool 改写 op/method/key 绕过判定 | checkPermission 对**最终 args** 判定（ADR-058 决策 2）；两个把手（set_config / rpc config.set）同判（§3.4） |
| T9 | 经 scope=project 写项目 vessel.yaml 的 permission 块 | 让渡只作用 scope=user（§3.4）；project 原始写面由 §3.6 守卫同口径覆盖（守卫目标含项目配置路径） |
| T10 | 多租户越界 | config.set 已 default-tenant-only（gateway-config-control），让渡继承 |
| T11 | 审计规避（先关 audit 再写） | audit:false 语义 = 禁 auto 而非禁记录（§3.3）；audit 文件在 dataDir，T2 块 data_dir 不可改 |
| T12 | 无 bridge 成员借让渡绕过「ask→deny 收口」做危险操作 | 让渡只放行 T0（纯展示）；T1 仍 ask→无 bridge 仍 deny；收口逻辑不改 |