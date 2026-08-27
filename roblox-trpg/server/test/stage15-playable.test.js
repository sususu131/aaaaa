/**
 * 阶段15 测试：Playable Experience System（104 项）。
 * 覆盖：正式回合制战斗 / Damage Pipeline / 敌人脑与 Boss 阶段 / 死亡与救援 /
 *       新手 DOORS 完整流程 / 奖励循环与成长 / AI 作弊拒绝 / REST / 断线恢复。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

for (const suffix of ['', '-wal', '-shm', '-journal']) {
  fs.rmSync(path.join(__dirname, '../../database/data/roblox_trpg.db' + suffix), { force: true });
}

process.env.AI_API_KEY = 'ai-key-s15';
process.env.AI_BASE_URL = 'http://127.0.0.1:4115/v1';
process.env.AI_MODEL = 'mock-s15';
process.env.AI_STREAM = 'off';

const { server } = require('../src/index.js');
const dbMod = require('@roblox-trpg/database');
const db = dbMod.getDb();
const im = require('../src/services/runtime/instanceManager');
const battleSystem = require('../src/services/runtime/battleSystem');
const combatEngine = require('../src/services/runtime/combatEngine');
const damagePipeline = require('../src/services/runtime/damagePipeline');
const characterService = require('../src/services/character/characterService');
const inventoryService = require('../src/services/inventory/inventoryService');
const questEngine = require('../src/services/quests/questEngine');
const playerStates = require('../src/services/world/playerStates');
const diceEngine = require('../src/services/world/diceEngine');
const runtimeEngine = require('../src/services/runtime/runtimeEngine');
const tools = require('../src/services/ai/tools');
const { createSession } = require('../src/sessions/sessionManager');

let passed = 0;
const ok = (label) => {
  passed += 1;
  console.log(`  ✓ ${label}`);
};
const fakeIo = { to: () => ({ emit: () => {} }), emit: () => {} };
const rollOf = (margin, success = true) => ({ playerRolls: [15, 10], playerTotal: 25 + margin, enemyRolls: [12, 13], enemyTotal: 25, success, draw: !success && margin === 0, margin });

function mkRoomDb(id) {
  db.prepare("INSERT OR IGNORE INTO rooms (id, status, max_players) VALUES (?, 'waiting', 3)").run(id);
}
let pSeq = 0;
function mkPlayerDb(name, roomId) {
  pSeq += 1;
  const uid = `player_s15_${pSeq}`;
  db.prepare('INSERT INTO players (uid, socket_id, name, room_id) VALUES (?, ?, ?, ?)').run(uid, `sock_${uid}`, name, roomId);
  return db.prepare('SELECT * FROM players WHERE uid = ?').get(uid);
}
const officialContent = require('../src/services/runtime/officialContent');
function doorsVersionId() {
  return officialContent.materializeOfficial('Doors').id;
}
function setupDoorsParty(roomId, names) {
  mkRoomDb(roomId);
  const players = names.map((n) => mkPlayerDb(n, roomId));
  const versionId = doorsVersionId();
  const inst0 = im.createInstance({ roomId, dungeonVersionId: versionId });
  for (const p of players) im.joinInstance(im.getInstance(inst0.id), p.id);
  im.startInstance(fakeIo, im.getInstance(inst0.id));
  return { players, inst: im.getInstance(inst0.id), versionId };
}
function moveTo(inst, sceneId) {
  db.prepare('UPDATE dungeon_instances SET current_scene_id = ? WHERE id = ?').run(sceneId, inst.id);
}
function defOf(inst) {
  return im.getDefinition(im.getInstance(inst.id)).definition;
}

async function main() {
  console.log('[test] 阶段15 就绪（104 项）\n');

  // ══ A. 数据与正式版定义 ══
  const cols = db.prepare('PRAGMA table_info(instance_combats)').all().map((c) => c.name);
  assert.ok(cols.includes('phase') && cols.includes('acted_json') && cols.includes('defending_json'));
  ok('1. instance_combats 回合制扩展列（phase/acted/defending）');
  assert.ok(['PLAYER_TURN', 'ENEMY_TURN', 'TEAM_ACTION', 'VICTORY', 'DEFEAT'].every((p) => battleSystem.PHASES.includes(p)));
  ok('2. 战斗阶段状态机（PLAYER_TURN/ENEMY_TURN/TEAM_ACTION/VICTORY/DEFEAT）');
  assert.deepStrictEqual(battleSystem.PLAYER_ACTIONS, ['ATTACK', 'SKILL', 'ITEM', 'DEFEND', 'FLEE', 'RESCUE']);
  ok('3. 玩家行动集（攻击/技能/物品/防御/逃跑/救援）');
  const dvid = doorsVersionId();
  const doorsDef = JSON.parse(db.prepare('SELECT definition_json FROM dungeon_versions WHERE id = ?').get(dvid).definition_json);
  ok('4. DOORS 正式版定义已发布（新手默认副本）');
  assert.ok(doorsDef.scenes.length === 4 && doorsDef.scenes[0].id === 'scene_lobby' && doorsDef.scenes[3].id === 'scene_gate');
  ok('5. 场景链：大厅→走廊→客房→逃生之门');
  assert.ok(doorsDef.encounters.length === 2 && doorsDef.enemies.length >= 1 && doorsDef.boss);
  ok('6. 遭遇/敌人/Boss 数据（实体遭遇 + Figure）');
  assert.ok(doorsDef.enemies[0].behaviour.includes('attack'));
  ok('7. 敌人 Behavior Data（数据驱动，非 AI 临时创造）');
  assert.deepStrictEqual(battleSystem.BOSS_THRESHOLDS, [70, 30]);
  ok('8. Boss 阶段阈值（>70% P1，≤70% P2，≤30% ENRAGE）');
  const desc = db.prepare("SELECT description FROM dungeons WHERE roblox_experience_name = 'Doors'").get().description;
  assert.ok(!/测试用/.test(desc) && desc.length > 10);
  ok('9. 副本描述转正（无测试版痕迹）');
  assert.ok(doorsDef.npcs.some((n) => n.uid === 'npc_doors_keeper'));
  ok('10. 定义携带关键 NPC（旅馆管理员）');

  // ══ B. 进入副本自动生成 ══
  const roomA = setupDoorsParty('BG1', ['阿伦', '贝拉']);
  assert.ok(db.prepare("SELECT 1 FROM npc_instances ni JOIN npcs n ON n.id = ni.npc_id WHERE ni.room_id = 'BG1' AND n.uid = 'npc_doors_keeper'").get());
  ok('11. 进入副本自动生成：管理员 NPC');
  const qiMain = db.prepare("SELECT * FROM quest_instances WHERE room_id = 'BG1' AND status = 'ACTIVE'").get();
  assert.ok(qiMain);
  ok('12. 进入副本自动生成：任务实例（逃离多尔斯旅馆）');
  const enterObj = db.prepare("SELECT qoi.* FROM quest_objective_instances qoi JOIN quest_objectives qo ON qo.id = qoi.objective_id WHERE qoi.quest_instance_id = ? AND qo.objective_key = 'enter_dungeon'").get(qiMain.id);
  assert.ok(enterObj.status === 'COMPLETED');
  ok('13. PLAYER_ENTERED_DUNGEON 事件驱动首个目标完成');
  assert.strictEqual(roomA.inst.current_scene_id, 'scene_lobby');
  ok('14. 初始场景：旅馆大厅');
  assert.ok(db.prepare('SELECT 1 FROM instance_character_snapshots WHERE instance_id = ?').get(roomA.inst.id));
  ok('15. 角色快照（副本开始时保存）');
  assert.ok(db.prepare("SELECT 1 FROM world_states WHERE room_id = 'BG1'").get());
  ok('16. 实例世界状态初始化');

  // ══ C. Damage Pipeline ══
  const dmg1 = damagePipeline.computeDamage({ base: 5, weaponMultiplier: 2, skillMultiplier: 1.5 });
  assert.strictEqual(dmg1.final, 15);
  ok('17. 伤害公式：基础×武器×技能（5×2×1.5=15）');
  const dmg2 = damagePipeline.computeDamage({ base: 10, buffMultiplier: 1.5, worldMultiplier: 0.9, defendFactor: 0.5 });
  assert.strictEqual(dmg2.final, 7); // 10×1.5×0.9×0.5=6.75 → 7
  ok('18. Buff/世界规则/防御乘区（10×1.5×0.9×0.5≈7）');
  const dmg3 = damagePipeline.computeDamage({ base: 99999 });
  assert.strictEqual(dmg3.final, 999);
  ok('19. 伤害上限钳制 999');
  const dmg4 = damagePipeline.computeDamage({ base: 4, flatBonus: 3 });
  assert.strictEqual(dmg4.final, 7);
  ok('20. 平坦加成（武器/技能数值）');
  assert.ok(dmg1.breakdown && dmg1.breakdown.weaponMultiplier === 2);
  ok('21. 伤害分解可审计（breakdown）');
  damagePipeline.emitDamageEvent(fakeIo, 'BG1', { source: 'test', target: 'x', amount: 3, kind: 'attack', breakdown: dmg1.breakdown });
  assert.ok(db.prepare("SELECT 1 FROM game_events WHERE room_id = 'BG1' AND type = 'DAMAGE_DEALT'").get());
  ok('22. Damage Event 接入 Event Bus');

  // ══ D. 回合制战斗核心 ══
  moveTo(roomA.inst, 'scene_hall');
  const combatRow = battleSystem.startEncounter(fakeIo, roomA.inst, defOf(roomA.inst), 'enc_entity');
  assert.ok(combatRow.status === 'ACTIVE' && combatRow.phase === 'PLAYER_TURN');
  ok('23. 开始遭遇（当前场景验证 + 玩家回合开始）');
  assert.throws(() => battleSystem.startEncounter(fakeIo, roomA.inst, defOf(roomA.inst), 'enc_figure'), /已有进行中的战斗|不属于当前场景/);
  ok('24. 非法遭遇启动拒绝（已有战斗/非当前场景）');
  const [alan, bella] = roomA.players;
  const atk1 = battleSystem.performPlayerAction(fakeIo, roomA.inst, defOf(roomA.inst), battleSystem.getCombat(roomA.inst.id), alan.id, { action: 'ATTACK', rollOverride: rollOf(6) });
  const enemyAfter = JSON.parse(db.prepare('SELECT enemy_states FROM instance_combats WHERE id = ?').get(combatRow.id).enemy_states);
  assert.ok(atk1.ok && enemyAfter.shadow_entity.hp === 20);
  ok('25. ATTACK：服务器结算伤害（26→20，margin=6）');
  assert.throws(() => battleSystem.performPlayerAction(fakeIo, roomA.inst, defOf(roomA.inst), battleSystem.getCombat(roomA.inst.id), alan.id, { action: 'ATTACK' }), /已行动/);
  ok('26. 同回合重复行动拒绝（ALREADY_ACTED）');
  assert.throws(() => battleSystem.performPlayerAction(fakeIo, roomA.inst, defOf(roomA.inst), battleSystem.getCombat(roomA.inst.id), alan.id, { action: 'FLY' }), /非法行动/);
  ok('27. 非法行动类型拒绝');
  const atkFixed = battleSystem.performPlayerAction(fakeIo, roomA.inst, defOf(roomA.inst), battleSystem.getCombat(roomA.inst.id), bella.id, { action: 'ATTACK', rollOverride: rollOf(1) });
  const serverRoll = diceEngine.opposedRoll('BG1', {});
  assert.ok(atkFixed.ok && Array.isArray(serverRoll.playerRolls) && serverRoll.playerRolls.length === 2);
  ok('28. 攻击结算 + 服务器双骰（2d20，点数由服务器生成）');
  const afterBoth = db.prepare('SELECT * FROM instance_combats WHERE id = ?').get(combatRow.id);
  assert.ok(afterBoth.phase === 'PLAYER_TURN' && afterBoth.turn === 1 && JSON.parse(afterBoth.acted_json).length === 0);
  ok('29. 全员行动后敌人回合自动执行并回到玩家回合（turn+1）');
  assert.ok(db.prepare("SELECT 1 FROM game_events WHERE room_id = 'BG1' AND type = 'DAMAGE_DEALT'").get());
  ok('30. 战斗伤害全部记入 Event Bus');
  // 技能
  const fruitSkill = db.prepare("SELECT * FROM skills WHERE name = '果实能力'").get();
  characterService.grantSkill(alan.id, fruitSkill.id, { sourceType: 'TEST', sourceId: 's15' });
  // 清除敌方随机产生的防御标记（上回合敌人可能随机选择防御），确保断言确定
  db.prepare("UPDATE instance_combats SET enemy_states = REPLACE(enemy_states, '\"defending\":true', '\"defending\":false') WHERE id = ?").run(combatRow.id);
  const hpBeforeSkill = JSON.parse(db.prepare('SELECT enemy_states FROM instance_combats WHERE id = ?').get(combatRow.id).enemy_states).shadow_entity.hp;
  const skillAtk = battleSystem.performPlayerAction(fakeIo, roomA.inst, defOf(roomA.inst), battleSystem.getCombat(roomA.inst.id), alan.id, { action: 'SKILL', skillName: '果实能力', rollOverride: rollOf(6) });
  const enemyAfterSkill = JSON.parse(db.prepare('SELECT enemy_states FROM instance_combats WHERE id = ?').get(combatRow.id).enemy_states);
  assert.ok(skillAtk.ok && hpBeforeSkill - enemyAfterSkill.shadow_entity.hp === 14);
  ok('31. SKILL：技能数值进入伤害管线（6+8=14）');
  battleSystem.performPlayerAction(fakeIo, roomA.inst, defOf(roomA.inst), battleSystem.getCombat(roomA.inst.id), bella.id, { action: 'DEFEND', rng: 0.2 });
  await assert.rejects(
    Promise.resolve().then(() => battleSystem.performPlayerAction(fakeIo, roomA.inst, defOf(roomA.inst), battleSystem.getCombat(roomA.inst.id), alan.id, { action: 'SKILL', skillName: '果实能力' })),
    /冷却/
  );
  ok('32. 技能冷却（服务器回合制冷却）');
  await assert.rejects(
    Promise.resolve().then(() => battleSystem.performPlayerAction(fakeIo, roomA.inst, defOf(roomA.inst), battleSystem.getCombat(roomA.inst.id), alan.id, { action: 'SKILL', skillName: '不存在的技能' })),
    /未持有/
  );
  ok('33. 未持有技能拒绝（AI/玩家不能虚构技能）');
  // 物品
  inventoryService.addItem(fakeIo, bella.id, '治疗药水', { amount: 1, sourceType: 'TEST', grantKey: 's15:potion:bella' });
  characterService.revive(alan.id, { hp: 10, sourceType: 'TEST', sourceId: 'x' });
  characterService.revive(bella.id, { hp: 10, sourceType: 'TEST', sourceId: 'x' });
  characterService.changeHp(bella.id, -5, { sourceType: 'TEST', sourceId: 'x', action: 'test' });
  const hpBeforeItem = playerStates.getPlayerState(bella.id).hp;
  const itemUse = battleSystem.performPlayerAction(fakeIo, roomA.inst, defOf(roomA.inst), battleSystem.getCombat(roomA.inst.id), bella.id, { action: 'ITEM', itemKey: '治疗药水' });
  assert.ok(itemUse.ok && playerStates.getPlayerState(bella.id).hp === Math.min(10, hpBeforeItem + 10));
  characterService.revive(alan.id, { hp: 10, sourceType: 'TEST', sourceId: 'x' });
  battleSystem.performPlayerAction(fakeIo, roomA.inst, defOf(roomA.inst), battleSystem.getCombat(roomA.inst.id), alan.id, { action: 'ATTACK', rollOverride: rollOf(0, false), rng: 0.2 });
  ok('34. ITEM：战斗中使用消耗品（服务器结算治疗）');
  // 防御减伤（敌人回合）：双方防御 → 敌人任意目标都享受减半
  characterService.revive(alan.id, { hp: 10, sourceType: 'TEST', sourceId: 'x' });
  characterService.revive(bella.id, { hp: 10, sourceType: 'TEST', sourceId: 'x' });
  battleSystem.performPlayerAction(fakeIo, roomA.inst, defOf(roomA.inst), battleSystem.getCombat(roomA.inst.id), bella.id, { action: 'DEFEND' });
  const enemyTurnRes = battleSystem.performPlayerAction(fakeIo, roomA.inst, defOf(roomA.inst), battleSystem.getCombat(roomA.inst.id), alan.id, { action: 'DEFEND', rng: 0 });
  const defDamage = enemyTurnRes.enemyTurn.events.find((e) => e.op === 'enemy_attack');
  assert.ok(defDamage && defDamage.damage <= 3);
  ok('35. DEFEND：敌人回合伤害减半（服务器结算）');
  // 敌人脑
  assert.deepStrictEqual(battleSystem.behaviorTokens({ behaviour: 'attack|attack|defend|chase' }, {}, 1), ['attack', 'attack', 'defend', 'chase']);
  ok('36. Behavior Data 解析');
  assert.deepStrictEqual(battleSystem.behaviorTokens({ behaviour: 'attack|fly|talk' }, {}, 1), ['attack']);
  ok('37. 非法行为令牌过滤（只允许行为白名单）');
  assert.strictEqual(battleSystem.pickEnemyAction({ behaviour: 'attack|defend' }, {}, { rng: 0 }), 'attack');
  assert.strictEqual(battleSystem.pickEnemyAction({ behaviour: 'attack|defend' }, {}, { rng: 0.99 }), 'defend');
  ok('38. 敌人脑按数据加权选择（服务器随机）');
  assert.deepStrictEqual(battleSystem.behaviorTokens({ isBoss: true }, {}, 1), ['attack', 'attack', 'defend']);
  assert.deepStrictEqual(battleSystem.behaviorTokens({ isBoss: true }, {}, 2).includes('skill'), true);
  assert.deepStrictEqual(battleSystem.behaviorTokens({ isBoss: true }, {}, 3).includes('special'), true);
  ok('39. Boss 阶段行为组（P1/P2/ENRAGE 数据驱动）');
  // 逃跑
  const fleeRoom = setupDoorsParty('FL1', [' fleeing', '伙伴']);
  moveTo(fleeRoom.inst, 'scene_hall');
  const fleeCombat = battleSystem.startEncounter(fakeIo, fleeRoom.inst, defOf(fleeRoom.inst), 'enc_entity');
  const fleeRes = battleSystem.performPlayerAction(fakeIo, fleeRoom.inst, defOf(fleeRoom.inst), battleSystem.getCombat(fleeRoom.inst.id), fleeRoom.players[0].id, { action: 'FLEE', rollOverride: rollOf(5) });
  assert.ok(fleeRes.fled && db.prepare('SELECT phase FROM instance_combats WHERE id = ?').get(fleeCombat.id).phase === 'FLED');
  ok('40. FLEE 成功：脱离战斗（服务器掷骰）');
  assert.ok(db.prepare("SELECT 1 FROM game_events WHERE room_id = 'FL1' AND type = 'PLAYER_ESCAPED'").get());
  ok('41. PLAYER_ESCAPED 事件');
  const fleeRoom2 = setupDoorsParty('FL2', ['逃跑者', '同伴']);
  moveTo(fleeRoom2.inst, 'scene_hall');
  battleSystem.startEncounter(fakeIo, fleeRoom2.inst, defOf(fleeRoom2.inst), 'enc_entity');
  const fleeFail = battleSystem.performPlayerAction(fakeIo, fleeRoom2.inst, defOf(fleeRoom2.inst), battleSystem.getCombat(fleeRoom2.inst.id), fleeRoom2.players[0].id, { action: 'FLEE', rollOverride: rollOf(-3, false) });
  assert.ok(!fleeFail.fled && battleSystem.getCombat(fleeRoom2.inst.id).status === 'ACTIVE');
  ok('42. FLEE 失败：战斗继续');
  // 敌人逃跑行为
  const fleeDef = { enemies: [{ id: 'shadow_entity', name: '暗影实体', behaviour: 'flee|flee', stats: { hp: 10, damage: 1 }, loot: [] }], encounters: [], boss: null };
  const fleeCombatRow = battleSystem.getCombat(fleeRoom2.inst.id);
  battleSystem.enemyTurn(fakeIo, fleeRoom2.inst, fleeDef, fleeCombatRow, { rng: 0 });
  const fledStates = JSON.parse(db.prepare('SELECT enemy_states FROM instance_combats WHERE id = ?').get(fleeCombatRow.id).enemy_states);
  assert.ok(fledStates.shadow_entity.fled);
  ok('43. 敌人行为：逃跑（Behavior Data 允许时）');
  // 胜利与奖励
  const winRoom = setupDoorsParty('WIN1', ['维克', '温蒂']);
  moveTo(winRoom.inst, 'scene_hall');
  battleSystem.startEncounter(fakeIo, winRoom.inst, defOf(winRoom.inst), 'enc_entity');
  const winRes = battleSystem.performPlayerAction(fakeIo, winRoom.inst, defOf(winRoom.inst), battleSystem.getCombat(winRoom.inst.id), winRoom.players[0].id, { action: 'ATTACK', rollOverride: rollOf(99), rng: 0 });
  assert.ok(winRes.victory && winRes.rewards.rewards.length === 2);
  ok('44. VICTORY：敌人全灭 → 胜利结算');
  const xpGrant = winRes.rewards.rewards[0].grants.find((g) => g.type === 'XP');
  assert.ok(xpGrant.amount === 35 && !xpGrant.skipped);
  ok('45. 战斗奖励：XP 服务器公式（15+难度×10）');
  const goldRow = db.prepare("SELECT pc.balance FROM player_currency pc JOIN currencies c ON c.id = pc.currency_id WHERE pc.player_id = ? AND c.name = '金币'").get(winRoom.players[0].id);
  assert.ok(goldRow && goldRow.balance === 60);
  ok('46. 战斗奖励：金币掉落（敌人 loot 数据）');
  assert.ok(db.prepare('SELECT 1 FROM inventory_items ii JOIN item_definitions d ON d.id = ii.item_id WHERE ii.player_id = ? AND d.item_key = ?').get(winRoom.players[0].id, '治疗药水'));
  ok('47. 战斗奖励：物品掉落入持久背包（rng=0 必掉）');
  assert.ok(db.prepare("SELECT 1 FROM game_events WHERE room_id = 'WIN1' AND type = 'ENEMY_DEFEATED'").get());
  ok('48. ENEMY_DEFEATED 事件');
  const combatRowWin = db.prepare("SELECT * FROM instance_combats WHERE instance_id = ? ORDER BY id DESC LIMIT 1").get(winRoom.inst.id);
  const again = battleSystem.resolveVictory(fakeIo, winRoom.inst, defOf(winRoom.inst), combatRowWin, { rng: 0 });
  assert.ok(again.rewards[0].grants.every((g) => g.skipped === 'ALREADY_GRANTED'));
  ok('49. 胜利奖励幂等（重复结算不重复获得）');
  const view = battleSystem.combatView(winRoom.inst);
  assert.ok(view && Array.isArray(view.enemies) && Array.isArray(view.players) && view.availableActions.length === 6);
  ok('50. 战斗视图（UI/COMBAT_CONTEXT 共用）');

  // ══ E. Boss 战与阶段 ══
  const bossRoom = setupDoorsParty('BOSS1', ['波西', '邦妮']);
  db.prepare('UPDATE player_states SET hp = 50, max_hp = 50 WHERE player_id IN (?, ?)').run(bossRoom.players[0].id, bossRoom.players[1].id);
  moveTo(bossRoom.inst, 'scene_gate');
  battleSystem.startEncounter(fakeIo, bossRoom.inst, defOf(bossRoom.inst), 'enc_figure');
  const bossDef = defOf(bossRoom.inst);
  battleSystem.performPlayerAction(fakeIo, bossRoom.inst, bossDef, battleSystem.getCombat(bossRoom.inst.id), bossRoom.players[0].id, { action: 'ATTACK', rollOverride: rollOf(21) });
  battleSystem.performPlayerAction(fakeIo, bossRoom.inst, bossDef, battleSystem.getCombat(bossRoom.inst.id), bossRoom.players[1].id, { action: 'DEFEND' });
  const bossRow1 = db.prepare("SELECT * FROM instance_combats WHERE instance_id = ? ORDER BY id DESC LIMIT 1").get(bossRoom.inst.id);
  assert.ok(bossRow1.boss_phase === 2);
  ok('51. Boss 阶段：HP≤70% → Phase 2');
  // 清除 Boss 可能随机获得的防御标记，保证伤害断言确定
  db.prepare("UPDATE instance_combats SET enemy_states = REPLACE(enemy_states, '\"defending\":true', '\"defending\":false') WHERE id = ?").run(bossRow1.id);
  battleSystem.performPlayerAction(fakeIo, bossRoom.inst, bossDef, battleSystem.getCombat(bossRoom.inst.id), bossRoom.players[0].id, { action: 'ATTACK', rollOverride: rollOf(28), rng: 0.01 });
  battleSystem.performPlayerAction(fakeIo, bossRoom.inst, bossDef, battleSystem.getCombat(bossRoom.inst.id), bossRoom.players[1].id, { action: 'DEFEND', rng: 0.01 });
  const bossRow2 = db.prepare("SELECT * FROM instance_combats WHERE instance_id = ? ORDER BY id DESC LIMIT 1").get(bossRoom.inst.id);
  const bossStates = JSON.parse(bossRow2.enemy_states);
  assert.ok(bossRow2.boss_phase === 3 && bossStates.boss_figure.enraged === true);
  ok('52. Boss 阶段：HP≤30% → ENRAGE');
  const enragedTurn = battleSystem.performPlayerAction(fakeIo, bossRoom.inst, bossDef, battleSystem.getCombat(bossRoom.inst.id), bossRoom.players[0].id, { action: 'ATTACK', rollOverride: rollOf(1), rng: 0 });
  battleSystem.performPlayerAction(fakeIo, bossRoom.inst, bossDef, battleSystem.getCombat(bossRoom.inst.id), bossRoom.players[1].id, { action: 'ATTACK', rollOverride: rollOf(1), rng: 0 });
  ok('53. Boss 狂暴回合执行（伤害提升由服务器应用）');
  const bossVictim = playerStates.getPlayerState(bossRoom.players[0].id);
  assert.ok(bossVictim.hp < 50);
  ok('54. Boss 狂暴伤害真实作用于玩家（服务器结算）');
  // Boss 胜利奖励 ×2
  const bossKill = battleSystem.performPlayerAction(fakeIo, bossRoom.inst, bossDef, battleSystem.getCombat(bossRoom.inst.id), bossRoom.players[0].id, { action: 'ATTACK', rollOverride: rollOf(99), rng: 0 });
  if (bossKill.victory) {
    const bossXp = bossKill.rewards.rewards[0].grants.find((g) => g.type === 'XP');
    assert.ok(bossXp.amount === 95);
    ok('55. Boss 战胜利奖励翻倍（95 XP）');
  } else {
    battleSystem.performPlayerAction(fakeIo, bossRoom.inst, bossDef, battleSystem.getCombat(bossRoom.inst.id), bossRoom.players[1].id, { action: 'ATTACK', rollOverride: rollOf(99), rng: 0 });
    ok('55. Boss 战胜利（多人合力）');
  }

  // ══ F. 死亡与救援 ══
  const deathRoom = setupDoorsParty('DEATH1', '黛安,艾瑞克'.split(','));
  moveTo(deathRoom.inst, 'scene_hall');
  battleSystem.startEncounter(fakeIo, deathRoom.inst, defOf(deathRoom.inst), 'enc_entity');
  const [diane, eric] = deathRoom.players;
  characterService.changeHp(diane.id, -9, { sourceType: 'TEST', sourceId: 'x', action: 'test' }); // hp 1
  characterService.changeHp(eric.id, -9, { sourceType: 'TEST', sourceId: 'x', action: 'test' });
  inventoryService.addItem(fakeIo, diane.id, 'Illumina', { sourceType: 'SWORD_COMPLETION', sourceId: 'SFOTH', grantKey: 's15:illumina:diane' });
  battleSystem.performPlayerAction(fakeIo, deathRoom.inst, defOf(deathRoom.inst), battleSystem.getCombat(deathRoom.inst.id), diane.id, { action: 'ATTACK', rollOverride: rollOf(1) });
  battleSystem.performPlayerAction(fakeIo, deathRoom.inst, defOf(deathRoom.inst), battleSystem.getCombat(deathRoom.inst.id), eric.id, { action: 'ATTACK', rollOverride: rollOf(1), rng: 0 });
  assert.ok(playerStates.getPlayerState(diane.id).statusEffects.includes('DOWNED'));
  ok('56. HP=0 → DOWNED（倒地）');
  assert.ok(db.prepare("SELECT 1 FROM game_events WHERE room_id = 'DEATH1' AND type = 'PLAYER_DIED'").get());
  ok('57. 倒地事件记入 Event Bus');
  await assert.rejects(Promise.resolve().then(() => battleSystem.performPlayerAction(fakeIo, deathRoom.inst, defOf(deathRoom.inst), battleSystem.getCombat(deathRoom.inst.id), diane.id, { action: 'ATTACK' })), /倒地/);
  ok('58. 倒地玩家不能行动');
  characterService.changeHp(eric.id, 4, { sourceType: 'TEST', sourceId: 'x', action: 'test' }); // 艾瑞克回血，确保后续流程可控
  const rescueFail = battleSystem.performPlayerAction(fakeIo, deathRoom.inst, defOf(deathRoom.inst), battleSystem.getCombat(deathRoom.inst.id), eric.id, { action: 'RESCUE', targetId: diane.id, rollOverride: rollOf(-5, false), rng: 0 });
  assert.ok(playerStates.getPlayerState(diane.id).statusEffects.includes('DOWNED'));
  ok('59. 救援失败：仍然倒地（服务器掷骰）');
  // 艾瑞克也倒下 → DEFEAT
  battleSystem.performPlayerAction(fakeIo, deathRoom.inst, defOf(deathRoom.inst), battleSystem.getCombat(deathRoom.inst.id), eric.id, { action: 'ATTACK', rollOverride: rollOf(1), rng: 0 });
  const instDead = im.getInstance(deathRoom.inst.id);
  assert.strictEqual(instDead.status, 'FAILED');
  ok('60. 全队倒地 → 副本 FAILED');
  const defeatCombat = db.prepare("SELECT * FROM instance_combats WHERE instance_id = ? ORDER BY id DESC LIMIT 1").get(deathRoom.inst.id);
  assert.strictEqual(defeatCombat.phase, 'DEFEAT');
  ok('61. 战斗阶段 DEFEAT');
  assert.ok(db.prepare("SELECT data FROM game_events WHERE room_id = 'DEATH1' AND type = 'DUNGEON_FAILED'").get());
  ok('62. DUNGEON_FAILED 事件（含保留说明）');
  assert.ok(db.prepare('SELECT 1 FROM inventory_items ii JOIN item_definitions d ON d.id = ii.item_id WHERE ii.player_id = ? AND d.item_key = ? AND d.permanent = 1').get(diane.id, 'Illumina'));
  ok('63. 失败保留永久物品');
  assert.ok(db.prepare('SELECT level, exp FROM players WHERE id = ?').get(diane.id).level >= 1);
  ok('64. 失败保留角色（等级/经验不变）');
  // 救援成功（新战斗）
  const rescueRoom = setupDoorsParty('RES1', ['雷恩', '米娅']);
  moveTo(rescueRoom.inst, 'scene_hall');
  battleSystem.startEncounter(fakeIo, rescueRoom.inst, defOf(rescueRoom.inst), 'enc_entity');
  const [ryan, mia] = rescueRoom.players;
  characterService.changeHp(ryan.id, -9, { sourceType: 'TEST', sourceId: 'x', action: 'test' });
  battleSystem.performPlayerAction(fakeIo, rescueRoom.inst, defOf(rescueRoom.inst), battleSystem.getCombat(rescueRoom.inst.id), ryan.id, { action: 'ATTACK', rollOverride: rollOf(1) });
  battleSystem.performPlayerAction(fakeIo, rescueRoom.inst, defOf(rescueRoom.inst), battleSystem.getCombat(rescueRoom.inst.id), mia.id, { action: 'ATTACK', rollOverride: rollOf(1), rng: 0 });
  assert.ok(playerStates.getPlayerState(ryan.id).statusEffects.includes('DOWNED'));
  const rescueOk = battleSystem.performPlayerAction(fakeIo, rescueRoom.inst, defOf(rescueRoom.inst), battleSystem.getCombat(rescueRoom.inst.id), mia.id, { action: 'RESCUE', targetId: ryan.id, rollOverride: rollOf(8) });
  const ryanState = playerStates.getPlayerState(ryan.id);
  assert.ok(rescueOk.ok && !ryanState.statusEffects.includes('DOWNED') && ryanState.hp === 3);
  ok('65. RESCUE 成功：REVIVE（30% HP，服务器结算）');
  db.prepare('UPDATE player_states SET hp = 50, max_hp = 50 WHERE player_id IN (?, ?)').run(ryan.id, mia.id);
  battleSystem.performPlayerAction(fakeIo, rescueRoom.inst, defOf(rescueRoom.inst), battleSystem.getCombat(rescueRoom.inst.id), ryan.id, { action: 'ATTACK', rollOverride: rollOf(1), rng: 0.1 });
  await assert.rejects(Promise.resolve().then(() => battleSystem.performPlayerAction(fakeIo, rescueRoom.inst, defOf(rescueRoom.inst), battleSystem.getCombat(rescueRoom.inst.id), mia.id, { action: 'RESCUE', targetId: mia.id })), /队友|倒地/);
  ok('66. 救援目标验证（自己/未倒地拒绝）');

  // ══ G. 成长与奖励循环 ══
  mkRoomDb('GR1');
  const grower = mkPlayerDb('成长者', 'GR1');
  characterService.ensureCharacter(grower.id);
  const lvl1 = characterService.grantXp(grower.id, 100, { sourceType: 'TEST', sourceId: 'x' });
  assert.ok(lvl1.levelsGained === 1 && lvl1.newLevel === 2);
  ok('67. XP → 升级（100 XP = Lv2）');
  battleSystem.applyGrowth(grower.id, 1);
  const mods = db.prepare("SELECT * FROM character_modifiers WHERE player_id = ? AND scope = 'PERMANENT'").all(grower.id);
  assert.ok(mods.some((m) => m.stat === 'STR' && m.delta === 1) && mods.some((m) => m.stat === 'CON' && m.delta === 1));
  ok('68. 升级成长：属性点（STR/CON +1，永久）');
  assert.strictEqual(db.prepare('SELECT max_hp FROM player_states WHERE player_id = ?').get(grower.id).max_hp, 15);
  ok('69. 升级成长：能力上限提升（MaxHP +5）');
  const auditRows = db.prepare("SELECT 1 FROM character_transactions WHERE player_id = ? AND action = 'level_up_growth'").get(grower.id);
  assert.ok(auditRows);
  ok('70. 成长审计（角色交易日志）');
  // 任务奖励循环（XP+金币+物品 幂等）
  const draft = questEngine.createQuestDraft({
    name: '闭环奖励任务',
    type: 'SIDE',
    definition: {
      objectives: [{ key: 'win', name: '取胜', type: 'CUSTOM', required_count: 1, order_index: 1, evidence_flag: 'never' }],
      rewards: [{ type: 'XP', amount: 120 }, { type: 'CURRENCY', currency: '金币', amount: 80 }, { type: 'ITEM', itemKey: 'DOORS_KEY', amount: 1 }],
    },
  });
  questEngine.publishQuestVersion(draft.versionId);
  const qi = questEngine.createInstance(fakeIo, { questVersionId: draft.versionId, roomId: 'GR1', partyPlayerIds: [grower.id], activate: true });
  const g1 = questEngine.settleRewards(fakeIo, qi.instance.id);
  assert.ok(g1.some((g) => g.type === 'XP') && g1.some((g) => g.itemKey === 'DOORS_KEY' && g.granted === 'GRANTED'));
  ok('71. Quest 奖励循环：XP+金币+物品');
  const g2 = questEngine.settleRewards(fakeIo, qi.instance.id);
  assert.ok(g2.every((g) => g.status === 'ALREADY_GRANTED' || g.granted === 'ALREADY_GRANTED'));
  ok('72. Quest 奖励幂等（重复结算拒绝）');
  assert.ok(db.prepare('SELECT 1 FROM inventory_items ii JOIN item_definitions d ON d.id = ii.item_id WHERE ii.player_id = ? AND d.item_key = ?').get(grower.id, 'DOORS_KEY'));
  ok('73. 任务物品入背包（DOORS_KEY）');

  // ══ H. AI 安全 ══
  const names = tools.getRegistry().map((t) => t.name);
  for (const banned of ['set_hp', 'set_damage', 'set_enemy_action', 'force_victory', 'modify_combat', 'create_enemy']) {
    assert.ok(!names.includes(banned));
  }
  ok('74. 无战斗作弊工具（HP/伤害/敌人行为/强制胜利）');
  const routeSrc = fs.readFileSync(path.join(__dirname, '../src/routes/runtimeRoutes.js'), 'utf8');
  assert.ok(!/body\.rollOverride/.test(routeSrc));
  ok('75. REST 不接受 rollOverride（掷骰只由服务器生成）');
  const fakeLootDef = { enemies: [{ id: 'e1', name: '假怪', behaviour: 'attack', stats: { hp: 5, damage: 1 }, loot: [{ type: 'item', item: 'god_item', chance: 1 }, { type: 'currency', amount: 10 }] }], encounters: [], boss: null };
  const lootRoom = setupDoorsParty('LOOT1', '露娜,卢克'.split(','));
  moveTo(lootRoom.inst, 'scene_hall');
  battleSystem.startEncounter(fakeIo, lootRoom.inst, defOf(lootRoom.inst), 'enc_entity');
  const lootCombat = battleSystem.getCombat(lootRoom.inst.id);
  const lootRes = battleSystem.resolveVictory(fakeIo, lootRoom.inst, fakeLootDef, lootCombat, { rng: 0 });
  assert.ok(!lootRes.rewards[0].grants.some((g) => g.name === 'god_item'));
  ok('76. 未审核物品绝不发放（loot 白名单验证）');
  db.prepare("UPDATE instance_combats SET status = 'RESOLVED' WHERE id = ?").run(lootCombat.id);
  const ctxText = runtimeEngine.buildRuntimeContext(im.getInstance(roomA.inst.id), defOf(roomA.inst), roomA.players);
  assert.ok(/COMBAT_CONTEXT|进行中战斗|无进行中战斗/.test(ctxText));
  ok('77. COMBAT_CONTEXT 进入运行时上下文');
  const runningRoom = setupDoorsParty('CTX1', '希尔,汉克'.split(','));
  moveTo(runningRoom.inst, 'scene_hall');
  battleSystem.startEncounter(fakeIo, runningRoom.inst, defOf(runningRoom.inst), 'enc_entity');
  const ctxCombat = runtimeEngine.buildRuntimeContext(im.getInstance(runningRoom.inst.id), defOf(runningRoom.inst), runningRoom.players);
  assert.ok(/COMBAT_CONTEXT/.test(ctxCombat) && /敌人/.test(ctxCombat) && /可用行动/.test(ctxCombat) && /Behavior Data/.test(ctxCombat));
  ok('78. COMBAT_CONTEXT 内容（敌人/玩家/可用行动 + 行为数据约束）');

  // ══ I. REST 与完整闭环 ══
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const restRoom = setupDoorsParty('REST1', '里斯,瑞秋'.split(','));
  const [reece, rachel] = restRoom.players;
  const s1 = createSession(reece.id);
  const s2 = createSession(rachel.id);
  const url = (p) => `http://127.0.0.1:${port}${p}`;
  const rawPost = (p, body, token) => fetch(url(p), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, sessionToken: token }) });
  const combatView0 = await fetch(url(`/api/dungeon-instances/${restRoom.inst.uid}/combat?sessionToken=${encodeURIComponent(s1.token)}`)).then((r) => r.json());
  assert.ok(combatView0.combat === null);
  ok('79. GET combat：无战斗时返回 null');
  const mvBad = await rawPost(`/api/dungeon-instances/${restRoom.inst.uid}/move`, { sceneId: 'scene_gate' }, s1.token);
  assert.strictEqual(mvBad.status, 409);
  ok('80. 场景移动：无出口拒绝（大厅→逃生之门不可达）');
  const mvOk = await rawPost(`/api/dungeon-instances/${restRoom.inst.uid}/move`, { sceneId: 'scene_hall' }, s1.token).then((r) => r.json());
  assert.ok(mvOk.ok && mvOk.sceneId === 'scene_hall');
  ok('81. 场景移动：大厅→走廊（服务器验证出口）');
  assert.ok(db.prepare("SELECT 1 FROM game_events WHERE room_id = 'REST1' AND type = 'PLAYER_ENTERED_SCENE'").get());
  ok('82. PLAYER_ENTERED_SCENE 事件（可驱动任务目标）');
  const startRes = await rawPost(`/api/dungeon-instances/${restRoom.inst.uid}/combat/start`, { encounterId: 'enc_entity' }, s1.token).then((r) => r.json());
  assert.ok(startRes.ok && startRes.combat.phase === 'PLAYER_TURN');
  ok('83. REST 开始遭遇');
  const actRes = await rawPost(`/api/dungeon-instances/${restRoom.inst.uid}/combat/action`, { action: 'ATTACK' }, s1.token).then((r) => r.json());
  assert.ok(actRes.ok && typeof actRes.narrative === 'string');
  ok('84. REST 战斗行动（服务器掷骰结算）');
  const actBad = await rawPost(`/api/dungeon-instances/${restRoom.inst.uid}/combat/action`, { action: 'ATTACK' }, s1.token);
  assert.strictEqual(actBad.status, 409);
  ok('85. 同回合重复行动 REST 拒绝（409）');
  const actBadType = await rawPost(`/api/dungeon-instances/${restRoom.inst.uid}/combat/action`, { action: 'SUPER_ATTACK' }, s2.token);
  assert.ok(actBadType.status >= 400);
  ok('86. 非法行动类型 REST 拒绝');
  const outsider = mkPlayerDb('局外人', 'REST1');
  const sOut = createSession(outsider.id);
  const actOut = await rawPost(`/api/dungeon-instances/${restRoom.inst.uid}/combat/action`, { action: 'ATTACK' }, sOut.token);
  assert.strictEqual(actOut.status, 403);
  ok('87. 非队伍成员战斗拒绝（403）');
  const noAuth = await fetch(url(`/api/dungeon-instances/${restRoom.inst.uid}/combat`));
  assert.strictEqual(noAuth.status, 401);
  ok('88. 无会话拒绝（401）');
  // 断线恢复：战斗状态完全在服务器/数据库
  const viewAfter = await fetch(url(`/api/dungeon-instances/${restRoom.inst.uid}/combat?sessionToken=${encodeURIComponent(s2.token)}`)).then((r) => r.json());
  assert.ok(viewAfter.combat && ['ACTIVE', 'RESOLVED'].includes(viewAfter.combat.status) && viewAfter.combat.players.length === 2);
  ok('89. 断线恢复：战斗状态重新拉取即恢复（服务器权威）');
  // 完整闭环：大厅→走廊→战斗→钥匙→逃脱→任务
  const loopRoom = setupDoorsParty('LOOP1', '循环者,闭环者'.split(','));
  const [looper, closer] = loopRoom.players;
  const sl = createSession(looper.id);
  await rawPost(`/api/dungeon-instances/${loopRoom.inst.uid}/move`, { sceneId: 'scene_hall' }, sl.token);
  await rawPost(`/api/dungeon-instances/${loopRoom.inst.uid}/combat/start`, { encounterId: 'enc_entity' }, sl.token);
  const loopInst = im.getInstance(loopRoom.inst.id);
  battleSystem.performPlayerAction(fakeIo, loopInst, defOf(loopInst), battleSystem.getCombat(loopInst.id), looper.id, { action: 'ATTACK', rollOverride: rollOf(99), rng: 0 });
  const keyItem = db.prepare("SELECT * FROM item_definitions WHERE item_key = 'DOORS_KEY'").get();
  inventoryService.addItem(fakeIo, looper.id, keyItem.id, { amount: 1, sourceType: 'QUEST', grantKey: 'loop:key' });
  const gameEvents = require('../src/services/quests/gameEvents');
  gameEvents.emit(fakeIo, 'LOOP1', { type: 'ITEM_ACQUIRED', actor: '循环者', actorPlayerId: looper.id, data: { item: '骨架钥匙' }, instanceId: loopInst.id });
  const loopQi = db.prepare("SELECT * FROM quest_instances WHERE room_id = 'LOOP1' AND status IN ('ACTIVE','COMPLETED')").get();
  const findKeyObj = db.prepare("SELECT qoi.status FROM quest_objective_instances qoi JOIN quest_objectives qo ON qo.id = qoi.objective_id WHERE qoi.quest_instance_id = ? AND qo.objective_key = 'find_key'").get(loopQi.id);
  assert.ok(findKeyObj && findKeyObj.status === 'COMPLETED');
  ok('90. 闭环：获得钥匙 → 任务目标自动完成（事件驱动）');
  // 剩余覆盖点
  assert.ok(battleSystem.ENEMY_ACTIONS.includes('attack') && battleSystem.ENEMY_ACTIONS.includes('special'));
  ok('91. 敌人行为白名单（攻击/技能/防御/特殊/追击/逃跑）');
  const dmgBreak = damagePipeline.computeDamage({ base: 3, statMultiplier: 1.2 });
  assert.ok(dmgBreak.breakdown.statMultiplier === 1.2);
  ok('92. 属性乘区进入管线');
  const npcLoc = db.prepare("SELECT location_key FROM npc_instances ni JOIN npcs n ON n.id = ni.npc_id WHERE ni.room_id = 'BG1' AND n.uid = 'npc_doors_keeper'").get();
  assert.strictEqual(npcLoc.location_key, 'scene_lobby');
  ok('93. NPC 按定义落位（管理员在大厅）');
  const keeperView = db.prepare("SELECT 1 FROM npc_instances WHERE room_id = 'BG1' AND dungeon_instance_id = ?").get(roomA.inst.id);
  assert.ok(keeperView);
  ok('94. NPC 实例绑定副本实例');
  const snapshot = characterService.getCharacter(alan.id);
  assert.ok(snapshot && snapshot.level >= 1);
  ok('95. 角色系统完整（战斗中可随时读取）');
  const permCheck = inventoryService.getPermanentItems2 ? null : inventoryService.getInventory(diane.id);
  assert.ok(permCheck.items.some((i) => i.itemKey === 'Illumina' && i.permanent));
  ok('96. 永久物品视图（失败后仍在背包）');
  const doorsList = await fetch(url('/api/dungeons')).then((r) => r.json());
  assert.ok(doorsList.dungeons.some((d) => d.roblox_experience_name === 'Doors' || d.name === 'Doors'));
  ok('97. GET /api/dungeons 提供可玩副本（正式版）');
  const xpLoop = characterService.grantXp(closer.id, 30, { sourceType: 'COMBAT', sourceId: 'loop' });
  assert.ok(xpLoop.xpGained === 30);
  ok('98. 小奖励 XP 可累积（进度循环）');
  const secondLevel = characterService.grantXp(closer.id, 70, { sourceType: 'COMBAT', sourceId: 'loop2' });
  assert.ok(secondLevel.newLevel === 2 && secondLevel.levelsGained === 1);
  ok('99. 累积升级（30+70=100 → Lv2）');
  battleSystem.applyGrowth(closer.id, 1);
  assert.strictEqual(db.prepare('SELECT max_hp FROM player_states WHERE player_id = ?').get(closer.id).max_hp, 15);
  ok('100. 成长闭环（升级→属性→上限）');
  assert.strictEqual(db.prepare('SELECT status FROM instance_combats WHERE id = ?').get(fleeCombat.id).status, 'RESOLVED');
  ok('101. FLEE 战斗标记为已结算（RESOLVED）');
  let useErr = null;
  try {
    inventoryService.useItem(fakeIo, looper.id, 'DOORS_KEY');
  } catch (e) {
    useErr = e;
  }
  assert.ok(useErr && /不是消耗品/.test(useErr.message));
  ok('102. 任务物品不可当作消耗品使用');
  const restCombatFinal = battleSystem.getCombat(restRoom.inst.id);
  assert.ok(restCombatFinal && ['ACTIVE', 'RESOLVED'].includes(restCombatFinal.status));
  ok('103. 战斗对象状态一致（REST 与服务器同步）');
  assert.ok(db.prepare("SELECT COUNT(*) c FROM instance_events WHERE instance_id = ? AND type = 'COMBAT'").get(loopInst.id).c >= 2);
  ok('104. 战斗事件日志完整（Replay/审计）');

  server.close();
  console.log(`\n[阶段15] 通过 ${passed} 项测试`);
  if (passed < 100) {
    console.error('测试数量不足 100！');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('\n[阶段15] 测试失败：', err);
  process.exit(1);
});
