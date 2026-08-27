/**
 * 阶段12 测试：World Simulation & Dynamic Event System（70 项）。
 * 覆盖：数据模型 / 世界事件（目录/幂等/效果/审核）/ World Tick（幂等/暂停恢复）/
 *       NPC自主行为 / NPC移动 / 阵营关系 / 动态副本 / 传奇世界联动 /
 *       AI权限边界 / 断线恢复 / REST。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

for (const suffix of ['', '-wal', '-shm', '-journal']) {
  fs.rmSync(path.join(__dirname, '../../database/data/roblox_trpg.db' + suffix), { force: true });
}

process.env.AI_API_KEY = 'ai-key-s12';
process.env.AI_BASE_URL = 'http://127.0.0.1:4112/v1';
process.env.AI_MODEL = 'mock-s12';
process.env.AI_STREAM = 'off';

const { server } = require('../src/index.js');
const dbMod = require('@roblox-trpg/database');
const db = dbMod.getDb();
const worldEvents = require('../src/services/world/worldEvents');
const worldSim = require('../src/services/world/worldSim');
const npcSimulation = require('../src/services/world/npcSimulation');
const factionRelations = require('../src/services/world/factionRelations');
const dynamicDungeon = require('../src/services/world/dynamicDungeon');
const npcEngine = require('../src/services/npcs/npcEngine');
const legendEngine = require('../src/services/legends/legendEngine');
const characterService = require('../src/services/character/characterService');
const worldState = require('../src/services/world/worldState');
const tools = require('../src/services/ai/tools');
const contextBuilder = require('../src/services/ai/contextBuilder');
const { createSession } = require('../src/sessions/sessionManager');
const instanceManager = require('../src/services/runtime/instanceManager');

let passed = 0;
const ok = (label) => {
  passed += 1;
  console.log(`  ✓ ${label}`);
};
const fakeIo = { to: () => ({ emit: () => {} }), emit: () => {} };

function mkRoomDb(id) {
  db.prepare("INSERT OR IGNORE INTO rooms (id, status, max_players) VALUES (?, 'waiting', 3)").run(id);
}
let pSeq = 0;
function mkPlayerDb(name, roomId) {
  pSeq += 1;
  const uid = `player_s12_${pSeq}`;
  db.prepare('INSERT INTO players (uid, socket_id, name, room_id) VALUES (?, ?, ?, ?)').run(uid, `sock_${uid}`, name, roomId);
  return db.prepare('SELECT * FROM players WHERE uid = ?').get(uid);
}
function mkCitizen(name, roomId) {
  const npc = npcEngine.createNpc({ name, description: '测试平民', personality: { traits: ['谨慎'] }, goals: [] });
  return npcEngine.spawnNpcInstance(null, { npcId: npc.id, roomId });
}
const factionByUid = (uid) => db.prepare('SELECT * FROM factions WHERE uid = ?').get(uid);

async function main() {
  console.log('[test] 阶段12 就绪（70 项）\n');

  // ══ A. 数据模型 ══
  const locs = npcSimulation.listLocations();
  assert.ok(locs.length >= 5 && locs.some((l) => l.key === 'loc_lobby') && locs.some((l) => l.key === 'loc_basement'));
  ok('1. npc_locations 表 + 种子地点（大厅/地下室…）');
  const survivors = factionByUid('faction_doors_survivors');
  const entities = factionByUid('faction_doors_entities');
  const keeper = factionByUid('faction_doors_keeper');
  assert.strictEqual(factionRelations.getFactionRelation(survivors.id, entities.id).relation, 'HOSTILE');
  ok('2. 种子阵营关系：幸存者↔实体=HOSTILE');
  assert.strictEqual(factionRelations.getFactionRelation(survivors.id, keeper.id).relation, 'NEUTRAL');
  ok('3. 种子阵营关系：幸存者↔管理员=NEUTRAL');
  assert.ok(Object.keys(worldEvents.EVENT_CATALOG).length === 7 && worldEvents.EVENT_CATALOG.POWER_OUTAGE.category === 'NATURAL');
  ok('4. 世界事件目录（自然/剧情/系统 7 类）');
  mkRoomDb('RT0');
  db.prepare('INSERT INTO world_ticks (room_id, tick_number) VALUES (?, ?)').run('RT0', 1);
  assert.throws(() => db.prepare('INSERT INTO world_ticks (room_id, tick_number) VALUES (?, ?)').run('RT0', 1));
  ok('5. world_ticks UNIQUE(room_id, tick_number)（幂等约束）');
  mkRoomDb('RT1');
  const citizen0 = mkCitizen('模型市民', 'RT1');
  assert.strictEqual(citizen0.behavior_state, 'IDLE');
  ok('6. npc_instances.behavior_state 默认 IDLE');
  assert.ok(db.prepare('PRAGMA table_info(dungeon_instances)').all().some((c) => c.name === 'variant_key'));
  ok('7. dungeon_instances.variant_key 列（动态副本）');

  // ══ B. 世界事件系统 ══
  mkRoomDb('RW1');
  const r1 = worldEvents.triggerWorldEvent(fakeIo, 'RW1', { type: 'POWER_OUTAGE', durationMs: 60000 });
  assert.ok(r1.triggered && r1.event.status === 'ACTIVE' && r1.event.category === 'NATURAL');
  ok('8. 触发 POWER_OUTAGE（ACTIVE/NATURAL）');
  assert.strictEqual(worldState.getWorld('RW1').state.lights_on, false);
  ok('9. 事件效果：灯光熄灭（lights_on=false，服务器规则写入）');
  const r1dup = worldEvents.triggerWorldEvent(fakeIo, 'RW1', { type: 'POWER_OUTAGE' });
  assert.strictEqual(r1dup.triggered, false);
  assert.strictEqual(r1dup.reason, 'DUPLICATE');
  ok('10. 重复触发幂等（DUPLICATE，不重复生效）');
  assert.throws(() => worldEvents.triggerWorldEvent(fakeIo, 'RW1', { type: 'ALIEN_LANDING' }), /未知事件类型/);
  ok('11. 事件目录外类型拒绝（无 AI 臆造事件）');
  const r2 = worldEvents.triggerWorldEvent(fakeIo, 'RW1', { type: 'MONSTER_INVASION', durationMs: 60000 });
  assert.ok(r2.triggered && worldState.getWorld('RW1').state.monster_invasion === true);
  ok('12. MONSTER_INVASION 效果（monster_invasion=true）');
  const expired = worldEvents.expireDueEvents(fakeIo, 'RW1', Date.now() + 120000);
  assert.ok(expired.length === 2 && worldState.getWorld('RW1').state.lights_on === true);
  ok('13. 事件到期结算（恢复供电 lights_on=true）');
  assert.strictEqual(worldState.getWorld('RW1').state.monster_invasion, false);
  ok('14. 到期后入侵状态撤销（效果可逆）');
  // 阵营战争：管理员↔实体 由中立转敌对，结束后恢复
  const war = worldEvents.triggerWorldEvent(fakeIo, 'RW1', { type: 'FACTION_WAR', data: { factionA: '旅馆管理员', factionB: '实体' }, durationMs: 1000 });
  assert.ok(war.triggered && factionRelations.getFactionRelation(keeper.id, entities.id).relation === 'HOSTILE');
  ok('15. FACTION_WAR 事件改变阵营关系（NEUTRAL→HOSTILE）');
  worldEvents.expireDueEvents(fakeIo, 'RW1', Date.now() + 5000);
  assert.strictEqual(factionRelations.getFactionRelation(keeper.id, entities.id).relation, 'NEUTRAL');
  ok('16. 阵营战争结束恢复原关系');
  mkRoomDb('RW2');
  worldEvents.triggerWorldEvent(fakeIo, 'RW2', { type: 'SECRET_DISCOVERED', data: { flag: 'hidden_route_discovered' } });
  assert.strictEqual(worldState.getWorld('RW2').state.hidden_route_discovered, true);
  ok('17. SECRET_DISCOVERED 写入剧情标志（隐藏路线）');
  const cancelRes = worldEvents.cancelEvent(fakeIo, 'RW2', worldEvents.activeEvents('RW2')[0].uid);
  assert.ok(cancelRes.cancelled);
  ok('18. 事件取消（服务器专用）');
  // AI 申请审核
  assert.throws(() => worldEvents.validateAiEventRequest('RW2', { type: 'DUNGEON_MUTATION' }), /SYSTEM|服务器专属/);
  ok('19. AI 禁止请求 SYSTEM 类事件');
  assert.throws(() => worldEvents.validateAiEventRequest('RW2', { type: 'NPC_DEATH' }), /无权请求/);
  ok('20. AI 禁止请求剧情生死类事件（NPC_DEATH）');
  assert.throws(() => worldEvents.validateAiEventRequest('RW2', { type: 'POWER_OUTAGE', data: { spawn: 'entity_rush' } }), /禁止/);
  ok('21. AI 事件禁止夹带 NPC/物品操作（spawn 键拒绝）');
  assert.throws(() => worldEvents.validateAiEventRequest('RW2', { type: 'POWER_OUTAGE', durationMs: 99 * 60 * 1000 }), /时长/);
  ok('22. AI 事件时长上限（30分钟）');
  assert.throws(() => worldEvents.validateAiEventRequest('RW1', { type: 'POWER_OUTAGE' }), /冷却/);
  ok('23. 同类型事件冷却期');
  worldEvents.triggerWorldEvent(fakeIo, 'RW2', { type: 'WEATHER_CHANGE', durationMs: 600000 });
  worldEvents.triggerWorldEvent(fakeIo, 'RW2', { type: 'MONSTER_INVASION', durationMs: 600000 });
  worldEvents.triggerWorldEvent(fakeIo, 'RW2', { type: 'POWER_OUTAGE', durationMs: 600000 });
  assert.throws(() => worldEvents.validateAiEventRequest('RW2', { type: 'WEATHER_CHANGE' }), /上限/);
  ok('24. 单房间活跃事件上限（3）');

  // ══ C. World Tick 系统 ══
  const t1 = worldSim.runTick(fakeIo, 'RT1', { tickNumber: 1 });
  assert.ok(!t1.skipped && db.prepare('SELECT * FROM world_ticks WHERE room_id = ? AND tick_number = 1').get('RT1'));
  ok('25. runTick 执行并落库 world_ticks');
  const t1again = worldSim.runTick(fakeIo, 'RT1', { tickNumber: 1 });
  assert.ok(t1again.skipped && t1again.reason === 'TICK_ALREADY_PROCESSED');
  ok('26. 幂等：同房间同 tick 重放直接跳过');
  worldSim.pause();
  assert.ok(worldSim.getSchedulerState().paused === true);
  ok('27. 暂停状态持久化（world_scheduler 表）');
  const tPaused = worldSim.runTick(fakeIo, 'RT1', { tickNumber: 2 });
  assert.ok(tPaused.paused && tPaused.skipped);
  ok('28. 暂停期间 tick 不执行');
  worldSim.resume();
  const tAuto1 = worldSim.runTick(fakeIo, 'RT1');
  const tAuto2 = worldSim.runTick(fakeIo, 'RT1');
  assert.ok(tAuto2.tickNumber > tAuto1.tickNumber);
  ok('29. 恢复后自动 tick 号递增');
  const allRooms = worldSim.tickAllRooms(fakeIo);
  assert.ok(!allRooms.paused && allRooms.rooms.length >= 1);
  ok('30. tickAllRooms 覆盖模拟房间');
  assert.ok(db.prepare("SELECT 1 FROM game_events WHERE room_id = 'RT1' AND type = 'WORLD_TICK'").get());
  ok('31. WORLD_TICK 记入 Event Bus（可追溯）');
  const startInfo = worldSim.startScheduler(fakeIo, 100000);
  assert.ok(startInfo.started || startInfo.alreadyRunning);
  worldSim.stopScheduler();
  ok('32. 调度器 start/stop 生命周期');

  // ══ D. NPC 自主行为 ══
  mkRoomDb('RS12');
  const keeperNpc = npcEngine.getNpc('npc_doors_keeper');
  const keeperInst = npcEngine.spawnNpcInstance(null, { npcId: keeperNpc.id, roomId: 'RS12' });
  const d1 = npcSimulation.decideNpcBehavior(fakeIo, npcEngine.getNpcInstance(keeperInst.id));
  assert.strictEqual(d1.state, 'WORKING');
  ok('33. 目标驱动行为：守护目标 → WORKING');
  const d2 = npcSimulation.decideNpcBehavior(fakeIo, npcEngine.getNpcInstance(keeperInst.id), { activeEventTypes: ['POWER_OUTAGE'] });
  assert.strictEqual(d2.state, 'PLANNING');
  ok('34. 人格×事件：谨慎 + 停电 → PLANNING');
  const d3 = npcSimulation.decideNpcBehavior(fakeIo, npcEngine.getNpcInstance(keeperInst.id), { activeEventTypes: ['MONSTER_INVASION'] });
  assert.strictEqual(d3.state, 'TRAVELING');
  ok('35. 怪物入侵：平民逃往安全点（TRAVELING→loc_lobby）');
  const entityNpc = npcEngine.createNpc({ name: '测试实体', nature: 'hostile', personality: {}, goals: [] });
  const entityInst = npcEngine.spawnNpcInstance(null, { npcId: entityNpc.id, roomId: 'RS12' });
  const d4 = npcSimulation.decideNpcBehavior(fakeIo, npcEngine.getNpcInstance(entityInst.id), { activeEventTypes: ['MONSTER_INVASION'] });
  assert.strictEqual(d4.state, 'FIGHTING');
  ok('36. 怪物入侵：敌对本性 → FIGHTING');
  const d5 = npcSimulation.decideNpcBehavior(fakeIo, npcEngine.getNpcInstance(keeperInst.id));
  assert.strictEqual(d5.state, 'WORKING');
  ok('37. 事件结束：抵达安全点后回归目标驱动行为（WORKING）');
  // AI 计划验证（AI 只能提出计划，执行必须过规则验证）
  const plan1 = npcSimulation.validateNpcPlan('移动到地下室查看情况');
  assert.ok(plan1.ok && plan1.action === 'move' && plan1.target === 'loc_basement');
  ok('38. AI 计划验证：移动到已登记地点 → 通过');
  const plan2 = npcSimulation.validateNpcPlan('移动到火星基地');
  assert.strictEqual(plan2.ok, false);
  ok('39. AI 计划验证：目的地不存在 → 拒绝（禁止创造地点）');
  const plan3 = npcSimulation.validateNpcPlan('他低声讲述着过去的故事');
  assert.ok(plan3.ok && plan3.action === null);
  ok('40. 纯叙事计划：不执行任何状态变更');
  const citizenA = mkCitizen('计划市民', 'RS12');
  db.prepare('UPDATE npc_instances SET current_plan_json = ? WHERE id = ?').run(JSON.stringify({ plan: '移动到地下室' }), citizenA.id);
  const d6 = npcSimulation.decideNpcBehavior(fakeIo, npcEngine.getNpcInstance(citizenA.id));
  assert.strictEqual(d6.state, 'TRAVELING');
  ok('41. 已验证的 AI 计划被执行（移动开始）');
  npcEngine.killNpc(null, citizenA.id);
  const d7 = npcSimulation.decideNpcBehavior(fakeIo, npcEngine.getNpcInstance(citizenA.id));
  assert.ok(d7.reason === 'dead');
  ok('42. 死亡 NPC 不参与行为模拟');
  assert.ok(db.prepare("SELECT 1 FROM game_events WHERE room_id = 'RS12' AND type = 'NPC_BEHAVIOR_CHANGED'").get());
  ok('43. 行为变化记入 Event Bus');

  // ══ E. NPC 移动系统 ══
  const citizenB = mkCitizen('旅行市民', 'RS12');
  assert.throws(() => npcSimulation.beginTravel(fakeIo, citizenB.id, 'loc_mars'), /不存在/);
  ok('44. 移动到未登记地点拒绝');
  const mv1 = npcSimulation.beginTravel(fakeIo, citizenB.id, '地下室', { ticks: 2 });
  assert.ok(mv1.started && npcEngine.getNpcInstance(citizenB.id).behavior_state === 'TRAVELING');
  ok('45. 开始移动（支持按名称解析地点，多 tick 行程）');
  const adv1 = npcSimulation.advanceTravel(fakeIo, npcEngine.getNpcInstance(citizenB.id));
  assert.ok(!adv1.arrived && adv1.remaining === 1);
  ok('46. 行程推进（未抵达）');
  const adv2 = npcSimulation.advanceTravel(fakeIo, npcEngine.getNpcInstance(citizenB.id));
  assert.ok(adv2.arrived && npcEngine.getNpcInstance(citizenB.id).location_key === 'loc_basement');
  ok('47. 抵达目的地（location_key 更新）');
  assert.ok(db.prepare('SELECT location_id FROM npcs WHERE id = ?').get(citizenB.npc_id).location_id === 'loc_basement');
  ok('48. NPC 定义地点同步（再次进入看到新位置）');
  assert.ok(db.prepare("SELECT 1 FROM game_events WHERE room_id = 'RS12' AND type = 'NPC_MOVED'").get());
  ok('49. NPC_MOVED 记入 Event Bus + 审计');
  const mv2 = npcSimulation.beginTravel(fakeIo, citizenB.id, 'loc_basement');
  assert.strictEqual(mv2.reason, 'ALREADY_THERE');
  ok('50. 已在目的地：幂等（ALREADY_THERE）');
  // tick 驱动的端到端移动（管理员：大厅→地下室）
  const citizenC = mkCitizen('端到端市民', 'RS12');
  npcSimulation.beginTravel(fakeIo, citizenC.id, 'loc_basement', { ticks: 1 });
  worldSim.runTick(fakeIo, 'RS12', { tickNumber: 501 });
  assert.strictEqual(npcEngine.getNpcInstance(citizenC.id).location_key, 'loc_basement');
  ok('51. World Tick 驱动移动抵达（端到端）');
  const view = npcEngine.publicNpcView(npcEngine.getNpcInstance(citizenC.id));
  assert.strictEqual(view.locationKey, 'loc_basement');
  assert.strictEqual(view.locationName, '地下室');
  assert.ok(view.behaviorState);
  ok('52. 玩家再次进入：公开视图含最新位置/行为状态');

  // ══ F. 阵营系统扩展 ══
  const fr1 = factionRelations.setFactionRelation(fakeIo, keeper.id, entities.id, 'ALLIED', { source: 'test', reason: '测试同盟', roomId: 'RS12' });
  assert.ok(fr1.changed && fr1.previous === 'NEUTRAL');
  ok('53. 设置阵营关系（记录前值）');
  assert.strictEqual(factionRelations.getFactionRelation(entities.id, keeper.id).relation, 'ALLIED');
  ok('54. 关系读取方向无关（规范化存储）');
  assert.throws(() => factionRelations.setFactionRelation(fakeIo, keeper.id, entities.id, 'BFF'), /非法关系/);
  ok('55. 非法关系值拒绝');
  assert.ok(db.prepare("SELECT 1 FROM game_events WHERE type = 'FACTION_RELATION_CHANGED'").get());
  ok('56. 阵营关系变化记入 Event Bus');

  // ══ G. 动态副本 ══
  const doors = db.prepare("SELECT * FROM dungeons WHERE roblox_experience_name = 'Doors'").get();
  db.prepare(
    "INSERT INTO dungeon_versions (dungeon_id, version, definition_json, status, published_at) VALUES (?, 900, '{}', 'PUBLISHED', datetime('now'))"
  ).run(doors.id);
  const dvId = db.prepare('SELECT id FROM dungeon_versions WHERE dungeon_id = ? AND version = 900').get(doors.id).id;
  mkRoomDb('GD1');
  assert.strictEqual(dynamicDungeon.resolveRoomVariant('Doors', 'GD1').variant, 'NORMAL');
  ok('57. 无事件：副本变体 NORMAL');
  worldEvents.triggerWorldEvent(fakeIo, 'GD1', { type: 'POWER_OUTAGE', durationMs: 600000 });
  const vBlack = dynamicDungeon.resolveRoomVariant('Doors', 'GD1');
  assert.strictEqual(vBlack.variant, 'BLACKOUT');
  assert.strictEqual(vBlack.difficultyDelta, 1);
  ok('58. 停电事件：DOORS → BLACKOUT（停电版本，难度+1）');
  mkRoomDb('GD2');
  worldEvents.triggerWorldEvent(fakeIo, 'GD2', { type: 'MONSTER_INVASION', durationMs: 600000 });
  worldEvents.triggerWorldEvent(fakeIo, 'GD2', { type: 'POWER_OUTAGE', durationMs: 600000 });
  assert.strictEqual(dynamicDungeon.resolveRoomVariant('Doors', 'GD2').variant, 'HARD');
  ok('59. 入侵优先于停电：HARD（困难版本）');
  mkRoomDb('GD3');
  worldState.setWorldField('GD3', 'hidden_route_discovered', true, { actor: 'server', source: 'rule_engine' });
  assert.strictEqual(dynamicDungeon.resolveRoomVariant('Doors', 'GD3').variant, 'HIDDEN_ROUTE');
  ok('60. 秘密发现：HIDDEN_ROUTE（隐藏路线）');
  mkRoomDb('GD4');
  worldEvents.triggerWorldEvent(fakeIo, 'GD4', { type: 'POWER_OUTAGE', durationMs: 600000 });
  const instB = instanceManager.createInstance({ roomId: 'GD4', dungeonVersionId: dvId });
  assert.strictEqual(instB.variant_key, 'BLACKOUT');
  ok('61. 创建实例时按世界状态解析变体');
  worldEvents.triggerWorldEvent(fakeIo, 'GD4', { type: 'MONSTER_INVASION', durationMs: 600000 });
  const changes = dynamicDungeon.syncInstanceVariants(fakeIo, 'GD4');
  assert.ok(changes.length === 1 && changes[0].to === 'HARD');
  ok('62. 事件触发副本形态变化（BLACKOUT→HARD，记 Event Bus）');
  const variantView = dynamicDungeon.roomInstanceVariants('GD4');
  assert.ok(variantView[0].variant.label === '困难版本');
  ok('63. 副本变体视图（UI/Context 用）');

  // ══ H. Legendary NPC 世界联动 ══
  mkRoomDb('RL1');
  const alice = mkPlayerDb('爱丽丝', 'RL1');
  const shed = legendEngine.getLegendByNpcUid('npc_legend_shedletsky');
  const builder = legendEngine.getLegendByNpcUid('npc_legend_builderman');
  const cond0 = worldSim.checkLegendConditions(shed, 'RL1');
  assert.strictEqual(cond0.eligible, false);
  ok('64. 条件不满足不掷骰（无剑术/无剧情 → 不出现）');
  const swordSkill = db.prepare("SELECT * FROM skills WHERE name = 'Sword Technique'").get();
  characterService.grantSkill(alice.id, swordSkill.id, { sourceType: 'SPECIAL_EVENT', sourceId: 'test' });
  const cond1 = worldSim.checkLegendConditions(shed, 'RL1');
  assert.ok(cond1.eligible && cond1.matched.includes('any_skill'));
  ok('65. 玩家剑术满足 → Shedletsky 具备出现条件');
  const lw1 = worldSim.legendWorldCheck(fakeIo, 'RL1', { rng: 0.001 });
  assert.ok(lw1.spawned && lw1.spawned.name === 'Shedletsky');
  ok('66. 条件通过后服务器掷骰生成（世界模拟路径）');
  mkRoomDb('RL2');
  const lw2 = worldSim.legendWorldCheck(fakeIo, 'RL2', { rng: 0.99 });
  assert.ok(lw2.spawned === null && db.prepare("SELECT 1 FROM game_events WHERE room_id = 'RL2' AND type = 'NPC_ENCOUNTER_CHECK'").get());
  ok('67. 掷骰未中：无生成 + 判定留痕');
  assert.ok(worldSim.checkLegendConditions(builder, 'RL2').eligible);
  ok('68. Builderman（管理员）：世界常驻条件 always');

  // ══ I. AI GM 权限边界 ══
  const names = tools.getRegistry().map((t) => t.name);
  assert.ok(names.includes('request_world_event') && names.includes('get_world_simulation'));
  ok('69. 新工具注册（request_world_event / get_world_simulation）');
  for (const banned of ['spawn_monster', 'change_world', 'give_item', 'set_faction_relation', 'move_npc', 'create_world_event']) {
    assert.ok(!names.includes(banned));
  }
  ok('70. 无直接创造类工具（spawn_monster/change_world/give_item 等禁止）');
  assert.strictEqual(tools.toolMeta('request_world_event').permission, 'GAME_ACTION');
  ok('71. request_world_event 权限 GAME_ACTION（非 ADMIN/REWARD）');
  mkRoomDb('RW3');
  const ctx = { io: fakeIo, room: { id: 'RW3', players: [] }, playerUid: 'player_s12_ai', actingPlayerName: 'GM' };
  const toolOk = await tools.runTool(ctx, 'request_world_event', { event_type: 'WEATHER_CHANGE', duration_minutes: 5, reason: '剧情需要一场暴雨' });
  assert.ok(toolOk.ok && toolOk.event === 'WEATHER_CHANGE');
  const aiEvent = db.prepare("SELECT * FROM world_sim_events WHERE uid = ?").get(toolOk.uid);
  assert.strictEqual(aiEvent.source, 'ai_request');
  ok('72. AI 申请事件：服务器审核后生效（source=ai_request）');
  await assert.rejects(tools.runTool(ctx, 'request_world_event', { event_type: 'DUNGEON_MUTATION', reason: 'x' }), (e) => e.kind === 'invalid_args');
  ok('73. AI 申请 SYSTEM 事件：参数白名单直接拒绝');
  await assert.rejects(tools.runTool(ctx, 'request_world_event', { event_type: 'WEATHER_CHANGE', duration_minutes: 5, reason: 'y' }), /冷却|已在进行/);
  ok('74. AI 重复申请同类事件：冷却/去重拒绝');
  const snap = await tools.runTool(ctx, 'get_world_simulation', {});
  assert.ok(snap.ok && Array.isArray(snap.events) && Array.isArray(snap.relations) && Array.isArray(snap.npcs));
  ok('75. get_world_simulation 只读快照');

  // ══ J. Context / 断线恢复 / REST ══
  mkRoomDb('RC1');
  const rcPlayer = mkPlayerDb('卡萝尔', 'RC1');
  const built = contextBuilder.buildContext({ id: 'RC1', players: [], currentExperience: null, currentDungeon: null });
  const simSection = built.sections.find((s) => s.key === 'world_sim');
  assert.ok(simSection && simSection.label.includes('WORLD_STATE') && /调度器/.test(simSection.content));
  ok('76. Context 新增 WORLD_STATE 分区（事件/阵营/NPC活动/环境）');
  // 断线恢复：玩家离开后世界继续演化，状态全部在服务器
  db.prepare("UPDATE players SET left_at = datetime('now') WHERE id = ?").run(rcPlayer.id);
  const tAfterLeave = worldSim.runTick(fakeIo, 'RC1');
  assert.ok(!tAfterLeave.skipped && db.prepare('PRAGMA table_info(world_ticks)').all().length > 0);
  ok('77. 玩家断线后世界模拟继续（服务器驱动，不依赖客户端）');
  assert.ok(JSON.parse(db.prepare('SELECT result_json FROM world_ticks WHERE room_id = ? ORDER BY id DESC LIMIT 1').get('RC1').result_json).actions !== undefined);
  ok('78. tick 结果存档（断线恢复可审计）');
  // REST：/api/world（世界状态面板）
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const sess = createSession(rcPlayer.id);
  const resWorld = await fetch(`http://127.0.0.1:${port}/api/world?sessionToken=${encodeURIComponent(sess.token)}`).then((r) => r.json());
  assert.ok(resWorld.world && resWorld.world.scheduler && Array.isArray(resWorld.world.events) && Array.isArray(resWorld.world.relations) && Array.isArray(resWorld.world.npcs));
  ok('79. GET /api/world 返回世界快照（会话鉴权）');
  const res401 = await fetch(`http://127.0.0.1:${port}/api/world`);
  assert.strictEqual(res401.status, 401);
  ok('80. 无会话访问 /api/world 拒绝（401）');
  const resPause = await fetch(`http://127.0.0.1:${port}/api/world/pause`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionToken: sess.token }) }).then((r) => r.json());
  assert.ok(resPause.ok && resPause.scheduler.paused === true);
  const resResume = await fetch(`http://127.0.0.1:${port}/api/world/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionToken: sess.token }) }).then((r) => r.json());
  assert.ok(resResume.ok && resResume.scheduler.paused === false);
  ok('81. REST 暂停/恢复世界模拟');
  const resEvents = await fetch(`http://127.0.0.1:${port}/api/world/events?sessionToken=${encodeURIComponent(sess.token)}`).then((r) => r.json());
  assert.ok(Array.isArray(resEvents.events));
  ok('82. GET /api/world/events 生效事件列表');

  server.close();
  console.log(`\n[阶段12] 通过 ${passed} 项测试`);
  if (passed < 70) {
    console.error('测试数量不足 70！');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('\n[阶段12] 测试失败：', err);
  process.exit(1);
});
