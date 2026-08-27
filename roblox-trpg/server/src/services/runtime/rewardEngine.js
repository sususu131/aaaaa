/**
 * Reward Engine（阶段5）：副本通关结算。
 * 复用阶段3 Reward Validation Chain：奖励只能来自数据库（approved），
 * AI 候选只有匹配到已审核条目才可能发放；reward_grants 唯一约束保证幂等。
 */
const crypto = require('crypto');
const { getDb } = require('@roblox-trpg/database');
const im = require('./instanceManager');

/** 实例对应的 dungeon 行（经 universe 关联，用于查询 approved 奖励表）。 */
function dungeonRowFor(definition) {
  if (!definition.roblox_universe_id) return null;
  return getDb().prepare('SELECT * FROM dungeons WHERE roblox_universe_id = ?').get(definition.roblox_universe_id);
}

/**
 * 通关结算：为每名队员发放奖励（幂等）。
 * 返回 { grants: [...], skipped: [...] }。
 */
function settleCompletion(io, instance, definition) {
  const db = getDb();
  const party = im.partyOf(instance);
  const dungeonRow = dungeonRowFor(definition);
  const grants = [];
  const skipped = [];

  for (const playerRowId of party) {
    const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerRowId);
    if (!player) continue;

    // 1) 副本进度标记（阶段3 验证链的前置条件）
    if (dungeonRow) {
      db.prepare(
        `INSERT INTO player_dungeon_progress (player_id, dungeon_id, status, completed_at)
         VALUES (?, ?, 'completed', datetime('now'))
         ON CONFLICT(player_id, dungeon_id) DO UPDATE SET status = 'completed', completed_at = datetime('now')`
      ).run(playerRowId, dungeonRow.id);
    }

    // 2) 数据库奖励表（approved）——与阶段3 grant_skill 同一验证链
    if (dungeonRow) {
      const rewards = db
        .prepare(
          `SELECT dr.*, s.name AS skill_name, s.description AS skill_desc, i.name AS item_name
           FROM dungeon_rewards dr
           LEFT JOIN skills s ON dr.reward_type = 'skill' AND s.id = dr.reward_id
           LEFT JOIN items i ON dr.reward_type = 'item' AND i.id = dr.reward_id
           WHERE dr.dungeon_id = ? AND dr.status = 'approved'`
        )
        .all(dungeonRow.id);

      for (const r of rewards) {
        const key = r.reward_type === 'skill' ? `skill:${r.skill_name}` : `item:${r.item_name}`;
        const grantId = `grant_${crypto.randomBytes(4).toString('hex')}`;

        // 幂等唯一约束：同实例同玩家同奖励只能一次
        const ins = db
          .prepare(
            `INSERT OR IGNORE INTO reward_grants (grant_uid, instance_id, player_id, reward_key, reward_type, status)
             VALUES (?, ?, ?, ?, ?, 'GRANTED')`
          )
          .run(grantId, instance.id, playerRowId, key, r.reward_type.toUpperCase());
        if (ins.changes === 0) {
          skipped.push({ player: player.name, reward: key, reason: 'REWARD_ALREADY_GRANTED' });
          continue;
        }

        // 防重复 + drop_rate / is_guaranteed（服务器随机）
        if (r.reward_type === 'skill') {
          const owned = db.prepare('SELECT 1 FROM player_skills WHERE player_id = ? AND skill_id = ?').get(playerRowId, r.reward_id);
          if (owned) {
            skipped.push({ player: player.name, reward: key, reason: 'SKILL_ALREADY_OWNED' });
            continue;
          }
          const rollHit = r.is_guaranteed ? true : crypto.randomInt(1, 10001) / 10000 <= r.drop_rate;
          if (!rollHit) {
            skipped.push({ player: player.name, reward: key, reason: 'DROP_ROLL_MISS' });
            continue;
          }
          db.prepare('INSERT OR IGNORE INTO player_skills (player_id, skill_id, obtained_from_dungeon_id) VALUES (?, ?, ?)').run(
            playerRowId,
            r.reward_id,
            dungeonRow.id
          );
          grants.push({ player: player.name, rewardKey: key, type: 'SKILL', name: r.skill_name });
          io.to(instance.room_id).emit('skill:gained', { playerName: player.name, skillName: r.skill_name, dungeon: definition.dungeon?.display_name || '', at: new Date().toISOString() });
        } else if (r.reward_type === 'item') {
          db.prepare(
            `INSERT INTO player_items (player_id, item_id, quantity, source, reason) VALUES (?, ?, 1, ?, '副本通关')
             ON CONFLICT(player_id, item_id) DO UPDATE SET quantity = MIN(quantity + 1, 99)`
          ).run(playerRowId, r.reward_id, `instance:${instance.uid}`);
          grants.push({ player: player.name, rewardKey: key, type: 'ITEM', name: r.item_name });
          io.to(instance.room_id).emit('item:gained', { playerName: player.name, itemName: r.item_name, quantity: 1, at: new Date().toISOString() });
        }
      }
    }

    // 3) Definition 的 reward_candidates（AI 候选）：必须匹配到已审核条目才发放
    for (const cand of definition.reward_candidates || []) {
      const skillRow = db.prepare("SELECT * FROM skills WHERE name = ? AND status = 'approved'").get(cand.name);
      const itemRow = db.prepare("SELECT * FROM items WHERE name = ? AND status = 'approved'").get(cand.name);
      const key = `candidate:${cand.name}`;
      if (!skillRow && !itemRow) {
        skipped.push({ player: player.name, reward: key, reason: 'CANDIDATE_NOT_IN_DATABASE' });
        continue;
      }
      const ins = db
        .prepare(
          `INSERT OR IGNORE INTO reward_grants (grant_uid, instance_id, player_id, reward_key, reward_type, status)
           VALUES (?, ?, ?, ?, 'CANDIDATE', 'GRANTED')`
        )
        .run(`grant_${crypto.randomBytes(4).toString('hex')}`, instance.id, playerRowId, key);
      if (ins.changes === 0) {
        skipped.push({ player: player.name, reward: key, reason: 'REWARD_ALREADY_GRANTED' });
        continue;
      }
      if (skillRow) {
        db.prepare('INSERT OR IGNORE INTO player_skills (player_id, skill_id, obtained_from_dungeon_id) VALUES (?, ?, ?)').run(
          playerRowId,
          skillRow.id,
          dungeonRow ? dungeonRow.id : null
        );
        grants.push({ player: player.name, rewardKey: key, type: 'SKILL', name: skillRow.name });
        io.to(instance.room_id).emit('skill:gained', { playerName: player.name, skillName: skillRow.name, dungeon: definition.dungeon?.display_name || '', at: new Date().toISOString() });
      } else if (itemRow) {
        db.prepare(
          `INSERT INTO player_items (player_id, item_id, quantity, source, reason) VALUES (?, ?, 1, ?, '副本通关(候选)')
           ON CONFLICT(player_id, item_id) DO UPDATE SET quantity = MIN(quantity + 1, 99)`
        ).run(playerRowId, itemRow.id, `instance:${instance.uid}`);
        grants.push({ player: player.name, rewardKey: key, type: 'ITEM', name: itemRow.name });
      }
    }
  }

  for (const g of grants) {
    im.logEvent(instance, 'REWARD', g.player, g);
  }
  io.to(instance.room_id).emit('instance:reward', { grants, skipped });
  return { grants, skipped };
}

module.exports = { settleCompletion };
