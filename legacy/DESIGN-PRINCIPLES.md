# 新 Vessel 设计原则与边界

> 本文是新项目的 SPEC 起点。继承旧版四层纪律与执行模型，针对 `LESSONS.md` 的教训设新约束。

---

## 一、新定位

面向无基础/弱基础用户的 Harness **应用**（非框架），三层结构：

1. **core 运行时**（`@vessel/core`）：tool-calling loop、provider 抽象、context/session、events、tool registry、插件宿主。纯库，无 UI。
2. **TUI 控制层**（`@vessel/tui`）：Claude-Code 式交互终端，调用 core。无基础用户入口。
3. **声明式配置层**（`@vessel/config`）：YAML/TOML + 向导定义 agent/工具；高级用户逃逸到 TS 插件。

无基础用户用 TUI；弱基础用户改配置；开发者写插件。一个产品通吃。

---

## 二、能力分层（继承四层纪律，重述）

| 层 | 规则 |
|----|------|
| **内置（core）** | 大多数 harness 都需要、领域无关、可接口化、轻依赖、不绑定厂商。 |
| **插件（扩展）** | 领域/重依赖/可选能力（memory/MCP/corrections/resilience/evals/OCR/PDF…）。不进 core，显式注册。 |
| **应用层** | TUI、配置向导、业务 agent。 |

**进 core 的决策树**（继承）：是否大多数 harness 需要？是否领域无关？是否可接口化？是否轻依赖？是否不绑定厂商？全"是"才进 core；否则进插件或应用层。

> **硬约束**：运行时构造函数**不得**注入 guardrails/memory/MCP/corrections/resilience 等插件对象（教训 2）。这些通过统一插件接口挂载。

---

## 三、核心执行模型（继承）

- **tool-calling loop**：调 LLM → 解析 tool_calls → 执行 → 注入 → 循环到文本响应或达上限。
- **Run/Session 分离**：Run=单次执行，Session=跨轮会话。
- **统一事件流**：所有中间过程发结构化事件；trace/replay/TUI 复用同一份数据。流式=订阅事件，非另一 runtime（教训 10）。
- **控制面**：UsageLimits / TerminationPolicy / Guardrails（四阶段）作为 runtime 骨架前置，非后补（继承 GAPS Phase 1）。

---

## 四、新约束（针对教训）

1. **core 极小**：runtime 只管 loop + 事件 + 状态；guardrails/memory/MCP/corrections/resilience/evals 全是插件，通过统一接口挂载，不在 core 构造函数。
2. **单一扩展心智**：tool/provider/hook/guardrail/plugin 用同一种声明式注册（TS 装饰器 + schema 自动生成），不搞 4 套（教训 3）。
3. **默认即用 + 可覆盖**：内置安全默认（provider 预设列表 + 行为默认），用户填 Key 即跑；放弃"无默认"教条（教训 5）。**Key 永远用户自备。**
4. **零配置起步 + 渐进披露**：开箱即用；高级旋钮藏到 `vessel.yaml`/向导，不默认暴露 33 个键（教训 4）。
5. **事件有类型注册表**：事件类型枚举 + payload schema，不散落字符串（教训 8）。
6. **不可变 + 构造完整**：状态构造时注入，不外部改私有（教训 7）；全异步，不 sync-in-async（教训 6）。
7. **文档极简**：几页够用；复杂度靠抽象消除，不靠文档解释（教训 12）。
8. **不留半成品**：要么实现要么不做，不留 stub 分支（教训 11）。
9. **MVP 范围**：只做 GAPS Phase 1 骨架 + TUI + 配置层；workflow/team/durable/evals 延后（教训 14）。

---

## 五、语言与架构决策

- **语言**：TypeScript（Claude Code/Cline/Continue 同栈；Ink 做 TUI；MCP SDK 生态；前后端同构）。理由见对话记录与 `LESSONS.md` 教训 13。
- **分发**：`npx vessel` 零安装，或 `bun build --compile` 单二进制。
- **三包**：`@vessel/core` / `@vessel/tui` / `@vessel/config`。
- **依赖**：保持精简（对应旧版 httpx/pydantic/pyyaml 的克制）。

---

## 六、反幻觉纪律（继承）

- 文档只写已实现；规划项标 `[plan]`。
- 不吹 MCP/RAG/evals 等未实现能力。
- 代码与文档不一致时，改其一，不留矛盾。
