# 金丝雀编排入主 gateway 调研（canary-node-topology）

> 状态：**调研稿，供用户裁定**（零代码改动）。
> 任务：评估「金丝雀舰队作为主 gateway 下的一个 node，而非独立 gateway」的影响与可行性。
> 分支：`design/q-canary-topology`（基于 redblue-dev）。调研日期：2026-11-25。
> 方法：codegraph + 只读代码/文档/运行时文件查证；未起任何进程、未碰生产 checkout 与 `~/.vessel`。

## 摘要（TL;DR）

1. **平台模型原生支持一 gateway 多 node**（0.49 G3：`nodes.json` registry + NodeSupervisor + 平台代理），每 node 独立 dataDir / config / token / 端口；Web UI 平台模式已有多 node 展示与切换。**机制上可行，不是新造实体。**
2. **但「gateway 托管金丝雀 node」（选项 B）有三个结构性缺口**，全部指向代码改动：
   - spawn 用 **gateway 自己的 entry**（`process.argv[1]`）⇒ 被托管的金丝雀 node 跑的是**生产 checkout 的代码**，版本隔离失效；
   - spawn env **全量继承 gateway 快照**、无 per-node `VESSEL_USER_CONFIG` ⇒ 金丝雀的权限/插件/peer **写回**会落进生产用户配置，env 层还会压过金丝雀 config；
   - 托管 node **没有独立 restart 通道**（`node stop` 拒绝托管 node；平台 RPC 只有 `nodes.list/get/credentials`）⇒ 用户想要的「只 start/restart 金丝雀 node」在 B 下反而做不到。
3. **选项 C（混合）零代码改动即可落地**：金丝雀以 `auto_start: false` 的 **external node** 注册进生产 gateway 的 `nodes.json`，进程仍由金丝雀 checkout 自己 `node start/stop`。得到：单 Web 入口（平台代理 + node 切换）、生产 `stop --stop-nodes` 不误杀金丝雀（只停 manifest 子进程）、数据零迁移（canary-data / node.json / root-secret / federation secret 全保留）。
4. **诚实结论：跨 node 寻址复杂度不会因同 gateway 消失。** federation 是 **node↔node** 数据面（三段地址 / peer allowlist / 共享 token / `local_team_id` 映射），gateway 只是监督器 + 浏览器代理，不参与 agent send 路由。昨日修的 peer team 映射在 A/B/C 三种拓扑下都同样需要。
5. **推荐 C（C1 变体：金丝雀保留独立 hub、自启动）**，一次性代价 = 生产 gateway 重启一次（隐式单节点 → 显式 registry）+ 给生产 node 建一个最小 config 文件（registry 条目强制 `config_path`）。金丝雀**新前端特性**验收仍受「平台 serve 生产 dist」限制，需单独裁定（§8 未决问题）。

## 目录

- §1 背景与现状拓扑（事实基线）
- §2 平台 / node-supervisor 模型（调研面①）
- §3 影响矩阵总表 + 隔离与权限（调研面②）
- §4 寻址：同 gateway 多 node vs 跨 gateway federation（调研面③）
- §5 生命周期：独立 node restart 的可行性（调研面④）
- §6 Web UI 与 env 卫生（调研面⑤⑥）
- §7 迁移成本（调研面⑦）
- §8 选项 A/B/C、推荐、风险、未决问题、迁移步骤草案

---

## §1 背景与现状拓扑（事实基线）

### 1.1 两条版本线（只读查证，2026-11-25）

| | production | canary |
|---|---|---|
| checkout | `D:/Application/APP/Vessel/Vessel`（main） | `D:/Application/APP/Vessel/fleets/canary`（branch `canary`，redblue-dev 线） |
| 平台端口（Web/RPC） | 8642 | 8652 |
| node 端口（federation 数据面） | 8644 | 8654 |
| hub 端口 | 8643（缺省） | 8653 |
| dataDir | `~/.vessel/data`（默认根） | `D:/Application/APP/Vessel/fleets/canary-data` |
| 用户配置 | `~/.vessel/config.yaml` | `fleets/canary-config.yaml`（经 `--user-config`，落 `VESSEL_USER_CONFIG`） |
| node_id | `7181ed6c-5ec2-479e-9400-fcd54b480de5` | `7377657b-dfba-4347-809d-5e88460441e0` |
| 本机 team | `vessel` | `default`（`teams/default` 实查） |
| registry | **隐式单节点**（无 `nodes.json`） | 隐式单节点（canary-data 内无 `nodes.json`） |
| instance | default | canary（`platform-canary.*` 痕迹）；**注意** canary-data 里同时存在 Nov 25 的 `platform-default.*` / `platform.pid` 痕迹——最近一次启动用了 default instance，两族锁文件并存 |
| package.json version | 0.56.1 | 0.56.1（**版本号不区分两线**，pid record 的 version 字段无法用来发现版本漂移） |

进程清点（现状 A）：2 gateway + 2 node + 2 hub = **6 个常驻进程**，两个 Web 入口（8642/8652，浏览器凭据按 origin 隔离、各自登录）。

### 1.2 金丝雀启动配方（现行，`docs/operations/version-isolation-blue-green.md` §2）

```bash
# 在 fleets/canary checkout 内
VESSEL_NO_EXTERNAL_PLUGINS=1 bun run src/cli.ts \
  --user-config D:/Application/APP/Vessel/fleets/canary-config.yaml \
  --data-dir  D:/Application/APP/Vessel/fleets/canary-data \
  gateway start --instance canary --daemon
```

隔离杠杆四件套：`--user-config`（用户层文件整体替换，经 env 继承传播到 node/hub 子进程）、`--data-dir`（数据根）、`--instance`（pid/lock/watchdog/manifest 命名族）、端口错开。另有 `VESSEL_NO_EXTERNAL_PLUGINS=1`（用户插件发现根 `~/.vessel/plugins` 是 homedir 硬编码，此 env 是唯一隔离手段）、`update.auto_check: false`（避免写共享更新缓存）。

### 1.3 `fleets/canary-config.yaml` 关键内容（实查）

- `env_file: fleets/federation.env`（federation 共享 token，node 进程自读，绕开 env 快照链）；
- `provider: dashscope/qwen4-max`（与生产模型配置独立）；
- `permission.auto_approve`: bash/read/write/edit/subscribe/pii_reveal/recall/vessel/web_fetch/agent 共 10 项；`never_auto_approve: [agent.close]`——**金丝雀的宽权限绝不能泄漏到生产 node**；
- `federation.peers`: → `7181ed6c…:vessel` @ `http://127.0.0.1:8644`，`token_env: VESSEL_FED_TOKEN`，`direction: both`，**`local_team_id: default`**（昨日刚修的 peer team 映射：对端 `vessel` → 本机 `default`，见 kanban `62215624` 立卡）；
- `plugins[]`: 显式 opt-in 11 插件（basic-tools / doc-subscription / guardrail-pii / hook-logging / media / recall / redact-secrets / tool-policy / web-tools / model-registry / skills）。

### 1.4 用户动机与本文要回答的问题

现状每次启动金丝雀要起**两个 gateway**；用户希望单 gateway 多 node 后，金丝雀只需 start/restart node、不碰生产。附带期望：昨日跨 gateway federation peer team 映射的复杂度（三段地址 / peer token / team 落点）可能消失。

本文逐面查证（§2–§7），给出影响矩阵与选项（§8）。**先说结论：动机的前半（少一个 gateway、单入口）选项 C 零代码可达；后半（寻址复杂度消失）不成立——federation 复杂度与 gateway 拓扑无关（§4）。**---

## §2 平台 / node-supervisor 模型（调研面①：一个 gateway 能管几个 node？）

**答案：没有数量上限**（registry 是数组，校验只查唯一性不查数量）；G3 只接受 `kind: 'local'`（同机），`remote` 留给 G4。现态生产与金丝雀都跑在**隐式单节点**模式，多 node 机制存在但本机从未启用过。

### 2.1 注册与发现：`nodes.json`

锚点：`src/gateway/node-registry.ts`。

- 路径：`<gatewayDataDir>/nodes.json`（`nodeRegistryPath` L75）。**缺失 = 隐式单节点**：`loadNodeRegistry`（L206）返回 `{kind:'missing'}`，调用方 `synthesizeImplicitNode`（L255）合成一条与 gateway 共用 dataDir/config 的条目，**不写文件**。
- 条目形状（`NodeRegistryEntry` L28）：`node_id / name / kind:'local' / data_dir / config_path? / auto_start`。
- **关键约束：显式 registry 里 `config_path` 是必填**。`parseEntry`（L108）对 `config_path` 无条件调 `requireAbsolutePath`（L135）——缺省/空串直接 `registry_invalid`。类型上的 `?` 只服务于隐式合成条目。**推论：给生产 gateway 加金丝雀条目时，生产 node 自己也必须有一个显式 config 文件**（迁移成本，§7）。
- 唯一性（`assertUnique` L151 / `assertRegistryEntryUnique` L373）：`node_id` / `name` / `data_dir` / `config_path` 四者各自唯一；Windows 路径大小写不敏感比较。
- `gateway nodes add <name> --data-dir <dir> --config <path> [--no-auto-start]`（`src/cli/args.ts` L2253）：add 前校验 config 可读可解析、`node.json` 身份一致（`resolveNodeIdForRegistryAdd` L313，**绝不写数据目录**）、dataDir 与 config 解析一致（`assertNodeDataDirMatches` L356）、端口不冲突。`--no-auto-start` 即 external node 开关。
- 身份权威：`<data_dir>/node.json`（`host.node_id` 显式配置优先）。金丝雀 `node.json` 已存在（`7377657b…`）⇒ add 的身份前置条件满足。

### 2.2 锁 / pid / manifest 命名族（实查 canary-data）

| 文件 | 语义 |
|---|---|
| `platform-<instance>.lock` / `platform.pid` | 平台进程锁 / pid 记录（`gateway-default.lock` 是 node 族） |
| `gateway.pid`（node dataDir 内） | node 进程 pid + host/port/version/node_id；supervisor adopt 与 `preferLiveNodeListen` 的依据 |
| `platform-children[-<instance>].json` | **本平台 spawn 的子进程 manifest**（node + hub）；`node stop` 的「是否托管」判定、`stop --stop-nodes` 的终止范围都只认它 |
| `platform-watchdog[-<instance>].json` | 看门狗快照（每 node 一条相位） |
| `hub.lock`（hub dataDir 内） | hub 进程锁 |

instance 只影响**命名族**，不影响数据隔离；数据隔离的根治杠杆是 dataDir（blue-green 文档 R3）。canary-data 里 canary/default 两族并存是历史启动方式不一致的痕迹，迁移时应顺手清理（§7）。

### 2.3 NodeSupervisor：spawn / adopt / external 三态

锚点：`src/gateway/node-supervisor.ts`、组合根 `src/cli/commands/gateway/gateway-command.ts` `resolveLocalNodes`（L2549）。

- **每 node 独立解析**：显式条目用 `loadConfig({configPath, env:{...env, VESSEL_DATA_DIR: entry.data_dir}})` 加载**该 node 自己的 config**（project 层），独立校验、独立 token（`effectiveNodeToken`：显式 `node.token*` > 派生 `vessel:node:<id>`，root-secret 在该 node 的 dataDir）、独立端口；端口冲突（与平台 / hub 缺省口 / 其它 node）fail-fast。**单 node 失败只标 `failed`，不回滚平台、不牵连其它 node**（`begin` L953 注释）。
- **phase A `claim`**（L995）：dataDir 里已有活进程 → **adopt 候选**（不重复 spawn、不杀）；`gateway.pid` 属于别的 node_id → `node_identity_mismatch` 标 failed；否则 spawn。
- **`auto_start: false` ⇒ external**（`begin` L963–982）：不 spawn、不管生命周期；只读一次 pid 文件区分「已经在跑」与「缺席」，缺席时状态里给出可复制的启动命令（`vessel node start --daemon --config <path>`）。**external node 不进 manifest、不进看门狗。**
- **spawn 的 entry 是 gateway 自己的**（`spawnOnly` L1293）：`execPath = process.execPath`、`entryPath = process.argv[1]`，argv = `node start [--config <path>]`（`buildDaemonArgv`，`src/gateway/daemon.ts` L128）。**registry / LocalNodeSpec 没有任何 per-node checkout / entry 覆盖字段**——这是选项 B 的版本隔离死穴（§3.2）。
- **spawn env**（L1336–1348）：`{...gateway进程env快照, VESSEL_DATA_DIR: spec.dataDir, VESSEL_NODE_TOKEN: <生效token>, VESSEL_PLATFORM_ORIGINS: ...}`——**全量继承 + 三个注入键**，没有 per-node env allowlist / 追加字段（§6.2）。
- 运行期崩溃只标 failed 不自动重启（G3）；**看门狗**（0.58，`src/gateway/watchdog.ts` `NodeWatchdog` L260）按 node 独立探活 `/health`，连续失败达阈值 → 强杀 + 用**同一份 entry/env 快照**重 spawn，每小时上限 + 指数退避。
- **平台代理**：`packages/serve/src/platform/registry.ts` `createPlatformRegistry`（L91）对全部条目做 ≤1s `/health` 探测投影（`platform.nodes.list`）；数据面代理 `<platform>/nodes/<node_id>/…`（HTTP + WS 桥，`proxy.ts` / `proxy-ws.ts`），浏览器凭据 = 平台会话 cookie，node token 由 `platform.nodes.credentials` 下发（平台按各 node dataDir 现算）。**external node 同样有 descriptor ⇒ 同样可代理、可切换**——代理不关心进程是谁起的。

### 2.4 平台 RPC 面（实查 grep）

平台只读 allowlist：`platform.whoami` / `platform.nodes.list` / `platform.nodes.get` / `platform.nodes.credentials`。**没有 `platform.nodes.start/stop/restart`**。node 生命周期操作全部在 CLI 本机侧（§5）。

### 2.5 hub 的归属

gateway 自动拉起**一个**本地 hub（0.50，`beginHub` L1154；dataDir = `hub.dataDir` 或 `<gatewayDataDir>/hub`）。hub 是**独立进程 + 独立 dataDir**，node 经 `hub join` 与之建立出站连接（`<nodeDataDir>/hub-node.json` 存 join 结果）。**hub 不是 per-node 实体**：单 gateway 下金丝雀 node 要么继续连自己的旧 hub（需有人起它），要么 join 生产 hub（§8 C1/C2 变体）。---

## §3 影响矩阵总表 + 隔离与权限（调研面②）

### 3.1 影响矩阵（A=双 gateway 现状；B=单 gateway 托管多 node；C=单 gateway + external 金丝雀 node）

| 维度 | A 维持双 gateway | B 单 gateway 多 node（托管） | C 混合（external node） |
|---|---|---|---|
| **数据隔离** | ✅ dataDir 全分离 | ✅ registry 强制 per-node dataDir（唯一性校验） | ✅ 同 B，canary-data 原样保留 |
| **代码版本隔离** | ✅ 各 checkout 各起各的 | ❌ **spawn 用 gateway entry ⇒ 金丝雀 node 跑生产代码**；需 per-node entry 支持（代码改动） | ✅ 进程由金丝雀 checkout 自起；gateway 只探测/代理 |
| **config 分层** | ✅ `--user-config` 整体替换用户层 | ⚠️ node config 只是 **project 层**；用户层仍是生产 `~/.vessel/config.yaml`，env 层压过 node config（§3.3） | ✅ 进程侧与 A 完全一致；gateway 侧解析有轻微双源差异（§3.4，不影响凭据） |
| **权限写回隔离** | ✅ 写 canary-config.yaml | ❌ `permission always`/插件配置/peer add 写 `getUserConfigPath()`=生产用户配置（§3.3） | ✅ 同 A |
| **寻址（agent send）** | 三段地址 + federation peer | **不变**：federation 是 node↔node，gateway 不参与（§4） | **不变** |
| **生命周期** | 金丝雀整舰队自治 | ❌ 托管 node 无独立 restart：`node stop` 拒绝、无平台 RPC；只有看门狗自动重启（§5） | ✅ `node start/stop` 不受托管判定（不在 manifest）；生产 `stop --stop-nodes` 不误杀 |
| **Web UI** | 两个 origin、两次登录 | ✅ 单入口 + node 切换（平台模式现成）；❌ 前端 = 生产 dist | ✅ 单入口 + 切换；⚠️ 前端 = 生产 dist（新前端特性验收受限，§6.1） |
| **env 卫生** | 各舰队启动快照独立 | ❌ gateway env 快照全量灌给所有 node；无 per-node env（§6.2） | ✅ 金丝雀 env 由自己的启动命令控制，与 A 同 |
| **hub** | 各舰队各 hub | ⚠️ gateway 只自动起一个 hub；金丝雀 hub 需自起或 join 生产 hub | 同 B（C1 自起 / C2 join 生产 hub） |
| **迁移成本** | 0 | 高：生产 registry 化 + 代码改动（entry/env/restart）+ 金丝雀重启换代码 | 低：生产 registry 化（一次性重启）+ add 两条目；数据零迁移（§7） |
| **代码改动量** | 0 | **大**（per-node entry/env/user-config + restart RPC，均无现成杠杆） | **0** |

### 3.2 版本隔离：B 的死穴（证据链）

1. `spawnOnly`（node-supervisor.ts L1298–1312）：`entryPath = this.options.entryPath ?? process.argv[1]`；组合根没有传 per-node entry 的通路，`LocalNodeSpec`（L69）无此字段。
2. `buildDaemonArgv`（daemon.ts L128）只接受 `execPath/entryPath/command/configPath/port/host/instance`——**config 能 per-node，代码不能**。
3. 看门狗 stall-restart 与 `gateway restart` 后的重新 spawn 走同一份 entry ⇒ 即使 adopt 了正在跑的金丝雀代码进程，**一次崩溃/重启就静默换成生产代码**。两线 package.json 同为 0.56.1，pid record 的 version 字段**看不出漂移**。
4. blue-green 文档 R1/R3 同源警示：跨版本 adopt 无版本闸。B 把「无版本闸的 adopt」从池扩大到 node 本体。

**结论：B 不满足金丝雀的定义（测新代码）。** 要让 B 成立必须新增 per-node entry/checkout 字段 + spawn/看门狗/restart 全链路接线——是新特性立项，不是配置调整。

### 3.3 config 分层与权限写回：共享用户层是隐蔽击穿面

`loadConfig`（packages/config/src/loader.ts L585–709）层序：

```
default → user（VESSEL_USER_CONFIG 或 ~/.vessel/config.yaml）
        → project（--config / nodes.json 的 config_path）
        → env_file → env（VESSEL_* 环境变量）→ CLI
```

两个方向都要看：

- **读方向**：node config（project 层）能压过用户层，但**压不过 env 层**。B 下 gateway env 快照里的任何 `VESSEL_*` 配置键都会灌进金丝雀 node 并**压过 canary-config**（spawnOnly 全量继承，§6.2）。金丝雀没写的键则回落到**生产用户层**值。
- **写方向（更危险）**：一批运行时写回路径锚定 `getUserConfigPath()`（**用户层**，不是 node config）：
  - 权限「always」：`src/data/permission-store.ts` `resolveConfigPath`（L65）→ `addAutoApproveRule`（L249）；
  - federation peer add/remove：`src/cli/commands/federation-peer.ts`（`readUserConfigRoot`/`writeUserConfigRoot`）；
  - 插件配置 / model-registry / UI 设置：`src/plugin/plugin-config.ts`、`plugins/provider/model-registry/src/registry-store.ts`、`src/config/ui-settings.ts` 同走 user-config root。

  A/C 下金丝雀进程带 `VESSEL_USER_CONFIG=canary-config.yaml` ⇒ 写回落在金丝雀自己的文件。**B 下 spawn env 不含 per-node `VESSEL_USER_CONFIG`**（registry 无此字段、spawnOnly 不注入）⇒ 金丝雀 agent 一次「always」就把 bash 免确认写进**生产** `~/.vessel/config.yaml`，生产 node 下次重启即继承——正是任务书红线「金丝雀 auto-approve 绝不能泄漏到生产 node」的击穿路径。federation-setup.md §5.3 已明文警示两舰队必须各有用户配置，否则 peer 互相覆盖。

### 3.4 C 的已知小差异：gateway 侧解析 ≠ node 侧解析

C 下生产 gateway 为探测/代理凭据会加载金丝雀条目：`loadConfig({configPath: canary-config.yaml, env: 生产gateway env + VESSEL_DATA_DIR})`——即「生产用户层 + 金丝雀 project 层」；而金丝雀 node 进程自己是「金丝雀用户层（--user-config）」。两者对 **canary-config 里写明的键**（node.port / provider / permission / federation / data_dir）取值一致；对**没写的键**可能不同。影响面核查：

- 代理凭据：token = 显式 `node.token*` 或从 **canary-data/root-secret** 派生 ⇒ 与 node 自算必然一致（0.56 设计目标，gateway-command.ts L2639 注释）；
- 探活端口：`node.port` 在 canary-config 里 ⇒ 一致；`preferLiveNodeListen`（L2668）还会优先采信活进程自报地址。

⇒ **凭据/代理不受双源差异影响**；差异只可能出现在状态展示的边角键。纪律：canary-config 保持「金丝雀生效配置的完整声明」，不依赖生产用户层补键。---

## §4 寻址：同 gateway 多 node vs 跨 gateway federation（调研面③）

### 4.1 「本机」的判定单位是 node 进程，不是 gateway

锚点：`src/federation/federation-address.ts`。

- 地址段数定义语义（DECISION-037 §2）：1 段 = 本机 agent；2 段 `p@team` = **恒本机**；3 段 `p@node:team` = node 段命中本机别名才算本机，否则 `remote` 透传 federation。
- `resolveAddress`（L169）是「是不是本机」的**唯一判断点**；`isLocalNodeSegment`（L254）只比较**本 node 进程**的 canonical nodeId 与展示名（大小写不敏感）。每个 node 进程有自己的 `node.json` 身份——**gateway 的身份不进入这个判定**。
- `team-service.ts` `sendAddress`（L1017）：`federation.resolve(to)` → 非 remote 走 `deliverLocalAddress`（本 node 内投递）；remote 走 `federation.send`（HTTP POST 对端 **node 端口** `/v1/federation/messages`，`federation-client.ts`）。

**推论：生产 node 与金丝雀 node 即使挂在同一个 gateway 下，互相 send 仍然是 3 段地址 + federation 出站**——与今天跨 gateway 时逐字节相同。gateway（平台层）不在 agent send 的数据路径上：它只做浏览器代理与进程监督。

### 4.2 昨日修的复杂度属于 team 命名，不属于 gateway 拓扑

现状 canary-config 的 peer：`node_id: 7181ed6c…, team_id: vessel, local_team_id: default`。入站 allowlist 按 **nodeId + teamId + direction** 匹配（`findOutboundPeer`，federation-client.ts L152），`localTeamId` 把对端 team 映射到本机 team（缺省同名）。这套机制的触发条件是「两侧 team 不同名」，与两个 node 是否同 gateway **无关**：

- A/B/C 三种拓扑下，peer 条目、共享 token（`VESSEL_FED_TOKEN` / `token_secret`）、三段地址、`local_team_id` 映射**一个都少不了**；
- 若两侧 team 统一命名（都叫 `vessel`），`local_team_id` 可省——这是**命名决策**，不是拓扑收益（§8 未决问题）。

### 4.3 同 gateway 能简化什么（诚实清单）

| 项 | 是否因同 gateway 简化 |
|---|---|
| 三段地址 / peer allowlist / 共享 token / team 映射 | ❌ 不变（node↔node 数据面） |
| peer URL | ❌ 本来就是回环 `127.0.0.1:8644/8654`（同机），拓扑无关 |
| 自动配对（`federation join`，q-fed-simple） | ❌ 回环免码 join 今天已跨 gateway 可用；与拓扑无关 |
| `federation discover`（读本地 hub registry.json） | ⚠️ **仅当两 node join 同一个 hub**（C2）时，一份 registry 同时列两 node，发现略顺；C1/A 下各读各的 hub，与今天同 |
| 浏览器跨 node 操作（roster/teams/attention） | ✅ 单 origin 平台代理 + `platform.nodes.credentials` 按 node 下发凭据，免二次登录（这是 **UI 面**收益，不是 agent send 面） |
| CLI targeting | ✅ `--connect http://127.0.0.1:8642 --node <canary-id>` 一个入口管两 node（`cli-node-targeting.md`）；但**写回类管理命令仍须带金丝雀 `--user-config`**（§3.3 写方向） |

**结论：任务书期望的「跨 gateway 寻址复杂度消失」不成立。同 gateway 的真实收益集中在 UI/CLI 入口与进程编排，不在 federation。**---

## §5 生命周期：独立 node restart 的可行性（调研面④）

### 5.1 现态命令面盘点（实查）

| 操作 | 托管 node（auto_start:true，在 manifest） | external node（auto_start:false，不在 manifest） |
|---|---|---|
| `node start --daemon --config <path>` | 可以独立起（gateway 下次 start 会 adopt） | ✅ 正常通道 |
| `node stop` | ❌ **拒绝**：`nodeStopCommand`（node-command.ts L269）两道确定性判定——pid record 指向 platform 监听（L296），或 `isManagedByPlatform`（children manifest 含该 node，L301）→ 报 `node.managedByGateway` 退出 1 | ✅ 正常停：先 `gateway.shutdown` 请进程内 drain（写 resume 标记 + interrupt('shutdown')），等自死 ≤10s，超时回退强杀（L306–360） |
| `node reload` | ✅ config scope 热应用（不重启） | ✅ 同 |
| 平台 RPC 单 node restart | ❌ **不存在**（平台只有 nodes.list/get/credentials，§2.4） | ❌ 不存在 |
| 看门狗自动重启 | ✅ 僵死探活失败 → 强杀 + 重 spawn（同一份 entry/env 快照） | ❌ external 不进看门狗 |
| `gateway stop`（缺省） | 平台层停，node/hub **保活**（handoff marker，下次 adopt） | 同（本来就不归它管） |
| `gateway stop --stop-nodes` / `vessel stop` | 连 **manifest 内** spawn/接管且归属可复核的 node/hub 一起停（`stopSpawnedChildren`） | ✅ **不受波及**：只认 manifest，external 不在其中 |
| `gateway restart`（缺省） | 新平台 adopt 旧 node，**env/代码完全不刷新**（federation-setup.md §3.1 第 3 环） | 同 |

**没有 `node restart` 子命令**（node-command.ts `runNodeCommand` L460：start/status/stop/reload/token）；「restart node」现态 = stop + start 两条命令，或看门狗代劳。

### 5.2 drain 超时坑（任务书点名）

- `node stop` 的优雅窗口：`shutdownGateway` 请求超时 3s + 等自死 10s，超时**回退强杀**并打 `node.drain.skipped reason=timeout`——在跑 run 的 resume 标记可能一条都写不出（Windows 外部 kill 是无条件终止）。`src/node/node-drain.ts` `createNodeDrainer` 负责进程内 settle。
- 这个坑**与拓扑无关**：A/C 下金丝雀自己 stop 自己的 node 走同一条路径；B 下托管 node 连这条路径都没有（被 managed 判定拒绝），只能整舰队 `--stop-nodes` 或等看门狗。**B 反而把「独立 restart」变成不可能。**
- 缓解（现有杠杆）：restart 前先 `node reload` 能热应用的 scope；drain 超时阈值目前硬编码（3s/10s），无 config 键——若金丝雀 run 普遍长，可另立「drain 预算可配」小项（与本调研解耦）。

### 5.3 三拓扑下的「金丝雀日常重启」动作对比

- **A（现状）**：`vessel --user-config canary-config.yaml --data-dir canary-data gateway restart --instance canary --stop-nodes`——整舰队冷重启（gateway+node+hub 三个进程），生产无感。
- **B（托管）**：无单 node 通道。要么 `gateway stop --stop-nodes`（**连生产 node 一起停**，违背动机），要么等看门狗（不可主动触发）。**动机落空。**
- **C（external）**：
  ```bash
  # 在 fleets/canary checkout 内（与启动同一套上下文）
  vessel --user-config …/canary-config.yaml --data-dir …/canary-data node stop
  vessel --user-config …/canary-config.yaml --data-dir …/canary-data node start --daemon --config …/canary-config.yaml
  ```
  只动金丝雀 node 一个进程；生产 gateway 的 `platform.nodes.list` 投影里它 down→up，浏览器切换不受影响（代理按 descriptor 转发，node 缺席只报 down）。**动机达成，且比 A 少动 gateway+hub 两个进程。**
  注意：`node start --config` 把 canary-config 当 **project 层**，与 `--user-config` 同文件双挂时层序幂等（同键同值）；保持与现行启动配方同一套 flag 即可，不要发明新组合。

### 5.4 adopt 语义的安全性（C 的关键保障）

生产 gateway `begin()` 对 external 条目**只读 pid 文件、不 spawn、不杀**（node-supervisor.ts L963–982）；`claim()` 对活进程只 adopt 不重复 spawn（L995）。⇒ 生产 gateway 重启/崩溃/看门狗动作都**不会**把金丝雀进程收编或重 spawn 成生产代码。唯一危险动作是人为把条目改成 `auto_start:true`（§8 风险 R6）。---

## §6 Web UI 与 env 卫生（调研面⑤⑥）

### 6.1 Web UI：多 node 展示/切换现成，但前端版本是生产 dist

**现成能力（平台模式，0.49 G3c 起）**：

- `platform.nodes.list` 是平台模式**唯一节点来源**（`apps/web/src/gateway/NodeProvider.tsx` L105–125：不合并手填节点）；
- 选择顺序：持久化 node_id（sessionStorage `vessel.node-selection`）→ 第一个 up → 第一个节点（`node-selection.ts` `resolvePlatformNodeSelection` L68）；用户显式切换不做二次猜测；
- 展示名：`useNodeNames`（`apps/web/src/domains/nodes/useNodeNames.ts` L53）优先 `health.get.node.name`，按 nodeKey 缓存 sessionStorage，健康短暂失败不回退 UUID；
- 数据面：当前 node 走活连接（平台代理 `<origin>/nodes/<id>`，cookie 鉴权）；跨 node roster/teams/attention 按 node_id 取 `platform.nodes.credentials` 下发的凭据（NodeProvider L138–151 注释：代理模式下浏览器没有 node token，直连 api_url 必然 401）；
- token 按 node_id 分槽 sessionStorage（`nodes.ts` `nodeTokenIdentity` L60），改名不丢。

⇒ **C 落地后浏览器只开 8642 一个入口**，节点列表里 production / soulkiller-canary 并列、点击切换，一次登录。这是用户动机的真实收益面。

**限制（必须向用户明示）**：

1. **前端代码 = 平台所在 checkout 的 dist**。拆分模式 node 不宿 WebUI（`packages/serve/src/gateway.ts` L4205 注释「拆分模式 node 不宿 WebUI（staticDir 置空）」）；8654 只有 RPC/WS，没有页面。单 gateway 后金丝雀 node 的页面由**生产前端**渲染 ⇒ **金丝雀的新前端特性无法经此入口验收**；生产前端 × 金丝雀后端还可能有能力位/timeline 协议差异（blue-green R9：旧前端缓存对新后端假报 timeline 缺口——反向同理）。
2. 缓解选项（§8 未决）：a) 保留 8652 作**纯 UI gateway**（只起平台层、node 指向 external 金丝雀——但隐式单节点模式下平台会自起 node，需 registry 化，等于金丝雀侧也做 C，复杂度回升）；b) `apps/web` dev server（vite）代理到金丝雀 node/平台做前端验收；c) 接受「金丝雀只验后端/agent 运行时」，前端特性走生产发布前的常规流程。**调研倾向 b/c：金丝雀日常（agent/工具/federation 修复）几乎全是后端面。**
3. 平台会话是单用户（auth 0.56）：两 node 共享同一登录会话，**没有 per-node 的 UI 权限差**——金丝雀 node 的宽 auto_approve 在 UI 上可见可操作，与今天 8652 入口等价，不新增泄漏面（权限本体在 node config，§3.3）。

### 6.2 env 卫生：T2b 教训与三拓扑对比

**T2b 事实**（`docs/dev/reports/q-runtime-fix/investigation.md` issue-1，q-tool-output-leak 在修）：canary 的 data_dir 来自配置文件、host 进程 env 无 `VESSEL_DATA_DIR` ⇒ `toolOutputRoot()` 落到硬编码 `~/.vessel/data/tool-output`，host 与 engine child 双双写进生产根。修法：bootstrap 解析 dataDir 后桥接 `process.env.VESSEL_DATA_DIR`（已提交 `1bce7a64`）。

**env 快照链**（federation-setup.md §3.1，四环）：daemon spawn = 启动那一刻 CLI env 快照 → node 子进程继承**平台**快照（spawnOnly L1337）→ `gateway restart` 缺省保活 node、env 不刷新 → WSL↔Windows env 边界。可靠注入 = node 自读 `env_file`。

三拓扑对比：

| | A | B | C |
|---|---|---|---|
| 金丝雀 node 的 env 来源 | 金丝雀启动 shell 快照（`--user-config`/`VESSEL_NO_EXTERNAL_PLUGINS` 等在此注入） | **生产 gateway 启动快照**全量继承 + 3 个注入键 | 同 A |
| `VESSEL_DATA_DIR` | node bootstrap 桥接（T2b 修后） | spawnOnly 按 spec.dataDir 注入 ✅（B 唯一占优的键） | 同 A |
| `VESSEL_USER_CONFIG` | 金丝雀自己的 ✅ | **缺失** ⇒ 用户层写回击穿（§3.3） | 同 A ✅ |
| ambient `VESSEL_TOOL_OUTPUT_DIR`/`VESSEL_PLUGIN_CONFIG` 等 | 各舰队快照独立，互不灌 | 生产 gateway 快照里若有 ⇒ **灌进金丝雀并压过其 config**（env 层 > project 层）；反向金丝雀 shell 的变量也进不了生产 gateway（它先启动） | 同 A |
| `VESSEL_NO_EXTERNAL_PLUGINS` | 金丝雀启动时设 ✅ | 取决于生产 gateway 启动时有没有设——**生产通常不设** ⇒ 金丝雀 node 会加载 `~/.vessel/plugins` 外部插件（R5 击穿） | 同 A ✅ |

**结论：B 的 env 模型是「一份快照灌所有 node」，与金丝雀隔离需求结构性冲突；C 保持「各 node 各快照」，T2b 类修复（node 内桥接 dataDir）在 C 下与 A 同样生效。** 若将来真要做 B，per-node env allowlist/追加字段是前置代码改动（与 per-node entry 同批立项）。---

## §7 迁移成本（调研面⑦：现 canary-data / 会话 / 团队 / 配对如何迁或弃）

### 7.1 核心结论：C 下数据零迁移

registry 条目只是**指针**（node_id + data_dir + config_path）。金丝雀继续用 `fleets/canary-data` ⇒ 以下全部原样保留、无需搬动：

| 资产 | 位置 | 迁移影响 |
|---|---|---|
| 会话 / runs / events / conversations | `canary-data/{sessions,runs,events,conversations}` | 无 |
| 团队（`default`）/ 成员快照 / inbox | `canary-data/{teams,agents,inbox}` | 无 |
| node 身份 | `canary-data/node.json`（`7377657b…`） | 无 ⇒ **三段地址、对端 peer 条目全部继续有效** |
| root-secret / 派生 node token | `canary-data/root-secret` | 无 ⇒ 平台代理解析出的凭据与 node 自算一致 |
| federation 配对 | canary-config `federation.peers` + `canary-data/federation-pair.json` + SecretStore（`token_secret` 时） | 无（peer 指向生产 node 端口 8644，不变） |
| hub join 状态 | `canary-data/hub-node.json`（指向 8653 canary hub） | C1：无（hub 自起后照旧）；C2：需重新 `hub join` 生产 hub（一条命令，旧状态覆盖写） |
| 工具输出 / 插件数据 | `canary-data/{tool-output,plugins}` | 无（T2b 修后落本根） |

**要弃的只有**：canary gateway 平台层进程及其锁族（`platform-canary.*` / `platform-default.*` / `platform.pid` / `platform-children*.json` / watchdog 快照）。canary-data 里两族 instance 痕迹并存（§1.1），停金丝雀 gateway 后按 `gateway status` 清点清理 stale 条目即可（`cleanupGatewayStateEntry` 语义：stale 才清，running/unknown 不动）。

### 7.2 生产侧的一次性改动（C 的真实成本）

1. **生产 node 显式 config 文件**（registry `config_path` 必填，§2.1）：最小化，只声明 `data_dir: ~/.vessel/data` + `node.port: 8644`（其余键继续从生产用户层继承，与今天隐式模式取值一致）。放哪由用户定（§8 未决：`fleets/production-node.yaml` vs `~/.vessel/node.yaml`——后者在生产根内，按宪法由用户维护）。
   ⚠️ 双源纪律：该文件是 project 层，会压过用户层同名键——**只放 data_dir/node.port，不放业务键**，避免与 `~/.vessel/config.yaml` 形成两处维护。
2. **`nodes.json` 两条目**（生产 gateway dataDir 内）：
   ```bash
   vessel gateway nodes add production --data-dir ~/.vessel/data --config <production-node.yaml>
   vessel gateway nodes add soulkiller-canary --data-dir D:/Application/APP/Vessel/fleets/canary-data \
     --config D:/Application/APP/Vessel/fleets/canary-config.yaml --no-auto-start
   ```
   add 前置条件已满足：两侧 node.json 都在、端口不冲突（8644/8654/8642/8643 互异）、dataDir 与 config 解析一致。
3. **生产 gateway 重启一次**加载 registry（隐式→显式是启动时解析，无热加载）。缺省 `gateway restart` 保活 node ⇒ 生产 node 进程不冷重启、会话不断；平台层重启秒级。**这是唯一一次碰生产的机会窗口**，可与用户已顺延的明日生产重启合并。
4. 金丝雀侧：停 canary gateway（`gateway stop --instance canary`，缺省保活 node/hub）→ 金丝雀 node 以 external 身份继续跑（或按 §5.3 用金丝雀 checkout 的 `node stop/start` 换一遍启动上下文，确保 env 带 `--user-config`）。canary hub 自起（C1）：`hub start --data-dir canary-data/hub`（无看门狗，§8 R5）。

### 7.3 回退

C 的回退 = `vessel gateway nodes remove soulkiller-canary`（最后一条显式条目移除时 `deleteNodeRegistry` 回到隐式单节点）+ 生产 gateway 再重启一次 + 金丝雀按原配方起自己的 gateway。**数据全程未动，回退无单向门**（对比 blue-green §4 的离线迁移警示：本方案不触发任何数据格式迁移）。

### 7.4 B 的迁移成本（对比用）

除 §7.2 全部外，还需：per-node entry/env/user-config 代码改动 + 金丝雀 node 冷重启换生产代码（**金丝雀会话宇宙里的 agent 运行时被换版本**，成员快照 v5 兼容但行为面变）+ 独立 restart RPC 立项。且每次生产 gateway 升级都会同步换掉金丝雀 node 的代码——金丝雀不再能独立 pin 版本。**不建议**（§8）。