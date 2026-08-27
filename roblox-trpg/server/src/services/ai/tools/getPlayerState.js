/** get_player_state：只读。只能读取当前房间内的玩家。 */
const { register, resolveRoomPlayer } = require('./index');
const playerStates = require('../../world/playerStates');

register({
  name: 'get_player_state',
  description: '只读：获取指定玩家的 HP/最大HP/状态效果/技能/物品/位置/副本进度。只能查询当前房间内的玩家（传玩家名字或 player_xxxx ID）。',
  permission: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      playerId: { type: 'string', required: true, maxLength: 64, description: '玩家名字或 player_xxxx ID' },
    },
  },
  execute(ctx, args) {
    const target = resolveRoomPlayer(ctx, args.playerId);
    return { ok: true, playerName: target.name, playerId: target.uid, ...playerStates.getPlayerState(target.playerRowId) };
  },
});
