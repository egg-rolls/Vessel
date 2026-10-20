---
adr: 73
title: npm scope 归属：子包统一为 @vessel-agent/*
status: accepted
date: 2026-10-20
related: [6, 71]
tags: [distribution, packaging, npm, release, scope, naming]
---

## ADR-073：npm scope 归属：子包统一为 @vessel-agent/*

- **上下文**：0.10 已经确定根包发布名为 `vessel-agent`（ADR-071），但 18 个可发布子包仍叫 `@vessel/*`。npm scope 必须先占用才能发布；`@vessel` 不是本项目可控的组织，继续使用会在发布时直接失败。用户在 npm 创建了 `vessel-agent` 组织，可用的 scope 是 `@vessel-agent`。此时源码、manifest、脚本和当前文档里已经存在大量 `@vessel/*` 引用，历史 ADR 与 CHANGELOG 也保留着当时的包名。

- **决策**：
  1. **子包 scope 统一为 `@vessel-agent/*`**：18 个可发布子包（5 个库包 + 13 个插件包）的 `name`、包间精确版本依赖与 import specifier 全部改为 `@vessel-agent/*`；根包名保持 `vessel-agent`，bin 仍是 `vessel`。
  2. **同步所有活引用**：源码 import、workspace manifest、`scripts/{version,release-dry-run,check-deps,smoke-subpaths,smoke-install}.ts` 的前缀、当前维护文档一并更新；接收 372 个文件的改动。新代码不得再引入 `@vessel/*`。
  3. **历史不改写**：`docs/adr/` 下的历史 ADR 与 `CHANGELOG.md` 的既往版本段落保留原包名，作为决策存档；只有当前文档与代码向 `@vessel-agent/*` 对齐。
  4. **发布顺序不变**：`core → permission → config → serve → tui → plugins`，最后发布根包 `vessel-agent`；根包依赖子包的精确版本，不得先发根包。
  5. **门禁覆盖重命名**：`release-dry-run` 校验 18 个包名与版本，`smoke-install` 用 `@vessel-agent/*` 的本地 `file:` overrides 安装并运行 `vessel --version` / `VESSEL_MOCK=1 vessel --tools`；`check-deps` 与 `smoke-subpaths` 按新前缀解析。

- **备选**：(a) 继续使用 `@vessel/*`——组织不可控，发布必然失败；(b) 改为 unscoped 包名（如 `vessel-core`）——命名空间分散、易与既有包冲突，且失去组织级访问控制；(c) 发布时用 npm alias / deprecated 旧名转发——需要同时维护两套包名与 dist-tag，用户安装路径也不稳定；(d) 只改 manifest 不改 import——workspace 内部解析会断，测试与 typecheck 直接失败。均不取。

- **后果**：所有嵌入式使用者必须把 import 从 `@vessel/*` 改为 `@vessel-agent/*`；这是 0.x 阶段的 breaking 变更，按约定走 minor（0.11.0）。发布账号必须对 `vessel-agent` 组织有写权限。历史 ADR / CHANGELOG 中仍可检索到旧名，属于有意保留；当前文档与脚本以 `@vessel-agent/*` 为准。根包名与 scope 名相同（`vessel-agent` 与 `@vessel-agent`）容易混淆，文档需分别说明：安装命令是 `npm i -g vessel-agent`，子包是 `@vessel-agent/<name>`。

- **关联**：ADR-006（npx 分发）、ADR-071（根包 vessel-agent 与安装解析 smoke）；`package.json`、`packages/*/package.json`、`plugins/*/*/package.json`、`scripts/{version,release-dry-run,check-deps,smoke-subpaths,smoke-install}.ts`、`docs/operations/{RELEASE,CI-CD}.md`。
