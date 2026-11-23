# 校验分层审视（O3）+ 不变量 owner/oracle（S3 改形）

- 分支：fix/q-validation（基线 …→6c1fe2d4→db69c381）
- 日期：2026-11-24
- 原则：**校验 rigor 匹配信任边界**；同信任域对齐 wire 序列化语义，不可信边界保持严校验。
- 验证形态（宪法第三/四条，2026-11-18 用户裁定）：**不写任何测试/探针/断言文件**。
  语义对照表本身即契约文档（`packages/serve/src/plugin-host/dto.ts` 头部）；每条不变量
  写明 owner（谁守）与 oracle（怎么判真）；判真落在**用户行为验证 + 构建产物读数 +
  只读真实日志/数据**，不落脚本。本文 §4 是 owner/oracle 登记处。

## 1. 信任域划分

| 信任域 | 成员 | 数据性质 |
|---|---|---|
| 同信任域 | host ↔ tools-engine（同机同用户，自己代码） | 信封/结果出自 own code；仍是**进程边界**，形状 fail-fast 有独立诊断价值 |
| 外部不可信 | host ↔ 体验插件子进程 | 第三方代码产物，DTO + 资源上限 + drop 策略从严 |
| 不可信输入 | LLM 生成的 tool args | 即使 envelope 来自同信任域，args 内容不可信 → schema 子集校验 |
| 权威判定 | path boundary | host 装配权威；engine 只重建与执行，不自决 |

## 2. 层盘点（数据流向顺序）

### L1 host 出口 DTO — `child.ts engineRequest / callRpc → ensurePayload`
- 实现：`packages/serve/src/plugin-host/dto.ts`（jsonDtoViolation + 字节上限，单实现）。
- 边界：host → 子进程 wire，**双向**（params 与 result 都校）。engine 通道 8 MiB，
  体验插件 1 MiB（`maxMessageBytes`）。
- 职责：JSON 可序列化性 + 资源上限。语义 = dto.ts 头部对照表（O1 后与 JSON.stringify
  对齐 undefined 两项；function/symbol/非有限数/非 plain object/深度为**注明理由的更严**）。
- 失败行为：抛 `PluginHostError`（plugin_manifest_invalid / plugin_payload_too_large）。
- **判定：keep**。这是生产事故缝（db69c381）的修复点，唯一 DTO 实现，无重复。

### L2 插件 RPC 分发复检 — `registry.ts validateParams / validateResult`
- 边界：dispatcher → 体验插件 RPC（外部不可信）。
- 职责：与 L1 相同的 JSON-ness + 1 MiB 检查，但**错误分类契约不同**：
  违规折 `RpcError('invalid_params')`（params）/ `RpcError('internal', plugin_rpc_denied)`
  （result），带 method 上下文，直接成 JSON-RPC 回包。
- 与 L1 的关系：manager.registerRpc 的 handler 最终走 `callRpc → child.callRpc`，
  同一 params/result 确实被校两次（最接近「同信任域重复」的候选）。
- **判定：keep（不去重）**。理由：删掉 L2 后违规经 `toRpcError` 折叠，wire 错误契约
  改变——params 违规从 `RpcError('invalid_params')` 变 `internal`（plugin_error =
  plugin_manifest_invalid）；result 违规码虽仍 `internal`，但 details 从
  `plugin_rpc_denied` 变 `plugin_manifest_invalid`。不满足「可证明冗余且语义不变」
  的删除门槛。两次校验同为 O(n) 纯函数，代价可忽略；保守优先。

### L3 事件推送 DTO — `manager.ts subscribeEvents → jsonDtoViolation + notifyEvent 字节闸`
- 边界：host 事件 → 体验插件（外部不可信）。
- 职责：redact 后的事件必须是 JSON DTO 且 ≤1 MiB；违规/超限 **drop**（recordDrop），
  不抛错不阻塞事件流。
- **判定：keep**。失败策略（drop）与 L1/L2（throw）不同，是独立职责不是重复。

### L4 engine 入口 wire 形状 — `src/tools-engine/validate.ts parse*`
- 边界：wire → engine 进程（同信任域，但进程边界）。
- 职责：契约形状——必填字段非空 / 类型 / 枚举（parseInvokeEnvelope、parseCancelParams、
  parseRegistrySync、parseImplReject、parseAuthFrame、parseMcpControl）。
  失败 throw → entry 折 JSON-RPC error；auth 帧 fail-closed close 连接。
- 与 L1 的关系：**互补不重复**——L1 判「是不是合法 JSON 值」，L4 判「是不是这个
  方法要求的形状」。L1 放行的 `{}` 会被 L4 拒（缺 run_id 等）。
- 显式分层委托：parseInvokeEnvelope 对 boundary 只校 `isRecord`，深形状委托
  worker `deserializeBoundary`（validate.ts L71 注释在案）——不是遗漏，是职责划分。
- **判定：keep**。同信任域不豁免形状校验：进程边界的 fail-fast 诊断价值独立存在，
  且 auth 帧面对的是连接级不可信输入。

### L5 tool args schema 子集 — `engine.ts handleInvoke → firstSchemaViolation`
- 边界：**LLM 生成的 args（不可信输入）** vs 注册表 inputSchema。
- 职责：机械子集（type/required/properties/items/enum/additionalProperties===false），
  未知关键字忽略；首个违规折 `ENGINE_ERROR.invalidParams` 稳定文本，不派发。
- 与 L4 的关系：不同数据（args vs envelope）、不同权威（工具契约 vs wire 契约）。
- **判定：keep**。这是不可信输入边界，从严；且是「机械、不权威」设计——不做
  format/minimum 等价值判定，避免第二套 schema 权威。

### L6 boundary 安全策略 — `worker.ts executeWorker + basic-tools deserializeBoundary / evaluatePath`
- 边界：路径安全判定（host 装配权威 → engine 执行）。
- 职责三层：
  1. worker fail-closed：PATH_TOOL_NAMES 工具无 boundary → `invalidParams('boundary required')`；
  2. `deserializeBoundary` 重建 SerializedBoundary 深形状，失败折 `boundary malformed`；
  3. 工具执行期 `evaluatePath(canonicalPath(...), boundary)` 做 allow/ask/deny 判定
     （attachment-ingest / attachments-list 等消费方同一套实现，无第二套前缀比较）。
- **判定：keep**。这是安全策略执行不是形状校验，与 L1–L5 无重叠；deserializeBoundary
  与 L4 浅校是显式委托关系（见 L4）。

### L7 结果形状兜底 — `engine.ts parseInvokeResult`（callback 回包）/ `forward.ts`（invoke 结果）
- parseInvokeResult：host → engine 的 tool.callback 结果，`{content: string}` +
  可选 bounded/original_chars 类型。
- forward.ts：engine → host 的 invoke 结果，isRecord + content string 兜底，
  失败折稳定 ENGINE_ERROR 前缀。
- **判定：keep**。两处校的是**不同方向**的数据（callback 回包 vs invoke 结果），
  不是同一数据的重复校验；同信任域轻量兜底，fail-fast 诊断价值独立。

## 3. 去重结论

**删除数：0。** 唯一候选（L2 ↔ L1 同数据双校）因 wire 错误分类契约不同而不满足
「可证明冗余且语义不变」门槛。其余各层数据不同、职责不同或失败策略不同。
本次质量修复的正确动作是**语义对齐**（O1：dto.ts 与 JSON.stringify 对齐 undefined
两项 + 显式建模 function/symbol/bigint），不是删层。

## 4. 不变量 owner / oracle 登记（S3 改形）

oracle 形态受宪法约束：不写测试/探针；判真 = 用户行为验证 + 构建产物读数
（`bun run build` 的 typecheck/lint 输出与成功标记）+ 只读真实日志/数据文件。

| # | 不变量 | owner（谁守） | oracle（怎么判真） |
|---|---|---|---|
| 1 | undefined 对象属性 wire 后键消失（可选字段语义） | dto.ts visit 对象分支（db69c381） | 用户行为验证：callback 类工具（ask_user 等）生产可用；只读 node 日志无 `plugin_manifest_invalid` 拒 envelope |
| 2 | undefined 数组元素 wire 后为 null | dto.ts visit 数组分支（本次 O1） | 语义锚点 = ECMAScript JSON.stringify 规范（`[undefined]→"[null]"`）；用户行为验证含数组可选元素的工具调用 |
| 3 | function/symbol 任何位置拒（更严：跨 wire 必是编程错误） | dto.ts visit default 分支 | 构建产物读数（tsc 保证类型面）+ 用户行为验证；日志中若出现该拒绝 = 上游 bug 信号而非 DTO 误杀 |
| 4 | bigint 拒（对齐 JSON.stringify throw） | dto.ts visit default 分支 | 同 #3；语义锚点 = JSON.stringify(BigInt) throw TypeError |
| 5 | NaN/±Infinity 拒（更严：数值 bug 信号） | dto.ts visit number 分支 | 同 #3 |
| 6 | 非 plain object / 循环引用拒 | dto.ts isPlainObject / seen 集 | 同 #3 |
| 7 | 深度 ≤32、消息 ≤ 通道上限（engine 8MiB / 插件 1MiB） | dto.ts MAX_DEPTH / ensurePayload / jsonByteLength | 只读真实日志：`plugin_payload_too_large` / `nested too deeply` 出现即资源保护生效 |
| 8 | tool.invoke 信封必填形状（三元组/tool_name/args/exec） | validate.ts parseInvokeEnvelope | 用户行为验证：四类工具（worker+boundary / callback / 非 bash / bash sync）生产调用成功；只读 engine 日志无形状拒绝 |
| 9 | args 符合 inputSchema 机械子集 | engine.ts handleInvoke → firstSchemaViolation | 用户行为验证：非法参数收到稳定 `invalidParams` 文本而非崩溃 |
| 10 | 路径工具必带 boundary；判定用 host 权威 | worker.ts fail-closed + evaluatePath 单实现 | 用户行为验证：越界路径走 ask/deny；只读日志 `boundary required` / `boundary malformed` |
| 11 | 体验插件事件违规/超限 drop 不阻塞 | manager.ts subscribeEvents | 只读真实日志 recordDrop 计数；用户行为验证事件流不中断 |
| 12 | 插件 RPC 违规折 invalid_params/internal 稳定错误码 | registry.ts validateParams/validateResult + toRpcError | 用户行为验证：插件 RPC 错误回包码稳定（L2 keep 的契约依据） |

## 5. 遗留缺口（诚实登记）

- #2（数组 undefined）与 #8 的四类信封端到端，本次**没有脚本级行为证据**（宪法禁
  测试文件）；正确性依据 = 语义对照表 + 规范锚点 + 构建产物读数，行为判真留给用户
  生产验证。若用户验证发现回归，按上表 owner 定位。
- L2 ↔ L1 双校保留是保守决策；若未来要合并，前置条件是统一 wire 错误分类契约
  （先改 toRpcError 映射，再删 L2），不在本次范围。