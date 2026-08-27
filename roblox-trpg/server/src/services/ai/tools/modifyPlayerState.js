/** modify_player_state：白名单字段 + 数值范围验证（见 playerStates）。 */
const { register, resolveRoomPlayer } = require('./index');
const playerStates = require('../../world/playerStates');

register({
  name: 'modify_player_state',
  description:
    '修改房间内玩家状态。白名单字段：hp(0..最大HP)、add_status_effect、remove_status_effect、location。' +
    '禁止修改技能/物品/金币/身份（这些由专用验证工具处理）。',
  permission: 'mutate',
  inputSchema: {
    type: 'object',
    properties: {
      playerId: { type: 'string', required: true, maxLength: 64 },
      field: { type: 'string', required: true, enum: ['hp', 'add_status_effect', 'remove_status_effect', 'location'] },
      value: { type: 'string', required: true, maxLength: 60, description: 'hp传数字；状态效果/位置传文本' },
    },
  },
  execute(ctx, args) {
    const target = resolveRoomPlayer(ctx, args.playerId);
    const value = args.field === 'hp' ? Number(args.value) : args.value;
    const { before, after } = playerStates.modifyPlayerState(target.playerRowId, args.field, value);

    ctx.broadcast &&
      ctx.broadcast('player:stateChanged', {
        playerName: target.name,
        field: args.field,
        hp: after.hp,
        maxHp: after.maxHp,
        at: new Date().toISOString(),
      });

    return { ok: true, playerName: target.name, field: args.field, before, hp: after.hp, maxHp: after.maxHp };
  },
});
