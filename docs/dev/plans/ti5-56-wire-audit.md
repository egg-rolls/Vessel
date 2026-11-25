# TI5-5 / TI5-6 根因审计 + 修复方案（q-ti5-56-wire）

日期：2026-06-27 · 分支：fix/q-ti5-56-wire（基线 redblue-dev @ 41a14135）
范围：B1 thinking-plugin 长尾（webui R3 发现，lead 转达）。两缺陷均为 `plugins.list` wire 契约缺口，**纯服务端 additive 修复，web 零改**。

## 1. TI5-5：toolbar 菜单仍不渲染（TI5-2 必要不充分）

### 根因链（逐跳实证）

1. manifest 真相完好：`plugins/context/thinking-intensity/package.json` vessel.contributes.rpc =
   `get_state(permission:read)` / `set_level(permission:write)` / `capabilities(permission:read)`；
   toolbar[thinking-level].menu = `{read:get_state, write:set_level, valueKey:level, sessionScoped:true, items:[auto/off/low/medium/high]}`。
2. assembly 透传完好：`src/plugin/plugin-host-assembly.ts:156-164` `manifestToServeDescriptor`
   把 rpc 的 name/description/permission 全量带进 `descriptor.contributes.rpc`；
   TI5-2 已把 toolbar.menu 原样透传（assembly:142-144 → manager.renderContributions:1928-1929）。
3. **断点**：`packages/serve/src/plugin-host/manager.ts:1933`
   `const rpc = (contributes.rpc ?? []).map((method) => method.name);`
   —— renderContributions 把 rpc 拍平成 bare strings，**permission 在 wire 组装这一步丢失**。
4. 契约固化了缺口：`packages/serve/src/plugin-host/types.ts:318` `PluginRenderContributions.rpc: string[]`；
   `packages/serve/src/gateway/methods/config.ts:597` result_schema `rpc: {type:'array', items:{type:'string'}}`。
5. web 校验永败：`apps/web/src/domains/plugins/plugin-contributions.ts:436-447` `toolbarMenuOf`
   对 string 条目缺省 read（E1 默认语义），`permissions.get('set_level')==='read' !== 'write'`
   → return undefined → menu 丢弃 → toolbar 条目退化为普通按钮（宿主无 id 映射回调 → 不渲染）。

结论：TI5-2 修的是 menu 透传（必要），但 write 权限真相过不了 rpc wire（不充分）。

### 方案裁定：wire additive（lead 推荐方向），混合发射

- **采纳**：plugins.list rpc wire additive 携带 `{name, permission}`。
- **发射口径（最小 additive）**：`permission==='write'` 的方法发 `{name, permission:'write'}` 对象；
  read / 缺省方法**保持 bare string**（E1 canonical 原样）。
  - 旧 string-only 消费方：read 方法逐字节不变（它们本来也只能调 read）；write 方法变对象后被
    fail-closed 跳过（旧消费方缺省 read，本来就不该调 write）——零破坏。
  - 新 web：`toolbarMenuOf` 与 `buildPluginInventory.methodsByPlugin` **早已双形状容忍**
    （plugin-contributions.ts:436-447 / 712-716；gateway/types/protocol.ts:267
    `rpc?: Array<string | {name?, description?, permission?}>`）→ write 真相到位 → menu 渲染。
- **拒绝**：web toolbarMenuOf 改信节点侧已校验 menu.write —— 会让 web 对 wire 真相盲信，
  违反「web 忠实 wire 真相」红线；且 iframe bridge 白名单同样需要 permission 真相。
- **catalog.ts 无需改**：审计核实 plugins.list contributions 唯一组装点是 manager.renderContributions；
  catalog.ts 是 CONTRACT-0.47 的 plugins.catalog 视图，manifest 原样透传（rpc permission  intact），无此缺口。

### 变更点

- `types.ts`：新增 `PluginRpcWireEntry {name; permission?}`；`PluginRenderContributions.rpc: Array<string | PluginRpcWireEntry>`。
- `manager.ts:1933`：write → 对象，其余 → bare string。
- `config.ts:597`：`rpc: {type:'array', items:{}}` —— 校验器子集无 union（schemas.ts:6 明令
  不引入 oneOf；先例 teamBudgetResultSchema.previous_max/max `{}`），items 不声明 type，
  形状由 renderContributions 组装保证，注释说明。

## 2. TI5-6：plugins.list wire 无 config → 设置弹窗不回显持久化值

### 根因链

1. 真相源完好：config `plugins[].config`（如 thinking-intensity `default_level:low`）。
   assembly `pluginSettingsFor`（plugin-host-assembly.ts:52-55）= 纯持久化值拷贝（无 default 混入），
   注入 `descriptor.settings`（child:178 / in-process 登记同函数）。
2. **断点**：`manager.ts` `statusOf`(1782-1803) / `inProcessStatusOf`(1806-1823) 不携带 settings；
   `PluginStatusEntry`（types.ts:405-429）与 `PluginListMetadata`（types.ts:394-402）无 config 字段；
   `pluginListMetadata`(1860-1876) 无映射；config.ts result_schema 无 config 属性。
3. web 早已就绪：`protocol.ts:377` `PluginListItem.config?: Record<string,unknown>`；
   `SettingsDialog.tsx:152-159` pluginConfigById 读 `plugin.config` → 173 行回显；
   wire 无 config → 恒 undefined → 回落 `def.default`/placeholder（default_level 框恒空 placeholder=auto）。

### 修复设计（live 真相优先）

- `PluginStatusEntry.config?` / `PluginListMetadata.config?`（additive）。
- `statusOf` / `inProcessStatusOf`：`this.options.settingsFor?.(id) ?? descriptor.settings ?? {}`，
  非空才发射。
  - **settingsFor 优先的理由**：它是装配注入的活配置读端口（cli.ts:988
    `settingsFor:(id)=>pluginSettingsFor(liveConfig,id)`）。in-process 登记是一次性的
    （registerInProcess 启动期，manager.ts:1200），descriptor.settings 是启动快照——
    thinking-intensity 恰是 in-process 能力插件，若只读 descriptor.settings，
    plugins.config.set 写后 wire 会回显旧值。settingsFor 读 liveConfig → 两轨写后皆新鲜。
  - 无端口回退 descriptor.settings（bootstrap 本地模式不注入 settingsFor，其执行面 config
    本就不热重读，语义不变）。
- `pluginListMetadata`：status.config → wire config。
- `mergePluginList`（config.ts:531-551）spread extraMeta → config 自动进 plugins.list 与
  plugin.changed（broadcastPluginChanged → pluginListPayload 同源）。
- result_schema：`config: {type:'object'}`（additive，同 ui_embed 风格）。
- **web 零改**：回显（SettingsDialog）与写确认（useSettingsWriter:164-174 轮询
  `entry.config?.[def.key]`）都已消费该字段。

### 写路径核查（main 转达 webui R2 观察：写 default_level:high 冒出 budget_high:32768）

逐跳审计结论：**现行写路径严格单键，无全对象 merge / 默认值物化**：

1. web：SettingRow per-row draft，`draft !== value` 才 commit（SettingRow.tsx:68-69）→
   `writer.save(def, raw)` 单键 → `client.setPluginConfigValue(pluginId, key, value)`
   （useSettingsWriter.ts:152）→ rpc `plugins.config.set {plugin,key,value}`（integrations.ts:117）。
   全 web 仅此一处调用 setPluginConfigValue；pending overlay 也只含本次键。
2. serve 方法层：按 manifest spec 单键校验 type/enum/minmax（config.ts:691-753）。
3. 落盘：`setPluginConfigValue`（src/plugin/plugin-config.ts:156-187）withConfigLock →
   readUserConfigRoot → **只改 plugins[name].config[key]** → writeUserConfigRoot；
   其它键 / 其它插件原样保留。setPluginEnabled 只写 enabled 标志，不物化 config。
4. 读写原语（packages/config/src/user-config.ts）纯 parse/stringify，无 schema 默认值填充。
5. **32768 全仓源码零命中**（grep packages/src/apps/plugins，排除 node_modules）；
   budget_high manifest default=16384。现行代码任何路径都产生不出 32768。

裁定：R2 观察到的 stray 键与「草稿基线失真」假设在现行代码不可复现，与 lead 已随 baseline
移除的残留一致；**不做投机性写路径改动**（红线：服务端 config 真相源不动）。
但审计发现写侧真实缺陷一枚，属 TI5-6 同根：**写确认环结构性失败**——
useSettingsWriter 以 plugins.list[].config 为确认源，wire 无 config → 每次插件写入成功
也必报「已写入但未确认」toast。config wire 补齐后该环自愈（8×250ms 轮询覆盖热应用 debounce，
与核心 config.set 确认同机制）。

## 3. 变更面汇总

| 文件 | 变更 |
|---|---|
| packages/serve/src/plugin-host/types.ts | rpc wire union 类型 + PluginStatusEntry.config + PluginListMetadata.config |
| packages/serve/src/plugin-host/manager.ts | renderContributions rpc 混合发射；statusOf/inProcessStatusOf 携带 config；pluginListMetadata 映射 |
| packages/serve/src/gateway/methods/config.ts | plugins.list result_schema：rpc items union 口径 + config 属性 |

零改：apps/web（双形状 rpc + config 消费早已就绪）、catalog.ts、config 真相源、
thinking-intensity 插件、src/ 装配层。

## 4. 红线合规

- 契约 additive：read rpc 逐字节不变；config 整字段缺省 = 无持久化值（旧客户端忽略新字段）。
- web 忠实 wire 真相：不改 web 校验逻辑，只补 wire 真相。
- 服务端 config 真相源不动：只读（settingsFor/descriptor.settings），写路径零改。
- thinking-intensity 插件不动（仅只读审计其 manifest）。
- 零测试 / 零探针；唯一门禁 bun run build。

## 5. 修复后实证设计（归金丝雀 / webui 复验）

1. **toolbar 菜单**：canary 同步后 webui 会话 composer 应出现 Thinking 按钮（icon observe）；
   点开 5 档菜单（auto/off/low/medium/high，i18n 随语言）；选档调 plugin.thinking-intensity.set_level
   （write 权限经 bridge 白名单），get_state 回读当前档。
2. **设置回显**：config 预置 thinking-intensity default_level:low → 设置弹窗扩展组
   「默认档位」框显示 low（非 placeholder auto）；「已配置」标记（configuredFor）为真。
3. **写确认**：弹窗改 default_level:high 保存 → toast「已保存」（非「已写入但未确认」）；
   yaml 只新增/变更 default_level 一键，无其它键冒出；重开弹窗回显 high。
4. **旧消费方回归**：bare string read 方法白名单不变（iframe bridge 照常）；
   plugins.list 旧字段逐字节不变（config 缺省时整字段不出现）。