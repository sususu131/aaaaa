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

// ── 阶段17：Die of Death Civilian System（模板制身份；服务器抽取 Deck）──

/** GET /api/dod/civilian/offer —— 抽取 Ability Deck（3 个 Deck × 2 Ability；服务器随机）。 */
router.get('/api/dod/civilian/offer', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  try {
    const dodCivilian = require('../services/presets/dodCivilian');
    const decks = dodCivilian.offerDecks(sess.playerRowId);
    res.json({ ok: true, decks, backgrounds: dodCivilian.BACKGROUNDS });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, code: err.code || 'DOD_ERROR' });
  }
});

/** POST /api/dod/civilian/select { deckIndex } —— 生成 Civilian 身份并获得该 Deck 的 Ability。 */
router.post('/api/dod/civilian/select', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  try {
    const { io } = require('../index.js');
    const dodCivilian = require('../services/presets/dodCivilian');
    const result = dodCivilian.createCivilianIdentity(io, sess.playerRowId, { deckIndex: (req.body || {}).deckIndex });
    res.json({ ok: true, ...result, view: dodCivilian.civilianView(sess.playerRowId) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, code: err.code || 'DOD_ERROR' });
  }
});

/** GET /api/dod/civilian —— 我的 Civilian 身份（可带 experience 查询跨副本倍率）。 */
router.get('/api/dod/civilian', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  try {
    const dodCivilian = require('../services/presets/dodCivilian');
    res.json({ civilian: dodCivilian.civilianView(sess.playerRowId, req.query.experience || null) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, code: err.code || 'DOD_ERROR' });
  }
});

module.exports = router;
