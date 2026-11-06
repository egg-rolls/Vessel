# Web 控制台开发

`apps/web` 不在根 bun workspaces 里，依赖单独安装：

```bash
cd apps/web
npm ci
```

需要 Node `^20.19.0 || >=22.12.0`（Vite 7 要求）。以下命令都在仓库根执行。

## 三条回路

### 1. Vite 开发回路（HMR，推荐日常）

```bash
bun run dev:web
```

脚本会：

1. 检查本机 gateway 是否已在配置端口（平台默认 `8642`）运行；未运行则 `gateway start --daemon`（同时监听 node `8644`）。
2. 在 `127.0.0.1` 起一个仅本机可访问的 relay，负责把真实 node token 注入 HTTP `Authorization` 与 WebSocket 首帧（只覆盖 `/v1`、`/health`）。
3. 在 `127.0.0.1:5173` 启动 Vite（`--strictPort`）。

打开 <http://127.0.0.1:5173>。无显式凭据时自动进入 dev 代理模式，不需要在页面里填 node token；浏览器只持有非密钥占位 token。平台入口走 `/platform` 直连（回环未配置平台 token 时匿名只读）。

Ctrl+C 只停止本脚本启动的 Vite/relay/gateway；如果 gateway 是你事先启动的，脚本不会停它。

真实 token 来源（优先级）：

1. 环境变量 `VESSEL_DEV_TOKEN`；
2. 用户配置的 `serve.token` / `serve.token_env` / `serve.admin_token(_env)` / `VESSEL_GATEWAY_TOKEN` / `transport.token`。

token 只存在于 `dev:web`/relay 进程，不写入前端 bundle、HTML、localStorage 或日志。

**显式凭据优先**：以下任一存在时，dev 代理模式关闭：

- URL `#token=...`（作为平台 token 种子；legacy 回退时同时用于 node）
- `sessionStorage['vessel.platform-token']`（平台 token 槽）
- `localStorage['vessel.gateway-url']`（语义 = 平台 origin；空串 = 页面同源）

node token 不在此列：平台模式下由 `platform.nodes.credentials` 提供，或由设置页的可选输入手填；legacy 回退使用旧的 `sessionStorage['vessel.token']`。所有 token 都只进 sessionStorage，绝不写 localStorage / URL / 日志。

**两个 URL**：`platformUrl` 连 `/platform/rpc`；`nodeUrl` 来自 `platform.nodes.list` 的 `api_url`，连 `/v1/rpc` 与 `/v1/events`。Vite 开发代理也是两个目标：`/platform` → `VESSEL_PLATFORM_URL`（默认 8642），`/v1` → `VESSEL_NODE_URL`（默认 8644）。跨源开发还要把 Vite origin（默认 `http://127.0.0.1:5173`）加入 `gateway.allowed_origins` 与 `serve.allowed_origins`。

### 2. dist 验证回路（接近生产）

```bash
bun run build:web:watch
bun run src/cli.ts gateway start
```

打开 <http://127.0.0.1:8642>（平台入口）。gateway 每次请求都读 `apps/web/dist`：`index.html` 为 `no-cache`，带 hash 的资源为 immutable，改完代码等 watch 输出后刷新即可。

`apps/web/dist` 不入 git。拆分模式启动时若 `apps/web/dist/index.html` 缺失会 fail-fast（P10）；旧于 `apps/web/src` 时由现有后台重建处理。legacy `--serve` 的自动构建行为不变。

### 3. 检查点回路

每个 commit：

```bash
bun run typecheck
bunx @biomejs/biome ci .
cd apps/web && npm run typecheck
```

检查点 / 收口：

```bash
bun run typecheck
bunx @biomejs/biome ci .
cd apps/web && npm run build
VESSEL_MOCK=1 bun run src/cli.ts --run "hello"
```

仓库没有自动化测试套件：Web 侧改动靠 `npm run typecheck` / `npm run build` 与人工验收。

## 脚本

| 命令 | 作用 |
|---|---|
| `bun run dev:web` | gateway（必要时）+ relay + Vite 5173 |
| `bun run build:web:watch` | `vite build --watch`，持续更新 `apps/web/dist` |
| `cd apps/web && npm run build` | 类型检查 + 生产构建 |
| `cd apps/web && npm run typecheck` | 只做类型检查 |

## 排查

- **5173 被占用**：dev 脚本使用 `--strictPort`，会直接失败；先释放端口。
- **8642 / 8644 被其它程序占用**：脚本不会杀未知进程；先停掉占用者，或用 `gateway.port` / `serve.port` 换端口。
- **`VESSEL_DEV_TOKEN` 与运行中 gateway 不匹配**：页面显示鉴权失败。去掉该变量让脚本读用户配置，或改成运行中 gateway 的真实 token。
- **缺少 `apps/web/node_modules`**：`cd apps/web && npm ci`（脚本不会自动安装）。
- **看不到新界面**：确认用的是 Vite 回路（5173）还是 dist 回路（8642）；dist 回路需要 `build:web:watch` 或手动 build。
- **`VESSEL_STATIC_DIR`**：覆盖 gateway 托管目录；自定义目录只检查 `index.html` 是否存在，不做过期比较。
