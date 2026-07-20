# Vessel 遗产与教训

> 本文件记录旧 Vessel 项目（Python，~7200 行，Alpha）的经验教训，供新项目（面向无基础/弱基础的 Harness 应用）为鉴。
> 代码将被推翻，故本文件只记**现象与原因**，不引用具体文件/行号。

---

## 一、可继承的资产

1. **四层能力分层 + core 准入决策树** — core / built-in reference / optional extension / example 四分；"进 core 前必须证明：大多数 harness 需要、领域无关、可接口化、轻依赖、不绑定厂商"。罕见的好纪律，新版改为"内置/插件/应用层"继续用。
2. **Gap 分析方法论** — 系统对标 Anthropic Effective Agents / OpenAI Agents SDK / Pydantic AI / AutoGen / LlamaIndex Workflows / LangSmith，找生产控制面缺口并排优先级。可复用的调研方法。
3. **核心执行模型** — "调 LLM → 解析 tool_calls → 执行工具 → 注入结果 → 循环到文本响应"；Run（单次）/Session（跨轮）分离；结构化事件流（trace/replay/UI 复用一份数据）。骨架正确，新版继承。
4. **生产控制面意识** — "Agent 自主性越高越需要硬预算"：UsageLimits / TerminationPolicy / Guardrails（输入/输出/工具调用/工具结果四阶段）。多数新手框架缺这块。
5. **反幻觉文档纪律** — 文档区分"已实现 vs 规划中"（如自承 MCP 半成品），不吹牛。防止文档承诺超过代码兑现。
6. **精简依赖本能** — 只依赖 httpx/pydantic/pyyaml。与"轻便"目标契合。

---

## 二、必须避免的教训（含原因）

### 教训 1：受众错位（最致命）
旧版定位"开发者构建 Harness 的底座"，所有 API 按会写 Python 的人校准（装饰器、YAML provider 配置、env var 约定）。与"面向无基础"冲突，文档补不了。**新版必须以"无基础用户能直接用"为第一性约束，而非"开发者好扩展"。**

### 教训 2：Core 不克制，runtime 沦为 god-object
旧版 SPEC 喊"core 克制"，但核心运行时类：构造函数注入近 20 个依赖；单个 run() 方法超 200 行，混合 MCP 懒连接、session 加载、输入 guardrail、记忆加载、迭代循环、LLM 调用（带熔断+重试）、钩子、响应分支、**嵌套的自我修正子循环**、工具执行、事件发布、状态持久化；运行时直接耦合 guardrails/hooks/memory/MCP/corrections/resilience/sessions/events 几乎所有模块。
**后果**：难测、难改、难读，违反自己的 scope 纪律。**新版：runtime 只管 loop 本身；guardrails/memory/MCP/corrections/resilience 全是插件，不进 runtime 构造函数。**

### 教训 3：4 套不统一的扩展机制
工具=装饰器，Provider=register/JSON，Hook=子类，Workflow=add_node。开发者记 4 套心智。**新版：统一成一种声明式注册，tool/provider/hook/guardrail 同构。**

### 教训 4：配置膨胀
旧版默认配置 ~33 个键，横跨 model/context/agent/tool/limits/sessions/observability/resilience(retry+双熔断)/memory/mcp/corrections 十余段。无基础用户看到就劝退。**新版：零配置起步，高级旋钮渐进披露，不默认暴露。**

### 教训 5："无默认"教条半吊子
旧版强制"不内置默认 provider/model/base_url/价格"，却给 temperature/max_iterations/limits 等行为默认值。教条自相矛盾：对 substrate 偏执，对行为默认又宽松。结果无基础用户既没"开箱默认 provider"的便利，又被一堆隐式行为默认值困惑。**新版：放弃绝对无默认，改"安全默认 + 可覆盖"，填 Key 即跑。**

### 教训 6：sync-in-async 反模式
旧版在同步方法里用 `asyncio.get_event_loop().run_until_complete(...)` 调异步上下文设置。`get_event_loop()` 已弃用，在已有事件循环里会崩。脆弱。**新版：全异步或全同步，不混用；构造与运行分离。**

### 教训 7：破坏封装
旧版从外部给 runtime 实例塞私有属性、构造后改字段。**新版：构造函数接收全部状态，不可变优先，不外部改私有。**

### 教训 8：字符串事件无注册表
事件类型是散落的字符串字面量（"run.started"/"llm.request"/"tool.call.completed"...），手写 dict 发布十几处。易拼写错，无中心枚举，无 payload 校验。**新版：事件类型有注册表/枚举，payload 有 schema。**

### 教训 9：自我修正启发式脆弱
旧版验证结果时用 `"def " in result or "class " in result` 触发 Python 编译检查——任何含 "def " 的散文都会被当代码编译并报错。启发式错误。**新版：验证靠显式信号（测试/校验器/LLM judge），不靠字符串嗅探。**

### 教训 10：流式非统一模型（gap 未真正闭合）
旧版 GAPS 自称修复了"流式不是统一事件模型"，但代码里流式是独立类 StreamingAgentRuntime，与主 loop 分离。宣称的修复未兑现。**新版：单一 loop 既可同步取最终结果，也可发事件流；流式是事件订阅，不是另一个 runtime。**

### 教训 11：MCP 死代码
旧版 MCP 的 connect/start/stop 是 pass，call_tool 抛 NotImplementedError；但 runtime 里仍有完整的 MCP schema 合并 + 工具分发分支（且分发逻辑与普通工具的 AFTER_TOOL 钩子重复）。宣传的特性是空壳，还增加 runtime 复杂度。**新版：要么真实现 MCP，要么不进 core；不留半成品分支。**

### 教训 12：文档反讽式过重
旧版 ~8500 行文档 + 2400 行 USER-GUIDE + 整套 learn/ 教程。要"轻便"的框架，文档本身成了负担，说明抽象不够自解释，靠文档补复杂度。**新版：文档极简（几页），靠产品自解释；复杂度靠简化抽象消除，不靠文档解释。**

### 教训 13：语言与分发门槛
Python 需装解释器/venv/pip，或 PyInstaller 打成 50–150MB 慢启动包。对无基础用户分发门槛高。**新版：TypeScript + Bun 单二进制 / npx 零安装。**

### 教训 14：过度抽象（speculative generality）
workflow/team/checkpoint/durable execution/evals 在 Alpha 就全上，多数未真正被用。GAPS 自己警告"别为像框架而抽象"，实现没遵守。**新版：MVP 只留 GAPS Phase 1 骨架（runtime/limits/guardrail/run-state/events/tracer）；其余按需再加，延迟决策。**

---

## 三、方法论遗产

- **Gap 分析**：重构前先对标竞品，列必备件与缺口，定优先级（P0/P1/P2）。新版重写前先更新这份对标。
- **模块通用性地图**（见 `COMP-MAP.md`）：哪些模块所有 harness 框架都有（LLMProvider/上下文/工具/反馈闭环=⭐⭐⭐⭐⭐），哪些可选。当需求基线。
- **反幻觉纪律**：文档只写已实现的；规划项明确标注；不吹牛。
- **控制面优先**：Agent 自主性越高，越先做 limits/termination/guardrail，而非功能。

---

## 四、一句话总结

旧 Vessel 的**纪律是对的**（分层、gap 分析、控制面、反幻觉），但**没约束住实现**（core 臃肿、4 套扩展、配置膨胀、半成品 MCP），且**受众错位**（为开发者建框架，而非为无基础用户建应用）。新版继承纪律，砍掉臃肿，重定受众。
