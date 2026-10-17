import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 生产：gateway 托管 dist（同源，无 CORS）。
// 开发：Vite dev server 反向代理 /v1 与 /health 到 127.0.0.1:8642（含 WS）。
// 注意 changeOrigin:false——保留原始 Host，gateway 的 Origin/Host 同源校验才会通过。
const GATEWAY = process.env.VESSEL_GATEWAY_URL ?? 'http://127.0.0.1:8642';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/v1': { target: GATEWAY, ws: true, changeOrigin: false },
      '/health': { target: GATEWAY, changeOrigin: false },
    },
  },
});
