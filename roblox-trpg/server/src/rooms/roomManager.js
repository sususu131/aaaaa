/**
 * 房间管理：内存 Map 为运行时权威状态（低延迟），SQLite 做持久化记录。
 */
const { getDb } = require('@roblox-trpg/database');
const { ROOM_MAX_PLAYERS } = require('../config');
const { generateRoomCode } = require('../util/roomCode');

/** roomId -> { id, maxPlayers, players: [{ socketId, name, joinedAt }] } */
const rooms = new Map();

/** 生成不与现有房间冲突的房间码。 */
function nextRoomCode() {
  for (let i = 0; i < 100; i += 1) {
    const code = generateRoomCode();
    if (!rooms.has(code)) return code;
  }
  throw new Error('房间码生成失败，请重试');
}

/** 创建房间。返回 { id, maxPlayers, players: [] }。 */
function createRoom(creatorSocketId) {
  const id = nextRoomCode();
  const room = { id, maxPlayers: ROOM_MAX_PLAYERS, players: [] };
  rooms.set(id, room);

  getDb()
    .prepare('INSERT INTO rooms (id, status, max_players, creator_socket_id) VALUES (?, ?, ?, ?)')
    .run(id, 'waiting', ROOM_MAX_PLAYERS, creatorSocketId);

  return room;
}

/** 获取房间（不存在返回 undefined）。 */
function getRoom(roomId) {
  return rooms.get(roomId);
}

/** 序列化玩家列表（对外广播用，不暴露 socketId）。 */
function publicPlayers(room) {
  return room.players.map((p) => ({ name: p.name, joinedAt: p.joinedAt }));
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
 * 校验：房间存在、未满、同名重复（同一房间内）。
 */
function joinRoom(roomId, player) {
  const room = rooms.get(roomId);
  if (!room) return { error: '房间不存在，请检查房间ID' };
  if (room.players.length >= room.maxPlayers) return { error: '房间已满（最多3人）' };
  if (room.players.some((p) => p.name === player.name)) {
    return { error: '房间内已有同名玩家，请换个名字' };
  }

  const record = { socketId: player.socketId, name: player.name, joinedAt: new Date().toISOString() };
  room.players.push(record);

  const db = getDb();
  db.prepare(
    `INSERT INTO players (socket_id, name, room_id) VALUES (?, ?, ?)
     ON CONFLICT(socket_id) DO UPDATE SET name = excluded.name, room_id = excluded.room_id, left_at = NULL`
  ).run(player.socketId, player.name, room.id);

  return { room };
}

/** 从所在房间移除玩家；房间无人时销毁。返回 { roomId, room, player } 或 null。 */
function leaveRoom(socketId) {
  const room = findRoomBySocket(socketId);
  if (!room) return null;

  const idx = room.players.findIndex((p) => p.socketId === socketId);
  const [player] = room.players.splice(idx, 1);

  const db = getDb();
  db.prepare('UPDATE players SET room_id = NULL, left_at = datetime(\'now\') WHERE socket_id = ?').run(socketId);

  if (room.players.length === 0) {
    db.prepare('UPDATE rooms SET status = ?, closed_at = datetime(\'now\') WHERE id = ?').run('finished', room.id);
    rooms.delete(room.id);
    return { roomId: room.id, room: null, player };
  }
  return { roomId: room.id, room, player };
}

/** 持久化一条聊天/系统消息，返回自增 id。 */
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
  saveMessage,
  getPlayerRow,
};
