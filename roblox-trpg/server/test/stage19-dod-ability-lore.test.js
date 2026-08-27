/**
 * 阶段19 测试：Civilian Ability Lore Integration（88 项）。
 * 覆盖：Ability Lore 数据库读取 / 解释规则（不是魔法）/ Background 权重关联（无职业锁定）/
 *       Trait 解释 / AI Context（DOD_CIVILIAN_CONTEXT + Lore Explanation）/ Synergy 预留 /
 *       边界（无战斗数值字段、无技能UI）/ Flashlight 官方 Library 集成（徒步/探索/向导，
 *       使用机制与数值不入库）/ 官方 Library 合集全量集成（14 项基础 library_excerpt、
 *       官方 Synergy 表 4 条登记、Artist↔表演系关联、居民关系、全库无数字）。
 * 红线：不制作游戏技能系统 —— 不实现 Cooldown/Damage/HP/SP/战斗数值/技能UI；不实现 Synergy 逻辑。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

for (const suffix of ['', '-wal', '-shm', '-journal']) {
  fs.rmSync(path.join(__dirname, '../../database/data/roblox_trpg.db' + suffix), { force: true });
}

process.env.AI_API_KEY = 'ai-key-s19';
process.env.AI_BASE_URL = 'http://127.0.0.1:4119/v1';
process.env.AI_MODEL = 'mock-s19';
process.env.AI_STREAM = 'off';

const { server } = require('../src/index.js');
const dbMod = require('@roblox-trpg/database');
const db = dbMod.getDb();
const presetSeeder = require('../src/services/presets/presetSeeder');
const dodCivilian = require('../src/services/presets/dodCivilian');
const dodLore = require('../src/services/presets/dodLore');
const dodAbilityLore = require('../src/services/presets/dodAbilityLore');
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
  const uid = `player_s19_${pSeq}`;
  db.prepare('INSERT INTO players (uid, socket_id, name, room_id) VALUES (?, ?, ?, ?)').run(uid, `sock_${uid}`, name, roomId);
  return db.prepare('SELECT * FROM players WHERE uid = ?').get(uid);
}
function mkCivilianDb(playerId, background, traits, abilities) {
  db.prepare(
    `INSERT INTO civilian_instance (player_id, background, traits, abilities, synergy_state, source, life_experience, personality_traits)
     VALUES (?, ?, ?, ?, 'NONE', 'DIE_OF_DEATH', ?, ?)`
  ).run(playerId, background, JSON.stringify(traits), JSON.stringify(abilities), `灾变前是一名${background}。`, JSON.stringify(traits));
  return dodCivilian.getCivilian(playerId);
}
const MAGIC_WORDS = /魔法|法术|超能力|召唤|咒语|mana/i;
const NUMERIC_KEYS = /"(cooldown|damage|hp|sp|attack|crit|mana|combat_value|damage_value)"/i;

async function main() {
  console.log('[test] 阶段19 就绪（88 项）\n');

  presetSeeder.runPresetSeeder(fakeIo);

  // ══ A. Ability Lore Database（读取）══
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dod_abilities_lore'").get());
  ok('1. dod_abilities_lore 表存在');
  const loreCols = db.prepare('PRAGMA table_info(dod_abilities_lore)').all().map((c) => c.name);
  ['id', 'name', 'source', 'category', 'core_trait', 'possible_background', 'lore_description', 'personality_connection', 'synergy_candidates']
    .every((f) => loreCols.includes(f) || assert.fail(`缺字段 ${f}`));
  ok('2. 每条 Lore 记录字段齐全（id/name/source/category/core_trait/possible_background/lore_description/personality_connection/synergy_candidates）');
  const count1 = dodAbilityLore.ensureAbilityLoreSeeded();
  dodAbilityLore.ensureAbilityLoreSeeded();
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM dod_abilities_lore').get().c, count1);
  ok('3. 播种幂等（重复运行不重复）');
  const allLore = dodAbilityLore.listAbilityLore();
  assert.strictEqual(allLore.length, 18); // 14 基础 Ability + 4 官方 Synergy 结果登记
  ok('4. Lore 目录完整（14 基础：Punch/Caretaker/Revolver/Hotdog/Pie/BonusPad/Dash/Block/Flashlight/Adrenaline/BananaPeel/Cloak/Taunt/Bugle + 4 Synergy：CarePad/Loveshot/SweetTooth/Noisemaker）');
  assert.ok(allLore.every((l) => l.source === 'DIE_OF_DEATH'));
  ok('5. 全部 source = DIE_OF_DEATH');
  assert.ok(allLore.every((l) => l.category && l.core_trait && l.lore_description && l.personality_connection));
  ok('6. category / core_trait / lore_description / personality_connection 均非空');
  const punchLore = dodAbilityLore.getAbilityLore('Punch');
  assert.ok(punchLore && dodAbilityLore.getAbilityLore('punch').name === 'Punch');
  ok('7. 按 name 或 id 读取均可');
  assert.ok(Array.isArray(punchLore.possible_background) && Array.isArray(punchLore.synergy_candidates) && Array.isArray(punchLore.explaining_traits));
  ok('8. possible_background / synergy_candidates / explaining_traits 为列表');
  assert.strictEqual(dodAbilityLore.getAbilityLore('不存在的Ability'), null);
  ok('9. 未知 Ability 返回空（不虚构 Lore）');
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM dod_abilities_lore WHERE category = 'synergy'").get().c, 4);
  ok('10. Synergy 结果单独分类（carepad/loveshot/sweettooth/noisemaker 仅登记）');

  // ══ B. 解释规则：Ability 不是魔法，是过去的人生经历 ══
  assert.ok(/优秀身体素质/.test(punchLore.lore_description) && /格斗训练/.test(punchLore.lore_description) && /体育经历/.test(punchLore.lore_description) && /长期锻炼/.test(punchLore.lore_description));
  ok('11. Punch = 优秀身体素质（格斗训练/体育经历/长期锻炼）');
  const caretakerLore = dodAbilityLore.getAbilityLore('Caretaker');
  assert.ok(/医疗知识/.test(caretakerLore.lore_description) && /照顾他人/.test(caretakerLore.lore_description));
  ok('12. Caretaker = 医疗知识 + 照顾他人的经验（不是治疗技能）');
  const revolverLore = dodAbilityLore.getAbilityLore('Revolver');
  assert.ok(/枪械训练/.test(revolverLore.lore_description) && /射击经验/.test(revolverLore.lore_description) && /安全职业背景/.test(revolverLore.lore_description));
  ok('13. Revolver = 枪械训练/射击经验/安全职业背景（不是召唤枪械）');
  const padLore = dodAbilityLore.getAbilityLore('BonusPad');
  assert.ok(/工程能力/.test(padLore.lore_description) && /建筑经验/.test(padLore.lore_description) && /创造辅助工具/.test(padLore.lore_description));
  ok('14. BonusPad = 工程能力/建筑经验/创造辅助工具（不是魔法平台）');
  assert.ok(allLore.every((l) => !MAGIC_WORDS.test(l.lore_description) && !MAGIC_WORDS.test(l.personality_connection)));
  ok('15. 全部 Lore 文本无魔法/法术/超能力/召唤描述');
  assert.ok(allLore.every((l) => !/玩家获得|获得技能|解锁技能/.test(l.lore_description)));
  ok('16. 不用「玩家获得技能」式解释（是人生经历，不是技能发放）');
  assert.ok(/不是魔法/.test(dodAbilityLore.ABILITY_EXPLANATION_RULE) && /人生经历/.test(dodAbilityLore.ABILITY_EXPLANATION_RULE));
  ok('17. 解释总规则：不是魔法，是过去的人生经历');

  // ══ C. Background 关联（权重提高，非锁定）══
  assert.strictEqual(dodAbilityLore.backgroundAbilityWeight('BonusPad', 'Engineer'), 3);
  ok('18. Engineer ↔ BonusPad 权重提高（3）');
  assert.ok(dodAbilityLore.backgroundAbilityWeight('Block', 'Engineer') === 3 && dodAbilityLore.backgroundAbilityWeight('Block', 'Security') === 3);
  ok('19. Engineer/Security ↔ Block 权重提高');
  assert.strictEqual(dodAbilityLore.backgroundAbilityWeight('Caretaker', 'Medic'), 3);
  ok('20. Medic ↔ Caretaker 权重提高');
  assert.ok(dodAbilityLore.backgroundAbilityWeight('Punch', 'Athlete') === 3 && dodAbilityLore.backgroundAbilityWeight('Dash', 'Athlete') === 3);
  ok('21. Athlete ↔ Punch/Dash 权重提高');
  assert.strictEqual(dodAbilityLore.backgroundAbilityWeight('Revolver', 'Security'), 3);
  ok('22. Security ↔ Revolver 权重提高');
  assert.ok(dodAbilityLore.backgroundAbilityWeight('Hotdog', 'Cook') === 3 && dodAbilityLore.backgroundAbilityWeight('Pie', 'Cook') === 3);
  ok('23. Cook ↔ Hotdog/Pie 权重提高');
  const grantable = dodCivilian.ABILITY_CATALOG.map((a) => a.key);
  for (const bg of dodCivilian.BACKGROUNDS) {
    for (const ab of grantable) {
      assert.ok(dodAbilityLore.backgroundAbilityWeight(ab, bg) >= 1, `${bg}×${ab} 权重必须 ≥1`);
    }
  }
  ok('24. 无职业锁定：任何背景 × 任何 Ability 权重 ≥ 1（都可能出现）');
  assert.deepStrictEqual(dodAbilityLore.linkedAbilities('Engineer').sort(), ['Block', 'BonusPad']);
  ok('25. linkedAbilities(Engineer) = BonusPad + Block（Lore 数据驱动）');
  // 预设 JSON 与服务层数据一致
  const cfg = JSON.parse(db.prepare("SELECT c.config_json FROM preset_dungeon_configs c JOIN preset_experiences p ON p.id = c.preset_id WHERE p.key = 'dod'").get().config_json);
  const weights = cfg.civilian.ability_lore.background_weights;
  for (const [bg, abilities] of Object.entries(weights)) {
    for (const ab of abilities) assert.strictEqual(dodAbilityLore.backgroundAbilityWeight(ab, bg), 3);
  }
  ok('26. 预设 ability_lore.background_weights 与服务层一致（Engineer/Medic/Athlete/Security/Cook）');
  // 权重影响抽取（同种子对比：关联背景 → BonusPad；无背景 → Hotdog）
  const withBg = dodLore.rollAbilitiesByTraits(['Cooking Skill'], 1, 0.613, 'Engineer');
  const noBg = dodLore.rollAbilitiesByTraits(['Cooking Skill'], 1, 0.613);
  assert.strictEqual(withBg[0].key, 'BonusPad');
  assert.strictEqual(noBg[0].key, 'Hotdog');
  ok('27. 背景权重实际提高关联 Ability 概率（同种子可对比）');
  // 非关联背景仍可获得（不是固定绑定）
  const cookGetsPad = dodLore.rollAbilitiesByTraits(['Cooking Skill'], 1, 0.763, 'Cook');
  assert.strictEqual(cookGetsPad[0].key, 'BonusPad');
  ok('28. Cook 居民也可能获得 BonusPad（仅概率差异，非绑定）');
  let engHits = 0;
  let cookHits = 0;
  for (let i = 0; i < 120; i += 1) {
    const tE = dodLore.rollPersonalityTraits('Engineer', i / 120);
    if (dodLore.rollAbilitiesByTraits(tE, 2, (i + 0.31) % 1, 'Engineer').some((a) => a.key === 'BonusPad')) engHits += 1;
    const tC = dodLore.rollPersonalityTraits('Cook', i / 120);
    if (dodLore.rollAbilitiesByTraits(tC, 2, (i + 0.31) % 1, 'Cook').some((a) => a.key === 'BonusPad')) cookHits += 1;
  }
  assert.ok(engHits > cookHits, `Engineer(${engHits}) 应高于 Cook(${cookHits})`);
  ok('29. 统计验证：Engineer 获得 BonusPad 频率显著高于 Cook（120 种子）');
  const artistExp = dodAbilityLore.abilityLoreExplanation('BonusPad', 'Artist');
  assert.ok(/没有固定绑定|任何背景/.test(artistExp));
  ok('30. 非关联背景解释明确「无固定绑定/任何背景都可能」');

  // ══ D. Trait 解释 ══
  assert.deepStrictEqual(dodAbilityLore.abilityExplainingTraits('Caretaker'), ['Medical Knowledge', 'Empathy', 'First Aid Experience']);
  ok('31. Caretaker Traits：Medical Knowledge / Empathy / First Aid Experience');
  const revTraits = dodAbilityLore.abilityExplainingTraits('Revolver');
  assert.ok(revTraits.includes('Weapon Familiarity') && revTraits.includes('Marksmanship'));
  ok('32. Revolver Traits：Weapon Familiarity / Marksmanship');
  assert.ok(allLore.every((l) => l.explaining_traits.includes(l.core_trait)));
  ok('33. 每条 Lore 的 core_trait ∈ explaining_traits');
  // 与阶段18 Trait→Ability 映射一致
  const pairs = [
    ['Medical Knowledge', 'Caretaker'],
    ['Physical Training', 'Punch'],
    ['Engineering Experience', 'BonusPad'],
    ['Weapon Familiarity', 'Revolver'],
    ['Cooking Skill', 'Hotdog'],
  ];
  for (const [trait, ability] of pairs) {
    assert.ok(dodLore.TRAIT_ABILITY_AFFINITY[trait].includes(ability));
    assert.ok(dodAbilityLore.abilityExplainingTraits(ability).includes(trait));
  }
  ok('34. Trait 解释与阶段18 Trait→Ability 亲和一致（双向对得上）');
  assert.strictEqual(dodAbilityLore.getAbilityLore('Punch').core_trait, 'Physical Training');
  ok('35. core_trait 与阶段17 Ability 目录一致（Punch ← Physical Training）');
  const npcTpl = dodLore.rollCivilianNpcTemplate(0.4);
  assert.ok(npcTpl.abilities.every((a) => grantable.includes(a)));
  ok('36. NPC 模板抽取仍 ⊆ 官方发放目录（Lore 扩展项不进入发放）');

  // ══ E. AI Context 生成（DOD_CIVILIAN_CONTEXT）══
  mkRoomDb('LORE9');
  const pEng = mkPlayerDb('工程居民', 'LORE9');
  mkCivilianDb(pEng.id, 'Engineer', ['Engineering Experience'], ['BonusPad', 'Caretaker']);
  const room = { id: 'LORE9', players: [{ name: '工程居民', socketId: pEng.socket_id }], currentExperience: null, currentDungeon: null };
  const ctx = contextBuilder.buildContext(room);
  const civSec = ctx.sections.find((s) => s.key === 'civilian');
  assert.ok(civSec.label.includes('DOD_CIVILIAN_CONTEXT'));
  ok('37. Context 分区 = DOD_CIVILIAN_CONTEXT');
  assert.ok(civSec.content.includes('Background: Engineer'));
  ok('38. 格式：Background:');
  assert.ok(civSec.content.includes('Traits: Engineering Experience'));
  ok('39. 格式：Traits:');
  assert.ok(/Abilities: .*BonusPad/.test(civSec.content));
  ok('40. 格式：Abilities:');
  assert.ok(civSec.content.includes('Lore Explanation: BonusPad —— 该居民过去拥有建筑经验，因此能够制作临时辅助设施。'));
  ok('41. 格式：Lore Explanation（背景→经历→能力的因果解释）');
  assert.ok(/Lore Explanation: Caretaker —— .*医疗知识/.test(civSec.content) && /任何背景/.test(civSec.content));
  ok('42. 非关联 Ability（Engineer 的 Caretaker）解释为个人经历 + 无绑定说明');
  const ctxDod = contextBuilder.buildContext({ ...room, currentDungeon: { name: 'Die of Death' } });
  assert.ok(/专业生存能力/.test(ctxDod.sections.find((s) => s.key === 'civilian').content));
  ok('43. DOD 世界内：保留跨世界解释（专业生存能力）');
  const ctxOther = contextBuilder.buildContext({ ...room, currentDungeon: { name: 'DOORS' } });
  const otherContent = ctxOther.sections.find((s) => s.key === 'civilian').content;
  assert.ok(!/专业生存能力/.test(otherContent) && /人生经历|经验/.test(otherContent));
  ok('44. 其他世界：解释为人生经验');
  const strippedCtx = civSec.content.replace(/不是魔法/g, ''); // 允许否定式纪律表述
  assert.ok(!MAGIC_WORDS.test(strippedCtx));
  ok('45. Context 不把 Ability 描述成魔法（仅纪律性否定表述）');
  assert.ok(/普通居民|幸存者/.test(civSec.content) && /禁止超级英雄/.test(civSec.content) && /不锁定 Ability/.test(civSec.content));
  ok('46. Context 携带 GM 纪律（普通居民 + 无职业锁定）');
  const pNoCiv = mkPlayerDb('无身份', 'LORE9');
  const ctxEmpty = contextBuilder.buildContext({ id: 'LORE9', players: [{ name: '无身份', socketId: pNoCiv.socket_id }], currentExperience: null, currentDungeon: null });
  assert.ok(ctxEmpty.sections.find((s) => s.key === 'civilian').content.includes('没有 Civilian 身份'));
  ok('47. 无身份玩家：占位说明（不虚构）');
  const viewEng = dodLore.loreView(pEng.id);
  assert.ok(viewEng.abilities.every((a) => a.loreExplanation && a.coreTrait && Array.isArray(a.explainingTraits)));
  ok('48. loreView 携带 Lore 字段（解释/核心Trait/解释Traits）');
  assert.strictEqual(viewEng.abilities.find((a) => a.key === 'BonusPad').backgroundLinked, true);
  assert.strictEqual(viewEng.abilities.find((a) => a.key === 'Caretaker').backgroundLinked, false);
  ok('49. backgroundLinked 标记（BonusPad 关联 Engineer；Caretaker 不关联）');
  assert.ok(/人生经历/.test(SYSTEM_RULES) && /Background 只提高出现概率/.test(SYSTEM_RULES));
  ok('50. SYSTEM_RULES：Ability=人生经历 + 无职业绑定纪律');

  // ══ F. Synergy 预留（只保存候选，不实现逻辑）══
  assert.deepStrictEqual(dodAbilityLore.synergyCandidates('BonusPad'), [{ with: 'Caretaker', result: 'CarePad' }]);
  ok('51. BonusPad possible_synergy：Caretaker → CarePad');
  assert.deepStrictEqual(dodAbilityLore.synergyCandidates('Revolver'), [{ with: 'Caretaker', result: 'Loveshot' }]);
  ok('52. Revolver possible_synergy：Caretaker → Loveshot');
  assert.deepStrictEqual(dodAbilityLore.getAbilityLore('BonusPad').possible_synergy, dodAbilityLore.synergyCandidates('BonusPad'));
  ok('53. possible_synergy 别名与 synergy_candidates 一致');
  assert.strictEqual(dodCivilian.SYNERGY_RULES.length, 1);
  ok('54. Synergy 逻辑未新增（阶段17 规则保持 1 条，Loveshot 不实现）');
  assert.ok(!db.prepare("SELECT 1 FROM skills WHERE name = 'Loveshot'").get());
  ok('55. Loveshot 未登记为可发放技能（仅 Lore 预留）');
  const pLoveshot = mkPlayerDb('枪械医护', 'LORE9');
  mkCivilianDb(pLoveshot.id, 'Security', ['Weapon Familiarity'], ['Revolver', 'Caretaker']);
  const characterService = require('../src/services/character/characterService');
  dodCivilian.ensureSeeded(); // 播种 DOD Ability 技能定义（阶段17 流程）
  const dodDungeon = db.prepare("SELECT d.* FROM dungeons d WHERE d.roblox_experience_name = 'Die of Death'").get();
  for (const key of ['Revolver', 'Caretaker']) {
    const skill = db.prepare("SELECT * FROM skills WHERE name = ? AND status = 'approved'").get(key);
    characterService.grantSkill(pLoveshot.id, skill.id, { sourceType: 'DIE_OF_DEATH', sourceId: 'lore_sim', obtainedFromDungeonId: dodDungeon.id });
  }
  assert.strictEqual(dodCivilian.checkSynergy(fakeIo, pLoveshot.id), null);
  ok('56. 拥有 Revolver + Caretaker 不触发任何 Synergy（Loveshot 仅是候选）');
  assert.deepStrictEqual(dodAbilityLore.getAbilityLore('CarePad').synergy_result_of, ['Caretaker', 'BonusPad']);
  ok('57. CarePad 登记来源组合（Lore 双向可查）');

  // ══ G. 边界：无游戏技能系统 / REST ══
  assert.ok(!NUMERIC_KEYS.test(JSON.stringify(allLore)));
  ok('58. Lore 记录无 Cooldown/Damage/HP/SP 等战斗数值字段');
  assert.ok(!loreCols.some((c) => /cooldown|damage|^hp$|^sp$|combat/i.test(c)));
  ok('59. dod_abilities_lore 表无战斗数值列');
  const feFiles = fs.readdirSync(path.join(__dirname, '../../frontend/src/components')).join('\n');
  assert.ok(!/AbilityLore|DodAbility|ability-ui/i.test(feFiles));
  ok('60. 前端无 Ability 技能 UI（Lore 仅服务 AI GM）');
  const loreSrc = fs.readFileSync(path.join(__dirname, '../src/services/presets/dodAbilityLore.js'), 'utf8');
  assert.ok(!/round_system|win_condition|killer_gameplay|competitive/i.test(loreSrc));
  ok('61. Lore 模块无玩法系统痕迹（复刻既有红线）');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const sess = createSession(mkPlayerDb('REST居民', 'LORE9').id);
  const url = (p) => `http://127.0.0.1:${port}${p}`;
  const res401 = await fetch(url('/api/dod/abilities/lore'));
  assert.strictEqual(res401.status, 401);
  const loreRes = await fetch(url(`/api/dod/abilities/lore?sessionToken=${encodeURIComponent(sess.token)}`)).then((r) => r.json());
  assert.ok(loreRes.abilities.length === 18 && /不是魔法/.test(loreRes.rule) && /无战斗数值/.test(loreRes.note));
  ok('62. GET /api/dod/abilities/lore（只读；401 保护；无数值说明）');

  // ══ H. Flashlight（官方 Library 集成：徒步/探索/向导，非游戏机制）══
  const fl = dodAbilityLore.getAbilityLore('Flashlight');
  assert.ok(fl && fl.source === 'DIE_OF_DEATH' && fl.category === 'exploration' && dodAbilityLore.getAbilityLore('flashlight').name === 'Flashlight');
  ok('63. Flashlight Lore 读取（source=DIE_OF_DEATH / category=exploration）');
  assert.deepStrictEqual(fl.explaining_traits, ['Outdoor Experience', 'Navigation']);
  ok('64. Flashlight Traits：Outdoor Experience / Navigation（hiking·exploration + sense of direction）');
  assert.ok(dodLore.TRAIT_POOL.includes('Outdoor Experience') && dodLore.TRAIT_POOL.includes('Navigation'));
  ok('65. Trait 池含官方增补项（Outdoor Experience / Navigation）');
  assert.deepStrictEqual(fl.possible_background, []);
  ok('66. Flashlight 无关联背景（官方 Library：wide variety of backgrounds）');
  for (const bg of dodCivilian.BACKGROUNDS) {
    assert.strictEqual(dodAbilityLore.backgroundAbilityWeight('Flashlight', bg), 1);
  }
  ok('67. 所有背景权重 = 1（彻底无职业锁定，任何居民都可能拥有）');
  assert.ok(/徒步|户外|向导/.test(fl.lore_description) && !/光锥|减速|slowness|stud|闪光|Dazed/i.test(fl.lore_description));
  ok('68. Flashlight 解释为徒步/户外/向导经历（不描述使用机制）');
  assert.ok(/不是战斗人员|导航者|组织者/.test(fl.personality_connection) && !MAGIC_WORDS.test(fl.personality_connection));
  ok('69. personality_connection：向导/组织者（官方 Library：not exactly fighters）');
  assert.ok(fl.library_excerpt && /tour guides/.test(fl.library_excerpt) && /navigators/.test(fl.library_excerpt) && /organizers/.test(fl.library_excerpt));
  assert.ok(!/\d+(\.\d+)?\s*(s\b|HP|stud|Points)|damage|slowness|cooldown/i.test(fl.library_excerpt));
  ok('70. library_excerpt 保存官方 Library 文本（CANON；无任何战斗数值/机制数值）');
  // 阶段25 更新（用户指令）：Flashlight 等所有 Ability 都算技能 → 经 Fate 池播种（dod_fate_ability 标记）
  assert.ok(!dodCivilian.ABILITY_CATALOG.some((a) => a.key === 'Flashlight'));
  assert.ok(db.prepare("SELECT 1 FROM skills WHERE name = 'Flashlight' AND json_extract(effect_data, '$.dod_fate_ability') = 1").get());
  ok('71. Flashlight 不入旧目录（ABILITY_CATALOG），但已作为 Fate 技能播种（阶段25：所有都算技能）');
  const pFl = mkPlayerDb('向导居民', 'LORE9');
  mkCivilianDb(pFl.id, 'Artist', ['Outdoor Experience', 'Navigation'], ['Flashlight']);
  const ctxFl = contextBuilder.buildContext({ id: 'LORE9', players: [{ name: '向导居民', socketId: pFl.socket_id }], currentExperience: null, currentDungeon: null });
  const flSec = ctxFl.sections.find((s) => s.key === 'civilian').content;
  assert.ok(/Background: Artist/.test(flSec) && /Abilities: .*Flashlight/.test(flSec) && /Lore Explanation: Flashlight —— .*徒步/.test(flSec) && /没有固定绑定/.test(flSec));
  assert.ok(!MAGIC_WORDS.test(flSec.replace(/不是魔法/g, '')));
  ok('72. AI Context 渲染 Flashlight（Lore Explanation=徒步经历 + 无绑定说明；非魔法）');

  // ══ I. 官方 Library 合集全量集成（13 项中文 Library + 官方 Synergy 表）══
  const baseLore = allLore.filter((l) => l.category !== 'synergy');
  assert.strictEqual(baseLore.length, 14);
  assert.ok(baseLore.every((l) => l.library_excerpt && l.library_excerpt.length > 20));
  ok('73. 全部 14 项基础 Ability 均保存官方 Library 文本（library_excerpt）');
  assert.ok(allLore.every((l) => !/\d/.test(l.library_excerpt || '')));
  ok('74. 全部 library_excerpt 无任何数字（只存 Traits 性格/背景段，机制数值不入库）');
  const resultOf = Object.fromEntries(allLore.filter((l) => l.category === 'synergy').map((l) => [l.name, l.synergy_result_of]));
  assert.deepStrictEqual(resultOf.CarePad, ['Caretaker', 'BonusPad']);
  assert.deepStrictEqual(resultOf.Loveshot, ['Revolver', 'Caretaker']);
  assert.deepStrictEqual(resultOf.SweetTooth, ['Hotdog', 'Pie']);
  assert.deepStrictEqual(resultOf.Noisemaker, ['Taunt', 'Bugle']);
  ok('75. 官方 Synergy 表四条全登记（CarePad/Loveshot/SweetTooth/Noisemaker 来源组合）');
  assert.deepStrictEqual(dodAbilityLore.synergyCandidates('Caretaker'), [
    { with: 'BonusPad', result: 'CarePad' },
    { with: 'Revolver', result: 'Loveshot' },
  ]);
  assert.deepStrictEqual(dodAbilityLore.synergyCandidates('Hotdog'), [{ with: 'Pie', result: 'SweetTooth' }]);
  assert.deepStrictEqual(dodAbilityLore.synergyCandidates('Pie'), [{ with: 'Hotdog', result: 'SweetTooth' }]);
  assert.deepStrictEqual(dodAbilityLore.synergyCandidates('Taunt'), [{ with: 'Bugle', result: 'Noisemaker' }]);
  assert.deepStrictEqual(dodAbilityLore.synergyCandidates('Bugle'), [{ with: 'Taunt', result: 'Noisemaker' }]);
  ok('76. Synergy 候选双向登记（Caretaker/Hotdog/Pie/Taunt/Bugle）');
  assert.deepStrictEqual(dodAbilityLore.synergyCandidates('Banana Peel'), [{ with: 'Artful', result: 'Showtime' }]);
  assert.ok(!allLore.some((l) => l.name === 'Showtime' || l.name === 'Artful'));
  assert.ok(!db.prepare("SELECT 1 FROM skills WHERE name IN ('Showtime','Artful','SweetTooth','Noisemaker')").get());
  ok('77. Banana Peel ↔ Artful → Showtime 仅候选（无条目/不入技能库/Artful 未入目录）');
  assert.ok(dodAbilityLore.backgroundAbilityWeight('Bugle', 'Artist') === 3 && dodAbilityLore.backgroundAbilityWeight('Banana Peel', 'Artist') === 3);
  assert.deepStrictEqual(dodAbilityLore.linkedAbilities('Artist').sort(), ['Banana Peel', 'Bugle']);
  ok('78. Artist ↔ Banana Peel/Bugle 权重提高（官方 Library：都有表演或戏剧的背景）');
  assert.ok(dodAbilityLore.backgroundAbilityWeight('Bugle', 'Engineer') === 1 && dodAbilityLore.backgroundAbilityWeight('Punch', 'Artist') === 1);
  for (const bg of dodCivilian.BACKGROUNDS) {
    for (const ab of ['Adrenaline', 'Cloak', 'Taunt', 'Flashlight']) {
      assert.strictEqual(dodAbilityLore.backgroundAbilityWeight(ab, bg), 1);
    }
  }
  ok('79. 无职业锁定：Artist 其他 Ability 仍 1；Adrenaline/Cloak/Taunt/Flashlight 全背景 1（官方：普通背景/政府科技/无背景信息）');
  const adLore = dodAbilityLore.getAbilityLore('Adrenaline');
  assert.ok(/受惊/.test(adLore.lore_description) && /只是普通平民，做着普通的工作/.test(adLore.library_excerpt) && !MAGIC_WORDS.test(adLore.lore_description));
  ok('80. Adrenaline = 受惊即逃的生存反应（官方 Library：普通背景普通工作，非魔法）');
  const cloakLore = dodAbilityLore.getAbilityLore('Cloak');
  assert.ok(/实验性政府科技/.test(cloakLore.lore_description) && /观察野生动物/.test(cloakLore.lore_description) && !MAGIC_WORDS.test(cloakLore.lore_description));
  ok('81. Cloak = 实验性政府科技 + 野生动物研究（科技来源解释，非魔法）');
  const loreOnly = ['Adrenaline', 'Banana Peel', 'Cloak', 'Taunt', 'Bugle'];
  assert.ok(!loreOnly.some((n) => dodCivilian.ABILITY_CATALOG.some((a) => a.key === n)));
  // 阶段25 更新（用户指令）：所有 Ability 都算技能 → 五项均经 Fate 池播种（dod_fate_ability 标记）
  assert.ok(loreOnly.every((n) => db.prepare("SELECT 1 FROM skills WHERE name = ? AND json_extract(effect_data, '$.dod_fate_ability') = 1").get(n)));
  ok('82. 新增五项均不入 ABILITY_CATALOG，但都已作为 Fate 技能播种（阶段25：所有都算技能）');
  assert.strictEqual(dodLore.TRAIT_POOL.length, 9);
  assert.ok(['Adrenaline', 'Banana Peel', 'Cloak', 'Taunt', 'Bugle'].every((n) => dodLore.TRAIT_POOL.includes(dodAbilityLore.getAbilityLore(n).core_trait)));
  ok('83. Trait 池仍 9 项（未新增）；新增 Ability 的 core_trait 全部来自官方池');
  assert.ok(/Dash/.test(adLore.personality_connection) && /Block/.test(adLore.personality_connection));
  assert.ok(/Punch/.test(dodAbilityLore.getAbilityLore('Block').personality_connection) && /Caretaker/.test(dodAbilityLore.getAbilityLore('Block').personality_connection));
  assert.ok(/Hotdog/.test(dodAbilityLore.getAbilityLore('Pie').personality_connection) && /Bugle/.test(dodAbilityLore.getAbilityLore('Pie').personality_connection));
  ok('84. 居民间官方关系入 personality_connection（Adrenaline↔Dash/Block；Block↔Punch/Caretaker；Pie↔Hotdog/Bugle）');
  assert.ok(allLore.every((l) => !/\d/.test(l.lore_description) && !/\d/.test(l.personality_connection)));
  assert.ok(allLore.every((l) => !/冷却|伤害|得分|Points|\bHP\b|\bSP\b/i.test(l.lore_description)));
  ok('85. 全库 lore_description/personality_connection 无数字与机制词（无冷却/HP/SP/伤害/得分）');
  const pBugle = mkPlayerDb('号手居民', 'LORE9');
  mkCivilianDb(pBugle.id, 'Artist', ['Special Habit'], ['Bugle']);
  const ctxBugle = contextBuilder.buildContext({ id: 'LORE9', players: [{ name: '号手居民', socketId: pBugle.socket_id }], currentExperience: null, currentDungeon: null });
  const bugleSec = ctxBugle.sections.find((s) => s.key === 'civilian').content;
  assert.ok(/Background: Artist/.test(bugleSec) && /Lore Explanation: Bugle —— 该居民过去拥有艺术创作与观察生活的经历，因此能用号角声提振身边人的士气。/.test(bugleSec));
  ok('86. AI Context 渲染 Bugle（Artist 关联 → 背景因果解释句式）');
  assert.strictEqual(dodLore.interpretAbility('Bugle', 'DOORS'), '吹奏与鼓舞士气经验');
  assert.strictEqual(dodLore.interpretAbility('Cloak', 'Die of Death'), '专业生存能力');
  assert.strictEqual(dodLore.interpretAbility('SweetTooth', 'DOORS'), '烹饪与食欲的组合（预留）');
  ok('87. 跨世界解释覆盖全部新增 Ability（DOD=生存能力；普通世界=人生经验）');
  const presetSyn = cfg.civilian.ability_lore.possible_synergy;
  for (const [ability, cands] of Object.entries(presetSyn)) {
    assert.deepStrictEqual(dodAbilityLore.synergyCandidates(ability), cands, `预设与服务层 Synergy 候选不一致：${ability}`);
  }
  assert.ok(['CarePad', 'Loveshot', 'SweetTooth', 'Noisemaker', 'Showtime'].every((r) => JSON.stringify(presetSyn).includes(r)));
  assert.deepStrictEqual(cfg.civilian.ability_lore.background_weights.Artist.sort(), ['Banana Peel', 'Bugle'].sort());
  ok('88. 预设 possible_synergy（8 键）与 background_weights.Artist 和服务层完全一致');

  server.close();
  console.log(`\n[阶段19] 通过 ${passed} 项测试`);
  if (passed < 84) {
    console.error('测试数量不足！');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('\n[阶段19] 测试失败：', err);
  process.exit(1);
});
