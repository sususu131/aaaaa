/**
 * Damage Pipeline（阶段15 第二节）：统一伤害计算。
 * final = base × weaponMultiplier × skillMultiplier × statMultiplier × buffMultiplier × worldMultiplier × defendFactor
 * 所有伤害由服务器计算并输出 Damage Event 到 Event Bus；AI/客户端均不能直接指定最终数值。
 */
const DAMAGE_MAX = 999;

class DamageError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function clampDamage(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(DAMAGE_MAX, n));
}

/**
 * 计算最终伤害（返回数值与逐项分解，便于审计与叙事）。
 */
function computeDamage({ base = 1, weaponMultiplier = 1, skillMultiplier = 1, statMultiplier = 1, buffMultiplier = 1, worldMultiplier = 1, defendFactor = 1, flatBonus = 0 } = {}) {
  const parts = {
    base: Math.max(0, Number(base) || 0),
    flatBonus: Math.max(0, Number(flatBonus) || 0),
    weaponMultiplier: Math.max(0, Number(weaponMultiplier) || 0),
    skillMultiplier: Math.max(0, Number(skillMultiplier) || 0),
    statMultiplier: Math.max(0, Number(statMultiplier) || 0),
    buffMultiplier: Math.max(0, Number(buffMultiplier) || 0),
    worldMultiplier: Math.max(0, Number(worldMultiplier) || 0),
    defendFactor: Math.max(0, Math.min(1, Number(defendFactor) === 0 ? 1 : Number(defendFactor))),
  };
  const raw = (parts.base + parts.flatBonus) * parts.weaponMultiplier * parts.skillMultiplier * parts.statMultiplier * parts.buffMultiplier * parts.worldMultiplier * parts.defendFactor;
  return { final: clampDamage(raw), raw: Math.round(raw * 100) / 100, breakdown: parts };
}

/** 输出 Damage Event（Event Bus + 房间广播）。 */
function emitDamageEvent(io, roomId, { source, target, amount, kind = 'attack', breakdown = null, instanceId = null, actorPlayerId = null }) {
  try {
    const gameEvents = require('../quests/gameEvents');
    gameEvents.emit(io, roomId, {
      type: 'DAMAGE_DEALT',
      actor: source,
      actorPlayerId,
      data: { source, target, amount, kind, breakdown },
      instanceId,
    });
  } catch { /* 事件失败不阻塞战斗 */ }
  if (io && roomId) io.to(roomId).emit('combat:damage', { source, target, amount, kind, at: new Date().toISOString() });
}

module.exports = { DamageError, DAMAGE_MAX, computeDamage, emitDamageEvent, clampDamage };
