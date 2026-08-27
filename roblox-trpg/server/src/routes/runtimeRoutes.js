/**
 * Dungeon Runtime REST（阶段5 第四十五节）。
 * 客户端只能提交 Action；所有状态由服务器裁定。
 */
const express = require('express');
const { getDb } = require('@roblox-trpg/database');
const { resolveSession } = require('../sessions/sessionManager');
const roomManager = require('../rooms/roomManager');
const im = require('../services/runtime/instanceManager');
const runtimeEngine = require('../services/runtime/runtimeEngine');
const worldState = require('../services/world/worldState');
const playerStates = require('../services/world/playerStates');
const combatEngine = require('../services/runtime/combatEngine');

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
  if (code === 'INTERNAL_ERROR') console.error('[runtime] 未处理异常:', err);
  res.status(status).json({ error: err.message, code });
}

/** GET /api/dungeons —— 副本列表（含已发布版本 + 官方可玩内容，供前端选择）。 */
router.get('/api/dungeons', (_req, res) => {
  const db = getDb();
  const dungeons = db.prepare('SELECT id, uid, dungeon_name, roblox_experience_name, difficulty FROM dungeons ORDER BY id').all();
  for (const d of dungeons) {
    d.publishedVersions = db
      .prepare("SELECT id, version FROM dungeon_versions WHERE dungeon_id = ? AND status = 'PUBLISHED' ORDER BY version")
      .all(d.id);
  }
  const officialContent = require('../services/runtime/officialContent');
  const official = officialContent.listOfficial().map((o) => ({
    ref: `official:${o.dungeon_name}`,
    dungeonName: o.dungeon_name,
    description: o.description,
  }));
  res.json({ dungeons, official });
});

/** POST /api/dungeon-instances —— 在玩家当前房间创建实例。 */
router.post('/api/dungeon-instances', (req, res) => {
  try {
    const sess = authPlayer(req, res);
    if (!sess) return;
    const player = getDb().prepare('SELECT * FROM players WHERE id = ?').get(sess.playerRowId);
    if (!player || !player.room_id) return res.status(400).json({ error: '你必须先在一个房间里', code: 'NO_ROOM' });
    let { dungeonVersionId } = req.body || {};
    // 阶段15：官方内容引用（"official:Doors"）→ 按需物化为已发布版本
    if (typeof dungeonVersionId === 'string' && dungeonVersionId.startsWith('official:')) {
      const officialContent = require('../services/runtime/officialContent');
      dungeonVersionId = officialContent.materializeOfficial(dungeonVersionId.slice('official:'.length)).id;
    }
    const instance = im.createInstance({ roomId: player.room_id, dungeonVersionId });
    im.joinInstance(im.getInstance(instance.id), sess.playerRowId); // 创建者自动加入
    res.json({ instance: im.getInstance(instance.id) });
  } catch (err) {
    fail(res, err);
  }
});

/** POST /api/dungeon-instances/:id/join */
router.post('/api/dungeon-instances/:id/join', (req, res) => {
  try {
    const sess = authPlayer(req, res);
    if (!sess) return;
    const instance = im.getInstance(req.params.id);
    const updated = im.joinInstance(instance, sess.playerRowId);
    res.json({ instance: updated });
  } catch (err) {
    fail(res, err);
  }
});

/** POST /api/dungeon-instances/:id/start */
router.post('/api/dungeon-instances/:id/start', (req, res) => {
  try {
    const sess = authPlayer(req, res);
    if (!sess) return;
    const instance = im.getInstance(req.params.id);
    const { io } = require('../index.js');
    const started = im.startInstance(io, instance);
    res.json({ instance: started });
  } catch (err) {
    fail(res, err);
  }
});

/** POST /api/dungeon-instances/:id/actions —— 提交 Action（服务器排队处理）。 */
router.post('/api/dungeon-instances/:id/actions', async (req, res) => {
  try {
    const sess = authPlayer(req, res);
    if (!sess) return;
    const instance = im.getInstance(req.params.id);
    const player = getDb().prepare('SELECT * FROM players WHERE id = ?').get(sess.playerRowId);
    if (!player || !im.partyOf(instance).includes(player.id)) {
      return res.status(403).json({ error: '你不是该实例的队伍成员', code: 'NOT_IN_PARTY' });
    }
    const text = String((req.body && req.body.action) || '').trim();
    if (!text) return res.status(400).json({ error: 'Action 不能为空', code: 'EMPTY_ACTION' });
    if (text.length > 2000) return res.status(400).json({ error: 'Action 过长（2000字符）', code: 'ACTION_TOO_LONG' });

    const room = roomManager.getRoom(instance.room_id) || { id: instance.room_id, players: [] };
    const { io } = require('../index.js');

    if (req.body && req.body.await === true) {
      const result = await runtimeEngine.submitAction(io, room, instance, player, text, req.body.clientActionId || null);
      return res.json(result);
    }
    // 默认：入队后立即返回（结果经 Socket 广播）
    const pending = runtimeEngine.submitAction(io, room, instance, player, text, req.body.clientActionId || null);
    pending.catch(() => {});
    res.json({ queued: true, instanceUid: instance.uid });
  } catch (err) {
    fail(res, err);
  }
});

/** GET /api/dungeon-instances/:id —— 完整快照（断线恢复用）。 */
router.get('/api/dungeon-instances/:id', (req, res) => {
  try {
    const instance = im.getInstance(req.params.id);
    const { definition, version } = im.getDefinition(instance);
    const db = getDb();
    const party = im.partyOf(instance).map((pid) => {
      const p = db.prepare('SELECT * FROM players WHERE id = ?').get(pid);
      if (!p) return null;
      const st = playerStates.getPlayerState(pid);
      return { name: p.name, uid: p.uid, hp: st.hp, maxHp: st.maxHp, attributes: st.attributes, skills: st.skills.map((s) => s.name), statusEffects: st.statusEffects };
    }).filter(Boolean);
    const scene = (definition.scenes || []).find((s) => s.id === instance.current_scene_id) || null;
    const combat = combatEngine.activeCombat(instance.id);
    res.json({
      instance: {
        uid: instance.uid,
        status: instance.status,
        currentSceneId: instance.current_scene_id,
        startedAt: instance.started_at,
        endedAt: instance.ended_at,
      },
      dungeon: { name: definition.dungeon?.display_name || definition.dungeon?.name, version: version.version, canonicalFacts: definition.canonical_facts },
      scene: scene ? { id: scene.id, name: scene.name, description: scene.description, exits: scene.exits, encounters: scene.encounters } : null,
      party,
      worldState: worldState.getWorld(instance.room_id),
      combat: combat ? combatEngine.serialize(combat) : null,
    });
  } catch (err) {
    fail(res, err);
  }
});

/** POST /api/dungeon-instances/:id/timed-choice —— 限时抉择（QTE）：倒计时内选择，幂等。 */
router.post('/api/dungeon-instances/:id/timed-choice', (req, res) => {
  try {
    const sess = authPlayer(req, res);
    if (!sess) return;
    const instance = im.getInstance(req.params.id);
    const player = getDb().prepare('SELECT * FROM players WHERE id = ?').get(sess.playerRowId);
    if (!player || !im.partyOf(instance).includes(player.id)) {
      return res.status(403).json({ error: '你不是该实例的队伍成员', code: 'NOT_IN_PARTY' });
    }
    if (instance.status !== 'RUNNING') {
      return res.status(409).json({ error: `实例状态 ${instance.status}，不能行动`, code: 'NOT_RUNNING' });
    }
    const { io } = require('../index.js');
    const result = runtimeEngine.resolveTimedChoice(io, instance, player, (req.body || {}).choiceIndex);
    if (!result.ok) return res.status(409).json({ error: `选择被拒：${result.reason}`, code: result.reason });
    res.json(result);
  } catch (err) {
    fail(res, err);
  }
});

/** GET /api/agent-runs?roomId= —— Agent Trace（开发/调试）。 */
router.get('/api/agent-runs', (req, res) => {
  try {
    const db = getDb();
    const runs = req.query.roomId
      ? db.prepare('SELECT * FROM agent_runs WHERE room_id = ? ORDER BY id DESC LIMIT 50').all(String(req.query.roomId))
      : db.prepare('SELECT * FROM agent_runs ORDER BY id DESC LIMIT 50').all();
    res.json({ runs });
  } catch (err) {
    fail(res, err);
  }
});

/** GET /api/agent-runs/:id —— 单次 Agent Run 的逐轮工具轨迹（Replay 视角）。 */
router.get('/api/agent-runs/:id', (req, res) => {
  try {
    const db = getDb();
    const run = db.prepare('SELECT * FROM agent_runs WHERE id = ? OR uid = ?').get(Number(req.params.id) || -1, String(req.params.id));
    if (!run) return res.status(404).json({ error: 'Agent Run 不存在', code: 'RUN_NOT_FOUND' });
    const calls = db.prepare('SELECT * FROM agent_tool_calls WHERE agent_run_id = ? ORDER BY round, id').all(run.id);
    const rounds = {};
    for (const c of calls) {
      (rounds[c.round] = rounds[c.round] || []).push(c);
    }
    res.json({ run, rounds });
  } catch (err) {
    fail(res, err);
  }
});

/** GET /api/dungeon-instances/:id/events —— 事件日志（Replay 数据）。 */
router.get('/api/dungeon-instances/:id/events', (req, res) => {
  try {
    const instance = im.getInstance(req.params.id);
    res.json({ events: im.events(instance, Number(req.query.limit) || 200) });
  } catch (err) {
    fail(res, err);
  }
});

/** POST /api/dungeon-instances/:id/leave */
router.post('/api/dungeon-instances/:id/leave', (req, res) => {
  try {
    const sess = authPlayer(req, res);
    if (!sess) return;
    const instance = im.getInstance(req.params.id);
    res.json({ instance: im.leaveInstance(instance, sess.playerRowId) });
  } catch (err) {
    fail(res, err);
  }
});

// ══ 阶段15：回合制战斗端点（全部服务器结算；客户端只提交行动意图）══

/** 战斗端点通用校验：会话 + 队伍成员 + 实例运行中。 */
function combatGuard(req, res) {
  const sess = authPlayer(req, res);
  if (!sess) return null;
  const instance = im.getInstance(req.params.id);
  const player = getDb().prepare('SELECT * FROM players WHERE id = ?').get(sess.playerRowId);
  if (!player || !im.partyOf(instance).includes(player.id)) {
    res.status(403).json({ error: '你不是该实例的队伍成员', code: 'NOT_IN_PARTY' });
    return null;
  }
  return { sess, instance, player };
}

/** GET /api/dungeon-instances/:id/combat —— 战斗视图（HP/阶段/技能冷却/可用行动）。 */
router.get('/api/dungeon-instances/:id/combat', (req, res) => {
  try {
    const g = combatGuard(req, res);
    if (!g) return;
    const battleSystem = require('../services/runtime/battleSystem');
    res.json({ combat: battleSystem.combatView(g.instance) });
  } catch (err) {
    fail(res, err);
  }
});

/** POST /api/dungeon-instances/:id/combat/start { encounterId } —— 开始遭遇（服务器验证遭遇属于当前场景）。 */
router.post('/api/dungeon-instances/:id/combat/start', (req, res) => {
  try {
    const g = combatGuard(req, res);
    if (!g) return;
    if (g.instance.status !== 'RUNNING') return res.status(409).json({ error: `实例状态 ${g.instance.status}`, code: 'NOT_RUNNING' });
    const battleSystem = require('../services/runtime/battleSystem');
    const { definition } = im.getDefinition(g.instance);
    const { io } = require('../index.js');
    const combat = battleSystem.startEncounter(io, g.instance, definition, String((req.body || {}).encounterId || ''));
    res.json({ ok: true, combat: battleSystem.combatView(g.instance, combat) });
  } catch (err) {
    fail(res, err);
  }
});

/** POST /api/dungeon-instances/:id/combat/action { action, targetId, skillName, itemKey } —— 玩家行动（服务器结算）。 */
router.post('/api/dungeon-instances/:id/combat/action', (req, res) => {
  try {
    const g = combatGuard(req, res);
    if (!g) return;
    if (g.instance.status !== 'RUNNING') return res.status(409).json({ error: `实例状态 ${g.instance.status}`, code: 'NOT_RUNNING' });
    const battleSystem = require('../services/runtime/battleSystem');
    const combat = battleSystem.getCombat(g.instance.id);
    if (!combat) return res.status(409).json({ error: '没有进行中的战斗', code: 'NO_COMBAT' });
    const { definition } = im.getDefinition(g.instance);
    const { io } = require('../index.js');
    const body = req.body || {};
    const result = battleSystem.performPlayerAction(io, g.instance, definition, combat, g.player.id, {
      action: String(body.action || ''),
      targetId: body.targetId != null ? body.targetId : null,
      skillName: body.skillName || null,
      itemKey: body.itemKey || null,
    });
    res.json({ ok: true, ...result, combat: battleSystem.combatView(im.getInstance(g.instance.id)) });
  } catch (err) {
    fail(res, err);
  }
});

/** POST /api/dungeon-instances/:id/move { sceneId } —— 场景移动（服务器验证出口）。 */
router.post('/api/dungeon-instances/:id/move', (req, res) => {
  try {
    const g = combatGuard(req, res);
    if (!g) return;
    if (g.instance.status !== 'RUNNING') return res.status(409).json({ error: `实例状态 ${g.instance.status}`, code: 'NOT_RUNNING' });
    const battleSystem = require('../services/runtime/battleSystem');
    if (battleSystem.getCombat(g.instance.id)) return res.status(409).json({ error: '战斗中不能移动', code: 'IN_COMBAT' });
    const { definition } = im.getDefinition(g.instance);
    const target = String((req.body || {}).sceneId || '');
    const scene = (definition.scenes || []).find((s) => s.id === g.instance.current_scene_id);
    const dest = (definition.scenes || []).find((s) => s.id === target);
    if (!scene || !dest) return res.status(404).json({ error: '场景不存在', code: 'SCENE_NOT_FOUND' });
    if (!(scene.exits || []).includes(target)) return res.status(409).json({ error: '当前场景没有通往那里的出口', code: 'NO_EXIT' });
    const db = getDb();
    db.prepare("UPDATE dungeon_instances SET current_scene_id = ?, updated_at = datetime('now') WHERE id = ?").run(target, g.instance.id);
    im.logEvent(g.instance, 'SCENE_TRANSITION', `player#${g.player.id}`, { from: scene.id, to: target });
    const gameEvents = require('../services/quests/gameEvents');
    const { io } = require('../index.js');
    gameEvents.emit(io, g.instance.room_id, { type: 'PLAYER_ENTERED_SCENE', actor: g.player.name, actorPlayerId: g.player.id, data: { scene: target, sceneName: dest.name }, instanceId: g.instance.id });
    io.to(g.instance.room_id).emit('instance:scene', { instanceUid: g.instance.uid, sceneId: target, sceneName: dest.name, at: new Date().toISOString() });
    res.json({ ok: true, sceneId: target, sceneName: dest.name, encounters: dest.encounters || [] });
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;
