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

⇒ **凭据/代理不受双源差异影响**；差异只可能出现在状态展示的边角键。纪律：canary-config 保持「金丝雀生效配置的完整声明」，不依赖生产用户层补键。