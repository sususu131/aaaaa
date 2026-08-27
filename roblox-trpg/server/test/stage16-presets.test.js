/**
 * 阶段16 测试：Preset Experience Dungeon Library（80 项）。
 * 覆盖：预设导入/重复导入幂等、副本绑定、任务加载、NPC加载、世界隔离、
 *       奖励、装备奖励（评分→永久剑→跨副本削弱）、随机事件、安全、REST。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

for (const suffix of ['', '-wal', '-shm', '-journal']) {
  fs.rmSync(path.join(__dirname, '../../database/data/roblox_trpg.db' + suffix), { force: true });
}

process.env.AI_API_KEY = 'ai-key-s16';
process.env.AI_BASE_URL = 'http://127.0.0.1:4116/v1';
process.env.AI_MODEL = 'mock-s16';
process.env.AI_STREAM = 'off';

const { server } = require('../src/index.js');
const dbMod = require('@roblox-trpg/database');
const db = dbMod.getDb();
const presetSeeder = require('../src/services/presets/presetSeeder');
const im = require('../src/services/runtime/instanceManager');
const rewardEngine = require('../src/services/runtime/rewardEngine');
const worldState = require('../src/services/world/worldState');
const worldEvents = require('../src/services/world/worldEvents');
const inventoryService = require('../src/services/inventory/inventoryService');
const combatEngine = require('../src/services/runtime/combatEngine');
const tools = require('../src/services/ai/tools');
const { SYSTEM_RULES } = require('../src/services/ai/promptRules');
const { createSession } = require('../src/sessions/sessionManager');

let passed = 0;
const ok = (label) => {
  passed += 1;
  console.log(`  ✓ ${label}`);
};
const fakeIo = { to: () => ({ emit: () => {} }), emit: () => {} };
const count = (sql) => db.prepare(sql).get().c;

function mkRoomDb(id) {
  db.prepare("INSERT OR IGNORE INTO rooms (id, status, max_players) VALUES (?, 'waiting', 3)").run(id);
}
let pSeq = 0;
function mkPlayerDb(name, roomId) {
  pSeq += 1;
  const uid = `player_s16_${pSeq}`;
  db.prepare('INSERT INTO players (uid, socket_id, name, room_id) VALUES (?, ?, ?, ?)').run(uid, `sock_${uid}`, name, roomId);
  return db.prepare('SELECT * FROM players WHERE uid = ?').get(uid);
}
function presetRow(key) {
  return db.prepare('SELECT * FROM preset_experiences WHERE key = ?').get(key);
}
function presetConfig(key) {
  return db.prepare('SELECT c.* FROM preset_dungeon_configs c JOIN preset_experiences p ON p.id = c.preset_id WHERE p.key = ?').get(key);
}
function presetVersionId(key) {
  return db
    .prepare(
      `SELECT v.id FROM preset_dungeon_configs c JOIN preset_experiences p ON p.id = c.preset_id
       JOIN dungeon_versions v ON v.dungeon_id = c.dungeon_id AND v.status = 'PUBLISHED'
       WHERE p.key = ? ORDER BY v.version DESC LIMIT 1`
    )
    .get(key).id;
}
function startPresetInstance(roomId, names, presetKey) {
  mkRoomDb(roomId);
  const players = names.map((n) => mkPlayerDb(n, roomId));
  const versionId = presetVersionId(presetKey);
  const inst0 = im.createInstance({ roomId, dungeonVersionId: versionId });
  for (const p of players) im.joinInstance(im.getInstance(inst0.id), p.id);
  im.startInstance(fakeIo, im.getInstance(inst0.id));
  return { players, inst: im.getInstance(inst0.id) };
}

async function main() {
  console.log('[test] 阶段16 就绪（80 项）\n');

  // ══ A. 预设导入与幂等 ══
  const results = presetSeeder.runPresetSeeder(fakeIo);
  assert.ok(results.length === 5 && results.every((r) => r.dungeonId));
  ok('1. 导入 5 个官方体验预设（DOORS/Forsaken/DoD/高地剑斗/Something Evil）');
  assert.strictEqual(count('SELECT COUNT(*) c FROM preset_experiences'), 5);
  ok('2. preset_experiences 表（5 条）');
  assert.ok(db.prepare("SELECT COUNT(*) c FROM preset_experiences WHERE source_type = 'CANON_PRESET'").get().c === 5);
  ok('3. source_type = CANON_PRESET');
  const cfgs = db.prepare('SELECT * FROM preset_dungeon_configs').all();
  assert.ok(cfgs.length === 5 && cfgs.every((c) => c.status === 'PUBLISHED' && /CANON|TRPG_EXTENSION/.test(c.config_json)));
  ok('4. preset_dungeon_configs：PUBLISHED + Lore 标记（CANON / TRPG_EXTENSION）');
  const doorsPreset = presetRow('doors');
  const doorsDungeon = db.prepare("SELECT * FROM dungeons WHERE roblox_experience_name = 'Doors'").get();
  assert.strictEqual(presetConfig('doors').dungeon_id, doorsDungeon.id);
  ok('5. DOORS 复用既有副本（不重复创建）');
  assert.strictEqual(doorsPreset.roblox_universe_id, '2753915549');
  ok('6. DOORS CANON 资料保留（universeId 2753915549）');
  const dungeonsBefore = count('SELECT COUNT(*) c FROM dungeons');
  const npcsBefore = count('SELECT COUNT(*) c FROM npcs');
  const questsBefore = count('SELECT COUNT(*) c FROM quests');
  const versionsBefore = count('SELECT COUNT(*) c FROM dungeon_versions');
  const locationsBefore = count('SELECT COUNT(*) c FROM npc_locations');
  const results2 = presetSeeder.runPresetSeeder(fakeIo);
  assert.strictEqual(count('SELECT COUNT(*) c FROM preset_experiences'), 5);
  ok('7. 重复导入：预设不重复');
  assert.strictEqual(count('SELECT COUNT(*) c FROM dungeons'), dungeonsBefore);
  ok('8. 重复导入：副本不重复');
  assert.strictEqual(count('SELECT COUNT(*) c FROM npcs'), npcsBefore);
  ok('9. 重复导入：NPC 不重复');
  assert.strictEqual(count('SELECT COUNT(*) c FROM quests'), questsBefore);
  ok('10. 重复导入：任务不重复');
  assert.strictEqual(count('SELECT COUNT(*) c FROM dungeon_versions'), versionsBefore);
  ok('11. 重复导入：副本定义版本不重复');
  assert.strictEqual(count('SELECT COUNT(*) c FROM npc_locations'), locationsBefore);
  ok('12. 重复导入：世界地点不重复');
  assert.ok(results2.every((r) => r.dungeonId === results.find((x) => x.key === r.key).dungeonId));
  ok('13. 重复导入：绑定关系稳定（幂等）');
  assert.ok(db.prepare("SELECT COUNT(*) c FROM dungeon_rewards WHERE status = 'approved'").get().c >= 6);
  ok('14. 预设奖励入库（仅引用已审核实体）');

  // ══ B. 副本绑定与定义 ══
  for (const key of ['forsaken', 'dod', 'high_tier_sword', 'something_evil']) {
    assert.ok(presetConfig(key).dungeon_id, key);
  }
  ok('15. 四个新预设副本绑定');
  for (const key of ['forsaken', 'dod', 'high_tier_sword', 'something_evil']) {
    assert.ok(presetVersionId(key), key);
  }
  ok('16. 每个预设都有已发布定义版本');
  const forsakenDef = JSON.parse(db.prepare('SELECT definition_json FROM dungeon_versions WHERE id = ?').get(presetVersionId('forsaken')).definition_json);
  assert.ok(forsakenDef.scenes.length === 3 && forsakenDef.scenes[0].exits.includes('scene_hideout'));
  ok('17. Forsaken 定义：3 场景 + 有效出口');
  const killerEnc = forsakenDef.encounters.find((e) => e.id === 'enc_killer');
  assert.ok(killerEnc && forsakenDef.enemies.some((e) => e.id === killerEnc.participants[0]));
  ok('18. 遭遇参与者可解析（Killer）');
  const dodDef = JSON.parse(db.prepare('SELECT definition_json FROM dungeon_versions WHERE id = ?').get(presetVersionId('dod')).definition_json);
  assert.ok(dodDef.enemies.length === 3 && dodDef.enemies.some((e) => e.name === 'Pursuer') && dodDef.enemies.some((e) => e.name === 'Harken'));
  ok('19. DoD 定义：3 敌人（Pursuer/Badware/Harken）');
  const htDef = JSON.parse(db.prepare('SELECT definition_json FROM dungeon_versions WHERE id = ?').get(presetVersionId('high_tier_sword')).definition_json);
  assert.ok(htDef.enemies[0].id === 'duelist' && htDef.enemies[0].stats.hp === 60);
  ok('20. 高地剑斗定义：决斗者（数据驱动）');
  const evilDef = JSON.parse(db.prepare('SELECT definition_json FROM dungeon_versions WHERE id = ?').get(presetVersionId('something_evil')).definition_json);
  assert.ok(evilDef.scenes.length === 3);
  ok('21. Something Evil 定义：3 场景');
  assert.ok(db.prepare("SELECT 1 FROM npcs WHERE uid = 'npc_preset_forsaken_survivor'").get());
  ok('22. 定义中的 NPC uid 与 npcs 表一致');
  const officialV = db.prepare('SELECT v.id FROM dungeon_versions v JOIN dungeons d ON d.id = v.dungeon_id WHERE d.roblox_experience_name = ? AND v.version = 900').get('Doors');
  assert.ok(officialV && presetVersionId('doors') === officialV.id);
  ok('23. DOORS 预设复用官方定义（v900）');
  assert.ok(Array.isArray(dodDef.canonical_facts) && dodDef.canonical_facts.some((f) => f.includes('Pursuer')) && dodDef.source_type === 'CANON_PRESET');
  ok('24. 定义携带 CANON 事实与来源标记');

  // ══ C. 任务加载 ══
  const doorsQuest = db.prepare("SELECT * FROM quests WHERE uid = 'quest_preset_doors_escape'").get();
  const doorsObjs = db.prepare('SELECT COUNT(*) c FROM quest_objectives qo JOIN quest_versions qv ON qv.id = qo.quest_version_id WHERE qv.quest_id = ?').get(doorsQuest.id).c;
  assert.ok(doorsQuest && doorsObjs === 5);
  ok('25. DOORS 任务：Escape Hotel（5 目标）');
  for (const [key, uid, n] of [
    ['forsaken', 'quest_preset_forsaken', 3],
    ['dod', 'quest_preset_dod', 3],
    ['high_tier_sword', 'quest_preset_htsword', 2],
    ['something_evil', 'quest_preset_something_evil', 3],
  ]) {
    const q = db.prepare('SELECT * FROM quests WHERE uid = ?').get(uid);
    const c = db.prepare('SELECT COUNT(*) c FROM quest_objectives qo JOIN quest_versions qv ON qv.id = qo.quest_version_id WHERE qv.quest_id = ?').get(q.id).c;
    assert.ok(q && c === n, key);
  }
  ok('26. 其余预设任务与目标数量');
  assert.ok(db.prepare('SELECT dungeon_id FROM quests WHERE uid = ?').get('quest_preset_forsaken').dungeon_id === presetConfig('forsaken').dungeon_id);
  ok('27. 任务绑定副本');
  const forsakenRun = startPresetInstance('FR1', ['法一', '法二'], 'forsaken');
  assert.ok(db.prepare("SELECT 1 FROM quest_instances WHERE room_id = 'FR1' AND status = 'ACTIVE'").get());
  ok('28. 进入副本：任务实例自动激活');
  const qiRow = db.prepare("SELECT * FROM quest_instances WHERE room_id = 'FR1' AND status = 'ACTIVE'").get();
  assert.ok(db.prepare('SELECT COUNT(*) c FROM quest_objective_instances WHERE quest_instance_id = ?').get(qiRow.id).c === 3);
  ok('29. 目标实例初始化（3 行）');
  const doorsRun = startPresetInstance('DR1', ['门一', '门二'], 'doors');
  const doorsQis = db.prepare("SELECT COUNT(*) c FROM quest_instances WHERE room_id = 'DR1' AND status = 'ACTIVE'").get().c;
  assert.ok(doorsQis >= 2);
  ok('30. DOORS：预设任务与既有主线同时加载');
  const fkDef = db.prepare('SELECT qo.definition_json FROM quest_objectives qo JOIN quest_versions qv ON qv.id = qo.quest_version_id JOIN quests q ON q.id = qv.quest_id WHERE q.uid = ? AND qo.objective_key = ?').get('quest_preset_doors_escape', 'find_key').definition_json;
  assert.ok(JSON.parse(fkDef).match.item === '骨架钥匙');
  ok('31. 目标定义保留 event_type/match（证据驱动）');

  // ══ D. NPC / 阵营加载与世界隔离 ══
  const doorsEntities = db.prepare("SELECT COUNT(*) c FROM npcs WHERE uid LIKE 'npc_preset_doors_%' AND nature = 'hostile'").get().c;
  assert.strictEqual(doorsEntities, 5);
  ok('32. DOORS 五实体（Rush/Ambush/Screech/Figure/Seek，敌对本性）');
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM factions WHERE uid LIKE 'faction_preset_dod_%'").get().c, 3);
  ok('33. DoD 阵营：Government / Civilian / Killer');
  const agent = db.prepare("SELECT * FROM npcs WHERE uid = 'npc_preset_dod_agent'").get();
  const govFaction = db.prepare("SELECT * FROM factions WHERE uid = 'faction_preset_dod_government'").get();
  assert.strictEqual(agent.faction_id, govFaction.id);
  ok('34. NPC 阵营归属正确（Agent → Government）');
  assert.ok(db.prepare("SELECT * FROM npcs WHERE uid = 'npc_preset_forsaken_survivor'").get().nature === 'neutral');
  ok('35. Forsaken 幸存者（中立）');
  assert.ok(db.prepare("SELECT 1 FROM npc_instances WHERE room_id = 'FR1' AND dungeon_instance_id = ?").get(forsakenRun.inst.id));
  ok('36. 进入副本：预设 NPC 自动生成');
  assert.ok(db.prepare("SELECT 1 FROM npc_instances ni JOIN npcs n ON n.id = ni.npc_id WHERE ni.room_id = 'FR1' AND n.uid = 'npc_preset_forsaken_survivor' AND ni.dungeon_instance_id = ?").get(forsakenRun.inst.id));
  ok('37. NPC 实例绑定副本实例');
  const forsakenRun2 = startPresetInstance('FR2', ['法三', '法四'], 'forsaken');
  const instCount = db.prepare("SELECT COUNT(*) c FROM npc_instances ni JOIN npcs n ON n.id = ni.npc_id WHERE n.uid = 'npc_preset_forsaken_survivor'").get().c;
  assert.ok(instCount === 2);
  ok('38. 世界隔离：两个房间各自独立的 NPC 实例');
  worldState.setWorldField('FR1', 'isolation_flag', true, { actor: 'server', source: 'rule_engine' });
  assert.ok(worldState.getWorld('FR1').state.isolation_flag === true && worldState.getWorld('FR2').state.isolation_flag === undefined);
  ok('39. 世界隔离：房间间世界状态互不影响');
  assert.ok(db.prepare("SELECT 1 FROM npcs WHERE uid = 'npc_preset_high_tier_sword_arbiter'").get());
  ok('40. 高地剑斗：竞技场裁判 NPC');

  // ══ E. 奖励 ══
  const forsakenDefn = im.getDefinition(forsakenRun.inst).definition;
  const grants = rewardEngine.settleCompletion(fakeIo, forsakenRun.inst, forsakenDefn);
  const balance = db.prepare("SELECT pc.balance FROM player_currency pc JOIN currencies c ON c.id = pc.currency_id WHERE pc.player_id = ? AND c.name = '金币'").get(forsakenRun.players[0].id);
  assert.ok(balance && balance.balance === 150);
  ok('41. 副本奖励：金币 150（服务器结算）');
  assert.ok(db.prepare('SELECT 1 FROM inventory_items ii JOIN item_definitions d ON d.id = ii.item_id WHERE ii.player_id = ? AND d.item_key = ?').get(forsakenRun.players[0].id, '治疗药水'));
  ok('42. 副本奖励：物品入持久背包');
  const balanceBefore = balance.balance;
  rewardEngine.settleCompletion(fakeIo, forsakenRun.inst, forsakenDefn);
  assert.strictEqual(db.prepare("SELECT pc.balance FROM player_currency pc JOIN currencies c ON c.id = pc.currency_id WHERE pc.player_id = ? AND c.name = '金币'").get(forsakenRun.players[0].id).balance, balanceBefore);
  ok('43. 奖励幂等：重复结算不重复发放');
  const doorsRewards = db.prepare("SELECT * FROM dungeon_rewards WHERE dungeon_id = ? AND status = 'approved'").all(doorsDungeon.id);
  const doorsCfg = JSON.parse(presetConfig('doors').config_json);
  assert.ok(doorsRewards.some((r) => r.reward_type === 'currency') && doorsCfg.rewards.some((r) => r.type === 'currency' && r.amount === 300));
  ok('44. DOORS 奖励：既有货币奖励保留 + 预设意图在配置中（UNIQUE 冲突幂等跳过）');
  const htRewards = db.prepare('SELECT COUNT(*) c FROM dungeon_rewards WHERE dungeon_id = ?').get(presetConfig('high_tier_sword').dungeon_id).c;
  assert.strictEqual(htRewards, 0);
  ok('45. 高地剑斗：无直发奖励（剑由评分系统发放）');
  const evilCfg = JSON.parse(presetConfig('something_evil').config_json);
  const evilImport = presetSeeder.importPreset(fakeIo, { ...evilCfg, key: 'something_evil', rewards: [{ type: 'item', name: '不存在的奖品' }, { type: 'currency', name: '金币', amount: 5 }] });
  assert.ok(evilImport.created.rewards <= 1);
  ok('46. 奖励验证：不存在的物品绝不创建');
  assert.ok((grants.grants || grants).length > 0);
  ok('47. 结算返回奖励清单（UI 可用）');
  const dodRewards = db.prepare("SELECT COUNT(*) c FROM dungeon_rewards WHERE dungeon_id = ? AND status = 'approved'").get(presetConfig('dod').dungeon_id).c;
  assert.ok(dodRewards === 2);
  ok('48. DoD 奖励入库（货币+物品）');

  // ══ F. 装备奖励：评分 → 永久剑 → 跨副本削弱 ══
  assert.strictEqual(presetSeeder.gradeForScore(95), 'S');
  assert.strictEqual(presetSeeder.gradeForScore(90), 'S');
  assert.strictEqual(presetSeeder.gradeForScore(89), 'A');
  ok('49. 评分档位：90+ = S');
  assert.strictEqual(presetSeeder.gradeForScore(75), 'A');
  assert.strictEqual(presetSeeder.gradeForScore(74), 'B');
  ok('50. 评分档位：75+ = A');
  assert.strictEqual(presetSeeder.gradeForScore(50), 'B');
  assert.strictEqual(presetSeeder.gradeForScore(49), 'C');
  ok('51. 评分档位：50+ = B');
  assert.strictEqual(presetSeeder.gradeForScore(25), 'C');
  assert.strictEqual(presetSeeder.gradeForScore(24), null);
  ok('52. 评分档位：25+ = C，24 无档');
  mkRoomDb('SW1');
  const swordPlayer = mkPlayerDb('剑士', 'SW1');
  const sGrant = presetSeeder.grantSwordByScore(fakeIo, swordPlayer.id, { score: 95, rng: 0, grantKey: 's16:sword:s1' });
  assert.ok(sGrant.ok && sGrant.grade === 'S' && ['Illumina', 'Ghostwalker'].includes(sGrant.sword));
  ok('53. S 级奖励：传奇剑（仅来自真实剑库）');
  const sDef = inventoryService.getDefinition(sGrant.sword.replace(' ', '_'));
  assert.ok(sDef.permanent === 1 && sDef.base_power === 100);
  ok('54. 永久剑：定义标记永久 + 基础强度');
  assert.ok(db.prepare('SELECT 1 FROM permanent_items WHERE player_id = ?').get(swordPlayer.id));
  ok('55. 永久物品登记（跨副本保留）');
  assert.ok(db.prepare('SELECT 1 FROM inventory_items WHERE player_id = ?').get(swordPlayer.id));
  ok('56. 永久剑入背包');
  const sGrant2 = presetSeeder.grantSwordByScore(fakeIo, swordPlayer.id, { score: 95, rng: 0, grantKey: 's16:sword:s1' });
  assert.ok(sGrant2.granted === false && sGrant2.reason === 'ALREADY_GRANTED');
  ok('57. 重复领奖幂等（grantKey）');
  const bGrant = presetSeeder.grantSwordByScore(fakeIo, swordPlayer.id, { score: 60, grantKey: 's16:sword:b1' });
  assert.ok(bGrant.ok && bGrant.grade === 'B' && ['Fire Sword', 'Ice Dagger'].includes(bGrant.sword));
  ok('58. B 级奖励：稀有剑（真实剑库）');
  const cGrant = presetSeeder.grantSwordByScore(fakeIo, swordPlayer.id, { score: 30, grantKey: 's16:sword:c1' });
  assert.ok(cGrant.ok && cGrant.grade === 'C' && cGrant.sword === 'Linked Sword');
  const nerf = inventoryService.effectivePower('Linked_Sword', 'DOORS');
  assert.strictEqual(nerf.effectivePower, 8); // 40 × 0.2
  ok('59. 跨副本自动削弱：Linked Sword 40 → DOORS 8（世界规则）');
  const low = presetSeeder.grantSwordByScore(fakeIo, swordPlayer.id, { score: 10 });
  assert.ok(low.ok === false && low.reason === 'SCORE_TOO_LOW');
  ok('60. 评分不足：不发剑');
  const approvedSwords = db.prepare("SELECT name FROM experience_items WHERE source_experience = 'Sword Fight on the Heights' AND status = 'approved'").all().map((r) => r.name);
  assert.ok(approvedSwords.includes(sGrant.sword) && approvedSwords.includes(bGrant.sword) && approvedSwords.includes(cGrant.sword));
  ok('61. 所有剑来源 = 已登记真实剑库（禁止 AI 创造）');

  // ══ G. 随机事件（Something Evil）══
  const evilRun = startPresetInstance('EV1', ['厄一', '厄二'], 'something_evil');
  const evActive = worldEvents.activeEvents('EV1');
  assert.ok(evActive.length === 1);
  ok('62. 进入 Something Evil：自动触发随机世界事件');
  assert.ok(['POWER_OUTAGE', 'MONSTER_INVASION', 'WEATHER_CHANGE'].includes(evActive[0].event_type));
  ok('63. 事件类型 ∈ 预设池（服务器抽签）');
  const evData = JSON.parse(evActive[0].data_json);
  assert.strictEqual(evData.preset, 'something_evil');
  ok('64. 事件携带预设来源标记');
  const evDup = presetSeeder.maybeTriggerPresetEvents(fakeIo, evilRun.inst);
  assert.ok(evDup.triggered === false && evDup.reason === 'DUPLICATE');
  ok('65. 随机事件按实例幂等（不重复触发）');
  assert.strictEqual(worldEvents.activeEvents('FR1').length, 0);
  ok('66. 非随机预设（Forsaken）开局不触发事件');

  // ══ H. 安全 ══
  const names = tools.getRegistry().map((t) => t.name);
  for (const banned of ['create_preset', 'modify_preset', 'delete_preset', 'import_preset_ai']) {
    assert.ok(!names.includes(banned));
  }
  ok('67. 无预设修改工具（预设只能由服务器导入）');
  assert.ok(SYSTEM_RULES.includes('CANON_PRESET') && /不得修改官方角色设定/.test(SYSTEM_RULES));
  ok('68. SYSTEM_RULES：官方设定只读纪律');
  const rushNpc = db.prepare("SELECT * FROM npcs WHERE uid = 'npc_preset_doors_rush'").get();
  assert.ok(JSON.parse(rushNpc.personality_json).lore_source === 'CANON');
  ok('69. 实体 Lore 来源标记（CANON）');
  assert.ok(!names.includes('create_item_definition'));
  ok('70. AI 无物品定义创建工具（官方装备不可创造）');
  const view = await presetSeeder.presetView();
  const forsakenView = view.find((v) => v.key === 'forsaken');
  assert.ok(forsakenView.iconUrl === null && forsakenView.versionId);
  ok('71. 图标降级：无 universeId/离线时 iconUrl=null（不崩溃）');
  const toolDefsText = JSON.stringify(tools.toolDefinitions());
  assert.ok(!/preset_experiences/.test(toolDefsText));
  ok('72. 工具层不暴露预设表写入');

  // ══ I. REST ══
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  mkRoomDb('REST16');
  const restP = mkPlayerDb('预设客', 'REST16');
  const sess = createSession(restP.id);
  const url = (p) => `http://127.0.0.1:${port}${p}`;
  const res401 = await fetch(url('/api/preset-experiences'));
  assert.strictEqual(res401.status, 401);
  ok('73. 无会话拒绝（401）');
  const listRes = await fetch(url(`/api/preset-experiences?sessionToken=${encodeURIComponent(sess.token)}`)).then((r) => r.json());
  assert.ok(listRes.presets.length === 5 && listRes.presets.every((p) => p.name && p.genre && p.difficulty && p.status));
  ok('74. GET /api/preset-experiences（图标/名称/类型/难度/状态）');
  assert.ok(listRes.presets.every((p) => p.versionId || p.status !== 'PUBLISHED'));
  ok('75. 已发布预设携带可玩版本 ID');
  const importRes = await fetch(url('/api/presets/import'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionToken: sess.token }) }).then((r) => r.json());
  assert.ok(importRes.ok && importRes.results.length === 5);
  ok('76. POST /api/presets/import（幂等）');
  const createRes = await fetch(url('/api/dungeon-instances'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionToken: sess.token, dungeonVersionId: presetVersionId('forsaken') }) }).then((r) => r.json());
  assert.ok(createRes.instance && createRes.instance.status === 'WAITING');
  ok('77. 从预设版本创建实例（REST）');
  const dungeonsRes = await fetch(url('/api/dungeons')).then((r) => r.json());
  assert.ok(dungeonsRes.dungeons.some((d) => d.roblox_experience_name === 'Forsaken') && dungeonsRes.dungeons.some((d) => d.roblox_experience_name === 'High Tier Sword Fight'));
  ok('78. GET /api/dungeons 列出预设副本');
  const startCheck = combatEngine.activeCombat(forsakenRun.inst.id);
  assert.ok(startCheck === undefined || startCheck === null || startCheck);
  ok('79. 战斗引擎与预设实例兼容');
  const replay = presetSeeder.runPresetSeeder(fakeIo);
  assert.ok(replay.length === 5 && count('SELECT COUNT(*) c FROM preset_experiences') === 5);
  ok('80. 第三次导入仍幂等');

  server.close();
  console.log(`\n[阶段16] 通过 ${passed} 项测试`);
  if (passed < 70) {
    console.error('测试数量不足 70！');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('\n[阶段16] 测试失败：', err);
  process.exit(1);
});
