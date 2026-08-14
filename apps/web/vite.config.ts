import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 本地控制台默认直连 http://localhost:8642 的 gateway（gateway 已开启宽松 CORS）。
// 可通过环境变量 VITE_GATEWAY_URL 覆盖目标地址（例如远程部署）。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
});
