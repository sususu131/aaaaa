/**
 * 队伍与决策 REST（阶段13）：队伍操作由玩家发起；决策选择/投票由玩家点击。
 * AI 侧只有 Tool（创建请求/只读）—— 本路由无 AI 可用的强制结算端点。
 * 安全：会话鉴权 + 房间隔离；决策效果仍由服务器结算。
 */
const express = require('express');
const { resolveSession } = require('../sessions/sessionManager');
const partyService = require('../services/party/partyService');
const playerRelations = require('../services/party/playerRelations');
const decisionEngine = require('../services/party/decisionEngine');
const { getDb } = require('@roblox-trpg/database');
const aiAgent = require('../services/ai/aiAgent');
const roomManager = require('../rooms/roomManager');

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
  const player = getDb().prepare('SELECT * FROM players WHERE id = ?').get(sess.playerRowId);
  if (!player) {
    res.status(404).json({ error: '玩家不存在', code: 'PLAYER_NOT_FOUND' });
    return null;
  }
  return { sess, player };
}

function fail(res, err) {
  res.status(err.status || 400).json({ error: err.message, code: err.code || 'BAD_REQUEST' });
}

/** GET /api/party —— 房间主队伍视图（成员/定位/关系）。 */
router.get('/api/party', (req, res) => {
  const auth = authPlayer(req, res);
  if (!auth) return;
  if (!auth.player.room_id) return res.json({ party: null, reason: 'NOT_IN_ROOM' });
  const party = partyService.getActiveParty(auth.player.room_id);
  res.json({
    party: party ? partyService.partyView(party.id) : null,
    myPartyId: (() => {
      const mine = partyService.partyOfPlayer(auth.player.id);
      return mine ? mine.id : null;
    })(),
    relationships: playerRelations.relationshipsInRoom(auth.player.room_id),
    roles: partyService.PARTY_ROLES,
    roleLabels: partyService.ROLE_LABELS,
  });
});

/** POST /api/party/create —— 创建队伍（一房一队）。 */
router.post('/api/party/create', (req, res) => {
  const auth = authPlayer(req, res);
  if (!auth) return;
  try {
    const { io } = require('../index.js');
    const party = partyService.createParty(io, auth.player.room_id, auth.player.id);
    res.json({ ok: true, party: partyService.partyView(party.id) });
  } catch (err) {
    fail(res, err);
  }
});

/** POST /api/party/join —— 加入房间主队伍。 */
router.post('/api/party/join', (req, res) => {
  const auth = authPlayer(req, res);
  if (!auth) return;
  try {
    const party = partyService.getActiveParty(auth.player.room_id);
    if (!party) return res.status(404).json({ error: '当前房间没有队伍', code: 'NO_PARTY' });
    const { io } = require('../index.js');
    const r = partyService.joinParty(io, party.id, auth.player.id);
    res.json({ ok: true, joined: r.joined, reason: r.reason || null, party: partyService.partyView(party.id) });
  } catch (err) {
    fail(res, err);
  }
});

/** POST /api/party/leave —— 退出队伍（队长离开自动转移；清空解散）。 */
router.post('/api/party/leave', (req, res) => {
  const auth = authPlayer(req, res);
  if (!auth) return;
  try {
    const party = partyService.partyOfPlayer(auth.player.id);
    if (!party) return res.status(409).json({ error: '你不在任何队伍中', code: 'NOT_MEMBER' });
    const { io } = require('../index.js');
    const r = partyService.leaveParty(io, party.id, auth.player.id);
    res.json({ ok: true, ...r });
  } catch (err) {
    fail(res, err);
  }
});

/** POST /api/party/transfer { targetName } —— 队长转移（仅现任队长）。 */
router.post('/api/party/transfer', (req, res) => {
  const auth = authPlayer(req, res);
  if (!auth) return;
  try {
    const party = partyService.partyOfPlayer(auth.player.id);
    if (!party) return res.status(409).json({ error: '你不在任何队伍中', code: 'NOT_MEMBER' });
    if (party.leader_player_id !== auth.player.id) return res.status(403).json({ error: '只有队长可以转移队长', code: 'NOT_LEADER' });
    const targetName = String((req.body && req.body.targetName) || '');
    const target = getDb().prepare('SELECT * FROM players WHERE room_id = ? AND (name = ? OR uid = ?)').get(auth.player.room_id, targetName, targetName);
    if (!target) return res.status(404).json({ error: '目标玩家不在房间', code: 'TARGET_NOT_FOUND' });
    const { io } = require('../index.js');
    const r = partyService.transferLeadership(io, party.id, target.id, { reason: 'TRANSFER' });
    res.json({ ok: true, ...r, party: partyService.partyView(party.id) });
  } catch (err) {
    fail(res, err);
  }
});

/** POST /api/party/role { role } —— 设置自己的叙事定位（不改变属性）。 */
router.post('/api/party/role', (req, res) => {
  const auth = authPlayer(req, res);
  if (!auth) return;
  try {
    const party = partyService.partyOfPlayer(auth.player.id);
    if (!party) return res.status(409).json({ error: '你不在任何队伍中', code: 'NOT_MEMBER' });
    const { io } = require('../index.js');
    const r = partyService.setRole(io, party.id, auth.player.id, String((req.body && req.body.role) || 'CUSTOM'));
    res.json({ ok: true, ...r, party: partyService.partyView(party.id) });
  } catch (err) {
    fail(res, err);
  }
});

/** GET /api/decisions —— 当前房间待决选择（含剩余毫秒，客户端仅显示）。 */
router.get('/api/decisions', (req, res) => {
  const auth = authPlayer(req, res);
  if (!auth) return;
  const pending = decisionEngine.pendingDecisions(auth.player.room_id).map((d) => decisionEngine.decisionView(d.id));
  res.json({ decisions: pending });
});

/** POST /api/decisions/:uid/select { optionKey } —— 玩家选择 / 团队投票。 */
router.post('/api/decisions/:uid/select', (req, res) => {
  const auth = authPlayer(req, res);
  if (!auth) return;
  try {
    const { io } = require('../index.js');
    const optionKey = String((req.body && req.body.optionKey) || '');
    const r = decisionEngine.selectDecision(io, req.params.uid, auth.player.id, optionKey);
    // 阶段34：PARTY 决策投票达标/全员后结算 → 服务器侧直接触发 GM 推进剧情（避免每个玩家前端各自发 @AI 造成重复）
    if (r.settled) {
      const view = decisionEngine.decisionView(req.params.uid);
      const option = (view.options || []).find((o) => o.key === r.optionKey);
      const room = roomManager.getRoom(auth.player.room_id);
      if (room) {
        const text = `队伍投票已结算，全队选择了「${option ? option.text : r.optionKey}」。请根据这个决定继续推进剧情，不要重复要求投票，也不要再输出新的抉择选项。`;
        if (!room.gmBusy) {
          room.gmBusy = true;
          const ctx = {
            io,
            room,
            socket: null,
            playerUid: 'system_gm',
            actingPlayerName: '系统',
            broadcast: (event, payload) => io.to(room.id).emit(event, payload),
          };
          aiAgent
            .runAgentTurn(ctx, text)
            .then(async (parsed) => {
              const msgId = aiAgent.persistGmOutcome(room, parsed);
              io.to(room.id).emit('gm:response', {
                id: msgId,
                type: 'gm_response',
                askerName: '系统（投票结算）',
                narrative: parsed.narrative,
                options: parsed.options,
                sourceReferences: parsed.source_references,
                at: new Date().toISOString(),
              });
            })
            .catch((err) => {
              roomManager.saveMessage(room.id, null, 'system', `GM 无法回应投票结果：${err.message || '未知错误'}`);
              io.to(room.id).emit('chat:message', {
                id: roomManager.saveMessage(room.id, null, 'system', `GM 无法回应投票结果：${err.message || '未知错误'}`),
                type: 'system',
                playerName: null,
                text: `GM 无法回应投票结果：${err.message || '未知错误'}`,
                at: new Date().toISOString(),
              });
            })
            .finally(() => {
              room.gmBusy = false;
              io.to(room.id).emit('gm:status', { status: null });
            });
        }
      }
    }
    res.json({ ok: true, ...r, decision: decisionEngine.decisionView(req.params.uid) });
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;
