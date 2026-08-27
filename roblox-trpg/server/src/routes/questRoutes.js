/**
 * Quest REST（阶段8）：查询/设计/发布/选择。
 * 权限：只能访问自己房间的任务（第三十九节）；隐藏任务未触发前不可见。
 */
const express = require('express');
const { getDb } = require('@roblox-trpg/database');
const { resolveSession } = require('../sessions/sessionManager');
const questEngine = require('../services/quests/questEngine');

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

function fail(res, err) {
  const code = err.code || 'INTERNAL_ERROR';
  const status = err.status || (code === 'INTERNAL_ERROR' ? 500 : 400);
  if (code === 'INTERNAL_ERROR') console.error('[quest] 未处理异常:', err);
  res.status(status).json({ error: err.message, code });
}

function playerRoom(sess) {
  const p = getDb().prepare('SELECT room_id FROM players WHERE id = ?').get(sess.playerRowId);
  return p && p.room_id;
}

/** GET /api/quests —— 当前房间任务列表（隐藏任务未触发不可见）。 */
router.get('/api/quests', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  const roomId = playerRoom(sess);
  if (!roomId) return res.json({ quests: [] });
  try {
    const rows = questEngine.listForRoom(roomId);
    res.json({
      quests: rows.map((r) => ({
        questInstanceId: r.id,
        uid: r.uid,
        name: r.name,
        description: r.description,
        questType: r.quest_type,
        status: r.status,
        scope: r.progress_scope,
        version: r.version,
        deadlineAt: r.deadline_at,
      })),
    });
  } catch (err) {
    fail(res, err);
  }
});

/** GET /api/quest-instances/:id —— 任务详情（含目标进度/选择；跨房间拒绝）。 */
router.get('/api/quest-instances/:id', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  const roomId = playerRoom(sess);
  try {
    const db = getDb();
    const qi = db.prepare('SELECT * FROM quest_instances WHERE id = ? OR uid = ?').get(Number(req.params.id) || -1, String(req.params.id));
    if (!qi) return res.status(404).json({ error: '任务实例不存在', code: 'INSTANCE_NOT_FOUND' });
    if (qi.room_id !== roomId) return res.status(403).json({ error: '不能访问其他房间的任务', code: 'FORBIDDEN_ROOM' });
    const full = questEngine.getInstanceFull(qi.id);
    res.json({
      instance: {
        id: qi.id,
        uid: qi.uid,
        name: full.quest.name,
        description: full.quest.description,
        questType: full.quest.type,
        status: qi.status,
        scope: qi.progress_scope,
        deadlineAt: qi.deadline_at,
        serverNow: new Date().toISOString(),
      },
      objectives: full.objectives.map((o) => ({
        key: o.objective_key,
        name: o.name,
        description: o.description,
        type: o.type,
        status: o.status,
        count: o.current_count,
        required: o.required_count,
        optional: Boolean(o.is_optional),
        order: o.order_index,
      })),
      participants: full.participants.map((p) => ({ playerId: p.player_id, status: p.status })),
      choices: full.choices.map((c) => ({ key: c.choice_key, status: c.status, options: JSON.parse(c.options_json) })),
    });
  } catch (err) {
    fail(res, err);
  }
});

/** POST /api/quest-instances/:id/choice —— 玩家分支选择（服务器重新验证）。 */
router.post('/api/quest-instances/:id/choice', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  try {
    const db = getDb();
    const qi = db.prepare('SELECT * FROM quest_instances WHERE id = ? OR uid = ?').get(Number(req.params.id) || -1, String(req.params.id));
    if (!qi) return res.status(404).json({ error: '任务实例不存在', code: 'INSTANCE_NOT_FOUND' });
    const roomId = playerRoom(sess);
    if (qi.room_id !== roomId) return res.status(403).json({ error: '不能访问其他房间的任务', code: 'FORBIDDEN_ROOM' });
    const { io } = require('../index.js');
    const result = questEngine.submitChoice(io, qi.id, sess.playerRowId, (req.body || {}).choiceKey, (req.body || {}).optionId);
    res.json(result);
  } catch (err) {
    fail(res, err);
  }
});

/** POST /api/quests/design —— 任务草案（AI/设计器；只能 DRAFT）。 */
router.post('/api/quests/design', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  try {
    const { name, description, type, dungeonId, definition, sourceType, sourceId } = req.body || {};
    const result = questEngine.createQuestDraft({ name, description, type, dungeonId, sourceType: sourceType || 'DESIGNER', sourceId, definition });
    res.json(result);
  } catch (err) {
    fail(res, err);
  }
});

/** POST /api/quest-versions/:id/publish —— 发布（验证后；发布即不可变）。 */
router.post('/api/quest-versions/:id/publish', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  try {
    res.json(questEngine.publishQuestVersion(Number(req.params.id)));
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;
