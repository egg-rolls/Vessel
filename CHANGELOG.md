# Changelog

> 本文件是 O(1) 当前态：**只保留当前版本的变更摘要**。
> 所有历史版本在 [`docs/versions/`](docs/versions/INDEX.md) 中按版本一文件保存，
> 索引见 [`docs/versions/INDEX.md`](docs/versions/INDEX.md)，当前版本见
> [`docs/versions/CURRENT.md`](docs/versions/CURRENT.md)。
>
> 变更记录遵循 [Keep a Changelog](https://keepachangelog.com/)。
> 标准 SemVer（用户裁决 2026-11-25 终版）：breaking→major / feature→minor / fix→patch。
> 版本 = 代码契约身份，不绑发版节奏。major=2（单一真相源架构 breaking）。
> 管理规则见 [`docs/DOC-MANAGEMENT.md`](docs/DOC-MANAGEMENT.md)。

## [2.1.0] - 2026-11-25

> 第四轮批次晋升（红蓝金丝雀验收 14–22 全闭环，ISSUE-CR22-1 / ISSUE-SS2-1 CLOSED）。
> feature→minor（RELEASE §1）；含第五轮四面（thinking-plugin / swr-refresh / context-fix / plugin-lifecycle-impl）搭晋升，金丝雀批次 B 验收候启动。
> 完整明细（合并链 / 验收 / 逐条变更与已知问题）见 [docs/versions/2.1.0.md](docs/versions/2.1.0.md)。

### 新增

- 任务看板（`kanban.get` / `kanban.archive` + 三列视图 + 勾选验收归档）/ 优雅停止·自重启（缺省 drain-to-quiesce + `restart --self` + `vessel ps`）/ 插件生命周期（per-capability + O5 badge + 注销 API）/ 思考强度插件 / SWR 刷新 / 拖拽引用 / inbox 编辑级联消费与撤回真删 / bash async 缺省不限时 / 配置责任链（显式 config > env）。

### 修复

- 卡片健壮性（permission 同构 P-A + PII 按需载体）/ hydration-anon（ISSUE-CR22-1）/ 上下文口径通知虚高 170K / plugin-ui-layer（ISSUE-SS2-1）/ 内置插件恒兼容去版本门禁 / skills-style / empty-state / DR15-1 优雅退出挂起（node 侧 CLOSED✅）/ DR15-2 platform 停 30s 看门狗污染（迭代 2 修复已合并 1aba69c0）。

### 变更

- 内置插件不再受 `engines.vessel` 版本门禁（第三方保护不变）；stop / restart 缺省不限时优雅 drain（用户裁定 #5），`--force` 唯一非优雅退出 + 审计。

### 已知问题（第五轮处置）

- ISSUE-DR15-1 node 侧 CLOSED✅（金丝雀 7 判据全 PASS）；ISSUE-DR15-2 迭代 2 已合并，候金丝雀 cli 修正判据复验闭环；plugin_manifest_invalid thinking-intensity（批次 B 登记）。
