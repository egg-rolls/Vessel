<!-- 标题格式：<type>(<scope>): <简短描述> -->
## 变更说明
<!-- 做了什么、为什么 -->

## 检查清单
- [ ] `bun run typecheck` / `bunx @biomejs/biome ci .` 全过
- [ ] CI 全绿（`quality` / `cross-platform` / `web` / `examples` / `smoke` 按触发条件）
- [ ] 新能力已按 [AGENTS.md](AGENTS.md) 分层（core / 插件 / 应用层），拿不准的做成了插件
- [ ] 影响 CI / 发布 / 文件规范时，已同步 [docs/operations/](docs/operations/) 与 [docs/FILE-MANAGEMENT.md](docs/FILE-MANAGEMENT.md)
- [ ] 未引重依赖、未加第二套扩展机制、未在文档里吹未实现的能力
- [ ] 未包含 handoff / plan / report / 临时脚本等个人侧产物
