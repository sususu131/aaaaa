/**
 * 阶段18 测试：Die of Death Lore Simulation Preset（66 项）。
 * 覆盖：预设加载（LORE_SIMULATION）/ Civilian 身份模型（life_experience/personality_traits）/
 *       Background 生成与倾向 / Trait→Ability 权重 / Ability 跨世界解释 / 跨世界保存 /
 *       GM Context 读取与纪律 / NPC Civilian 规则 / 无游戏玩法边界。
 * 红线：不实现 Round 系统 / Deck 抽卡 UI / 胜负条件 / Killers 玩法 / 竞技模式；不创造原创 Lore。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

for (const suffix of ['', '-wal', '-shm', '-journal']) {
  fs.rmSync(path.join(__dirname, '../../database/data/roblox_trpg.db' + suffix), { force: true });
}

process.env.AI_API_KEY = 'ai-key-s18';
process.env.AI_BASE_URL = 'http://127.0.0.1:4118/v1';
process.env.AI_MODEL = 'mock-s18';
process.env.AI_STREAM = 'off';

require('../src/index.js');
const dbMod = require('@roblox-trpg/database');
const db = dbMod.getDb();
const presetSeeder = require('../src/services/presets/presetSeeder');
const dodCivilian = require('../src/services/presets/dodCivilian');
const dodLore = require('../src/services/presets/dodLore');
const contextBuilder = require('../src/services/ai/contextBuilder');
const { SYSTEM_RULES } = require('../src/services/ai/promptRules');

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
  const uid = `player_s18_${pSeq}`;
  db.prepare('INSERT INTO players (uid, socket_id, name, room_id) VALUES (?, ?, ?, ?)').run(uid, `sock_${uid}`, name, roomId);
  return db.prepare('SELECT * FROM players WHERE uid = ?').get(uid);
}
function dodCfg() {
  return JSON.parse(db.prepare("SELECT c.config_json FROM preset_dungeon_configs c JOIN preset_experiences p ON p.id = c.preset_id WHERE p.key = 'dod'").get().config_json);
}

async function main() {
  console.log('[test] 阶段18 就绪（66 项）\n');

  presetSeeder.runPresetSeeder(fakeIo);

  // ══ A. DOD Lore Simulation 预设加载 ══
  const cfg = dodCfg();
  assert.strictEqual(cfg.mode, 'LORE_SIMULATION');
  ok('1. DOD 预设模式 = LORE_SIMULATION');
  assert.ok(cfg.world_setting.world === 'Robloxia' && cfg.world_setting.era === 'Killers出现后的异常时期');
  ok('2. World Setting：Robloxia / Killers出现后的异常时期');
  assert.ok(/普通Civilian|不是英雄/.test(cfg.world_setting.player_role));
  ok('3. 玩家进入 = 普通 Civilian（不是英雄）');
  assert.ok(/不是游戏玩法复刻/.test(cfg.mode_note) && !/缺失/.test(cfg.mode_note));
  ok('4. 模式说明：不是玩法复刻');
  const hooks = Object.keys(cfg.future_hooks);
  assert.ok(['Government', 'Bunker', 'Killer', 'WorldEvents', 'LoreLocations'].every((h) => hooks.includes(h)));
  ok('5. 未来扩展接口预留（Government/Bunker/Killer/WorldEvents/LoreLocations）');
  assert.ok(Object.values(cfg.future_hooks).every((v) => v === 'reserved'));
  ok('6. 预留接口全部为 reserved（当前不实现）');
  assert.ok(cfg.civilian && cfg.civilian.backgrounds.length === 6 && cfg.civilian.traits.length === 9);
  ok('7. 预设携带 Civilian 配置（官方背景/特点池；阶段19 增补 Outdoor Experience/Navigation）');
  presetSeeder.runPresetSeeder(fakeIo);
  assert.strictEqual(dodCfg().mode, 'LORE_SIMULATION');
  ok('8. 重复导入：Lore 配置保持（幂等）');
  const doorsCfg = JSON.parse(db.prepare("SELECT c.config_json FROM preset_dungeon_configs c JOIN preset_experiences p ON p.id = c.preset_id WHERE p.key = 'doors'").get().config_json);
  assert.ok(doorsCfg.mode === undefined);
  ok('9. 其他预设不受影响（DOORS 无 LORE_SIMULATION 模式）');
  assert.ok(cfg.civilian.npc_rule.includes('Civilian'));
  ok('10. 预设携带 NPC Civilian 规则');

  // ══ B. Civilian Identity 模型扩展 ══
  const cols = db.prepare('PRAGMA table_info(civilian_instance)').all().map((c) => c.name);
  assert.ok(cols.includes('life_experience') && cols.includes('personality_traits'));
  ok('11. 身份模型扩展列（life_experience / personality_traits）');
  mkRoomDb('LORE1');
  const p1 = mkPlayerDb('居民甲', 'LORE1');
  const gen1 = dodLore.generateCivilianLore(fakeIo, p1.id, { rng: 0.3 });
  assert.ok(gen1.created && gen1.civilian.life_experience);
  ok('12. Lore 生成身份（无 Deck 抽卡）');
  assert.ok(gen1.civilian.life_experience.includes(gen1.civilian.background));
  ok('13. life_experience 含背景（人生经历解释能力来源）');
  assert.ok(/Killers出现后的异常时期|Robloxia/.test(gen1.civilian.life_experience));
  ok('14. life_experience 含官方世界设定（时代/世界）');
  const pTraits = JSON.parse(gen1.civilian.personality_traits);
  assert.ok(Array.isArray(pTraits) && pTraits.length === 2 && pTraits.every((t) => dodLore.TRAIT_POOL.includes(t)));
  ok('15. personality_traits ⊆ 官方 Trait 池');
  const dupGen = dodLore.generateCivilianLore(fakeIo, p1.id, { rng: 0.9 });
  assert.ok(dupGen.created === false && dupGen.reason === 'ALREADY_HAS_IDENTITY');
  ok('16. 重复生成幂等');
  const view1 = dodLore.loreView(p1.id);
  assert.ok(view1 && view1.lifeExperience && view1.personalityTraits.length === 2);
  ok('17. Lore 视图（经历/特点/能力）');
  // 阶段17 身份向后兼容
  const p17 = mkPlayerDb('旧身份', 'LORE1');
  dodCivilian.offerDecks(p17.id, { rng: 0.5 });
  const legacy = dodCivilian.createCivilianIdentity(fakeIo, p17.id, { deckIndex: 1, rng: 0.5 });
  const legacyView = dodLore.loreView(p17.id);
  assert.ok(legacy.created && legacyView && Array.isArray(legacyView.abilities));
  ok('18. 阶段17 身份向后兼容（Deck 路径仍可用）');

  // ══ C. Background 生成与倾向 ══
  const bgs = new Set();
  for (let i = 0; i < 60; i += 1) {
    bgs.add(dodLore.rollPersonalityTraits(dodCivilian.BACKGROUNDS[i % 6], 0.5)[0]);
  }
  assert.ok(bgs.size >= 5);
  ok('19. Background 倾向产生多样主特点');
  assert.strictEqual(dodLore.rollPersonalityTraits('Medic', 0.5)[0], 'Medical Knowledge');
  ok('20. Medic → Medical Knowledge（治疗相关）');
  assert.strictEqual(dodLore.rollPersonalityTraits('Engineer', 0.5)[0], 'Engineering Experience');
  ok('21. Engineer → Engineering Experience（建设相关）');
  assert.strictEqual(dodLore.rollPersonalityTraits('Athlete', 0.5)[0], 'Physical Training');
  ok('22. Athlete → Physical Training（移动/身体）');
  assert.strictEqual(dodLore.rollPersonalityTraits('Cook', 0.5)[0], 'Cooking Skill');
  ok('23. Cook → Cooking Skill（食物相关）');
  assert.strictEqual(dodLore.rollPersonalityTraits('Security', 0.5)[0], 'Weapon Familiarity');
  ok('24. Security → Weapon Familiarity（防御相关）');
  const artistTraits = dodLore.rollPersonalityTraits('Artist', 0.5);
  assert.ok(artistTraits.length === 2 && artistTraits.every((t) => dodLore.TRAIT_POOL.includes(t)));
  ok('25. Artist 无固定倾向（随机官方特点）');
  assert.throws(() => dodLore.generateCivilianLore(fakeIo, mkPlayerDb('非法', 'LORE1').id, { background: 'Superhero' }), /背景必须是/);
  ok('26. 非法背景拒绝（不创造原创身份）');

  // ══ D. Trait 与 Ability 权重 ══
  assert.ok(dodLore.TRAIT_POOL.length === 9);
  ok('27. Trait 池（官方 9 项：阶段18 的 7 项 + 阶段19 Flashlight Library 增补 2 项）');
  assert.ok(dodLore.abilityWeight('Caretaker', ['Medical Knowledge']) === 3 && dodLore.abilityWeight('Caretaker', []) === 1);
  ok('28. Trait 提升 Ability 权重（1 + 2×匹配）');
  assert.ok(dodLore.abilityWeight('Revolver', ['Weapon Familiarity']) === 3);
  ok('29. Weapon Familiarity → Revolver 权重');
  assert.ok(dodLore.abilityWeight('Hotdog', ['Cooking Skill']) === 3 && dodLore.abilityWeight('Hotdog', ['Special Habit']) === 3);
  ok('30. Cooking Skill / Special Habit → Hotdog');
  assert.ok(dodLore.abilityWeight('BonusPad', ['Engineering Experience', 'Support Facility']) === 5);
  ok('31. 多 Trait 叠加权重（工程+支援设施）');
  const medicalRolls = dodLore.rollAbilitiesByTraits(['Medical Knowledge'], 1, 0.05);
  assert.strictEqual(medicalRolls[0].key, 'Caretaker');
  ok('32. 权重抽取：医疗特点 → 高概率 Caretaker（低种子确定）');
  const catalogKeys = dodCivilian.ABILITY_CATALOG.map((a) => a.key);
  for (let i = 0; i < 20; i += 1) {
    const picks = dodLore.rollAbilitiesByTraits(dodLore.rollPersonalityTraits('Security', i / 20), 2, i / 20);
    assert.ok(picks.every((p) => catalogKeys.includes(p.key)) && new Set(picks.map((p) => p.key)).size === picks.length);
  }
  ok('33. 抽取结果始终 ⊆ 官方目录且不重复（20 组种子）');

  // ══ E. Ability 跨世界解释 ══
  assert.strictEqual(dodLore.interpretAbility('Caretaker', 'Die of Death'), '专业生存能力');
  ok('34. Caretaker 在 DOD = 专业生存能力');
  assert.strictEqual(dodLore.interpretAbility('Caretaker', 'DOORS'), '医疗经验');
  ok('35. Caretaker 在普通世界 = 医疗经验（官方示例）');
  for (const key of ['Punch', 'Caretaker', 'Revolver', 'Hotdog', 'BonusPad', 'CarePad']) {
    assert.ok(dodLore.ABILITY_INTERPRETATIONS[key].dod && dodLore.ABILITY_INTERPRETATIONS[key].default);
  }
  ok('36. 全部 Ability 有双世界解释');
  const viewDod = dodLore.loreView(p1.id, 'Die of Death');
  assert.ok(viewDod.abilities.every((a) => a.interpretation === '专业生存能力' || a.interpretation === '大师级能力组合'));
  ok('37. DOD 世界视图：能力=生存能力');
  const viewOther = dodLore.loreView(p1.id, 'DOORS');
  assert.ok(viewOther.abilities.every((a) => a.interpretation !== '专业生存能力'));
  ok('38. 其他世界视图：能力=人生经验');
  const punchMeta = JSON.parse(db.prepare("SELECT effect_data FROM skills WHERE name = 'Punch'").get().effect_data);
  assert.ok(punchMeta.dod_ability === true);
  ok('39. Ability 非魔法/超能力（仍是 DOD 生存技能定义）');

  // ══ F. 跨世界保存 ══
  const p1Skills = db.prepare("SELECT s.name, ps.source_type FROM player_skills ps JOIN skills s ON s.id = ps.skill_id WHERE ps.player_id = ?").all(p1.id);
  assert.ok(p1Skills.length >= 2 && p1Skills.every((r) => r.source_type === 'DIE_OF_DEATH'));
  ok('40. Ability 属于个人经历：character_skills source=DIE_OF_DEATH');
  const beforeCount = p1Skills.length;
  dodLore.loreView(p1.id, 'DOORS'); // 切换世界解释不改变保存
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM player_skills WHERE player_id = ?').get(p1.id).c, beforeCount);
  ok('41. 离开 DOD：能力不删除');
  assert.strictEqual(dodCivilian.dodAbilityMultiplier('DOORS'), 0.5);
  ok('42. 其他世界：Balance 削弱保留（阶段17 规则）');
  assert.ok(dodCivilian.getCivilian(p1.id).source === 'DIE_OF_DEATH');
  ok('43. 身份来源标记保留');
  const p2 = mkPlayerDb('居民乙', 'LORE1');
  const gen2 = dodLore.generateCivilianLore(fakeIo, p2.id, { rng: 0.3, background: gen1.civilian.background });
  assert.ok(gen2.created && gen2.civilian.background === gen1.civilian.background);
  ok('44. 两名居民可同为一种背景（Civilian 代表一类居民）');

  // ══ G. GM Context 与 NPC 规则 ══
  const room = { id: 'LORE1', players: [{ name: '居民甲', socketId: p1.socket_id }], currentExperience: null, currentDungeon: null };
  const ctx = contextBuilder.buildContext(room);
  const civSec = ctx.sections.find((s) => s.key === 'civilian');
  assert.ok(civSec && civSec.label.includes('CIVILIAN_CONTEXT'));
  ok('45. Context 含 CIVILIAN_CONTEXT 分区');
  assert.ok(civSec.content.includes(gen1.civilian.background) && civSec.content.includes('居民甲'));
  ok('46. Context 读取身份（背景/玩家）');
  assert.ok(/Robloxia|Killers出现后的异常时期/.test(civSec.content));
  ok('47. Context 含世界设定（时代）');
  const roomDod = { ...room, currentDungeon: { name: 'Die of Death' } };
  const ctxDod = contextBuilder.buildContext(roomDod);
  const civDodSec = ctxDod.sections.find((s) => s.key === 'civilian');
  assert.ok(/专业生存能力/.test(civDodSec.content));
  ok('48. DOD 世界内：Context 显示生存能力解释');
  const ctxOther = contextBuilder.buildContext({ ...room, currentDungeon: { name: 'DOORS' } });
  assert.ok(!/专业生存能力/.test(ctxOther.sections.find((s) => s.key === 'civilian').content));
  ok('49. 其他世界：Context 显示人生经验解释');
  assert.ok(/普通居民|幸存者/.test(civSec.content) && /禁止超级英雄/.test(civSec.content));
  ok('50. Context 携带 GM 描述纪律');
  const npcTpl = dodLore.rollCivilianNpcTemplate(0.4);
  assert.ok(dodCivilian.BACKGROUNDS.includes(npcTpl.background) && npcTpl.traits.every((t) => dodLore.TRAIT_POOL.includes(t)) && npcTpl.abilities.every((a) => catalogKeys.includes(a)));
  ok('51. NPC 生成使用 Civilian 规则（官方池模板）');
  assert.ok(/无固定身份|不是英雄/.test(npcTpl.note));
  ok('52. NPC 模板无固定英雄身份');
  assert.ok(/NPC 同样使用 Civilian 规则|不创建固定英雄/.test(SYSTEM_RULES));
  ok('53. SYSTEM_RULES：NPC Civilian 规则');
  assert.ok(/救世主/.test(SYSTEM_RULES) && /传奇战士/.test(SYSTEM_RULES));
  ok('54. SYSTEM_RULES：禁止超级英雄/救世主/传奇战士');

  // ══ H. 边界：不实现游戏玩法 ══
  const srcAll = fs.readdirSync(path.join(__dirname, '../src/services/presets')).map((f) => fs.readFileSync(path.join(__dirname, '../src/services/presets', f), 'utf8')).join('\n');
  assert.ok(!/round_system|roundSystem/i.test(srcAll));
  ok('55. 无 Round 系统');
  assert.ok(!/win_condition|winCondition|victory_condition/i.test(srcAll));
  ok('56. 无胜负条件');
  assert.ok(!/killer_gameplay|killerGameplay|competitive/i.test(srcAll));
  ok('57. 无 Killers 玩法/竞技模式');
  const routesSrc = fs.readFileSync(path.join(__dirname, '../src/routes/presetRoutes.js'), 'utf8');
  assert.ok(!/\/api\/dod\/round|\/api\/dod\/gacha|deck-ui/i.test(routesSrc));
  ok('58. 无回合/抽卡 UI 端点');
  const feFiles = fs.readdirSync(path.join(__dirname, '../../frontend/src/components')).map((f) => fs.readFileSync(path.join(__dirname, '../../frontend/src/components', f), 'utf8')).join('\n');
  assert.ok(!/DodDeck|deck-gacha|抽卡/i.test(feFiles));
  ok('59. 前端无 Deck 抽卡 UI');
  const future = dodLore.FUTURE_HOOKS;
  assert.ok(Object.keys(future).length === 5 && Object.values(future).every((v) => v === 'reserved'));
  ok('60. 未来接口在服务层同样为 reserved');
  assert.ok(!fs.existsSync(path.join(__dirname, '../src/services/presets/dodKiller.js')));
  ok('61. 未实现 Killer 模块');
  assert.ok(!fs.existsSync(path.join(__dirname, '../src/services/presets/dodDungeon.js')));
  ok('62. 未实现 DOD 专属 Dungeon 模块');
  const events = db.prepare("SELECT COUNT(*) c FROM game_events WHERE type = 'CIVILIAN_CREATED' AND data LIKE '%lore_simulation%'").get().c;
  assert.ok(events >= 2);
  ok('63. Lore 生成走 Event Bus（可审计）');
  const synergyLore = db.prepare("SELECT data FROM game_events WHERE type = 'CIVILIAN_CREATED' AND data LIKE '%lore_simulation%' LIMIT 1").get();
  assert.ok(JSON.parse(synergyLore.data).source === 'DIE_OF_DEATH');
  ok('64. 事件携带 DIE_OF_DEATH 来源');
  const noHero = db.prepare("SELECT COUNT(*) c FROM civilian_instance WHERE background IN ('Superhero','Savior','Legendary Warrior')").get().c;
  assert.strictEqual(noHero, 0);
  ok('65. 数据库中无英雄身份（Civilian 无固定身份）');
  assert.ok(cfg.civilian.definition.includes('没有固定身份'));
  ok('66. 预设定义：Civilian 没有固定身份（不是角色模板/英雄/特殊人物）');

  console.log(`\n[阶段18] 通过 ${passed} 项测试`);
  if (passed < 60) {
    console.error('测试数量不足！');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('\n[阶段18] 测试失败：', err);
  process.exit(1);
});
