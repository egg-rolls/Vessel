---
title: CLI 命令与输出规范
kind: target
triggers: [cli, command, verb, start, stop, restart, status, reload, fleet, 舰队, 动词, 退出码, exit code, 输出, json, NO_COLOR, 颜色, 无障碍, tools-engine, 生命周期, 依赖序, drain, resume, 错误码, 渲染, src/cli]
paths: [src/cli.ts, src/cli-args.ts, src/cli-help-spec.ts, src/cli-help.ts, src/commands/**, src/*-command.ts, src/ui-style.ts, src/tools-engine/supervisor.ts, src/gateway/node-supervisor.ts, src/gateway/pool-supervisor.ts]
---

# CLI 命令与输出规范

> **状态标记**：〔现行〕= 代码已实现、本文只做规范化表述；〔提案〕= 目标态设计，落地前以本文为准绳。
> 事实源：命令分派见 [cli-wiring.md](cli-wiring.md)，进程归属见 [gateway-lifecycle.md](gateway-lifecycle.md)。
> 本文是**规范**（conventions）：动词怎么定义、生命周期归谁、输出长什么样、退出码与错误码怎么稳定。
> 纯设计文档，不改代码；落地重组（src/cli/ 领域目录，与计划 C 合一）见 §8。

## 0. 一段话

（待扩充）

## 1. 两层命令模型与命令分类表

（待扩充）

## 2. 动词契约

（待扩充）

## 3. 生命周期归属与停止依赖序

（待扩充）

## 4. 输出契约（单一渲染实现）

（待扩充）

## 5. 退出码表

（待扩充）

## 6. 错误格式与稳定码

（待扩充）

## 7. 颜色与无障碍

（待扩充）

## 8. 落地布局：src/cli/ 领域目录（与计划 C 重组合一）

（待扩充）

## 9. 兼容与演进规则

（待扩充）