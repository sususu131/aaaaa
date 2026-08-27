/**
 * Reward Engine（阶段5）：副本通关结算。
 * 复用阶段3 Reward Validation Chain：奖励只能来自数据库（approved），
 * AI 候选只有匹配到已审核条目才可能发放；reward_grants 唯一约束保证幂等。
 */
const crypto = require('crypto');
const { getDb } = require('@roblox-trpg/database');
const im = require('./instanceManager');
const characterService = require('../character/characterService');
const leveling = require('../character/leveling');

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
          const itemRow = db.prepare('SELECT * FROM items WHERE id = ?').get(r.reward_id);
          const grantRes = characterService.grantItem(playerRowId, r.reward_id, {
            sourceType: 'DUNGEON_REWARD',
            sourceId: `instance:${instance.uid}`,
          });
          if (grantRes.granted === 'REJECTED') {
            skipped.push({ player: player.name, reward: key, reason: grantRes.reason });
            continue;
          }
          grants.push({ player: player.name, rewardKey: key, type: itemRow && ['weapon', 'armor', 'accessory'].includes(itemRow.kind) ? 'EQUIPMENT' : 'ITEM', name: r.item_name });
          io.to(instance.room_id).emit('item:gained', { playerName: player.name, itemName: r.item_name, quantity: 1, at: new Date().toISOString() });
        } else if (r.reward_type === 'currency') {
          // 货币奖励：数量来自 condition_data（服务器读取，AI 不可指定）
          let amount = 100;
          try {
            amount = Math.max(1, Math.min(99999, Number((r.condition_data ? JSON.parse(r.condition_data) : {}).amount) || 100));
          } catch { /* 非法 JSON 用默认 */ }
          const curRes = characterService.grantCurrency(playerRowId, r.reward_id, amount, {
            sourceType: 'DUNGEON_REWARD',
            sourceId: `instance:${instance.uid}`,
          });
          const curName = db.prepare('SELECT name FROM currencies WHERE id = ?').get(r.reward_id);
          grants.push({ player: player.name, rewardKey: key, type: 'CURRENCY', name: curName ? curName.name : '货币', amount });
          io.to(instance.room_id).emit('currency:gained', { playerName: player.name, currencyName: curName && curName.name, amount, at: new Date().toISOString() });
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
        const g = characterService.grantSkill(playerRowId, skillRow.id, {
          sourceType: 'DUNGEON_REWARD',
          sourceId: `instance:${instance.uid}`,
          obtainedFromDungeonId: dungeonRow ? dungeonRow.id : null,
        });
        if (g.granted === 'REJECTED') {
          skipped.push({ player: player.name, reward: key, reason: g.reason });
          db.prepare("UPDATE reward_grants SET status = 'SKIPPED' WHERE instance_id = ? AND player_id = ? AND reward_key = ?").run(instance.id, playerRowId, key);
          continue;
        }
        grants.push({ player: player.name, rewardKey: key, type: 'SKILL', name: skillRow.name, note: g.granted });
        io.to(instance.room_id).emit('skill:gained', { playerName: player.name, skillName: skillRow.name, dungeon: definition.dungeon?.display_name || '', at: new Date().toISOString() });
      } else if (itemRow) {
        const grantRes = characterService.grantItem(playerRowId, itemRow.id, {
          sourceType: 'DUNGEON_REWARD',
          sourceId: `instance:${instance.uid}`,
        });
        if (grantRes.granted === 'REJECTED') {
          skipped.push({ player: player.name, reward: key, reason: grantRes.reason });
          db.prepare("UPDATE reward_grants SET status = 'SKIPPED' WHERE instance_id = ? AND player_id = ? AND reward_key = ?").run(instance.id, playerRowId, key);
          continue;
        }
        grants.push({ player: player.name, rewardKey: key, type: ['weapon', 'armor', 'accessory'].includes(itemRow.kind) ? 'EQUIPMENT' : 'ITEM', name: itemRow.name });
      }
    }

    // 阶段6：XP（服务器按难度计算，AI 不能指定）+ 角色回写规则
    const xp = leveling.dungeonCompletionXp(definition.dungeon?.difficulty, true);
    const xpRes = characterService.grantXp(playerRowId, xp, { sourceType: 'DUNGEON_COMPLETION', sourceId: `instance:${instance.uid}` });
    grants.push({ player: player.name, rewardKey: `xp:${xp}`, type: 'XP', amount: xp, levelUps: xpRes.events });
    for (const ev of xpRes.events) {
      im.logEvent(instance, 'LEVEL_UP', player.name, ev);
      io.to(instance.room_id).emit('character:levelUp', { playerName: player.name, ...ev });
    }

    // 死亡规则：副本内死亡只影响实例；结束时按快照恢复 HP（除非 PERMADEATH）
    const snapshot = characterService.getSnapshot(playerRowId, instance.id);
    const stNow = db.prepare('SELECT * FROM player_states WHERE player_id = ?').get(playerRowId);
    const diedInInstance = stNow && (stNow.hp <= 0 || JSON.parse(stNow.status_effects || '[]').includes('DOWNED'));
    const permadeath = definition.dungeon?.permadeath === true;
    if (diedInInstance && permadeath) {
      // 服务器规则验证的永久后果（仅当 Definition 明确声明）
      characterService.addStatModifier(playerRowId, 'CON', -1, { scope: 'PERMANENT', sourceType: 'PERMADEATH', sourceId: `instance:${instance.uid}` });
      characterService.revive(playerRowId, { hp: 1, sourceType: 'PERMADEATH', sourceId: `instance:${instance.uid}` });
      grants.push({ player: player.name, rewardKey: 'permadeath', type: 'SPECIAL', note: 'PERMADEATH：永久 CON-1' });
    } else if (snapshot) {
      // 恢复长期角色：HP 回快照值并清除 DOWNED；临时属性修正清除
      db.prepare("UPDATE player_states SET hp = ?, status_effects = ?, updated_at = datetime('now') WHERE player_id = ?").run(
        Math.max(1, snapshot.hp),
        JSON.stringify(JSON.parse(stNow.status_effects || '[]').filter((e) => e !== 'DOWNED')),
        playerRowId
      );
    }
    characterService.clearTemporaryModifiers(playerRowId, instance.id);
  }

  for (const g of grants) {
    im.logEvent(instance, 'REWARD', g.player, g);
  }
  io.to(instance.room_id).emit('instance:reward', { grants, skipped });
  return { grants, skipped };
}

module.exports = { settleCompletion };
