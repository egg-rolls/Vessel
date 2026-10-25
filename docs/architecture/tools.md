---
title: 工具与权限边界
kind: current
triggers: [tool, bash, read, edit, permission, denylist, allowed_roots, agent, ask_user, mcp tool]
paths: [packages/core/src/types/tool.ts, plugins/tools/**, packages/agent/**]
---

# 工具与权限边界

<a id="tool-definition"></a>

### `ToolDefinition`（`types/tool.ts`）

```ts
interface ToolContext {
  session_id?: string;
  run_id: string;
  messages: Message[];
  events: EventStream;
}

type ToolHandler = (args: unknown, ctx: ToolContext) => Promise<string>;

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
  /** 超时毫秒数；缺省或 0 = 不限时 */
  timeout?: number;
  /** 执行时权限判定（allow/deny/ask）；缺省走 runtime 默认策略 */
  checkPermission?(input: unknown, ctx: ToolContext): Promise<'allow' | 'deny' | 'ask'>;
}
```

工具是**自描述对象**：权限判定与超时随工具走，不集中在 runtime 的一张策略表里。core 里**没有 `ToolRegistry` 接口**——唯一的工具注册表是 `PluginHost` / `MemoryPluginHost`。

工具的实际执行统一走 `ToolPipeline`（ADR-058）：`getTool` → ToolCall guardrail → BeforeTool hook → 权限（最终工具与参数）→ handler（timeout + signal）→ ToolResult guardrail → AfterTool hook（仅成功）。`ToolPipelineStages` 可关闭调用方已在外层处理的阶段；`AgentRuntime`（含 delegate 子 runtime）关闭 guardrail/BeforeTool/AfterTool，只复用 permission / handler / ToolResult。

<a id="tools"></a>

## 工具集：能力工具为什么这么少

默认运行期工具：`plugins/tools/basic-tools` 提供能力工具 **`bash` / `read` / `edit`**；`packages/agent` 提供内置 `agent`（默认注册；显式 `agent.enabled: false` 关闭）；`plugins/context/doc-subscription` 提供 `subscribe`（agent 显式订阅文件；变更只发短通知，按需 `inspect`；未 add 不通知）。`team_*` / `delegate_task` 已删除。

| 接缝 / 可选工具 | 注册条件 |
|---|---|
| `subscribe` | 默认注册（`doc-subscription` 插件）；agent 显式 add 文件后，变更只在下个 run 的系统提示里发一条短通知（path / id / rev / bytes），模型调用 `subscribe inspect` 才取 diff（首次全文）；正文不自动进历史。只接受具体文件，无 glob / 目录 / 自动发现 |
| `agent` | 默认注册；显式 `agent.enabled: false` 关闭。owner 动作 `new` / `send` / `close` / `list` / `rotate` / `post`（支持 batch；成员侧只暴露 `rotate` / `post` / `send` / `list`，`new` / `close` 只给 owner）；权限模式与成员配置见 `agent.*`（rotate 与 Team 动作见 ADR-091/092） |
| `ask_user` | 交互 REPL（stdin 是 TTY）或 `gateway start` / `--serve`；`--run` / headless / 管道不注册；`ui.askUser: false` 可关闭 |
| `mcp__<server>__<tool>` | 配置 `mcp_servers` 且 server 连接成功后注册；数量随 server 动态变化（ADR-039） |

口径：默认 = 能力工具 + `agent` + `subscribe`；显式 `agent.enabled: false` 去掉 `agent`；交互 REPL 或 gateway-serve 再加 `ask_user`。配置 MCP 后在基础上加 **N 个 MCP 工具**（N 由 server 提供）。`--tools` 一次性命令按 headless 口径列出，并注明 `ask_user (interactive REPL / gateway only)`；**`--tools` 不连接 MCP，因此不列出 MCP 工具**——需实际运行/连接后，经 REPL `/mcp` 或 gateway `GET /v1/mcp/servers` 查看。

| 工具 | inputSchema | 权限 | 行为 |
|---|---|---|---|
| `bash` | `{ command, cwd?, timeout_ms? }` | `ask`；cwd 命中 denylist → `deny`；配置 `allowed_roots` 后越界 → `ask` | `Bun.spawn(['bash','-c',command])`。超时默认 120s；输出超 2000 行时保留头 1000 + 尾 1000 并标注省略行数；超时返回明确错误文本而非抛异常 |
| `read` | `{ path, offset?, limit? }` | `allow`；命中 denylist → `deny`；配置 `allowed_roots` 后越界 → `ask` | 带行号返回（从 1 开始）。`limit` 默认 2000 行；截断时标注总行数与继续读的方式 |
| `edit` | `{ path, old_string, new_string, replace_all? }` | `ask`；命中 denylist → `deny`；配置 `allowed_roots` 后越界 → `ask` | `old_string` 必须**精确匹配且唯一**；不唯一时报错并说明匹配次数，未匹配时报错；`replace_all: true` 才允许多处替换 |

<a id="path-boundary"></a>

**路径边界（ADR-055；`edit` 同样适用）**：`read` / `edit` / `bash cwd` 先按真实路径（`realpath`；不存在的路径取最近已存在祖先）判定，`..` 与 symlink 不能绕过。内置 denylist（`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.vessel/config.yaml`）命中即 `deny`；插件 `config.allowed_roots` 非空时越界为 `ask`，`config.deny_paths` 追加到内置列表。默认 `allowed_roots` 为空 = 不限制根。`bash` 只校验 `cwd`，命令本身仍可访问其它路径——这不是沙箱。

**被判死的工具，以及为什么**：

| 删掉的 | 因为 |
|---|---|
| `grep` / `ls` / `cat` / `find` | `bash` 就能干，且组合能力更强 |
| file-ops（`write_file` / `create_dir` / `path_exists` / …） | `edit` 写、`bash` 建目录与判定存在 |
| meta-tools（`register_tool` / `search_assets` / `inspect_asset` / …） | 写文件即等于建工具：模型用 `bash` 落一个插件目录，下次启动被 `PluginLoader` 扫到 |
| skills-loader（scanner + CRUD + 文件监听） | skills 就是文件；前端引用、core 只收消息 |
| memory 插件 | 项目约定写在 `AGENTS.md`，模型自己读；跨会话笔记是 markdown 文件，模型自己读写 |

> MCP 不是「能力工具」，而是把外部工具接进 `PluginHost` 的插件（ADR-039）；它不占基础工具名额，也不改变能力工具的判据。

**evals / feishu 不注册模型工具**；工具口径：默认 = 能力工具 + `agent` + `subscribe`；交互模式再加 `ask_user`；另有 N 个 MCP 工具。

判据只有一条：**能被其他工具替代的工具，就不该存在**。工具越多，模型的选错空间越大；真正的通用原语只有"执行一条命令"，其余都是它的特化。

