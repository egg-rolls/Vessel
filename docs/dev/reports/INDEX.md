# 证据索引（reports）

> O(n) 只追加索引。每条一行：版本 | 主题 | 一句话结论 | 链接。
> 容器规则：证据属「历史」，按第 09 条第 2 款进 `reports/<version>/`；只追加、不改写结论。
> 归属：report 按第 01 条第 3 款一律留个人侧，本目录是共享侧存量，迁出后本索引随目录一并退场。
> 管理规则见 [../../DOC-MANAGEMENT.md](../../DOC-MANAGEMENT.md) §4。

| 版本 | 主题 | 一句话结论 | 链接 |
| --- | --- | --- | --- |
| 0.54 | 「刷新时正好有 run 在跑」时间线错乱 | 复现样本与根因；装置 `scripts/probe-midrun-refresh.ts`（当前应当红）；不含修复 | [midrun-refresh-clump](0.54/midrun-refresh-clump.md) |
| 0.54 | 投影纯读侧（`derived_upto_seq` → `projection_cache_seq`） | 缓存水位字段灌任何畸形值，投影产物与 `sessions.get` 出站字节逐字节相同（判据 B-2 成立） | [proj-b3](0.54/proj-b3.md) |
| 0.54 | 投影卡规格 §1.5 实测：压缩/重启后那条工具消息正文 | 落盘正文到底是原文还是占位；装置 `scripts/probe-proj-readback.ts` | [proj-readback-15](0.54/proj-readback-15.md) |
| 0.54 | 存量体检：真实会话里工具结果已是 `[cleared …]` 占位 | 规模、可救性、与撤回的相关性；只读探针 `scripts/probe-stock-audit.ts` | [stock-audit](0.54/stock-audit.md) |

