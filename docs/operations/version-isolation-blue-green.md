---
title: 两版本并行（红蓝双行）隔离配方
kind: current
triggers: [双行, 红蓝, 版本隔离, 并行版本, blue-green, user-config, data-dir, instance, engine_pool, 舰队, 切换, 回退, 候选线, 生产线]
paths: [src/cli/args.ts, packages/config/src/loader.ts, src/cli/commands/gateway/gateway-command.ts, src/gateway/pool-supervisor.ts]
---

# 两版本并行（红蓝双行）隔离配方

> 用户裁决（2026-11-23）：① 不加 profile 新实体（全部用既有杠杆）；② 切换 = 新会话宇宙，
> 不做离线数据迁移；③ VesselGateway OS 服务本机未装、无需动作，**双行期不跑 install-service**。
> 场景：A 行（红，旧版）日用干活，B 行（蓝，新版）测试；验证通过后切换、可回退。
> 适用版本：B 行需 0.56 dev 线（`--user-config` 系 `331afe1f` 新增）；A 行 = 0.54.0 基线
> （`c31dba42` / `a229255d`）——该线无 `--user-config`、无 engine 子进程/池、无 write 工具与 write.lock。
> 两 checkout 各自 `bun install`（apps/web 另需 `bun install --cwd apps/web`），不得 junction 共享 node_modules。

## 1. 不对称配方：A 行留默认根，B 行整体搬出

A 行保留默认根不动：`~/.vessel/config.yaml` + `~/.vessel/data` + 端口 8642/8644（/8643）。
B 行用既有杠杆整体搬出：

| 杠杆 | 作用 | 边界 |
|---|---|---|
| `--user-config <path>` | 整体替换用户层配置文件（落 `VESSEL_USER_CONFIG`，daemon/node/hub 子进程经 env 继承一致生效）；显式给了必须存在，否则报错 | **只替换文件路径，不移动 `~/.vessel` 目录**：poolDir / 用户插件发现 / update 缓存不受影响（`loader.ts` getUserConfigPath vs getUserConfigDir） |
| `--data-dir <path>` | 数据根（sessions/runs/events/锁/pid/日志/hub 状态）；flag 最高优先级 | config `data_dir` / env / flag 三层；仅设 env 会被用户配置压过，flag 无此问题 |
| `gateway.engine_pool.instance` | poolDir = `~/.vessel/engine-pool[-<instance>]` | **唯一池隔离杠杆**；poolDir 不随 `--data-dir` / `--user-config` 移动（代码注释明说） |
| 端口 config | `gateway.port` / `node.port` / `hub.listen.port` 显式错开 | 缺省 8642/8644/8643；两行同端口 = bind fail-fast（可见，不静默） |

DD 分离 ⇒ 各线 `<dataDir>/root-secret` 不同 ⇒ 派生 token 互不认，跨舰队连接 401 fail-closed。
**舰队 yaml 不放任何密钥**：自定义配置路径不在内置 denylist（只覆盖 `~/.vessel/config.yaml`），
read/bash 读得到；token 留给各线自己的 root-secret 派生。

## 2. B 行配置与启动

`D:/Application/APP/Vessel/fleets/blue/config.yaml`（必须存在，空 `{}` 也合法）：

```yaml
data_dir: D:/Application/APP/Vessel/fleets/blue/data
gateway:
  port: 8652
  engine_pool:        # 仅在需要测池时开；双开关同开，size>=2
    instance: blue    # 必须：poolDir 不随 data_dir 移动
    size: 2
node:
  port: 8654
tools_engine:
  mode: pool          # 仅与上面 engine_pool 同开；缺省 child
hub:
  listen:
    port: 8653        # 仅在本行要 hub 时错开；auto_start 缺省 true
update:
  auto_check: false   # 避免写共享 ~/.vessel/update-check.json
```

启动（B checkout 内）：

```bash
VESSEL_NO_EXTERNAL_PLUGINS=1 bun run src/cli.ts \
  --user-config D:/Application/APP/Vessel/fleets/blue/config.yaml \
  --data-dir  D:/Application/APP/Vessel/fleets/blue/data \
  gateway start --instance blue --daemon
```

- `--instance blue` 是 DD 分离之上的双保险（pid/lock/watchdog/children manifest 命名族）；端口已在 config。
- `VESSEL_NO_EXTERNAL_PLUGINS=1`：用户插件发现根 `~/.vessel/plugins` 是 homedir 硬编码，此 env 是唯一隔离手段；
  经 daemon env 继承传播到 node/hub 子进程。池 engine 子进程 env 是 allowlist（dirs 经 auth 帧下发），
  插件加载发生在 host 进程，故该 env 在 gateway/node 层生效即可。
- 临时端口：`gateway start --instance blue --port 0`（`--port 0` 必须配 `--instance`），再用 status 查实际端口。
- A 行照旧：`vessel gateway start --daemon`（或既有常驻不动）。

入口对照：

| 入口 | A 行（旧） | B 行（新） |
|---|---|---|
| 浏览器 | http://127.0.0.1:8642 | http://127.0.0.1:8652 |
| CLI 只读命令 | 缺省（默认根） | 带同样 `--user-config`/`--data-dir`，或 `--connect http://127.0.0.1:8652` + connect token |
| TUI 本地跑 | 缺省根 | `bun run src/cli.ts --user-config <blue.yaml> --data-dir <blue-data>`（本地 runtime 同样吃 UC/DD） |

浏览器凭据按 origin 天然隔离（token 只进 sessionStorage），切换需各自重新登录。

## 3. 停止：缺省只停平台层，--stop-nodes 才整舰队真停

- `gateway stop --instance blue`（**缺省**）：**只停平台层**。node/hub/池 engine 全保留——
  停止方先写 handoff marker，平台退出消费 marker 后保留子进程，下一次 start adopt 回来。
- `gateway stop --instance blue --stop-nodes`（`--no-keep-nodes` 别名）：整舰队真停——
  node 先经 `gateway.shutdown` drain（写 resume 标记）、超时回退强杀；hub 停；
  池只 terminate **owned** engine（adopt/external 永不杀）。
- **不要只 taskkill platform 进程**：Windows 句柄继承会让 detached 子进程继续持有监听 socket，
  新 gateway bind 不上。恒用命令整舰队停。
- 停后若仍有 detached engine 残留（crash 残留 / adopted external），按
  `~/.vessel/engine-pool-blue/engines/*.json` 的 pid 手工清理。

## 4. 切换与回退

- **切换 = 换入口**（裁决②）：浏览器/CLI 改指 B 行；A 行可停可留。**数据不迁移**：
  B 行是全新会话宇宙，旧会话不在 B 行出现。升级后**刷新浏览器页面**
  （旧前端缓存对新后端会假报 timeline 缺口）。
- **回退 = 入口换回 A 行**：A 根/配置/端口未被触碰，零成本。
- 离线迁移是**单向门**（裁决②不做，只作警示）：成员快照 v4→v5 首写一次性清旧 model 字段
  （留 `.v4.bak`，备份失败放弃写入），旧二进制不认 v5；0.55+ 不支持旧格式会话
  （`legacy_session_unsupported`，用 0.54 导出）。若将来要迁移：停两行 → 整根备份 → 复制；
  回退顺序 = 停进程 → 恢复 `.v4.bak` → 回退二进制，不能反。

## 5. 风险与纪律

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 跨版本池 adopt **无版本闸**（状态文件 version 字段只做形状校验、从不比较）：同 poolDir 时新 gateway 静默收编旧 engine | 每舰队 `engine_pool.instance`；停后按 state pid 清孤儿 |
| R2 | 端口冲突 | 显式错开；bind fail-fast 可见 |
| R3 | 共享 dataDir ⇒ watchdog/supervisor 跨版本 adopt/stall-restart/stop 互扰 | DD 分离（根治） |
| R4 | OS 服务拉错版本：任务名 `VesselGateway` 冻结，命令 `vessel gateway start` 按 PATH 解析、无版本 pin、无根 flag | 本机未装 = 无需动作；**双行期不跑 install-service**；装过先卸载 |
| R5 | 外部插件共享 + marketplace install **写 `~/.vessel/config.yaml`** 波及生产线 | `VESSEL_NO_EXTERNAL_PLUGINS=1`；双行期不跑 marketplace install |
| R6 | 更新缓存/staging 共享（`~/.vessel/update-check.json` / `updates/`） | B 行 `update.auto_check: false`；双行期不跑更新 apply |
| R7 | 数据格式单向门 | 不共享 dataDir；见 §4 |
| R8 | **同 workspace 双版本并行写 = 不安全**：write.lock 是合作式协议，只有新版 edit/write 持锁；0.54 无 write 工具、无锁 = 非合作写入者，可静默覆盖新版正在编辑的文件；expected_content 只能事后检出（报错不写），不能阻止旧版写入 | **B 行用独立 worktree/workspace**；必须共享时：A 行对该 workspace 只读，或人工文件分区 + B 行恒带 expected_content |
| R9 | 浏览器旧前端缓存假报缺口 | 刷新页面；每舰队 serve 自己 checkout 的 dist，不共享 `VESSEL_STATIC_DIR` |
| R10 | 舰队 yaml 可被工具读（自定义路径不在 denylist） | 密钥不进 yaml（§1） |

## 6. 指针

- 生命周期职责：[architecture/gateway-lifecycle.md](../architecture/gateway-lifecycle.md)；stop/drain 契约：[architecture/gateway-rpc.md](../architecture/gateway-rpc.md) 的 `gateway.shutdown`。
- 池决策：[ADR-106](../adr/ADR-106-engine-pool.md)；工具双路现态：[architecture/tools.md](../architecture/tools.md#engine-exec)。
- Gateway 运维：[GATEWAY.md](GATEWAY.md)；配置层序：[CONFIG.md](CONFIG.md)。
