/**
 * 服务器入口：Express + HTTP + Socket.io + REST API。
 * 端口 3000；开发环境由 Vite 代理 /socket.io 与 /api。
 */
const express = require('express');
const path = require('path');
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
const inventoryRoutes = require('./routes/inventoryRoutes');
const presetRoutes = require('./routes/presetRoutes');

// 启动即建表（幂等）
initDb();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

// Vision 测试页把本地图片转 Base64 data URL 放进 JSON（膨胀约33%）——8MB 不够会返回
// HTML 413 页，前端随后报 Unexpected token '<'。默认放宽到 25MB（可用 JSON_BODY_LIMIT 覆盖）。
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '25mb' }));
app.get('/health', (_req, res) => res.json({ ok: true, name: 'roblox-trpg-server', stage: 16 }));
app.use('/api', apiRoutes);
app.use(require('./routes/adminRoutes')); // 阶段25：/admin 管理页 + /api/admin/*
app.use(require('./routes/adminAiTestRoutes')); // 阶段29（用户）：/admin/ai-test 实测页 + 三端点
// 阶段29：用户的 AI/Vision 实测页（发 base64 图片走真实链路）
app.get('/admin/ai-test.html', (_req, res) => res.sendFile(path.join(__dirname, 'admin/ai-test.html')));
app.use(visionRoutes); // /api/vision/avatar/analyze、/vision-test 等
app.use(dungeonRoutes); // 阶段4：Dungeon Design Pipeline
app.use(runtimeRoutes); // 阶段5：Dungeon Runtime
app.use(characterRoutes); // 阶段6：Persistent Character
app.use(questRoutes); // 阶段8：Quest System
app.use(npcRoutes); // 阶段9：NPC & Living World
app.use(worldRoutes); // 阶段12：World Simulation & Dynamic Events
app.use(partyDecisionRoutes); // 阶段13：Party & Narrative Decision
app.use(inventoryRoutes); // 阶段14：Persistent Inventory
app.use(presetRoutes); // 阶段16：Preset Experience Dungeon Library

// 未匹配的路由返回 JSON 404（默认 HTML "Cannot POST /xxx" 会让前端报 Unexpected token '<'）。
app.use((req, res) => {
  res.status(404).json({ ok: false, error: `路径不存在：${req.method} ${req.path}（后端可能未重启到最新版本）`, code: 'NOT_FOUND' });
});

// 不让 Express 在 JSON 解析失败（请求体过大/JSON 损坏）时返回 HTML——统一 JSON 错误。
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

// 阶段9：NPC Listener（Game Event Bus → NPC 反应，服务器规则决定）
require('./services/npcs/npcListener').registerNpcListener();
// 阶段11：表现追踪监听器（死亡/战斗/探索/任务 → 完成度评分）
require('./services/legends/performanceListener').registerPerformanceListener();
// 阶段13：玩家关系监听器（类型化事件 → 固定增量；AI 无直接修改途径）
require('./services/party/playerRelations').registerPlayerRelationsListener();

// 作为入口运行时才监听端口（测试可直接 require 后自管端口）
if (require.main === module) {
  // 阶段16：官方体验预设导入（幂等；测试环境不自动执行）
  try {
    const results = require('./services/presets/presetSeeder').runPresetSeeder();
    console.log(`[server] 预设副本导入完成：${results.map((r) => r.key || `${r.error}`).join(', ')}`);
  } catch (err) {
    console.error('[server] 预设副本导入失败:', err.message);
  }
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] roblox-trpg 服务器已启动（阶段16：预设副本库）: http://localhost:${PORT}`);
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
