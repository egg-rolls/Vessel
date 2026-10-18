---
adr: 28
title: 注册系统外推——registry 接口化 + 构建时扫描
status: accepted
date: null
related: [6, 26]
---

## ADR-028：注册系统外推——registry 接口化 + 构建时扫描

- **上下文**：core 冻结，但 core 边缘的装配机制同样应作为接口，否则自由度在装配层被卡死。既有 `src/plugin-registry.ts` 是具体类（`DEFAULT_PLUGIN_IMPORT_MAP` 路径写死）：加一个工具要手改注册表，违背开闭原则；「扫描式 / 配置声明式」的注册实现全被堵死。复杂度外推：装配机制也应接口化，实现可插拔。
- **决策**：
  1. 定义 `PluginProvider` 接口：`getAvailablePlugins()` / `loadPlugin(name)` / `getProviders()`——只承诺「发现」，不做权限/暂停/显示等业务决策（已下沉到工具对象，ADR-026）。
  2. 实现可插拔：`StaticRegistry`（既有映射表，迁移期保留）/ `BuildTimeScanner`（构建时扫描生成注册表）/ `DirScanner`（用户目录运行时扫描）/ `ConfigDeclared`（vessel.yaml 声明连接）。
  3. 内置工具**运行时扫描** `plugins/*/*/`（ADR-006 弃单二进制后，分发带插件目录，运行时动态发现；构建时扫描是单二进制时代的打包折中，不再必要）。
- **备选**：(a) 保持路径写死——加工具要改代码，违背「只加不改」；(b) 构建时扫描——单二进制时代的打包折中，ADR-006 弃单二进制后不再必要。取运行时扫描。
- **后果**：注册系统只做「发现」，实现可替换；开发者放文件夹即注册，**运行时自动发现**（无需构建生成注册表）；bootstrap 不再硬编码插件名数组。
- **关联**：ADR-026；[#92](https://github.com/egg-rolls/Vessel/issues/92)。
