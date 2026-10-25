# 技术架构

> 当前架构按模块组织，入口：[architecture/INDEX.md](architecture/INDEX.md)。
> 本文只保留重定向与阅读入口；当前事实不要写在这里。

- 模块索引：[architecture/INDEX.md](architecture/INDEX.md)
- 历史版本：[versions/INDEX.md](versions/INDEX.md)
- 决策记录：[adr/README.md](adr/README.md)

## 从哪里开始

- 分层、依赖方向、core 边界 → [overview](architecture/overview.md)
- 一次 run / 循环 / 消息 / 接口 → [runtime-lifecycle](architecture/runtime-lifecycle.md) · [runtime-loop](architecture/runtime-loop.md) · [runtime-api](architecture/runtime-api.md) · [interfaces](architecture/interfaces.md)
- 工具、扩展、配置、事件 → [tools](architecture/tools.md) · [extensions](architecture/extensions.md) · [config](architecture/config.md) · [events](architecture/events.md)
- Gateway / RPC / Web → [gateway](architecture/gateway.md) · [gateway-rpc](architecture/gateway-rpc.md) · [gateway-web](architecture/gateway-web.md)
- **硬安全规则** → [AGENTS.md](../AGENTS.md)
