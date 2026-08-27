/**
 * Dice Engine（唯一骰子实现，阶段3 提取，供 Tool 与 Dungeon Runtime 复用）。
 * 骰子只能由服务器生成；客户端与 AI 均不得指定结果。
 */
const crypto = require('crypto');
const { getDb } = require('@roblox-trpg/database');

/** 掷骰并落库审计。返回 { sides, count, rolls, total }。 */
function roll(roomId, { playerRowId = null, sides = 20, count = 1, kind = 'roll' } = {}) {
  const s = Math.max(2, Math.min(100, Number(sides) || 20));
  const c = Math.max(1, Math.min(10, Number(count) || 1));
  const rolls = Array.from({ length: c }, () => crypto.randomInt(1, s + 1));
  const total = rolls.reduce((a, b) => a + b, 0);
  const data = { sides: s, count: c, rolls, total };
  try {
    getDb()
      .prepare('INSERT INTO dice_rolls (room_id, player_id, kind, data) VALUES (?, ?, ?, ?)')
      .run(roomId, playerRowId, kind, JSON.stringify(data));
  } catch {
    /* 审计失败不影响结果 */
  }
  return data;
}

/**
 * 双骰拼点（战斗用）：双方各掷 2 颗骰求和比较。
 * 返回 { playerRolls, playerTotal, enemyRolls, enemyTotal, success, draw, margin }。
 */
function opposedRoll(roomId, { playerRowId = null, playerBonus = 0, enemyBonus = 0 } = {}) {
  const p = roll(roomId, { playerRowId, sides: 20, count: 2, kind: 'combat_player' });
  const e = roll(roomId, { playerRowId: null, sides: 20, count: 2, kind: 'combat_enemy' });
  const playerTotal = p.total + playerBonus;
  const enemyTotal = e.total + enemyBonus;
  return {
    playerRolls: p.rolls,
    playerTotal,
    enemyRolls: e.rolls,
    enemyTotal,
    success: playerTotal > enemyTotal,
    draw: playerTotal === enemyTotal,
    margin: playerTotal - enemyTotal,
  };
}

module.exports = { roll, opposedRoll };
