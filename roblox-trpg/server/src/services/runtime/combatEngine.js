/**
 * Combat Engine（阶段5）：复用阶段3 Dice Engine（双骰拼点，服务器生成）。
 * Combat 状态乐观锁：同一战斗只有一个服务器写者，禁止最后写入覆盖。
 * 客户端只能请求攻击；不能提交骰子结果/HP/Enemy 数值。
 */
const { getDb } = require('@roblox-trpg/database');
const diceEngine = require('../world/diceEngine');
const playerStates = require('../world/playerStates');
const im = require('./instanceManager');

class CombatError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function activeCombat(instanceId) {
  return getDb()
    .prepare("SELECT * FROM instance_combats WHERE instance_id = ? AND status = 'ACTIVE' ORDER BY id DESC LIMIT 1")
    .get(instanceId);
}

/** 查找遭遇对象（普通遭遇或 Boss，均来自 Published Definition）。 */
function findEncounterTarget(definition, encounterId) {
  const enc = (definition.encounters || []).find((e) => e.id === encounterId);
  if (!enc) return null;
  const participants = (enc.participants || []).map((pid) => {
    const enemy = (definition.enemies || []).find((e) => e.id === pid);
    if (enemy) return { id: enemy.id, name: enemy.name, stats: enemy.stats || { hp: 10, damage: 2 }, isBoss: false };
    if (definition.boss && definition.boss.id === pid) {
      return { id: definition.boss.id, name: definition.boss.name, stats: definition.boss.stats || { hp: 50, damage: 5 }, isBoss: true };
    }
    return null;
  }).filter(Boolean);
  return { encounter: enc, participants };
}

/** 开始战斗（遭遇必须来自 Definition；AI 不能临时创造敌人）。 */
function startCombat(io, instance, definition, encounterId) {
  if (activeCombat(instance.id)) throw new CombatError('COMBAT_ACTIVE', '已有进行中的战斗');
  const target = findEncounterTarget(definition, encounterId);
  if (!target) throw new CombatError('UNKNOWN_ENCOUNTER', `遭遇 "${encounterId}" 不存在于副本定义`);
  if (!target.participants.length) throw new CombatError('NO_PARTICIPANTS', '遭遇缺少敌方单位');

  const db = getDb();
  const enemyStates = {};
  for (const p of target.participants) {
    enemyStates[p.id] = { hp: clampNum(p.stats.hp, 1, 1000), maxHp: clampNum(p.stats.hp, 1, 1000), damage: clampNum(p.stats.damage, 0, 500), isBoss: p.isBoss, name: p.name };
  }
  const party = im.partyOf(instance);
  const playerCombatStates = {};
  for (const pid of party) {
    playerCombatStates[pid] = { hp: playerStates.getPlayerState(pid).hp };
  }
  const info = db
    .prepare(
      `INSERT INTO instance_combats (instance_id, encounter_id, participants, enemy_states, player_states, boss_phase)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(instance.id, encounterId, JSON.stringify(party), JSON.stringify(enemyStates), JSON.stringify(playerCombatStates), 1);

  const combat = db.prepare('SELECT * FROM instance_combats WHERE id = ?').get(info.lastInsertRowid);
  im.logEvent(instance, 'COMBAT', 'server', { op: 'start', encounterId, enemies: Object.keys(enemyStates) });
  io.to(instance.room_id).emit('instance:combat', serialize(combat));
  return combat;
}

function clampNum(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** 属性修正（复用阶段3b 属性：超出 5 的部分转化为修正值）。 */
function attributeBonus(playerRowId) {
  const st = playerStates.getPlayerState(playerRowId);
  const attrs = st.attributes || {};
  const str = Number(attrs.STR || 5);
  return Math.floor((str - 5) / 2);
}

/** Boss 阶段由服务器状态决定（HP < 70% → Phase 2；< 40% → Phase 3）。 */
function bossPhaseFor(hp, maxHp) {
  const ratio = maxHp > 0 ? hp / maxHp : 0;
  if (ratio < 0.4) return 3;
  if (ratio < 0.7) return 2;
  return 1;
}

/**
 * 玩家攻击。双骰拼点：双方各 2d20 求和（服务器生成），大者成功。
 * rollOverride 仅服务端内部/测试可用，绝不接受客户端传入。
 */
function attack(io, instance, definition, combat, playerRowId, targetId, { rollOverride } = {}) {
  const db = getDb();
  const enemyStates = JSON.parse(combat.enemy_states);
  const enemy = enemyStates[targetId];
  if (!enemy) throw new CombatError('UNKNOWN_TARGET', `目标 "${targetId}" 不在战斗中`);
  if (enemy.hp <= 0) throw new CombatError('TARGET_DOWN', '目标已被击败');

  const rollResult =
    rollOverride ||
    diceEngine.opposedRoll(instance.room_id, {
      playerRowId,
      playerBonus: attributeBonus(playerRowId),
      enemyBonus: 0,
    });

  const events = [];
  let narrative;
  if (rollResult.success) {
    const dmg = Math.max(1, Math.min(99, rollResult.margin));
    enemy.hp = Math.max(0, enemy.hp - dmg);
    narrative = `对 ${enemy.name} 造成 ${dmg} 点伤害`;
    events.push({ op: 'damage_enemy', target: targetId, damage: dmg, enemyHp: enemy.hp });
  } else if (rollResult.draw) {
    narrative = '僵持（平局）';
    events.push({ op: 'draw' });
  } else {
    const dmg = clampNum(enemy.damage, 0, 500);
    const before = playerStates.getPlayerState(playerRowId);
    const newHp = Math.max(0, before.hp - dmg);
    playerStates.modifyPlayerState(playerRowId, 'hp', newHp);
    narrative = `${enemy.name} 反击，玩家受到 ${dmg} 点伤害`;
    events.push({ op: 'damage_player', damage: dmg, playerHp: newHp });
    if (newHp <= 0) {
      // DOWNED：不立即移出队伍
      try {
        playerStates.modifyPlayerState(playerRowId, 'add_status_effect', 'DOWNED');
      } catch { /* 已有则忽略 */ }
      events.push({ op: 'player_downed', playerRowId });
    }
  }

  // Boss 阶段（服务器决定）
  let bossPhase = combat.boss_phase;
  if (enemy.isBoss && enemy.hp > 0) {
    const ph = bossPhaseFor(enemy.hp, enemy.maxHp);
    if (ph !== bossPhase) {
      bossPhase = ph;
      events.push({ op: 'boss_phase', phase: ph });
    }
  }

  enemyStates[targetId] = enemy;

  // 乐观锁更新（同一战斗单写者）
  const upd = db
    .prepare(
      `UPDATE instance_combats SET enemy_states = ?, boss_phase = ?, turn = turn + 1, version = version + 1
       WHERE id = ? AND version = ?`
    )
    .run(JSON.stringify(enemyStates), bossPhase, combat.id, combat.version);
  if (upd.changes === 0) throw new CombatError('COMBAT_LOCK', '战斗状态版本冲突，请重试');

  // 战斗结束判定
  const allDead = Object.values(enemyStates).every((e) => e.hp <= 0);
  let finalStatus = 'ACTIVE';
  if (allDead) {
    db.prepare("UPDATE instance_combats SET status = 'RESOLVED' WHERE id = ?").run(combat.id);
    finalStatus = 'RESOLVED';
    events.push({ op: 'combat_resolved' });
  }

  im.logEvent(instance, 'COMBAT', `player#${playerRowId}`, {
    op: 'attack',
    target: targetId,
    roll: rollResult,
    events,
  });

  // 阶段8：敌人被击败事件（驱动 DEFEAT_ENEMY 任务目标）
  if (enemy.hp <= 0) {
    const gameEvents = require('../quests/gameEvents');
    const byPlayer = db.prepare('SELECT name FROM players WHERE id = ?').get(playerRowId);
    gameEvents.emit(io, instance.room_id, {
      type: 'ENEMY_DEFEATED',
      actor: byPlayer ? byPlayer.name : null,
      actorPlayerId: playerRowId,
      data: { enemy: targetId, enemyName: enemy.name, isBoss: Boolean(enemy.isBoss) },
      instanceId: instance.id,
    });
  }

  const updated = db.prepare('SELECT * FROM instance_combats WHERE id = ?').get(combat.id);
  io.to(instance.room_id).emit('instance:combat', { ...serialize(updated), lastRoll: rollResult, events });
  return { combat: updated, rollResult, events, narrative, resolved: finalStatus === 'RESOLVED' };
}

function serialize(combat) {
  return {
    id: combat.id,
    encounterId: combat.encounter_id,
    status: combat.status,
    round: combat.round,
    turn: combat.turn,
    bossPhase: combat.boss_phase,
    version: combat.version,
    enemyStates: JSON.parse(combat.enemy_states || '{}'),
  };
}

/** 全队是否都倒下（用于 FAILED 判定）。 */
function allPlayersDowned(instance) {
  const party = im.partyOf(instance);
  if (!party.length) return false;
  return party.every((pid) => {
    const st = playerStates.getPlayerState(pid);
    return st.hp <= 0 || st.statusEffects.includes('DOWNED');
  });
}

module.exports = { CombatError, activeCombat, startCombat, attack, serialize, allPlayersDowned, bossPhaseFor };
