/** get_dungeon_state：只读。当前副本的规则/阶段/进度；Roblox 数据为只读围栏。 */
const { register } = require('./index');
const { getDb } = require('@roblox-trpg/database');

register({
  name: 'get_dungeon_state',
  description: '只读：获取房间当前绑定的副本（名称/难度/规则/玩家进度/通关后可领取的奖励类型）。Roblox 官方资料属于 CANONICAL_FACT 只读围栏，不得修改。',
  permission: 'read',
  inputSchema: { type: 'object', properties: {} },
  execute(ctx) {
    const cd = ctx.room.currentDungeon;
    if (!cd) return { ok: false, error: '房间尚未绑定副本（玩家可先在副本面板选择）', kind: 'not_found' };

    const db = getDb();
    const dungeon = db.prepare('SELECT * FROM dungeons WHERE id = ?').get(cd.dungeonId);
    const rewards = db
      .prepare(
        `SELECT dr.reward_type, dr.is_guaranteed, s.name AS skill_name, i.name AS item_name
         FROM dungeon_rewards dr
         LEFT JOIN skills s ON dr.reward_type = 'skill' AND s.id = dr.reward_id
         LEFT JOIN items i ON dr.reward_type = 'item' AND i.id = dr.reward_id
         WHERE dr.dungeon_id = ? AND dr.status = 'approved'`
      )
      .all(cd.dungeonId);

    const progress = ctx.room.players.map((p) => {
      const row = db.prepare('SELECT * FROM players WHERE socket_id = ?').get(p.socketId);
      const pr = row
        ? db.prepare('SELECT status FROM player_dungeon_progress WHERE player_id = ? AND dungeon_id = ?').get(row.id, cd.dungeonId)
        : null;
      return { name: p.name, status: pr ? pr.status : 'active' };
    });

    return {
      ok: true,
      dungeonId: dungeon.id,
      name: dungeon.dungeon_name,
      robloxExperience: dungeon.roblox_experience_name,
      difficulty: dungeon.difficulty,
      description: dungeon.description,
      playerProgress: progress,
      availableRewardTypes: rewards.map((r) => ({
        type: r.reward_type,
        name: r.skill_name || r.item_name || null,
        guaranteed: Boolean(r.is_guaranteed),
      })),
      rules: [
        '双骰拼点：玩家1d20 对 难度1d20，大者成功，相等为特殊结果。',
        '通关后由服务器按奖励表发放技能/物品；AI 不得跳过验证直接宣布获得。',
      ],
      robloxNote: ctx.room.currentExperience
        ? '[只读围栏|CANONICAL_FACT] 本房间绑定了 Roblox 官方资料快照，可通过 get_roblox_experience 查看。'
        : '无 Roblox 资料快照（ROBLOX_DATA_UNAVAILABLE 时不得编造）。',
    };
  },
});
