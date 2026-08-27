/**
 * 预设体验路由（阶段16）：列表（Experience Select Panel 数据）+ 手动导入。
 * 图标经既有 Roblox Thumbnails Service 服务端代理获取（离线时降级为 null）。
 */
const express = require('express');
const { resolveSession } = require('../sessions/sessionManager');
const presetSeeder = require('../services/presets/presetSeeder');

const router = express.Router();

function authPlayer(req, res) {
  let token = (req.body && req.body.sessionToken) || (req.query && req.query.sessionToken);
  if (!token && req.headers.cookie) {
    const m = req.headers.cookie.match(/(?:^|;\s*)rtp_session=([^;]+)/);
    token = m && m[1];
  }
  const sess = token ? resolveSession(token) : null;
  if (!sess) {
    res.status(401).json({ error: '无效会话', code: 'UNAUTHORIZED' });
    return null;
  }
  return sess;
}

/** GET /api/preset-experiences —— 预设体验列表（图标/名称/类型/难度/可玩版本）。 */
router.get('/api/preset-experiences', async (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  try {
    const presets = await presetSeeder.presetView();
    res.json({ presets });
  } catch (err) {
    res.status(500).json({ error: err.message, code: err.code || 'PRESET_ERROR' });
  }
});

/** POST /api/presets/import —— 运行预设导入器（幂等；服务启动时也会自动执行一次）。 */
router.post('/api/presets/import', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  try {
    const { io } = require('../index.js');
    const results = presetSeeder.runPresetSeeder(io);
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message, code: err.code || 'PRESET_IMPORT_FAILED' });
  }
});

module.exports = router;
