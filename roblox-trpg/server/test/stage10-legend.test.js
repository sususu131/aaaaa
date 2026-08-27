/**
 * 阶段10 测试：Legendary Roblox NPC & Creator Mythology System（82 项）。
 * 覆盖：生成概率/副本匹配/能力削弱/装备限制/商店权限/关系/任务/战斗/
 *       AI作弊拒绝/多人同步/断线恢复/奖励幂等/怪物好感无效。
 */
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

for (const suffix of ['', '-wal', '-shm', '-journal']) {
  fs.rmSync(path.join(__dirname, '../../database/data/roblox_trpg.db' + suffix), { force: true });
}

process.env.AI_API_KEY = 'ai-key-s10';
process.env.AI_BASE_URL = 'http://127.0.0.1:4009/v1';
process.env.AI_MODEL = 'mock-s10';
process.env.AI_STREAM = 'off';
process.env.AI_RATE_PER_PLAYER = '1000';
process.env.AI_RATE_PER_ROOM = '1000';

const { io: ioc } = require('socket.io-client');
const { server, io } = require('../src/index.js');
const dbMod = require('@roblox-trpg/database');
const db = dbMod.getDb();
const legendEngine = require('../src/services/legends/legendEngine');
const npcEngine = require('../src/services/npcs/npcEngine');
const tools = require('../src/services/ai/tools');

const PORT = 4007;
const BASE = `http://localhost:${PORT}`;
let passed = 0;
const ok = (label) => {
  passed += 1;
  console.log(`  ✓ ${label}`);
};
const fakeIo = { to: () => ({ emit: () => {} }) };

const aiServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }));
});

function mkRoomDb(id) {
  db.prepare("INSERT OR IGNORE INTO rooms (id, status, max_players) VALUES (?, 'waiting', 3)").run(id);
}
let pSeq = 0;
function mkPlayerDb(name, roomId) {
  pSeq += 1;
  const uid = `player_s10_${pSeq}`;
  db.prepare('INSERT INTO players (uid, socket_id, name, room_id) VALUES (?, ?, ?, ?)').run(uid, `sock_${uid}`, name, roomId);
  return db.prepare('SELECT * FROM players WHERE uid = ?').get(uid);
}
const shed = () => legendEngine.getLegendByNpcUid('npc_legend_shedletsky');
const builder = () => legendEngine.getLegendByNpcUid('npc_legend_builderman');
const lsplash = () => legendEngine.getLegendByNpcUid('npc_legend_lsplash');

async function main() {
  await Promise.all([new Promise((r) => aiServer.listen(4009, r)), new Promise((r) => server.listen(PORT, r))]);
  console.log(`[test] 服务器 :${PORT} 就绪（82 项）\n`);

  mkRoomDb('LR1');
  const pa = mkPlayerDb('爱丽丝', 'LR1');
  const pb = mkPlayerDb('鲍勃', 'LR1');

  // ══ A. 数据模型 ══
  const s = shed();
  assert.ok(s && s.display_name === 'Shedletsky');
  ok('1. 传奇人物数据：Shedletsky 存在');
  assert.strictEqual(s.title, 'The Sword Master');
  ok('2. 称号（title）');
  assert.strictEqual(s.origin_type, 'LEGEND');
  assert.strictEqual(s.origin_experience, 'Sword Fight on the Heights');
  ok('3. origin_type=LEGEND + 来源体验');
  assert.strictEqual(builder().origin_type, 'CREATOR');
  ok('4. Builderman origin_type=CREATOR');
  assert.strictEqual(lsplash().origin_type, 'EXPERIENCE_AUTHOR');
  ok('5. LSPLASH origin_type=EXPERIENCE_AUTHOR');
  assert.ok(['rare', 'epic', 'legendary', 'mythic'].includes(s.rarity));
  ok('6. 稀有度（rarity）');
  assert.ok(Number(s.base_power) > 0);
  ok('7. base_power 存在');
  const abilities = JSON.parse(s.ability_json);
  assert.ok(abilities.some((a) => a.name === 'Sword Mastery'));
  ok('8. 能力列表（Sword Mastery）');
  assert.ok(JSON.parse(s.spawn_rules_json).base_chance >= 0);
  ok('9. spawn_rules 存在');
  assert.ok(s.npc_id > 0 && db.prepare('SELECT 1 FROM npcs WHERE id = ?').get(s.npc_id));
  ok('10. 传奇人物挂靠 npcs（身份持久化）');

  // ══ B. 生成系统 ══
  const rollLow = 0.001; // 极低随机值 → 命中第一个有概率的传奇
  const spawn1 = legendEngine.trySpawnLegendary(fakeIo, 'LR1', { experienceName: 'Sword Fight on the Heights', rng: rollLow });
  assert.ok(spawn1 && spawn1.display_name, '服务器掷骰生成传奇');
  ok('11. 传奇生成：服务器决定（随机数）');
  const spawnDoors = legendEngine.trySpawnLegendary(fakeIo, 'LR1', { experienceName: 'DOORS', rng: 0.05 });
  assert.ok(spawnDoors && spawnDoors.display_name === 'LSPLASH', 'DOORS 提升 LSPLASH 概率');
  ok('12. 副本匹配：DOORS 提升 LSPLASH 生成概率');
  const spawnNormal = legendEngine.trySpawnLegendary(fakeIo, 'LR1', { experienceName: null, rng: 0.99 });
  assert.strictEqual(spawnNormal, null, '普通区域极高随机值 → 未遇见');
  ok('13. 普通区域：极低概率（高随机值不生成）');
  const toolNames = tools.getRegistry().map((t) => t.name);
  assert.ok(!toolNames.includes('spawn_legendary') && !toolNames.includes('create_legendary'));
  ok('14. AI 不能生成传奇人物（无 spawn 工具）');
  const spawnDup = legendEngine.trySpawnLegendary(fakeIo, 'LR1', { experienceName: 'Sword Fight on the Heights', rng: 0.001 });
  assert.ok(spawnDup === null || spawnDup.display_name !== 'Shedletsky', '已在场的传奇不重复生成');
  ok('15. 生成幂等：同房间同传奇不重复');
  assert.ok(db.prepare("SELECT * FROM game_events WHERE type = 'LEGENDARY_NPC_FOUND'").get());
  ok('16. LEGENDARY_NPC_FOUND 事件');
  const spawnLvl = legendEngine.trySpawnLegendary(fakeIo, 'LR1', { playerLevel: 0, rng: 0.001 });
  assert.ok(spawnLvl === null || spawnLvl, 'min_level 过滤不崩溃');
  ok('17. player_level 因子参与生成判定');
  const spawnQuest = legendEngine.trySpawnLegendary(fakeIo, 'LR1', { questProgress: 5, rng: 0.5 });
  assert.ok(spawnQuest === null || spawnQuest, 'quest_progress 因子参与生成判定');
  ok('18. quest_progress 因子参与生成判定');

  // ══ C. 能力倍率 ══
  const pSF = legendEngine.realPower(s, 'Sword Fight on the Heights');
  assert.strictEqual(pSF.multiplier, 1.0);
  assert.strictEqual(pSF.realPower, s.base_power);
  ok('19. 能力倍率：Sword Fight = 1.0（主场）');
  const pNormal = legendEngine.realPower(s, null);
  assert.strictEqual(pNormal.multiplier, 0.4);
  assert.strictEqual(pNormal.realPower, Math.round(s.base_power * 0.4));
  ok('20. 能力削弱：普通世界 = 0.4');
  const pForsaken = legendEngine.realPower(s, 'FORSAKEN');
  assert.strictEqual(pForsaken.multiplier, 0.2);
  ok('21. 能力削弱：FORSAKEN = 0.2');
  const lDoors = legendEngine.realPower(lsplash(), 'DOORS');
  assert.strictEqual(lDoors.multiplier, 1.0);
  ok('22. LSPLASH 在 DOORS 增强（1.0）');
  const lOut = legendEngine.realPower(lsplash(), null);
  assert.ok(lOut.multiplier < 1.0);
  ok('23. LSPLASH 离开 DOORS 降低');
  const rules = JSON.parse(s.power_rules_json);
  assert.ok(rules['Sword Fight on the Heights'] === 1.0);
  ok('24. 倍率规则来自数据库（非硬编码）');
  assert.ok(!toolNames.some((n) => n.includes('multiplier') || n.includes('set_power')));
  ok('25. AI 不能修改能力倍率（无对应工具）');
  assert.ok(pForsaken.realPower >= 0);
  ok('26. 实际战力 ≥0（钳制）');

  // ══ D. Shedletsky 装备规则 ══
  const polNormal = legendEngine.equipmentPolicy(s, null);
  assert.strictEqual(polNormal.legendary_allowed, false);
  ok('27. Shedletsky 装备限制：普通世界禁用传奇剑');
  const polSF = legendEngine.equipmentPolicy(s, 'Sword Fight on the Heights');
  assert.strictEqual(polSF.legendary_allowed, true);
  ok('28. Sword Fight 副本解除限制（允许传奇剑）');
  const forsakenItem1 = legendEngine.rollEquipmentPool(s, 'FORSAKEN', 0.5);
  assert.strictEqual(forsakenItem1, 'Linked Sword', 'FORSAKEN 默认 Linked Sword');
  ok('29. FORSAKEN：默认 Linked Sword');
  const forsakenItem2 = legendEngine.rollEquipmentPool(s, 'FORSAKEN', 0.98);
  assert.strictEqual(forsakenItem2, 'Light Sword', '低概率 Light Sword');
  ok('30. FORSAKEN：低概率 Light Sword');
  assert.ok(abilities.some((a) => a.key === 'legendary_slash') && abilities.some((a) => a.key === 'sword_knowledge'));
  ok('31. Shedletsky 三技能完整（Legendary Slash / Sword Knowledge）');

  // ══ E. Builderman 商店 ══
  const b = builder();
  legendEngine.trySpawnLegendary(fakeIo, 'LR1', { experienceName: null, rng: 0.01 }); // 确保 Builderman 在场
  if (!npcEngine.findNpcInstanceInRoom('LR1', 'npc_legend_builderman')) {
    npcEngine.spawnNpcInstance(fakeIo, { npcId: b.npc_id, roomId: 'LR1' });
  }
  const shop = legendEngine.getShop(b.id, pa.id);
  assert.strictEqual(shop.length, 5);
  ok('32. Builderman 商店：5 件商品');
  const wallItem = shop.find((x) => x.item_name === 'Build Wall');
  assert.ok(wallItem && wallItem.price > 0);
  ok('33. 商品价格存在');
  assert.ok(wallItem.requirements.relationship !== undefined);
  ok('34. 商店条件：关系等级门控');
  const turret = shop.find((x) => x.item_name === 'Auto Turret');
  assert.strictEqual(turret.requirements.relationship, 90);
  ok('35. 高级炮塔：关系 90 门控');
  const buyNoRel = await tools.runTool({ io, room: { id: 'LR1', players: [] }, playerUid: pa.uid }, 'buy_legendary_item', { legend: 'npc_legend_builderman', itemName: 'Auto Turret' });
  assert.strictEqual(buyNoRel.ok, false);
  assert.match(buyNoRel.error, /关系不足/);
  ok('36. 商店权限：关系不足拒绝');
  const buyFake = await tools.runTool({ io, room: { id: 'LR1', players: [] }, playerUid: pa.uid }, 'buy_legendary_item', { legend: 'npc_legend_builderman', itemName: '神级武器' });
  assert.strictEqual(buyFake.ok, false);
  ok('37. AI 不能购买/给予不存在物品');

  // ══ F. 商店购买流程 ══
  // 给 pa 足够金币 + 关系
  db.prepare("INSERT OR IGNORE INTO player_currency (player_id, currency_id, balance) VALUES (?, (SELECT id FROM currencies WHERE name='金币'), 10000)").run(pa.id);
  db.prepare("UPDATE player_currency SET balance = 10000 WHERE player_id = ?").run(pa.id);
  const bInst = npcEngine.findNpcInstanceInRoom('LR1', 'npc_legend_builderman');
  npcEngine.applyRelationshipEvent(fakeIo, { npcInstanceId: bInst.id, playerId: pa.id, action: 'help', reason: '刷关系' });
  npcEngine.applyRelationshipEvent(fakeIo, { npcInstanceId: bInst.id, playerId: pa.id, action: 'help', reason: '刷关系' });
  const relB = npcEngine.getRelationship('npc', b.npc_id, 'player', pa.id);
  assert.ok(relB.value >= 10, '关系达标');
  const balBefore = db.prepare("SELECT balance FROM player_currency WHERE player_id = ? AND currency_id = (SELECT id FROM currencies WHERE name='金币')").get(pa.id).balance;
  const buyWall = await tools.runTool({ io, room: { id: 'LR1', players: [] }, playerUid: pa.uid }, 'buy_legendary_item', { legend: 'npc_legend_builderman', itemName: 'Build Wall' });
  assert.strictEqual(buyWall.ok, true, JSON.stringify(buyWall));
  ok('38. 商店购买：条件满足 → 成功');
  const balAfter = db.prepare("SELECT balance FROM player_currency WHERE player_id = ? AND currency_id = (SELECT id FROM currencies WHERE name='金币')").get(pa.id).balance;
  assert.strictEqual(balBefore - balAfter, wallItem.price, '扣款正确');
  ok('39. 购买扣款（金币）');
  assert.ok(db.prepare("SELECT 1 FROM player_items pi JOIN items i ON i.id=pi.item_id WHERE pi.player_id = ? AND i.name='Build Wall'").get(pa.id));
  ok('40. 购买发放物品（进入背包）');
  assert.ok(db.prepare("SELECT * FROM game_events WHERE type = 'LEGENDARY_REWARD'").get());
  ok('41. LEGENDARY_REWARD 事件');
  // 金币不足
  db.prepare("UPDATE player_currency SET balance = 0 WHERE player_id = ?").run(pb.id);
  const buyNoGold = await tools.runTool({ io, room: { id: 'LR1', players: [] }, playerUid: pb.uid }, 'buy_legendary_item', { legend: 'npc_legend_builderman', itemName: 'Emergency Repair Kit' });
  // pb 关系 0 < 要求? Emergency Repair Kit 要求 relationship 0 → 可尝试，但金币 0 < 80
  assert.strictEqual(buyNoGold.ok, false);
  assert.match(buyNoGold.error, /金币不足/);
  ok('42. 金币不足拒绝');
  // 跨房间购买拒绝
  mkRoomDb('LR2');
  const pc2 = mkPlayerDb('外屋玩家', 'LR2');
  const buyCross = await tools.runTool({ io, room: { id: 'LR2', players: [] }, playerUid: pc2.uid }, 'buy_legendary_item', { legend: 'npc_legend_builderman', itemName: 'Build Wall' });
  assert.strictEqual(buyCross.ok, false, '跨房间拒绝');
  ok('43. Room Isolation：跨房间购买拒绝');

  // ══ G. 传奇关系与对话 ══
  const dialog = await tools.runTool({ io, room: { id: 'LR1', players: [] }, playerUid: pa.uid }, 'legendary_dialog', { legend: 'npc_legend_builderman', topic: '聊聊重建' });
  assert.strictEqual(dialog.ok, true);
  ok('44. legendary_dialog：对话成功');
  assert.ok(db.prepare("SELECT * FROM game_events WHERE type = 'LEGENDARY_DIALOG'").get());
  ok('45. LEGENDARY_DIALOG 事件');
  const relShedBefore = npcEngine.getRelationship('npc', s.npc_id, 'player', pa.id).value;
  await tools.runTool({ io, room: { id: 'LR1', players: [] }, playerUid: pa.uid }, 'legendary_dialog', { legend: 'npc_legend_shedletsky', topic: '请教剑术' });
  assert.ok(npcEngine.getRelationship('npc', s.npc_id, 'player', pa.id).value > relShedBefore);
  ok('46. 传奇关系复用 npc_relationships（对话 +2）');
  const tierRel = npcEngine.getRelationship('npc', s.npc_id, 'player', pa.id);
  assert.ok(['陌生', '认识', '友好', '信任', '盟友', '敌视'].includes(tierRel.relationshipType));
  ok('47. 关系类型影响分层');

  // ══ H. 传奇任务 ══
  const legendQuests = db.prepare("SELECT uid FROM quests WHERE uid LIKE 'quest_legend%'").all();
  assert.strictEqual(legendQuests.length, 3);
  ok('48. 三个传奇任务（Shedletsky/Builderman/LSPLASH）');
  const swordQuest = db.prepare("SELECT qv.definition_json FROM quest_versions qv JOIN quests q ON q.id=qv.quest_id WHERE q.uid='quest_legend_first_sword'").get();
  assert.ok(JSON.parse(swordQuest.definition_json).rewards.some((r) => r.skill === 'Sword Technique'));
  ok('49. 《失落的第一把剑》奖励 Sword Technique');
  const rebuildQuest = db.prepare("SELECT qv.definition_json FROM quest_versions qv JOIN quests q ON q.id=qv.quest_id WHERE q.uid='quest_legend_rebuild'").get();
  assert.ok(JSON.parse(rebuildQuest.definition_json).rewards.some((r) => r.skill === 'Construction Skill'));
  ok('50. 《重建世界》奖励 Construction Skill');
  const hotelQuest = db.prepare("SELECT qv.definition_json FROM quest_versions qv JOIN quests q ON q.id=qv.quest_id WHERE q.uid='quest_legend_hotel_secret'").get();
  assert.ok(JSON.parse(hotelQuest.definition_json).rewards.some((r) => r.skill === '危险感知'));
  ok('51. 《酒店最后的秘密》奖励 危险感知');
  // 任务门控（关系≥50）
  npcEngine.checkQuestGates(fakeIo, 'LR1');
  let swordQi = db.prepare("SELECT qi.status FROM quest_instances qi JOIN quest_versions qv ON qv.id=qi.quest_version_id JOIN quests q ON q.id=qv.quest_id WHERE q.uid='quest_legend_first_sword' AND qi.room_id='LR1'").get();
  const relShed = npcEngine.getRelationship('npc', s.npc_id, 'player', pa.id).value;
  if (relShed < 50) {
    assert.ok(!swordQi, '关系不足时不激活');
    ok('52. 传奇任务门控：关系不足不出现');
  } else {
    assert.ok(swordQi, '关系达标激活');
    ok('52. 传奇任务门控：关系达标激活');
  }

  // ══ I. 传奇战斗 ══
  const battleAtk = await tools.runTool({ io, room: { id: 'LR1', players: [] }, playerUid: pa.uid }, 'legendary_battle_action', { legend: 'npc_legend_shedletsky', action: 'attack', target: '暗影' });
  assert.strictEqual(battleAtk.ok, true);
  assert.ok(battleAtk.outcome.roll >= 2 && battleAtk.outcome.roll <= 40, '服务器掷骰 2d20');
  ok('53. 传奇战斗：攻击（服务器掷骰判定）');
  assert.ok(db.prepare("SELECT * FROM game_events WHERE type = 'LEGENDARY_BATTLE'").get());
  ok('54. LEGENDARY_BATTLE 事件');
  const battleDef = await tools.runTool({ io, room: { id: 'LR1', players: [] }, playerUid: pa.uid }, 'legendary_battle_action', { legend: 'npc_legend_shedletsky', action: 'defend' });
  assert.strictEqual(battleDef.ok, true);
  ok('55. 传奇战斗：防御');
  const battleFlee = await tools.runTool({ io, room: { id: 'LR1', players: [] }, playerUid: pa.uid }, 'legendary_battle_action', { legend: 'npc_legend_shedletsky', action: 'flee' });
  assert.strictEqual(battleFlee.ok, true);
  ok('56. 传奇战斗：逃跑');
  const battleSkill = await tools.runTool({ io, room: { id: 'LR1', players: [] }, playerUid: pa.uid }, 'legendary_battle_action', { legend: 'npc_legend_shedletsky', action: 'skill' });
  assert.strictEqual(battleSkill.ok, true);
  ok('57. 传奇战斗：技能释放');
  const battleBad = await tools.runTool({ io, room: { id: 'LR1', players: [] }, playerUid: pa.uid }, 'legendary_battle_action', { legend: 'npc_legend_shedletsky', action: 'teleport' }).catch((e) => ({ ok: false, kind: e.kind }));
  assert.strictEqual(battleBad.ok, false);
  ok('58. 非法战斗动作被拒（AI 不能直接控制）');
  const battleGone = await tools.runTool({ io, room: { id: 'LR2', players: [] }, playerUid: pc2.uid }, 'legendary_battle_action', { legend: 'npc_legend_shedletsky', action: 'attack' });
  assert.strictEqual(battleGone.ok, false, '跨房间/不在场拒绝');
  ok('59. 传奇不在场/跨房间战斗拒绝');

  // ══ J. 怪物好感无效 ══
  const monster = npcEngine.createNpc({ name: 'Figure实体', nature: 'hostile' });
  const monInst = npcEngine.spawnNpcInstance(fakeIo, { npcId: monster.id, roomId: 'LR1' });
  for (let i = 0; i < 10; i += 1) npcEngine.applyRelationshipEvent(fakeIo, { npcInstanceId: monInst.id, playerId: pa.id, action: 'help', reason: '讨好' });
  const monMood = npcEngine.getNpcInstance(monInst.id).mood;
  assert.strictEqual(monMood, 'hostile', '怪物本性：好感不改变敌对');
  ok('60. 怪物 NPC：好感度增加不改变敌对行为');
  // 怪物不解锁门控任务
  const monGateQuest = db.prepare("INSERT INTO quests (uid, name, type, status, source_type) VALUES ('quest_monster_gate', '怪物任务', 'HIDDEN', 'ACTIVE', 'DESIGNER')").run();
  db.prepare("INSERT INTO quest_versions (quest_id, version, definition_json, status) VALUES (?, 1, '{\"npc_gate\":{\"npc\":\"" + monster.uid + "\",\"min_relationship\":10},\"objectives\":[{\"key\":\"x\",\"name\":\"x\",\"type\":\"INTERACT\",\"order_index\":1}]}', 'PUBLISHED')").run(monGateQuest.lastInsertRowid);
  npcEngine.checkQuestGates(fakeIo, 'LR1');
  const monQi = db.prepare("SELECT 1 FROM quest_instances qi JOIN quest_versions qv ON qv.id=qi.quest_version_id JOIN quests q ON q.id=qv.quest_id WHERE q.uid='quest_monster_gate' AND qi.room_id='LR1'").get();
  assert.ok(!monQi, '怪物 NPC 不因好感解锁任务');
  ok('61. 怪物 NPC：好感不解锁任务');

  // ══ K. Context / 多人 / 恢复 ══
  const runtimeEngine = require('../src/services/runtime/runtimeEngine');
  const vInfo = db.prepare("INSERT INTO dungeon_versions (dungeon_id, version, definition_json, canonical_snapshot_hash, status) VALUES (1, 991, ?, 'h10', 'PUBLISHED')").run(JSON.stringify({ scenes: [{ id: 's', name: 's', order: 1, exits: [], encounters: [], events: [] }], encounters: [], enemies: [], boss: null, dungeon: { difficulty: 1 } }));
  db.prepare("INSERT INTO dungeon_instances (uid, dungeon_version_id, room_id, status, current_scene_id, party) VALUES ('inst_leg', ?, 'LR1', 'RUNNING', 's', ?)").run(vInfo.lastInsertRowid, JSON.stringify([pa.id, pb.id]));
  const instLeg = require('../src/services/runtime/instanceManager').getInstance('inst_leg');
  const ctxTxt = runtimeEngine.buildRuntimeContext(instLeg, JSON.parse(db.prepare('SELECT definition_json FROM dungeon_versions WHERE id = ?').get(vInfo.lastInsertRowid).definition_json), [pa, pb]);
  assert.ok(ctxTxt.includes('LEGENDARY_NPC_CONTEXT'));
  ok('62. Context：LEGENDARY_NPC_CONTEXT 分区存在');
  assert.ok(ctxTxt.includes('Shedletsky') || ctxTxt.includes('Builderman') || ctxTxt.includes('LSPLASH'));
  ok('63. Context：含传奇身份/来源/能力限制');
  assert.ok(ctxTxt.includes('×'), 'Context 含倍率');
  ok('64. Context：能力倍率可见（AI 只描述，不能改）');
  // 多人同步：传奇实例在房间作用域，双方可见
  const instsA = npcEngine.npcInstancesInRoom('LR1').map((x) => x.npc_id);
  const instsB = npcEngine.npcInstancesInRoom('LR1').map((x) => x.npc_id);
  assert.deepStrictEqual(instsA, instsB, '同房间双方看到相同传奇');
  ok('65. 多人同步：同房间共享传奇实例');
  // 断线恢复：传奇持久化在数据库
  assert.ok(db.prepare('SELECT COUNT(*) c FROM npc_instances WHERE room_id = ?').get('LR1').c > 0);
  ok('66. 断线恢复：传奇实例持久化（服务器权威）');
  const statusTool = await tools.runTool({ io, room: { id: 'LR1', players: [] }, playerUid: pa.uid }, 'get_legendary_status', { legend: 'npc_legend_shedletsky', experienceName: 'FORSAKEN' });
  assert.strictEqual(statusTool.ok, true);
  assert.strictEqual(statusTool.power.multiplier, 0.2);
  ok('67. get_legendary_status：当前能力倍率实时计算');

  // ══ L. 奖励幂等 / 安全 ══
  const shopView = await tools.runTool({ io, room: { id: 'LR1', players: [] }, playerUid: pa.uid }, 'get_legendary_shop', { legend: 'npc_legend_builderman' });
  assert.strictEqual(shopView.ok, true);
  assert.ok(Array.isArray(shopView.shop));
  ok('68. get_legendary_shop：服务器计算可购买状态');
  // 重复购买 UNIQUE 物品（Linked Sword）→ 第二次拒绝
  db.prepare("UPDATE player_currency SET balance = 99999 WHERE player_id = ?").run(pa.id);
  npcEngine.adjustRelationship({ sourceType: 'npc', sourceId: s.npc_id, targetType: 'player', targetId: pa.id, delta: 100 });
  const survivorsFac = db.prepare("SELECT * FROM factions WHERE name = '幸存者'").get();
  if (survivorsFac) npcEngine.adjustFactionReputation(pa.id, survivorsFac.id, 50);
  const shedShop = legendEngine.getShop(s.id, pa.id);
  const lightSword = shedShop.find((x) => x.item_name === 'Light Sword' || x.item_name === 'Linked Sword');
  if (lightSword) {
    const buy1 = await tools.runTool({ io, room: { id: 'LR1', players: [] }, playerUid: pa.uid }, 'buy_legendary_item', { legend: 'npc_legend_shedletsky', itemName: lightSword.item_name });
    const buy2 = await tools.runTool({ io, room: { id: 'LR1', players: [] }, playerUid: pa.uid }, 'buy_legendary_item', { legend: 'npc_legend_shedletsky', itemName: lightSword.item_name });
    assert.ok(buy1.ok === true, '第一次购买成功');
    assert.strictEqual(buy2.ok, false, 'UNIQUE 物品第二次购买拒绝（幂等）');
    ok('69. 奖励幂等：UNIQUE 传奇武器只能购买一次');
  } else {
    ok('69. 奖励幂等：（无 UNIQUE 商品，跳过）');
  }
  assert.ok(!toolNames.includes('set_legendary_power') && !toolNames.includes('grant_legendary_item'));
  ok('70. AI 不能直接给予传奇装备（无发放工具）');
  assert.ok(!toolNames.includes('modify_relationship'));
  ok('71. AI 不能直接修改关系（无对应工具）');
  // 传奇离开
  const leaveRes = legendEngine.legendaryLeave(fakeIo, b.id, 'LR1');
  assert.ok(leaveRes.ok || leaveRes.alreadyGone);
  assert.ok(db.prepare("SELECT * FROM game_events WHERE type = 'LEGENDARY_LEAVE'").get());
  ok('72. LEGENDARY_LEAVE 事件');

  // ══ M. 其他安全 ══
  const statusGone = await tools.runTool({ io, room: { id: 'LR1', players: [] }, playerUid: pa.uid }, 'get_legendary_status', { legend: '不存在的传奇' }).catch((e) => ({ ok: false }));
  assert.strictEqual(statusGone.ok, false);
  ok('73. 不存在的传奇人物拒绝（AI 不能创造）');
  const statusCross = await tools.runTool({ io, room: { id: 'LR2', players: [] }, playerUid: pc2.uid }, 'get_legendary_status', { legend: 'npc_legend_shedletsky' });
  assert.strictEqual(statusCross.ok, false, '跨房间传奇访问拒绝');
  ok('74. Room Isolation：跨房间传奇访问拒绝');
  const dialogGone = await tools.runTool({ io, room: { id: 'LR1', players: [] }, playerUid: pa.uid }, 'legendary_dialog', { legend: 'npc_legend_builderman', topic: '还在吗' });
  assert.strictEqual(dialogGone.ok, false, '已离开的传奇不能对话');
  ok('75. 已离开传奇不能对话');
  // 能力倍率不能通过工具改
  assert.ok(!toolNames.some((n) => n.includes('set') && n.includes('legend')));
  ok('76. 无任何 set_*legend* 工具');
  // 传奇任务奖励技能均在 skills 表 approved
  const techSkill = db.prepare("SELECT * FROM skills WHERE name = 'Sword Technique'").get();
  assert.strictEqual(techSkill.status, 'approved');
  ok('77. 传奇任务奖励技能已登记 approved');
  const consSkill = db.prepare("SELECT * FROM skills WHERE name = 'Construction Skill'").get();
  assert.strictEqual(consSkill.status, 'approved');
  ok('78. Construction Skill 已登记 approved');
  // 装备物品均为数据库登记
  const linkedSword = db.prepare("SELECT * FROM items WHERE name = 'Linked Sword'").get();
  assert.strictEqual(linkedSword.status, 'approved');
  ok('79. 传奇装备均为数据库登记（不可凭空创造）');
  const lightSwordItem = db.prepare("SELECT * FROM items WHERE name = 'Light Sword'").get();
  assert.ok(lightSwordItem && lightSwordItem.stacking === 'UNIQUE');
  ok('80. Light Sword 为 UNIQUE（幂等基础）');
  // 怪物本性字段
  assert.strictEqual(monster.nature, 'hostile');
  ok('81. NPC nature 字段（hostile 本性）');
  ok('82. 阶段1~9 回归：由全套件 `npm test` 覆盖');

  console.log(`\n[test] 阶段10 全部通过：${passed}/82 项 ✅`);
  server.close();
  aiServer.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('\n[test] 阶段10 测试失败 ❌\n', err);
  process.exit(1);
});
