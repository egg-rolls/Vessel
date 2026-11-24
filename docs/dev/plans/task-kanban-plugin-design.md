# 任务看板插件（kanban）设计

> 状态：设计中（q-kanban，design/q-kanban 分支）
> 任务书：main 派单「任务看板插件设计（只读文件弹窗+路径设置）」。
> 性质：**纯设计文档，不改代码**。实施按 §12 分期，另派单执行。
> 宪法约束：零测试 / 零探针 / 零临时进程；构建期检查只有 `bun run build`；行为验证由用户手动完成。

## 0. 用户意图（硬约束，全文贯彻）

1. **看板文件只存当前内容，不存历史消息**；历史（已完成）任务归档到**其他文件**（archive），板只留当前。
2. 插件**只读**「配置的文件路径」指向的文件，以**弹窗 / 页面**展示；插件不写看板文件。
3. 提供**设置项**：可添加 / 配置插件的展示文件路径，**支持多路径**。

参考实例：`redblue-dev` 分支 `docs/dev/kanban/board.json`（main 维护），现有形状：

```jsonc
{
  "board": "vessel 红蓝开发任务看板",
  "updated": "2026-11-23T23:30:00+08:00",
  "columns": ["待办", "进行中", "已完成", "阻塞"],
  "note": "本文件由 main 维护，任务看板插件只读此文件弹窗展示。历史完成任务归档至 archive.json，本板只留当前内容。",
  "tasks": [
    { "id": "q-validation", "title": "…", "column": "已完成", "owner": "q-validation",
      "branch": "fix/q-validation", "progress": "已合入 redblue-dev (merge 8694a681)，build exit 0" }
    // …
  ]
}
```

本设计以该形状为基线做 **additive 优化**（§4）：现有 board.json **零改动即可被插件读取**。

## 1. 调研结论（现有机制盘点）

| 机制 | 现状 | 对本设计的意义 |
| --- | --- | --- |
| 插件形态 | 一套 loader / manifest；能力插件 in-process，体验插件 child+iframe（`docs/architecture/plugins.md`） | kanban 选 **in-process + embed UI**（§2） |
| in-process RPC | `Plugin.rpc(name, params)`，装配层 `registerInProcessPlugin` 接进 `PluginRpcRegistry`，canonical `plugin.<id>.<name>`，read/write 权限 + DTO 校验（`src/plugin-host-assembly.ts`、`packages/serve/src/plugin-host/registry.ts`） | kanban 的数据面走同一机制，不自造注册路径 |
| embed UI | `ui.embed` + `pages[].component`，builtin 自动 `embedded` 档，宿主 import 插件 ESM 同源渲染；SDK `createPluginHost`（`docs/architecture/plugin-embed.md`、`packages/plugin-sdk`） | 看板页用 embed 档；iframe entry 保留作 isolated 回退 |
| 宿主 SDK 面 | P2 最小面：rpc / events.subscribe / theme / toast / i18n / log / permissions.has；**dialog / router / mounts 在 P3 未落地** | 「弹窗」一期不做宿主级 dialog，用页面承载（§7.3） |
| settings 贡献点 | `contributes.settings`：JSON Schema 子集（type/description/default…），**宿主 v1 不自动渲染表单**；值存 `config.yaml plugins[].config`，激活时下发（child 经 settingsFor，in-process 经 install config） | kanban 声明 settings 域；渲染交给 q-settings（§10），过渡期页面内置设置节 |
| settings 写路径 | `config.set` 白名单**不含 plugins[]**；先例：model-registry 自持 write RPC，经 `withConfigLock` 读改写 config.yaml 自己的块 | kanban P1 同模式自持 `settings.set`；P2 提宿主通用 `plugins.settings.set`（§5.4） |
| 文件监听 | `src/plugin-watch.ts`（插件目录+config.yaml，300ms 去抖）、`src/config-watch.ts`；**无任意文件监听、无插件→UI 事件推送通道**（events 只有宿主→插件转发） | 刷新 P1 = 手动 + 可见期轮询（ifMtime 廉价比对）；推送列 P3 候选（§8） |
| 参考插件 | `plugins/provider/model-registry`（in-process + rpc + embed 双页 + fs 声明 + config.yaml 写）；`plugins/observability/usage`（embed 双产线样本） | kanban 目录 / 构建 / 装配全部照这两个先例 |
| 导航 | 内置组 chat/network/runs/integrations/status/observe/settings/top/plugins + 自定义 `plugin:<id>` 组；图标白名单 | 看板页挂 `status` 组，icon `runs`（§7.1） |
| 版本 | 仓库 0.56.0；plugin-sdk 1.0.0（独立版本线） | `engines.vessel: ">=0.56.0 <1.0.0"`，`runtime: { react: "^19", sdk: "^1" }` |

## 2. 形态决策

**决定：builtin in-process 只读插件 + embed 页面**，落位 `plugins/observability/kanban`，id `kanban`。

- in-process：需要直接读宿主文件系统上「配置的路径」；child 插件只有 data-dir 注入，读任意配置路径要另开缝，得不偿失。
- 只读：不注册 tool / provider / hook / guardrail，不影响 run 与模型输入；只贡献 pages / rpc(read) / settings / i18n。唯一 write RPC 是 `settings.set`（写的是 config.yaml 的 kanban 配置块，**不是看板文件**）。
- embed：builtin → 自动 embedded 档，无 TOFU 确认负担；isolated iframe 回退保留（契约要求 entry 必填）。
- 备选与否决理由：
  - child 体验插件：读配置路径需要新权限缝 + 子进程开销，否决。
  - 纯 apps/web 域（不做插件）：违背「插件 + 设置贡献点」的任务书，且无法被 q-settings 以插件域统一收纳，否决。
  - 能力插件注册 `kanban` 工具给 agent：与用户「弹窗/页面展示」意图无关，徒增每轮 token 税，否决。

## 3. 架构图

（待扩充：数据流 / 配置流 / 信任边界 ASCII 图）

## 4. 看板文件 schema（v1，兼容 v0）

（待扩充：Board / Column / Task / Archive DTO、归一化与校验策略、markdown 板 P2）

## 5. 设置贡献与多路径配置

（待扩充：contributes.settings 键表、config.yaml 示例、路径解析与读边界、写路径 P1/P2）

## 6. RPC 接口契约

（待扩充：plugin.kanban.* 方法表、参数/结果 DTO、错误码、ifMtime 轮询协议）

## 7. UI 设计（页面 + 弹窗路线）

（待扩充：线框、卡片、归档视图、错误/空态、样式与 i18n 契约、弹窗分期）

## 8. 刷新机制

（待扩充：手动 / 可见期轮询 / focus；fs.watch+事件推送为何列后期）

## 9. 归档策略

（待扩充：维护者约定、archive.json schema、containment、插件只读归档视图）

## 10. 与 q-settings 的协同

（待扩充：设置域注册、schema/现值/写路径三件套、检索与视觉分区、过渡期 fallback）

## 11. manifest 示例与工程结构

（待扩充：package.json vessel 块全文、目录树、build:ui 双产线、装配接线点）

## 12. 分期计划

（待扩充：P1 最小闭环 / P2 归档+设置协同 / P3 弹窗+推送，各期交付与验收）

## 13. 风险与缓解

（待扩充）

## 14. 参考

- `docs/architecture/plugins.md` / `docs/architecture/plugin-embed.md` / `docs/adr/ADR-102-host-level-ui-mount.md`
- `packages/plugin-sdk/src/index.ts`、`src/plugin-manifest.ts`、`src/plugin-host-assembly.ts`、`src/plugin-config.ts`
- `packages/serve/src/plugin-host/registry.ts`、`packages/serve/src/gateway/methods/config.ts`
- `plugins/provider/model-registry/**`、`plugins/observability/usage/**`
- `redblue-dev:docs/dev/kanban/board.json`