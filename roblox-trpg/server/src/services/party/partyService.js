/**
 * Party 系统（阶段13 第一、二节）：队伍管理 + 叙事角色定位。
 * 规则：一个房间只能存在一个主队伍（parties 部分唯一索引保证）；
 * 角色定位（EXPLORER/COMBATANT/SUPPORT/SCOUT/CUSTOM）只影响 AI 叙事描述，绝不改变真实属性。
 */
const crypto = require('crypto');
const { getDb } = require('@roblox-trpg/database');

const PARTY_ROLES = ['EXPLORER', 'COMBATANT', 'SUPPORT', 'SCOUT', 'CUSTOM'];

const ROLE_LABELS = {
  EXPLORER: '探索者',
  COMBATANT: '战斗员',
  SUPPORT: '支援者',
  SCOUT: '侦察者',
  CUSTOM: '自定义',
};

class PartyError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function getPlayerRow(playerId) {
  return getDb().prepare('SELECT * FROM players WHERE id = ?').get(Number(playerId));
}

/** 房间当前主队伍（唯一）。 */
function getActiveParty(roomId) {
  return getDb().prepare("SELECT * FROM parties WHERE room_id = ? AND status = 'ACTIVE'").get(roomId);
}

function getParty(partyId) {
  return getDb().prepare('SELECT * FROM parties WHERE id = ?').get(Number(partyId));
}

function membersOf(partyId) {
  return getDb()
    .prepare(
      `SELECT pm.*, p.name AS player_name, p.uid AS player_uid FROM party_members pm JOIN players p ON p.id = pm.player_id WHERE pm.party_id = ? ORDER BY pm.joined_at, pm.id`
    )
    .all(partyId);
}

function isMember(partyId, playerId) {
  return Boolean(getDb().prepare('SELECT 1 FROM party_members WHERE party_id = ? AND player_id = ?').get(partyId, playerId));
}

function broadcastParty(io, roomId, party) {
  if (io && roomId) io.to(roomId).emit('party:update', party ? partyView(party.id) : { disbanded: true });
}

function audit(io, roomId, actor, action, after) {
  try {
    getDb()
      .prepare('INSERT INTO world_events (room_id, actor, action, before_state, after_state, source) VALUES (?, ?, ?, ?, ?, ?)')
      .run(roomId, actor, action, null, JSON.stringify(after), 'party_service');
  } catch { /* 审计失败不阻塞 */ }
}

/** 创建队伍（一房一队；创建者自动成为队长与成员）。 */
function createParty(io, roomId, leaderPlayerId) {
  const db = getDb();
  const leader = getPlayerRow(leaderPlayerId);
  if (!leader) throw new PartyError('PLAYER_NOT_FOUND', '玩家不存在', 404);
  if (leader.room_id !== roomId) throw new PartyError('NOT_IN_ROOM', '玩家不在该房间', 403);
  if (getActiveParty(roomId)) throw new PartyError('PARTY_EXISTS', '该房间已存在主队伍（一个房间只能有一个主队伍）', 409);

  let uid;
  do {
    uid = `party_${crypto.randomBytes(4).toString('hex')}`;
  } while (db.prepare('SELECT 1 FROM parties WHERE uid = ?').get(uid));
  const info = db.prepare('INSERT INTO parties (uid, room_id, leader_player_id) VALUES (?, ?, ?)').run(uid, roomId, leader.id);
  const party = getParty(info.lastInsertRowid);
  joinParty(io, party.id, leader.id, { skipPartyExistsCheck: true });

  const gameEvents = require('../quests/gameEvents');
  gameEvents.emit(io, roomId, { type: 'PARTY_CREATED', actor: leader.name, actorPlayerId: leader.id, data: { partyUid: uid } });
  audit(io, roomId, leader.name, 'PARTY_CREATED', { partyUid: uid, leader: leader.name });
  broadcastParty(io, roomId, party);
  return party;
}

/** 加入队伍（幂等；已在队伍中直接返回）。 */
function joinParty(io, partyId, playerId, { skipPartyExistsCheck = false } = {}) {
  const db = getDb();
  const party = getParty(partyId);
  if (!party || party.status !== 'ACTIVE') throw new PartyError('PARTY_NOT_FOUND', '队伍不存在或已解散', 404);
  const player = getPlayerRow(playerId);
  if (!player) throw new PartyError('PLAYER_NOT_FOUND', '玩家不存在', 404);
  if (player.room_id !== party.room_id) throw new PartyError('NOT_IN_ROOM', '玩家不在该房间', 403);
  if (!skipPartyExistsCheck) {
    const active = getActiveParty(party.room_id);
    if (active && active.id !== party.id) throw new PartyError('PARTY_EXISTS', '该房间已有其他主队伍', 409);
  }
  if (isMember(party.id, player.id)) return { joined: false, reason: 'ALREADY_MEMBER', party };
  db.prepare('INSERT INTO party_members (party_id, player_id) VALUES (?, ?)').run(party.id, player.id);
  db.prepare('INSERT OR IGNORE INTO party_roles (party_id, player_id, role) VALUES (?, ?, ?)').run(party.id, player.id, 'CUSTOM');

  const gameEvents = require('../quests/gameEvents');
  gameEvents.emit(io, party.room_id, { type: 'PARTY_JOINED', actor: player.name, actorPlayerId: player.id, data: { partyUid: party.uid } });
  audit(io, party.room_id, player.name, 'PARTY_JOINED', { partyUid: party.uid });
  broadcastParty(io, party.room_id, party);
  return { joined: true, party };
}

/** 离开队伍：队长离开自动转移；队伍清空则解散。 */
function leaveParty(io, partyId, playerId) {
  const db = getDb();
  const party = getParty(partyId);
  if (!party || party.status !== 'ACTIVE') throw new PartyError('PARTY_NOT_FOUND', '队伍不存在或已解散', 404);
  if (!isMember(party.id, playerId)) throw new PartyError('NOT_MEMBER', '该玩家不在队伍中', 409);
  const player = getPlayerRow(playerId);

  db.prepare('DELETE FROM party_members WHERE party_id = ? AND player_id = ?').run(party.id, playerId);
  db.prepare('DELETE FROM party_roles WHERE party_id = ? AND player_id = ?').run(party.id, playerId);
  const gameEvents = require('../quests/gameEvents');
  gameEvents.emit(io, party.room_id, { type: 'PARTY_LEFT', actor: player ? player.name : null, actorPlayerId: playerId, data: { partyUid: party.uid } });

  const remaining = membersOf(party.id);
  if (remaining.length === 0) {
    db.prepare("UPDATE parties SET status = 'DISBANDED', disbanded_at = datetime('now') WHERE id = ?").run(party.id);
    gameEvents.emit(io, party.room_id, { type: 'PARTY_DISBANDED', actor: 'server', data: { partyUid: party.uid, reason: 'EMPTY' } });
    audit(io, party.room_id, 'server', 'PARTY_DISBANDED', { partyUid: party.uid });
    broadcastParty(io, party.room_id, null);
    return { left: true, disbanded: true };
  }
  if (party.leader_player_id === playerId) {
    // 队长转移：最早加入的成员接任（服务器规则，不由 AI 指定）
    transferLeadership(io, party.id, remaining[0].player_id, { reason: 'LEADER_LEFT' });
  }
  audit(io, party.room_id, player ? player.name : `player#${playerId}`, 'PARTY_LEFT', { partyUid: party.uid });
  broadcastParty(io, party.room_id, party);
  return { left: true, disbanded: false };
}

/** 队长转移（仅现任队长可发起；服务器验证目标为成员）。 */
function transferLeadership(io, partyId, newLeaderPlayerId, { reason = 'TRANSFER' } = {}) {
  const db = getDb();
  const party = getParty(partyId);
  if (!party || party.status !== 'ACTIVE') throw new PartyError('PARTY_NOT_FOUND', '队伍不存在或已解散', 404);
  if (!isMember(party.id, newLeaderPlayerId)) throw new PartyError('NOT_MEMBER', '新队长必须是队伍成员', 409);
  if (party.leader_player_id === newLeaderPlayerId) return { transferred: false, reason: 'ALREADY_LEADER' };
  db.prepare('UPDATE parties SET leader_player_id = ? WHERE id = ?').run(newLeaderPlayerId, party.id);
  const newLeader = getPlayerRow(newLeaderPlayerId);
  const gameEvents = require('../quests/gameEvents');
  gameEvents.emit(io, party.room_id, { type: 'PARTY_LEADER_CHANGED', actor: 'server', data: { partyUid: party.uid, newLeader: newLeader ? newLeader.name : null, reason } });
  audit(io, party.room_id, 'server', 'PARTY_LEADER_CHANGED', { partyUid: party.uid, newLeader: newLeader ? newLeader.name : null, reason });
  broadcastParty(io, party.room_id, party);
  return { transferred: true, newLeaderPlayerId };
}

/** 设置叙事角色定位（只影响 AI 描述，绝不改变属性；仅本人可设置自己）。 */
function setRole(io, partyId, playerId, role) {
  const db = getDb();
  if (!PARTY_ROLES.includes(role)) throw new PartyError('INVALID_ROLE', `非法角色定位 ${role}（允许：${PARTY_ROLES.join('/')}）`);
  const party = getParty(partyId);
  if (!party || party.status !== 'ACTIVE') throw new PartyError('PARTY_NOT_FOUND', '队伍不存在或已解散', 404);
  if (!isMember(party.id, playerId)) throw new PartyError('NOT_MEMBER', '该玩家不在队伍中', 409);
  db.prepare(
    `INSERT INTO party_roles (party_id, player_id, role) VALUES (?, ?, ?)
     ON CONFLICT(party_id, player_id) DO UPDATE SET role = ?, updated_at = datetime('now')`
  ).run(party.id, playerId, role, role);
  db.prepare('UPDATE party_members SET role = ? WHERE party_id = ? AND player_id = ?').run(role, party.id, playerId);
  const player = getPlayerRow(playerId);
  const gameEvents = require('../quests/gameEvents');
  gameEvents.emit(io, party.room_id, { type: 'PARTY_ROLE_SET', actor: player ? player.name : null, actorPlayerId: playerId, data: { partyUid: party.uid, role } });
  broadcastParty(io, party.room_id, party);
  return { ok: true, role };
}

/** 队伍公开视图（成员/角色/队长/关系摘要）。 */
function partyView(partyId) {
  const party = getParty(partyId);
  if (!party) return null;
  const playerRelations = require('./playerRelations');
  const members = membersOf(partyId).map((m) => ({
    playerId: m.player_id,
    playerUid: m.player_uid,
    name: m.player_name,
    role: m.role,
    roleLabel: ROLE_LABELS[m.role] || ROLE_LABELS.CUSTOM,
    isLeader: m.player_id === party.leader_player_id,
    joinedAt: m.joined_at,
  }));
  const relationships = [];
  for (let i = 0; i < members.length; i += 1) {
    for (let j = i + 1; j < members.length; j += 1) {
      const rel = playerRelations.getRelationship(members[i].playerId, members[j].playerId);
      relationships.push({ a: members[i].name, b: members[j].name, value: rel.value, type: rel.relationshipType });
    }
  }
  return {
    partyId: party.id,
    uid: party.uid,
    roomId: party.room_id,
    status: party.status,
    leaderPlayerId: party.leader_player_id,
    members,
    relationships,
    createdAt: party.created_at,
  };
}

/** 玩家所在主队伍（若在）。 */
function partyOfPlayer(playerId) {
  const row = getDb()
    .prepare(
      `SELECT p.* FROM parties p JOIN party_members pm ON pm.party_id = p.id WHERE pm.player_id = ? AND p.status = 'ACTIVE' ORDER BY p.id DESC LIMIT 1`
    )
    .get(playerId);
  return row || null;
}

module.exports = {
  PartyError,
  PARTY_ROLES,
  ROLE_LABELS,
  createParty,
  joinParty,
  leaveParty,
  transferLeadership,
  setRole,
  getActiveParty,
  getParty,
  membersOf,
  isMember,
  partyView,
  partyOfPlayer,
};
