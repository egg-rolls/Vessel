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

1. **q-modes**：拉起 agent（id `8f7edd39-4058-483d-8c71-336d4a66e21b`），让它基于已保全的 WIP 继续完成 S5/S6/S7 模式矩阵审计 + apps/web 同类扫描，跑 `bun run build`，完成后合入 redblue-dev。WIP 含：ConnectionProvider/NodeProvider/nodes.ts/auth.ts + mode-matrix-audit.md。
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

## 五、agent id 速查

- q-validation `6a6bcb84-27c0-42cc-adc5-4a50bded94e1`（完成）
- q-serving `48a51694-aca5-4aa9-b6bb-99a103c2ff00`（完成）
- q-modes `8f7edd39-4058-483d-8c71-336d4a66e21b`（WIP 保全）
- q-pool-design `e680abf4-ca08-41a4-8868-877f08a6f4f8`（待重做）