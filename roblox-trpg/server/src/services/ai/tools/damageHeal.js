/** damage_player / heal_player：GAME_ACTION，服务器全验证（目标/范围/状态）。 */
const { register, resolveRoomPlayer, ToolError } = require('./index');
const characterService = require('../../character/characterService');

register({
  name: 'damage_player',
  description: '对当前场景内的玩家造成伤害（服务器验证目标存在/存活/范围 1~50）。服务器计算，客户端与 AI 均不能伪造。',
  permission: 'GAME_ACTION',
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string', required: true, maxLength: 64 },
      amount: { type: 'integer', required: true, min: 1, max: 50 },
      reason: { type: 'string', maxLength: 120 },
    },
  },
  execute(ctx, args) {
    const target = resolveRoomPlayer(ctx, args.target); // 跨房间目标自动拒绝
    const r = characterService.changeHp(target.playerRowId, -args.amount, {
      sourceType: 'AI_TOOL',
      sourceId: args.reason || 'damage_player',
      action: 'damage',
    });
    ctx.broadcast && ctx.broadcast('player:stateChanged', { playerName: target.name, hp: r.hp, maxHp: r.maxHp, at: new Date().toISOString() });
    return { ok: true, target: target.name, damage: args.amount, hp: r.hp, downed: r.downed };
  },
});

register({
  name: 'heal_player',
  description: '治疗当前场景内的玩家（服务器验证目标存在/范围 1~50，不超过 max_hp）。',
  permission: 'GAME_ACTION',
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string', required: true, maxLength: 64 },
      amount: { type: 'integer', required: true, min: 1, max: 50 },
      reason: { type: 'string', maxLength: 120 },
    },
  },
  execute(ctx, args) {
    const target = resolveRoomPlayer(ctx, args.target);
    const r = characterService.changeHp(target.playerRowId, args.amount, {
      sourceType: 'AI_TOOL',
      sourceId: args.reason || 'heal_player',
      action: 'heal',
    });
    ctx.broadcast && ctx.broadcast('player:stateChanged', { playerName: target.name, hp: r.hp, maxHp: r.maxHp, at: new Date().toISOString() });
    return { ok: true, target: target.name, healed: args.amount, hp: r.hp };
  },
});
