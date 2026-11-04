# 当前版本

> O(1) 当前态：整文件覆盖，只写当前事实。历史见 [INDEX.md](INDEX.md)，
> 本文只回答「现在到哪了、下一步是什么」。

## 版本

**0.40.0（2026-11-04）** — 未 tag、未 publish、未 bump。版本号以根 `package.json` 为唯一来源；
当前 manifest 仍是 `0.33.0`；收口时 `bun run scripts/version.ts 0.40.0`（写模式）只同步各 manifest，
不改 `CHANGELOG.md` 与本文件，那两处由 1 手工切换（`--check 0.40.0` 在 bump 前会 exit 1，不能当前置步骤）。
0.39（create 原语 / 会话分支）的代码已收口，是本线基线；治理面收口随 egg/UI 分支合并后的最终 main 成立。

## 已合入

- **文档行数门禁转绿（0.39 已完成，非本批改动）**：`docs/architecture/gateway.md` 101 → 100 行
  （ef83a137）、`gateway-rpc.md` 103@dda00a5f → 98@1f7da374 → 99@ef83a137，
  `bun run scripts/check-docs.ts` exit 0；0.40 本批未改这两份文件。
- **i18n 孤儿检测（I5）**：`scripts/check-i18n.ts` 新增 I5，默认 warn + `--orphans` 全量报告；
  gov 分支 catalog 保持 1402 键（79 孤儿，只报告）。web 线 `bf7d6c0c` + `3bdc06ce` 删 74 个后
  catalog 1316 键、孤儿 2（`team.role.member` / `team.role.temporary`，动态拼接可达，必须保留）。
- **biome 覆盖边界**：`**/*.md` 移出 biome 范围（markdown 排版归 `check-docs`，同时防 biome 2.6.x
  起把 md 纳入格式化造成假红），`biome ci`（2.5.15）exit 0。
- **基线**：0.39 的 `agents.create{from_session_id}` / `sessions.create|restart|activate` 方法表、
  删除面与事件口径已在 current 文档中。

## 下一步

- **孤儿清理由 web 线收尾**：`bf7d6c0c` 删 32 个、`3bdc06ce` 再删 42 个，复测 catalog 1316 /
  孤儿 2（两个动态拼接 key，必须保留，预期值就是 2）；清单与判定规则见
  `docs/dev/reports/0.40/i18n-orphans.md`。
- biome warning（`main` 上 3 条）：`chat.css:555` / `:601` 已由 web 的 `862b698c` 修掉，
  `basic-tools/src/index.ts:284` 已由 ext 的 `ca639ff7` 豁免；随 egg/UI 分支合并后的最终 main
  为 **0 warning**（单独合 gov 时 `main` 仍是 3 条）。
- 收口时 bump：`scripts/version.ts 0.40.0` 只改写 manifest；本文件与 `CHANGELOG.md` 由 1 手工切换。

## 入口

- 版本历史：[INDEX.md](INDEX.md)
- 当前版本变更摘要：[../../CHANGELOG.md](../../CHANGELOG.md)（收口 bump 时切到 0.40.0）
