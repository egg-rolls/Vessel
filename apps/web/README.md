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

1. 检查本机 gateway 是否已在配置端口（默认 `8642`）运行；未运行则 `gateway start --daemon`。
2. 在 `127.0.0.1` 起一个仅本机可访问的 relay，负责把真实 token 注入 HTTP `Authorization` 与 WebSocket 首帧。
3. 在 `127.0.0.1:5173` 启动 Vite（`--strictPort`）。

打开 <http://127.0.0.1:5173>。无显式凭据时自动进入 dev 代理模式，不需要在页面里填 token；浏览器只持有非密钥占位 token。

Ctrl+C 只停止本脚本启动的 Vite/relay/gateway；如果 gateway 是你事先启动的，脚本不会停它。

真实 token 来源（优先级）：

1. 环境变量 `VESSEL_DEV_TOKEN`；
2. 用户配置的 `serve.token` / `serve.token_env` / `serve.admin_token(_env)` / `VESSEL_GATEWAY_TOKEN` / `transport.token`。

token 只存在于 `dev:web`/relay 进程，不写入前端 bundle、HTML、localStorage 或日志。

**显式凭据优先**：以下任一存在时，dev 代理模式关闭，按原逻辑使用页面里的 token / gateway URL：

- URL `#token=...`
- `sessionStorage['vessel.token']`
- `localStorage['vessel.gateway-url']`

### 2. dist 验证回路（接近生产）

```bash
bun run build:web:watch
bun run src/cli.ts gateway start
```

打开 <http://127.0.0.1:8642>。gateway 每次请求都读 `apps/web/dist`：`index.html` 为 `no-cache`，带 hash 的资源为 immutable，改完代码等 watch 输出后刷新即可。

`apps/web/dist` 不入 git。gateway 启动时若发现 `apps/web/dist/index.html` 缺失，或旧于 `apps/web/src`，会向 stderr 打一行提示（退出码不变）。

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
- **8642 被其它程序占用**：脚本不会杀未知进程；先停掉占用者，或用 `serve.port` 换端口。
- **`VESSEL_DEV_TOKEN` 与运行中 gateway 不匹配**：页面显示鉴权失败。去掉该变量让脚本读用户配置，或改成运行中 gateway 的真实 token。
- **缺少 `apps/web/node_modules`**：`cd apps/web && npm ci`（脚本不会自动安装）。
- **看不到新界面**：确认用的是 Vite 回路（5173）还是 dist 回路（8642）；dist 回路需要 `build:web:watch` 或手动 build。
- **`VESSEL_STATIC_DIR`**：覆盖 gateway 托管目录；自定义目录只检查 `index.html` 是否存在，不做过期比较。
