/**
 * NPC REST（阶段9）：只读公开视图。
 * 安全：不返回隐藏记忆（BETRAYAL / importance≥60）；不返回内部 state_json。
 * 所有变更仅通过 AI Tool（服务器验证）——无写入端点。
 */
const express = require('express');
const { resolveSession } = require('../sessions/sessionManager');
const npcEngine = require('../services/npcs/npcEngine');
const legendEngine = require('../services/legends/legendEngine');
const { getDb } = require('@roblox-trpg/database');

const router = express.Router();

function authPlayer(req, res) {
  let token = (req.query && req.query.sessionToken) || (req.query && req.query.token) || '';
  if (!token && req.headers && req.headers['x-session-token']) token = req.headers['x-session-token'];
  if (!token && req.body && req.body.sessionToken) token = req.body.sessionToken;
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

/** GET /api/npcs —— 当前房间的 NPC 公开视图（断线恢复安全：数据全来自服务器）。 */
router.get('/api/npcs', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  const p = getDb().prepare('SELECT room_id FROM players WHERE id = ?').get(sess.playerRowId);
  if (!p || !p.room_id) return res.json({ npcs: [] });
  const insts = npcEngine.npcInstancesInRoom(p.room_id);
  res.json({ npcs: insts.map((ni) => npcEngine.publicNpcView(ni, { playerId: sess.playerRowId })) });
});

/** GET /api/npcs/:npcInstanceId —— 单个 NPC 公开视图（跨房间拒绝）。 */
router.get('/api/npcs/:npcInstanceId', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  const p = getDb().prepare('SELECT room_id FROM players WHERE id = ?').get(sess.playerRowId);
  const inst = npcEngine.getNpcInstance(req.params.npcInstanceId);
  if (!inst) return res.status(404).json({ error: 'NPC 不存在', code: 'NPC_NOT_FOUND' });
  if (!p || inst.room_id !== p.room_id) return res.status(403).json({ error: '不能访问其他房间的 NPC', code: 'FORBIDDEN_ROOM' });
  res.json(npcEngine.publicNpcView(inst, { playerId: sess.playerRowId }));
});

/** GET /api/legend-shop/:legendId —— 传奇商店（服务器计算可购买状态）。 */
router.get('/api/legend-shop/:legendId', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  try {
    const legend = legendEngine.getLegendById(Number(req.params.legendId));
    if (!legend) return res.status(404).json({ error: '传奇人物不存在', code: 'LEGEND_NOT_FOUND' });
    const p = getDb().prepare('SELECT room_id FROM players WHERE id = ?').get(sess.playerRowId);
    const inst = npcEngine.findNpcInstanceInRoom(p ? p.room_id : '__none__', legend.npc_uid);
    if (!inst) return res.status(403).json({ error: '该传奇人物不在当前房间', code: 'LEGEND_NOT_PRESENT' });
    res.json({ shop: legendEngine.getShop(legend.id, sess.playerRowId) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, code: err.code || 'ERROR' });
  }
});

/** POST /api/legend-shop/buy —— 购买（服务器验证：关系/声望/任务/金币）。 */
router.post('/api/legend-shop/buy', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  try {
    const { legendId, itemName } = req.body || {};
    const legend = legendEngine.getLegendById(Number(legendId));
    if (!legend) return res.status(404).json({ error: '传奇人物不存在', code: 'LEGEND_NOT_FOUND' });
    const p = getDb().prepare('SELECT room_id FROM players WHERE id = ?').get(sess.playerRowId);
    const inst = npcEngine.findNpcInstanceInRoom(p ? p.room_id : '__none__', legend.npc_uid);
    if (!inst) return res.status(403).json({ error: '该传奇人物不在当前房间', code: 'LEGEND_NOT_PRESENT' });
    const item = getDb().prepare("SELECT * FROM items WHERE name = ? AND status = 'approved'").get(String(itemName || ''));
    if (!item) return res.status(409).json({ error: '物品不存在或未审核', code: 'ITEM_NOT_APPROVED' });
    const result = legendEngine.purchaseShopItem(require('../index.js').io, legend.id, sess.playerRowId, item.id, p.room_id);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, code: err.code || 'ERROR' });
  }
});

/** GET /api/factions —— 阵营与玩家声望。 */
router.get('/api/factions', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  const factions = getDb().prepare('SELECT * FROM factions').all();
  res.json({
    factions: factions.map((f) => ({ ...f, reputation: npcEngine.getFactionReputation(sess.playerRowId, f.id) })),
  });
});

module.exports = router;
