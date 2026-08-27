/**
 * websocket 通信：全部游戏事件的绑定与广播。
 * 事件协议见 docs/01-requirements-analysis.md。
 */
const { MESSAGE_MAX } = require('../config');
const roomManager = require('../rooms/roomManager');
const { validateName, makePlayer } = require('../players/playerManager');

/** 广播一条系统消息到房间（并持久化）。 */
function broadcastSystem(io, room, text) {
  const id = roomManager.saveMessage(room.id, null, 'system', text);
  io.to(room.id).emit('chat:message', {
    id,
    type: 'system',
    playerName: null,
    text,
    at: new Date().toISOString(),
  });
}

/** 离开当前房间并通知其余玩家。 */
function leaveCurrentRoom(io, socket, silent = false) {
  const result = roomManager.leaveRoom(socket.id);
  if (!result) return;
  const { roomId, room, player } = result;
  socket.leave(roomId);
  if (room && !silent) {
    io.to(room.id).emit('player:left', {
      playerName: player.name,
      players: roomManager.publicPlayers(room),
    });
    broadcastSystem(io, room, `${player.name} 离开了房间`);
  }
}

module.exports = function registerSocketHandlers(io) {
  io.on('connection', (socket) => {
    /** 创建房间（F3/F4）：校验名字 → 建房 → 创建者自动加入。 */
    socket.on('room:create', ({ playerName } = {}, ack) => {
      const { name, error } = validateName(playerName);
      if (error) return socket.emit('error', { message: error });

      // 若已在某房间，先离开
      leaveCurrentRoom(io, socket, true);

      const room = roomManager.createRoom(socket.id);
      roomManager.joinRoom(room.id, makePlayer(socket.id, name));
      socket.join(room.id);

      const payload = { room: { id: room.id, maxPlayers: room.maxPlayers }, players: roomManager.publicPlayers(room) };
      if (typeof ack === 'function') ack({ ok: true, ...payload });
      socket.emit('room:joined', payload);
    });

    /** 加入房间（F5）。 */
    socket.on('room:join', ({ playerName, roomId } = {}, ack) => {
      const { name, error } = validateName(playerName);
      if (error) return socket.emit('error', { message: error });

      const code = String(roomId ?? '').trim().toUpperCase();
      if (!code) return socket.emit('error', { message: '请输入房间ID' });

      leaveCurrentRoom(io, socket, true);

      const result = roomManager.joinRoom(code, makePlayer(socket.id, name));
      if (result.error) return socket.emit('error', { message: result.error });

      const { room } = result;
      socket.join(room.id);

      const payload = { room: { id: room.id, maxPlayers: room.maxPlayers }, players: roomManager.publicPlayers(room) };
      if (typeof ack === 'function') ack({ ok: true, ...payload });
      socket.emit('room:joined', payload);

      // 通知房间内其他人（F9）
      socket.to(room.id).emit('player:joined', { playerName: name, players: payload.players });
      broadcastSystem(io, room, `${name} 加入了房间`);
    });

    /** 主动离开房间。 */
    socket.on('room:leave', () => {
      leaveCurrentRoom(io, socket);
    });

    /** 聊天消息（F7/F8）：校验 → 持久化 → 广播全房间。 */
    socket.on('chat:send', ({ text } = {}) => {
      const room = roomManager.findRoomBySocket(socket.id);
      if (!room) return socket.emit('error', { message: '你不在任何房间中' });

      const content = String(text ?? '').trim();
      if (!content) return;
      if (content.length > MESSAGE_MAX) {
        return socket.emit('error', { message: `消息不能超过${MESSAGE_MAX}个字符` });
      }

      const player = room.players.find((p) => p.socketId === socket.id);
      const row = roomManager.getPlayerRow(socket.id);
      const id = roomManager.saveMessage(room.id, row ? row.id : null, 'chat', content);

      io.to(room.id).emit('chat:message', {
        id,
        type: 'chat',
        playerName: player.name,
        text: content,
        at: new Date().toISOString(),
      });
    });

    /** 断线即离开（F9）。 */
    socket.on('disconnect', () => {
      leaveCurrentRoom(io, socket);
    });
  });
};
