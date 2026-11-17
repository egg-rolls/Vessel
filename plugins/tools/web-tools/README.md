# @vessel-agent/web-tools

`web_search`（三家搜索后端）+ `web_fetch`（双后端）。设计：`docs/dev/design/0.56-web-tools.md`。

**默认加载**（0.56 起）：任何会话都能用 `web_search` / `web_fetch`，缺 key 时工具**仍然在**，
调用时报 `provider_auth_failed` 并点名要设置哪个环境变量。想关掉：`plugins:` 里写
`- name: web-tools` + `enabled: false`。

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
src/fetch/provider.ts           FetchBackend 接口 + 注册表
src/fetch/local.ts              local 抓取（SSRF / robots / 抽取全在 http.ts）
src/deepseek-fetch.ts           deepseek 抓取
src/search/index.ts             共用层：校验 → 选后端 → 缺 key → 缓存 → 三道闸 → 限流 → 重试 → 预算 → 定界渲染
```

加一个搜索后端＝写一个 `SearchProvider` 实现 + 在 `backends.ts` 加一行：**工具层、预算、缓存键、闸一行都不用改**
（缓存键带 `provider_id` + `provider_version`，两个后端的结果不会串味）。

⚠️ **但「一行」只在鉴权风格与 key 名跟 deepseek 一样时成立**。期 2 实测：`search/index.ts` 曾把
provider 与 transport 写死（`DEFAULT_SEARCH_PROVIDER_ID` + `createDeepSeekHttp`），那时注册是**假的**。
现在新后端若**鉴权头不同**或**key 变量名不同**，还需要在实现里提供两个可选字段（不是改共用层）：

- `keyEnv`：这家缺省读哪个环境变量（配置 `search_key_env` 仍可覆盖）；
- `createHttp?()`：自带 `ProviderHttp`（`createJsonHttp` 已把固定 host + 自定义头包好），
  **重试/退避/错误映射/擦除仍是同一份**——不要在适配器里另写一套闸；
- `maxCount?`：上游条数上限（Tavily 20），由 provider 自己夹紧。


## 搜索后端（三选一，`search_provider` 或注册顺序）

| 后端 | key 环境变量 | 摘要来源 | 正文 | 过滤支持 |
| --- | --- | --- | --- | --- |
| `deepseek` | `DEEPSEEK_API_KEY` | 上游 `summary` | `need_content` | `site:` / `lang:` / `after:` / `before:` 渲染进 query |
| `tavily` | `VESSEL_TAVILY_API_KEY` | 上游 `content`（它自己的摘要口径） | `include_raw_content` | 只支持 `site`（走 `include_domains`）；**`lang` / `after` / `before` 没有对应参数，不做过滤**；结果上限 20 |
| `serper` | `VESSEL_SERPER_API_KEY` | 上游 `snippet`（Google `organic[]` 里**没有** `summary` 字段） | **没有正文**（`need_content` 无效，要全文用 `web_fetch`） | `site:` 拼进 `q`；`lang` → `hl`/`gl`；`after`/`before` → `tbs` |

三家的 `authority` 只有 `deepseek` 有；Tavily 的 `score` 是相关性、Serper 不给权威度，**都不冒充**。
`date`：Tavily 给绝对日期，Serper 是 Google 的相对时间（`2 days ago`）——**原样透传**，不解析。

### 选择顺序（写在工具描述里，模型也能看见）

1. 配置优先：`search_provider: tavily` ⇒ 只用它（没注册就 `provider_unavailable`）；
2. 否则 `auto`（缺省）⇒ **按 `src/backends.ts` 的注册顺序**取第一个 key 在位的：`deepseek → tavily → serper`；
3. 一个 key 都没有 ⇒ `provider_auth_failed`，文案里列出每家要哪个环境变量（不发请求、不降级）。

选中谁是可观测的：结果的 `backend: <id>` 与指标行的 `provider_id` 都是它。

## 配置（全部在 `plugins[].config`，不进 `packages/config`）

| 键 | 缺省 | 说明 |
| --- | --- | --- |
| `backend` | `local` | `local` / `deepseek` |
| `search_provider` | `auto` | 搜索后端：`auto` / `deepseek` / `tavily` / `serper`（选择顺序见上） |
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
