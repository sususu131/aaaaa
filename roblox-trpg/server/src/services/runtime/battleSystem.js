/**
 * Battle System（阶段15 第一~四、六~七节）：正式回合制战斗核心。
 * 阶段流转：PLAYER_TURN →（全员行动）→ ENEMY_TURN → TEAM 结算 → VICTORY / DEFEAT。
 * 红线：所有伤害/治疗/状态由服务器计算（Damage Pipeline）；
 *      敌人行为必须来自副本定义的 Behavior Data（AI 不能临时创造敌人行为）；
 *      AI 只能叙事与建议，不能直接修改 HP/伤害/状态。
 */
const crypto = require('crypto');
const { getDb } = require('@roblox-trpg/database');
const diceEngine = require('../world/diceEngine');
const playerStates = require('../world/playerStates');
const damagePipeline = require('./damagePipeline');
const im = require('./instanceManager');

const PHASES = ['PLAYER_TURN', 'ENEMY_TURN', 'TEAM_ACTION', 'VICTORY', 'DEFEAT', 'FLED'];
const PLAYER_ACTIONS = ['ATTACK', 'SKILL', 'ITEM', 'DEFEND', 'FLEE', 'RESCUE'];
const ENEMY_ACTIONS = ['attack', 'skill', 'defend', 'special', 'chase', 'flee'];
// Boss 阶段阈值（第三节）：>70% Phase1，≤70% Phase2，≤30% Enrage（数据可覆盖）
const BOSS_THRESHOLDS = [70, 30];

class BattleError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const parseJson = (s, fallback) => {
  try {
    return JSON.parse(s || '') || fallback;
  } catch {
    return fallback;
  }
};

function getCombat(instanceId) {
  return getDb()
    .prepare("SELECT * FROM instance_combats WHERE instance_id = ? AND status = 'ACTIVE' ORDER BY id DESC LIMIT 1")
    .get(instanceId);
}

function saveCombat(combat, { enemyStates, phase, acted, defending, bossPhase, turnDelta = 0, versionBump = true } = {}) {
  const db = getDb();
  const upd = db
    .prepare(
      `UPDATE instance_combats SET enemy_states = ?, phase = ?, acted_json = ?, defending_json = ?, boss_phase = ?, turn = turn + ?, version = version + 1
       WHERE id = ? AND version = ?`
    )
    .run(
      JSON.stringify(enemyStates),
      phase || combat.phase,
      JSON.stringify(acted || []),
      JSON.stringify(defending || {}),
      bossPhase || combat.boss_phase,
      turnDelta,
      combat.id,
      combat.version
    );
  if (upd.changes === 0) throw new BattleError('COMBAT_LOCK', '战斗状态版本冲突，请重试', 409);
  return db.prepare('SELECT * FROM instance_combats WHERE id = ?').get(combat.id);
}

function experienceNameOf(instance) {
  try {
    const row = getDb()
      .prepare('SELECT d.roblox_experience_name AS name FROM dungeon_versions v JOIN dungeons d ON d.id = v.dungeon_id WHERE v.id = ?')
      .get(instance.dungeon_version_id);
    return row ? row.name : null;
  } catch {
    return null;
  }
}

function attributeBonus(playerRowId, attr = 'STR') {
  const st = playerStates.getPlayerState(playerRowId);
  const attrs = st.attributes || {};
  return Math.floor(((Number(attrs[attr]) || 5) - 5) / 2);
}

function isDowned(playerRowId) {
  const st = playerStates.getPlayerState(playerRowId);
  return (st.statusEffects || []).includes('DOWNED');
}

function partyOf(combat) {
  return parseJson(combat.participants, []).map(Number);
}

function alivePlayers(combat) {
  return partyOf(combat).filter((pid) => !isDowned(pid));
}

function enemyMeta(definition, enemyId) {
  const e = (definition.enemies || []).find((x) => x.id === enemyId);
  if (e) return { ...e, isBoss: false };
  if (definition.boss && definition.boss.id === enemyId) return { ...definition.boss, isBoss: true };
  return null;
}

/** 解析 Behavior Data（第三节：行为必须来自定义，禁止临时创造）。 */
function behaviorTokens(meta, enemyState, bossPhase) {
  if (meta && meta.isBoss) {
    if (bossPhase >= 3) return ['attack', 'skill', 'special'];
    if (bossPhase === 2) return ['attack', 'skill', 'attack', 'defend'];
    return ['attack', 'attack', 'defend'];
  }
  const raw = meta && typeof meta.behaviour === 'string' ? meta.behaviour : '';
  const tokens = raw.split('|').map((t) => t.trim().toLowerCase()).filter((t) => ENEMY_ACTIONS.includes(t));
  return tokens.length ? tokens : ['attack']; // 无行为数据时的固定默认（数据驱动，非 AI 创造）
}

/** 敌人脑：按行为数据加权选择（服务器随机，可注入）。 */
function pickEnemyAction(meta, enemyState, { bossPhase = 1, rng = null } = {}) {
  const tokens = behaviorTokens(meta, enemyState, bossPhase);
  const pick = rng !== null ? rng : crypto.randomInt(0, 100000) / 100000;
  return tokens[Math.floor(pick * tokens.length) % tokens.length];
}

function broadcastCombat(io, instance, combat) {
  if (io) io.to(instance.room_id).emit('instance:combat', combatView(instance, combat));
}

// ══ 玩家行动 ══
/**
 * 玩家回合行动（全部服务器结算）。
 * action: ATTACK / SKILL / ITEM / DEFEND / FLEE / RESCUE
 */
function performPlayerAction(io, instanceRaw, definition, combat, playerRowId, { action, targetId = null, skillName = null, itemKey = null, rollOverride = null, rng = null } = {}) {
  const db = getDb();
  const instance = im.getInstance(instanceRaw.id || instanceRaw.uid); // 始终读取最新实例状态
  if (!PLAYER_ACTIONS.includes(action)) throw new BattleError('UNKNOWN_ACTION', `非法行动 ${action}（允许：${PLAYER_ACTIONS.join('/')}）`);
  if (combat.status !== 'ACTIVE') throw new BattleError('COMBAT_OVER', '战斗已结束', 409);
  if (combat.phase !== 'PLAYER_TURN') throw new BattleError('NOT_PLAYER_TURN', `当前阶段 ${combat.phase}，不是玩家回合`, 409);
  if (!partyOf(combat).includes(playerRowId)) throw new BattleError('NOT_IN_PARTY', '你不是该战斗的队伍成员', 403);
  if (isDowned(playerRowId)) throw new BattleError('PLAYER_DOWNED', '你已倒地，等待队友救援', 409);
  const acted = parseJson(combat.acted_json, []);
  if (acted.includes(playerRowId)) throw new BattleError('ALREADY_ACTED', '本回合你已行动过', 409);

  const enemyStates = parseJson(combat.enemy_states, {});
  const defending = parseJson(combat.defending_json, {});
  const expName = experienceNameOf(instance);
  const events = [];
  let narrative = '';

  const livingEnemies = Object.entries(enemyStates).filter(([, e]) => e.hp > 0 && !e.fled);
  if (!livingEnemies.length) throw new BattleError('NO_ENEMIES', '战场上没有敌人', 409);

  if (action === 'ATTACK' || action === 'RESCUE' || action === 'SKILL') {
    // ── 需要目标的对抗行动 ──
    if (action === 'RESCUE') {
      const target = Number(targetId);
      if (!partyOf(combat).includes(target) || target === playerRowId) throw new BattleError('BAD_TARGET', '救援目标必须是倒地的队友');
      if (!isDowned(target)) throw new BattleError('NOT_DOWNED', '目标没有倒地');
      const roll = rollOverride || diceEngine.opposedRoll(instance.room_id, { playerRowId, playerBonus: attributeBonus(playerRowId, 'CON'), enemyBonus: 2 });
      if (roll.success) {
        const characterService = require('../character/characterService');
        const st = playerStates.getPlayerState(target);
        const reviveHp = Math.max(1, Math.floor(st.maxHp * 0.3));
        characterService.revive(target, { hp: reviveHp, sourceType: 'COMBAT_RESCUE', sourceId: `combat:${combat.id}` });
        narrative = '救援成功！队友苏醒过来。';
        events.push({ op: 'revive', target, hp: reviveHp });
      } else {
        narrative = '救援失败（挣扎中未能拉起队友）。';
        events.push({ op: 'revive_failed', target });
      }
      events.unshift({ op: 'rescue_roll', roll });
    } else {
      // ATTACK / SKILL 攻击
      const inventoryService = require('../inventory/inventoryService');
      const equip = inventoryService.equippedCombatStats(playerRowId, expName);
      let targetKey = targetId && enemyStates[targetId] ? String(targetId) : livingEnemies[0][0];
      const enemy = enemyStates[targetKey];
      if (enemy.hp <= 0 || enemy.fled) throw new BattleError('TARGET_DOWN', '目标已被击败', 409);

      // 技能准备（倍率/加成/冷却）
      let skillMultiplier = 1;
      let flatBonus = equip.weaponBonus;
      let rollBonus = attributeBonus(playerRowId);
      let usedSkill = null;
      if (action === 'SKILL') {
        const skillRow = db
          .prepare(
            `SELECT ps.*, s.name AS sname, s.cooldown_turns, s.max_uses, s.effect_data, s.skill_type FROM player_skills ps JOIN skills s ON s.id = ps.skill_id
             WHERE ps.player_id = ? AND s.name = ?`
          )
          .get(playerRowId, String(skillName || ''));
        if (!skillRow) throw new BattleError('SKILL_NOT_OWNED', `未持有技能「${skillName}」（AI 不能虚构技能）`, 404);
        if ((skillRow.cooldown_until_turn || 0) > combat.turn) throw new BattleError('SKILL_COOLDOWN', `技能「${skillRow.sname}」冷却中（还需 ${(skillRow.cooldown_until_turn || 0) - combat.turn} 回合）`, 409);
        if (skillRow.uses_remaining !== null && skillRow.uses_remaining <= 0) throw new BattleError('SKILL_NO_USES', `技能「${skillRow.sname}」次数已用完`, 409);
        const effects = parseJson(skillRow.effect_data, {}).effects || [];
        for (const eff of effects) {
          if (eff.type === 'DAMAGE') flatBonus += Math.max(0, Number(eff.value) || 0);
          if (eff.type === 'ROLL_MODIFIER') rollBonus += Math.max(0, Number(eff.value) || 0);
          if (eff.type === 'ADVANTAGE') rollBonus += 2;
        }
        skillMultiplier = 1; // 技能数值以 flatBonus/ROLL_MODIFIER 进入 Pipeline（数据驱动）
        usedSkill = skillRow;
      }

      const roll =
        rollOverride ||
        diceEngine.opposedRoll(instance.room_id, { playerRowId, playerBonus: rollBonus, enemyBonus: 0 });

      if (roll.success || roll.draw) {
        const variant = instance.variant_key || 'NORMAL';
        const worldMultiplier = variant === 'BLACKOUT' ? 0.9 : 1; // 世界规则（动态副本影响伤害）
        const dmgResult = damagePipeline.computeDamage({
          base: Math.max(1, roll.margin),
          flatBonus,
          skillMultiplier,
          worldMultiplier,
          defendFactor: enemy.defending ? 0.5 : 1,
        });
        const dmg = Math.max(roll.success ? 1 : 0, dmgResult.final);
        enemy.hp = Math.max(0, enemy.hp - dmg);
        enemyStates[targetKey] = enemy;
        damagePipeline.emitDamageEvent(io, instance.room_id, {
          source: `player#${playerRowId}`,
          target: enemy.name,
          amount: dmg,
          kind: action === 'SKILL' ? 'skill' : 'attack',
          breakdown: dmgResult.breakdown,
          instanceId: instance.id,
          actorPlayerId: playerRowId,
        });
        narrative = `对 ${enemy.name} 造成 ${dmg} 点伤害${usedSkill ? `（技能：${usedSkill.sname}）` : ''}${equip.weapon ? `，武器：${equip.weapon.name}${equip.weapon.multiplier < 1 ? `（世界规则削弱×${equip.weapon.multiplier}）` : ''}` : ''}${roll.draw ? '（平局，勉强命中）' : ''}`;
        events.push({ op: 'damage_enemy', target: targetKey, damage: dmg, enemyHp: enemy.hp, roll });
      } else {
        narrative = `攻击被 ${enemy.name} 化解了。`;
        events.push({ op: 'attack_missed', target: targetKey, roll });
      }

      // 技能消耗与冷却（服务器写）
      if (usedSkill) {
        const updates = { last_used_turn: combat.turn };
        if (usedSkill.cooldown_turns > 0) updates.cooldown_until_turn = combat.turn + usedSkill.cooldown_turns;
        if (usedSkill.uses_remaining !== null) updates.uses_remaining = usedSkill.uses_remaining - 1;
        db.prepare('UPDATE player_skills SET last_used_turn = ?, cooldown_until_turn = ?, uses_remaining = ? WHERE id = ?').run(
          updates.last_used_turn,
          updates.cooldown_until_turn || usedSkill.cooldown_until_turn || 0,
          updates.uses_remaining === undefined ? usedSkill.uses_remaining : updates.uses_remaining,
          usedSkill.id
        );
        events.push({ op: 'skill_used', skill: usedSkill.sname });
      }
    }
  } else if (action === 'ITEM') {
    const inventoryService = require('../inventory/inventoryService');
    const r = inventoryService.useItem(io, playerRowId, String(itemKey || ''));
    narrative = `使用了「${itemKey}」${r.effects.length ? '，生效了' : ''}`;
    events.push({ op: 'item_used', itemKey, effects: r.effects });
  } else if (action === 'DEFEND') {
    defending[playerRowId] = true;
    narrative = '你摆出防御姿态（本回合受到的伤害减半）。';
    events.push({ op: 'defend' });
  } else if (action === 'FLEE') {
    const roll = rollOverride || diceEngine.opposedRoll(instance.room_id, { playerRowId, playerBonus: attributeBonus(playerRowId, 'DEX'), enemyBonus: 1 });
    if (roll.success) {
      const cleared = saveCombat(combat, { enemyStates, phase: 'FLED', acted: [], defending: {}, turnDelta: 0 });
      db.prepare("UPDATE instance_combats SET status = 'RESOLVED' WHERE id = ?").run(combat.id);
      const gameEvents = require('../quests/gameEvents');
      gameEvents.emit(io, instance.room_id, { type: 'PLAYER_ESCAPED', actor: `player#${playerRowId}`, actorPlayerId: playerRowId, data: { encounterId: combat.encounter_id }, instanceId: instance.id });
      im.logEvent(instance, 'COMBAT', `player#${playerRowId}`, { op: 'flee_success', roll });
      broadcastCombat(io, instance, cleared);
      return { ok: true, action, fled: true, narrative: '你趁乱脱离了战斗！', events };
    }
    narrative = '逃跑失败！敌人挡住了去路。';
    events.push({ op: 'flee_failed', roll });
  }

  acted.push(playerRowId);
  im.logEvent(instance, 'COMBAT', `player#${playerRowId}`, { op: action.toLowerCase(), narrative, events });

  // ── 胜负与阶段推进 ──
  const allEnemiesDead = Object.values(enemyStates).every((e) => e.hp <= 0 || e.fled);
  if (allEnemiesDead) {
    const finished = saveCombat(combat, { enemyStates, phase: 'VICTORY', acted: [], defending: {} });
    const result = resolveVictory(io, instance, definition, finished, { rng });
    broadcastCombat(io, instance, getCombatFinal(instance.id) || finished);
    return { ok: true, action, narrative, events, victory: true, rewards: result };
  }

  const alive = alivePlayers(combat);
  const next = saveCombat(combat, { enemyStates, phase: 'PLAYER_TURN', acted, defending });
  let enemyResult = null;
  if (alive.length && alive.every((pid) => acted.includes(pid))) {
    enemyResult = enemyTurn(io, instance, definition, next, { rng });
  }
  broadcastCombat(io, instance, getCombat(instance.id) || next);
  return { ok: true, action, narrative, events, enemyTurn: enemyResult };
}

function getCombatFinal(instanceId) {
  return getDb().prepare('SELECT * FROM instance_combats WHERE instance_id = ? ORDER BY id DESC LIMIT 1').get(instanceId);
}

// ══ 敌人回合 ══
/**
 * 敌人回合：逐个敌人按 Behavior Data 行动（服务器随机；Boss 阶段变化）。
 */
function enemyTurn(io, instanceRaw, definition, combat, { rng = null } = {}) {
  const db = getDb();
  const instance = im.getInstance(instanceRaw.id || instanceRaw.uid);
  let enemyStates = parseJson(combat.enemy_states, {});
  let defending = parseJson(combat.defending_json, {});
  const events = [];
  const narratives = [];
  const variant = instance.variant_key || 'NORMAL';
  const worldMultiplier = variant === 'HARD' ? 1.2 : 1; // 困难版本：敌人更强

  let bossPhase = combat.boss_phase || 1;
  for (const [enemyId, enemy] of Object.entries(enemyStates)) {
    if (enemy.hp <= 0 || enemy.fled) continue;
    const meta = enemyMeta(definition, enemyId);
    enemy.defending = false; // 敌人的防御只持续一轮

    // Boss 阶段（阈值数据驱动：>70 P1，≤70 P2，≤30 ENRAGE）
    let enraged = false;
    if (meta && meta.isBoss) {
      const pct = (enemy.hp / enemy.maxHp) * 100;
      const thresholds = (meta.conditions && meta.conditions.phase_thresholds) || BOSS_THRESHOLDS;
      const newPhase = pct > thresholds[0] ? 1 : pct > thresholds[1] ? 2 : 3;
      if (newPhase > bossPhase) {
        bossPhase = newPhase;
        events.push({ op: 'boss_phase', enemy: enemyId, phase: bossPhase });
        if (bossPhase === 3) narratives.push(`${enemy.name} 进入狂暴（ENRAGE）！`);
      }
      enraged = bossPhase >= 3;
      enemy.enraged = enraged;
    }

    const action = pickEnemyAction(meta, enemy, { bossPhase, rng });
    const targets = alivePlayers(combat);
    if (!targets.length) break;

    if (action === 'defend') {
      enemy.defending = true;
      narratives.push(`${enemy.name} 蜷缩防御。`);
      events.push({ op: 'enemy_defend', enemy: enemyId });
    } else if (action === 'flee' && !(meta && meta.isBoss)) {
      enemy.fled = true;
      enemy.hp = 0;
      narratives.push(`${enemy.name} 逃走了。`);
      events.push({ op: 'enemy_flee', enemy: enemyId });
    } else {
      // attack / skill / special / chase
      const pickIdx = rng !== null ? Math.floor(rng * targets.length) % targets.length : crypto.randomInt(0, targets.length);
      const target = targets[pickIdx];
      let skillMultiplier = 1;
      let label = '攻击';
      if (action === 'skill' || action === 'special') {
        const skills = (meta && meta.skills) || [];
        if (skills.length) {
          const sk = skills[0];
          skillMultiplier = Math.max(1, Number(sk.multiplier) || 1);
          label = `技能「${sk.name}」`;
        }
        if (action === 'special') skillMultiplier = Math.max(skillMultiplier, 1.25);
      }
      const chaseBonus = action === 'chase' ? 1 : 0;
      const dmgResult = damagePipeline.computeDamage({
        base: enemy.damage + chaseBonus,
        skillMultiplier,
        buffMultiplier: enraged ? 1.5 : 1,
        worldMultiplier,
        defendFactor: defending[target] ? 0.5 : 1,
      });
      const st = playerStates.getPlayerState(target);
      const newHp = Math.max(0, Math.min(st.maxHp, st.hp - dmgResult.final));
      playerStates.modifyPlayerState(target, 'hp', newHp);
      damagePipeline.emitDamageEvent(io, instance.room_id, {
        source: enemy.name,
        target: `player#${target}`,
        amount: dmgResult.final,
        kind: action,
        breakdown: dmgResult.breakdown,
        instanceId: instance.id,
      });
      const byPlayer = db.prepare('SELECT name FROM players WHERE id = ?').get(target);
      narratives.push(`${enemy.name} 的${label}命中 ${byPlayer ? byPlayer.name : target}，造成 ${dmgResult.final} 点伤害${defending[target] ? '（防御减半）' : ''}。`);
      events.push({ op: 'enemy_attack', enemy: enemyId, action, target, damage: dmgResult.final, playerHp: newHp });
      if (newHp <= 0) {
        try {
          playerStates.modifyPlayerState(target, 'add_status_effect', 'DOWNED');
        } catch { /* ignore */ }
        const gameEvents = require('../quests/gameEvents');
        gameEvents.emit(io, instance.room_id, { type: 'PLAYER_DIED', actor: enemy.name, actorPlayerId: target, data: { downed: true, by: enemy.name }, instanceId: instance.id });
        narratives.push(`${byPlayer ? byPlayer.name : target} 倒下了！队友可以救援。`);
        events.push({ op: 'player_downed', playerRowId: target });
      }
    }
    enemyStates[enemyId] = enemy;
  }

  // ── 全队倒地 → DEFEAT ──
  if (!alivePlayers(combat).length) {
    const finished = saveCombat(combat, { enemyStates, phase: 'DEFEAT', acted: [], defending: {}, bossPhase, turnDelta: 1 });
    const result = resolveDefeat(io, instance, definition, finished);
    broadcastCombat(io, instance, finished);
    return { phase: 'DEFEAT', narratives, events, defeat: result };
  }

  const next = saveCombat(combat, { enemyStates, phase: 'PLAYER_TURN', acted: [], defending: {}, bossPhase, turnDelta: 1 });
  im.logEvent(instance, 'COMBAT', 'server', { op: 'enemy_turn', narratives, events });
  return { phase: 'PLAYER_TURN', narratives, events, combat: next };
}

// ══ 胜利结算（第六节：奖励循环；幂等）══
function resolveVictory(io, instance, definition, combat, { rng = null } = {}) {
  const db = getDb();
  db.prepare("UPDATE instance_combats SET status = 'RESOLVED' WHERE id = ?").run(combat.id);
  const party = partyOf(combat);
  const enemyStates = parseJson(combat.enemy_states, {});
  const encounter = (definition.encounters || []).find((e) => e.id === combat.encounter_id) || { difficulty: 1 };
  const hadBoss = Object.values(enemyStates).some((e) => e.isBoss);
  const rewardsPerPlayer = [];

  // 战利品汇总（敌人 loot 数据驱动）
  let currencyLoot = 0;
  const itemLoots = [];
  for (const [enemyId, e] of Object.entries(enemyStates)) {
    if (e.fled && e.hp > 0) continue; // 逃跑的敌人不掉奖励
    const meta = enemyMeta(definition, enemyId);
    for (const loot of (meta && meta.loot) || []) {
      if (loot.type === 'currency') currencyLoot += Math.max(0, Math.round(Number(loot.amount) || 0));
      if (loot.type === 'item') itemLoots.push({ item: loot.item, chance: loot.chance === undefined ? 1 : Number(loot.chance) });
    }
    const gameEvents = require('../quests/gameEvents');
    const killedBy = db.prepare('SELECT name FROM players WHERE id = ?').get(party[0] || 0);
    gameEvents.emit(io, instance.room_id, { type: 'ENEMY_DEFEATED', actor: killedBy ? killedBy.name : null, data: { enemy: enemyId, enemyName: e.name, isBoss: Boolean(e.isBoss) }, instanceId: instance.id });
  }

  const characterService = require('../character/characterService');
  const inventoryService = require('../inventory/inventoryService');
  const leveling = require('../character/leveling');
  const gold = db.prepare("SELECT * FROM currencies WHERE name = '金币'").get();

  for (const pid of party) {
    const grants = [];
    const grantOnce = (key, fn) => {
      const ins = db
        .prepare('INSERT OR IGNORE INTO reward_grants (grant_uid, instance_id, player_id, reward_key, reward_type, status) VALUES (?, ?, ?, ?, ?, ?)')
        .run(`cg_${crypto.randomBytes(4).toString('hex')}`, instance.id, pid, key, 'COMBAT', 'GRANTED');
      if (ins.changes === 0) return { skipped: 'ALREADY_GRANTED', key };
      return fn();
    };
    // XP（服务器公式）
    const xp = leveling.XP_PER_ACTION * 3 + (Number(encounter.difficulty) || 1) * 10 * (hadBoss ? 2 : 1);
    const xpR = grantOnce(`combat:${combat.id}:xp`, () => characterService.grantXp(pid, xp, { sourceType: 'COMBAT', sourceId: `combat:${combat.id}` }));
    grants.push({ type: 'XP', amount: xpR.xpGained !== undefined ? xpR.xpGained : xp, levelsGained: xpR.levelsGained || 0, skipped: xpR.skipped || null });
    if (xpR.levelsGained > 0) applyGrowth(pid, xpR.levelsGained);
    // 金币
    if (currencyLoot > 0 && gold) {
      const curR = grantOnce(`combat:${combat.id}:gold`, () => characterService.grantCurrency(pid, gold.id, currencyLoot, { sourceType: 'COMBAT', sourceId: `combat:${combat.id}` }));
      grants.push({ type: 'CURRENCY', name: '金币', amount: currencyLoot, skipped: curR.skipped || null });
    }
    // 物品掉落（服务器掷概率）
    for (const loot of itemLoots) {
      const roll = rng !== null ? rng : crypto.randomInt(0, 100000) / 100000;
      if (roll > loot.chance) continue;
      const legacy = db.prepare("SELECT * FROM items WHERE name = ? AND status = 'approved'").get(loot.item);
      if (!legacy) continue; // 未审核物品绝不发放
      const itemR = grantOnce(`combat:${combat.id}:item:${loot.item}`, () => {
        const def = inventoryService.syncDefinitionFromLegacyItem(legacy);
        return inventoryService.addItem(io, pid, def.item_key, { amount: 1, sourceType: 'COMBAT_LOOT', sourceId: `combat:${combat.id}`, grantKey: `combat_loot:${combat.id}:${pid}:${def.item_key}` });
      });
      grants.push({ type: 'ITEM', name: loot.item, skipped: itemR.skipped || null });
    }
    rewardsPerPlayer.push({ playerId: pid, grants });
  }

  im.logEvent(instance, 'COMBAT', 'server', { op: 'victory', encounterId: combat.encounter_id, rewardsPerPlayer });
  if (io) io.to(instance.room_id).emit('combat:rewards', { encounterId: combat.encounter_id, rewards: rewardsPerPlayer, at: new Date().toISOString() });
  return { victory: true, rewards: rewardsPerPlayer };
}

/** 升级成长（第七节）：属性点 + 能力上限提升 + 快照留档。 */
function applyGrowth(playerRowId, levelsGained) {
  const db = getDb();
  const characterService = require('../character/characterService');
  try {
    characterService.addStatModifier(playerRowId, 'STR', levelsGained, { scope: 'PERMANENT', sourceType: 'LEVEL_UP', sourceId: `level:${levelsGained}` });
    characterService.addStatModifier(playerRowId, 'CON', levelsGained, { scope: 'PERMANENT', sourceType: 'LEVEL_UP', sourceId: `level:${levelsGained}` });
    const st = db.prepare('SELECT * FROM player_states WHERE player_id = ?').get(playerRowId);
    if (st) {
      const newMax = Math.min(999, st.max_hp + levelsGained * 5);
      db.prepare("UPDATE player_states SET max_hp = ?, hp = MIN(hp + ?, max_hp), updated_at = datetime('now') WHERE player_id = ?").run(newMax, levelsGained * 5, playerRowId);
    }
    characterService.audit(playerRowId, 'STAT', 'level_up_growth', 'LEVEL_UP', null, null, `STR/CON+${levelsGained}, MaxHP+${levelsGained * 5}`);
  } catch { /* 成长结算失败不阻塞战斗结算 */ }
}

// ══ 失败结算（第四节：保留角色与永久物品）══
function resolveDefeat(io, instance, definition, combat) {
  const db = getDb();
  db.prepare("UPDATE instance_combats SET status = 'RESOLVED' WHERE id = ?").run(combat.id);
  db.prepare("UPDATE dungeon_instances SET status = 'FAILED', ended_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(instance.id);
  im.logEvent(instance, 'FAILED', 'server', { reason: '全队倒地', encounterId: combat.encounter_id });
  const gameEvents = require('../quests/gameEvents');
  gameEvents.emit(io, instance.room_id, { type: 'DUNGEON_FAILED', actor: 'server', data: { reason: '全队倒地', instanceUid: instance.uid, note: '角色与永久物品已保留' }, instanceId: instance.id });
  if (io) io.to(instance.room_id).emit('instance:defeat', { instanceUid: instance.uid, reason: '全队倒地', retained: '角色进度与永久物品已保留', at: new Date().toISOString() });
  return { defeat: true, retained: ['character', 'permanent_items'], instanceStatus: 'FAILED' };
}

// ══ 遭遇启动（服务器验证：遭遇必须来自定义且在当前场景）══
function startEncounter(io, instanceRaw, definition, encounterId) {
  const instance = im.getInstance(instanceRaw.id || instanceRaw.uid);
  const scene = (definition.scenes || []).find((s) => s.id === instance.current_scene_id);
  if (!scene || !(scene.encounters || []).includes(encounterId)) {
    throw new BattleError('ENCOUNTER_NOT_IN_SCENE', '该遭遇不属于当前场景', 409);
  }
  const combatEngine = require('./combatEngine');
  const combat = combatEngine.startCombat(io, instance, definition, encounterId);
  getDb().prepare("UPDATE instance_combats SET phase = 'PLAYER_TURN', acted_json = '[]', defending_json = '{}' WHERE id = ?").run(combat.id);
  im.logEvent(instance, 'COMBAT', 'server', { op: 'encounter_start', encounterId });
  broadcastCombat(io, instance, getCombatFinal(instance.id));
  return getCombatFinal(instance.id);
}

// ══ 战斗视图（UI / COMBAT_CONTEXT 共用）══
function combatView(instance, combat = null) {
  const db = getDb();
  const c = combat || getCombat(instance.id) || getCombatFinal(instance.id);
  if (!c) return null;
  const definition = im.getDefinition(instance).definition;
  const enemyStates = parseJson(c.enemy_states, {});
  const defending = parseJson(c.defending_json, {});
  const acted = parseJson(c.acted_json, []);
  const enemies = Object.entries(enemyStates).map(([id, e]) => {
    const meta = enemyMeta(definition, id);
    return {
      id,
      name: e.name,
      hp: e.hp,
      maxHp: e.maxHp,
      isBoss: Boolean(e.isBoss),
      enraged: Boolean(e.enraged),
      defending: Boolean(e.defending),
      fled: Boolean(e.fled),
      behaviour: meta ? meta.behaviour || (meta.isBoss ? 'boss' : '') : '',
      skills: meta ? (meta.skills || []).map((s) => s.name) : [],
    };
  });
  const players = partyOf(c).map((pid) => {
    const row = db.prepare('SELECT name, uid FROM players WHERE id = ?').get(pid);
    const st = playerStates.getPlayerState(pid);
    const skills = db
      .prepare('SELECT s.name, s.cooldown_turns, ps.cooldown_until_turn, ps.uses_remaining FROM player_skills ps JOIN skills s ON s.id = ps.skill_id WHERE ps.player_id = ?')
      .all(pid)
      .map((s) => ({ name: s.name, cooldownLeft: Math.max(0, (s.cooldown_until_turn || 0) - c.turn), usesRemaining: s.uses_remaining }));
    return {
      playerId: pid,
      name: row ? row.name : `#${pid}`,
      hp: st.hp,
      maxHp: st.maxHp,
      downed: (st.statusEffects || []).includes('DOWNED'),
      defending: Boolean(defending[pid]),
      acted: acted.includes(pid),
      skills,
    };
  });
  return {
    combatId: c.id,
    encounterId: c.encounter_id,
    status: c.status,
    phase: c.phase,
    turn: c.turn,
    bossPhase: c.boss_phase,
    enemies,
    players,
    availableActions: PLAYER_ACTIONS,
  };
}

module.exports = {
  BattleError,
  PHASES,
  PLAYER_ACTIONS,
  ENEMY_ACTIONS,
  BOSS_THRESHOLDS,
  performPlayerAction,
  enemyTurn,
  pickEnemyAction,
  behaviorTokens,
  resolveVictory,
  resolveDefeat,
  startEncounter,
  combatView,
  getCombat,
  applyGrowth,
};
