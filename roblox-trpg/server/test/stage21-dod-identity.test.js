/**
 * 阶段21 测试：Civilian Identity Presentation System + NPC 修复（76 项）。
 * 覆盖：civilian_identity_profile 五字段 / Ability 外观映射（视觉表现+Lore解释，外观≠装备）/
 *       Background 一致性（穿着风格）/ Ability→人格倾向 / NPC 观察描述（不得直呼 Ability 名）/
 *       生成流（Background→Traits→Ability→Appearance→Personality）/ CIVILIAN_IDENTITY_CONTEXT /
 *       限制（无超级英雄外观/职业战士模板/固定角色）/ NPC 修复（进入副本不显示其他副本 NPC；
 *       AI GM 不能创建 NPC —— kind='npc' 降级、名册来源=服务器实例）。
 * 红线：外观不是装备（无属性/无数值/无穿戴加成）；不是复刻游戏皮肤系统。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

for (const suffix of ['', '-wal', '-shm', '-journal']) {
  fs.rmSync(path.join(__dirname, '../../database/data/roblox_trpg.db' + suffix), { force: true });
}

process.env.AI_API_KEY = 'ai-key-s21';
process.env.AI_BASE_URL = 'http://127.0.0.1:4121/v1';
process.env.AI_MODEL = 'mock-s21';
process.env.AI_STREAM = 'off';

const { server } = require('../src/index.js');
const dbMod = require('@roblox-trpg/database');
const db = dbMod.getDb();
const presetSeeder = require('../src/services/presets/presetSeeder');
const dodCivilian = require('../src/services/presets/dodCivilian');
const dodLore = require('../src/services/presets/dodLore');
const identitySvc = require('../src/services/presets/dodIdentityPresentation');
const npcEngine = require('../src/services/npcs/npcEngine');
const instanceManager = require('../src/services/runtime/instanceManager');
const contextBuilder = require('../src/services/ai/contextBuilder');
const { SYSTEM_RULES } = require('../src/services/ai/promptRules');
const { parseGmResponse } = require('../src/services/ai/structuredOutput');
const { createSession } = require('../src/sessions/sessionManager');

let passed = 0;
const ok = (label) => {
  passed += 1;
  console.log(`  ✓ ${label}`);
};
const fakeIo = { to: () => ({ emit: () => {} }), emit: () => {} };
const HERO_WORDS = /超级英雄|战衣|神装|铠甲|披风战士|超级战士|传说之|神话|救世主|传奇战士/;

function mkRoomDb(id) {
  db.prepare("INSERT OR IGNORE INTO rooms (id, status, max_players) VALUES (?, 'waiting', 3)").run(id);
}
let pSeq = 0;
function mkPlayerDb(name, roomId) {
  pSeq += 1;
  const uid = `player_s21_${pSeq}`;
  db.prepare('INSERT INTO players (uid, socket_id, name, room_id) VALUES (?, ?, ?, ?)').run(uid, `sock_${uid}`, name, roomId);
  return db.prepare('SELECT * FROM players WHERE uid = ?').get(uid);
}

async function main() {
  console.log('[test] 阶段21 就绪（76 项）\n');

  presetSeeder.runPresetSeeder(fakeIo);

  // ══ A. 身份表现档案数据模型 ══
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'civilian_identity_profile'").get());
  ok('1. civilian_identity_profile 表存在');
  const cols = db.prepare('PRAGMA table_info(civilian_identity_profile)').all().map((c) => c.name);
  ['appearance_traits', 'clothing_style', 'visual_markers', 'personality_expression', 'ability_signatures']
    .every((f) => cols.includes(f) || assert.fail(`缺字段 ${f}`));
  ok('2. 五字段齐全（appearance_traits/clothing_style/visual_markers/personality_expression/ability_signatures）');
  assert.ok(!cols.some((c) => /stat|attack|defense|hp|bonus|equip_slot/i.test(c)));
  ok('3. 无属性/装备槽字段（外观不是装备，不是皮肤系统）');
  const profile = identitySvc.buildIdentityProfile({
    background: 'Medic',
    abilities: ['Caretaker', 'Revolver'],
    personality: ['Selfless', 'Nervous'],
  });
  assert.ok(Array.isArray(profile.appearance_traits) && profile.clothing_style && Array.isArray(profile.visual_markers) && Array.isArray(profile.personality_expression) && Array.isArray(profile.ability_signatures));
  ok('4. buildIdentityProfile 输出五字段完整结构');
  mkRoomDb('IDN1');
  const pKeep = mkPlayerDb('档案测试者', 'IDN1');
  const saved = identitySvc.saveIdentityProfile(pKeep.id, profile);
  assert.ok(saved && saved.appearanceTraits.length && db.prepare('SELECT 1 FROM civilian_identity_profile WHERE player_id = ?').get(pKeep.id));
  const savedAgain = identitySvc.saveIdentityProfile(pKeep.id, profile);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM civilian_identity_profile WHERE player_id = ?').get(pKeep.id).c, 1);
  ok('5. 保存幂等（每玩家单行）');
  assert.strictEqual(identitySvc.getIdentityProfile(999002), null); // 不存在的玩家
  ok('6. 未生成档案返回空（不虚构）');

  // ══ B. Ability 外观映射（视觉表现 + Lore 解释）══
  const ct = identitySvc.abilityAppearance('Caretaker');
  assert.deepStrictEqual(ct.visual, ['医疗相关物品', '干净服饰', '急救用品']);
  assert.strictEqual(ct.lore, '这个人拥有医疗背景。');
  ok('7. Caretaker：医疗相关物品/干净服饰/急救用品 = 医疗背景');
  const bp = identitySvc.abilityAppearance('BonusPad');
  assert.deepStrictEqual(bp.visual, ['工程工具', '建筑用品', '工作服']);
  assert.strictEqual(bp.lore, '这个人拥有建造和工程经验。');
  ok('8. BonusPad：工程工具/建筑用品/工作服 = 建造和工程经验');
  const rv = identitySvc.abilityAppearance('Revolver');
  assert.deepStrictEqual(rv.visual, ['射击相关装备', '安全人员风格']);
  assert.strictEqual(rv.lore, '这个人过去接触枪械训练。');
  ok('9. Revolver：射击相关装备/安全人员风格 = 枪械训练');
  const catalogKeys = dodCivilian.ABILITY_CATALOG.map((a) => a.key);
  const loreKeys = require('../src/services/presets/dodAbilityLore').listAbilityLore().filter((l) => l.category !== 'synergy').map((l) => l.name);
  assert.ok(loreKeys.every((k) => identitySvc.abilityAppearance(k) !== null));
  ok('10. 全部 14 项 Ability 均有外观映射（含 Lore 项）');
  assert.ok(catalogKeys.every((k) => identitySvc.abilityAppearance(k) !== null));
  ok('11. 发放目录 Ability 外观全覆盖');
  for (const key of loreKeys) {
    const ap = identitySvc.abilityAppearance(key);
    assert.ok(ap.visual.length >= 1 && ap.lore && ap.npcObservation && ap.personalityTendencies.length >= 1, `${key} 外观档案不完整`);
  }
  ok('12. 每项外观档案含 visual/lore/npcObservation/personalityTendencies');
  assert.ok(!JSON.stringify(identitySvc.ABILITY_APPEARANCE).match(/\+?\d+\s*(伤害|HP|SP|攻击|防御|加成|%)|cooldown/i));
  ok('13. 外观映射无任何数值/加成词');
  assert.ok(!JSON.stringify(identitySvc.ABILITY_APPEARANCE).match(/穿戴.*获得|装备.*技能|解锁/i));
  ok('14. 无"穿戴装备获得技能"语义（外观≠装备）');

  // ══ C. Background 一致性（穿着风格）══
  assert.strictEqual(identitySvc.BACKGROUND_CLOTHING.Engineer, '耐磨实用的工作服，口袋里别着卷尺或笔');
  ok('15. Engineer → 工作服（工程背景一致）');
  assert.ok(identitySvc.BACKGROUND_CLOTHING.Medic.includes('干净'));
  ok('16. Medic → 干净便装（医疗背景一致）');
  assert.ok(identitySvc.BACKGROUND_CLOTHING.Cook.includes('围裙'));
  ok('17. Cook → 围裙（料理背景一致）');
  assert.ok(dodCivilian.BACKGROUNDS.every((b) => identitySvc.BACKGROUND_CLOTHING[b]));
  ok('18. 官方 6 背景全部有穿着风格');
  const engProfile = identitySvc.buildIdentityProfile({ background: 'Engineer', abilities: [], personality: [] });
  assert.strictEqual(engProfile.clothing_style, identitySvc.BACKGROUND_CLOTHING.Engineer);
  ok('19. clothing_style 来自 Background（与背景一致）');
  assert.ok(Object.values(identitySvc.BACKGROUND_CLOTHING).every((s) => !HERO_WORDS.test(s)));
  ok('20. 穿着风格无超级英雄外观词');

  // ══ D. Ability → 人格倾向 + 人格外向表现 ══
  assert.deepStrictEqual(identitySvc.abilityAppearance('Caretaker').personalityTendencies, ['Selfless', 'Calm', 'Protective']);
  ok('21. Caretaker 倾向：Selfless/Calm/Protective（官方例）');
  assert.deepStrictEqual(identitySvc.abilityAppearance('Punch').personalityTendencies, ['Confident', 'Aggressive', 'Competitive']);
  ok('22. Punch 倾向：Confident/Aggressive/Competitive（官方例）');
  assert.deepStrictEqual(identitySvc.abilityAppearance('Cloak').personalityTendencies, ['Careful', 'Secretive', 'Avoidant']);
  ok('23. Cloak 倾向：Careful/Secretive/Avoidant（官方例）');
  assert.deepStrictEqual(Object.keys(identitySvc.PERSONALITY_EXPRESSION).sort(), ['Brave', 'Careful', 'Creative', 'Nervous', 'Practical', 'Selfless']);
  ok('24. 六词人格池全部有外向表现描述');
  const mixed = identitySvc.buildIdentityProfile({ background: 'Security', abilities: ['Caretaker', 'Cloak'], personality: ['Brave'] });
  assert.ok(mixed.personality_expression.some((e) => e.startsWith('经历带来的倾向：')) && /Selfless/.test(mixed.personality_expression.join()) && /Secretive/.test(mixed.personality_expression.join()));
  ok('25. 多 Ability 倾向合并进 personality_expression');
  assert.ok(mixed.personality_expression.includes(identitySvc.PERSONALITY_EXPRESSION.Brave));
  ok('26. 人格外向表现来自六词池映射');
  assert.ok(/不改变能力/.test(mixed.personality_expression.find((e) => e.startsWith('经历带来的倾向：'))));
  ok('27. 倾向注明"只影响举止神态，不改变能力"');

  // ══ E. NPC 观察描述（不得直呼 Ability 名）══
  assert.strictEqual(identitySvc.abilityAppearance('Caretaker').npcObservation, '你的医疗经验看起来很明显。');
  ok('28. Caretaker 官方观察例句："你的医疗经验看起来很明显。"');
  for (const key of loreKeys) {
    const obs = identitySvc.abilityAppearance(key).npcObservation;
    assert.ok(!obs.includes(key), `${key} 观察语泄漏 Ability 名`);
  }
  ok('29. 全部观察语不包含自身 Ability 名称');
  assert.ok(/不能知道具体 Ability 名称|不能直呼他人的 Ability 名称/.test(identitySvc.NPC_IDENTIFICATION_RULE));
  assert.ok(identitySvc.NPC_IDENTIFICATION_RULE.includes('你是Caretaker玩家') && identitySvc.NPC_IDENTIFICATION_RULE.includes('你的医疗经验看起来很明显。'));
  ok('30. NPC 识别规则：错例"你是Caretaker玩家" + 正例"医疗经验明显"');
  const wrongStyle = /你是(Caretaker|Punch|Revolver)玩家|玩家获得|获得了?\w+技能/;
  assert.ok(!JSON.stringify(identitySvc.ABILITY_APPEARANCE).match(wrongStyle));
  ok('31. 全档案无"你是X玩家/获得技能"句式');

  // ══ F. 生成流（Background→Traits→Ability→Appearance→Personality）══
  mkRoomDb('IDN1');
  const pA = mkPlayerDb('表现居民', 'IDN1');
  const gen = dodLore.generateCivilianLore(fakeIo, pA.id, { rng: 0.1, background: 'Medic' });
  assert.ok(gen.created);
  const autoRow = identitySvc.getIdentityProfile(pA.id);
  assert.ok(autoRow && autoRow.appearanceTraits.length && autoRow.clothingStyle && autoRow.abilitySignatures.length);
  ok('32. 生成流自动落库身份表现档案');
  assert.strictEqual(autoRow.clothingStyle, identitySvc.BACKGROUND_CLOTHING.Medic);
  ok('33. 档案穿着风格与生成背景一致');
  const genAbilities = JSON.parse(gen.civilian.abilities);
  assert.deepStrictEqual(autoRow.abilitySignatures.map((s) => s.ability).sort(), [...genAbilities].sort());
  ok('34. ability_signatures 与生成的 Ability 一致');
  assert.ok(JSON.parse(gen.civilian.personality).length === 2);
  ok('35. 人格在 Ability 之后生成并保持六词池（阶段20 不变量）');
  // 旧身份（阶段17/20 无档案）补建
  const pLegacy = mkPlayerDb('旧身份居民', 'IDN1');
  dodCivilian.offerDecks(pLegacy.id, { rng: 0.5 });
  dodCivilian.createCivilianIdentity(fakeIo, pLegacy.id, { deckIndex: 1, rng: 0.5 });
  assert.strictEqual(identitySvc.getIdentityProfile(pLegacy.id), null);
  const backfilled = identitySvc.ensureIdentityProfile(pLegacy.id);
  assert.ok(backfilled && backfilled.abilitySignatures.length === 2);
  ok('36. 旧身份幂等补建档案（ensureIdentityProfile）');
  assert.strictEqual(identitySvc.ensureIdentityProfile(mkPlayerDb('非居民', 'IDN1').id), null);
  ok('37. 无 Civilian 身份 → 补建返回空');
  assert.strictEqual(identitySvc.ensureIdentityProfile(pA.id).appearanceTraits.length, autoRow.appearanceTraits.length);
  ok('38. ensureIdentityProfile 不覆盖已生成档案（幂等）');

  // ══ G. CIVILIAN_IDENTITY_CONTEXT ══
  const room = { id: 'IDN1', players: [{ name: '表现居民', socketId: pA.socket_id }], currentExperience: null, currentDungeon: { name: 'Die of Death' } };
  const ctx = contextBuilder.buildContext(room);
  const idSec = ctx.sections.find((s) => s.key === 'civilian_identity');
  assert.ok(idSec && idSec.label === 'CIVILIAN_IDENTITY_CONTEXT');
  ok('39. 新增 CIVILIAN_IDENTITY_CONTEXT 分区');
  assert.ok(idSec.content.includes(`Background: ${gen.civilian.background}`));
  ok('40. 含 Background:');
  assert.ok(/Traits: .+/.test(idSec.content));
  ok('41. 含 Traits:');
  assert.ok(/Ability: .+（仅GM可见/.test(idSec.content));
  ok('42. 含 Ability:（标注仅GM可见，叙事不得直呼）');
  assert.ok(/Appearance: .+/.test(idSec.content));
  ok('43. 含 Appearance:');
  assert.ok(/Personality: .+——/.test(idSec.content));
  ok('44. 含 Personality:（词 + 外向表现）');
  assert.ok(/NPC观察提示（\w+）: 「.+」/.test(idSec.content));
  ok('45. 含 NPC观察提示（观察语）');
  assert.ok(idSec.content.includes('外观不是装备'));
  ok('46. 分区声明：外观不是装备');
  assert.ok(idSec.content.includes('不能知道具体 Ability 名称') || idSec.content.includes('不得直呼Ability名'));
  ok('47. 分区携带 NPC 识别规则');
  assert.ok(idSec.content.includes('禁止超级英雄外观'));
  ok('48. 分区携带限制（无超级英雄外观/职业战士模板/固定角色）');
  const ctxEmpty = contextBuilder.buildContext({ id: 'IDN1', players: [{ name: '非居民', socketId: 'sock_none' }], currentExperience: null, currentDungeon: null });
  assert.ok(ctxEmpty.sections.find((s) => s.key === 'civilian_identity').content.includes('没有 Civilian 身份'));
  ok('49. 无身份房间：占位说明');
  assert.ok(/不能凭叙事"创建"NPC|NPC 只能由服务器流程生成/.test(SYSTEM_RULES));
  ok('50. SYSTEM_RULES：AI 不能创建 NPC');
  assert.ok(/不能直呼他人的 Ability 名称/.test(SYSTEM_RULES) && /你的医疗经验看起来很明显/.test(SYSTEM_RULES));
  ok('51. SYSTEM_RULES：NPC 观察纪律（含官方例句）');
  assert.ok(/外观是人生经历的可视化，不是装备/.test(SYSTEM_RULES));
  ok('52. SYSTEM_RULES：外观≠装备');

  // ══ H. 限制（无英雄化）══
  const allProfiles = dodCivilian.BACKGROUNDS.map((b) => identitySvc.buildIdentityProfile({ background: b, abilities: loreKeys, personality: ['Brave', 'Nervous', 'Selfless'] }));
  assert.ok(allProfiles.every((p) => !HERO_WORDS.test(JSON.stringify(p))));
  ok('53. 全背景×全能力组合无超级英雄/职业战士/救世主外观词');
  assert.ok(!JSON.stringify(identitySvc.ABILITY_APPEARANCE).match(/John|Mike|Alice/));
  ok('54. 无固定角色名（Civilian 保持模板）');
  assert.ok(identitySvc.IDENTITY_LIMIT_RULE.includes('普通 Robloxia 居民'));
  ok('55. 限制规则：始终普通 Robloxia 居民');
  const idSrc = fs.readFileSync(path.join(__dirname, '../src/services/presets/dodIdentityPresentation.js'), 'utf8');
  assert.ok(!/skin|皮肤系统|wearable|cosmetic_/i.test(idSrc));
  ok('56. 非皮肤/外观装备系统（无 skin/wearable 痕迹）');

  // ══ I. NPC 修复 1：进入副本不显示其他副本的 NPC ══
  mkRoomDb('NPCFIX');
  const dodDungeon = db.prepare("SELECT * FROM dungeons WHERE roblox_experience_name = 'Die of Death'").get();
  const doorsDungeon = db.prepare("SELECT * FROM dungeons WHERE roblox_experience_name = 'Doors'").get();
  const dodNpc = db.prepare("SELECT * FROM npcs WHERE uid = 'npc_preset_dod_agent'").get();
  const doorsNpc = db.prepare("SELECT * FROM npcs WHERE uid = 'npc_doors_keeper'").get();
  const legendNpc = db.prepare("SELECT * FROM npcs WHERE uid = 'npc_legend_builderman'").get();
  // 三个真实副本实例行（9101=旧 DOD / 9102=DOORS / 9103=新 DOD）
  const dodVersion = db.prepare("SELECT v.id FROM dungeon_versions v JOIN dungeons d ON d.id = v.dungeon_id WHERE d.roblox_experience_name = 'Die of Death' ORDER BY v.version DESC LIMIT 1").get();
  const mkInstance = (id) =>
    db.prepare(
      "INSERT OR IGNORE INTO dungeon_instances (id, uid, dungeon_version_id, room_id, status) VALUES (?, ?, ?, 'NPCFIX', 'COMPLETED')"
    ).run(id, `npcfix_inst_${id}`, dodVersion.id);
  mkInstance(9101);
  mkInstance(9102);
  mkInstance(9103);
  // 旧 DOD 实例（9101）的 NPC + 世界级传奇 + DOORS 实例（9102）的 NPC
  npcEngine.spawnNpcInstance(fakeIo, { npcId: dodNpc.id, roomId: 'NPCFIX', dungeonInstanceId: 9101 });
  npcEngine.spawnNpcInstance(fakeIo, { npcId: legendNpc.id, roomId: 'NPCFIX' });
  npcEngine.spawnNpcInstance(fakeIo, { npcId: doorsNpc.id, roomId: 'NPCFIX', dungeonInstanceId: 9102 });
  db.prepare("INSERT INTO room_memories (room_id, kind, content) VALUES ('NPCFIX', 'npc', '旧副本残留：某个不属于这里的NPC')").run();
  const namesBefore = npcEngine.npcInstancesInRoom('NPCFIX').map((ni) => ni.npc_id);
  assert.strictEqual(namesBefore.length, 3);
  ok('57. 修复前状态：房间含旧实例 NPC（可复现泄露）');
  instanceManager.cleanupRoomNpcs('NPCFIX', 9103); // 进入新实例 9103（DOD 重新进入）
  const after = npcEngine.npcInstancesInRoom('NPCFIX').map((ni) => ni.npc_id);
  assert.strictEqual(after.length, 1);
  assert.strictEqual(after[0], legendNpc.id);
  ok('58. 进入新副本：旧实例 NPC 全部清理（DOD/DOORS 实例 NPC 均移除）');
  assert.ok(!legendNpc || after.includes(legendNpc.id));
  ok('59. 世界级 NPC（未绑定实例的传奇）保留');
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM room_memories WHERE room_id = 'NPCFIX' AND kind = 'npc'").get().c, 0);
  ok('60. 旧 NPC 名册记忆清空');
  instanceManager.cleanupRoomNpcs('NPCFIX', 9103);
  assert.strictEqual(npcEngine.npcInstancesInRoom('NPCFIX').length, 1);
  ok('61. 清理幂等（重复执行无副作用）');
  // NPC 面板/Context 只显示当前可用 NPC
  const roomFix = { id: 'NPCFIX', players: [], currentExperience: null, currentDungeon: { name: 'Die of Death' } };
  const ctxFix = contextBuilder.buildContext(roomFix);
  const npcSec = ctxFix.sections.find((s) => s.key === 'npc').content;
  assert.ok(npcSec.includes('Builderman') && !npcSec.includes('旅馆管理员') && !npcSec.includes('Government Agent'));
  ok('62. NPC_STATE 不再显示其他副本的 NPC（名册=服务器实例）');

  // ══ J. NPC 修复 2：AI GM 不能创建 NPC ══
  const parsed = parseGmResponse(JSON.stringify({
    type: 'gm_response',
    narrative: '你遇到一位神秘的流浪者。',
    options: [],
    events: [],
    memory_update: [
      { kind: 'npc', content: '流浪者卡尔加入了队伍' },
      { kind: 'important_event', content: '你们穿过了大门' },
    ],
    rule_requests: [],
    source_references: [],
  }));
  assert.strictEqual(parsed.memory_update[0].kind, 'important_event');
  assert.strictEqual(parsed.memory_update[0].content, '流浪者卡尔加入了队伍');
  ok('63. structuredOutput：kind=npc 降级为 important_event（内容保留为记忆）');
  assert.strictEqual(parsed.memory_update[1].kind, 'important_event');
  ok('64. 合法 kind 原样保留');
  const agentSrc = fs.readFileSync(path.join(__dirname, '../src/services/ai/aiAgent.js'), 'utf8');
  assert.ok(/const kind = \['important_event', 'quest', 'location'\]\.includes\(m\.kind\)/.test(agentSrc));
  ok('65. persistGmOutcome 白名单写入（无 npc kind 入库）');
  db.prepare("INSERT INTO room_memories (room_id, kind, content) VALUES ('NPCFIX', 'npc', '伪造的AI创建NPC')").run();
  const ctxLeak = contextBuilder.buildContext(roomFix);
  assert.ok(!ctxLeak.sections.find((s) => s.key === 'npc').content.includes('伪造的AI创建NPC'));
  ok('66. NPC_STATE 不读取 npc 记忆（AI 无法通过记忆"创建"NPC）');
  assert.ok(!/kind.*'npc'/.test(fs.readFileSync(path.join(__dirname, '../src/services/ai/promptRules.js'), 'utf8').match(/memory_update[^\n]*/)[0]));
  ok('67. 输出格式文档：memory_update 无 npc kind');
  const toolNames = require('../src/services/ai/tools').getRegistry().map((t) => t.name);
  assert.ok(!toolNames.includes('create_npc') && !toolNames.some((n) => /create.*npc|spawn.*npc/i.test(n)));
  ok('68. 无 AI 创建/生成 NPC 工具（只有服务器流程）');

  // ══ K. REST ══
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const url = (p) => `http://127.0.0.1:${port}${p}`;
  const res401 = await fetch(url('/api/dod/civilian/identity'));
  assert.strictEqual(res401.status, 401);
  ok('69. REST 401 保护');
  const sess = createSession(pA.id);
  const idRes = await fetch(url(`/api/dod/civilian/identity?sessionToken=${encodeURIComponent(sess.token)}`)).then((r) => r.json());
  assert.ok(idRes.identity && idRes.identity.appearanceTraits.length && idRes.identity.abilitySignatures.length >= 1);
  assert.ok(/不是装备/.test(idRes.appearanceRule) && /不能直呼他人的 Ability 名称/.test(idRes.npcIdentificationRule) && /禁止超级英雄外观/.test(idRes.limitRule));
  ok('70. GET /api/dod/civilian/identity（档案 + 三条规则）');

  // ══ L. 生成随机性 ══
  const setA = new Set();
  for (let i = 0; i < 30; i += 1) {
    const pr = identitySvc.buildIdentityProfile({ background: 'Athlete', abilities: ['Punch', 'Dash'], personality: ['Brave', 'Careful'] });
    setA.add(pr.appearance_traits.join('|'));
  }
  assert.strictEqual(setA.size, 1); // 同输入确定性（外观由经历决定，非随机皮肤）
  ok('71. 外观由背景/能力/人格决定（确定性映射，不是随机皮肤）');
  const pr1 = identitySvc.buildIdentityProfile({ background: 'Athlete', abilities: ['Punch'], personality: ['Brave'] });
  const pr2 = identitySvc.buildIdentityProfile({ background: 'Athlete', abilities: ['Dash'], personality: ['Brave'] });
  assert.notDeepStrictEqual(pr1.appearance_traits, pr2.appearance_traits);
  ok('72. 不同 Ability → 不同外观表现');
  const pr3 = identitySvc.buildIdentityProfile({ background: 'Artist', abilities: ['Punch'], personality: ['Brave'] });
  assert.notStrictEqual(pr3.clothing_style, pr1.clothing_style);
  ok('73. 不同 Background → 不同穿着风格');
  const genB = dodLore.generateCivilianLore(fakeIo, mkPlayerDb('随机居民乙', 'IDN1').id, { rng: 0.55 });
  assert.ok(genB.created && identitySvc.getIdentityProfile(genB.civilian.player_id) !== null);
  ok('74. 不同种子生成均落库档案');
  const genC = dodLore.generateCivilianLore(fakeIo, mkPlayerDb('随机居民丙', 'IDN1').id, { rng: 0.91 });
  assert.ok(genC.created && identitySvc.getIdentityProfile(genC.civilian.player_id) !== null);
  ok('75. 多名居民档案独立（无固定角色）');
  const heroes = db.prepare("SELECT COUNT(*) c FROM civilian_identity_profile WHERE appearance_traits LIKE '%英雄%' OR clothing_style LIKE '%战衣%'").get().c;
  assert.strictEqual(heroes, 0);
  ok('76. 数据库中无英雄化外观档案');

  server.close();
  console.log(`\n[阶段21] 通过 ${passed} 项测试`);
  if (passed < 72) {
    console.error('测试数量不足！');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('\n[阶段21] 测试失败：', err);
  process.exit(1);
});
