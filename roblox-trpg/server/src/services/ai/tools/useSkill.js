/** use_skill：AI 请求使用技能（服务器验证拥有/冷却/次数/状态后执行声明式效果）。 */
const { register, resolveRoomPlayer } = require('./index');
const characterService = require('../../character/characterService');

register({
  name: 'use_skill',
  description: '请求玩家使用其已拥有的技能。服务器验证：拥有/状态/冷却/次数；效果声明式执行。AI 不能伪造技能。',
  permission: 'GAME_ACTION',
  inputSchema: {
    type: 'object',
    properties: {
      playerId: { type: 'string', required: true, maxLength: 64 },
      skill: { type: 'string', required: true, maxLength: 64 },
    },
  },
  execute(ctx, args) {
    const target = resolveRoomPlayer(ctx, args.playerId);
    const turn = ctx.instance
      ? require('@roblox-trpg/database').getDb().prepare('SELECT COUNT(*) c FROM instance_actions WHERE instance_id = ?').get(ctx.instance.id).c
      : 0;
    const res = characterService.useSkill(target.playerRowId, args.skill, {
      instanceId: ctx.instance ? ctx.instance.id : null,
      turn,
    });
    if (!res.ok) {
      return { ok: false, error: `技能使用被拒：${res.reason}`, error_code: res.reason, success: false };
    }
    ctx.broadcast && ctx.broadcast('skill:used', { playerName: target.name, skill: res.skillName, effects: res.effects.map((e) => e.type) });
    return { ok: true, player: target.name, skill: res.skillName, effects: res.effects, success: true };
  },
});
