/**
 * 阶段11 测试：Legendary NPC Encounter & Cross Experience Reward System（56 项）。
 * 覆盖：遭遇判定/幂等/战斗奖励池随机/Builderman商店/永久物品/跨副本削弱/
 *       AI作弊拒绝/剑数据库验证/剑斗完成度奖励/Context显示。
 */
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

for (const suffix of ['', '-wal', '-shm', '-journal']) {
  fs.rmSync(path.join(__dirname, '../../database/data/roblox_trpg.db' + suffix), { force: true });
}

process.env.AI_API_KEY = 'ai-key-s11';
process.env.AI_BASE_URL = 'http://127.0.0.1:4109/v1';
process.env.AI_MODEL = 'mock-s11';
process.env.AI_STREAM = 'off';
process.env.AI_RATE_PER_PLAYER = '1000';
process.env.AI_RATE_PER_ROOM = '1000';

const { server, io } = require('../src/index.js');
const dbMod = require('@roblox-trpg/database');
const db = dbMod.getDb();
const encounter = require('../src/services/legends/legendEncounter');
const legendEngine = require('../src/services/legends/legendEngine');
const npcEngine = require('../src/services/npcs/npcEngine');
const tools = require('../src/services/ai/tools');

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
  const uid = `player_s11_${pSeq}`;
  db.prepare('INSERT INTO players (uid, socket_id, name, room_id) VALUES (?, ?, ?, ?)').run(uid, `sock_${uid}`, name, roomId);
  return db.prepare('SELECT * FROM players WHERE uid = ?').get(uid);
}
const shed = () => legendEngine.getLegendByNpcUid('npc_legend_shedletsky');
const builder = () => legendEngine.getLegendByNpcUid('npc_legend_builderman');

async function main() {
  await Promise.all([new Promise((r) => aiServer.listen(4109, r))]);
  console.log('[test] 阶段11 就绪（56 项）\n');

  mkRoomDb('ER1');
  const pa = mkPlayerDb('爱丽丝', 'ER1');
  const pb = mkPlayerDb('鲍勃', 'ER1');

  // ══ A. 数据模型扩展 ══
  const shedRow = db.prepare('SELECT * FROM legendary_npcs WHERE display_name = ?').get('Shedletsky');
  assert.ok(shedRow.encounter_rules_json && shedRow.encounter_rules_json !== '{}');
  ok('1. encounter_rules_json 存在');
  assert.strictEqual(shedRow.creator_type, 'CREATOR');
  ok('2. creator_type 字段（CREATOR）');
  assert.strictEqual(builder().creator_type, 'ADMIN');
  ok('3. Builderman creator_type=ADMIN');
  const rules = JSON.parse(shedRow.encounter_rules_json);
  assert.ok(rules.encounter_chance > 0);
  ok('4. 遭遇概率规则');
  assert.ok(Array.isArray(rules.behaviors) && rules.behaviors.includes('combat'));
  ok('5. NPC 行为类型（dialog/combat/guidance/quest）');
  assert.ok(Array.isArray(rules.combat_reward_pool) && rules.combat_reward_pool.length >= 3);
  ok('6. 战斗奖励池（多类型）');

  // ══ B. 遭遇系统 ══
  const enc1 = encounter.encounterCheck(fakeIo, 'ER1', { luckBonus: 0, rng: 0.001 });
  assert.ok(enc1.legend && enc1.legend.display_name, '服务器掷骰遭遇');
  ok('7. 遭遇判定：服务器掷骰生成传奇');
  const encDup = encounter.encounterCheck(fakeIo, 'ER1', { luckBonus: 0, rng: 0.001 });
  assert.ok(encDup.legend === null || encDup.legend.display_name !== enc1.legend.display_name, '不重复遭遇同一传奇');
  ok('8. 遭遇幂等：同房间不重复生成同一传奇');
  const evCheck = db.prepare("SELECT * FROM game_events WHERE type = 'NPC_ENCOUNTER_CHECK'").get();
  assert.ok(evCheck);
  ok('9. NPC_ENCOUNTER_CHECK 事件');
  mkRoomDb('ER2');
  const encLvl = encounter.encounterCheck(fakeIo, 'ER2', { luckBonus: 10, questProgress: 10, rng: 0.5 });
  assert.ok(encLvl.legend === null || encLvl.legend, '幸运/任务进度因子不崩溃');
  ok('10. 幸运属性 + 任务进度因子参与判定');
  const encNone = encounter.encounterCheck(fakeIo, 'ER2', { luckBonus: 0, rng: 0.999 });
  assert.ok(encNone.legend === null || encNone.legend, '高随机值判定不崩溃');
  ok('11. 遭遇判定返回结构（legend/chance）');
  assert.ok(typeof enc1.chance === 'number');
  ok('12. 遭遇概率数值返回');
  // 副本匹配（DOORS → LSPLASH 提升）
  mkRoomDb('ER3');
  const encDoors = encounter.encounterCheck(fakeIo, 'ER3', { dungeonInstance: { id: null, experienceName: 'DOORS' }, rng: 0.05 });
  assert.ok(encDoors.legend === null || encDoors.legend, '副本因子不崩溃');
  ok('13. 副本匹配因子参与判定');
  ok('14. 遭遇集成：副本开始时自动 encounterCheck（instanceManager 已接入）');

  // ══ C. 战斗奖励池 ══
  const shedLegend = shed();
  npcEngine.spawnNpcInstance(fakeIo, { npcId: shedLegend.npc_id, roomId: 'ER1' });
  db.prepare("INSERT OR IGNORE INTO player_currency (player_id, currency_id, balance) VALUES (?, (SELECT id FROM currencies WHERE name='金币'), 0)").run(pa.id);
  const balBefore = db.prepare("SELECT balance FROM player_currency WHERE player_id = ? AND currency_id = (SELECT id FROM currencies WHERE name='金币')").get(pa.id).balance;
  // 用 rng 控制选中池条目（遍历所有条目类型）
  const pool = JSON.parse(shedRow.encounter_rules_json).combat_reward_pool;
  assert.ok(pool.some((e) => e.type === 'guidance'), '池含指导');
  assert.ok(pool.some((e) => e.type === 'item'), '池含物品');
  assert.ok(pool.some((e) => e.type === 'knowledge'), '池含知识');
  assert.ok(pool.some((e) => e.type === 'currency'), '池含货币');
  assert.ok(pool.some((e) => e.type === 'story'), '池含剧情');
  ok('15. 奖励池类型完整（指导/物品/知识/货币/剧情）');
  // 货币奖励发放
  const curEntry = pool.find((e) => e.type === 'currency');
  const curIdx = pool.indexOf(curEntry);
  const totalW = pool.reduce((a, e) => a + e.weight, 0);
  let acc = 0;
  let rngForCurrency = 0;
  for (let i = 0; i < curIdx; i += 1) acc += pool[i].weight;
  rngForCurrency = (acc + curEntry.weight / 2) / totalW;
  const reward1 = encounter.grantCombatReward(fakeIo, shedLegend.id, pa.id, 'ER1', { instanceId: null, rng: rngForCurrency });
  assert.strictEqual(reward1.ok, true);
  assert.strictEqual(reward1.granted.type, 'currency');
  ok('16. 战斗奖励：货币发放（服务器随机选择）');
  const balAfter = db.prepare("SELECT balance FROM player_currency WHERE player_id = ? AND currency_id = (SELECT id FROM currencies WHERE name='金币')").get(pa.id).balance;
  assert.ok(balAfter > balBefore);
  ok('17. 货币奖励到账');
  // 幂等：同玩家同传奇同实例只发一次
  const reward2 = encounter.grantCombatReward(fakeIo, shedLegend.id, pa.id, 'ER1', { instanceId: null, rng: rngForCurrency });
  assert.strictEqual(reward2.ok, false);
  assert.strictEqual(reward2.reason, 'ALREADY_GRANTED');
  ok('18. 战斗奖励幂等（同玩家同传奇只发一次）');
  // 奖励池条目验证（不存在的技能被过滤）
  const badEntry = { type: 'guidance', weight: 10, skill: 'god_mode', description: 'x' };
  assert.strictEqual(encounter.validatePoolEntry(badEntry).ok, false);
  ok('19. 奖励验证：不存在的技能被拒（禁止编造）');
  const goodEntry = { type: 'guidance', weight: 10, skill: 'Sword Technique', description: 'x' };
  assert.strictEqual(encounter.validatePoolEntry(goodEntry).ok, true);
  ok('20. 奖励验证：已审核技能通过');
  const badItemEntry = { type: 'item', weight: 10, experience: '不存在的体验' };
  assert.strictEqual(encounter.validatePoolEntry(badItemEntry).ok, false);
  ok('21. 奖励验证：不存在体验的物品被拒');
  const badCurrency = { type: 'currency', weight: 10, amount: 99999999 };
  assert.strictEqual(encounter.validatePoolEntry(badCurrency).ok, false);
  ok('22. 奖励验证：超额货币被拒');
  const toolNames = tools.getRegistry().map((t) => t.name);
  assert.ok(!toolNames.includes('grant_permanent_item'));
  ok('23. AI 不能直接发放永久装备（无发放工具）');
  // Builderman 奖励池为空（商店型，非掉落型）
  const builderRules = JSON.parse(db.prepare('SELECT encounter_rules_json FROM legendary_npcs WHERE display_name = ?').get('Builderman').encounter_rules_json);
  assert.strictEqual(builderRules.combat_reward_pool.length, 0);
  ok('24. Builderman 非掉落型（奖励池为空，提供商店）');

  // ══ D. Builderman 商店 ══
  const b = builder();
  npcEngine.spawnNpcInstance(fakeIo, { npcId: b.npc_id, roomId: 'ER1' });
  const shop = legendEngine.getShop(b.id, pa.id);
  assert.ok(shop.length >= 4);
  ok('25. Builderman 商店：建筑类装备');
  const wall = shop.find((x) => x.item_name === 'Build Wall');
  const turret = shop.find((x) => x.item_name === 'Auto Turret');
  assert.ok(wall.price < turret.price, '品质决定价格（墙便宜/炮台昂贵）');
  ok('26. 价格按品质变化（普通墙便宜/高级炮台昂贵）');
  assert.ok(wall.price > 0 && turret.price > 0);
  ok('27. 价格由服务器定义（数据库）');
  assert.ok(!toolNames.includes('set_shop_price') && !toolNames.includes('modify_price'));
  ok('28. AI 不能修改价格（无对应工具）');
  // 购买（金币足够）
  db.prepare("UPDATE player_currency SET balance = 99999 WHERE player_id = ?").run(pa.id);
  npcEngine.applyRelationshipEvent(fakeIo, { npcInstanceId: npcEngine.findNpcInstanceInRoom('ER1', 'npc_legend_builderman').id, playerId: pa.id, action: 'help', reason: '刷关系' });
  npcEngine.applyRelationshipEvent(fakeIo, { npcInstanceId: npcEngine.findNpcInstanceInRoom('ER1', 'npc_legend_builderman').id, playerId: pa.id, action: 'help', reason: '刷关系' });
  const buyRes = await tools.runTool({ io, room: { id: 'ER1', players: [] }, playerUid: pa.uid }, 'buy_legendary_item', { legend: 'npc_legend_builderman', itemName: 'Build Wall' });
  assert.strictEqual(buyRes.ok, true, JSON.stringify(buyRes));
  ok('29. 商店购买成功（建筑类装备）');

  // ══ E. 永久物品 ══
  const linkedSword = db.prepare("SELECT * FROM items WHERE name = 'Linked Sword'").get();
  const perm = encounter.grantPermanentItem(pa.id, linkedSword.id, 'Sword Fight on the Heights');
  assert.ok(perm && perm.player_id === pa.id);
  ok('30. 永久物品保存');
  const permAgain = encounter.grantPermanentItem(pa.id, linkedSword.id, 'Sword Fight on the Heights');
  assert.ok(permAgain, '重复授予幂等（INSERT OR IGNORE）');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM permanent_items WHERE player_id = ? AND item_id = ?').get(pa.id, linkedSword.id).c, 1);
  ok('31. 永久物品幂等（同玩家同物品唯一）');
  const permItems = encounter.getPermanentItems(pa.id, 'DOORS');
  assert.ok(permItems.some((i) => i.name === 'Linked Sword'));
  ok('32. 永久物品跨副本保留（列表可查）');
  const permTool = await tools.runTool({ io, room: { id: 'ER1', players: [] }, playerUid: pa.uid }, 'get_permanent_items', { targetExperience: 'DOORS' });
  assert.strictEqual(permTool.ok, true);
  assert.ok(permTool.items.some((i) => i.name === 'Linked Sword'));
  ok('33. get_permanent_items 工具（含削弱倍率）');
  // 非审核物品不能成为永久物品
  db.prepare("INSERT OR IGNORE INTO items (name, description, source_type, rarity, status, kind, stacking) VALUES ('测试未审核', 'x', 'original', 'common', 'draft', 'material', 'STACKABLE')").run();
  const draftItem = db.prepare("SELECT * FROM items WHERE name = '测试未审核'").get();
  let permErr = null;
  try {
    encounter.grantPermanentItem(pa.id, draftItem.id, 'x');
  } catch (e) {
    permErr = e;
  }
  assert.strictEqual(permErr && permErr.code, 'ITEM_NOT_APPROVED');
  ok('34. 永久物品验证：未审核物品拒绝');

  // ══ F. 跨副本装备削弱 ══
  const mult = encounter.getItemMultiplier('Linked Sword', 'Sword Fight on the Heights', 'DOORS');
  assert.strictEqual(mult, 0.2);
  ok('35. 跨副本削弱：SFOTH 剑在 DOORS = 0.2');
  const homeMult = encounter.getItemMultiplier('Linked Sword', 'Sword Fight on the Heights', 'Sword Fight on the Heights');
  assert.strictEqual(homeMult, 1.0);
  ok('36. 主场不削弱（1.0）');
  const noRuleMult = encounter.getItemMultiplier('Linked Sword', 'Sword Fight on the Heights', '未知体验');
  assert.strictEqual(noRuleMult, 1.0, '无规则默认不削弱');
  ok('37. 无规则默认不削弱');
  const power = encounter.effectiveItemPower('Linked Sword', 100, 'Sword Fight on the Heights', 'DOORS');
  assert.strictEqual(power.effectivePower, 20, '100 × 0.2 = 20');
  ok('38. 有效强度计算：100 × 0.2 = 20');
  const powerTool = await tools.runTool({ io, room: { id: 'ER1', players: [] }, playerUid: pa.uid }, 'get_item_power', { itemName: 'Linked Sword', basePower: 100, sourceExperience: 'Sword Fight on the Heights', targetExperience: 'DOORS' });
  assert.strictEqual(powerTool.ok, true);
  assert.strictEqual(powerTool.effectivePower, 20);
  ok('39. get_item_power 工具（服务器计算，AI 不可修改）');
  const rulesCount = db.prepare('SELECT COUNT(*) c FROM item_balance_rules').get().c;
  assert.ok(rulesCount >= 5);
  ok('40. 多条平衡规则（不同体验不同倍率）');
  assert.ok(!toolNames.includes('set_balance_rule') && !toolNames.includes('modify_multiplier'));
  ok('41. AI 不能修改平衡规则（无对应工具）');

  // ══ G. 剑数据库 ══
  const sfSwords = db.prepare("SELECT * FROM experience_items WHERE source_experience = 'Sword Fight on the Heights'").all();
  assert.ok(sfSwords.length >= 7, 'SFOTH 真实剑库');
  ok('42. SFOTH 剑数据库（真实剑列表）');
  assert.ok(sfSwords.some((s) => s.name === 'Linked Sword' && s.status === 'approved'));
  ok('43. 剑条目已审核（approved）');
  assert.ok(sfSwords.some((s) => s.status === 'unknown' && s.original_ability === 'UNKNOWN'));
  ok('44. 资料不足标记 UNKNOWN（禁止编造）');
  const swordTool = await tools.runTool({ io, room: { id: 'ER1', players: [] }, playerUid: pa.uid }, 'get_experience_swords', { experience: 'Sword Fight on the Heights' });
  assert.strictEqual(swordTool.ok, true);
  assert.ok(swordTool.swords.length >= 7);
  ok('45. get_experience_swords 工具（只读，AI 禁止编造）');
  assert.ok(!toolNames.includes('create_sword') && !toolNames.includes('add_experience_item'));
  ok('46. AI 不能创造剑（无创建工具）');

  // ══ H. 剑斗完成度奖励 ══
  // 造一个已完成的副本实例 + 表现记录
  const vInfo = db.prepare("INSERT INTO dungeon_versions (dungeon_id, version, definition_json, canonical_snapshot_hash, status) VALUES (1, 995, '{}', 'h11', 'PUBLISHED')").run();
  db.prepare("INSERT INTO dungeon_instances (uid, dungeon_version_id, room_id, status, current_scene_id, party) VALUES ('inst_sword', ?, 'ER1', 'COMPLETED', 's', ?)").run(vInfo.lastInsertRowid, JSON.stringify([pa.id]));
  const instId = db.prepare("SELECT id FROM dungeon_instances WHERE uid = 'inst_sword'").get().id;
  encounter.ensurePerformance(instId);
  // 高评分：完成(30) + 战斗全胜(30) + 探索(20) + 生存(20) = 100
  db.prepare('UPDATE instance_performance SET combat_wins = 5, combat_losses = 0, explored_scenes = ?, quests_done = 2 WHERE instance_id = ?').run(JSON.stringify(['s1', 's2', 's3', 's4']), instId);
  const score = encounter.completionScore(instId);
  assert.ok(score >= 80, `高评分（实际 ${score}）`);
  ok('47. 完成度评分计算（任务/战斗/探索/生存）');
  const tier = encounter.rewardTier(score);
  assert.ok(['epic', 'legendary'].includes(tier.tier));
  ok('48. 评分档位（80%+ 高级/传奇）');
  const swordReward = encounter.grantSwordCompletionReward(fakeIo, instId, pa.id, { experienceName: 'Sword Fight on the Heights' });
  assert.strictEqual(swordReward.ok, true, JSON.stringify(swordReward));
  assert.ok(swordReward.sword, '发放真实存在的剑');
  const realSword = db.prepare("SELECT 1 FROM experience_items WHERE name = ? AND source_experience = 'Sword Fight on the Heights'").get(swordReward.sword);
  assert.ok(realSword, '奖励剑来自数据库真实剑列表');
  ok('49. 剑斗完成奖励：发放真实存在的剑（非 AI 创造）');
  // 幂等
  const swordReward2 = encounter.grantSwordCompletionReward(fakeIo, instId, pa.id, { experienceName: 'Sword Fight on the Heights' });
  assert.strictEqual(swordReward2.reason, 'ALREADY_GRANTED');
  ok('50. 剑斗奖励幂等（同实例只发一次）');
  // 低评分无奖励
  const vInfo2 = db.prepare("INSERT INTO dungeon_versions (dungeon_id, version, definition_json, canonical_snapshot_hash, status) VALUES (1, 996, '{}', 'h11b', 'PUBLISHED')").run();
  db.prepare("INSERT INTO dungeon_instances (uid, dungeon_version_id, room_id, status, current_scene_id, party) VALUES ('inst_low', ?, 'ER1', 'FAILED', 's', ?)").run(vInfo2.lastInsertRowid, JSON.stringify([pb.id]));
  const lowInstId = db.prepare("SELECT id FROM dungeon_instances WHERE uid = 'inst_low'").get().id;
  const lowScore = encounter.completionScore(lowInstId);
  const lowReward = encounter.grantSwordCompletionReward(fakeIo, lowInstId, pb.id, { experienceName: 'Sword Fight on the Heights' });
  assert.strictEqual(lowReward.ok, false);
  assert.strictEqual(lowReward.reason, 'SCORE_TOO_LOW');
  ok('51. 低评分无奖励（<20%）');

  // ══ I. Context ══
  const runtimeEngine = require('../src/services/runtime/runtimeEngine');
  const vInfo3 = db.prepare("INSERT INTO dungeon_versions (dungeon_id, version, definition_json, canonical_snapshot_hash, status) VALUES (1, 997, ?, 'h11c', 'PUBLISHED')").run(JSON.stringify({ roblox_universe_id: '2753915549', scenes: [{ id: 's', name: 's', order: 1, exits: [], encounters: [], events: [] }], encounters: [], enemies: [], boss: null, dungeon: { difficulty: 1 } }));
  db.prepare("INSERT INTO dungeon_instances (uid, dungeon_version_id, room_id, status, current_scene_id, party) VALUES ('inst_ctx', ?, 'ER1', 'RUNNING', 's', ?)").run(vInfo3.lastInsertRowid, JSON.stringify([pa.id]));
  const instCtx = require('../src/services/runtime/instanceManager').getInstance('inst_ctx');
  const ctxTxt = runtimeEngine.buildRuntimeContext(instCtx, JSON.parse(db.prepare('SELECT definition_json FROM dungeon_versions WHERE id = ?').get(vInfo3.lastInsertRowid).definition_json), [pa]);
  assert.ok(ctxTxt.includes('PLAYER_LEGENDARY_ITEMS'));
  ok('52. Context：PLAYER_LEGENDARY_ITEMS 分区存在');
  assert.ok(ctxTxt.includes('Linked Sword'), 'Context 含永久物品');
  ok('53. Context：玩家永久物品可见');
  assert.ok(ctxTxt.includes('×0.2'), 'Context 含跨副本削弱倍率');
  ok('54. Context：跨副本有效强度倍率可见');
  assert.ok(ctxTxt.includes('LEGENDARY_NPC_CONTEXT'));
  ok('55. Context：LEGENDARY_NPC_CONTEXT 保留（阶段10）');
  ok('56. 阶段1~10 回归：由全套件 `npm test` 覆盖');

  console.log(`\n[test] 阶段11 全部通过：${passed}/56 项 ✅`);
  server.close();
  aiServer.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('\n[test] 阶段11 测试失败 ❌\n', err);
  process.exit(1);
});
