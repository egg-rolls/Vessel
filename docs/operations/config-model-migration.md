---
title: models 一次性迁移
kind: current
triggers: [迁移, model-migration, vendors, aliases, 旧块, pre-model-registry.bak, model-registry-migration.json, 悬空 pin, doctor, model_migration, 重录, credentials 拆分]
paths: [packages/config/src/model-migration.ts, src/cli/commands/doctor-command.ts]
---

# models 一次性迁移

> 旧 `models.vendors` / `models.aliases` → `models.credentials` + `models.entries` 的迁移运维手册。
> 新形状与校验见 [config-models](config-models.md)；注册表机制见
> [architecture/config.md](../architecture/config.md#models)。

## 触发与顺序

- **用户层首载自动迁移**（`loader.ts` 首载钩子调 `migrateUserConfigModels`）：检测到
  `models.vendors` / `models.aliases` 即触发；`withConfigLock` 内执行（已在锁内则原地免嵌套，
  `isConfigLockHeld`）。幂等：旧块不存在 → no-op。迁移后重读用户层，后续层叠/校验走新形状。
- 顺序：**yaml 先**（`.pre-model-registry.bak` 备份 + 写前预校验 + 原子写）→ 凭证值重加密复制
  → agent store pin 改写 → 报告。
- 迁移成功给一条 pre-warning：报告路径 `<dataDir>/model-registry-migration.json`、备份
  `config.yaml.pre-model-registry.bak`。
- **项目层旧块不自动迁移**（config 写路径只落用户层）：fail-loud 报错 + 手动迁移指引
  （手动把该文件改成 credentials + entries 形状）。

## 映射规则

| 旧 | 新 |
|---|---|
| vendor id | 凭证 cid = `vendor.credential`（沿用同 id，库值不动）否则 vid |
| vendor baseUrl 缺省 | 物化协议默认端点（`defaults.ts:defaultBaseUrlFor`） |
| 同 cid 异端点 | 按 `(baseUrl, apiKeyEnv)` 拆分；异端点者 cid = vid + 值重加密复制 |
| 模型 | 条目键 = wire（全局唯一时）否则 `vid/wire`（旧 ref 原样可解析）；`name` = wire（键≠wire 时） |
| `pricing.models` | 命中注册 wire 的键搬入 `entry.pricing`（键序首个）；未命中留顶层 + 报告 |
| 多别名指向同一模型 | 字典序首个入 `entry.alias`，其余报告（alias 单值） |
| `models.default` | 经映射表改写 |
| agent store v5 显式 pin | 同批改写 |

## 失败语义

- yaml 写失败 → **fail-fast**（`.bak` 完好，不半写）。
- 旧凭证值不可解密（root 轮换过）→ 只建元数据 + 报告「需重录」（`needsReRecord`），不阻断启动。
- pin 改写失败 → 报告（`pinsFailed`）+ doctor 浮现，不阻断启动。

## 报告与诊断

报告落 `<dataDir>/model-registry-migration.json`（`readMigrationReport`），字段含
`migratedAt` / `entriesCreated` / `credentialsSplit` / `droppedAliases` / `pinsRewritten` /
`needsReRecord` / `pinsFailed` / `errors`；`vessel doctor` 与 `vessel model list` 消费。

`vessel doctor` 的 `model_migration` 检查项：

| 状态 | 条件 |
|---|---|
| fail | 配置里仍有 `models.vendors/aliases`（项目层不自动迁移） |
| warn | 报告有 `needsReRecord` / `pinsFailed` / `errors` |
| info | 报告干净（回显迁移时刻与各类计数） |
| ok | 无迁移报告（no migration pending） |

doctor 还只读交叉检查 agent store（v5）的**悬空 pin / 疑似旧 ref**：pin 未命中注册面且严格面
（`legacyPresent=false`）解析抛 `ModelRefError` → dangling；形如 `vid/wire`（首段非 `legacy:`）
→ suspected（落入 legacy 透传会把整串当 wire 名）。不修改任何记录。