# 开发阶段计划（DEVELOPMENT-PLAN）

> 状态：2026-08-05 启用。记录当前开发阶段、候选模块、周常操作。
> 本文件属于 `docs/dev/`——可以有状态、进度、时间描述。
> 阶段定义（WHAT）见 `docs/specs/ROADMAP.md`。
> 优先级体系（HOW to decide）见 `docs/specs/ISSUE-SPEC.md`。
> 治理模型（HOW to intake）见 `docs/specs/GOVERNANCE.md`。

## 一、当前阶段

**Phase 0（脚手架）→ 向 Phase 1（MVP）过渡。**

### 已完成

- monorepo 结构（bun workspaces）：`packages/{core,config,tui}` + `plugins/`
- `@vessel/core`：最小 tool-calling loop + provider 抽象 + in-memory context/events + PluginHost 骨架
- `@vessel/config`：YAML 读取 + schema 校验
- `@vessel/tui`：Ink REPL 桩，流式渲染，slash 命令
- CI：lint + typecheck + test + build 四灯
- 插件：file-ops、meta-tools、skills-loader、mcp-client、memory（auto + project）、guardrail-pii、redact-secrets、tool-policy、hook-logging

### 阻塞 MVP 的缺口

当前仅剩一个缺口阻塞 Phase 0→1 切换：

1. **headless `--run` 入口**（`feat/headless-single-run` 分支未合并，main 无 CLI 入口）——无头运行是嵌入场景和非交互部署的基础

以下已在 main 实现，不再阻塞：
- provider 适配：Anthropic + OpenAI 兼容 SSE 流式（`packages/core/src/provider/providers.ts`）
- session SQLite 持久化（`packages/core/src/session/sqlite-backend.ts`）
- 首启配置向导（`packages/tui/src/wizard/setup-wizard.ts`，`/setup` 命令 + start.ts 自动触发）
- 工具执行前权限确认弹窗（`packages/tui/src/renderer/tool-confirm.ts`）

## 二、各阶段开发优先级

```
Phase 0（脚手架 → MVP）：
  P0 Bug（立即处理） > 新功能/新模块 > 代码质量 > 体验细节

Phase 1（MVP）：
  Bug 修复 > 核心功能补全 > 性能 > 体验 > 文档

Phase 2+（增强）：
  Bug 修复 > 新能力 > 性能 > 代码质量 > 体验 > 文档
```

### Hermes 六层优先级在各阶段的执行策略

| 优先级 | Hermes 原版 | Vessel 对应 | Phase 0 执行策略 |
|--------|-----------|------------|-----------------|
| 1 | Bug fixes（崩溃/数据丢失） | `fix` + `security`（P0） | 随时处理，不排队 |
| 2 | Cross-platform | `feat(cross)` | 不主动做，有人报再说 |
| 3 | Security hardening | `security`（注入/提权/密钥泄漏 → P0；一般安全加固 → P1） | 每个 phase 结束前审计一次 |
| 4 | Perf & robustness | `perf` + `test`（P2） | MVP 功能稳定后再优化 |
| 5 | New skills | `feat(plugins)`（P2/P3） | 有真实需求驱动才做 |
| 6 | Documentation | `docs`（P3） | 功能稳定后补文档 |

## 三、候选模块表

当前阶段及后续阶段需要启动的大模块（L3 级别）。
每个模块启动时按 `docs/specs/GOVERNANCE.md` §三 走完整 PRD→SPEC→Issues 流程。

| 模块 | 目标 Phase | 当前状态 | `docs/dev/` 目录 | 优先级 |
|------|-----------|---------|-----------------|--------|
| headless `--run` | Phase 1 MVP | 分支开发中（`feat/headless-single-run`） | `docs/dev/headless/` | P1 |
| provider 完整性 | Phase 1 MVP | 已实现（Anthropic + OpenAI SSE 流式） | `docs/dev/provider-completeness/` | P1 |
| session SQLite | Phase 1 MVP | 已实现（`packages/core/src/session/sqlite-backend.ts`） | — | P1 |
| 首启配置向导 | Phase 1 MVP | 已实现（`packages/tui/src/wizard/setup-wizard.ts`） | — | P2 |
| 权限确认弹窗 | Phase 1 MVP | 已实现（`packages/tui/src/renderer/tool-confirm.ts`） | — | P2 |
| skills-loader 完善 | Phase 2 | 已有原型 | `docs/dev/skills-loader/` | P2 |
| mcp-client 产品化 | Phase 2 | 已有原型 | `docs/dev/mcp-client/` | P2 |
| a2a-bridge | Phase 3 | 未启动 | — | P3 |
| webui | Phase 3+ | 未启动，PRD 讨论中 | — | P3 |
| desktop-app | Phase 3+ | 未启动，PRD 讨论中 | — | P3 |

## 四、Phase 里程碑

### Phase 0 → Phase 1 切换条件

以下全部满足时，打 tag 发 `v0.1.0`（Phase 0 结束），进入 Phase 1：

- [ ] `bun test` 全绿
- [ ] `bun run build` 通过，单二进制可运行
- [ ] headless `--run` 可完成一次完整 tool-calling 对话
- [ ] 至少一个 OpenAI 兼容 provider + 一个 Anthropic 兼容 provider 可正常工作
- [ ] 首启配置向导可引导用户完成 Key 填写
- [ ] 工具执行前权限确认弹窗生效

### Phase 1（MVP）完成条件

见 `docs/specs/ROADMAP.md` Phase 1 验收标准。核心指标：
- 无基础用户 ≤5 分钟跑通
- 弱基础用户 ≤20 行 YAML 定义带自定义工具的 agent
- core 独立可嵌入

## 五、每周 Issue 分类操作

每周进行一次（或 PR 合并时顺手做）：

1. `gh issue list --state open --limit 50` 列出所有 open issue
2. 检查未标优先级的 issue —— 按 `docs/specs/ISSUE-SPEC.md` §2.2 补标签
3. 检查 P2 issue 是否已过期（无 PR、无人认领 > 30 天）—— 降为 P3 或关闭
4. 检查 P0/P1 issue 是否有活跃 PR —— 没有则提醒认领
5. 检查是否有冗余碎片 issue —— 合并并关闭
6. 新出现的 L3 级需求 → 更新 §三 候选模块表

## 六、关联规范

- 阶段定义（WHAT）：`docs/specs/ROADMAP.md`
- Issue 类型与优先级（HOW to decide）：`docs/specs/ISSUE-SPEC.md`
- 需求治理模型（HOW to intake）：`docs/specs/GOVERNANCE.md`
- 命名与消息规范：`processes/conventions.md`
- 模块开发流程：`processes/development.md`
- Hermes 贡献优先级：https://github.com/NickSavage/hermes
