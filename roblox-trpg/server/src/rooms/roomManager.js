/**
 * 房间管理：内存 Map 为运行时权威状态（低延迟），SQLite 做持久化记录。
 * 阶段2扩展：currentExperience（绑定的 Roblox 体验）、contextFlags、gmBusy。
 */
const { getDb } = require('@roblox-trpg/database');
const { ROOM_MAX_PLAYERS } = require('../config');
const { generateRoomCode } = require('../util/roomCode');

/** roomId -> { id, maxPlayers, players, currentExperience, contextFlags, gmBusy } */
const rooms = new Map();

function newRoomState(id) {
  return {
    id,
    maxPlayers: ROOM_MAX_PLAYERS,
    players: [],
    currentExperience: null, // ROBLOX_SOURCE_DATA 来源（官方公开资料快照）
    currentDungeon: null,    // 数据库登记副本 { dungeonId, name, robloxUniverseId }
    contextFlags: {},        // 压缩阈值提示去重标记
    gmBusy: false,           // GM 并发保护（同一房间 GM 串行，防并发覆盖）
  };
}

/** 生成不与现有房间冲突的房间码。 */
function nextRoomCode() {
  for (let i = 0; i < 100; i += 1) {
    const code = generateRoomCode();
    if (!rooms.has(code)) return code;
  }
  throw new Error('房间码生成失败，请重试');
}

/** 创建房间。 */
function createRoom(creatorSocketId) {
  const id = nextRoomCode();
  const room = newRoomState(id);
  rooms.set(id, room);

  getDb()
    .prepare('INSERT INTO rooms (id, status, max_players, creator_socket_id) VALUES (?, ?, ?, ?)')
    .run(id, 'waiting', ROOM_MAX_PLAYERS, creatorSocketId);

  return room;
}

function getRoom(roomId) {
  return rooms.get(roomId);
}

/** 玩家列表（对外广播用，含公开头像信息，不暴露 socketId）。 */
function publicPlayers(room) {
  // 阶段32：断线保留座位的玩家带 disconnected 标记（前端显示 ⚠）
  const disconnected = new Set(
    (room.players || []).filter((p) => p.disconnectedAt).map((p) => p.name)
  );
  const rows = getDb()
    .prepare(
      `SELECT p.name, p.uid, p.avatar_type, rp.roblox_user_id, rp.username, rp.display_name, rp.headshot_url
       FROM players p LEFT JOIN roblox_profiles rp ON rp.id = p.roblox_profile_id
       WHERE p.room_id = ? AND p.left_at IS NULL
       ORDER BY p.joined_at`
    )
    .all(room.id);
  return rows.map((r) => ({
    name: r.name,
    uid: r.uid,
    avatarType: r.avatar_type || 'bacon',
    headshotUrl: r.headshot_url || null,
    disconnected: disconnected.has(r.name),
    roblox: r.roblox_user_id
      ? { userId: r.roblox_user_id, username: r.username, displayName: r.display_name || r.username }
      : null,
  }));
}

/** 查找某玩家当前所在房间。 */
function findRoomBySocket(socketId) {
  for (const room of rooms.values()) {
    if (room.players.some((p) => p.socketId === socketId)) return room;
  }
  return undefined;
}

/**
 * 加入房间。成功返回 { room }，失败返回 { error }。
 * player: { socketId, name, existingRowId? }（existingRowId 用于会话重连复用玩家行）。
 * 阶段32：断线保留座位的玩家重连 → 复活原座位（不占新名额、保留顺序与身份）。
 */
function findRevivableSeat(room, player) {
  return (
    room.players.find(
      (p) =>
        p.disconnectedAt &&
        ((player.existingRowId && p.rowId === player.existingRowId) || p.name === player.name)
    ) || null
  );
}

function joinRoom(roomId, player) {
  const room = rooms.get(roomId);
  if (!room) return { error: '房间不存在，请检查房间ID' };

  // 阶段32：先找可复活的断线座位（浏览器休眠重连、刷新后重进）
  const seat = findRevivableSeat(room, player);

  const alreadyIn = room.players.some((p) => p.socketId === player.socketId);
  if (!alreadyIn && !seat && room.players.length >= room.maxPlayers) return { error: '房间已满（最多3人）' };
  if (
    room.players.some((p) => p.name === player.name && p.socketId !== player.socketId && !p.disconnectedAt)
  ) {
    return { error: '房间内已有同名玩家，请换个名字' };
  }

  const db = getDb();

  // 复活断线座位：换绑新 socketId，清掉断线标记（DB 玩家行保持 room_id / joined_at 不变）
  if (seat) {
    const oldSocketId = seat.socketId;
    seat.socketId = player.socketId;
    seat.disconnectedAt = null;
    if (player.existingRowId) {
      db.prepare(
        'UPDATE players SET socket_id = ?, name = ?, room_id = ?, left_at = NULL WHERE id = ?'
      ).run(player.socketId, player.name, room.id, player.existingRowId);
    } else if (oldSocketId) {
      db.prepare(
        'UPDATE players SET socket_id = ?, room_id = ?, left_at = NULL WHERE socket_id = ?'
      ).run(player.socketId, room.id, oldSocketId);
    }
    return { room, revived: true };
  }

  // 重连场景：先移除旧记录再重新入房
  room.players = room.players.filter((p) => p.socketId !== player.socketId);
  let rowId = player.existingRowId || null;
  if (rowId) {
    db.prepare(
      'UPDATE players SET socket_id = ?, name = ?, room_id = ?, left_at = NULL WHERE id = ?'
    ).run(player.socketId, player.name, room.id, rowId);
  } else {
    const info = db
      .prepare(
        `INSERT INTO players (socket_id, name, room_id) VALUES (?, ?, ?)
         ON CONFLICT(socket_id) DO UPDATE SET name = excluded.name, room_id = excluded.room_id, left_at = NULL`
      )
      .run(player.socketId, player.name, room.id);
    rowId = info.lastInsertRowid;
  }
  room.players.push({ socketId: player.socketId, name: player.name, rowId, joinedAt: new Date().toISOString() });

  return { room };
}

/**
 * 阶段32：断线 → 标记座位保留，graceMs 后仍未恢复才真正移除。
 * onExpire(roomId, name) 在真正移除后回调（用于广播）。
 */
function markDisconnected(socketId, graceMs, onExpire) {
  const room = findRoomBySocket(socketId);
  if (!room) return null;
  const player = room.players.find((p) => p.socketId === socketId);
  if (!player) return null;
  player.disconnectedAt = Date.now();
  setTimeout(() => {
    const cur = rooms.get(room.id);
    if (!cur) return; // 房间已销毁
    const still = cur.players.find((p) => p.socketId === socketId);
    if (still && still.disconnectedAt) {
      leaveRoom(socketId);
      if (typeof onExpire === 'function') onExpire(room.id, player.name);
    }
  }, graceMs);
  return { room, player };
}

/** 从所在房间移除玩家；房间无人且无活跃副本实例时销毁（阶段5：实例独立于房主会话）。 */
function leaveRoom(socketId) {
  const room = findRoomBySocket(socketId);
  if (!room) return null;

  const idx = room.players.findIndex((p) => p.socketId === socketId);
  const [player] = room.players.splice(idx, 1);

  const db = getDb();
  db.prepare('UPDATE players SET room_id = NULL, left_at = datetime(\'now\') WHERE socket_id = ?').run(socketId);

  if (room.players.length === 0) {
    // 有活跃副本实例时保留房间（玩家可重连恢复；实例生命周期独立于房主）
    const { getActiveByRoom } = require('../services/runtime/instanceManager');
    if (getActiveByRoom(room.id)) {
      return { roomId: room.id, room, player };
    }
    db.prepare('UPDATE rooms SET status = ?, closed_at = datetime(\'now\') WHERE id = ?').run('finished', room.id);
    rooms.delete(room.id);
    return { roomId: room.id, room: null, player };
  }
  return { roomId: room.id, room, player };
}

/** 绑定房间的 Roblox 体验（官方公开资料快照），并持久化。 */
function setRoomExperience(room, experience) {
  room.currentExperience = experience;
  getDb()
    .prepare('UPDATE rooms SET current_experience = ? WHERE id = ?')
    .run(JSON.stringify(experience), room.id);
}

function clearRoomExperience(room) {
  room.currentExperience = null;
  getDb().prepare('UPDATE rooms SET current_experience = NULL WHERE id = ?').run(room.id);
}

/** 持久化一条消息（chat / system / gm），返回自增 id。 */
function saveMessage(roomId, playerId, type, content) {
  const info = getDb()
    .prepare('INSERT INTO messages (room_id, player_id, type, content) VALUES (?, ?, ?, ?)')
    .run(roomId, playerId, type, content);
  return info.lastInsertRowid;
}

/** 查玩家数据库记录（按 socket_id）。 */
function getPlayerRow(socketId) {
  return getDb().prepare('SELECT * FROM players WHERE socket_id = ?').get(socketId);
}

module.exports = {
  createRoom,
  getRoom,
  publicPlayers,
  findRoomBySocket,
  joinRoom,
  leaveRoom,
  markDisconnected,
  setRoomExperience,
  clearRoomExperience,
  saveMessage,
  getPlayerRow,
};
