# @vessel-agent/web-tools

`web_search`（三家内置 + 声明式自定义后端）+ `web_fetch`（双后端）。设计：`docs/dev/design/0.56-web-tools.md`。

**默认加载**（0.56 起）：任何会话都能用 `web_search` / `web_fetch`。**没有可用的搜索 key 时
`web_search` 不注册**（`--tools` 里也不出现，只留 `web_fetch`），并在启动时打一行原因
（不含 key 值）；想「先看到工具再配 key」就配 `always_register: true`，那时调用会返回
`provider_auth_failed` 并点名要设置哪个环境变量。想关掉整个插件：`plugins:` 里写
`- name: web-tools` + `enabled: false`。

密钥不必 export：顶层配置 `env_file: <path>` 让 Vessel 启动时从文件加载
（见 `docs/operations/CONFIG.md` §3.1）；本插件只认**环境变量名**，从不存值。

## 两个工具

| 工具 | 干什么 | 计费 |
| --- | --- | --- |
| `web_search` | 返回 3–5 条带 URL 的候选（标题 / 摘要 / 日期），让模型**先搜再抓**，URL 来自搜索结果而不是记忆 | 按次（**结果非空**才计） |
| `web_fetch` | 抓一个 http(s) URL，返回正文 + 「怎么抓到的」元字段 | `local` 免费；`deepseek` 按次（**拿到正文**才计） |

`web_fetch` 的缺省后端是 **`local`**：免费、离线可用、内网可调试、每一跳都在我们眼里。
`deepseek` 换成服务端抓取（Markdown、更抗反爬），代价是**按次付费 + URL 交给第三方**。

## 后端是插件包内的扩展点（宪法第十三条）

```
src/backends.ts                 唯一注册点：registerSearchProvider(...) / registerFetchBackend(...)
src/search/provider.ts          SearchProvider 接口 + 注册表
src/search/deepseek.ts          deepseek 搜索实现（Bearer + config.base_url）
src/search/tavily.ts            tavily 搜索实现（固定 host + Bearer，include_raw_content）
src/search/serper.ts            serper 搜索实现（固定 host + X-API-KEY，organic[]）
src/search/custom.ts            声明式自定义后端（占位符 + 点号路径映射）+ Bocha 内置预设
src/fetch/provider.ts           FetchBackend 接口 + 注册表
src/fetch/local.ts              local 抓取（SSRF / robots / 抽取全在 http.ts）
src/deepseek-fetch.ts           deepseek 抓取
src/search/index.ts             共用层：校验 → 选后端 → 缺 key → 缓存 → 三道闸 → 限流 → 重试 → 预算 → 定界渲染
```

加一个搜索后端有**两条路**：

1. **先看能不能声明式解决**（95% 的情况）：`custom_search` 加一段配置 = 多一家，
   **零代码、零发版**。见下面「声明式自定义后端」。
2. 声明式表达不了（分页 / 二次请求 / 条件字段 / 非 JSON）才写 `SearchProvider` +
   在 `backends.ts` 加一行：**工具层、预算、缓存键、闸一行都不用改**
   （缓存键带 `provider_id` + `provider_version`，两个后端的结果不会串味）。

⚠️ **「一行」只在鉴权风格与 key 名跟 deepseek 一样时成立**。期 2 实测：`search/index.ts` 曾把
provider 与 transport 写死（`DEFAULT_SEARCH_PROVIDER_ID` + `createDeepSeekHttp`），那时注册是**假的**。
非声明式的新后端若**鉴权头不同**或**key 变量名不同**，还需要在实现里提供几个可选字段（不是改共用层）：

- `keyEnv`：这家缺省读哪个环境变量（配置 `search_key_env` 仍可覆盖）；
- `createHttp?()`：自带 `ProviderHttp`（`createJsonHttp` 已把固定 host + 自定义头/查询串鉴权包好），
  **重试/退避/错误映射/擦除仍是同一份**——不要在适配器里另写一套闸；
- `maxCount?`：上游条数上限（Tavily 20 / Bocha 50），由共用层在发请求前夹紧。


## 搜索后端（内置三家 + 声明式自定义，`search_provider` 或注册顺序）

| 后端 | key 环境变量 | 摘要来源 | 正文 | 过滤支持 |
| --- | --- | --- | --- | --- |
| `deepseek` | `DEEPSEEK_API_KEY` | 上游 `summary` | `need_content` | `site:` / `lang:` / `after:` / `before:` 渲染进 query |
| `tavily` | `VESSEL_TAVILY_API_KEY` | 上游 `content`（它自己的摘要口径） | `include_raw_content` | 只支持 `site`（走 `include_domains`）；**`lang` / `after` / `before` 没有对应参数，不做过滤**；结果上限 20 |
| `serper` | `VESSEL_SERPER_API_KEY` | 上游 `snippet`（Google `organic[]` 里**没有** `summary` 字段） | **没有正文**（`need_content` 无效，要全文用 `web_fetch`） | `site:` 拼进 `q`；`lang` → `hl`/`gl`；`after`/`before` → `tbs` |
| `bocha` | `BOCHAAI_SEARCH_API_KEY` | 上游 `snippet`；长摘要 `summary` 归到正文 | `summary: true` 才回的**长摘要**（不是整页正文） | **声明式预设**：`site`/`lang` 不发送（body 里没有对应占位符）；`after`+`before` 都给才映射成 `freshness` 区间，只给一端则整条键省略；上限 50 |

`authority` 只有 `deepseek` 有；Tavily 的 `score` 是相关性、Serper 不给、Bocha 给的是 `siteName`
（网站名不是权威度）——**都不冒充**，条目里就是「(未提供)」。
`date`：Tavily/Bocha 给绝对时间，Serper 是 Google 的相对时间（`2 days ago`）——**原样透传**，不解析。

### 选择顺序（写在工具描述里，模型也能看见）

1. 配置优先：`search_provider: tavily` ⇒ 只用它（没注册就 `provider_unavailable`）；
2. 否则 `auto`（缺省）⇒ **按 `src/backends.ts` 的注册顺序**取第一个 key 在位的：`deepseek → tavily → serper → bocha`；
3. 一个 key 都没有 ⇒ 工具**不注册**（见下节）；配了 `always_register: true` 时改为调用报
   `provider_auth_failed`，文案里列出每家要哪个环境变量（不发请求、不降级）。

选中谁是可观测的：结果的 `backend: <id>` 与指标行的 `provider_id` 都是它。

### 可用性预检：没有 key 就不注册 `web_search`（0.56，用户要求）

- **装配时判定**（`install()` / `createWebTools()` 调 `searchAvailability()`，纯本地、不发请求）：
  没有任何搜索后端能解析到 key ⇒ **不注册 `web_search`**，`--tools` 里看不到它，
  stderr 打一行原因（只含环境变量名）：`web-tools: web_search 未注册 —— …（web_fetch 不受影响）`。
- `web_fetch` 不受影响：`local` 后端不需要 key，永远可用。
- **可用性在进程启动/工具装配时判定**：改 `env_file` 或环境变量后**需要重启**
  （或重新装配工具）才生效，不做热更新。
- 逃生阀：`plugins[].config.always_register: true` ⇒ 无 key 也注册，调用时按
  `provider_auth_failed` 报原因（给「想先看到工具再配 key」的人）。
  为什么不叫 `web.tools.always_register` 顶层键：这条语义只对 web-tools 有效，
  放进配置包会让「配置包」知道某个插件的行为细节。

## 声明式自定义后端（`custom:<id>`）

同类 API 的差异只有三块：**URL / 怎么带 key / 请求体与响应字段的映射**。
为每家写一个适配器不划算 ⇒ 这三块用配置描述，`custom_search` 里加一段就多一家。
**Bocha 就是这条路的第一例**：不在代码里，而是内置预设——`search_provider: bocha` 直接用，
名字跟以前一样（预设 id `bocha` 是保留名，用户自定义的 `id` 不许叫这个）。

```yaml
plugins:
  - name: web-tools
    config:
      search_provider: custom:stubber          # 选中谁；auto 时按注册顺序
      custom_search:
        - id: stubber                           # 注册成 custom:stubber
          request:
            url: http://127.0.0.1:8080/api/search   # https，或 http + loopback/私网
            method: POST                        # POST | GET
            query_in: body                      # body | query
            body:                               # 值里只能写字面占位符
              q: "{{query}}"
              size: "{{count}}"
              when: "{{freshness}}"
              domain: "{{site}}"
            headers: { x-lang: "{{lang}}" }
          auth:
            style: header                       # bearer | header | query
            header_name: X-Token                # header/query 时用（query 时是参数名）
            key_env: STUB_SEARCH_KEY            # **只写变量名**
          response:
            results_path: data.items            # 点号路径（支持数组下标 items.0.x）
            field_map:                          # 值也是点号路径；缺的字段就别写
              title: headline
              url: link
              summary: blurb
              content: full
              date: published
          limits:
            max_count: 20                       # 上游条数上限
            requires: [count]                   # 这套配置**必须用到**的占位符（写错配置就报错）
```

占位符只有这八个：`{{query}} {{count}} {{need_content}} {{freshness}} {{site}} {{lang}} {{after}} {{before}}`。

- **只做字面替换**：整个值就是一个占位符时保留类型（`"{{count}}"` → 数字、`"{{need_content}}"` → 布尔）；
- 占位符缺值 ⇒ **整条键不出现**（不写 `null`/空串，免得上游以为我们传了东西）；
- `{{freshness}}` = `after..before`（两端都给）／`noLimit`（都没给）／**只给一端时不可用**。

### 五条硬边界（不满足就别用声明式，退回专用适配器）

1. **没有表达式语言**。要 `if` / `map` / `filter` / 翻页 / 二次请求 ⇒ 说明这家不适配，
   写一个 `SearchProvider` 并说明原因。
2. **SSRF**：`url` 来自配置（人可信），但**必须 https**；`http` 只允许 loopback/私网
   （本地 SearxNG 是合法用途）。**url 里不许出现占位符**——host 永远不能由工具入参决定。
3. **映射失败要响**：`results_path` 取不到 / 不是数组 / `field_map.url` 全空 ⇒
   `provider_schema_mismatch`，**绝不返回 0 条**（「上游说没有」和「配置与上游不一致」是两件事）。
4. **闸只有一份**：声明式后端就是普通 `SearchProvider`，走同一个 `runWebSearch`
   ⇒ 预算 / 配额 / 缓存键（`custom:<id>` + `1.<spec 指纹>`）/ 熔断 / 指标行 / `sk-` 擦除全部复用。
   **⚠ 改配置 = 缓存冷启动**：spec 指纹进 `provider_version`，改任何一个字段（哪怕只改
   `limits.max_count`）都会让该后端的缓存全部失效——这是有意的，但别在高峰期改着玩。
5. **可见性同等**：在 `--tools` 的可用性预检里与内置后端一视同仁（没 key 一样让
   `web_search` 不出现）。

### 过滤条件：**表达不了就发请求前拒掉**（映射规则 + 升级成错误）

底层是一条映射规则（**不需要表达式语言**）：占位符解析为空 ⇒ 整条键省略。
但当「省略」意味着**用户要的过滤被静默丢掉**时必须升级成错误——拿到一份「看起来过滤过、
其实全网」的结果，比拿一条报错危险得多。所以：

| 情况 | 行为 |
| --- | --- |
| body 里有 `{{site}}`，用户传了 `site` | 正常映射 |
| body 里**没有** `{{site}}`，用户传了 `site` | `provider_bad_request`，**不发请求** |
| 同上（`lang`） | 同上 |
| 有日期占位符，`after`+`before` 都给 | `{{freshness}}` = `a..b` |
| 有 `{{freshness}}`，只给一端 | `provider_bad_request`（上游没有单边写法） |
| 完全没有日期占位符，用户给了 `after`/`before` | `provider_bad_request` |
| 用户没给该项 | 占位符解析为空 ⇒ 键省略（正常路径，不报错） |

每条错误都带**下一步**（去掉参数 / 换后端 / 在 spec 里加占位符），否则模型会反复重试同一个调用。
Bocha 就是这套规则的实例：它的 body 里只有 `{{freshness}}`，所以传 `site`/`lang` 会被拒。

### `field_map` 只收 `SearchHit` **真有**的字段

只允许 `title / url / summary / content / date`。`site` / `icon` 之类**直接拒绝**：
要么没有 destination（写进来就是哑配置），要么只能塞进 `authority`——那是「拿域名冒充权威度」，
比缺字段更坏。

### 没 key 时工具消失，`--tools` 里会带一条「怎么恢复」

`--tools` 的 warnings 里除了 stderr 那行，还会有一条可操作提示：
列出每个后端要的环境变量 + `env_file` 这条路 + `always_register: true` 这个逃生阀，
并说明**改完要重启**（可用性是装配时判定的）。

## 自测花销（别以为免费）

真机验收用的都是 `.env` 里那条 `BOCHAAI_SEARCH_API_KEY`，**累计约 6 次 live 请求**
（另有 4 次是同 query 的缓存命中，不计费）：

| 轮次 | 内容 | live 请求 |
| --- | --- | --- |
| 期 3 首测 | `search_provider: bocha` 真调 + 修字段映射后复跑 | 3 |
| 期 3 验收 | 两个脚本各跑一轮（含一次 `results_path` 写错但真的打到上游） | 2 |
| 期 4 回归 | `bocha` 短名走 custom 引擎 | 1 |

以后要复测：优先走 `cached` 路径，或把 `custom_search` 指向本地桩服务端（本单的桩
`http://127.0.0.1:<port>/api/search` 就是这么用的，零花费）。

## 遗留清单（本单不做，写给下一单）

1. **`SearchHit` 加 `site` / `icon` 字段 + 渲染**：现在 `field_map` 拒收它们（没有 destination）。
   要做得先定语义：站点名**不算**权威度（`authority` 是排序/权重概念），图标要不要抓取与缓存。
2. **什么时候必须退回专用适配器**：声明式表达不了「翻页 / 二次请求（先取 token 再查）/ 条件字段
   （`a?x:y`）/ 非 JSON / 需要按结果再聚合」时。判据：**配置里一旦需要 `if`、`map`、`filter`，
   就是专用适配器的信号**——不要往占位符里加语法糖。
3. **改配置 = 缓存冷启动**：`custom_search` 的 spec 指纹进 `provider_version`（`1.<sha8>`），
   **改任何一个字段都会让该后端的缓存全部失效**（包括只改 `limits.max_count`）。
   这是有意的（配置变了旧结果不该再被复用），但别在高峰期改着玩。

## 错误文案格式（加第四家后端时照抄这段）

「缺凭据」这类错误只有三种形态，措辞是契约的一部分。每条都要：① 说清什么坏了；
② 把**下一步**写出来（能直接抄去 export）；③ 不让模型误以为「这个能力不存在」。

**① 一个可用 key 都没有（`auto` 兜底）** → 缺省**不注册工具**（stderr 一行说明）；配 `always_register: true` 时是 `provider_auth_failed`

```text
没有可用的搜索后端：按注册顺序（deepseek → tavily → serper → bocha）都没有可用的 key。设置其一即可：
deepseek → DEEPSEEK_API_KEY、tavily → VESSEL_TAVILY_API_KEY、serper → VESSEL_SERPER_API_KEY、
bocha → BOCHAAI_SEARCH_API_KEY；或用配置 search_provider 指定某一家（本次没有发出任何请求）
```

三个要素：**注册顺序**（解释为什么没选别家）、**每家 → 环境变量名**（可直接照抄）、
**「本次没有发出任何请求」**（排除「是不是白花了钱」）。加第五家 ⇒ 往「设置其一即可」那段续一项即可。

**② 显式指定了后端，但缺它那把 key** → `provider_auth_failed`，**只点名一家**

```text
环境变量 VESSEL_TAVILY_API_KEY 未设置或为空；设置后重试（本次没有发出任何请求）
```

**③ 配置写了没注册的后端** → `provider_unavailable`，列出在册 id

```text
配置 search_provider=bravesearch 没有对应的搜索后端；已注册：deepseek | serper | tavily
```

这条**不是** `provider_auth_failed`：它是配置错，不是缺凭据——两者的下一步动作完全不同。

共同规则：文案里**只出现环境变量名，永不出现 key 的值**；本地拒绝时**一次请求都不发**；
失败也要落到指标行（`backend` / `provider_id` / `code`），不许静默失败。

## 配置（全部在 `plugins[].config`，不进 `packages/config`）

> 拼写：`packages/config` 会把 `plugins[].config` 的键**转成 camelCase**
> （`search_provider` → `searchProvider`），插件这边的读法统一按 snake_case 写，
> 入口处做一次归一 ⇒ **两种拼写都认**（YAML 文档口径是 snake）。

| 键 | 缺省 | 说明 |
| --- | --- | --- |
| `backend` | `local` | `local` / `deepseek` |
| `search_provider` | `auto` | 搜索后端：`auto` / `deepseek` / `tavily` / `serper` / `custom:<id>`（选择顺序见上） |
| `custom_search` | `[]` | 声明式自定义后端（见下节）；每项注册成 `custom:<id>` |
| `always_register` | `false` | 无可用搜索 key 时也注册 `web_search`（默认不注册；见「可用性预检」） |
| `base_url` | `https://api.deepseek.com` | tools API 地址（不含末尾斜杠） |
| `key_env` | `DEEPSEEK_API_KEY` | **只写环境变量名**，绝不写 key 本身（写错在 install 时报错） |
| `search_key_env` / `fetch_key_env` | 空 | 分开账户时才用；空则回落 `key_env` |
| `allow_model_backend_override` | `false` | 是否允许模型用 `backend` 参数改后端 |
| `api_timeout_ms` | `15000` | 单次上游调用总 deadline（含重试与 body 读取） |
| `max_chars` | `8000` | 正文预算，上界 **32000**（全 CJK = 16000 token，正好撞闸） |
| `respect_robots` | `true` | 只对 `local` 生效 |
| `approval` | `open` | `open` / `guarded` / `locked`（`locked` 只走 `domain_allowlist`） |
| `renderer` | `none` | 只支持 `none`；与 `backend=deepseek` 冲突时安装即报错 |
| `search_detail_default` | `brief` | `brief`≈4000 tok / `full`≈8000 tok |
| `search_budget_brief_tokens` / `search_budget_full_tokens` | `4000` / `8000` | 都不得 ≥16000 |
| `search_summary_max_chars` / `search_content_max_chars` | `800` / `600` | 条级上限，实际值由预算算法继续压低 |
| `search_cache_ttl_s` / `search_cache_max_entries` | `600` / `128` | 搜索结果缓存（只存归一后的条目） |
| `fetch_cache_ttl_s` | `local 0` / `deepseek 1800` | 抓取结果缓存 |
| `retry_max` / `retry_base_ms` | `2` / `400` | 408 / 429 / 5xx / 网络层才重试；400/401/402/403/404/413 一次都不重试 |
| `search_qps` / `fetch_qps` / `fetch_host_min_interval_ms` | `5` / `3` / `500` | 自建限流（远低于服务端） |
| `max_uses_search_per_run` | **15** | `MAX_SEARCH_PER_RUN` |
| `max_uses_fetch_per_run` | **20** | `MAX_DEEPSEEK_FETCH_PER_RUN`（`local` 不计） |
| `max_billed_calls_per_day` | **500** | `MAX_BILLED_CALLS_PER_DAY`：**每进程**每日计费调用上限，跨 run 累积 |
| `breaker_failures` / `breaker_open_ms` | `5` / `60000` | 连续失败（不含 4xx）打开熔断，打开期间零请求 |
| `deepseek_fetch_block_query_string` | **`true`** | 带 query string 的 URL 缺省拦（一次性 token / 会话 id / 邮箱 = 外发） |
| `deepseek_fetch_allow_query_string_hosts` | `[]` | 显式白名单（主机名） |

## 三道成本闸（检查顺序：参数 → 缺 key → 熔断 → 每 run 配额 → 日上限 → 发请求）

前五步任何一步拒绝都**不产生网络往返**。**只数会被计费的调用**（search 结果非空、fetch 拿到正文），
失败不计入日上限——否则「失败把日配额烧光」会让工具在坏天气里彻底不可用。

单 run 配额挡不住跨 run 累积（一小时 20 个 run × 15 次搜索 = 1.5 元，没人会看），
所以 500 次/天的日上限是最后一道闸。

## 安全

- **key 只在 `Authorization: Bearer` 头里**：不进 URL、不进配置、不进缓存、不进日志；
  上游错误文本进 `message` 前做「精确串替换 + `sk-` 形态」双擦除。
- `local`：SSRF 全套（只 http(s)、只 80/443、拒 userinfo、私网/环回/链路本地/云元数据、
  每跳重查、禁 `https→http` 降级、5 MiB + 整体 deadline），robots 同源缓存 12h。
- `deepseek`：只做**语法校验**（内网字面量直接明拒），**不做 DNS/IP 判定**；
  **内网不可达是特性**，不是我们拦住了内网。新增风险是**数据外发**（URL 交给第三方）。
- `robots` 是**输出字段**：`local` = `respected`（或 `ignored (config)`），`deepseek` = `unknown`。
  服务端是否遵守 robots 不可知，**绝不允许写 respected**。

### 诚实的限度

定界块（`<untrusted-web-content>`）是**可读性 + 注意力**上的缓解，不是沙箱。
真正的边界是「工具只读、不发凭据、不写本地」。搜索片段与网页正文同属不可信内容，
都包在同一层定界块里；本插件不提供任何「按网页内容执行动作」的入口。

## 双后端「形状一致」= 语义一致，不是字段填满

`deepseek` 拿不到的东西一律如实标注，不用空值冒充能力：

| 字段 | local | deepseek |
| --- | --- | --- |
| `status` / `status_source` | 目标站点状态码 / `target` | 固定 200 / `api`（不代表目标站点状态） |
| `format` | `text`（本地抽取） | `markdown`（服务端给的） |
| `bytes` / `bytes_source` | 响应体字节 / `http-body` | 正文 UTF-8 字节 / `extracted-text` |
| `links` / `links_source` | 同域链接 / `backend` | `[]` / `none`（不许读成「这页没有链接」） |
| `redirects` / `redirects_known` | 跳链 / `true` | `[]` / `false`（服务端跳链不可见） |
| `robots` | `respected` | `unknown` |
