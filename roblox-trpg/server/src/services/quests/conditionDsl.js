/**
 * Condition DSL（阶段8 第十九节）：声明式条件求值，绝不执行 JS/SQL。
 * 支持：stat_check / has_skill / has_item / has_equipment / quest_completed /
 *       world_state / dice_result / dungeon_state / player_count。
 */
const { getDb } = require('@roblox-trpg/database');
const characterService = require('../character/characterService');
const worldState = require('../world/worldState');

const OPERATORS = {
  '>=': (a, b) => Number(a) >= Number(b),
  '<=': (a, b) => Number(a) <= Number(b),
  '>': (a, b) => Number(a) > Number(b),
  '<': (a, b) => Number(a) < Number(b),
  '==': (a, b) => String(a) === String(b),
  '!=': (a, b) => String(a) !== String(b),
};

/**
 * 求值单个条件。ctx: { playerRowId, roomId }。
 * 非法条件一律返回 false（安全默认）。
 */
function evaluate(cond, ctx) {
  if (!cond || typeof cond !== 'object' || !cond.type) return false;
  try {
    const db = getDb();
    switch (cond.type) {
      case 'stat_check': {
        if (!ctx.playerRowId) return false;
        const { totals } = characterService.effectiveStats(ctx.playerRowId, {});
        const v = totals[String(cond.stat).toUpperCase()];
        const op = OPERATORS[cond.operator || '>='];
        return op ? op(v, cond.value) : false;
      }
      case 'has_skill': {
        if (!ctx.playerRowId) return false;
        const row = db
          .prepare('SELECT 1 FROM player_skills ps JOIN skills s ON s.id = ps.skill_id WHERE ps.player_id = ? AND (s.name = ? OR s.id = ?)')
          .get(ctx.playerRowId, String(cond.skill || cond.skill_id), Number(cond.skill_id) || -1);
        return Boolean(row);
      }
      case 'has_item': {
        if (!ctx.playerRowId) return false;
        const row = db
          .prepare('SELECT 1 FROM player_items pi JOIN items i ON i.id = pi.item_id WHERE pi.player_id = ? AND i.name = ?')
          .get(ctx.playerRowId, String(cond.item || cond.item_id));
        return Boolean(row);
      }
      case 'has_equipment': {
        if (!ctx.playerRowId) return false;
        const row = db
          .prepare('SELECT 1 FROM character_equipment ce JOIN items i ON i.id = ce.item_id WHERE ce.player_id = ? AND i.name = ?')
          .get(ctx.playerRowId, String(cond.item));
        return Boolean(row);
      }
      case 'quest_completed': {
        const row = db
          .prepare(
            `SELECT 1 FROM quest_instances qi JOIN quest_versions qv ON qv.id = qi.quest_version_id
             JOIN quests q ON q.id = qv.quest_id WHERE qi.room_id = ? AND q.uid = ? AND qi.status = 'COMPLETED'`
          )
          .get(ctx.roomId, String(cond.quest));
        return Boolean(row);
      }
      case 'world_state': {
        const w = worldState.getWorld(ctx.roomId);
        const v = w.state[cond.flag];
        if ('equals' in cond) return String(v) === String(cond.equals);
        const op = OPERATORS[cond.operator || '=='];
        return op ? op(v, cond.value) : false;
      }
      case 'dice_result': {
        const rows = db.prepare('SELECT data FROM dice_rolls WHERE room_id = ? ORDER BY id DESC LIMIT 1').all(ctx.roomId);
        if (!rows.length) return false;
        const d = JSON.parse(rows[0].data);
        const op = OPERATORS[cond.operator || '>='];
        return op ? op(d.total, cond.value) : false;
      }
      case 'dungeon_state': {
        const row = db.prepare('SELECT status FROM dungeon_instances WHERE room_id = ? ORDER BY id DESC LIMIT 1').get(ctx.roomId);
        return row ? String(row.status) === String(cond.status) : false;
      }
      case 'player_count': {
        const row = db.prepare('SELECT COUNT(*) c FROM players WHERE room_id = ? AND left_at IS NULL').get(ctx.roomId);
        const op = OPERATORS[cond.operator || '>='];
        return op ? op(row.c, cond.value) : false;
      }
      default:
        return false;
    }
  } catch {
    return false;
  }
}

/** AND 组合。 */
function evaluateAll(conds, ctx) {
  if (!Array.isArray(conds) || conds.length === 0) return true;
  return conds.every((c) => evaluate(c, ctx));
}

module.exports = { evaluate, evaluateAll, OPERATORS };
