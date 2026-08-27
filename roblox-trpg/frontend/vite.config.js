import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发环境：前端 5173，/socket.io 代理到后端 3000（含 WebSocket 升级）
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
      },
    },
  },
});
