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
const visionRoutes = require('./routes/visionRoutes');
const dungeonRoutes = require('./routes/dungeonRoutes');
const runtimeRoutes = require('./routes/runtimeRoutes');
const characterRoutes = require('./routes/characterRoutes');
const questRoutes = require('./routes/questRoutes');
const npcRoutes = require('./routes/npcRoutes');

// 启动即建表（幂等）
initDb();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

app.use(express.json({ limit: '2mb' }));
app.get('/health', (_req, res) => res.json({ ok: true, name: 'roblox-trpg-server', stage: 10 }));
app.use('/api', apiRoutes);
app.use(visionRoutes); // /api/vision/avatar/analyze、/vision-test 等
app.use(dungeonRoutes); // 阶段4：Dungeon Design Pipeline
app.use(runtimeRoutes); // 阶段5：Dungeon Runtime
app.use(characterRoutes); // 阶段6：Persistent Character
app.use(questRoutes); // 阶段8：Quest System
app.use(npcRoutes); // 阶段9：NPC & Living World

registerSocketHandlers(io);

// 阶段9：NPC Listener（Game Event Bus → NPC 反应，服务器规则决定）
require('./services/npcs/npcListener').registerNpcListener();

// 作为入口运行时才监听端口（测试可直接 require 后自管端口）
if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] roblox-trpg 服务器已启动（阶段3）: http://localhost:${PORT}`);
  });
}

module.exports = { app, server, io };
