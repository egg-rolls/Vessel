---
title: models 块配置项与校验
kind: current
triggers: [models, 模型注册表, credentials, entries, 凭证, 别称, alias, wire, model list, model set, credential-set, models-validation, models-disk, provider 兼容, param, pricing, 模型价格]
paths: [packages/config/src/models-validation.ts, packages/config/src/models-disk.ts, packages/config/src/types.ts, src/cli/commands/model.ts]
---

# models 块配置项与校验

> models 块的 YAML 形状 / 校验规则 / 磁盘与命令面运维手册。**机制家**（ModelRef 解析链 /
> param 优先级 / 价格合并视图 / legacy 兼容）在 [architecture/config.md](../architecture/config.md#models)；
> 一次性迁移见 [config-model-migration](config-model-migration.md)。

## YAML 形状（凭证面 + 模型面）

磁盘只有两种实体，**无密钥值**（user/project 层可叠、config-watch 热重载）：

```yaml
models:
  default: qwen4-max            # 有效默认 ref（别称或条目键），必须命中注册条目
  credentials:                  # 凭证面：认证端点（可被任意多个模型共享）
    soulkiller-gw:
      base_url: https://gw.example.com/v1   # 必填；http(s)
      api_key_env: DASHSCOPE_API_KEY        # 可选 env 间接来源；库值优先
  entries:                      # 模型面：扁平条目（键 = ref 主处理柄）
    qwen4-max:
      name: dashscope/qwen4-max # wire 名（缺省 = 条目键）
      alias: qwen               # 别称：单值、扁平唯一、不撞条目键
      provider: openai-compatible  # 协议适配（非品牌）；缺省 openai
      mode: chat                # wire 请求形状；缺省按 provider 推导
      credential: soulkiller-gw # 必填 ref → models.credentials
      pricing: { input_per_million: 2.0, output_per_million: 8.0 }
      param: { temperature: 0.7, max_tokens: 8192 }
      info: { display_name: Qwen4 Max, context_window: 262144 }
```

## 校验规则（`models-validation.ts`）

| 项 | 规则 |
|---|---|
| 凭证 id | `^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$`（字母/数字/连字符，大小写均可）；`legacy:` 前缀保留给合成凭证 |
| 凭证 baseUrl | 必填，http(s) URL；`api_key_env` 只写变量名 |
| 条目键 | `^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$`（wire 名可直接作键）；`legacy:` 前缀保留 |
| alias | 非空字符串、不含 `/`；与条目键共享一个扁平 ref 命名空间（不撞键、全局唯一） |
| provider | 规范协议集 `openai` / `openai-compatible` / `anthropic` / `gemini`；品牌工厂名（google/mistral/ollama/cohere）保留注册供 legacy 兼容；未知 provider 解析期 fail-fast + 候选 |
| mode | 枚举 `chat \| responses \| messages`；`responses` 是保留枚举（适配器未实现，配置即拒）；anthropic 只认 `messages`，openai 家族只认 `chat`；未知 provider（自定义插件工厂）只认枚举 |
| credential | 必须命中 `models.credentials`（报错列已注册 id） |
| param | `temperature` [0,2]；`maxTokens` 正整数；`topP` (0,1]；`extra` 命中 provider 保留请求体键（`RESERVED_BODY_KEYS_*`）写前拒绝 |
| info | 只展示/规划，永不进 wire 请求体；已知键（display_name/context_window/max_output_tokens/capabilities）有类型校验，未知键读容忍 |
| pricing | 四项费率非负（per 1M tokens）；同 wire 多 entry 价格不同 → warning，计量确定性取条目键序首个 |

## 磁盘与凭证值

- **凭证值**只经 `plugin.model-registry.credential_set` 写入 `<dataDir>/credentials.json`
  （AES-256-GCM 信封 v1，root-secret 派生 key）；yaml 永不存值。`credential_set` 一次写两处
  （先库值后 yaml 元数据）；`credentials_list` 回 `hasValue` / `usedBy`，值永不回显。
- **序列化口径**（`models-disk.ts`）：camelCase DTO → snake_case 磁盘形状，registry-store 写事务
  与一次性迁移共用；map 键（凭证 id / 条目键 / `param.extra` / info 未知键）原样保留。
  loader 反向映射（`preserveConfigMapKeys`）：`entries.<id>.info` 已知键 snake→camel，未知键原样。

## 命令面

```bash
vessel model list [--json]                          # 注册条目 + 默认 + 迁移报告消费
vessel model set <id> --entry <json>                # 写条目（校验同上）
vessel model remove <id>
vessel model set-default <ref>
vessel model credential-set <id> --base-url <url> [--value-env <ENV>]
vessel model credential-remove <id>
vessel model credentials-list
vessel model test [<entry>] [--credential <id>]     # 连通性测试
```

管理面：插件两 tab（凭证 → 模型）+ 上述 CLI（RPC 8 方法）；WebUI ModelPicker 选项 =
别称 + 条目键 + 跟随默认（无自由文本；存量未注册 pin 原样显示 + 标记）。

## provider 新旧键（legacy 兼容面）

新版配置只写一个 `provider:` 块（`name` / `base_url` / `api_key_env` / `model`）；legacy 键
`default_provider` / `default_model` / `providers.<name>.{apiKey,baseUrl,model}` 仅兼容。
同层并存时新版生效；只有 legacy 键时映射为 `provider:` 形状继续生效。已注册 provider 缺
`model` → 启动失败（`provider_invalid`），不回退全局默认。密钥统一走 `api_key_env` / `apiKey`，
不写 `${VAR}` 插值。provider 传输层重试**没有配置键**（core 常量 `DEFAULT_PROVIDER_RETRY_POLICY`，
嵌入方经 `ExecutionUnitOptions.retry` 覆写；见 [runtime-loop](../architecture/runtime-loop.md#loop)）。