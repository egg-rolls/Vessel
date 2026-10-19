---
adr: 34
title: 极简化重构——解冻 core、三工具集、skills 即消息、拆治理
status: accepted
date: null
supersedes: [17, 11]
related: [3, 4, 12, 24, 26, 28, 30]
---

## ADR-034：极简化重构——解冻 core、三工具集、skills 即消息、拆治理

- **上下文**：Vessel 长出了两层与产品无关的复杂度。
  **(1) 代码层**：为「让 Agent 自我管理资产」，并存了四套插件/工具发现机制（构建时生成的注册表 / 静态映射表 / 运行时目录扫描 / `vessel.yaml` 声明式）；另有 606 行的 skills-loader（SkillsManager + 文件监听 + 5 个 CRUD 工具 + 路径穿越防护）、761 行的 MCP 客户端、278 行的 file-ops（5 个工具里 3 个等价于 `ls` / `test` / `mkdir -p`）、351+338 行的两个 memory 插件。而**最必要的通用工具——执行命令的 bash 工具——根本不存在**。
  **(2) 文档层**：40 份 markdown，约 28 份在约束 AI 怎么干活（任务启动器 CLAUDE.md、5 个角色 TODO + 5 份角色文档、4 份 processes、10 份 specs 里的规范与治理）。管理流程的成本已超过写代码。
  **(3) 背离**：资产体系代码删了一半（`search_assets` / `inspect_asset` / `patch_asset` / `remove_asset` / `add_skill` / `connect_mcp` 均已不存在），但 SPEC / PLUGINS / ADR / README 与 `core/types/tool.ts` 的注释里全还写着它们；`/assets` 命令永远输出空；`skills/asset-introspection.md` 教 Agent 调用不存在的工具。
- **决策**：
  1. **工具集收敛为三个**：`bash` + `read` + `edit`。`bash` 承担 grep / cat / ls / python / mkdir / curl / git 等一切命令行操作。判据只有一条——**能被其他工具替代的工具就不该存在**。三个是原语，其余都是它们的特化。装配层另注册 `ask_user`（交互）与 `delegate_task`（子 agent 派发）。
  2. **删除 plugin 包**（共 1,862 行）：`file-ops` / `meta-tools` / `skills-loader` / `mcp-client` / `memory/project` / `memory/auto`。默认工具从 8 组降为 5 个，插件包从 12 降为 8。
  3. **skills 就是文件，不是一条加载通道**：harness 不扫描、不解析、不注入 skills。core 新增通用注入位 `RunOptions.messages`——调用方把**任何要进语言空间的文本**（skill 内容、附件、引用文件、项目约定）拼成消息传进来，core 不解释其来源与语义。REPL 侧由前端展开 `@路径`；技能就是 markdown 文件，约定放仓库 `skills/`（项目级，随仓库提交、团队共享）与 `~/.vessel/skills/`（用户级，跨项目复用）——纯约定，代码里零硬编码。memory 同理：项目约定写在 `AGENTS.md`，模型自己读；跨会话笔记是 markdown，模型自己读写。
  4. **插件发现收敛为一套**：只保留 `src/plugin-loader.ts` 的运行时扫描（`plugins/<category>/<name>/package.json` + `src/index.ts`，放文件夹即注册、无需构建步骤）。删掉 `plugin-registry.generated.ts` / `DEFAULT_PLUGIN_IMPORT_MAP` / `CompositeProvider` / `PluginProvider` 接口 / `dir-scanner.ts` / `config-declared.ts` / `scripts/discover-plugins.ts`。连带删除 `vessel.yaml` 的 `tools:` 声明段与 `ToolConfig` 类型——有了 bash 之后，「用户声明式加工具」的三条路都多余。
  5. **core 解冻 + 针对性简化**（不重写 loop）：删除全仓库零读零写的死字段 `ToolDefinition.default` / `interactive` / `render` / `isEnabled` / `shouldDefer`；删除 `ToolRegistry` 接口与 `packages/core/src/tools/`——**唯一的工具注册表是 `PluginHost` / `MemoryPluginHost`**；`AgentRuntime` 直接接 `PluginHost`（删掉构造期从 `ToolRegistry` 播种工具的双轨步骤），并暴露 `readonly pluginHost`；`Hook.run` 返回类型收窄为 `Promise<void>`；`HookContext` 加显式 `systemPrompt` 字段；抽 `buildRequestMessages()` 把持久化上下文 + `RunOptions.messages` 注入消息 + `BeforeLlm` 写入的 system 收敛到一处；删从不发布的 `GuardrailModifiedPayload`。
  6. **拆掉角色/流程治理**：删除 `docs/role/`（11 份）、`processes/`（4 份）、`legacy/`、`.github/ISSUE_TEMPLATE/` 与任务启动器 CLAUDE.md。开发流程只留 git 约定：**分支 → PR → squash merge**。
  7. **文档树收敛为 4 份**：`README.md`（是什么/怎么跑/延后项）+ `AGENTS.md`（AI 行为约定，~1 页）+ `docs/ARCHITECTURE.md`（分层/循环/两插槽/扩展模型/接口签名/事件名）+ `docs/ADR.md`（本存档，只追加）。删 `docs/specs/`（10 份）、`docs/api/`（3 份）、`docs/guides/`（4 份）、`docs/dev/`（1 份）。`CLAUDE.md` 收缩为单行 `@AGENTS.md`。
  8. **MCP 延后**：本期不做，写进 README 的延后段。若回归，形态也是「一个插件」，不给 core 加接口。
- **备选**：(a) 保持 core 冻结、把简化全做成插件——但被删的是 core 内部的死字段与双轨注册表（`ToolRegistry`），插件无法触及；且工具集本身是最贴近 core 的决策。(b) 重写 tool-calling loop——诊断为「约束错误 + 死物堆积」而非循环设计错误，重写会白扔已验证的 loop（含流式、中断、事件、限流）。(c) 保留 skills-loader 但精简——skills 的本质是「发给模型的文本」，一旦承认这点，扫描器/CRUD/文件监听/路径穿越防护全部失去存在理由。(d) 保留治理文档树——成本已超过收益，且 28 份约束文档里大部分在描述不存在的架构。均不取。
- **后果**：
  - 解冻 core。ADR-017 的冻结条款作废——core 回到按 ADR-012 的三条理由（扩插座 / 修 bug / 横切需求）逐案判断，仍需 ADR。**但冻结的精神以更弱的形式保留**：core 仍只放领域无关的运行时，「拿不准就选插件」的能力准入判据写进 AGENTS.md。
  - 仓库里每份文档都记录代码事实，每个工具都无法被其他工具替代。
  - 代价一：模型失去了「专用工具」的强约束（grep 的 glob 语义、edit 的唯一性保证由各自 handler 自守），要靠工具 description 与 `inputSchema` 把用法讲清楚。代价二：删掉的 `/assets` `/skills` `/mcp` 三条命令与资产体系没有替代品——它们是空壳。
  - `@vessel/core` 的公开面收窄：不再导出 `MemoryToolRegistry` 与 `ToolRegistry` 类型；嵌入方若只想要简单注册表，用 `MemoryPluginHost`。
- **关联**：**supersede ADR-017（Core 冻结）**、**supersede ADR-011（Skills 经 skills-loader 插件注入）**；使 **ADR-024（`ToolDefinition.default` 过滤）失效**（字段已删）、**部分取代 ADR-026**（`render` / `isEnabled` / `shouldDefer` / `interactive` 已删，`checkPermission` / `timeout` 保留）、**收窄 ADR-028**（保留其「运行时扫描」结论，删除 `PluginProvider` 接口与另外三套实现）；ADR-003（插件不进构造函数）、ADR-004（唯一扩展机制）、ADR-030（事件名开放字符串）不变；架构事实见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## Addendum（0.6.1，计划中）

- **插件扫描范围（additive）**：在仓库 `plugins/` 之外增加用户 `~/.vessel/plugins/` 与项目 `./.vessel/plugins/`。仍然是同一套运行时目录扫描、启动时扫描一次、无构建步骤；不恢复第二套注册机制，也不做远程市场。
- **插件配置（additive）**：`plugins[].config` 通过 `Plugin.install(host, { config })` 传入；插件对象仍由 `PluginHost` 注册。ADR-003 / ADR-004 的边界不变。
- **skills 不变**：skills 仍是文件，经消息注入；不新增扫描器 / 解析器 / 工具。
- **工具集不变**：`bash` / `read` / `edit` 三能力工具与最小工具集结论不变。
