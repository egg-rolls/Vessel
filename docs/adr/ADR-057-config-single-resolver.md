---
adr: 57
title: 配置单一 resolver
status: accepted
date: 2026-10-19
related: [5, 19, 46, 49, 50, 51]
tags: [config, cli, precedence, connect]
---

## ADR-057：配置单一 resolver

- **上下文**：0.7 及以前，CLI flag 在多个位置被各自合并：`resolveServeOptions(config, cli)` 单独接收 argv，`bootstrapConnect` 直接读 `process.env.VESSEL_CONNECT_TOKEN` / `VESSEL_GATEWAY_TOKEN` / `VESSEL_CONNECT_CA`，`allowed_origins` 又在 `cli.ts` 里做一次 CLI > config 选择。层序虽然文档上固定为 `CLI > env > tenant overlay > project > user > default`，但实际合并点分散，容易在某条路径上漂移；connect 的 env 变量也不在 config 层里，`config show --sources` 看不到。`ConfigLoadOptions.defaults` 的名字也无法表达“这是最高优先级的 CLI 层”。

- **决策**：
  1. **唯一合并点**。所有配置层只在 `packages/config` 的 `loadConfig()` 合并一次，顺序固定为 `CLI > env > tenant overlay > project > user > default`；应用层不再自行拼接 argv / env。
  2. **`cliOverrides` 取代 `defaults`**。`ConfigLoadOptions` 新增 `cliOverrides?: Partial<VesselConfig>`；`defaults` 标记 deprecated，作为同义层先应用，`cliOverrides` 后应用（因此优先）。两层都标注 `source=cli`。
  3. **CLI 覆盖层只含显式 flag**。新增 `src/cli-overrides.ts` 的 `buildCliConfigOverrides()`：`serve.port` 只在用户显式给出端口时写入；`serve.hostname` / `allow_remote` / `tls`（必须成对）/ `allowed_origins`（整体替换 YAML 列表）只在对应 flag 出现时写入；`connect.token` / `connect.caFile` 同理。未给出的字段不进入 CLI 层，从而让 env / project / user / default 正常生效。
  4. **serve 解析不再接收 argv**。`resolveServeOptions(config)` 只做 `serve.*` → 默认值补全与启动前校验（回环 / `allow_remote` / TLS 成对）；不再有 `ServeCliInput`，CLI 值已由 loader 合并。`--serve` 未显式给端口时使用 `DEFAULT_SERVE_OPTIONS.port`（8642），与旧行为一致。
  5. **connect token / CA 走 `config.connect`**。loader 的 env 层新增 `VESSEL_CONNECT_TOKEN` / `VESSEL_CONNECT_CA`；`VESSEL_GATEWAY_TOKEN` 仅在 `VESSEL_CONNECT_TOKEN` 缺失时作为 token 回退（保持 0.6 兼容）。`bootstrapConnect` 只读 `config.connect?.token` / `config.connect?.caFile`，不再读 argv / `process.env`；`serve.token` / `transport.token` 仍作为**配置层内**的旧版回退保留。
  6. **兼容性**：所有既有 CLI flag 名称与语义不变；`defaults` 调用方继续可用（只是 deprecated）；`tokenEnv` 语义不变（loader 在 env 层解析）。嵌入方若直接调用 `bootstrap` 并依赖旧的 `connectToken` / `caFile` 选项，这两个选项仍被接受，并折入 `cliOverrides.connect`。

- **备选**：(a) 在每个入口各自维护一份优先级——正是本次要消除的漂移来源；不取。(b) 让 `resolveServeOptions` 继续接收 argv，只把 connect 收敛——仍有两个合并点，`allowed_origins` 等字段容易再次分叉；不取。(c) 把 CLI flag 全部预解析进 env——会污染环境变量语义，且无法区分“显式 flag”与“部署环境”；不取。(d) 直接删除 `defaults`——破坏既有嵌入方；不取。

- **后果**：配置来源可以在一处审计，`config show --sources` 能反映 connect token / CA 的环境来源。代价是 CLI 必须先把 flag 组装成 `Partial<VesselConfig>`（`buildCliConfigOverrides`）；任何新 flag 都要加到这一层，否则不会生效。`--allow-remote` 只能置 true、不能通过 CLI 关闭；`allowed_origins` 是整体替换而非追加。直接调用 `bootstrap` 的嵌入方应改用 `cliOverrides`。

- **关联**：ADR-005（双层配置）、ADR-019（YAML snake_case 映射）、ADR-046 ~ ADR-050（存储 / 配置 / 密钥分层）、ADR-051（远程控制面）；`src/cli-overrides.ts`、`src/serve-config.ts`、`src/bootstrap.ts`、`packages/config/src/loader.ts`、`packages/config/src/types.ts`。
