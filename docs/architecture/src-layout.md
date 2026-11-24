---
title: src 领域目录布局（计划 C）
kind: target
triggers: [src, layout, 目录, 归类, 领域, domain, 重组, 搬迁, refactor, plan-c, 文件管理, 新文件, 命名, import 重写, cli, agent, session, run, config, plugin, node, federation, observability, runtime, data, shared]
paths: [src/**, docs/FILE-MANAGEMENT.md, docs/architecture/cli-conventions.md, docs/architecture/assembly.md]
---

# src 领域目录布局（计划 C）

> **状态**：〔提案→执行中〕main 已批准映射与 C1–C5 裁决（§8），阶段2逐域搬迁进行中；全部落地后翻〔现行〕。
> 上位规范：[FILE-MANAGEMENT.md](../FILE-MANAGEMENT.md)（路径归属）；CLI 域布局以
> [cli-conventions.md](cli-conventions.md) §8 为准绳（本文是其向全 src 的推广）。
> 装配层导航见 [assembly.md](assembly.md)；分层边界见 [layering.md](layering.md)。

## 0. 一段话

src 顶层现有 **136 个 .ts 平铺** + 8 个子目录。文件名前缀已形成 31 个隐式领域簇
（plugin-\*×8、session-\*×7、agent-\*×7、gateway-\*×6、cli-\*×6、config-\*×5、node-\*×4、
federation-\*×4 …），但物理上无边界：新文件无处可归、跨切文件与领域文件混排、
import 网全平铺。本方案把 136 个文件按**语义**归入 **14 个领域目录 + 1 个跨切 utilities 目录
+ 4 个既有基础设施目录**，顶层只留 `cli.ts` 一个入口（bin 契约）。
归类不是机械按前缀：`bootstrap`/`*-wiring`/`cli-args` 等跨切文件按「它装配的是哪个领域」安置（§2）。

## 1. 目标目录清单

| # | 目录 | 性质 | 回答的问题 | 文件数（迁后） |
|---|------|------|-----------|------|
| 1 | `src/cli/` | 领域（新，吸收 `src/commands/`） | 命令怎么解析、分派、渲染、退出 | 40（含 commands/ 28） |
| 2 | `src/agent/` | 领域（新） | 成员/团队能力怎么装配（AgentService、owner 端点、投递） | 10 |
| 3 | `src/session/` | 领域（新） | 会话后端、锁、续接、timeline、sessions.get 读数面 | 13 |
| 4 | `src/run/` | 领域（新） | durable run、执行控制、租约、远端终态等待 | 5 |
| 5 | `src/config/` | 领域（新） | 配置覆盖层、监听、热应用、settings 映射 | 11 |
| 6 | `src/plugin/` | 领域（新） | 插件机制（loader/manifest/selection/watch）与插件接线 | 9 |
| 7 | `src/gateway/` | 领域（既有，扩充） | 平台层生命周期、serve 启动/鉴权/关闭、控制面写回 | 21 |
| 8 | `src/hub/` | 领域（既有，扩充） | Hub 控制面与配对 | 18 |
| 9 | `src/node/` | 领域（新） | node 身份、drain/resume、token 派生 | 4 |
| 10 | `src/federation/` | 领域（新） | 跨节点寻址、出站 client、attention 路由 | 6 |
| 11 | `src/tools-engine/` | 领域（既有，扩充） | 工具执行引擎（child/pool）与工具清单 | 9 |
| 12 | `src/observability/` | 领域（新） | 日志、trace、启动计时、用量计价 | 5 |
| 13 | `src/runtime/` | 领域（新） | 核心运行时装配：bootstrap、provider/model、tenant 执行面、通知总线 | 10 |
| 14 | `src/data/` | 领域（新） | data-dir 路径/锁、迁移、留存清理、附件/blob | 10 |
| 15 | `src/shared/` | 跨切 utilities（新，严格准入） | 无领域语义的纯叶子工具 | 2 |
| — | `src/i18n/` | 基础设施（既有，不动） | 文案 catalog | 不变 |
| — | `src/rpc/` | 基础设施（既有，不动） | RPC 客户端/类型 | 不变 |
| — | `src/update/` | 基础设施（既有，不动） | 自更新机制 | 不变 |
| — | `src/mock/` | 基础设施（既有，不动） | VESSEL_MOCK 场景 | 不变 |
| — | `src/cli.ts` | **顶层唯一保留** | bin 入口（package.json bin/start、dev-web entryPath 契约） | 1 |

> `src/commands/` 整体并入 `src/cli/`（registry → `cli/registry.ts`，三个命令 → `cli/commands/<ns>/`），
> 与 cli-conventions §8 一致——**这是对任务书「commands/ 保留」的唯一偏离，列为待 main 确认项 C1**。
> `src/shared/` 只收「两个以上领域共用、且无领域语义」的纯函数叶子（当前仅 version / port-in-use）；
> 禁止把拿不准的文件扔进 shared（§3 规则）。

## 2. 文件 → 目标目录映射表（136 个顶层文件 + src/commands/ 4 个）

命名策略：**纯移动优先**。除 cli-conventions §8 点名的 5 个改名
（cli-args→args、cli-help-spec→help-spec、cli-help→help、ui-style→output、commands/registry→cli/registry）
外，**一律保留原文件名**，只改目录。命令文件保留 `-command` 后缀（目录已表达归属，后缀是历史契约面，
改名收益低、文档 churn 大；后续 q-cli 落地时再议）。

### 2.1 cli/（框架 + 入口模式助手）

| 现路径 | 目标 | 理由 |
|---|---|---|
| src/cli.ts | **src/cli.ts（不动）** | bin/start/dev-web entryPath 契约；入口分发 |
| src/cli-args.ts | src/cli/args.ts | §8 点名；纯解析 |
| src/cli-help-spec.ts | src/cli/help-spec.ts | §8 点名；help 单一数据源 |
| src/cli-help.ts | src/cli/help.ts | §8 点名 |
| src/ui-style.ts | src/cli/output.ts | §8 点名；渲染契约单一实现 |
| src/commands/registry.ts | src/cli/registry.ts | §8 点名；唯一分派接缝 |
| src/completion-spec.ts | src/cli/completion-spec.ts | 补全数据源（help-spec 同族） |
| src/completion-script.ts | src/cli/completion-script.ts | 补全脚本生成器 |
| src/control-plane-target.ts | src/cli/control-plane-target.ts | 控制面 CLI 的 --connect 目标解析，命令共用 |
| src/control-plane-types.ts | src/cli/control-plane-types.ts | 控制面 CLI 结构类型（asm 侧），命令共用 |
| src/headless-runner.ts | src/cli/headless-runner.ts | `--run` 入口模式执行器（与 REPL/serve 并列的入口面） |
| src/ask-channel.ts | src/cli/ask-channel.ts | headless ask 人类通道，只服务 headless 入口 |
| src/feishu-command.ts | src/cli/feishu-command.ts | `--feishu` 入口模式启动与错误分类（非 registry 命令） |

### 2.2 cli/commands/（28 个命令；main C2 裁决：命名空间 ≥2 命令建目录，单命令平铺）

目录命名空间（4 个）：agent/（3）、gateway/（2）、fleet/（2）、plugin/（2）；其余 21 个单命令命名空间平铺。

| 现路径 | 目标 |
|---|---|
| src/agent-command.ts | src/cli/commands/agent/agent-command.ts |
| src/agent-inbox-command.ts | src/cli/commands/agent/agent-inbox-command.ts |
| src/agents-command.ts | src/cli/commands/agent/agents-command.ts |
| src/gateway-command.ts | src/cli/commands/gateway/gateway-command.ts |
| src/gateway-nodes-command.ts | src/cli/commands/gateway/gateway-nodes-command.ts |
| src/stop-command.ts | src/cli/commands/fleet/stop-command.ts |
| src/status-command.ts | src/cli/commands/fleet/status-command.ts |
| src/plugin-command.ts | src/cli/commands/plugin/plugin-command.ts |
| src/plugin-cli-command.ts | src/cli/commands/plugin/plugin-cli-command.ts |
| src/team-command.ts | src/cli/commands/team-command.ts |
| src/node-command.ts | src/cli/commands/node-command.ts |
| src/hub-command.ts | src/cli/commands/hub-command.ts |
| src/config-command.ts | src/cli/commands/config-command.ts |
| src/token-command.ts | src/cli/commands/token-command.ts |
| src/cli-update.ts | src/cli/commands/cli-update.ts |
| src/completion-command.ts | src/cli/commands/completion-command.ts |
| src/dev-command.ts | src/cli/commands/dev-command.ts |
| src/doctor-command.ts | src/cli/commands/doctor-command.ts |
| src/errors-command.ts | src/cli/commands/errors-command.ts |
| src/logs-command.ts | src/cli/commands/logs-command.ts |
| src/trace-command.ts | src/cli/commands/trace-command.ts |
| src/eval-command.ts | src/cli/commands/eval-command.ts |
| src/migrate-command.ts | src/cli/commands/migrate-command.ts |
| src/prune-command.ts | src/cli/commands/prune-command.ts |
| src/resume-command.ts | src/cli/commands/resume-command.ts |
| src/commands/attention.ts | src/cli/commands/attention.ts |
| src/commands/federation.ts | src/cli/commands/federation.ts |
| src/commands/model.ts | src/cli/commands/model.ts |

### 2.3 agent/（成员/团队能力装配）

| 现路径 | 目标 | 理由 |
|---|---|---|
| src/agent-control.ts | src/agent/agent-control.ts | AgentService → agents.*/sessions.* 控制面适配 |
| src/agent-owner-client.ts | src/agent/agent-owner-client.ts | owner 客户端 |
| src/agent-owner-server.ts | src/agent/agent-owner-server.ts | REPL owner loopback 端点 |
| src/agent-service-wiring.ts | src/agent/agent-service-wiring.ts | 进程内 AgentService 装配 |
| src/agent-wiring.ts | src/agent/agent-wiring.ts | canonical agent 工具装配决策 |
| src/self-card.ts | src/agent/self-card.ts | 主 agent Self Card |
| src/local-run-adapter.ts | src/agent/local-run-adapter.ts | AgentService → RunnableAgent（TUI 裸跑）适配器 |
| src/team-human-delivery.ts | src/agent/team-human-delivery.ts | 发给人类的 send 落本机 Team 日志 |
| src/peer-notices.ts | src/agent/peer-notices.ts | 成员停下的 peer 通知（成员语义） |
| src/ask-answer-delivery.ts | src/agent/ask-answer-delivery.ts | async ask 答案投放（成员交互） |

### 2.4 session/（会话后端与读数面）

| 现路径 | 目标 | 理由 |
|---|---|---|
| src/session-control.ts | src/session/session-control.ts | rename/delete |
| src/session-events.ts | src/session/session-events.ts | sessions.events 读取面 |
| src/session-factory.ts | src/session/session-factory.ts | 后端装配 |
| src/session-liveness.ts | src/session/session-liveness.ts | liveness 对账 |
| src/session-lock.ts | src/session/session-lock.ts | session/run 写锁 |
| src/session-lock-runtime.ts | src/session/session-lock-runtime.ts | RunnableAgent 写锁包装 |
| src/session-resume.ts | src/session/session-resume.ts | 会话续接 |
| src/timeline-dual-write.ts | src/session/timeline-dual-write.ts | timeline 双写旁路 |
| src/timeline-session-log.ts | src/session/timeline-session-log.ts | 会话事件唯一持久化端口 |
| src/context-usage.ts | src/session/context-usage.ts | sessions.get.context_usage 读数面 |
| src/context-ratio-source.ts | src/session/context-ratio-source.ts | 上下文占用实时读数源（与 context-usage 同族） |
| src/system-context.ts | src/session/system-context.ts | sessions.get.system_context 读数面 |
| src/image-delivery.ts | src/session/image-delivery.ts | sessions.get.image_delivery 读数面 |

### 2.5 run/（durable run 与执行控制）

| 现路径 | 目标 | 理由 |
|---|---|---|
| src/run-control.ts | src/run/run-control.ts | runs.* 控制面适配 |
| src/run-record-store-factory.ts | src/run/run-record-store-factory.ts | RunRecordStore 装配 |
| src/durable-wiring.ts | src/run/durable-wiring.ts | durable run 接线 |
| src/lease-service.ts | src/run/lease-service.ts | 单节点本地租约（调度） |
| src/connect-run-wait.ts | src/run/connect-run-wait.ts | --connect --run 终态等待 |

### 2.6 config/（配置层与热应用）

| 现路径 | 目标 | 理由 |
|---|---|---|
| src/cli-overrides.ts | src/config/cli-overrides.ts | CLI flag → 配置覆盖层（config 优先级层，config.md 事实家） |
| src/config-error-format.ts | src/config/config-error-format.ts | 校验错误格式化 |
| src/config-snapshot.ts | src/config/config-snapshot.ts | 配置快照 |
| src/config-watch.ts | src/config/config-watch.ts | 用户配置监听 → 热应用 |
| src/config-write-apply.ts | src/config/config-write-apply.ts | config.set 写后热应用 |
| src/hot-apply-appliers.ts | src/config/hot-apply-appliers.ts | reload applier（permission/tools/mcp） |
| src/hot-apply-assembly.ts | src/config/hot-apply-assembly.ts | 热应用装配 |
| src/empty-response-settings.ts | src/config/empty-response-settings.ts | 配置 → EmptyResponsePolicy |
| src/vision-settings.ts | src/config/vision-settings.ts | 配置 → VisionSettings |
| src/ui-settings.ts | src/config/ui-settings.ts | UI 设置持久化 |
| src/legacy-tool-names.ts | src/config/legacy-tool-names.ts | 配置层工具名兼容换算 |

### 2.7 plugin/（插件机制 + 插件接线）

| 现路径 | 目标 | 理由 |
|---|---|---|
| src/plugin-config.ts | src/plugin/plugin-config.ts | 插件安装配置 |
| src/plugin-host-assembly.ts | src/plugin/plugin-host-assembly.ts | 体验型 plugin 宿主装配 |
| src/plugin-loader.ts | src/plugin/plugin-loader.ts | 运行时扫描 + 动态 import |
| src/plugin-manifest.ts | src/plugin/plugin-manifest.ts | package.json.vessel 契约 |
| src/plugin-selection.ts | src/plugin/plugin-selection.ts | 默认集选择策略 |
| src/plugin-watch.ts | src/plugin/plugin-watch.ts | 插件目录/配置监听 |
| src/mcp-wiring.ts | src/plugin/mcp-wiring.ts | MCP 工厂式插件接线（MCP 是插件，ADR-039） |
| src/eval-wiring.ts | src/plugin/eval-wiring.ts | eval harness（plugins/evals）接线 |
| src/feishu-wiring.ts | src/plugin/feishu-wiring.ts | 飞书渠道（plugins/im）接线 |

### 2.8 gateway/（既有 10 文件不动 + 12 个迁入）

| 现路径 | 目标 | 理由 |
|---|---|---|
| src/gateway-banner.ts | src/gateway/gateway-banner.ts | 启动 banner（纯移动，保留原名） |
| src/gateway-config-control.ts | src/gateway/gateway-config-control.ts | gateway config.set 写回 |
| src/gateway-reload-wiring.ts | src/gateway/gateway-reload-wiring.ts | gateway.reload asm 侧实现（RPC 控制面） |
| src/gateway-wiring.ts | src/gateway/gateway-wiring.ts | gateway 控制面注入 |
| src/serve-auth.ts | src/gateway/serve-auth.ts | gateway token → principal |
| src/serve-config.ts | src/gateway/serve-config.ts | serve 启动选项单一 resolver |
| src/transport-factory.ts | src/gateway/transport-factory.ts | gateway/connect token 解析（scripts/dev-web 也引用） |
| src/web-dist.ts | src/gateway/web-dist.ts | Web 静态产物检查 + 后台重建（gateway 启动诊断） |
| src/interactions-dir.ts | src/gateway/interactions-dir.ts | 权限交互记录的实例隔离 |
| src/shutdown-sequence.ts | src/gateway/shutdown-sequence.ts | serve 关闭顺序 |
| src/shutdown-report.ts | src/gateway/shutdown-report.ts | 关闭失败可观测性（与 shutdown-sequence 成对） |

### 2.9 hub/（既有 17 文件不动 + 1 迁入）

| 现路径 | 目标 |
|---|---|
| src/hub-wiring.ts | src/hub/hub-wiring.ts |

### 2.10 node/

| 现路径 | 目标 | 理由 |
|---|---|---|
| src/node-drain.ts | src/node/node-drain.ts | node 优雅退出第一段 |
| src/node-identity.ts | src/node/node-identity.ts | node.json 身份文件 |
| src/node-resume.ts | src/node/node-resume.ts | node 启动恢复 |
| src/token-derive.ts | src/node/token-derive.ts | 根密钥 + 派生 token（node 凭据面；gateway/hub 消费） |

### 2.11 federation/

| 现路径 | 目标 | 理由 |
|---|---|---|
| src/federation-address.ts | src/federation/federation-address.ts | agent@node:team 地址解析 |
| src/federation-client.ts | src/federation/federation-client.ts | 出站 federation client |
| src/federation-config.ts | src/federation/federation-config.ts | federation 配置归一化 |
| src/federation-send-port.ts | src/federation/federation-send-port.ts | FederationSendPort app 层实现 |
| src/attention-client.ts | src/federation/attention-client.ts | attention RPC 客户端（跨节点路由） |
| src/attention-nodes.ts | src/federation/attention-nodes.ts | 多节点 attention 目标选择 |

### 2.12 tools-engine/（既有 7 文件不动 + 2 迁入）

| 现路径 | 目标 | 理由 |
|---|---|---|
| src/mcp-engine-wiring.ts | src/tools-engine/mcp-engine-wiring.ts | engine 模式 MCP host shell 接线 |
| src/tools-list.ts | src/tools-engine/tools-list.ts | --tools 工具清单（工具目录面，与 engine 同域） |

### 2.13 observability/

| 现路径 | 目标 | 理由 |
|---|---|---|
| src/logging.ts | src/observability/logging.ts | CLI/serve 诊断日志装配 |
| src/trace-wiring.ts | src/observability/trace-wiring.ts | trace 装配 |
| src/observability-wiring.ts | src/observability/observability-wiring.ts | observability 接线 |
| src/startup-timing.ts | src/observability/startup-timing.ts | 启动分期观测 |
| src/usage-pricing.ts | src/observability/usage-pricing.ts | opt-in 用量计价（usage 插件同族） |

### 2.14 runtime/（核心运行时装配——跨切 wiring 的家）

| 现路径 | 目标 | 理由 |
|---|---|---|
| src/bootstrap.ts | src/runtime/bootstrap.ts | 应用引导/装配序之根；装配的是运行时整体，不是某单一领域 |
| src/provider-factory.ts | src/runtime/provider-factory.ts | provider 装配（core 运行时面） |
| src/model-registry-wiring.ts | src/runtime/model-registry-wiring.ts | 多厂商路由 + 热应用装配 |
| src/reasoning.ts | src/runtime/reasoning.ts | 思考流接线 |
| src/tenant-runtime-factory.ts | src/runtime/tenant-runtime-factory.ts | 每 tenant 执行面 |
| src/vessel-meta.ts | src/runtime/vessel-meta.ts | vessel 元工具：RPC 控制面 + 工具调用桥 |
| src/runtime-notice.ts | src/runtime/runtime-notice.ts | 运行期通知总线 |
| src/runtime-notice-hook.ts | src/runtime/runtime-notice-hook.ts | runtime.notice → BeforeLlm 注入 |
| src/bash-job-delivery.ts | src/runtime/bash-job-delivery.ts | 后台 bash 作业唤醒投递（走通知总线） |
| src/process-handlers.ts | src/runtime/process-handlers.ts | CLI/serve 未捕获异常兜底（进程级） |

### 2.15 data/（data-dir 路径/锁/迁移/留存/附件）

| 现路径 | 目标 | 理由 |
|---|---|---|
| src/data-paths.ts | src/data/data-paths.ts | data_dir/tenant 路径解析 |
| src/data-lock.ts | src/data/data-lock.ts | data-dir 双层写锁 |
| src/path-resolution.ts | src/data/path-resolution.ts | 路径与名称解析（纯函数 + 只读 fs） |
| src/migrate.ts | src/data/migrate.ts | 迁移核心 |
| src/prune-wiring.ts | src/data/prune-wiring.ts | 留存清理（候选扫描与删除） |
| src/permission-store.ts | src/data/permission-store.ts | 权限免确认规则持久化 |
| src/attachment-ingest.ts | src/data/attachment-ingest.ts | 附件入池（上传即落 blob） |
| src/attachments-list.ts | src/data/attachments-list.ts | 附件目录浏览 |
| src/image-blob-gc.ts | src/data/image-blob-gc.ts | 图片 blob GC |
| src/refs-notice-hook.ts | src/data/refs-notice-hook.ts | 附件引用环境信息行（附件域的输出面） |

### 2.16 shared/（跨切纯叶子，严格准入）

| 现路径 | 目标 | 理由 |
|---|---|---|
| src/version.ts | src/shared/version.ts | 根 package.json 版本读取；cli/gateway/update/doctor 共用，无领域语义 |
| src/port-in-use.ts | src/shared/port-in-use.ts | EADDRINUSE 识别；gateway/node/hub 共用，无领域语义 |

### 2.17 不动清单

- `src/cli.ts`（顶层入口，bin 契约）。
- `src/i18n/`、`src/rpc/`、`src/update/`、`src/mock/` 整目录不动。
- `src/gateway/`、`src/hub/`、`src/tools-engine/` 既有文件不动（只迁入）。
- `src/commands/` 迁空后删除目录（4 文件全部有去向）。

**核对**：136 顶层 − 1（cli.ts 留守）+ 4（commands/）= **139 个移动**，上表逐行覆盖，无遗漏无重复。

## 3. 领域关键词表（供 agent 分类新文件）

分类口诀：**先问「它装配/服务的是哪个领域」，再看前缀**。前缀只是线索，语义才是判据；
`*-wiring`/`*-factory` 归「被装配物」的领域，不归装配动作本身（bootstrap 除外，它是装配序之根）。

| 领域 | 关键词（命中即候选） | 命名约定 | 边界判据 / 反例 |
|---|---|---|---|
| cli/ | cli、args、help、completion、command、退出码、exit code、渲染、output、NO_COLOR、headless、入口模式、--run/--pipe/--serve 分发 | 框架件裸名（args.ts/help.ts/output.ts）；命令 `<ns>-command.ts` 进 `commands/<ns>/` | 只收「解析/分派/渲染/入口模式」。命令调用的业务实现归业务域（反例：stop-command 在 cli/，stopGateway 接缝在 gateway/） |
| agent/ | agent、member、team、body、AgentService、owner、self-card、inbox、peer、send 投递、ask 答案 | agent-*、*-delivery（成员交互向） | 成员/团队能力装配。反例：agent 命令在 cli/commands/agent/；federation 跨节点投递在 federation/ |
| session/ | session、timeline、续接、resume（会话向）、写锁、liveness、context_usage、system_context、sessions.get 读数面 | session-*、timeline-*、*-usage/*-context 读数面 | 会话壳与其持久化/读数。反例：run 记录在 run/；会话锁的 data-dir 锁基建在 data/ |
| run/ | run、durable、RunRecordStore、runs.*、lease、租约、终态等待、interrupted | run-*、durable-* | 一次执行的记录/控制/调度。反例：--resume-run 命令在 cli/；run 的会话锁在 session/ |
| config/ | config、settings、热应用、hot-apply、reload applier、覆盖层、overrides、watch（配置向）、校验错误格式 | config-*、*-settings、hot-apply-* | 配置模型与生效链路。反例：gateway.reload 的 RPC 受理在 gateway/；插件自身配置在 plugin/ |
| plugin/ | plugin、manifest、loader、selection、MCP 接线、插件宿主、eval/feishu 等插件类别接线 | plugin-*、<类别>-wiring（插件向） | 唯一运行期插件机制（ADR-037/099）。反例：engine 模式 MCP shell 在 tools-engine/；插件命令在 cli/ |
| gateway/ | gateway、serve、platform、实例锁、pid、supervisor、adopt、handoff、drain（平台向）、shutdown、banner、web-dist、token→principal | gateway-*、serve-*、shutdown-* | 平台层生命周期与 serve 面。反例：node 自身 drain/resume 在 node/；舰队 stop 编排在 cli/commands/fleet/ |
| hub/ | hub、join、pairing、directory、配对码、hub 控制面 | hub-*（既有目录内裸名亦可） | Hub 控制面与配对。反例：hub 命令在 cli/commands/hub/ |
| node/ | node（身份/生命周期向）、node.json、drain（node 向）、resume 标记、token 派生、根密钥 | node-*、token-derive | node 组件自身。反例：平台视角的 node 监管在 gateway/node-supervisor；node 命令在 cli/ |
| federation/ | federation、跨节点、agent@node:team、attention、出站 client、send port | federation-*、attention-* | 跨节点寻址与投递。反例：本机成员 send 在 agent/ |
| tools-engine/ | tools-engine、engine、worker、工具执行、工具清单、--tools、MCP host shell | 既有目录内裸名；迁入件保留原名 | 工具执行引擎（child/pool）。反例：工具权限规则持久化在 data/；工具名兼容换算在 config/ |
| observability/ | log、trace、timing、观测、usage、计价、诊断日志 | logging、*-wiring（观测向）、startup-timing | 观测数据的装配与计价。反例：logs/errors/trace 命令在 cli/；关闭失败报告与关闭序列成对在 gateway/ |
| runtime/ | bootstrap、装配序、provider、model-registry、reasoning、tenant 执行面、通知总线、runtime.notice、元工具、进程兜底 | bootstrap、*-factory（core 运行时向）、runtime-notice* | 核心运行时整体装配与运行期机制。反例：单一领域的 wiring 归该领域（session-factory→session/） |
| data/ | data-dir、路径解析、写锁（data-dir 向）、migrate、prune、留存、附件、attachment、blob、GC、permission-store | data-*、attachment*、image-blob-* | 数据落盘的路径/锁/迁移/留存/附件。反例：会话事件持久化端口在 session/（它是会话域端口，不是通用存储） |
| shared/ | 版本读取、EADDRINUSE 等**无领域语义**纯叶子 | 裸名短词 | 准入：≥2 个领域共用 + 纯函数/只读 + 无领域状态。拿不准 → 问 main，不进 shared |
| i18n/ | 文案、catalog、MessageKey、t() | messages/<lang>.ts | 只放文案，不放逻辑 |
| rpc/ | RPC client、HttpRpcClient、local-client、RPC 类型 | 裸名 | 传输客户端基建；控制面目标解析（CLI 向）在 cli/ |
| update/ | 自更新、latest.json、channel、install-detect、semver | 裸名 | 更新机制；`vessel update` 命令在 cli/commands/update/ |
| mock/ | VESSEL_MOCK、场景 | scenarios.ts | 仅 mock 场景数据 |

## 4. 管理规范（新文件规则）

1. **顶层冻结**：`src/` 顶层只允许 `cli.ts` 一个 .ts。新增顶层文件 = 违规（gov 记录、main 要求整改）。
2. **≥3 簇必进目录**：某领域已有 ≥3 个文件（含既有目录），该领域新文件**必须**进 `src/<domain>/`，
   不得再平铺。隐式前缀簇达到 3 个文件时，按 §3 关键词表认领领域目录（没有对应目录则按第 3 条建新目录）。
3. **新子系统 ≥3 文件必建目录**：新子系统预计/已有 ≥3 个文件，先建 `src/<domain>/` 再落文件；
   目录名 = 单数名词、kebab-case、与 §3 关键词表登记同步（改本文 §1/§3 即登记）。
   1–2 个文件的萌芽子系统：挂语义最近的既有领域，并在文件头注释写明「候选独立域」；满 3 个再拆。
4. **shared/ 严格准入**：只收「≥2 领域共用 + 无领域语义 + 纯函数/只读」的叶子（§3）。
   禁止把跨切难题扔进 shared 逃避归类；跨切 wiring 按「被装配物」归域（§3 口诀）。
5. **命令三件套**：新命令 = `cli/commands/<ns>/` 文件 + help-spec 条目 + 稳定码/退出码登记
   （cli-conventions §9.4），输出走 cli/output.ts 单一渲染。
6. **纯移动纪律**：relocation commit 不混行为变更（cli-conventions §8.2）；改名只允许设计文档点名的。
7. **与 FILE-MANAGEMENT.md 衔接**：本文是 FILE-MANAGEMENT §3.3「代码」在 `src/**` 内的细化；
   路径独占不变（src/** 归 asm，本文档归 gov 审查、本任务经 main 授权代写）。
   冲突时以 FILE-MANAGEMENT 为准，本文修订需 main 确认。
8. **与 docs/agents/*.md 衔接**：各角色 handoff/领域文档引用 src 路径时以本文映射为准；
   阶段2落地后同步 docs/architecture/*.md 的 paths frontmatter（见 §8 C5）。
   AGENTS.md 不重复本文细节，只加一行指针（随阶段2收口提交）。

## 5. import 重写策略与影响面

### 5.1 影响面盘点（已实测）

| 面 | 读数 | 处置 |
|---|---|---|
| src 顶层文件内相对 import | 632 条 | 随搬迁逐批重写 |
| 既有子目录 → 顶层 import | 58 条（commands/→顶层 48；gateway/node-registry→data-paths、node-identity；hub/runtime→data-paths、node-identity、token-derive；tools-engine/entry→version；update/*→version、runtime-notice；gateway/reload→rpc 不动） | 目标文件移动的那一批一并重写 |
| cli.ts 动态 import | 4 条（./commands/registry ×2、./gateway-nodes-command、./gateway-command） | cli 批重写 |
| 跨包引用根 src | **仅 4 个文件**：scripts/dev-web.ts（data-paths、gateway/daemon、gateway/pid、transport-factory）、scripts/version.ts（plugin-manifest）、examples/eval-offline.ts（eval-wiring、plugin-loader）、examples/feishu-mock.ts（feishu-wiring） | 对应域批重写；packages/plugins/apps 对根 src **零引用**（实测 grep，各自 ../src 是包内路径） |
| package.json bin/start、dev-web entryPath、build.ts 提示 | 都指 src/cli.ts | cli.ts 留守，**零改动** |
| 非 import 的运行时路径计算 | **5 文件 8 处**（见 5.2） | 手工 edit，随所在域批提交 |
| tsconfig include | `src/**/*.ts` 通配 | 零改动 |
| biome | 无 organizeImports assist；src 内 import 全无扩展名（361/361） | 重写保持无扩展名风格；formatter 只动被改行 |

### 5.2 运行时路径计算修正清单（import.meta.dir / new URL 深度）

移动后模块目录深度变化，以下**不是 import 语句**、脚本扫不到，必须手工改：

| 文件（迁后位置） | 现写法 | 迁后写法 |
|---|---|---|
| runtime/bootstrap.ts:1247 | join(import.meta.dir, 'tools-engine', 'entry.ts') | join(import.meta.dir, '..', 'tools-engine', 'entry.ts') |
| runtime/bootstrap.ts:1248 | join(import.meta.dir, '..') | join(import.meta.dir, '..', '..') |
| cli/commands/gateway/gateway-command.ts:3057 | join(import.meta.dir, 'tools-engine', 'entry.ts') | join(import.meta.dir, '..', '..', '..', 'tools-engine', 'entry.ts') |
| cli/commands/gateway/gateway-command.ts:3058 | join(import.meta.dir, '..') | join(import.meta.dir, '..', '..', '..') |
| plugin/plugin-loader.ts:33 | new URL('../plugins', import.meta.url) | new URL('../../plugins', …) |
| shared/version.ts:11 | new URL('../package.json', …) | new URL('../../package.json', …) |
| shared/version.ts:28 | new URL('..', …) | new URL('../..', …) |
| gateway/web-dist.ts:19–24 | new URL('../apps/web/…', …) ×4 | new URL('../../apps/web/…', …) ×4 |

（cli.ts:178 的 ../apps/web/dist 不动；tools-engine/supervisor.ts 只注释提及，entryPath 由装配层传入，不动。）

### 5.3 重写机制（工具辅助 + 精确匹配，不做盲替换）

1. **一次性脚本，不进仓库**：内联 python（bash 执行，用完即弃，符合 FILE-MANAGEMENT §3.4
   「一次性迁移脚本放个人侧」——本任务直接内联执行，不落盘）。
2. 每批给定 old→new 映射；扫描 src/**、scripts/**、examples/** 全部 .ts 的
   `from '…'` / `import('…')` / `export … from '…'` 相对 specifier：
   - 以**引用方文件所在目录**解析 specifier（归一化去 .js/.ts 后缀）得到绝对目标；
   - 目标**精确命中**本批移动集合才重写；按引用方（可能也已移动）的新位置重算相对路径；
   - 保持原风格（无扩展名保持无扩展名；原有 .js 的保持 .js）；
   - 非相对 import（包名）一律不碰。
3. 同批手工 edit §5.2 中属于本批的运行时路径。
4. **残留检查**：grep 全仓（除 docs/node_modules）对旧路径的引用 = 0 才算重写完整。
5. 门禁：`bun run build`（§6）。重写脚本本身不是门禁，build 才是。

### 5.4 为什么不用「全仓字符串替换」

`./data-paths` 这类短名在包内同名文件（plugins/*/src）也存在；盲替换会误伤。
精确解析 + 命中移动集合是唯一安全口径。docs 里的路径引用是文档同步（C5），与代码重写分开。

## 6. 逐域分批顺序与门禁

原则：**叶子域先搬、cli 最后**；每批 = git mv + 全仓引用重写（引用方不动）+ §5.2 手工修正
+ 残留检查 + build + **独立 commit**。任何一批 build 红 → 停在该批修复或 revert，不带病进下一批。

| 批 | 域 | 移动数 | 备注 |
|---|---|---|---|
| 1 | shared/ | 2 | version 深度修正；tools-engine/entry、update/* 引用重写 |
| 2 | data/ | 10 | gateway/node-registry、hub/runtime、scripts/dev-web 引用重写 |
| 3 | node/ | 4 | hub/runtime、gateway/node-registry 引用重写 |
| 4 | federation/ | 6 | |
| 5 | observability/ | 5 | |
| 6 | config/ | 11 | |
| 7 | plugin/ | 9 | plugin-loader URL 深度修正；scripts/version、examples/* 引用重写 |
| 8 | session/ | 13 | |
| 9 | run/ | 5 | |
| 10 | agent/ | 10 | |
| 11 | runtime/ | 10 | bootstrap import.meta.dir 修正（此时被装配物已在新位置） |
| 12 | gateway/ 迁入 | 11 | web-dist URL 深度修正；scripts/dev-web transport-factory 引用重写 |
| 13 | hub/ 迁入 | 1 | hub-wiring |
| 14 | tools-engine/ 迁入 | 2 | tools-list、mcp-engine-wiring |
| 15 | cli/ 框架 | 11 | args/help-spec/help/output 改名 + completion/control-plane/headless/ask-channel/feishu-command；cli.ts 引用重写 |
| 16 | cli/commands/ + registry | 29 | 28 命令 + registry；cli.ts 4 条动态 import 重写；gateway-command import.meta.dir 修正；src/commands/ 目录删除 |
| 收口 | 文档同步 | — | 最终 build + docs paths 同步（C5 裁定后）+ AGENTS.md 指针 + 本文翻〔现行〕 |

**门禁口径（宪法）**：每批 `bun run build` 独立取 exit code **且**读产物证据——
输出必须出现末尾 `📦 Build complete!`，且无 `error TS####` / `Found N error` /
`Some errors were emitted`（WSL 退出码可能谎报 0，build.ts 已内置同款双判，读数记入 commit message
或回报）。零测试、零探针、零临时进程；行为验证归用户。

## 7. 风险与回滚

| 风险 | 缓解 | 回滚 |
|---|---|---|
| 相对路径漏改/误改 | §5.3 精确匹配 + 残留 grep + 每批 build | 单批 `git revert <batch-commit>`（批间无交叉依赖，revert 一批不伤他批） |
| 运行时路径计算漏改（build 绿但运行炸） | §5.2 清单逐条手工改 + 收口全仓 grep import.meta/new URL 复核 | 同上；行为验证归用户（宪法），发现即 revert 该批 |
| 动态 import 字符串漏改 | cli.ts 4 条列入批16清单；typecheck 覆盖动态 import 类型 | 同上 |
| WSL/Windows git 索引陈旧（本 worktree 已实测首次 status 谎报 1567 删除） | 每批操作前先 `git status` 刷新索引再核对 | 误判时以 `git ls-files` + 磁盘实况复核，不盲目 commit |
| 早退（长 thinking 空响应） | 小步：每批 mv→重写→build→commit 四连，单批输出短 | 已提交批次不丢；接续从 git log 读进度 |
| 与在途分支冲突（q-empty-response 等改 src 顶层） | 本分支只移动不改行为；合并冲突由 main 收口时按「新位置 + 对方行为变更」裁决 | 不 merge、不碰主 checkout（宪法） |
| docs 路径引用漂移 | C5 裁定后收口批机械同步 32 个文档的 paths/正文 | 文档单独 commit，可独立 revert |
| 命令字面量/flag/--json 形状/退出码变化 | 纯移动纪律：只改 import 与 §5.2 路径，命令契约面零触碰 | build 之外由用户行为验证兜底 |

**总回滚**：阶段2全部批次在 refactor/q-plan-c 上线性排列，main 可整段不合并，
或 `git revert <批1>..<批16>` 逆序回退；src/cli.ts 与四个基础设施目录全程未动，回滚无残留。

## 8. main 裁决记录（阶段2批准）

- **C1 批准**：`src/commands/` 并入 `src/cli/`（任务书「commands/ 保留」系 main 笔误，以 cli-conventions §8 为准）。
- **C2 修正**：命名空间 **≥2 命令才建目录**（agent/gateway/fleet/plugin 4 个），单命令命名空间平铺
  `cli/commands/<原文件名>.ts`（21 个），避免单文件目录碎片化。§2.2 已按此更新。
- **C3 批准**：仅 5 个点名改名（args/help-spec/help/output/registry），其余保留原名含 -command 后缀。
- **C4 批准**：token-derive→node/、tools-list→tools-engine/、headless-runner/ask-channel/feishu-command→cli/。
- **C5 批准**：~32 个 docs/architecture/*.md 的 paths/正文 src 路径同步在本分支收口批一并改。

阶段2纪律（main 追加）：每批 git mv + 内联脚本精确重写 + 残留 grep + build 双判 + 独立 commit；
5 文件 8 处运行时路径暗礁每处手工修正后单独验证路径计算；跨包 4 文件引用同步改；增量小输出防早退。