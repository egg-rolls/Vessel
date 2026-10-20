---
adr: 5
title: 双层配置——用户身份与项目行为分离
status: accepted
date: null
---

## ADR-005：双层配置——用户身份与项目行为分离

- **上下文**：旧 Vessel 强制"不内置默认 provider/model/base_url/价格"，却给 temperature/iterations 等行为默认，教条自相矛盾。同时 `.env` 和 `vessel.yaml` 混用，API Key 散落各处，无基础用户困惑。
- **决策**：
  1. 内置安全默认（provider 预设列表 + 行为默认），用户填 Key 即跑。
  2. **Key 永远用户自备，不内置任何厂商 Key/价格。**
  3. **配置分两层**：`~/.vessel/config.yaml`（用户身份：Key + provider 偏好，跨项目复用）+ `vessel.yaml`（项目行为：工具/限额/插件，跟着仓库走）。
  4. `api_key` **只存** `~/.vessel/config.yaml`，**不进入** `vessel.yaml`（后者可安全 git commit）。
  5. 加载优先级：CLI flag > `VESSEL_*` env > `vessel.yaml` > `~/.vessel/config.yaml` > 安全默认。
  6. `.env` 不是 Vessel 的配置机制（保留 `VESSEL_*` 环境变量用于 CI/容器/自动化）。
  7. 首启向导产出 `~/.vessel/config.yaml`，此后所有项目自动可用。
- **后果**：无基础用户填一次 Key 即可在所有项目使用；项目配置不含密钥可安全共享；环境变量退居自动化场景。代价：需维护 `~/.vessel/` 目录的创建/读写逻辑。
- **关联**：legacy/LESSONS 教训5；[SPEC.md](SPEC.md) §6。
