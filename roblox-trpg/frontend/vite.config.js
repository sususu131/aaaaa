import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发环境：前端 5173，/socket.io 代理到后端 3000（含 WebSocket 升级）
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    allowedHosts: true, // 允许预览代理域名访问
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
      },
      '/api': {
        target: 'http://localhost:3000',
      },
    },
  },
});
