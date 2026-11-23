# 工程质量复盘：过度工程化 vs 简陋开发（2026-11-23）

> 来源：本 session 修 vessel 可用性暴露的一串缺口。用户要求反思记录，供重构。
> 诚实复盘，含 1（main）自身过程问题。证据均本 session 实证（commit/file:line）。

## 一、DTO 校验的意义与过度边界
- **目的**：数据跨边界（RPC/wire）前查形状/类型——边界契约 + fail-fast + 防畸形数据跨信任边界。
- **合理**：不可信边界（外部插件 / 网络输入 / 跨信任域）必须严校验。
- **过度**：同信任域内部（host↔engine 同机同用户，数据来自自己代码）套重校验 = 防御自己人。
- **本次问题不是 DTO 本身**，是：① 校验语义没对齐 JSON（拒 JSON.stringify 会丢弃的 undefined 对象属性，dto.ts:67）；② 可选字段路径（boundary/timeout_ms undefined）从没端到端测。
- **重构原则**：校验 rigor 匹配信任边界——内部同信任轻校验（形状兜底即可），外部不可信严校验。别用一套最严校验套所有边界。

## 二、过度工程化实例（机制复杂度超出实际需要 / 防御过度）
| # | 实例 | 证据 | 问题 |
|---|---|---|---|
| O1 | DTO 校验比 JSON 严 | dto.ts:67 拒 undefined；JSON.stringify 丢弃 undefined 对象属性 | 防御过度，校验语义≠序列化语义 |
| O2 | ensureActive child 激活闸统一套所有插件 | manager.ts:871→requireEntry:1653 只查 child entries | 机制泛化没考虑适用边界，in-process 早已激活却被当未知拒 |
| O3 | 多层重复校验 | DTO ensureJsonDto + validate.ts + schema subset + boundary check | 同一数据多道闸，职责重叠 |
| O4 | pool 韧性 machinery 复杂度 | breaker/cooldown/fencing/adopt/P2C/routing epoch+revision（ADR-106） | 同机工具执行池套了分布式级韧性；用户质疑「不需要 pool 的人可不装」（已批决策，复杂度值得审视，见 IDEAL-ARCHITECTURE A1） |

## 三、简陋开发实例（能跑就行 / happy-path-only / 覆盖面不全）
| # | 实例 | 证据 | 问题 |
|---|---|---|---|
| S1 | staticMounts 漏 in-process | manager.ts:1144 只遍历 entries（child），漏 inProcess map | in-process 插件 UI 不挂载，只测了 child |
| S2 | model-registry 双路注册无去重 | model-registry-wiring + plugin-selection 显式分支都注册 → 启用崩 | 两条路加了没考虑交集，启用路径没测 |
| S3 | boundary/timeout_ms undefined 可选路径没测 | forward.ts:93 非 worker 设 undefined → DTO 拒 | 只测有 boundary 的 worker happy path |
| S4 | 插件资产 URL 构造不一致 | RPC 用拼接（node/rpc.ts:55），资产用 new URL（吞 /nodes/<id> 代理路径） | 代理模式没端到端测，两套构造不一致 |
| S5 | restart 不保持 daemon | parseGatewayRestart 缺省 daemon=false，不检测运行模式 | 显式 --daemon happy path 通，缺省 restart 忘模式 |
| S6 | NodeProvider 代理模式直连 node | NodeProvider.tsx:109/138 fetchHealth 直连 node，浏览器无 node token → 401 | 代理缺省开但直连逻辑没考虑代理模式 |
| S7 | marketplace iframe 经代理 | 代理白名单只 /ui/**，iframe 页不在内；设计意图直连 node 没贯彻 |  iframe URL 走代理路径 → 404 |
| S8 | in-process 插件 UI serving 整体没接 | staticMounts/ensureActive 都按 child 设计 | 「能力插件+体验面」混合场景从没端到端跑通 |

## 四、共同根因（过度与简陋同源）
**机制建了但语义没建模完备 + 只测 happy path。**
- 过度工程化 = 机制复杂度/防御超出实际需要（没想清「这个边界需要多严」「这个机制适用谁」）。
- 简陋开发 = 覆盖面不全（没想清「可选字段/边界情况/另一种模式会怎样」）。
- 两者都是**「没把语义想全就动手」**：一个往多了做（过度防御），一个往少了做（漏覆盖）。

## 五、1（main）自身过程问题（诚实）
- 合并修复**没端到端验证 serving 全链**：ensureActive→staticMounts→servePluginAsset→文件，只修报的那个点，没扫全链，导致用户反复 404（修了 staticMounts 还被 ensureActive 挡着）。
- **头痛医头**：一个个踩雷修，没系统性扫同类缺口（in-process serving 缺口的多处表现本可一次扫出）。
- 验证停在「静态门禁绿 + 静态链核」，真实行为归用户——但静态链也没核全（ensureActive 前置闸漏看）。
- 改进：修复时**端到端核全链 + 扫同类缺口**，不只修报的点；门禁绿≠行为通。

## 六、重构原则（供记录）
1. **校验 rigor 匹配信任边界**：内部同信任轻校验，外部不可信严校验；校验语义对齐实际序列化（DTO 对齐 JSON）。
2. **机制适用边界显式**：ensureActive 只 child，in-process 跳过；闸/机制声明适用谁，不无脑泛化。
3. **可选路径/边界情况端到端覆盖**：不只 happy path；可选字段、另一种模式（proxy/direct/legacy）、in-process/child 都要跑通。
4. **单实现/一个事实一个家**：避免双路注册（S2）、不一致 URL 构造（S4）；同一逻辑一处实现。
5. **修复扫同类缺口**：修一个点时扫同机制的其他表现，端到端核全链。
6. **复杂度审视**：pool 韧性 machinery（O4）对同机场景是否过重；不需要者可 opt-out（A1 插件化）。
7. **in-process 插件 UI 是一等场景**：staticMounts/ensureActive/serving 全链按 child+in-process 双轨设计，不是 child 专属补漏。

## 关联
- 理想架构 backlog：docs/dev/plans/IDEAL-ARCHITECTURE.md（A1 engine 插件化 / A2 Platform 级插件 / A5 归属体系）。
- 本 session 修复链：72f0bad7→59907815→57e514f7→1a075344→1aae9ace→332fd2e7→95361fac→6c1fe2d4→db69c381。
- issue 实例：docs/dev/issues/model-registry-ui-404.md。
