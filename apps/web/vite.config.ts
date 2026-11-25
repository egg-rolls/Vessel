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
    // stderr 静音：在 git worktree 里 `git rev-parse` 会往 stderr 打
    // `fatal: not a git repository: .../worktrees/<name>`（.git 是文件不是目录时
    // 某些 git 版本的路径推断），那行噪声不该出现在构建输出里；
    // 非 git 环境（发布 tarball）同样静默降级成 'unknown'。
    commit = execSync('git rev-parse --short HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
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

/** 平台反代密钥头（与 `packages/serve/src/gateway/auth.ts` 的 `PROXY_SECRET_HEADER` 同名）。 */
const PROXY_SECRET_HEADER = 'x-vessel-proxy-secret';
/** 受信 relay 声明的页面真实 origin（与 `auth/routes.ts` 的 `TRUSTED_ORIGIN_HEADER` 同名）。 */
const TRUSTED_ORIGIN_HEADER = 'x-vessel-origin';

/**
 * 平台侧 `POST /platform/rpc` 带 cookie 的变更请求要过 CSRF 闸：`Origin` 的 host 必须等于
 * 网关看到的生效 Host。dev 下页面跑在 Vite origin、网关在平台端口，这条判据落空 ⇒ 403
 * `csrf_failed`。
 *
 * 解法**不是**把 Vite 端口加进同源名单（那样本机任何进程开的页面都能伪造），而是让这个
 * 我们自己的 dev 边缘带**密钥**并声明页面真实 origin —— 只有密钥成立时网关才采信声明
 * （与 `X-Forwarded-*` + 反代密钥同一套模式）。
 *
 * 密钥取自环境变量：`VESSEL_PLATFORM_PROXY_SECRET`（显式）优先，否则沿用
 * `VESSEL_DEV_RELAY_SECRET`（`bun run dev:web` 已经在用）。**两者都没设 ⇒ 什么都不发**，
 * 行为与今天逐字一致。
 */
const PLATFORM_PROXY_SECRET =
  process.env.VESSEL_PLATFORM_PROXY_SECRET ?? process.env.VESSEL_DEV_RELAY_SECRET;

/**
 * 声明值：缺省「浏览器发来的 Origin」（忠实转发）。若 dev 边缘改写了 Host
 * （`changeOrigin: true` 或 relay 转发到别的端口），就用这个变量显式声明
 * 「网关是以哪个 origin 被访问的」—— 声明必须是 edge 的事实，不能猜。
 */
const TRUSTED_ORIGIN_CLAIM = process.env.VESSEL_TRUSTED_ORIGIN_CLAIM;

function platformProxyConfigure(): NonNullable<ProxyOptions['configure']> | undefined {
  if (PLATFORM_PROXY_SECRET === undefined || PLATFORM_PROXY_SECRET === '') return undefined;
  return (proxy) => {
    proxy.on(
      'proxyReq',
      (
        proxyReq: { setHeader(name: string, value: string): void },
        req: { headers: Record<string, string | string[] | undefined> },
      ) => {
        proxyReq.setHeader(PROXY_SECRET_HEADER, PLATFORM_PROXY_SECRET);
        const fromEnv = TRUSTED_ORIGIN_CLAIM;
        const claimed =
          typeof fromEnv === 'string' && fromEnv !== '' ? fromEnv : req.headers.origin;
        // 没有声明值就不发：让网关按老规则判（声明必须是「我看到的事实」，不是猜的）。
        if (typeof claimed === 'string' && claimed !== '') {
          proxyReq.setHeader(TRUSTED_ORIGIN_HEADER, claimed);
        }
      },
    );
  };
}

const platformConfigure = platformProxyConfigure();

const relay =
  RELAY_URL !== undefined && RELAY_URL !== '' && RELAY_SECRET !== undefined && RELAY_SECRET !== ''
    ? { url: RELAY_URL, secret: RELAY_SECRET }
    : null;

const nodeTarget = relay?.url ?? NODE;
const configure = relay ? relayConfigure(relay.secret) : undefined;

const PLUGIN_UI_SRC = resolve(__dirname, '../../packages/plugin-ui/src');
const PLUGIN_SDK_SRC = resolve(__dirname, '../../packages/plugin-sdk/src');

/** SDK 版本只有一份真源（plugin-sdk package.json）；构建期 define 注入运行时。 */
const PLUGIN_SDK_VERSION = (
  JSON.parse(readFileSync(resolve(PLUGIN_SDK_SRC, '../package.json'), 'utf8')) as {
    version: string;
  }
).version;

// ── plugin-embed 契约 §6：React 单例 vendor shim + 冻结 import map ─────────
//
// 宿主 bundle 与插件 ESM 必须共用同一份 React 实例：main.tsx 在 createRoot 前
// 把 namespace import 挂到 globalThis.__VESSEL_SHARED__，下面的 shim 只做静态
// 具名导出 + default，全部取自该注册表（未注册时 throw，fail-closed）。
// import map 把裸说明符映射到稳定路径的 shim；JSON 逐字冻结，它的 sha256 与
// gateway/auth.ts buildContentSecurityPolicy 的 script-src 哈希互为契约
// （docs/architecture/plugin-embed.md §6）：改一处必须同步改另一处并重算。

const IMPORT_MAP_JSON =
  '{"imports":{"react":"/assets/vendor/react.mjs","react-dom":"/assets/vendor/react-dom.mjs","react-dom/client":"/assets/vendor/react-dom-client.mjs","react/jsx-runtime":"/assets/vendor/jsx-runtime.mjs","@vessel-agent/plugin-sdk":"/assets/vendor/plugin-sdk.mjs"}}';

/** 生成一个 vendor shim：静态具名导出 + default，全部取自 __VESSEL_SHARED__。 */
function vendorShim(namespace: string, names: readonly string[]): string {
  return [
    'const shared = globalThis.__VESSEL_SHARED__;',
    `if (!shared || !shared.${namespace}) throw new Error('[vessel] __VESSEL_SHARED__.${namespace} is not registered; embedded plugin vendor shim cannot load.');`,
    `const mod = shared.${namespace};`,
    ...names.map((name) => `export const ${name} = mod.${name};`),
    // default 取模块自身的 default（react / react-dom 有）；没有 default 的
    // 模块（jsx-runtime / plugin-sdk）回落到 namespace 对象。
    'export default mod.default ?? mod;',
    '',
  ].join('\n');
}

/** React 19 导出面（契约 §6 冻结清单）。 */
const REACT_EXPORTS = [
  'Children',
  'Component',
  'Fragment',
  'Profiler',
  'PureComponent',
  'StrictMode',
  'Suspense',
  'cloneElement',
  'createContext',
  'createElement',
  'createRef',
  'forwardRef',
  'isValidElement',
  'lazy',
  'memo',
  'startTransition',
  'use',
  'useActionState',
  'useCallback',
  'useContext',
  'useDebugValue',
  'useDeferredValue',
  'useEffect',
  'useId',
  'useImperativeHandle',
  'useInsertionEffect',
  'useLayoutEffect',
  'useMemo',
  'useOptimistic',
  'useReducer',
  'useRef',
  'useState',
  'useSyncExternalStore',
  'useTransition',
  'version',
] as const;

const VENDOR_SHIMS: Readonly<Record<string, string>> = {
  'react.mjs': vendorShim('React', REACT_EXPORTS),
  'react-dom.mjs': vendorShim('ReactDOM', [
    'createPortal',
    'flushSync',
    'preload',
    'preinit',
    'prefetchDNS',
    'preconnect',
    'version',
  ]),
  'react-dom-client.mjs': vendorShim('ReactDOMClient', ['createRoot', 'hydrateRoot']),
  'jsx-runtime.mjs': vendorShim('JsxRuntime', ['Fragment', 'jsx', 'jsxs']),
  'plugin-sdk.mjs': vendorShim('PluginSdk', [
    'createPluginHost',
    'compareSemver',
    'isValidSemver',
    'parseRangeVersion',
    'parseSemver',
    'parseVersionRange',
    'satisfiesComparator',
    'satisfiesVersionRange',
  ]),
};

const VENDOR_PATH_PREFIX = '/assets/vendor/';

/**
 * vendor shim 的稳定路径服务：构建期 emitFile 到 `assets/vendor/*.mjs`，
 * dev 用 configureServer 中间件同路径服务；transformIndexHtml 在 <head> 最前
 * （第一个 module script 之前）注入冻结 import map（tag 内无任何附加空白）。
 */
function vesselPluginEmbed(): Plugin {
  return {
    name: 'vessel-plugin-embed',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? '').split('?')[0] ?? '';
        const name = pathname.startsWith(VENDOR_PATH_PREFIX)
          ? pathname.slice(VENDOR_PATH_PREFIX.length)
          : '';
        const source = Object.hasOwn(VENDOR_SHIMS, name) ? VENDOR_SHIMS[name] : undefined;
        if (source === undefined) {
          next();
          return;
        }
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(source);
      });
    },
    transformIndexHtml(html) {
      return {
        html,
        tags: [
          {
            tag: 'script',
            attrs: { type: 'importmap' },
            children: IMPORT_MAP_JSON,
            injectTo: 'head-prepend',
          },
        ],
      };
    },
    generateBundle() {
      for (const [name, source] of Object.entries(VENDOR_SHIMS)) {
        this.emitFile({ type: 'asset', fileName: `assets/vendor/${name}`, source });
      }
    },
  };
}

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
      // plugin-sdk 同样按源码消费（plugin-embed 契约 §7）：宿主 bundle 与
      // vendor shim 共用同一份模块实例。
      {
        find: '@vessel-agent/plugin-sdk',
        replacement: resolve(PLUGIN_SDK_SRC, 'index.ts'),
      },
      // q-addr-display：地址显示纯函数（零 import leaf）按源码消费，与 tsconfig paths
      // 同一映射。只开放这一个子路径 —— agent 包根有 node 依赖，不进 web bundle。
      {
        find: '@vessel-agent/agent/address-display',
        replacement: resolve(__dirname, '../../packages/agent/src/address-display.ts'),
      },
    ],
  },
  plugins: [react(), tailwindcss(), writeBuildStamp(), vesselPluginEmbed()],
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
    // embed loader 的运行时版本核对用（plugin-embed 契约 §7/§8）；
    // 真源是 plugin-sdk package.json，不在源码硬编码第二份。
    __VESSEL_PLUGIN_SDK_VERSION__: JSON.stringify(PLUGIN_SDK_VERSION),
  },
  server: {
    port: 5173,
    proxy: {
      // 平台入口：独立监听；不经过 dev relay（平台 token 是静态 bearer）。
      // `configure` 只在设了平台反代密钥时才有：带上密钥头 + 页面 origin 声明，
      // 让带 cookie 的变更请求能过 CSRF 闸（见 platformProxyConfigure 的注释）。
      '/platform': {
        target: PLATFORM,
        changeOrigin: false,
        ...(platformConfigure !== undefined ? { configure: platformConfigure } : {}),
      },
      // node 入口：WS + legacy 回退。
      '/v1': { target: nodeTarget, ws: true, changeOrigin: false, configure },
      '/health': { target: nodeTarget, changeOrigin: false, configure },
    },
  },
});
