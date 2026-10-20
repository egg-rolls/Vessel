---
adr: 60
title: CLI 一次性命令改用有序注册表
status: accepted
date: 2026-10-20
related: [20, 28, 57]
tags: [cli, commands, refactor, registry]
---

## ADR-060：CLI 一次性命令改用有序注册表

- **上下文**：`src/cli.ts` 曾用一条顶层 `if` 链处理所有一次性命令（`--tools`、`update`、`--resume-run-list`、`workflow`、`eval`、`config`、`tenant`、`migrate`、`trace`、`plugin`、`doctor`）。链条与 REPL / serve / headless 的选择逻辑混在同一函数里，约 150 行；新增命令只能继续往链尾追加，命中顺序和退出码处理散落在各分支，难以测试单个命令是否存在。

- **决策**：
  1. **新增 `src/commands/registry.ts`**，导出 `CliCommand`（`name` / `match(args)` / `run(args, ctx)`）与有序数组 `cliCommands`。`match` 只做参数形态判断，`run` 返回退出码（`undefined` 等价于 0）。
  2. **有序命中即停**。`matchCommand(args)` 用 `find` 返回首个命中的命令；数组顺序与迁移前 `if` 链的短路顺序一致（`tools` → `update` → `resume-run-list` → `workflow` → `eval` → `config` → `tenant` → `migrate` → `trace` → `plugin` → `doctor`）。`--help` / `--version` 仍在入口处先行处理，不进入注册表。
  3. **`cli.ts` 只做入口编排**：解析全局参数 → `matchCommand` → 执行 → 统一 `process.exitCode`。主 REPL、`--serve`、headless 路径不经过注册表，行为与清理流程不变。
  4. **命令上下文最小化**：`CliCommandContext` 目前只含 `useMock`（`VESSEL_MOCK=1|true`），避免把整个 bootstrap 结果塞进注册表。
  5. **输出归一**：一次性命令统一经 `printCommandResult({ exitCode, stdout, stderr })` 写 stdout / stderr 并返回退出码；继续复用 `src/*-command.ts` 的既有实现，不复制业务逻辑。

- **备选**：(a) 保留 `if` 链、只按函数拆段——命中顺序仍与实现耦合，新增命令依旧要改同一处；(b) 用 commander / yargs 等参数解析框架——引入新依赖，且现有 `parseArgs` 的语义（`--run` 的 stdin / `@file`、隐藏别名等）需要重写；(c) 让每个命令自行 `process.exit`——跳过统一清理，也失去可测试的退出码返回；(d) 用 map 按首 token 查表——无法表达 `--tools`、`--resume-run-list` 这类无子命令的 flag 形态。均不取。

- **后果**：新增一次性子命令只需在 `cliCommands` 追加一项并写自己的 `match` / `run`，`cli.ts` 不再增长。代价是命令顺序成为语义的一部分：把宽泛的 `match` 放到前面会遮蔽后面的命令，新增项的位置需要显式考虑。注册表只覆盖一次性命令，REPL / serve / headless 的入口选择仍未抽象。

- **关联**：ADR-020（双轨命令体系）、ADR-028（registry 接口化）、ADR-057（CLI flag 必须经 `buildCliConfigOverrides()` 进入配置层）；`src/commands/registry.ts`、`src/cli.ts`、`src/cli-args.ts`。
