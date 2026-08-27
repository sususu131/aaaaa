/**
 * 阶段20 测试：Civilian Background & Personality Simulation + 阵营关系去写死（66 项）。
 * 覆盖：civilian_background_profiles 档案库 / Background 定义（人生经历非职业）/
 *       Trait 生成（人格·经历·知识，非技能）/ Personality 生成（六词池，影响叙事不改数值）/
 *       Ability 解释（"你过去…因此你知道…"，禁止"获得技能"）/ Ability→Background 推断（非绑定）/
 *       随机生成流（Background→Traits→Ability解释）/ CIVILIAN_PROFILE_CONTEXT /
 *       无职业系统边界 / 阵营关系由预设声明（seed 不再写死，幂等不覆盖运行期改动）。
 * 红线：不制作游戏职业系统 —— 无职业等级/职业技能树/职业装备；不生成英雄身份。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

for (const suffix of ['', '-wal', '-shm', '-journal']) {
  fs.rmSync(path.join(__dirname, '../../database/data/roblox_trpg.db' + suffix), { force: true });
}

process.env.AI_API_KEY = 'ai-key-s20';
process.env.AI_BASE_URL = 'http://127.0.0.1:4120/v1';
process.env.AI_MODEL = 'mock-s20';
process.env.AI_STREAM = 'off';

const { server } = require('../src/index.js');
const dbMod = require('@roblox-trpg/database');
const db = dbMod.getDb();
const presetSeeder = require('../src/services/presets/presetSeeder');
const dodCivilian = require('../src/services/presets/dodCivilian');
const dodLore = require('../src/services/presets/dodLore');
const dodAbilityLore = require('../src/services/presets/dodAbilityLore');
const profileSvc = require('../src/services/presets/dodBackgroundProfile');
const factionRelations = require('../src/services/world/factionRelations');
const contextBuilder = require('../src/services/ai/contextBuilder');
const { SYSTEM_RULES } = require('../src/services/ai/promptRules');
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
  const uid = `player_s20_${pSeq}`;
  db.prepare('INSERT INTO players (uid, socket_id, name, room_id) VALUES (?, ?, ?, ?)').run(uid, `sock_${uid}`, name, roomId);
  return db.prepare('SELECT * FROM players WHERE uid = ?').get(uid);
}
function mkCivilianDb(playerId, background, traits, abilities, personality, profileTraits) {
  db.prepare(
    `INSERT INTO civilian_instance (player_id, background, traits, abilities, synergy_state, source, life_experience, personality_traits, personality, profile_traits)
     VALUES (?, ?, ?, ?, 'NONE', 'DIE_OF_DEATH', ?, ?, ?, ?)`
  ).run(
    playerId,
    background,
    JSON.stringify(traits),
    JSON.stringify(abilities),
    `灾变前是一名${background}。`,
    JSON.stringify(traits),
    JSON.stringify(personality || []),
    JSON.stringify(profileTraits || [])
  );
  return dodCivilian.getCivilian(playerId);
}

async function main() {
  console.log('[test] 阶段20 就绪（66 项）\n');

  presetSeeder.runPresetSeeder(fakeIo);

  // ══ A. Background 档案库 ══
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'civilian_background_profiles'").get());
  ok('1. civilian_background_profiles 表存在');
  const cols = db.prepare('PRAGMA table_info(civilian_background_profiles)').all().map((c) => c.name);
  ['id', 'background_type', 'description', 'possible_traits', 'possible_abilities', 'personality_patterns']
    .every((f) => cols.includes(f) || assert.fail(`缺字段 ${f}`));
  ok('2. 字段齐全（id/background_type/description/possible_traits/possible_abilities/personality_patterns）');
  const n1 = profileSvc.ensureBackgroundProfilesSeeded();
  profileSvc.ensureBackgroundProfilesSeeded();
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM civilian_background_profiles').get().c, n1);
  ok('3. 播种幂等');
  const profiles = profileSvc.listProfiles();
  assert.strictEqual(profiles.length, 6);
  assert.ok(['Engineer', 'Medic', 'Athlete', 'Security', 'Cook', 'Artist'].every((b) => profiles.some((p) => p.background_type === b)));
  ok('4. 覆盖官方 6 背景（Engineer/Medic/Athlete/Security/Cook/Artist）');
  assert.ok(profiles.every((p) => p.source === 'DIE_OF_DEATH' && p.description && p.possible_traits.length && p.possible_abilities.length && p.personality_patterns.length));
  ok('5. 每条档案字段完整');
  assert.ok(!cols.some((c) => /level|skill_?[tree]|equipment|tier/i.test(c)));
  ok('6. 无职业等级/技能树/装备字段');
  assert.ok(!JSON.stringify(profiles).match(/"level"|"skillTree"|"equipment"/i));
  ok('7. 档案内容无职业系统痕迹');

  // ══ B. Background 定义（规格内容）══
  const eng = profileSvc.getProfile('Engineer');
  assert.strictEqual(eng.description, '拥有机械、建筑或者创造经验的人。');
  assert.deepStrictEqual(eng.possible_traits, ['Engineering Knowledge', 'Problem Solving', 'Construction Experience']);
  assert.deepStrictEqual(eng.possible_abilities, ['BonusPad', 'Block']);
  ok('8. Engineer：机械/建筑/创造经验 + 3 Trait + BonusPad/Block');
  const med = profileSvc.getProfile('Medic');
  assert.ok(/护士|医生|志愿者|照顾家人/.test(med.description));
  assert.deepStrictEqual(med.possible_traits, ['Medical Knowledge', 'Empathy', 'First Aid']);
  assert.deepStrictEqual(med.possible_abilities, ['Caretaker']);
  ok('9. Medic：医疗/护理/助人经验（护士/医生/志愿者/照顾家人）+ Caretaker');
  const ath = profileSvc.getProfile('Athlete');
  assert.deepStrictEqual(ath.possible_traits, ['Physical Training', 'Endurance', 'Fast Reaction']);
  assert.deepStrictEqual(ath.possible_abilities, ['Punch', 'Dash', 'Adrenaline']);
  ok('10. Athlete：体育训练 + Punch/Dash/Adrenaline');
  const sec = profileSvc.getProfile('Security');
  assert.deepStrictEqual(sec.possible_traits, ['Weapon Familiarity', 'Awareness', 'Defense Training']);
  assert.deepStrictEqual(sec.possible_abilities, ['Revolver', 'Block']);
  ok('11. Security：安全/防卫/危险环境 + Revolver/Block');
  const cok = profileSvc.getProfile('Cook');
  assert.deepStrictEqual(cok.possible_traits, ['Cooking', 'Food Knowledge']);
  assert.deepStrictEqual(cok.possible_abilities, ['Hotdog', 'Pie']);
  ok('12. Cook：料理经验 + Hotdog/Pie');
  assert.strictEqual(profileSvc.getProfile('engineer').background_type, 'Engineer');
  ok('13. 按 background_type 或 id 读取均可');
  assert.ok(profiles.every((p) => p.personality_patterns.every((w) => profileSvc.PERSONALITY_POOL.includes(w))));
  ok('14. personality_patterns ⊆ 官方人格池（Brave/Careful/Selfless/Practical/Creative/Nervous）');

  // ══ C. Trait 生成（Trait 不是技能）══
  const t1 = profileSvc.rollProfileTraits('Engineer', 0.2);
  const t2 = profileSvc.rollProfileTraits('Engineer', 0.9);
  assert.ok(t1.length === 2 && t2.length === 2);
  assert.ok(eng.possible_traits.includes(t1[0]) && eng.possible_traits.includes(t2[0]));
  ok('15. 主特点 ∈ 该背景 possible_traits');
  const union = profileSvc.allProfileTraits();
  assert.ok(t1.every((t) => union.includes(t)) && t2.every((t) => union.includes(t)));
  ok('16. 次特点 ∈ 全档案并集（任何居民都可能有任何经历特点）');
  assert.notDeepStrictEqual(t1, t2);
  ok('17. 随机性：不同种子产生不同特点组合');
  const skillRows = db.prepare("SELECT COUNT(*) c FROM skills WHERE name IN ('Engineering Knowledge','Problem Solving','Endurance','Awareness','Food Knowledge')").get().c;
  assert.strictEqual(skillRows, 0);
  ok('18. Trait 不是技能：档案 Trait 不入 skills 表');

  // ══ D. Personality 生成 ══
  const p1 = profileSvc.rollPersonality('Engineer', 0.15);
  const p2 = profileSvc.rollPersonality('Engineer', 0.85);
  assert.ok(p1.length === 2 && p2.length === 2);
  assert.ok(p1.every((w) => profileSvc.PERSONALITY_POOL.includes(w)) && p2.every((w) => profileSvc.PERSONALITY_POOL.includes(w)));
  ok('19. 人格 ⊆ 官方六词池');
  assert.ok(eng.personality_patterns.includes(p1[0]) && eng.personality_patterns.includes(p2[0]));
  ok('20. 主人格 ∈ 背景 personality_patterns');
  assert.notDeepStrictEqual(p1, p2);
  ok('21. 随机性：不同种子产生不同人格');
  assert.deepStrictEqual(profileSvc.PERSONALITY_POOL, ['Brave', 'Careful', 'Selfless', 'Practical', 'Creative', 'Nervous']);
  ok('22. 人格池无英雄化词汇（无 Heroic/Legendary/Savior）');

  // ══ E. Ability 解释（GM 用语）══
  assert.strictEqual(profileSvc.gmAbilityPhrasing('Caretaker'), '你过去接受过医疗训练，因此你知道如何处理伤员');
  ok('23. Caretaker 官方句式："你过去接受过医疗训练，因此你知道如何处理伤员"');
  assert.ok(Object.values(profileSvc.ABILITY_GM_PHRASING).every((s) => s.startsWith('你') && /因此你/.test(s)));
  ok('24. 全部解释为"你过去…因此你知道/能…"句式（第二人称人生经历）');
  assert.ok(!JSON.stringify(profileSvc.ABILITY_GM_PHRASING).match(/获得了?[^"）]*技能/));
  ok('25. 无"你获得了X技能"句式');
  assert.ok(/护士|医生|志愿者|照顾家人/.test(profileSvc.getProfile('Medic').description));
  ok('26. Caretaker 多来源：护士/医生/志愿者/照顾家人（1 Ability ≠ 1 职业）');
  assert.ok(dodAbilityLore.backgroundAbilityWeight('Block', 'Engineer') === 3 && dodAbilityLore.backgroundAbilityWeight('Block', 'Security') === 3);
  ok('27. Block 关联多个 Background（Engineer + Security）');
  assert.ok(/不能说"你获得了X技能"/.test(profileSvc.GM_PHRASING_RULE));
  ok('28. GM 用语总规则（禁"获得技能"句式）');

  // ══ F. Ability → Background 推断 ══
  const inf1 = profileSvc.inferBackgroundFromAbilities(['BonusPad', 'Block']);
  assert.strictEqual(inf1.top, 'Engineer');
  ok('29. BonusPad+Block → 推断 Engineer（依据匹配 Ability）');
  const inf2 = profileSvc.inferBackgroundFromAbilities(['Revolver', 'Block']);
  assert.strictEqual(inf2.top, 'Security');
  ok('30. Revolver+Block → 推断 Security（权重计分：Lore 关联 2 > 档案命中 1）');
  const inf3 = profileSvc.inferBackgroundFromAbilities(['Caretaker']);
  assert.strictEqual(inf3.top, 'Medic');
  ok('31. Caretaker → 推断 Medic');
  const inf4 = profileSvc.inferBackgroundFromAbilities(['Cloak', 'Taunt']);
  assert.strictEqual(inf4.top, null);
  ok('32. 无关联 Ability → 不强行推断（top=null，不虚构）');
  assert.ok(inf1.candidates.length === 6 && inf1.candidates.some((c) => c.score === 0));
  ok('33. 推断返回全部候选（含 0 分背景：不是职业锁定）');
  assert.ok(/不构成职业绑定|多种人生/.test(inf1.note));
  ok('34. 推断注明非绑定（同一能力可来自多种人生）');
  const inf5 = profileSvc.inferBackgroundFromAbilities(['Adrenaline']);
  assert.strictEqual(inf5.top, 'Athlete'); // 档案 possible_abilities 命中（Lore 无关联背景）
  ok('35. 档案 possible_abilities 参与推断（Adrenaline → Athlete）');

  // ══ G. 随机生成流（Background → Traits → Ability 解释）══
  mkRoomDb('PRF1');
  const pA = mkPlayerDb('档案居民甲', 'PRF1');
  const genA = dodLore.generateCivilianLore(fakeIo, pA.id, { rng: 0.2, background: 'Medic' });
  assert.ok(genA.created);
  const personality = JSON.parse(genA.civilian.personality);
  const profileTraits = JSON.parse(genA.civilian.profile_traits);
  assert.ok(personality.length === 2 && personality.every((w) => profileSvc.PERSONALITY_POOL.includes(w)));
  ok('36. 生成流写入人格（六词池内 2 项）');
  assert.ok(profileTraits.length === 2 && profileTraits[0] === 'Medical Knowledge' || med.possible_traits.includes(profileTraits[0]));
  ok('37. 生成流写入背景特点（主特点来自 Medic 档案）');
  assert.ok(profileSvc.getProfile(genA.civilian.background).personality_patterns.includes(personality[0]));
  ok('38. 人格主人格与背景倾向一致（Medic → Selfless/Careful/Brave）');
  const pB = mkPlayerDb('档案居民乙', 'PRF1');
  const genB = dodLore.generateCivilianLore(fakeIo, pB.id, { rng: 0.87, background: 'Medic' });
  assert.notDeepStrictEqual(JSON.parse(genB.civilian.personality), personality);
  ok('39. 随机性：同背景不同种子 → 不同人格');
  const viewA = dodLore.loreView(pA.id);
  assert.ok(viewA.personality.length === 2 && viewA.profileTraits.length === 2);
  ok('40. loreView 暴露 personality / profileTraits');
  const profA = dodLore.profileView(pA.id);
  assert.ok(profA.background === 'Medic' && /护士/.test(profA.backgroundDescription));
  assert.strictEqual(profA.backgroundSurvivalLore, '这个Civilian过去负责帮助伤员，在Killers出现后，他的经验成为生存优势。');
  ok('41. profileView：背景描述 + 生存优势 Lore（官方示例句）');
  assert.ok(profA.abilities.length === 2 && profA.abilities.every((a) => a.gmPhrasing && /因此你/.test(a.gmPhrasing)));
  ok('42. profileView：每个 Ability 附"你过去…因此你…"解释');
  assert.ok(profA.inferredBackground && profA.inferredBackground.candidates.length === 6);
  ok('43. profileView：背景推断（全候选，非锁定）');
  const profNone = dodLore.profileView(mkPlayerDb('无身份者', 'PRF1').id);
  assert.strictEqual(profNone, null);
  ok('44. 无身份 → profileView 返回空（不虚构）');

  // ══ H. CIVILIAN_PROFILE_CONTEXT ══
  const room = { id: 'PRF1', players: [{ name: '档案居民甲', socketId: pA.socket_id }], currentExperience: null, currentDungeon: null };
  const ctx = contextBuilder.buildContext(room);
  const profSec = ctx.sections.find((s) => s.key === 'civilian_profile');
  assert.ok(profSec && profSec.label === 'CIVILIAN_PROFILE_CONTEXT');
  ok('45. 新增 CIVILIAN_PROFILE_CONTEXT 分区');
  assert.ok(profSec.content.includes('Background: Medic —— '));
  ok('46. 格式：Background:（类型 + 经历描述）');
  assert.ok(/Traits: .*(医疗|Medical)/.test(profSec.content) && /背景特点：/.test(profSec.content));
  ok('47. 格式：Traits:（官方特点 + 背景特点）');
  assert.ok(/Personality: \w+、?\w*/.test(profSec.content));
  ok('48. 格式：Personality:');
  assert.ok(profSec.content.includes('Life Experience:'));
  ok('49. 格式：Life Experience:');
  assert.ok(/Ability Explanation: \w+ —— 你过去/.test(profSec.content));
  ok('50. 格式：Ability Explanation:（"你过去…"第二人称）');
  assert.ok(profSec.content.includes('Survival Lore: 这个Civilian过去负责帮助伤员'));
  ok('51. Survival Lore（Killers出现后经验成为生存优势）');
  assert.ok(/Inferred Background: \w+（依据/.test(profSec.content) && /不构成职业绑定/.test(profSec.content));
  ok('52. Inferred Background（推断 + 非绑定声明）');
  assert.ok(profSec.content.includes('不是职业') && profSec.content.includes('无职业等级/技能树/装备'));
  ok('53. 分区声明：Background 不是职业');
  assert.ok(profSec.content.includes('绝不改变属性或检定数值'));
  ok('54. 人格说明：影响叙事/NPC互动/剧情选择，不改数值');
  assert.ok(/你获得了X技能/.test(SYSTEM_RULES) && /你过去接受过X训练/.test(SYSTEM_RULES));
  ok('55. SYSTEM_RULES：GM 用语纪律（禁"获得技能"）');
  const ctxEmpty = contextBuilder.buildContext({ id: 'PRF1', players: [{ name: '无身份者', socketId: 'sock_none' }], currentExperience: null, currentDungeon: null });
  assert.ok(ctxEmpty.sections.find((s) => s.key === 'civilian_profile').content.includes('没有 Civilian 身份'));
  ok('56. 无身份房间：占位说明');
  assert.ok(!fs.readFileSync(path.join(__dirname, '../src/services/presets/dodBackgroundProfile.js'), 'utf8').match(/round_system|win_condition|cooldown|damage/i));
  ok('57. 档案模块无玩法/数值痕迹');

  // ══ I. 阵营关系：预设声明取代 seed 写死 ══
  const seedSql = fs.readFileSync(path.join(__dirname, '../../database/seed.sql'), 'utf8');
  assert.ok(!/INSERT OR IGNORE INTO faction_relations/.test(seedSql));
  ok('58. seed.sql 不再写死阵营关系');
  const dodCfg = JSON.parse(db.prepare("SELECT c.config_json FROM preset_dungeon_configs c JOIN preset_experiences p ON p.id = c.preset_id WHERE p.key = 'dod'").get().config_json);
  const doorsCfg = JSON.parse(db.prepare("SELECT c.config_json FROM preset_dungeon_configs c JOIN preset_experiences p ON p.id = c.preset_id WHERE p.key = 'doors'").get().config_json);
  assert.ok(dodCfg.faction_relations.length === 2 && doorsCfg.faction_relations.length === 2);
  ok('59. dod/doors 预设声明 faction_relations（各 2 条）');
  const fCiv = db.prepare("SELECT * FROM factions WHERE uid = 'faction_preset_dod_civilian'").get();
  const fKil = db.prepare("SELECT * FROM factions WHERE uid = 'faction_preset_dod_killer'").get();
  const fGov = db.prepare("SELECT * FROM factions WHERE uid = 'faction_preset_dod_government'").get();
  assert.strictEqual(factionRelations.getFactionRelation(fCiv.id, fKil.id).relation, 'HOSTILE');
  assert.strictEqual(factionRelations.getFactionRelation(fCiv.id, fGov.id).relation, 'NEUTRAL');
  ok('60. DOD：Civilian↔Killer=HOSTILE（天生敌对）；Civilian↔Government=NEUTRAL（观望）');
  const survivors = db.prepare("SELECT * FROM factions WHERE uid = 'faction_doors_survivors'").get();
  const entities = db.prepare("SELECT * FROM factions WHERE uid = 'faction_doors_entities'").get();
  const keeper = db.prepare("SELECT * FROM factions WHERE uid = 'faction_doors_keeper'").get();
  assert.strictEqual(factionRelations.getFactionRelation(survivors.id, entities.id).relation, 'HOSTILE');
  assert.strictEqual(factionRelations.getFactionRelation(survivors.id, keeper.id).relation, 'NEUTRAL');
  ok('61. DOORS：幸存者↔实体=HOSTILE、幸存者↔管理员=NEUTRAL（由预设导入恢复）');
  factionRelations.setFactionRelation(fakeIo, survivors.id, entities.id, 'ALLIED', { source: 'test', reason: '运行期改动', roomId: 'PRF1' });
  presetSeeder.runPresetSeeder(fakeIo);
  assert.strictEqual(factionRelations.getFactionRelation(survivors.id, entities.id).relation, 'ALLIED');
  ok('62. 幂等：重复导入不覆盖运行期关系改动（ALLIED 保持）');
  dodCivilian.ensureSeeded();
  const robloxia = db.prepare("SELECT * FROM factions WHERE uid = 'faction_dod_robloxia_citizens'").get();
  assert.strictEqual(factionRelations.getFactionRelation(robloxia.id, fKil.id).relation, 'HOSTILE');
  assert.strictEqual(factionRelations.getFactionRelation(robloxia.id, fGov.id).relation, 'NEUTRAL');
  ok('63. Robloxia Citizens↔Killer=HOSTILE、↔Government=NEUTRAL（dodCivilian 播种）');

  // ══ J. REST ══
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const url = (p) => `http://127.0.0.1:${port}${p}`;
  const res401 = await fetch(url('/api/dod/civilian/profile'));
  assert.strictEqual(res401.status, 401);
  ok('64. REST 401 保护');
  const sess = createSession(pA.id);
  const profRes = await fetch(url(`/api/dod/civilian/profile?sessionToken=${encodeURIComponent(sess.token)}`)).then((r) => r.json());
  assert.ok(profRes.profile && profRes.profile.background === 'Medic' && profRes.profile.abilities.every((a) => a.gmPhrasing));
  ok('65. GET /api/dod/civilian/profile（档案 + Ability 解释）');
  const bgRes = await fetch(url(`/api/dod/backgrounds?sessionToken=${encodeURIComponent(sess.token)}`)).then((r) => r.json());
  assert.ok(bgRes.backgrounds.length === 6 && bgRes.personalityPool.length === 6 && /不是职业/.test(bgRes.note));
  ok('66. GET /api/dod/backgrounds（6 档案 + 人格池 + 非职业声明）');

  server.close();
  console.log(`\n[阶段20] 通过 ${passed} 项测试`);
  if (passed < 62) {
    console.error('测试数量不足！');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('\n[阶段20] 测试失败：', err);
  process.exit(1);
});
