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
const worldRoutes = require('./routes/worldRoutes');
const partyDecisionRoutes = require('./routes/partyDecisionRoutes');

// 启动即建表（幂等）
initDb();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

app.use(express.json({ limit: '2mb' }));
app.get('/health', (_req, res) => res.json({ ok: true, name: 'roblox-trpg-server', stage: 13 }));
app.use('/api', apiRoutes);
app.use(visionRoutes); // /api/vision/avatar/analyze、/vision-test 等
app.use(dungeonRoutes); // 阶段4：Dungeon Design Pipeline
app.use(runtimeRoutes); // 阶段5：Dungeon Runtime
app.use(characterRoutes); // 阶段6：Persistent Character
app.use(questRoutes); // 阶段8：Quest System
app.use(npcRoutes); // 阶段9：NPC & Living World
app.use(worldRoutes); // 阶段12：World Simulation & Dynamic Events
app.use(partyDecisionRoutes); // 阶段13：Party & Narrative Decision

registerSocketHandlers(io);

// 阶段9：NPC Listener（Game Event Bus → NPC 反应，服务器规则决定）
require('./services/npcs/npcListener').registerNpcListener();
// 阶段11：表现追踪监听器（死亡/战斗/探索/任务 → 完成度评分）
require('./services/legends/performanceListener').registerPerformanceListener();
// 阶段13：玩家关系监听器（类型化事件 → 固定增量；AI 无直接修改途径）
require('./services/party/playerRelations').registerPlayerRelationsListener();

// 作为入口运行时才监听端口（测试可直接 require 后自管端口）
if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] roblox-trpg 服务器已启动（阶段13）: http://localhost:${PORT}`);
    // 阶段12：World Tick 调度器（周期驱动世界演化；可经 /api/world/pause 暂停）
    if (process.env.WORLD_TICK_ENABLED !== 'off') {
      const worldSim = require('./services/world/worldSim');
      const { WORLD_TICK_INTERVAL_MS } = require('./config');
      const info = worldSim.startScheduler(io, WORLD_TICK_INTERVAL_MS);
      console.log(`[server] World Tick 调度器已启动（每 ${info.intervalMs}ms${info.paused ? '，当前处于暂停状态' : ''}）`);
    }
  });
}

module.exports = { app, server, io };
