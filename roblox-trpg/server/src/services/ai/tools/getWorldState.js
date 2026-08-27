/** get_world_state：只读。当前房间/场景/副本/世界变量/玩家列表/近期事件。 */
const { register } = require('./index');
const worldState = require('../../world/worldState');

register({
  name: 'get_world_state',
  description: '只读：获取当前房间的共享世界状态（版本号、白名单状态字段、玩家列表、近期世界事件、副本绑定）。',
  permission: 'read',
  inputSchema: { type: 'object', properties: {} },
  execute(ctx) {
    const world = worldState.getWorld(ctx.room.id);
    const dungeon = ctx.room.currentDungeon
      ? { dungeonId: ctx.room.currentDungeon.dungeonId, name: ctx.room.currentDungeon.name }
      : null;
    return {
      ok: true,
      roomId: ctx.room.id,
      worldVersion: world.version,
      state: world.state,
      currentDungeon: dungeon,
      players: ctx.room.players.map((p) => p.name),
      recentWorldEvents: worldState.recentEvents(ctx.room.id, 5).map((e) => ({
        actor: e.actor,
        action: e.action,
        after: JSON.parse(e.after_state || '{}'),
        at: e.created_at,
      })),
    };
  },
});
