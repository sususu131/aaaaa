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
const adminAiTestRoutes = require('./routes/adminAiTestRoutes');
const dungeonRoutes = require('./routes/dungeonRoutes');
const runtimeRoutes = require('./routes/runtimeRoutes');
const characterRoutes = require('./routes/characterRoutes');
const questRoutes = require('./routes/questRoutes');
const npcRoutes = require('./routes/npcRoutes');
const worldRoutes = require('./routes/worldRoutes');
const partyDecisionRoutes = require('./routes/partyDecisionRoutes');
const inventoryRoutes = require('./routes/inventoryRoutes');
const presetRoutes = require('./routes/presetRoutes');

initDb();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

// Vision 测试页面会把本地图片转换成 Base64 data URL，再放进 JSON。
// 8MB 对稍大的 PNG/JPEG 很容易不够（Base64 还会膨胀约 33%），导致
// express.json() 直接返回默认 HTML 413 页面，前端随后报 Unexpected token '<'。
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '25mb' }));
app.get('/health', (_req, res) => res.json({ ok: true, name: 'roblox-trpg-server', stage: 16 }));
app.use('/api', apiRoutes);
app.use(require('./routes/adminRoutes'));
app.use(adminAiTestRoutes);
app.use(visionRoutes);
app.use(dungeonRoutes);
app.use(runtimeRoutes);
app.use(characterRoutes);
app.use(questRoutes);
app.use(npcRoutes);
app.use(worldRoutes);
app.use(partyDecisionRoutes);
app.use(inventoryRoutes);
app.use(presetRoutes);

// 不让 Express 在 JSON 解析失败（例如请求体过大/JSON 损坏）时返回 HTML。
// Admin Test 页面可以据此显示真正的错误，而不是 SyntaxError: Unexpected token '<'。
app.use((err, _req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err instanceof SyntaxError || err.type === 'entity.parse.failed')) {
    const status = err.status || (err.type === 'entity.too.large' ? 413 : 400);
    return res.status(status).json({
      ok: false,
      error: status === 413 ? '请求图片过大，请压缩图片后重试' : '请求 JSON 无效',
      code: status === 413 ? 'REQUEST_ENTITY_TOO_LARGE' : 'INVALID_JSON',
    });
  }
  return next(err);
});

registerSocketHandlers(io);
require('./services/npcs/npcListener').registerNpcListener();
require('./services/legends/performanceListener').registerPerformanceListener();
require('./services/party/playerRelations').registerPlayerRelationsListener();

if (require.main === module) {
  try {
    const results = require('./services/presets/presetSeeder').runPresetSeeder();
    console.log(`[server] 预设副本导入完成：${results.map((r) => r.key || `${r.error}`).join(', ')}`);
  } catch (err) {
    console.error('[server] 预设副本导入失败:', err.message);
  }
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] roblox-trpg 服务器已启动（阶段16：预设副本库）: http://localhost:${PORT}`);
    if (process.env.WORLD_TICK_ENABLED !== 'off') {
      const worldSim = require('./services/world/worldSim');
      const { WORLD_TICK_INTERVAL_MS } = require('./config');
      const info = worldSim.startScheduler(io, WORLD_TICK_INTERVAL_MS);
      console.log(`[server] World Tick 调度器已启动（每 ${info.intervalMs}ms${info.paused ? '，当前处于暂停状态' : ''}）`);
    }
  });
}

module.exports = { app, server, io };
