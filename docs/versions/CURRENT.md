# 当前版本

> O(1) 当前态：整文件覆盖，只写当前事实。历史见 [INDEX.md](INDEX.md)，
> 本文只回答「现在到哪了、下一步是什么」。

## 版本

**0.33.0（2026-10-31）** — 未 tag、未 publish。版本号以根 `package.json` 为唯一来源；
manifest 与 `CHANGELOG.md` 一致。

## 已合入

- **headless ask 异步**：headless / `--run` 注册 `ask_user`；提问挂起 run 并以 exit 3 退出，
  请求持久化（`StoredInteraction.suspended`）；`attention [--json]` 离线查看，
  `attention respond --answers` 应答，`--resume-run` 恢复并注入 `source=ask_resume`。
  ADR-082 已追加 Errata。
- **压缩质量**：压缩前清空旧工具输出（保留最近 5 条、配对与 system）；摘要九段模板
  （目标/约束/已完成/进行中/阻塞/决策/相关文件/下一步/关键值）。
- **Web 尾部拆分**：AttentionPanel 550→23、TeamsView 547→31、TeamChat 541→145、
  TenantsView 536→183；导入路径与导出面不变。
- **诊断页**：覆盖 doctor --deep 九类检查，标注数据来源；RPC 不可得的项标 unavailable 并写原因。
- **门禁**：零测试文件；一次性探针 + typecheck / biome / web tsc / web build / mock smoke。

## 下一步

- 下一轮方向待定。候选：真实 provider 下 dogfooding ask 流程、`--connect --run` 远端 ask、
  离线 attention 跨进程锁、剩余 Web 大文件、计费/价格表、token 限额口径。
- 已知边界：`--serve --run` 双写同一记录；resume 重放会让保留区被清空的旧工具结果重现；
  `KEEP_RECENT_TOOL_RESULTS=5` 为模块常量。

## 入口

- 版本历史：[INDEX.md](INDEX.md)
- 当前版本变更摘要：[../../CHANGELOG.md](../../CHANGELOG.md)
