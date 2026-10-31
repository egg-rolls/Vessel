import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

// 生产：gateway 托管 dist（同源，无 CORS）。
// 开发：`bun run dev:web` 会起一个只绑回环的 dev relay，由它注入 token：
//   - REST/SSE 覆盖 Authorization；
//   - WS 首帧 {kind:'auth'} 替换 token（http-proxy 改不了帧）。
// 因此 Vite 本身不读取、不传递任何 token，只拿 relay 地址 + 每次运行的 secret。
// 没有 relay 时保持旧行为：直连 127.0.0.1:8642。
// 注意 changeOrigin:false——保留原始 Host；relay 会按需移除。
const GATEWAY = process.env.VESSEL_GATEWAY_URL ?? 'http://127.0.0.1:8642';
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

const target = relay?.url ?? GATEWAY;
const configure = relay ? relayConfigure(relay.secret) : undefined;

export default defineConfig({
  plugins: [react(), tailwindcss(), writeBuildStamp()],
  server: {
    port: 5173,
    proxy: {
      '/v1': { target, ws: true, changeOrigin: false, configure },
      '/health': { target, changeOrigin: false, configure },
    },
  },
});
