/** complete_dungeon：标记房间副本通关（之后 grant_skill 才可结算）。 */
const { register, ToolError } = require('./index');
const { getDb } = require('@roblox-trpg/database');
const worldState = require('../../world/worldState');

register({
  name: 'complete_dungeon',
  description: '宣布当前副本通关：服务器将房间内全体玩家标记为已通关并解锁奖励结算。仅在剧情上确实达成通关目标时调用。',
  permission: 'mutate',
  inputSchema: { type: 'object', properties: { summary: { type: 'string', maxLength: 200, description: '通关摘要' } } },
  execute(ctx, args) {
    const cd = ctx.room.currentDungeon;
    if (!cd) throw new ToolError('房间未绑定副本，无法通关', 'forbidden');

    const db = getDb();
    const completed = [];
    for (const p of ctx.room.players) {
      const row = db.prepare('SELECT * FROM players WHERE socket_id = ?').get(p.socketId);
      if (!row) continue;
      db.prepare(
        `INSERT INTO player_dungeon_progress (player_id, dungeon_id, status, completed_at)
         VALUES (?, ?, 'completed', datetime('now'))
         ON CONFLICT(player_id, dungeon_id) DO UPDATE SET status = 'completed', completed_at = datetime('now')`
      ).run(row.id, cd.dungeonId);
      completed.push(p.name);
    }

    try {
      worldState.setWorldField(ctx.room.id, 'dungeon_completed', true, {
        actor: ctx.playerUid || 'ai_tool',
        action: 'complete_dungeon',
      });
    } catch {
      /* 版本冲突不影响通关登记 */
    }

    worldState.appendEvent(ctx.room.id, ctx.playerUid || 'ai_tool', 'complete_dungeon', null, { dungeon: cd.name, players: completed }, 'rule_engine');
    ctx.broadcast && ctx.broadcast('dungeon:completed', { dungeon: cd.name, players: completed, summary: args.summary || '', at: new Date().toISOString() });

    return { ok: true, dungeon: cd.name, completedPlayers: completed, note: '现在可以调用 grant_skill 结算技能奖励。' };
  },
});
