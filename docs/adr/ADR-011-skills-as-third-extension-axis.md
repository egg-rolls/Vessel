---
adr: 11
title: Skills 作为第三扩展轴，plugin-delivered，core 不加 SkillHost
status: superseded
date: null
---

## ADR-011：Skills 作为第三扩展轴，plugin-delivered，core 不加 SkillHost

- **上下文**：用户期望"加功能 = 加 Plugin/MCP/Skill"且 core 零改动。Skills（可复用行为剧本，对标 Claude Code）对无基础用户最友好（Markdown，不写代码）。是否需要 core 新增 SkillHost 接口？
- **决策**：Skills 由 skills-loader 插件承载：用 `BeforeLlm` 钩子按需注入 skill 内容，TUI slash 命令触发；skill 内容是 Markdown。core 不新增 SkillHost 接口。用户面向四类扩展（Plugin/MCP/Skill/Config）全部经 PluginHost 投放。
- **备选**：core 加 SkillHost 与 PluginHost 对称（更紧集成、对称），但属 speculative core 增长，且与"加 skill 不动 core"诉求矛盾。
- **后果**：core 真正冻结；skill 即装即用；无基础用户可写/分享 Markdown skill。代价：skill 注入只能走现有钩子点，若将来需更紧集成再评估（届时新 ADR）。
- **关联**：legacy/LESSONS 教训14；[SPEC.md](SPEC.md) §5.1；[PLUGINS.md](PLUGINS.md) §八。
