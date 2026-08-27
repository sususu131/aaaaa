/**
 * grant_skill（阶段3 第七节核心）：技能完全由数据库决定。
 * 服务器验证链：绑定副本 → 已通关 → 奖励表（approved）→ 防重复 →
 * drop_rate 服务器随机 / is_guaranteed → 写 player_skills → 广播。
 * AI 不选择技能、不创造技能、不跳过验证。
 */
const crypto = require('crypto');
const { register, resolveRoomPlayer, ToolError } = require('./index');
const { getDb } = require('@roblox-trpg/database');
const worldState = require('../../world/worldState');

register({
  name: 'grant_skill',
  description:
    '为玩家结算副本技能奖励（数据库驱动）。服务器验证：房间已绑定副本、该玩家已通关、奖励表已审核、未重复领取，' +
    '并按 drop_rate（服务器随机）或 is_guaranteed 决定掉落。AI 不能指定技能名、不能跳过验证。',
  permission: 'mutate',
  inputSchema: {
    type: 'object',
    properties: {
      playerId: { type: 'string', required: true, maxLength: 64 },
    },
  },
  execute(ctx, args) {
    const db = getDb();
    const target = resolveRoomPlayer(ctx, args.playerId);

    const cd = ctx.room.currentDungeon;
    if (!cd) throw new ToolError('房间未绑定副本，无法发放技能', 'forbidden');

    const progress = db
      .prepare('SELECT * FROM player_dungeon_progress WHERE player_id = ? AND dungeon_id = ?')
      .get(target.playerRowId, cd.dungeonId);
    if (!progress || progress.status !== 'completed') {
      throw new ToolError(`玩家 ${target.name} 尚未通关副本「${cd.name}」，不能领取技能（禁止跳步）`, 'forbidden');
    }

    const rewards = db
      .prepare(
        `SELECT dr.*, s.name AS skill_name, s.description AS skill_desc
         FROM dungeon_rewards dr JOIN skills s ON s.id = dr.reward_id
         WHERE dr.dungeon_id = ? AND dr.reward_type = 'skill' AND dr.status = 'approved'`
      )
      .all(cd.dungeonId);
    if (!rewards.length) throw new ToolError('该副本暂无已审核的技能奖励', 'not_found');

    const granted = [];
    const skipped = [];
    for (const r of rewards) {
      const owned = db
        .prepare('SELECT 1 FROM player_skills WHERE player_id = ? AND skill_id = ?')
        .get(target.playerRowId, r.reward_id);
      if (owned) {
        skipped.push({ skill: r.skill_name, reason: '已领取过（防重复）' });
        continue;
      }
      const roll = crypto.randomInt(1, 10001) / 10000; // 服务器随机
      const hit = r.is_guaranteed ? true : roll <= r.drop_rate;
      if (!hit) {
        skipped.push({ skill: r.skill_name, reason: '未通过掉落概率（服务器随机）' });
        continue;
      }
      db.prepare('INSERT INTO player_skills (player_id, skill_id, obtained_from_dungeon_id) VALUES (?, ?, ?)').run(
        target.playerRowId,
        r.reward_id,
        cd.dungeonId
      );
      granted.push({ skill: r.skill_name, description: r.skill_desc, guaranteed: Boolean(r.is_guaranteed) });
    }

    if (!granted.length) {
      return { ok: true, granted: [], skipped, note: skipped.length ? '无可新发放的技能' : '未掉落' };
    }

    worldState.appendEvent(
      ctx.room.id,
      ctx.playerUid || 'ai_tool',
      'grant_skill',
      null,
      { to: target.name, skills: granted.map((g) => g.skill), dungeon: cd.name },
      'rule_engine'
    );
    for (const g of granted) {
      ctx.broadcast &&
        ctx.broadcast('skill:gained', { playerName: target.name, skillName: g.skill, dungeon: cd.name, at: new Date().toISOString() });
    }
    return { ok: true, playerName: target.name, granted, skipped };
  },
});
