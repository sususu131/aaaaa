/**
 * Character API（阶段6 第三十四节）：只读查询 + 服务器验证的操作。
 * 客户端不能修改 XP/等级/属性/HP/技能/物品/货币 —— 这里没有任何此类写入端点。
 */
const express = require('express');
const { resolveSession } = require('../sessions/sessionManager');
const cs = require('../services/character/characterService');

const router = express.Router();

function authPlayer(req, res) {
  let token = req.body && req.body.sessionToken;
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

function fail(res, err) {
  const code = err.code || 'INTERNAL_ERROR';
  const status = err.status || (code === 'INTERNAL_ERROR' ? 500 : 400);
  if (code === 'INTERNAL_ERROR') console.error('[character] 未处理异常:', err);
  res.status(status).json({ error: err.message, code });
}

/** GET /api/character —— 完整角色（持久数据，服务端权威）。 */
router.get('/api/character', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  try {
    res.json({ character: cs.ensureCharacter(sess.playerRowId) });
  } catch (err) {
    fail(res, err);
  }
});

/** GET /api/character/stats —— 属性（base/total 分离）。 */
router.get('/api/character/stats', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  try {
    const { base, totals } = cs.effectiveStats(sess.playerRowId);
    res.json({ base, totals });
  } catch (err) {
    fail(res, err);
  }
});

/** GET /api/character/skills */
router.get('/api/character/skills', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  try {
    res.json({ skills: cs.getCharacter(sess.playerRowId).skills });
  } catch (err) {
    fail(res, err);
  }
});

/** GET /api/character/inventory */
router.get('/api/character/inventory', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  try {
    res.json({ inventory: cs.getCharacter(sess.playerRowId).inventory });
  } catch (err) {
    fail(res, err);
  }
});

/** GET /api/character/equipment */
router.get('/api/character/equipment', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  try {
    res.json({ equipment: cs.getCharacter(sess.playerRowId).equipment });
  } catch (err) {
    fail(res, err);
  }
});

/** POST /api/character/skills/:id/use —— 使用技能（服务器验证冷却/次数/状态）。 */
router.post('/api/character/skills/:id/use', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  try {
    const turn = Number((req.body && req.body.turn) || 0);
    const result = cs.useSkill(sess.playerRowId, req.params.id, { turn });
    if (!result.ok) return res.status(409).json({ error: `技能使用被拒：${result.reason}`, code: result.reason });
    res.json(result);
  } catch (err) {
    fail(res, err);
  }
});

/** POST /api/character/equipment/equip —— 装备（服务器验证所有权与槽位）。 */
router.post('/api/character/equipment/equip', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  try {
    const { itemId, slot } = req.body || {};
    res.json(cs.equip(sess.playerRowId, Number(itemId), slot || null));
  } catch (err) {
    fail(res, err);
  }
});

/** POST /api/character/equipment/unequip —— 卸下（物品保留在背包）。 */
router.post('/api/character/equipment/unequip', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  try {
    const { slot } = req.body || {};
    res.json(cs.unequip(sess.playerRowId, String(slot)));
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;
