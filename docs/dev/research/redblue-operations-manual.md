# 红蓝运维手册（Red-Blue Operations Manual）

> 调研 + 文档产物，不改任何产品代码。分支 `design/q-redblue`，基线 `8694a681`。
> 任务：把「旧版 agent 起新版 → 新版自检回报 → 修复 → 回归 → 入住 → 迭代」闭环落到 vessel 既有原语上。
> 证据标注：**[事实]** = 本仓文档/代码锚点；**[推断]** = 作者判断；**[业界]** = 外部来源（URL 见 §10）。
> 宪法约束（本手册自身与推荐流程都遵守）：零测试 / 零探针 / 零临时验证进程；行为验证由用户本人做，
> 证据只来自只读真实日志 / 数据 / 构建产物。B 行是**候选生产线**（真实数据根、真实工作），不是临时探针。

## 0. 结论先说

（调研完成后填写：推荐方法一句话 + 闭环六步摘要 + 最重要的三条纪律。）

## 1. 范围与术语

| 术语 | 定义 |
|---|---|
| A 行（红） | 旧版生产线：默认根 `~/.vessel`，端口 8642/8644(/8643)，日用干活 |
| B 行（蓝） | 新版候选线：独立 checkout + `--user-config` / `--data-dir` / `--instance` 整体搬出，端口错开（示例 8652/8654/8653） |
| 会话宇宙 | 一个 dataDir 下的全部会话/成员/事件。裁决②：**切换 = 新会话宇宙，不做离线数据迁移** |
| 入住 | 用户把日用入口从 A 行换到 B 行；工作连续性靠 git + handoff 文档 + federation 消息，不靠会话搬运 |
| 回归 | 用户行为验证 + 只读真实读数核对（宪法第四条），不是自动化测试 |
| 迭代 | 入住后 B 成为新 A，下一轮候选线再起；回退 = 入口换回旧 A（零成本） |

裁决基线（2026-11-23，[事实] `docs/operations/version-isolation-blue-green.md` 头部）：
① 不加 profile 新实体，全部用既有杠杆；② 切换 = 新会话宇宙，不做离线迁移；
③ 双行期不跑 `install-service`。本手册不推翻任何一条，只在其上补操作流程。

## 2. 既有原语盘点（本仓事实）

### 2.1 隔离与生命周期

| 原语 | 语义 | 锚点 |
|---|---|---|
| 不对称隔离配方 | A 留默认根；B 用 `--user-config` + `--data-dir` + `engine_pool.instance` + 端口错开整体搬出 | [事实] version-isolation-blue-green.md §1–2 |
| DD 分离 ⇒ token 互不认 | 各线 root-secret 不同，派生 token 跨舰队 401 fail-closed；peer token 是独立命名空间 | [事实] 同上 §1；REMOTE.md §3.5.1 |
| `gateway start` 分段启动 | 平台先 ready；node/hub 后台逐个结算，单节点失败只标它自己 | [事实] gateway-lifecycle.md；GATEWAY.md §1 |
| adopt / handoff marker | 缺省 stop/restart 只停平台层，写保留标记，子进程存活，下次 start adopt | [事实] gateway-lifecycle.md 生命周期表 |
| `--stop-nodes` 真停 | node 先 `gateway.shutdown` drain（写 resume 标记）≤10s，超时强杀；池只 terminate owned | [事实] GATEWAY.md §4 |
| **restart 缺省不换 node 代码** | `gateway restart` 后 node 仍跑旧代码（命令打印提示）；换代码必须 `restart --stop-nodes` | [事实] GATEWAY.md §4 表 + 提示行 |
| graceful-first（Q4-C） | 平台停止也先进程内 `gateway.shutdown`（含池 stop），关闭 Windows owned engine 孤儿缺口 | [事实] GATEWAY.md §4 |
| `vessel stop` 舰队级 | manifest 三元复核（pid + started_at + node_id/hub lock），adopt/external 永不杀 | [事实] gateway-lifecycle.md；GATEWAY.md §4 |
| Windows 句柄继承坑 | 只 taskkill 平台进程会让 detached 子进程继续持有监听 socket；恒用命令整舰队停 | [事实] version-isolation-blue-green.md §3 |

### 2.2 中断恢复（durable resume / node-resume）

| 原语 | 语义 | 锚点 |
|---|---|---|
| RunStore checkpoint | run 开始 / 每轮 tool-call 后 / 结束写 checkpoint；`runs.resume` 接受 `running\|interrupted` | [事实] ADR-040；graceful-restart.md §2 |
| 手动 `vessel resume` | 列 interrupted 再 resume；**启动期不自动续 run** | [事实] graceful-restart.md §2 |
| node-resume 重启卡 | 启动扫 `resume_after_restart` 标记 → 发 restart EnvCard（模型+用户同源）→ FIFO 重放 human 输入 → 卡准入后清标记；去重键 run_id + interrupted_at | [事实] src/node-resume.ts 头注 |
| 三档「无感」 | a 档（热升级）不可达；b 档（续跑）原料在、缺自动串接；c 档（任务重投）已实现 | [事实] graceful-restart.md §1/§3 |
| rotate / sessions.restart | 同进程换 body（epoch+1），startup_prompt 是唯一 handoff 通道；**不是换代码** | [事实] agent 工具语义；graceful-restart.md §2 |

### 2.3 跨节点（federation / hub）

| 原语 | 语义 | 锚点 |
|---|---|---|
| federation 数据面 | node→node 一条消息；地址 `<principal>@<node_id>:<team_id>`；入站落 Team 日志，最多 1 个 run（唯一 present 非 private 成员） | [事实] federation-hub.md §federation |
| peer 配置 | `federation.peers[]` 显式 allowlist；bearer 只从 `tokenEnv` 读；非回环必须 https；回环 http 可 | [事实] federation-hub.md；src/federation-config.ts |
| 失败顺序 fail-closed | enabled → bearer → direction → from=peer → 严格解析 → team 映射 → hop → 自指环 → team 存在 → 去重 → 写日志 | [事实] federation-hub.md §federation-guards |
| 无离线队列/重试/exactly-once | 去重是进程内 LRU 1024；限流缺省 60/min；hop 恒 1 | [事实] federation-hub.md；REMOTE.md §3.3.1 |
| agent send 地址形态 | 跨节点目标不支持 interrupt / notify（0.41） | [事实] packages/agent/src/tool.ts:903 附近 |
| hub 控制面 | 只传目录/指针元数据，不代理正文；join-code/join；同机回环无码自助重 join | [事实] federation-hub.md §pairing/§auto-join |
| 派生白名单 D 定格 | D 在 join / 平台启动那一刻定格，运行期不刷新；新 node 要平台重启才被认识 | [事实] node-auto-join.md §10.3 |
| 不做远程生命周期 | federation 不做远程 spawn / close / rotate / resume / create | [事实] federation-hub.md §不做什么 |

### 2.4 工作区与共享面

| 原语 | 语义 | 锚点 |
|---|---|---|
| write.lock 合作式 | 只有新版 edit/write 持锁；旧版是非合作写入者 ⇒ 同 workspace 双版本并行写不安全（R8） | [事实] version-isolation-blue-green.md §5 R8 |
| 共享 `~/.vessel` 面 | 用户插件发现 / update 缓存 / marketplace / OS 服务不随 UC/DD 移动；`VESSEL_NO_EXTERNAL_PLUGINS=1` + 双行期纪律 | [事实] 同上 §1/§5 R4–R6 |
| 数据格式单向门 | 成员快照 v4→v5 首写清旧字段（留 `.v4.bak`）；0.55+ 不认旧格式会话 | [事实] 同上 §4 |
| `vessel migrate` | 只做 sqlite/file-v1→file-v2 存储格式迁移，默认 dry-run；不是跨版本会话迁移 | [事实] MIGRATION.md §1–2 |

## 3. 业界方法调研

（web_search 后填写：蓝绿 / 金丝雀 / 特性开关 / 数据库迁移 / 双版本并行与回滚，逐条给来源与可抄点。）

## 4. 映射：业界方法 → vessel 原语

（填写：已具备 / 缺口 / 替代做法 三列映射表。）

## 5. 缺口分析

（填写：区分「可补缺口」与「裁决边界（不补，绕行）」，每条给缓解。）

## 6. 推荐方法 + 操作步骤（闭环 playbook）

（填写：6.0 前置纪律；6.1 旧版 agent 起新版；6.2 新版自检回报；6.3 修复；6.4 回归；6.5 入住；6.6 迭代与回退。）

## 7. 跨节点场景

（填写：多机 handoff、federation 回报、hub join、会话宇宙切换的跨机形态。）

## 8. 风险登记

（填写：继承配方 R1–R10 + 闭环新增风险。）

## 9. 未证 / 待实测

（填写。）

## 10. 参考

（填写：本仓文档锚点 + 业界 URL。）