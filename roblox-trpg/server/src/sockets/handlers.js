/**
 * websocket 通信：全部游戏事件的绑定与广播。
 * 阶段1：房间生命周期 + 聊天。
 * 阶段2：临时会话身份 / @AI → GM 流水线 / Roblox 绑定与副本选择 / Context Viewer。
 *
 * 架构红线：PLAYER → SERVER → AI → RULE ENGINE → DATABASE → ALL PLAYERS。
 * AI 输出不直达任何状态表；玩家输入全部按 UNTRUSTED INPUT 处理。
 */
const { MESSAGE_MAX, CONTEXT_VIEWER_SCOPE } = require('../config');
const { getDb } = require('@roblox-trpg/database');
const roomManager = require('../rooms/roomManager');
const { validateName } = require('../players/playerManager');
const { createSession, resolveSession } = require('../sessions/sessionManager');
const aiAgent = require('../services/ai/aiAgent');
const rateLimiter = require('../services/ai/rateLimiter');
const { maybeCompress } = require('../services/ai/contextCompressor');
const { buildContext } = require('../services/ai/contextBuilder');
const robloxUsers = require('../services/roblox/robloxUsers');
const robloxThumbnails = require('../services/roblox/robloxThumbnails');
const robloxExperiences = require('../services/roblox/robloxExperiences');
const robloxSearch = require('../services/roblox/robloxSearch');
const { initializeAvatar } = require('../services/vision/initializeAvatar');

/**
 * Bacon Head 默认初始化（阶段3b）：无 Roblox 账号 → 全属性5 + 0技能，
 * 完全不调用 Vision API。入房时异步执行，不阻塞。
 */
function maybeBaconInit(io, room, socket) {
  const row = getDb()
    .prepare('SELECT id, roblox_profile_id FROM players WHERE socket_id = ?')
    .get(socket.id);
  if (!row || row.roblox_profile_id) return;
  initializeAvatar({ playerRowId: row.id, forceBacon: true })
    .then((result) => {
      if (result.status === 'INITIALIZED' && !result.duplicate) {
        const player = room.players.find((p) => p.socketId === socket.id);
        io.to(room.id).emit('avatar:initialized', {
          playerName: player ? player.name : '',
          bacon: true,
          attributes: result.attributes,
          skills: [],
        });
      }
    })
    .catch(() => {});
}

/** Tool 广播事件 → 持久化消息类型映射（关键事件可追溯、可进 Context）。 */
const EVENT_MSG_TYPE = {
  'dice:rolled': 'dice',
  'skill:check': 'skill_check',
  'skill:gained': 'gain',
  'item:gained': 'gain',
  'world:changed': 'world',
  'dungeon:completed': 'dungeon',
};

// ── 通用工具 ──────────────────────────────────────────────

/** 广播系统消息（并持久化）。 */
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

/** 广播玩家列表刷新。 */
function broadcastPlayers(io, room) {
  io.to(room.id).emit('players:update', { players: roomManager.publicPlayers(room) });
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

/** 会话接入：握手带有效 token → 复用身份；否则创建新的临时身份。 */
function attachSession(socket, playerRowId) {
  const handToken = socket.handshake.auth && socket.handshake.auth.sessionToken;
  const resolved = handToken ? resolveSession(handToken) : null;
  if (resolved && resolved.playerRowId === playerRowId) {
    socket.playerUid = resolved.playerId;
    return { playerId: resolved.playerId, sessionToken: null }; // token 客户端已持有
  }
  const { playerId, token } = createSession(playerRowId);
  socket.playerUid = playerId;
  return { playerId, sessionToken: token };
}

/** 组装 create/join 的成功载荷。 */
function roomPayload(room, session) {
  return {
    room: {
      id: room.id,
      maxPlayers: room.maxPlayers,
      experience: room.currentExperience || null,
      dungeon: room.currentDungeon || null,
    },
    players: roomManager.publicPlayers(room),
    playerId: session.playerId,
    ...(session.sessionToken ? { sessionToken: session.sessionToken } : {}),
  };
}

// ── @AI → GM Agent 流水线（阶段3：多轮 Tool Calling）──────

async function triggerGm(io, socket, room, player, text) {
  if (room.gmBusy) {
    socket.emit('error', { message: 'GM 正在处理上一条请求，请稍候' });
    return;
  }
  const limit = rateLimiter.tryConsumeAiRequest(socket.playerUid || socket.id, room.id);
  if (!limit.ok) {
    broadcastSystem(
      io,
      room,
      limit.scope === 'player'
        ? `AI 请求过于频繁（单玩家限流），请 ${limit.retryAfterSec} 秒后重试`
        : `本房间 AI 请求过于频繁（房间限流），请 ${limit.retryAfterSec} 秒后重试`
    );
    return;
  }

  // 阶段5：房间有 RUNNING 副本实例且发言者在队伍中 → 走 Runtime GM（实例 Context）
  const { getActiveByRoom } = require('../services/runtime/instanceManager');
  const runtimeEngine = require('../services/runtime/runtimeEngine');
  const activeInstance = getActiveByRoom(room.id);
  if (activeInstance && activeInstance.status === 'RUNNING') {
    const playerRow = getDb().prepare('SELECT * FROM players WHERE socket_id = ?').get(socket.id);
    if (playerRow && JSON.parse(activeInstance.party || '[]').includes(playerRow.id)) {
      room.gmBusy = true;
      try {
        await runtimeEngine.submitAction(io, room, activeInstance, playerRow, text, null);
      } catch (err) {
        broadcastSystem(io, room, `GM 无法回应：${err.message || '未知错误'}`);
      } finally {
        room.gmBusy = false;
        io.to(room.id).emit('gm:status', { status: null });
      }
      return;
    }
  }

  room.gmBusy = true;
  const ctx = {
    io,
    room,
    socket,
    playerUid: socket.playerUid,
    actingPlayerName: player.name,
    /** Tool 广播：实时推送 + 关键事件持久化（谁/何时/前后状态可追溯）。 */
    broadcast: (event, payload) => {
      io.to(room.id).emit(event, payload);
      const msgType = EVENT_MSG_TYPE[event];
      if (msgType) roomManager.saveMessage(room.id, null, msgType, JSON.stringify(payload));
    },
  };

  try {
    const parsed = await aiAgent.runAgentTurn(ctx, text);
    const msgId = aiAgent.persistGmOutcome(room, parsed);
    io.to(room.id).emit('gm:response', {
      id: msgId,
      type: 'gm_response',
      askerName: player.name,
      narrative: parsed.narrative,
      options: parsed.options,
      sourceReferences: parsed.source_references,
      at: new Date().toISOString(),
    });
    // Context 压缩检查（不阻塞主线）
    maybeCompress(room, io, (msgs) => aiAgent.summarizeHistory(room.id, msgs))
      .then((note) => note && broadcastSystem(io, room, note))
      .catch(() => {});
  } catch (err) {
    // 按真实原因提示：未配置 / 限速 / 余额不足 / 鉴权失败 / 超时 / 格式异常
    broadcastSystem(io, room, `GM 无法回应：${err.message || '未知错误'}`);
  } finally {
    room.gmBusy = false;
    io.to(room.id).emit('gm:status', { status: null });
  }
}

/** 把 Roblox 体验快照关联到数据库登记的副本（按 universeId 或体验名）。 */
function linkDungeonFromExperience(room, experience) {
  const db = getDb();
  const row =
    db.prepare('SELECT * FROM dungeons WHERE roblox_universe_id = ?').get(experience.universeId) ||
    db.prepare('SELECT * FROM dungeons WHERE LOWER(roblox_experience_name) = LOWER(?)').get(experience.name);
  if (row) {
    room.currentDungeon = { dungeonId: row.id, name: row.dungeon_name, robloxUniverseId: row.roblox_universe_id };
  }
  return room.currentDungeon;
}

// ── 事件注册 ─────────────────────────────────────────────

module.exports = function registerSocketHandlers(io) {
  io.on('connection', (socket) => {
    // 握手会话恢复（刷新/重连保持 playerId）
    const handToken = socket.handshake.auth && socket.handshake.auth.sessionToken;
    const sess = handToken ? resolveSession(handToken) : null;
    if (sess) {
      socket.playerRowId = sess.playerRowId;
      socket.playerUid = sess.playerId;
    }

    /** 创建房间。 */
    socket.on('room:create', ({ playerName } = {}, ack) => {
      const { name, error } = validateName(playerName);
      if (error) return socket.emit('error', { message: error });

      leaveCurrentRoom(io, socket, true);

      const room = roomManager.createRoom(socket.id);
      roomManager.joinRoom(room.id, { socketId: socket.id, name });
      socket.join(room.id);

      const row = roomManager.getPlayerRow(socket.id);
      const session = attachSession(socket, row.id);
      require('../services/character/characterService').ensureCharacter(row.id); // 阶段6：新玩家自动创建 Character
      const payload = roomPayload(room, session);
      if (typeof ack === 'function') ack({ ok: true, ...payload });
      socket.emit('room:joined', payload);
      maybeBaconInit(io, room, socket); // 阶段3b：无 Roblox 账号 → 默认属性，不调用 Vision
    });

    /** 加入房间。 */
    socket.on('room:join', ({ playerName, roomId } = {}, ack) => {
      const { name, error } = validateName(playerName);
      if (error) return socket.emit('error', { message: error });

      const code = String(roomId ?? '').trim().toUpperCase();
      if (!code) return socket.emit('error', { message: '请输入房间ID' });

      leaveCurrentRoom(io, socket, true);

      const result = roomManager.joinRoom(code, {
        socketId: socket.id,
        name,
        existingRowId: socket.playerRowId,
      });
      if (result.error) return socket.emit('error', { message: result.error });

      const { room } = result;
      socket.join(room.id);

      const row = roomManager.getPlayerRow(socket.id);
      const session = attachSession(socket, row.id);
      require('../services/character/characterService').ensureCharacter(row.id); // 阶段6：新玩家自动创建 Character
      const payload = roomPayload(room, session);
      if (typeof ack === 'function') ack({ ok: true, ...payload });
      socket.emit('room:joined', payload);

      socket.to(room.id).emit('player:joined', { playerName: name, players: payload.players });
      broadcastSystem(io, room, `${name} 加入了房间`);
      maybeBaconInit(io, room, socket); // 阶段3b
    });

    /** 主动离开房间。 */
    socket.on('room:leave', () => {
      leaveCurrentRoom(io, socket);
    });

    /**
     * 聊天（Step 8）：普通消息直接广播；包含 @AI 时额外触发 GM 流水线。
     * @玩家 只是提及（前端高亮），绝不触发 AI。
     */
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

      // 仅显式 @AI 触发 GM；玩家间 @ 消息不能调用 AI
      if (/@AI\b/i.test(content)) {
        triggerGm(io, socket, room, player, content).catch(() => {});
      }
    });

    // ── Roblox 身份绑定（公开信息，无登录）──

    /** 绑定：提供 Roblox User ID 或 username，服务端抓取公开资料。 */
    socket.on('player:bindRoblox', async ({ userId, username } = {}, ack) => {
      const room = roomManager.findRoomBySocket(socket.id);
      if (!room) return socket.emit('error', { message: '你不在任何房间中' });
      try {
        const profile = userId
          ? await robloxUsers.getUserById(userId)
          : await robloxUsers.getUserByUsername(username);
        // 阶段30：R6/R15 双渲染 + 实际体型探测（绑定固定使用 R6 渲染）
        const [thumbs, avatarType] = await Promise.all([
          robloxThumbnails.getUserThumbnails(profile.userId).catch(() => ({ headshot: null, fullbody: null, fullbodyR6: null, fullbodyR15: null })),
          robloxThumbnails.getUserAvatarType(profile.userId).catch(() => null),
        ]);

        const db = getDb();
        db.prepare(
          `INSERT INTO roblox_profiles (roblox_user_id, username, display_name, description, headshot_url, fullbody_url, fullbody_r6_url, fullbody_r15_url, avatar_type)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(roblox_user_id) DO UPDATE SET
             username = excluded.username, display_name = excluded.display_name,
             description = excluded.description, headshot_url = excluded.headshot_url,
             fullbody_url = excluded.fullbody_url, fullbody_r6_url = excluded.fullbody_r6_url,
             fullbody_r15_url = excluded.fullbody_r15_url, avatar_type = excluded.avatar_type,
             fetched_at = datetime('now')`
        ).run(
          profile.userId,
          profile.username,
          profile.displayName,
          profile.description,
          thumbs.headshot && thumbs.headshot.state !== 'Blocked' ? thumbs.headshot.imageUrl : null,
          // 绑定固定 R6：fullbody_url 存 R6 渲染（R6 不可用回落 R15）
          (thumbs.fullbodyR6 && thumbs.fullbodyR6.state !== 'Blocked' && thumbs.fullbodyR6.imageUrl) ||
            (thumbs.fullbodyR15 && thumbs.fullbodyR15.state !== 'Blocked' ? thumbs.fullbodyR15.imageUrl : null),
          thumbs.fullbodyR6 && thumbs.fullbodyR6.state !== 'Blocked' ? thumbs.fullbodyR6.imageUrl : null,
          thumbs.fullbodyR15 && thumbs.fullbodyR15.state !== 'Blocked' ? thumbs.fullbodyR15.imageUrl : null,
          avatarType || null
        );
        const profileRow = db.prepare('SELECT id FROM roblox_profiles WHERE roblox_user_id = ?').get(profile.userId);
        db.prepare('UPDATE players SET roblox_profile_id = ?, avatar_type = ? WHERE socket_id = ?').run(
          profileRow.id,
          'roblox',
          socket.id
        );

        if (typeof ack === 'function') ack({ ok: true, profile });
        broadcastPlayers(io, room);
        const player = room.players.find((p) => p.socketId === socket.id);
        broadcastSystem(io, room, `${player.name} 绑定了 Roblox 形象（${profile.username}，仅公开信息）`);
      } catch (err) {
        if (typeof ack === 'function') ack({ ok: false, error: err.message });
        socket.emit('error', { message: err.message || 'Roblox 资料获取失败' });
      }
    });

    /** 解绑 → 培根头。 */
    socket.on('player:unbindRoblox', (_data, ack) => {
      const room = roomManager.findRoomBySocket(socket.id);
      if (!room) return;
      getDb().prepare('UPDATE players SET roblox_profile_id = NULL, avatar_type = ? WHERE socket_id = ?').run(
        'bacon',
        socket.id
      );
      if (typeof ack === 'function') ack({ ok: true });
      broadcastPlayers(io, room);
    });

    // ── 副本（Roblox Experience）选择（多结果不自动选定）──

    /** 搜索体验（仅回给请求者）。 */
    socket.on('dungeon:search', async ({ query } = {}, ack) => {
      try {
        const results = await robloxSearch.searchExperiences(query, 5);
        if (typeof ack === 'function') ack({ ok: true, results });
      } catch (err) {
        if (typeof ack === 'function') ack({ ok: false, error: err.message, kind: err.kind });
      }
    });

    /** URL / ID 解析体验。 */
    socket.on('dungeon:resolve', async ({ input } = {}, ack) => {
      try {
        const experience = await robloxExperiences.resolveExperience(input);
        if (typeof ack === 'function') ack({ ok: true, results: [experience] });
      } catch (err) {
        if (typeof ack === 'function') ack({ ok: false, error: err.message, kind: err.kind });
      }
    });

    /** 玩家选定体验 → 绑定为房间副本来源（官方资料快照 + 关联数据库副本）。 */
    socket.on('dungeon:select', async ({ universeId } = {}, ack) => {
      const room = roomManager.findRoomBySocket(socket.id);
      if (!room) return socket.emit('error', { message: '你不在任何房间中' });
      try {
        const experience = await robloxExperiences.getExperienceByUniverse(universeId);
        roomManager.setRoomExperience(room, experience);
        const dungeon = linkDungeonFromExperience(room, experience);
        if (typeof ack === 'function') ack({ ok: true, experience, dungeon });
        io.to(room.id).emit('dungeon:set', { experience, dungeon });
        broadcastSystem(
          io,
          room,
          `副本来源已锁定：${experience.name}（Roblox 官方公开资料，source=roblox_api）` +
            (dungeon ? `，已关联数据库副本「${dungeon.name}」` : '，该体验暂未在副本数据库登记')
        );
      } catch (err) {
        if (typeof ack === 'function') ack({ ok: false, error: err.message });
      }
    });

    /** 直接绑定数据库登记副本（离线/无 Roblox 网络时可用）。 */
    socket.on('dungeon:bindDb', ({ dungeonId } = {}, ack) => {
      const room = roomManager.findRoomBySocket(socket.id);
      if (!room) return socket.emit('error', { message: '你不在任何房间中' });
      const row = getDb().prepare('SELECT * FROM dungeons WHERE id = ?').get(Number(dungeonId));
      if (!row) return typeof ack === 'function' && ack({ ok: false, error: '副本不存在' });
      room.currentDungeon = { dungeonId: row.id, name: row.dungeon_name, robloxUniverseId: row.roblox_universe_id };
      if (typeof ack === 'function') ack({ ok: true, dungeon: room.currentDungeon });
      io.to(room.id).emit('dungeon:set', { experience: room.currentExperience, dungeon: room.currentDungeon });
      broadcastSystem(io, room, `已绑定数据库副本「${row.dungeon_name}」（对应体验：${row.roblox_experience_name}）`);
    });

    /** 列出数据库登记的副本（供离线绑定）。 */
    socket.on('dungeon:listDb', (_data, ack) => {
      const rows = getDb().prepare('SELECT id, dungeon_name, roblox_experience_name, difficulty FROM dungeons ORDER BY id').all();
      if (typeof ack === 'function') ack({ ok: true, dungeons: rows });
    });

    socket.on('dungeon:clear', (_data, ack) => {
      const room = roomManager.findRoomBySocket(socket.id);
      if (!room) return;
      roomManager.clearRoomExperience(room);
      room.currentDungeon = null;
      if (typeof ack === 'function') ack({ ok: true });
      io.to(room.id).emit('dungeon:set', { experience: null, dungeon: null });
      broadcastSystem(io, room, '已解除副本绑定');
    });

    // ── Context Viewer（Step 15-16，开发期调试用）──
    socket.on('context:view', (_data, ack) => {
      const room = roomManager.findRoomBySocket(socket.id);
      if (!room) return typeof ack === 'function' && ack({ ok: false, error: '你不在任何房间中' });

      if (CONTEXT_VIEWER_SCOPE === 'none') {
        return typeof ack === 'function' && ack({ ok: false, error: 'Context Viewer 已关闭' });
      }
      if (CONTEXT_VIEWER_SCOPE === 'host') {
        const db = getDb();
        const roomRow = db.prepare('SELECT creator_socket_id FROM rooms WHERE id = ?').get(room.id);
        if (!roomRow || roomRow.creator_socket_id !== socket.id) {
          return typeof ack === 'function' && ack({ ok: false, error: '仅房主可查看 Context' });
        }
      }
      // 脱敏：构建器从不包含 API Key / session token；这里再做一道长度保险
      const ctx = buildContext(room);
      if (typeof ack === 'function') {
        ack({
          ok: true,
          sections: ctx.sections.map((s) => ({
            key: s.key,
            label: s.label,
            tokens: s.tokens,
            content: s.content.length > 8000 ? `${s.content.slice(0, 8000)}\n…（已截断显示）` : s.content,
          })),
          totalTokens: ctx.totalTokens,
          budget: require('../config').AI_CONTEXT_BUDGET,
        });
      }
    });

    /** 阶段5：断线重连后同步房间活跃副本实例（实例独立于房主会话）。 */
    socket.on('instance:sync', (_data, ack) => {
      const room = roomManager.findRoomBySocket(socket.id);
      if (!room) return typeof ack === 'function' && ack({ ok: false, error: '不在房间中' });
      const { getActiveByRoom } = require('../services/runtime/instanceManager');
      const inst = getActiveByRoom(room.id);
      if (typeof ack === 'function') {
        ack({
          ok: true,
          instance: inst
            ? { uid: inst.uid, status: inst.status, currentSceneId: inst.current_scene_id, party: JSON.parse(inst.party || '[]') }
            : null,
        });
      }
    });

    /** 断线即离开房间（副本实例不受影响：座位保留，可重连恢复）。 */
    socket.on('disconnect', () => {
      leaveCurrentRoom(io, socket);
    });
  });
};
