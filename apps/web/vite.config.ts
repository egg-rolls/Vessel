import react from '@vitejs/plugin-react';
import { defineConfig, type ProxyOptions } from 'vite';

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
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/v1': { target, ws: true, changeOrigin: false, configure },
      '/health': { target, changeOrigin: false, configure },
    },
  },
});
