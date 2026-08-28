/**
 * 世界模拟 REST（阶段12 第十节）：只读世界快照 + 调度器暂停/恢复。
 * 安全：会话鉴权；快照只含公开状态（无隐藏记忆/内部 behavior_data 细节）。
 * 所有世界变更仍只由服务器规则驱动 —— 本路由无"创建事件"端点。
 */
const express = require('express');
const { resolveSession } = require('../sessions/sessionManager');
const worldSim = require('../services/world/worldSim');
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

function roomOf(sess) {
  const p = getDb().prepare('SELECT room_id FROM players WHERE id = ?').get(sess.playerRowId);
  return p ? p.room_id : null;
}

/** GET /api/world —— 世界状态面板数据（当前事件/阵营关系/NPC活动/副本变体/调度器）。 */
router.get('/api/world', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  const roomId = roomOf(sess);
  if (!roomId) return res.json({ world: null, reason: 'NOT_IN_ROOM' });
  res.json({ roomId, world: worldSim.worldSnapshot(roomId) });
});

/** GET /api/world/events —— 当前生效世界事件列表。 */
router.get('/api/world/events', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  const roomId = roomOf(sess);
  const worldEvents = require('../services/world/worldEvents');
  res.json({ events: worldEvents.activeEvents(roomId) });
});

/** POST /api/world/pause —— 暂停世界模拟（可恢复；幂等）。 */
router.post('/api/world/pause', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  const state = worldSim.pause();
  getDb()
    .prepare('INSERT INTO world_events (room_id, actor, action, before_state, after_state, source) VALUES (?, ?, ?, ?, ?, ?)')
    .run(roomOf(sess), `player#${sess.playerRowId}`, 'WORLD_SIM_PAUSED', null, JSON.stringify(state), 'world_api');
  res.json({ ok: true, scheduler: state });
});

/** POST /api/world/resume —— 恢复世界模拟（幂等）。 */
router.post('/api/world/resume', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  const state = worldSim.resume();
  getDb()
    .prepare('INSERT INTO world_events (room_id, actor, action, before_state, after_state, source) VALUES (?, ?, ?, ?, ?, ?)')
    .run(roomOf(sess), `player#${sess.playerRowId}`, 'WORLD_SIM_RESUMED', null, JSON.stringify(state), 'world_api');
  res.json({ ok: true, scheduler: state });
});

module.exports = router;
