import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin, type ProxyOptions } from 'vite';

/**
 * 构建指纹：构建结束时写 `<dist>/build.json`，供 gateway 读取比对。
 *
 * `dist` 不入 git，gateway 直接托管它 —— 源码改了但忘了重新构建时，界面会一直是旧的，
 * 而 `v0.29.0` 这种版本号在构建前后一模一样，光看版本区分不出来。
 *
 * 为什么写文件而不是只在页面里显示：**要让网关来判断**。人不会主动去看时间戳，
 * 但网关可以在启动 / `gateway status` 时自己读 `build.json` 与自身 commit 比对，
 * 不一致就直接说「Web 产物是旧的，请重新构建」。
 */
function buildStamp(): { builtAt: string; version: string; commit: string } {
  let commit = 'unknown';
  try {
    commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    // 非 git 环境（发布 tarball）不阻断构建。
  }
  let version = 'unknown';
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8')) as {
      version?: string;
    };
    version = pkg.version ?? 'unknown';
  } catch {
    // 同上。
  }
  return { builtAt: new Date().toISOString(), version, commit };
}

const STAMP = buildStamp();

/** 构建结束写 `<dist>/build.json`；gateway 读它判断 Web 产物是不是旧的。 */
function writeBuildStamp(): Plugin {
  return {
    name: 'vessel-build-stamp',
    apply: 'build',
    closeBundle() {
      const outDir = join(__dirname, 'dist');
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, 'build.json'), `${JSON.stringify(STAMP, null, 2)}\n`, 'utf8');
    },
  };
}

// 生产：Platform Gateway 托管 dist（同源，无 CORS）。
// 0.49 双入口：
//   - `/platform` → 平台 gateway（默认 8642，`/platform/rpc`）；
//   - `/v1`       → node API（默认 8644，`/v1/rpc`、`/v1/events` WS）；
//   - `/health`   → node（legacy/同源 node 连接的预探）。
// 开发：`bun run dev:web` 会起一个只绑回环的 dev relay，由它注入 token：
//   - REST/SSE 覆盖 Authorization；
//   - WS 首帧 {kind:'auth'} 替换 token（http-proxy 改不了帧）。
// 因此 Vite 本身不读取、不传递任何 token，只拿 relay 地址 + 每次运行的 secret。
// relay 只服务 node 侧（`/v1`、`/health`），平台 RPC 直连。
// 注意 changeOrigin:false——保留原始 Host；relay 会按需移除。
const PLATFORM =
  process.env.VESSEL_PLATFORM_URL ?? process.env.VESSEL_GATEWAY_URL ?? 'http://127.0.0.1:8642';
const NODE = process.env.VESSEL_NODE_URL ?? 'http://127.0.0.1:8644';
const RELAY_URL = process.env.VESSEL_DEV_RELAY_URL;
const RELAY_SECRET = process.env.VESSEL_DEV_RELAY_SECRET;
const RELAY_HEADER = 'x-vessel-dev-relay';

function relayConfigure(secret: string): NonNullable<ProxyOptions['configure']> {
  return (proxy) => {
    const addRelayHeader = (proxyReq: { setHeader(name: string, value: string): void }): void => {
      proxyReq.setHeader(RELAY_HEADER, secret);
    };
    proxy.on('proxyReq', addRelayHeader);
    proxy.on('proxyReqWs', addRelayHeader);
  };
}

const relay =
  RELAY_URL !== undefined && RELAY_URL !== '' && RELAY_SECRET !== undefined && RELAY_SECRET !== ''
    ? { url: RELAY_URL, secret: RELAY_SECRET }
    : null;

const nodeTarget = relay?.url ?? NODE;
const configure = relay ? relayConfigure(relay.secret) : undefined;

const PLUGIN_UI_SRC = resolve(__dirname, '../../packages/plugin-ui/src');

export default defineConfig({
  // 品牌资源只有一份：仓库根 `assets/`。Web 直接把它当 public 目录，
  // 图标既能在 index.html 里按 `/Vessel.svg` 引用，也能被 README 用相对路径引用。
  publicDir: join(__dirname, '../../assets'),
  resolve: {
    // 顺序重要：styles.css 必须先于包根匹配，否则会被当成目录 index。
    alias: [
      {
        find: '@vessel-agent/plugin-ui/styles.css',
        replacement: resolve(PLUGIN_UI_SRC, 'styles.css'),
      },
      {
        find: '@vessel-agent/plugin-ui',
        replacement: resolve(PLUGIN_UI_SRC, 'index.ts'),
      },
    ],
  },
  plugins: [react(), tailwindcss(), writeBuildStamp()],
  build: {
    // 500 kB 是给「公网 CDN 上的多页应用」定的阈值：首屏之外的 chunk 可以慢慢拉，
    // 单块太大才值得拆。这个站不是那个形状 —— 单页应用、dist 由本地 gateway
    // **同源**托管（`vessel gateway start` 起的进程直接读盘发文件）、离线首屏一次性
    // 加载，没有「多页共享缓存」可以摊薄首块成本。
    //
    // 实测量级（vite 输出，见下面 manualChunks 拆完的样子）：主 chunk 764 kB，
    // gzip 后约 216 kB；加上 react-vendor / plugin-ui / CSS，整站首屏传输约 308 kB，
    // 本地回环一次读完。也就是说这条警告惩罚的是「源码行数」，不是「用户等多久」。
    //
    // 所以把阈值调到 800 kB：留约 5% 余量，让这条警告重新变成**新增依赖失控**的
    // 信号（谁再塞进一个几百 kB 的库照样报），而不是每次构建都在背景里刷。
    // 真正的降本手段是按路由动态 import（要改 `apps/web/src/**`），不在本轮范围。
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        // 拆分只按**依赖的包边界**切，不动应用源码：`apps/web/src/**` 的分层
        // （`src/gateway/**` 等）由 check-deps 看守，按目录硬切 chunk 极易造出
        // chunk 环（A→B→A）。三方包之间没有反向依赖，插件 UI 包也只被 app
        // 单向依赖，切开天然无环。
        //
        // react / react-dom / scheduler 是最大的一块且**几乎不变**：独立成 chunk
        // 后改应用代码只有应用自己的 chunk 变哈希，这块可以长期缓存。
        manualChunks(id: string): string | undefined {
          // 共享 UI 包按源码消费（见上面 alias），但它同样只被 app 单向依赖。
          if (/[\\/]packages[\\/]plugin-ui[\\/]src[\\/]/.test(id)) return 'plugin-ui';
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
            return 'react-vendor';
          }
          return undefined;
        },
      },
    },
  },
  define: {
    // 页面把「我是哪一次构建」编进 bundle，运行时与 `dist/build.json` 比对，
    // 不一致就提示刷新 —— 后台重建完成后用户能立刻知道。
    __VESSEL_WEB_BUILD__: JSON.stringify(STAMP),
  },
  server: {
    port: 5173,
    proxy: {
      // 平台入口：独立监听；不经过 dev relay（平台 token 是静态 bearer）。
      '/platform': { target: PLATFORM, changeOrigin: false },
      // node 入口：WS + legacy 回退。
      '/v1': { target: nodeTarget, ws: true, changeOrigin: false, configure },
      '/health': { target: nodeTarget, changeOrigin: false, configure },
    },
  },
});
