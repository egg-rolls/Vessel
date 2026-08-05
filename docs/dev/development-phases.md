# 开发阶段与优先级决策

> 状态：2026-08-05 启用。记录当前开发阶段、工作优先级决策框架。
> 本文件属于 `docs/dev/`——可以有状态、进度、时间描述。
> 阶段定义（WHAT）见 `docs/specs/ROADMAP.md`；本文档定义 HOW——当前在哪、下一步做什么、怎么决策。

## 一、当前阶段

**Phase 0（脚手架）→ 向 Phase 1（MVP）过渡。**

已完成：
- monorepo 结构（bun workspaces）：`packages/{core,config,tui}` + `plugins/`
- `@vessel/core`：最小 tool-calling loop + provider 抽象 + in-memory context/events + PluginHost 骨架
- `@vessel/config`：YAML 读取 + schema 校验
- `@vessel/tui`：Ink REPL 桩，流式渲染，slash 命令
- CI：lint + typecheck + test + build 四灯
- 插件示例：file-ops、meta-tools、skills-loader、mcp-client、memory（auto + project）、guardrail-pii、redact-secrets、tool-policy、hook-logging

当前阻塞 MVP 的缺口（按优先级排序）：
1. headless 模式（`--run` 入口）——无头运行是嵌入场景的基础
2. provider 适配完整性——Anthropic 流式 + OpenAI 兼容
3. session 持久化与恢复——SQLite backend 完整性
4. 首启配置向导——无基础用户填 Key 即跑的关键入口
5. 工具执行前权限确认弹窗——安全底线

## 二、开发优先级原则

### 2.1 总原则：先功能，后体验

```
功能跑通 > 体验打磨

pre-MVP 阶段：
  新功能/新模块 > Bug 修复 > 代码质量 > 体验细节

MVP 阶段（Phase 1）：
  Bug 修复 > 核心功能补全 > 性能 > 体验 > 文档

MVP 后（Phase 2+）：
  Bug 修复 > 新能力 > 性能 > 代码质量 > 体验 > 文档
```

### 2.2 借鉴 Hermes：六层贡献优先级

Hermes 项目的贡献优先级体系提供了清晰的"什么先做"框架。Vessel 适配如下：

| 优先级 | Hermes 原版 | Vessel 对应 | 当前阶段执行策略 |
|--------|-----------|------------|----------------|
| 1 | Bug fixes（崩溃/数据丢失） | `fix` + `security`（P0） | 随时处理，不排队 |
| 2 | Cross-platform | `feat(cross)` | 不主动做，有人报再说 |
| 3 | Security hardening | `security`（P1） | 每个 phase 结束前审计一次 |
| 4 | Perf & robustness | `perf` + `test`（P2） | MVP 功能稳定后再优化 |
| 5 | New skills | `feat(plugins)`（P2/P3） | 有真实需求驱动才做 |
| 6 | Documentation | `docs`（P3） | 功能稳定后补文档 |

### 2.3 决策框架：拿到一个 Issue 或想法时

```
[ 是 Bug（崩溃/数据丢失/安全漏洞）？]
  → 是 → P0，立即处理
  → 否 ↓

[ 是核心功能缺失（用户被阻塞）？]
  → 是 → P1，本周处理
  → 否 ↓

[ 是质量加固（测试/性能/核心交互完善）？]
  → 是 → P2，本月排期
  → 否 ↓

[ 是体验打磨/内部重构/文档/跨平台？]
  → 是 → P3，有空再做，pre-MVP 阶段不主动投入
```

### 2.4 TUI 体验问题的特殊处理

pre-MVP 阶段 TUI 体验类 issue 最容易膨胀。判断标准：

```
这个改动是让用户"能做之前做不到的事"（功能），
还是让用户"更舒服地做已经能做的事"（体验）？

功能 → 按优先级正常排期
体验 → 默认 P3，除非 Reviewer 判断为核心交互
```

核心交互 vs 体验细节的区分见 `processes/conventions.md` §4.3。

## 三、Phase 里程碑

### Phase 0（脚手架）→ Phase 1（MVP）的切换条件

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

## 四、每周 Issue 分类操作

每周进行一次（或 PR 合并时顺手做）：

1. `gh issue list --state open --limit 50` 列出所有 open issue
2. 检查未标优先级的 issue —— 按 `conventions.md` §4.2 补标签
3. 检查 P2 issue 是否已过期（无 PR、无人认领 > 30 天）—— 降为 P3 或关闭
4. 检查 P0/P1 issue 是否有活跃 PR —— 没有则提醒认领
5. 检查是否有"能合并到一个 issue"的碎片 issue —— 合并并关闭冗余

## 五、参考

- 阶段定义：`docs/specs/ROADMAP.md`
- 优先级映射：`processes/conventions.md` §4
- 产品范围：`docs/specs/PRD.md`
- 发布策略：`docs/dev/release-strategy.md`
- Hermes 贡献优先级：https://github.com/NickSavage/hermes
