/**
 * 服务器入口：Express + HTTP + Socket.io。
 * 端口 3000；开发环境由 Vite 代理 /socket.io。
 */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { initDb } = require('@roblox-trpg/database');
const { PORT } = require('./config');
const registerSocketHandlers = require('./sockets/handlers');

// 启动即建表（幂等）
initDb();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }, // 开发环境允许 Vite dev server 直连；生产走同源代理
});

app.get('/health', (_req, res) => res.json({ ok: true, name: 'roblox-trpg-server' }));

registerSocketHandlers(io);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] roblox-trpg 服务器已启动: http://localhost:${PORT}`);
});

module.exports = { app, server, io };
