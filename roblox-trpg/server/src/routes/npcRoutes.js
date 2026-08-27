/**
 * NPC REST（阶段9）：只读公开视图。
 * 安全：不返回隐藏记忆（BETRAYAL / importance≥60）；不返回内部 state_json。
 * 所有变更仅通过 AI Tool（服务器验证）——无写入端点。
 */
const express = require('express');
const { resolveSession } = require('../sessions/sessionManager');
const npcEngine = require('../services/npcs/npcEngine');
const { getDb } = require('@roblox-trpg/database');

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
