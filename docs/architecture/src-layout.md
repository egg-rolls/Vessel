---
title: src 领域目录布局（计划 C）
kind: target
triggers: [src, layout, 目录, 归类, 领域, domain, 重组, 搬迁, refactor, plan-c, 文件管理, 新文件, 命名, import 重写, cli, agent, session, run, config, plugin, node, federation, observability, runtime, data, shared]
paths: [src/**, docs/FILE-MANAGEMENT.md, docs/architecture/cli-conventions.md, docs/architecture/assembly.md]
---

# src 领域目录布局（计划 C）

> **状态**：〔提案〕阶段1设计稿，待 main 审映射后进阶段2搬迁。落地后翻〔现行〕。
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

### 2.2 cli/commands/（27 个命令，按命名空间分目录，§8 布局）

| 现路径 | 目标 |
|---|---|
| src/agent-command.ts | src/cli/commands/agent/agent-command.ts |
| src/agent-inbox-command.ts | src/cli/commands/agent/agent-inbox-command.ts |
| src/agents-command.ts | src/cli/commands/agent/agents-command.ts |
| src/team-command.ts | src/cli/commands/team/team-command.ts |
| src/gateway-command.ts | src/cli/commands/gateway/gateway-command.ts |
| src/gateway-nodes-command.ts | src/cli/commands/gateway/gateway-nodes-command.ts |
| src/node-command.ts | src/cli/commands/node/node-command.ts |
| src/hub-command.ts | src/cli/commands/hub/hub-command.ts |
| src/stop-command.ts | src/cli/commands/fleet/stop-command.ts |
| src/status-command.ts | src/cli/commands/fleet/status-command.ts |
| src/config-command.ts | src/cli/commands/config/config-command.ts |
| src/token-command.ts | src/cli/commands/token/token-command.ts |
| src/plugin-command.ts | src/cli/commands/plugin/plugin-command.ts |
| src/plugin-cli-command.ts | src/cli/commands/plugin/plugin-cli-command.ts |
| src/cli-update.ts | src/cli/commands/update/cli-update.ts |
| src/completion-command.ts | src/cli/commands/completion/completion-command.ts |
| src/dev-command.ts | src/cli/commands/dev/dev-command.ts |
| src/doctor-command.ts | src/cli/commands/doctor/doctor-command.ts |
| src/errors-command.ts | src/cli/commands/errors/errors-command.ts |
| src/logs-command.ts | src/cli/commands/logs/logs-command.ts |
| src/trace-command.ts | src/cli/commands/trace/trace-command.ts |
| src/eval-command.ts | src/cli/commands/eval/eval-command.ts |
| src/migrate-command.ts | src/cli/commands/migrate/migrate-command.ts |
| src/prune-command.ts | src/cli/commands/prune/prune-command.ts |
| src/resume-command.ts | src/cli/commands/resume/resume-command.ts |
| src/commands/attention.ts | src/cli/commands/attention/attention.ts |
| src/commands/federation.ts | src/cli/commands/federation/federation.ts |
| src/commands/model.ts | src/cli/commands/model/model.ts |

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

（第2步补全）

## 4. 管理规范（新文件规则）

（第2步补全）

## 5. import 重写策略与影响面

（第3步补全）

## 6. 逐域分批顺序与门禁

（第3步补全）

## 7. 风险与回滚

（第3步补全）

## 8. 待 main 确认项

- **C1**：`src/commands/` 并入 `src/cli/`（cli-conventions §8 布局），偏离任务书「commands/ 保留」字面。
  若 main 裁定保留 `src/commands/`，则 §2.2 的 28 个命令改落 `src/commands/<ns>/`，cli/ 只收框架 12 件，其余不变。
- **C2**：命令命名空间目录粒度——§8 是每命名空间一目录（23 个目录，多数 1 文件）。
  备选：`cli/commands/` 平铺 28 文件（少 23 个目录）。本稿按 §8 执行，main 可改平铺。
- **C3**：5 个点名改名（args/help-spec/help/output/registry）随搬迁一次做；其余保留原名。是否同意。
- **C4**：`token-derive` 归 node/（备选 gateway/）；`tools-list` 归 tools-engine/（备选 cli/）；
  `headless-runner`/`ask-channel`/`feishu-command` 归 cli/（备选 run/、agent/、plugin/）。本稿按语义主归属，main 可微调。
- **C5**：docs/architecture/*.md 的 paths frontmatter 与正文 src 路径引用（约 32 个文档）随阶段2机械同步，
  属 gov 路径——按任务书授权在本分支一并改，还是留给 main/gov 收口。