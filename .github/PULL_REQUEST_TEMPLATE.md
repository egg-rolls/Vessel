<!-- PR 标题格式：<type>(<scope>): <简短描述> #<issue-number> -->
<!-- 示例：fix(core): AgentRuntime 改用静态工厂方法 #17 -->

## 变更说明
<!-- 这个 PR 做了什么、为什么 -->

## 变更类型
- [ ] feat
- [ ] fix
- [ ] docs
- [ ] refactor
- [ ] test
- [ ] chore

## 检查清单
- [ ] 已读 [CLAUDE.md](../CLAUDE.md) §5 能力分层决策树，新能力分类正确（core / 插件 / 应用层）
- [ ] 未触碰 core 红线（CLAUDE.md §3）；若改 core 已附 ADR（ADR-012）
- [ ] 未引入 LangChain 或重依赖进 core
- [ ] 补了测试，`bun test` 通过
- [ ] `bun run lint` / `bun run typecheck` / `bun run build` 通过
- [ ] 更新了相关文档（SPEC / ADR / ROADMAP / CLAUDE / PLUGINS）
- [ ] 未在文档中吹未实现能力（反幻觉纪律）
