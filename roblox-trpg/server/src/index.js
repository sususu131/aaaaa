/**
 * 服务器入口：Express + HTTP + Socket.io + REST API。
 * 端口 3000；开发环境由 Vite 代理 /socket.io 与 /api。
 */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { initDb } = require('@roblox-trpg/database');
const { PORT } = require('./config');
const registerSocketHandlers = require('./sockets/handlers');
const apiRoutes = require('./routes/apiRoutes');

// 启动即建表（幂等）
initDb();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

app.use(express.json());
app.get('/health', (_req, res) => res.json({ ok: true, name: 'roblox-trpg-server', stage: 2 }));
app.use('/api', apiRoutes);

registerSocketHandlers(io);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] roblox-trpg 服务器已启动（阶段2）: http://localhost:${PORT}`);
});

module.exports = { app, server, io };
