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

本文逐面查证（§2–§7），给出影响矩阵与选项（§8）。**先说结论：动机的前半（少一个 gateway、单入口）选项 C 零代码可达；后半（寻址复杂度消失）不成立——federation 复杂度与 gateway 拓扑无关（§4）。**