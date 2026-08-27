/**
 * NPC AI Tools（阶段9 第六节）。
 * AI 只能读取状态/请求类型化事件；关系/记忆/声望数值全部由服务器固定规则决定。
 * update_npc_plan 仅能写计划与情绪，绝不能改关系/记忆/阵营。
 */
const { register, ToolError } = require('./index');
const npcEngine = require('../../npcs/npcEngine');
const { getDb } = require('@roblox-trpg/database');

function resolveInstance(ctx, ref) {
  const inst = npcEngine.findNpcInstanceInRoom(ctx.room.id, ref); // Room Isolation：只查当前房间
  if (!inst) throw new ToolError('NPC 不在当前房间（或不存在）', 'not_found');
  return inst;
}

register({
  name: 'get_npc_status',
  description: '只读：获取 NPC 实例状态（身份/存活/情绪/目标/与玩家关系/公开记忆/当前计划）。隐藏记忆不返回。',
  permission: 'READ_ONLY',
  inputSchema: {
    type: 'object',
    properties: { npc: { type: 'string', required: true, maxLength: 64, description: 'NPC 名称/uid/实例ID' } },
  },
  execute(ctx, args) {
    const inst = resolveInstance(ctx, args.npc);
    const playerRow = getDb().prepare('SELECT id FROM players WHERE uid = ?').get(ctx.playerUid || '__none__');
    return { ok: true, ...npcEngine.publicNpcView(inst, { playerId: playerRow ? playerRow.id : null }) };
  },
});

register({
  name: 'talk_to_npc',
  description: '与 NPC 交流：服务器记录对话记忆（低重要度）并微调关系（+2，服务器固定值）。AI 负责生成对话内容，数值由服务器决定。',
  permission: 'GAME_ACTION',
  inputSchema: {
    type: 'object',
    properties: {
      npc: { type: 'string', required: true, maxLength: 64 },
      topic: { type: 'string', required: true, maxLength: 200, description: '对话主题/内容摘要' },
    },
  },
  execute(ctx, args) {
    const inst = resolveInstance(ctx, args.npc);
    const playerRow = getDb().prepare('SELECT id FROM players WHERE uid = ?').get(ctx.playerUid || '__none__');
    if (!playerRow) throw new ToolError('玩家不存在', 'not_found');
    const res = npcEngine.applyRelationshipEvent(ctx.io, {
      npcInstanceId: inst.id,
      playerId: playerRow.id,
      action: 'conversation',
      reason: String(args.topic).slice(0, 200),
    });
    return { ok: true, npcInstanceId: inst.id, relationship: res.relationship.value, mood: res.mood, success: true };
  },
});

register({
  name: 'inspect_npc_memory',
  description: '只读：查看 NPC 允许公开的记忆（隐藏记忆如背叛/高重要度记忆绝不返回）。',
  permission: 'READ_ONLY',
  inputSchema: {
    type: 'object',
    properties: { npc: { type: 'string', required: true, maxLength: 64 } },
  },
  execute(ctx, args) {
    const inst = resolveInstance(ctx, args.npc);
    const memories = npcEngine.getMemories(inst.npc_id, { publicOnly: true, limit: 10 });
    return { ok: true, memories: memories.map((m) => ({ type: m.memory_type, importance: m.importance, content: m.content })) };
  },
});

register({
  name: 'npc_relationship_event',
  description:
    '请求类型化关系事件（服务器按固定增量表执行，AI 不能指定数值）：' +
    'help(+10)/deceive(-20)/attack(-50)/betray(-60)/quest_complete(+15)。同时生成记忆与事件日志。',
  permission: 'GAME_ACTION',
  inputSchema: {
    type: 'object',
    properties: {
      npc: { type: 'string', required: true, maxLength: 64 },
      action: { type: 'string', required: true, enum: ['help', 'deceive', 'attack', 'betray', 'quest_complete'] },
      reason: { type: 'string', maxLength: 200 },
    },
  },
  execute(ctx, args) {
    const inst = resolveInstance(ctx, args.npc);
    const playerRow = getDb().prepare('SELECT id FROM players WHERE uid = ?').get(ctx.playerUid || '__none__');
    if (!playerRow) throw new ToolError('玩家不存在', 'not_found');
    try {
      const res = npcEngine.applyRelationshipEvent(ctx.io, {
        npcInstanceId: inst.id,
        playerId: playerRow.id,
        action: args.action,
        reason: String(args.reason || '').slice(0, 200),
      });
      return { ok: true, relationship: res.relationship.value, mood: res.mood, success: true };
    } catch (err) {
      return { ok: false, error: err.message, error_code: err.code, success: false };
    }
  },
});

register({
  name: 'update_npc_plan',
  description:
    '更新 NPC 当前计划与情绪（服务器验证：计划仅文本，情绪仅枚举）。' +
    '本工具绝不能修改关系/记忆/阵营声望——那些由类型化事件驱动。',
  permission: 'GAME_ACTION',
  inputSchema: {
    type: 'object',
    properties: {
      npc: { type: 'string', required: true, maxLength: 64 },
      plan: { type: 'string', required: true, maxLength: 300 },
      mood: { type: 'string', enum: ['neutral', 'friendly', 'afraid', 'hostile', 'grateful'] },
    },
  },
  execute(ctx, args) {
    const inst = resolveInstance(ctx, args.npc);
    const db = getDb();
    const planJson = JSON.stringify({ plan: String(args.plan).slice(0, 300), updatedAt: new Date().toISOString() });
    if (args.mood) {
      db.prepare('UPDATE npc_instances SET current_plan_json = ?, mood = ? WHERE id = ?').run(planJson, args.mood, inst.id);
    } else {
      db.prepare('UPDATE npc_instances SET current_plan_json = ? WHERE id = ?').run(planJson, inst.id);
    }
    // 服务器行为决策留痕（第八节：服务器决定行为，AI 只描述）
    db.prepare('INSERT INTO world_events (room_id, actor, action, before_state, after_state, source) VALUES (?, ?, ?, ?, ?, ?)').run(
      ctx.room.id,
      ctx.actingPlayerName || 'ai_gm',
      'NPC_PLAN_UPDATE',
      null,
      planJson,
      'npc_engine'
    );
    return { ok: true, npcInstanceId: inst.id, success: true };
  },
});

register({
  name: 'kill_npc',
  description: 'NPC 死亡（服务器验证后执行）：产生 NPC_DEAD 长期事件（可触发新任务/敌人/态度变化）。仅当剧情确凿时使用。',
  permission: 'GAME_ACTION',
  inputSchema: {
    type: 'object',
    properties: {
      npc: { type: 'string', required: true, maxLength: 64 },
      reason: { type: 'string', maxLength: 200 },
    },
  },
  execute(ctx, args) {
    const inst = resolveInstance(ctx, args.npc);
    const playerRow = getDb().prepare('SELECT id FROM players WHERE uid = ?').get(ctx.playerUid || '__none__');
    try {
      const res = npcEngine.killNpc(ctx.io, inst.id, { byPlayerId: playerRow ? playerRow.id : null, reason: String(args.reason || '').slice(0, 200) });
      return { ok: true, ...res, success: true };
    } catch (err) {
      return { ok: false, error: err.message, error_code: err.code, success: false };
    }
  },
});
