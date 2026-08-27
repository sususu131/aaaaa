/** get_character：只读角色摘要（阶段6 数据；不发整个 Inventory）。 */
const { register, resolveRoomPlayer } = require('./index');
const characterService = require('../../character/characterService');

register({
  name: 'get_character',
  description: '只读：获取指定玩家的长期角色摘要（等级/XP/HP/属性/技能名/装备名）。不含完整背包。',
  permission: 'READ_ONLY',
  inputSchema: {
    type: 'object',
    properties: { playerId: { type: 'string', required: true, maxLength: 64 } },
  },
  execute(ctx, args) {
    const target = resolveRoomPlayer(ctx, args.playerId);
    const c = characterService.getCharacter(target.playerRowId);
    return {
      ok: true,
      playerName: c.displayName,
      level: c.level,
      xp: c.experience,
      hp: `${c.currentHp}/${c.maxHp}`,
      stats: c.stats,
      skills: c.skills.map((s) => `${s.name}Lv${s.level}`),
      equipment: c.equipment.map((e) => e.name),
      currencies: c.currencies.map((cur) => `${cur.name}×${cur.balance}`),
    };
  },
});
