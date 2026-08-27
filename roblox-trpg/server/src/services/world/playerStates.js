/**
 * 玩家状态：HP / 状态效果 / 位置 + 技能 / 物品 / 副本进度 查询。
 * 修改必须经过验证（数值范围、白名单字段）。
 */
const { getDb } = require('@roblox-trpg/database');
const { PLAYER_MAX_HP } = require('../../config');

/** 确保玩家有状态行（默认 10/10）。 */
function ensurePlayerState(playerRowId) {
  getDb()
    .prepare('INSERT OR IGNORE INTO player_states (player_id, hp, max_hp) VALUES (?, 10, 10)')
    .run(playerRowId);
}

/** 完整玩家状态（技能/物品/副本进度全部来自数据库）。 */
function getPlayerState(playerRowId) {
  const db = getDb();
  ensurePlayerState(playerRowId);
  const s = db.prepare('SELECT * FROM player_states WHERE player_id = ?').get(playerRowId);

  const skills = db
    .prepare(
      `SELECT s.name, s.description, s.skill_type, s.rarity, ps.obtained_at,
              d.roblox_experience_name AS obtained_from
       FROM player_skills ps
       JOIN skills s ON s.id = ps.skill_id
       LEFT JOIN dungeons d ON d.id = ps.obtained_from_dungeon_id
       WHERE ps.player_id = ?`
    )
    .all(playerRowId);

  const items = db
    .prepare(
      `SELECT i.name, pi.quantity, pi.source, pi.reason
       FROM player_items pi JOIN items i ON i.id = pi.item_id
       WHERE pi.player_id = ?`
    )
    .all(playerRowId);

  const progress = db
    .prepare(
      `SELECT d.roblox_experience_name AS dungeon, p.status, p.completed_at
       FROM player_dungeon_progress p JOIN dungeons d ON d.id = p.dungeon_id
       WHERE p.player_id = ?`
    )
    .all(playerRowId);

  return {
    hp: s.hp,
    maxHp: s.max_hp,
    statusEffects: JSON.parse(s.status_effects || '[]'),
    location: s.location,
    skills,
    items,
    dungeonProgress: progress,
  };
}

/**
 * 修改玩家状态（白名单 + 范围验证）。
 * 允许字段：hp(0..max_hp)、add_status_effect、remove_status_effect、location。
 */
function modifyPlayerState(playerRowId, field, value) {
  const db = getDb();
  ensurePlayerState(playerRowId);
  const s = db.prepare('SELECT * FROM player_states WHERE player_id = ?').get(playerRowId);
  const before = { hp: s.hp, status_effects: JSON.parse(s.status_effects || '[]'), location: s.location };

  if (field === 'hp') {
    const hp = Number(value);
    if (!Number.isInteger(hp) || hp < 0 || hp > Math.min(s.max_hp, PLAYER_MAX_HP)) {
      const err = new Error(`HP 必须在 0..${Math.min(s.max_hp, PLAYER_MAX_HP)} 之间`);
      err.kind = 'invalid_args';
      throw err;
    }
    db.prepare("UPDATE player_states SET hp = ?, updated_at = datetime('now') WHERE player_id = ?").run(hp, playerRowId);
  } else if (field === 'add_status_effect') {
    const eff = String(value || '').trim().slice(0, 40);
    if (!eff) throw Object.assign(new Error('状态效果不能为空'), { kind: 'invalid_args' });
    const arr = JSON.parse(s.status_effects || '[]');
    if (!arr.includes(eff)) arr.push(eff);
    db.prepare("UPDATE player_states SET status_effects = ?, updated_at = datetime('now') WHERE player_id = ?").run(
      JSON.stringify(arr),
      playerRowId
    );
  } else if (field === 'remove_status_effect') {
    const arr = JSON.parse(s.status_effects || '[]').filter((e) => e !== String(value));
    db.prepare("UPDATE player_states SET status_effects = ?, updated_at = datetime('now') WHERE player_id = ?").run(
      JSON.stringify(arr),
      playerRowId
    );
  } else if (field === 'location') {
    const loc = String(value || '').trim().slice(0, 60);
    if (!loc) throw Object.assign(new Error('位置不能为空'), { kind: 'invalid_args' });
    db.prepare("UPDATE player_states SET location = ?, updated_at = datetime('now') WHERE player_id = ?").run(loc, playerRowId);
  } else {
    const err = new Error(`玩家状态字段 "${field}" 不可修改（白名单：hp / add_status_effect / remove_status_effect / location）`);
    err.kind = 'forbidden_field';
    throw err;
  }

  return { before, after: getPlayerState(playerRowId) };
}

/** 玩家是否拥有指定技能（按名称或ID）。 */
function playerHasSkill(playerRowId, skillRef) {
  const db = getDb();
  if (/^\d+$/.test(String(skillRef))) {
    return Boolean(
      db.prepare('SELECT 1 FROM player_skills WHERE player_id = ? AND skill_id = ?').get(playerRowId, Number(skillRef))
    );
  }
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM player_skills ps JOIN skills s ON s.id = ps.skill_id
         WHERE ps.player_id = ? AND s.name = ?`
      )
      .get(playerRowId, String(skillRef))
  );
}

/** 查找技能行（按名称或ID，仅 approved）。 */
function findApprovedSkill(skillRef) {
  const db = getDb();
  if (/^\d+$/.test(String(skillRef))) {
    return db.prepare("SELECT * FROM skills WHERE id = ? AND status = 'approved'").get(Number(skillRef));
  }
  return db.prepare("SELECT * FROM skills WHERE name = ? AND status = 'approved'").get(String(skillRef));
}

module.exports = { ensurePlayerState, getPlayerState, modifyPlayerState, playerHasSkill, findApprovedSkill };
