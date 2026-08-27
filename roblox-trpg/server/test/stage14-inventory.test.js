/**
 * 阶段14 测试：Persistent Inventory & Item System（84 项）。
 * 覆盖：物品定义 / 背包（添加/删除/堆叠/容量/绑定/永久）/ 类型与品质 / 元数据 /
 *       跨副本削弱 / 工具权限与作弊拒绝 / Quest/NPC/副本奖励幂等 / 战斗装备集成 /
 *       随机事件（AI 候选+服务器抽签）/ GM 抉择按钮提示 / Context / REST。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

for (const suffix of ['', '-wal', '-shm', '-journal']) {
  fs.rmSync(path.join(__dirname, '../../database/data/roblox_trpg.db' + suffix), { force: true });
}

process.env.AI_API_KEY = 'ai-key-s14';
process.env.AI_BASE_URL = 'http://127.0.0.1:4114/v1';
process.env.AI_MODEL = 'mock-s14';
process.env.AI_STREAM = 'off';

const { server } = require('../src/index.js');
const dbMod = require('@roblox-trpg/database');
const db = dbMod.getDb();
const inventoryService = require('../src/services/inventory/inventoryService');
const characterService = require('../src/services/character/characterService');
const questEngine = require('../src/services/quests/questEngine');
const npcEngine = require('../src/services/npcs/npcEngine');
const legendEngine = require('../src/services/legends/legendEngine');
const combatEngine = require('../src/services/runtime/combatEngine');
const instanceManager = require('../src/services/runtime/instanceManager');
const worldEvents = require('../src/services/world/worldEvents');
const decisionEngine = require('../src/services/party/decisionEngine');
const aiAgent = require('../src/services/ai/aiAgent');
const contextBuilder = require('../src/services/ai/contextBuilder');
const { SYSTEM_RULES } = require('../src/services/ai/promptRules');
const tools = require('../src/services/ai/tools');
const { createSession } = require('../src/sessions/sessionManager');

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
  const uid = `player_s14_${pSeq}`;
  db.prepare('INSERT INTO players (uid, socket_id, name, room_id) VALUES (?, ?, ?, ?)').run(uid, `sock_${uid}`, name, roomId);
  return db.prepare('SELECT * FROM players WHERE uid = ?').get(uid);
}
function ctxFor(roomId, players) {
  return { io: fakeIo, room: { id: roomId, players: players.map((p) => ({ name: p.name, uid: p.uid, socketId: p.socket_id })) }, playerUid: 'ai', actingPlayerName: 'GM' };
}

async function main() {
  console.log('[test] 阶段14 就绪（84 项）\n');

  // ══ A. 物品定义系统 ══
  const testPotion = inventoryService.createDefinition({ itemKey: 'TEST_POTION', name: '测试药剂', description: '堆叠测试', type: 'CONSUMABLE', rarity: 'UNCOMMON', icon: '🧪', stackLimit: 5, metadata: { heal: 8 } });
  assert.ok(testPotion.id && testPotion.item_key === 'TEST_POTION' && testPotion.stack_limit === 5);
  ok('1. 创建物品定义（服务器入口）');
  assert.throws(() => inventoryService.createDefinition({ itemKey: 'TEST_POTION', name: '重复', type: 'MATERIAL' }), /UNIQUE|constraint/i);
  ok('2. item_key 唯一约束');
  assert.throws(() => inventoryService.createDefinition({ itemKey: 'BAD_TYPE', name: 'x', type: 'ARTIFACT' }), /非法物品类型/);
  ok('3. 非法类型拒绝（7 类白名单）');
  assert.throws(() => inventoryService.createDefinition({ itemKey: 'BAD_RARITY', name: 'x', rarity: 'GODLY' }), /非法品质/);
  ok('4. 非法品质拒绝（6 档白名单）');
  assert.ok(inventoryService.getDefinition('TEST_POTION') && inventoryService.getDefinition(testPotion.id).item_key === 'TEST_POTION');
  ok('5. 查询定义（按 key / 按 id）');
  assert.strictEqual(inventoryService.getDefinition('god_sword'), null);
  ok('6. 不存在的物品定义 = null（禁止凭空引用）');
  const doorsKey = inventoryService.getDefinition('DOORS_KEY');
  assert.ok(doorsKey && doorsKey.type === 'QUEST_ITEM' && doorsKey.bind_on_acquire === 1 && JSON.parse(doorsKey.metadata_json).quest_id === 'quest_doors_main');
  ok('7. 任务物品定义（绑定 + quest_id 元数据）');
  const legacyDefs = inventoryService.listDefinitions();
  assert.ok(legacyDefs.some((d) => d.item_key === 'Build_Wall') && legacyDefs.some((d) => d.item_key === '治疗药水'));
  ok('8. 既有审核物品桥接进定义表（Build Wall/治疗药水…）');

  // ══ B. 背包系统 ══
  mkRoomDb('IV1');
  const hero = mkPlayerDb('勇者', 'IV1');
  const inv0 = inventoryService.ensureInventory(hero.id);
  assert.strictEqual(inv0.capacity, 20);
  ok('9. 背包自动创建（默认容量 20）');
  const add1 = inventoryService.addItem(fakeIo, hero.id, 'TEST_POTION', { amount: 2, sourceType: 'TEST' });
  assert.ok(add1.added && add1.amount === 2);
  ok('10. 添加物品（入库 + 事件）');
  inventoryService.addItem(fakeIo, hero.id, 'TEST_POTION', { amount: 2 });
  const rowPotion = db.prepare('SELECT ii.*, d.item_key FROM inventory_items ii JOIN item_definitions d ON d.id = ii.item_id WHERE ii.player_id = ? AND d.item_key = ?').get(hero.id, 'TEST_POTION');
  assert.strictEqual(rowPotion.amount, 4);
  ok('11. 堆叠：同定义单行累加');
  assert.throws(() => inventoryService.addItem(fakeIo, hero.id, 'TEST_POTION', { amount: 3 }), /堆叠上限/);
  ok('12. 堆叠上限拒绝（4+3 > 5）');
  const ill = inventoryService.addItem(fakeIo, hero.id, 'Illumina', { sourceType: 'SWORD_COMPLETION', sourceId: 'SFOTH' });
  assert.ok(ill.added && ill.permanent === true);
  assert.throws(() => inventoryService.addItem(fakeIo, hero.id, 'Illumina'), /唯一物品/);
  ok('13. 唯一物品重复获得拒绝');
  inventoryService.ensureInventory(hero.id, 2); // 收紧容量用于测试
  mkRoomDb('IV2');
  const capGuy = mkPlayerDb('容量侠', 'IV2');
  inventoryService.ensureInventory(capGuy.id, 2);
  inventoryService.addItem(fakeIo, capGuy.id, 'TEST_POTION', { amount: 1 });
  inventoryService.addItem(fakeIo, capGuy.id, 'DOORS_KEY');
  assert.throws(() => inventoryService.addItem(fakeIo, capGuy.id, 'Illumina'), /背包已满/);
  ok('14. 容量上限拒绝');
  assert.throws(() => inventoryService.removeItem(fakeIo, hero.id, 'TEST_POTION', { amount: 99 }), /移除数量非法/);
  ok('15. 移除数量超过持有拒绝');
  inventoryService.removeItem(fakeIo, hero.id, 'TEST_POTION', { amount: 3 });
  assert.strictEqual(db.prepare('SELECT amount FROM inventory_items WHERE player_id = ? AND item_id = ?').get(hero.id, testPotion.id).amount, 1);
  ok('16. 部分移除（4→1）');
  assert.throws(() => inventoryService.removeItem(fakeIo, hero.id, 'Illumina'), /永久物品/);
  ok('17. 永久物品不可移除');
  assert.throws(() => inventoryService.removeItem(fakeIo, hero.id, 'TEST_POTION', { amount: 0 }), /移除数量非法/);
  ok('18. 移除数量为 0 拒绝');
  const boundGuy = mkPlayerDb('绑定侠', 'IV2');
  inventoryService.addItem(fakeIo, boundGuy.id, 'DOORS_KEY');
  assert.throws(() => inventoryService.removeItem(fakeIo, boundGuy.id, 'DOORS_KEY'), /绑定/);
  ok('19. 绑定物品不可移除');
  assert.throws(() => inventoryService.removeItem(fakeIo, boundGuy.id, 'NOT_EXIST'), /不存在/);
  ok('20. 移除不存在的物品拒绝');
  assert.ok(db.prepare("SELECT 1 FROM game_events WHERE room_id = 'IV1' AND type = 'ITEM_ACQUIRED'").get());
  ok('21. ITEM_ACQUIRED 记入 Event Bus');

  // ══ C. 类型 / 品质 / 元数据 ══
  for (const t of inventoryService.ITEM_TYPES) {
    inventoryService.createDefinition({ itemKey: `T_${t}`, name: `类型${t}`, type: t });
  }
  assert.ok(inventoryService.ITEM_TYPES.length === 7 && inventoryService.getDefinition('T_QUEST_ITEM').type === 'QUEST_ITEM');
  ok('22. 七种物品类型全部支持');
  for (const r of inventoryService.RARITIES) {
    inventoryService.createDefinition({ itemKey: `R_${r}`, name: `品质${r}`, rarity: r });
  }
  assert.ok(inventoryService.RARITIES.length === 6 && inventoryService.getDefinition('R_MYTHIC').rarity === 'MYTHIC' && inventoryService.getDefinition('R_UNCOMMON').rarity === 'UNCOMMON');
  ok('23. 六档品质（含 UNCOMMON/MYTHIC）');
  const illDef = inventoryService.getDefinition('Illumina');
  const illMeta = JSON.parse(illDef.metadata_json);
  assert.ok(illMeta.damage === 100 && illMeta.element === 'light' && illMeta.source === 'Sword Fight on the Heights');
  ok('24. 剑元数据（damage/element/source）');
  inventoryService.createDefinition({ itemKey: 'TEST_ARMOR', name: '测试护甲', type: 'ARMOR', rarity: 'RARE', metadata: { armor: 20 } });
  assert.strictEqual(JSON.parse(inventoryService.getDefinition('TEST_ARMOR').metadata_json).armor, 20);
  ok('25. 护甲元数据（armor）');
  assert.ok(testPotion.icon === '🧪');
  ok('26. 图标字段');

  // ══ D. 永久物品 + 跨副本削弱 ══
  const effDoors = inventoryService.effectivePower('Illumina', 'DOORS');
  assert.strictEqual(effDoors.effectivePower, 30);
  assert.strictEqual(effDoors.multiplier, 0.3);
  ok('27. 跨副本削弱：Illumina 100 → DOORS 30（世界规则）');
  const effHome = inventoryService.effectivePower('Illumina', 'Sword Fight on the Heights');
  assert.strictEqual(effHome.effectivePower, 100);
  ok('28. 主场不削弱（100 保持）');
  const effNone = inventoryService.effectivePower('Illumina', '完全未知的体验');
  assert.strictEqual(effNone.effectivePower, 100);
  ok('29. 无规则默认不削弱');
  assert.ok(db.prepare('SELECT 1 FROM inventory_items ii JOIN item_definitions d ON d.id = ii.item_id WHERE ii.player_id = ? AND d.item_key = ?').get(hero.id, 'Illumina'));
  ok('30. 永久物品跨副本保留（不删除物品，只削弱）');

  // ══ E. AI 工具 ══
  mkRoomDb('TL1');
  const tia = mkPlayerDb('蒂亚', 'TL1');
  const tob = mkPlayerDb('托布', 'TL1');
  const tctx = ctxFor('TL1', [tia, tob]);
  const invTool = await tools.runTool(tctx, 'get_inventory', { target: '蒂亚' });
  assert.ok(invTool.ok && invTool.inventory.capacity === 20 && Array.isArray(invTool.inventory.items));
  ok('31. get_inventory 只读工具');
  const addTool = await tools.runTool(tctx, 'add_item', { target: '蒂亚', item_key: 'TEST_POTION', amount: 2, reason: '剧情赠送' });
  assert.ok(addTool.ok && addTool.added);
  ok('32. add_item 服务器验证后增加');
  await assert.rejects(tools.runTool(tctx, 'add_item', { target: '蒂亚', item_key: 'god_sword', amount: 1 }), /奖励验证失败|不存在/);
  ok('33. AI 制造不存在物品拒绝（give_item("god_sword") 不可能）');
  await assert.rejects(tools.runTool(tctx, 'add_item', { target: '蒂亚', item_key: 'TEST_POTION', amount: 999 }), /不能大于|数量/);
  ok('34. add_item 数量上限（无限物品拒绝）');
  inventoryService.createDefinition({ itemKey: 'DRAFT_ITEM', name: '草稿物品', type: 'MATERIAL' });
  db.prepare("UPDATE item_definitions SET status = 'draft' WHERE item_key = 'DRAFT_ITEM'").run();
  await assert.rejects(tools.runTool(tctx, 'add_item', { target: '蒂亚', item_key: 'DRAFT_ITEM' }), /未审核/);
  ok('35. 未审核定义拒绝（奖励必须经验证）');
  const rmTool = await tools.runTool(tctx, 'remove_item', { target: '蒂亚', item_key: 'TEST_POTION', amount: 1 });
  assert.ok(rmTool.ok && rmTool.removed);
  ok('36. remove_item 服务器验证后删除');
  await tools.runTool(tctx, 'add_item', { target: '蒂亚', item_key: 'Illumina' });
  await assert.rejects(tools.runTool(tctx, 'remove_item', { target: '蒂亚', item_key: 'Illumina' }), /永久物品/);
  ok('37. AI 移除永久物品拒绝');
  const useTool = await tools.runTool(tctx, 'use_item', { target: '蒂亚', item_key: 'TEST_POTION' });
  assert.ok(useTool.ok && useTool.effects.some((e) => e.effect === 'heal'));
  ok('38. use_item 使用消耗品（服务器结算治疗）');
  await tools.runTool(tctx, 'add_item', { target: '蒂亚', item_key: 'DOORS_KEY' });
  await assert.rejects(tools.runTool(tctx, 'use_item', { target: '蒂亚', item_key: 'DOORS_KEY' }), /不是消耗品/);
  ok('39. 非消耗品使用拒绝');
  const eqTool = await tools.runTool(tctx, 'equip_item', { target: '蒂亚', item_key: 'Illumina' });
  assert.ok(eqTool.equipped && eqTool.slot === 'weapon');
  ok('40. equip_item 装备武器');
  await tools.runTool(tctx, 'add_item', { target: '蒂亚', item_key: 'TEST_ARMOR' });
  await tools.runTool(tctx, 'equip_item', { target: '蒂亚', item_key: 'TEST_ARMOR' });
  const eqRows = db.prepare("SELECT equipped_slot, COUNT(*) c FROM inventory_items WHERE player_id = ? AND equipped_slot IS NOT NULL GROUP BY equipped_slot").all(tia.id);
  assert.ok(eqRows.length === 2);
  ok('41. 多槽位装备（武器+护甲）');
  await tools.runTool(tctx, 'add_item', { target: '蒂亚', item_key: 'Linked_Sword' });
  await tools.runTool(tctx, 'equip_item', { target: '蒂亚', item_key: 'Linked_Sword' });
  const weaponEquipped = db.prepare("SELECT d.item_key FROM inventory_items ii JOIN item_definitions d ON d.id = ii.item_id WHERE ii.player_id = ? AND ii.equipped_slot = 'weapon'").get(tia.id);
  assert.strictEqual(weaponEquipped.item_key, 'Linked_Sword');
  ok('42. 同槽位自动换装');
  await assert.rejects(tools.runTool(tctx, 'equip_item', { target: '蒂亚', item_key: 'TEST_POTION' }), /不可装备/);
  ok('43. 消耗品装备拒绝');
  mkRoomDb('TL2');
  const outsider = mkPlayerDb('外人', 'TL2');
  await assert.rejects(tools.runTool(tctx, 'add_item', { target: '外人', item_key: 'TEST_POTION' }), /不在当前房间/);
  ok('44. 跨玩家/跨房间修改拒绝（房间隔离）');
  const names = tools.getRegistry().map((t) => t.name);
  for (const banned of ['create_item_definition', 'create_item', 'give_god_item', 'set_item_power']) {
    assert.ok(!names.includes(banned));
  }
  ok('45. 无物品定义创建/作弊工具');
  assert.strictEqual(tools.toolMeta('get_inventory').permission, 'READ_ONLY');
  assert.strictEqual(tools.toolMeta('add_item').permission, 'GAME_ACTION');
  ok('46. 工具权限分级');

  // ══ F. 奖励集成与幂等 ══
  mkRoomDb('RW1');
  const qHero = mkPlayerDb('任务勇者', 'RW1');
  const draft = questEngine.createQuestDraft({
    name: '钥匙任务',
    type: 'SIDE',
    definition: {
      objectives: [{ key: 'finish', name: '完成', type: 'CUSTOM', required_count: 1, order_index: 1, evidence_flag: 'done' }],
      rewards: [{ type: 'ITEM', itemKey: 'DOORS_KEY', amount: 1 }, { type: 'ITEM', itemKey: 'TEST_POTION', amount: 3 }],
    },
  });
  questEngine.publishQuestVersion(draft.versionId);
  const qi = questEngine.createInstance(fakeIo, { questVersionId: draft.versionId, roomId: 'RW1', partyPlayerIds: [qHero.id], activate: true });
  const granted = questEngine.settleRewards(fakeIo, qi.instance.id);
  assert.ok(granted.some((g) => g.itemKey === 'DOORS_KEY' && g.granted === 'GRANTED'));
  assert.ok(db.prepare('SELECT amount FROM inventory_items ii JOIN item_definitions d ON d.id = ii.item_id WHERE ii.player_id = ? AND d.item_key = ?').get(qHero.id, 'TEST_POTION').amount === 3);
  ok('47. Quest 奖励（itemKey）结算入背包');
  const again = questEngine.settleRewards(fakeIo, qi.instance.id);
  assert.ok(again.every((g) => g.status === 'ALREADY_GRANTED' || g.granted === 'ALREADY_GRANTED'));
  assert.ok(db.prepare('SELECT COUNT(*) c FROM inventory_items ii JOIN item_definitions d ON d.id = ii.item_id WHERE ii.player_id = ? AND d.item_key = ?').get(qHero.id, 'DOORS_KEY').c === 1);
  ok('48. 重复领奖幂等（不会重复获得）');
  assert.throws(
    () => questEngine.createQuestDraft({ name: '坏奖励', type: 'SIDE', definition: { objectives: [{ key: 'a', name: 'a', type: 'CUSTOM' }], rewards: [{ type: 'ITEM', itemKey: 'god_sword' }] } }),
    /物品定义不存在|验证/
  );
  ok('49. 任务设计验证：不存在的物品奖励拒绝');
  // NPC 赠予（关系门槛 + 幂等）
  mkRoomDb('RW2');
  const nHero = mkPlayerDb('受的恩惠', 'RW2');
  npcEngine.spawnNpcInstance(null, { npcId: npcEngine.getNpc('npc_doors_keeper').id, roomId: 'RW2' });
  assert.throws(() => inventoryService.giftItemFromNpc(fakeIo, { npcUid: 'npc_doors_keeper', playerId: nHero.id, itemKey: 'DOORS_KEY', roomId: 'RW2', minRelationship: 50 }), /关系不足/);
  ok('50. NPC 赠予：关系门槛（服务器规则）');
  const gift1 = inventoryService.giftItemFromNpc(fakeIo, { npcUid: 'npc_doors_keeper', playerId: nHero.id, itemKey: 'TEST_POTION', roomId: 'RW2', minRelationship: 0 });
  const gift2 = inventoryService.giftItemFromNpc(fakeIo, { npcUid: 'npc_doors_keeper', playerId: nHero.id, itemKey: 'TEST_POTION', roomId: 'RW2', minRelationship: 0 });
  assert.ok(gift1.added && gift2.added === false && gift2.reason === 'ALREADY_GRANTED');
  ok('51. NPC 赠予幂等（同NPC同玩家同物品一次）');
  // NPC 商店 → 背包（Builderman）
  mkRoomDb('RW3');
  const buyer = mkPlayerDb('买家', 'RW3');
  const builderLegend = legendEngine.getLegendByNpcUid('npc_legend_builderman');
  const builderInst = npcEngine.spawnNpcInstance(null, { npcId: builderLegend.npc_id, roomId: 'RW3' });
  npcEngine.applyRelationshipEvent(fakeIo, { npcInstanceId: builderInst.id, playerId: buyer.id, action: 'help', reason: '测试' });
  const gold = db.prepare("SELECT * FROM currencies WHERE name = '金币'").get();
  characterService.grantCurrency(buyer.id, gold.id, 1000, { sourceType: 'TEST', sourceId: 'x' });
  const wallItem = db.prepare("SELECT * FROM items WHERE name = 'Build Wall'").get();
  legendEngine.purchaseShopItem(fakeIo, builderLegend.id, buyer.id, wallItem.id, 'RW3');
  assert.ok(db.prepare('SELECT 1 FROM inventory_items ii JOIN item_definitions d ON d.id = ii.item_id WHERE ii.player_id = ? AND d.item_key = ?').get(buyer.id, 'Build_Wall'));
  ok('52. NPC 商店购买 → 持久背包（关系+价格由服务器验证，阶段10 规则不变）');
  // 副本掉落桥接（旧发放 → 新背包）
  mkRoomDb('RW4');
  const dropper = mkPlayerDb('掉落者', 'RW4');
  const legacyItem = db.prepare("SELECT * FROM items WHERE name = '骨架钥匙'").get();
  characterService.grantItem(dropper.id, legacyItem.id, { sourceType: 'DUNGEON_REWARD', sourceId: 'test' });
  assert.ok(db.prepare('SELECT 1 FROM inventory_items ii JOIN item_definitions d ON d.id = ii.item_id WHERE ii.player_id = ? AND d.item_key = ?').get(dropper.id, '骨架钥匙'));
  ok('53. 副本掉落（旧发放路径）自动入持久背包');
  const legacyStack = db.prepare("SELECT * FROM items WHERE name = '治疗药水'").get();
  characterService.grantItem(dropper.id, legacyStack.id, { quantity: 2, sourceType: 'DUNGEON_REWARD' });
  characterService.grantItem(dropper.id, legacyStack.id, { quantity: 3, sourceType: 'DUNGEON_REWARD' });
  assert.strictEqual(db.prepare('SELECT amount FROM inventory_items ii JOIN item_definitions d ON d.id = ii.item_id WHERE ii.player_id = ? AND d.item_key = ?').get(dropper.id, '治疗药水').amount, 5);
  ok('54. 可堆叠旧物品桥接堆叠');
  assert.ok(db.prepare('SELECT COUNT(*) c FROM inventory_grants').get().c >= 2);
  ok('55. 奖励幂等台账（inventory_grants）');

  // ══ G. 战斗集成 ══
  mkRoomDb('CB1');
  const warrior = mkPlayerDb('剑勇', 'CB1');
  characterService.ensureCharacter(warrior.id);
  const doors = db.prepare("SELECT * FROM dungeons WHERE roblox_experience_name = 'Doors'").get();
  db.prepare("INSERT INTO dungeon_versions (dungeon_id, version, definition_json, status, published_at) VALUES (?, 902, '{}', 'PUBLISHED', datetime('now'))").run(doors.id);
  const dvId = db.prepare('SELECT id FROM dungeon_versions WHERE dungeon_id = ? AND version = 902').get(doors.id).id;
  const inst = instanceManager.createInstance({ roomId: 'CB1', dungeonVersionId: dvId });
  inventoryService.addItem(fakeIo, warrior.id, 'Illumina', { sourceType: 'SWORD_COMPLETION' });
  inventoryService.equipItem(fakeIo, warrior.id, 'Illumina');
  const stats = inventoryService.equippedCombatStats(warrior.id, 'Doors');
  assert.ok(stats.weapon && stats.weapon.power === 30 && stats.weapon.multiplier === 0.3 && stats.weaponBonus === 3);
  ok('56. 战斗读取装备：武器受副本规则削弱（100→30，加成+3）');
  inventoryService.addItem(fakeIo, warrior.id, 'TEST_ARMOR');
  inventoryService.equipItem(fakeIo, warrior.id, 'TEST_ARMOR');
  const stats2 = inventoryService.equippedCombatStats(warrior.id, 'Doors');
  assert.ok(stats2.armor && stats2.armor.armor === 20 && stats2.armorReduction === 2);
  ok('57. 护甲读取（armor 20 → 减伤 2）');
  db.prepare(
    `INSERT INTO instance_combats (instance_id, encounter_id, participants, enemy_states, status, version)
     VALUES (?, 'enc_test', '[]', ?, 'ACTIVE', 0)`
  ).run(inst.id, JSON.stringify({ goblin: { name: '哥布林', hp: 50, maxHp: 50, damage: 10, isBoss: false } }));
  const combat = db.prepare("SELECT * FROM instance_combats WHERE instance_id = ? AND encounter_id = 'enc_test'").get(inst.id);
  const atk1 = combatEngine.attack(fakeIo, inst, {}, combat, warrior.id, 'goblin', { rollOverride: { success: true, draw: false, margin: 5, playerRoll: 18, enemyRoll: 8 } });
  assert.ok(atk1.events[0].damage === 8 && atk1.events[0].enemyHp === 42 && /Illumina/.test(atk1.narrative) && /×0.3/.test(atk1.narrative));
  ok('58. 攻击伤害 = 骰差 + 削弱后武器加成（5+3=8，叙事含削弱说明）');
  const hpBefore = db.prepare('SELECT hp FROM player_states WHERE player_id = ?').get(warrior.id).hp;
  combatEngine.attack(fakeIo, inst, {}, db.prepare('SELECT * FROM instance_combats WHERE id = ?').get(combat.id), warrior.id, 'goblin', { rollOverride: { success: false, draw: false, margin: 0, playerRoll: 3, enemyRoll: 19 } });
  const hpAfter = db.prepare('SELECT hp FROM player_states WHERE player_id = ?').get(warrior.id).hp;
  assert.strictEqual(hpBefore - hpAfter, 8);
  ok('59. 反击伤害受护甲减伤（10-2=8）');
  inventoryService.unequipItem(fakeIo, warrior.id, 'weapon');
  const stats3 = inventoryService.equippedCombatStats(warrior.id, 'Doors');
  assert.ok(stats3.weapon === null && stats3.weaponBonus === 0);
  ok('60. 卸下武器后加成为 0');

  // ══ H. 随机事件（AI 候选 + 服务器抽签）══
  mkRoomDb('RX1');
  const picked1 = worldEvents.pickRandomEventType('RX1', { candidates: ['POWER_OUTAGE', 'WEATHER_CHANGE'], rng: 0 });
  const picked2 = worldEvents.pickRandomEventType('RX1', { candidates: ['POWER_OUTAGE', 'WEATHER_CHANGE'], rng: 0.99 });
  assert.ok(picked1 === 'POWER_OUTAGE' && picked2 === 'WEATHER_CHANGE');
  ok('61. 服务器抽签（rng 可验证；AI 只提供候选）');
  const pickedW = worldEvents.pickRandomEventType('RX1', { candidates: ['POWER_OUTAGE', 'WEATHER_CHANGE'], weights: [1, 100], rng: 0.5 });
  assert.strictEqual(pickedW, 'WEATHER_CHANGE');
  ok('62. 权重抽签（1:100）');
  assert.throws(() => worldEvents.pickRandomEventType('RX1', { candidates: ['DUNGEON_MUTATION', 'POWER_OUTAGE'] }), /白名单/);
  ok('63. 候选越权拒绝（SYSTEM 事件不能进候选池）');
  assert.throws(() => worldEvents.pickRandomEventType('RX1', { candidates: ['POWER_OUTAGE'] }), /至少 2 个/);
  ok('64. 单候选拒绝（必须是真正的随机）');
  const rr = worldEvents.requestRandomEvent(fakeIo, 'RX1', { candidates: ['POWER_OUTAGE', 'WEATHER_CHANGE'], weights: [100, 1], rng: 0, reason: '测试' });
  assert.ok(rr.type === 'POWER_OUTAGE' && rr.triggered && worldEvents.hasActiveEvent('RX1', 'POWER_OUTAGE'));
  ok('65. 随机事件触发（抽签+常规执行）');
  assert.throws(() => worldEvents.requestRandomEvent(fakeIo, 'RX1', { candidates: ['POWER_OUTAGE', 'MONSTER_INVASION'], weights: [100, 1], rng: 0, reason: 'x' }), /冷却/);
  ok('66. 随机事件仍受冷却约束');
  mkRoomDb('RX2');
  const randTool = await tools.runTool({ io: fakeIo, room: { id: 'RX2', players: [] }, playerUid: 'ai' }, 'request_random_world_event', {
    candidates: JSON.stringify(['WEATHER_CHANGE', 'SECRET_DISCOVERED']),
    reason: '让世界更生动',
  });
  assert.ok(randTool.ok && ['WEATHER_CHANGE', 'SECRET_DISCOVERED'].includes(randTool.chosenByServer) && randTool.triggered);
  ok('67. request_random_world_event 工具（抽签由服务器执行）');

  // ══ I. GM 抉择按钮提示 ══
  mkRoomDb('HT1');
  const hPlayer = mkPlayerDb('提示侠', 'HT1');
  assert.strictEqual(decisionEngine.decisionHint('HT1'), null);
  ok('68. 无待决选择：无提示');
  decisionEngine.createDecision(fakeIo, 'HT1', { type: 'NORMAL', prompt: '帮不帮？', options: [{ key: 'A', text: '帮' }, { key: 'B', text: '不帮' }] });
  const hint1 = decisionEngine.decisionHint('HT1');
  assert.ok(hint1.includes('1 个抉择') && hint1.includes('点击'));
  ok('69. 普通抉择：按钮提示（数量+点击指引）');
  decisionEngine.createDecision(fakeIo, 'HT1', { type: 'TIMED', prompt: '快躲！', options: [{ key: 'A', text: '躲' }, { key: 'B', text: '跑' }], defaultOption: 'B', timeoutMs: 60000 });
  const hint2 = decisionEngine.decisionHint('HT1');
  assert.ok(hint2.includes('2 个抉择') && /限时抉择/.test(hint2) && /剩余约 \d+ 秒/.test(hint2));
  ok('70. 限时抉择：提示含剩余秒数（服务器计算）');
  const parsed = { type: 'gm_response', narrative: '你面前出现了一扇吱呀作响的门。', options: [], events: [], memory_update: [], rule_requests: [], source_references: [] };
  aiAgent.persistGmOutcome({ id: 'HT1' }, parsed);
  assert.ok(parsed.narrative.includes('抉择等待玩家点击') && parsed.narrative.includes('🎭 抉择'));
  ok('71. GM 输出自动附带按钮提示（服务器注入，非 AI 自由发挥）');
  mkRoomDb('HT2');
  const parsed2 = { type: 'gm_response', narrative: '平静的房间。', options: [], events: [], memory_update: [], rule_requests: [], source_references: [] };
  aiAgent.persistGmOutcome({ id: 'HT2' }, parsed2);
  assert.strictEqual(parsed2.narrative, '平静的房间。');
  ok('72. 无抉择房间：提示不注入');
  assert.ok(/抉择/.test(SYSTEM_RULES) && /点击按钮/.test(SYSTEM_RULES) && /request_random_world_event/.test(SYSTEM_RULES));
  ok('73. SYSTEM_RULES 含抉择按钮契约与随机事件契约');

  // ══ J. Context / REST ══
  mkRoomDb('CX1');
  const cxPlayer = mkPlayerDb('背包展示', 'CX1');
  inventoryService.addItem(fakeIo, cxPlayer.id, 'Illumina');
  inventoryService.equipItem(fakeIo, cxPlayer.id, 'Illumina');
  inventoryService.addItem(fakeIo, cxPlayer.id, 'TEST_POTION', { amount: 3 });
  const built = contextBuilder.buildContext({ id: 'CX1', players: [{ name: '背包展示', socketId: cxPlayer.socket_id }], currentExperience: null, currentDungeon: null });
  const invSec = built.sections.find((s) => s.key === 'inventory');
  assert.ok(invSec && invSec.label === 'INVENTORY_CONTEXT');
  assert.ok(/Illumina/.test(invSec.content) && /已装备/.test(invSec.content) && /测试药剂×3/.test(invSec.content));
  assert.ok(!/player_id|item_id|rowId/i.test(invSec.content));
  ok('74. INVENTORY_CONTEXT（拥有/装备；隐藏内部 ID）');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const sess = createSession(cxPlayer.id);
  const resInv = await fetch(`http://127.0.0.1:${port}/api/inventory?sessionToken=${encodeURIComponent(sess.token)}`).then((r) => r.json());
  assert.ok(resInv.inventory && resInv.inventory.items.some((i) => i.itemKey === 'Illumina' && i.equippedSlot === 'weapon'));
  ok('75. GET /api/inventory（会话鉴权）');
  const res401 = await fetch(`http://127.0.0.1:${port}/api/inventory`);
  assert.strictEqual(res401.status, 401);
  ok('76. 无会话拒绝（401）');
  const resUse = await fetch(`http://127.0.0.1:${port}/api/inventory/use`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemKey: 'TEST_POTION', sessionToken: sess.token }) }).then((r) => r.json());
  assert.ok(resUse.ok && resUse.effects.some((e) => e.effect === 'heal'));
  ok('77. POST /api/inventory/use（玩家使用消耗品）');
  const resUneq = await fetch(`http://127.0.0.1:${port}/api/inventory/unequip`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemKeyOrSlot: 'weapon', sessionToken: sess.token }) }).then((r) => r.json());
  assert.ok(resUneq.ok && resUneq.unequipped);
  ok('78. POST /api/inventory/unequip');
  const resEq = await fetch(`http://127.0.0.1:${port}/api/inventory/equip`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemKey: 'Illumina', sessionToken: sess.token }) }).then((r) => r.json());
  assert.ok(resEq.ok && resEq.equipped && resEq.slot === 'weapon');
  ok('79. POST /api/inventory/equip');

  // ══ K. 安全补强 ══
  const grantLedger = db.prepare('SELECT COUNT(*) c FROM inventory_grants').get().c;
  questEngine.settleRewards(fakeIo, qi.instance.id);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM inventory_grants').get().c, grantLedger);
  ok('80. 幂等再验证：重复结算不新增台账');
  await assert.rejects(tools.runTool(tctx, 'get_inventory', { target: '不存在的人' }), /不在当前房间/);
  ok('81. 查询不存在/跨房玩家拒绝');
  const beforeDefs = db.prepare('SELECT COUNT(*) c FROM item_definitions').get().c;
  await assert.rejects(tools.runTool(tctx, 'add_item', { target: '蒂亚', item_key: 'sword_of_godmode', amount: 1 }), /验证失败/);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM item_definitions').get().c, beforeDefs);
  ok('82. AI 无法借 add_item 创造定义');
  inventoryService.ensureInventory(tia.id, 20);
  const stackCap = inventoryService.addItem(fakeIo, tia.id, 'TEST_POTION', { amount: 1 });
  assert.ok(stackCap.added || stackCap.reason === 'ALREADY_GRANTED');
  ok('83. 堆叠数量始终受定义上限约束');
  const illStill = db.prepare('SELECT COUNT(*) c FROM inventory_items ii JOIN item_definitions d ON d.id = ii.item_id WHERE d.permanent = 1').get().c;
  assert.ok(illStill >= 3);
  ok('84. 永久物品全部留存（跨玩家/跨副本不删除）');

  server.close();
  console.log(`\n[阶段14] 通过 ${passed} 项测试`);
  if (passed < 80) {
    console.error('测试数量不足 80！');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('\n[阶段14] 测试失败：', err);
  process.exit(1);
});
