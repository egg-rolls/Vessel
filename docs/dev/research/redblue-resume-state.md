# 红蓝质量修复 · 关机恢复交接（RESUME STATE）

> 2026-11-23 用户电脑关机前保全快照。**所有分支/工作树/agent 均保留，未删除任何东西。** 拉起后按本文件继续。

## 一、分支与合并状态（redblue-dev 为红蓝开发主线）

| 分支 | 工作树 | 状态 | 已合入 redblue-dev |
|---|---|---|---|
| `redblue-dev` | worktrees/redblue-dev | 主线 HEAD=`28ea00ba` | — |
| `fix/q-validation` | worktrees/q-validation | ✅ 完成 f2f78a5a | ✅ merge `8694a681` |
| `fix/q-serving` | worktrees/q-serving | ✅ 完成 8d3c1b79 | ✅ merge `28ea00ba` |
| `fix/q-modes` | worktrees/q-modes | ⏸ WIP 已保全提交（shutdown-preserve） | ❌ 待完成后合 |
| `fix/q-pool-design` | worktrees/q-pool-design | ⚠️ 两次空输出失败，O4 文档未产出 | ❌ 待重做 |
| `design/q-cli` | worktrees/q-cli | 🆕 工作树已建，agent 未雇（关机推迟） | — |
| `design/q-redblue` | worktrees/q-redblue | 🆕 工作树已建，agent 未雇（关机推迟） | — |
| `design/q-skills` | （仅分支，worktree 未建完） | 🆕 分支已建，worktree 待补建 | — |

## 二、已完成交付（已合入主线）

- **q-validation**：O1 DTO 语义对齐 JSON.stringify（数组 undefined→null 放行；bigint 对齐 throw；function/symbol 故意更严+理由）；O3 七层校验分层文档 `validation-layering.md`（去重删除 0，保守保留 L2↔L1 并登记前置条件）；S3 改形 12 条不变量 owner/oracle。build exit 0。
- **q-serving**：S8 双轨 serving 全链审计 `serving-chain-audit.md`（链 A in-process 14 跳/链 B child 8 跳/链 C RPC 5 跳）；扫出并修齐 8 处同类缺口 G1-G8（关键 G1：statuses() 只遍历 child→in-process embed 档永不成立）；S4 资产 URL 统一到 `apps/web/src/gateway/url.ts`。build exit 0。

## 三、拉起后的续工清单（按序）

1. **q-modes**（大部分已完成，剩收尾）：拉起 agent（id `8f7edd39-4058-483d-8c71-336d4a66e21b`）。**续工入口：读 `docs/dev/research/mode-matrix-audit.md` + `git show 53811383` 即恢复全部上下文。** 已完成：S5 restart 模式保持全链核通（--foreground 设计内拒绝）；S6 三模式核通+修 1 处同类缺口（NodeProvider.fetchAllAttention 改逐节点委托）；S7 全链追踪完；同类扫描基本完成（除已修 1 处无新缺口，G1/G2 留档另批）；注释更正 3 处。**剩余**：① 审计文档收尾 §3 模式矩阵/§4 扫描汇总表/§5 缺口 owner+oracle/§6 门禁读数（现 126 行，§1/§2 完整）；② 跑 `bun run build`（日志落个人侧 docs/dev/tmp/q-modes/gates.log + dist 产物回读）；③ 发最终完成报告。完成后合入 redblue-dev。
2. **q-pool-design（O4）**：两次大文档生成空输出失败。改策略——降阶为最小交付（先只写机制清单表+判定，~40 行，立即提交），或由 main 直接基于已有证据撰写 `pool-complexity-review.md`。agent id `e680abf4-ca08-41a4-8868-877f08a6f4f8`。
3. **新设计/调研单（关机前已建工作树，未雇 agent）**——拉起后雇并派单：
   - `design/q-cli`：CLI 规范架构文档 `docs/architecture/cli-conventions.md`（命令分层/动词契约/生命周期依赖序/输出契约 human+--json/退出码/错误格式/颜色无障碍/单一渲染模块）。
   - `design/q-redblue`：红蓝版本手册调研 `docs/dev/research/redblue-operations-manual.md`（调研业界蓝绿/金丝雀/特性开关方法，映射 vessel 原语，补现有 version-isolation-blue-green.md 的缺口）。可用 web_search。
   - `design/q-skills`：SKILLS 插件设计 `docs/dev/plans/skills-plugin-design.md`（先补建 worktree：`git worktree add worktrees/q-skills design/q-skills`；调研 plugin-sdk/plugin-host，设计 skills 管理+agent 查看/加载能力，严守软件工程规范）。
4. **计划 C（src 大重组）**：用户裁定「开发者开发完成后」执行——即 q-modes/q-pool-design 合入后。把 ~94 个平铺文件按前缀簇搬进 ~15 个领域目录，全仓 import 重写，定管理规范+领域关键词。详见用户 2026-11-23 指令。
5. **最终合并树门禁**：全部合入后由一个实施 agent 在 worktrees/redblue-dev 跑 `bun run build`（宪法：门禁由 N 跑，main 不亲自跑），备产物读数。
6. **用户行为验收**（宪法第四条，agent 不代跑）：重点 q-serving I1（代理模式 model-registry 走 embed 档 200）/I3（双路启用不崩）/I7（plugins.list 单行带 mode:'in-process'）；q-validation 四类信封可选路径。

## 四、宪法约束（所有续工 agent 必须遵守）

- 不写测试文件（任何位置，*.test.*/*.spec.*/__tests__/夹具全禁）；不跑探针/烟测/临时进程/端口/data dir。
- 行为验证归用户本人；需要行为证据只读真实日志/数据；绝不写 ~/.vessel、不重启 8642/8644。
- 唯一构建期检查 `bun run build`，独立看 exit code + 产物读数（WSL 退出码可能谎报 0）；日志落个人侧 docs/dev/tmp/<slice>/gates.log。
- 不碰主 checkout D:\Application\APP\Vessel\Vessel（生产节点在跑）；只提交自己分支；不 merge（main 合）；不雇子 agent。
- 工具路径域：read/write/edit/codegraph 用 D:/ 路径；bash sync 在 WSL 用 /mnt/d/ 路径。

## 五、agent id 速查（2026-11-23 重启后重雇，旧 id 已失效）

> 关机释放了所有承包 agent；已完成工作已合入主线无需重雇。以下为重新雇佣的 id。

- q-modes `8e211225-838d-448a-8348-bd938ccea7e0`（接续 WIP 53811383 收尾）
- q-pool-design `cec3e278-53ee-4521-9b41-acebdbb23f34`（O4 降阶增量重做）
- q-cli `a8635904-e67a-4fef-8353-5b5ae8a18cb0`（CLI 规范架构文档）
- q-redblue `fd35b181-75cd-47de-a7b5-c79b071157c6`（红蓝手册调研）
- q-skills `79f401ec-489e-4925-b553-b11f65c24886`（SKILLS 插件设计）
- q-kanban `845397aa-2722-438d-aaa3-a0ceddd10da0`（任务看板插件设计）
- q-settings `84838fe0-848f-4a9b-8ebc-fa794d240cf4`（VSCode 式设置重构设计）
- 已完成（无需 agent）：q-validation（merge 8694a681）、q-serving（merge 28ea00ba）

## 六、任务看板（main 维护，用户直接看，无需 main 逐次汇报）

- 看板文件：`docs/dev/kanban/board.json`（redblue-dev 分支，commit 106e1c16）。schema：columns + tasks[id/title/column/owner/branch/progress]。
- main 每次任务状态变化即更新此文件；未来 q-kanban 插件只读此文件弹窗展示。历史完成任务归档至 archive.json。
- 用户新增需求（2026-11-23）：看板插件 + VSCode 式设置重构（检索/插件设置域/视觉分区/设计实验室归视觉/设置移右上角替换 gateway 图标）——已派 q-kanban/q-settings 设计。