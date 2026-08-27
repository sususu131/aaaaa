/**
 * 阶段23 测试：Civilian Ability Relationship System（Synergy Lore System）（62 项）。
 * 覆盖：ability_synergies 表与官方目录 / Ability 组合检测 / 生成流（Background→Traits→
 *       Abilities→检查Synergy）/ Lore 解释 / 不会生成不存在组合 / AI Context 读取 /
 *       描述规则（禁止"你升级成"）/ 限制（不创造新 Synergy、不是技能树、不发技能）。
 * 红线：不是游戏技能组合系统、不是装备系统、不是升级系统。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

for (const suffix of ['', '-wal', '-shm', '-journal']) {
  fs.rmSync(path.join(__dirname, '../../database/data/roblox_trpg.db' + suffix), { force: true });
}

process.env.AI_API_KEY = 'ai-key-s23';
process.env.AI_BASE_URL = 'http://127.0.0.1:4123/v1';
process.env.AI_MODEL = 'mock-s23';
process.env.AI_STREAM = 'off';

const { server } = require('../src/index.js');
const dbMod = require('@roblox-trpg/database');
const db = dbMod.getDb();
const presetSeeder = require('../src/services/presets/presetSeeder');
const dodLore = require('../src/services/presets/dodLore');
const dodSynergy = require('../src/services/presets/dodSynergy');
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
  const uid = `player_s23_${pSeq}`;
  db.prepare('INSERT INTO players (uid, socket_id, name, room_id) VALUES (?, ?, ?, ?)').run(uid, `sock_${uid}`, name, roomId);
  return db.prepare('SELECT * FROM players WHERE uid = ?').get(uid);
}

async function main() {
  console.log('[test] 阶段23 就绪（62 项）\n');

  presetSeeder.runPresetSeeder(fakeIo);

  // ══ A. 数据库与官方目录 ══
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ability_synergies'").get());
  ok('1. ability_synergies 表存在');
  const cols = db.prepare('PRAGMA table_info(ability_synergies)').all().map((c) => c.name);
  ['id', 'name', 'source_abilities_json', 'changed_ability', 'lore_explanation', 'trait_requirements_json']
    .every((f) => cols.includes(f) || assert.fail(`缺字段 ${f}`));
  ok('2. 规格字段齐全（id/name/source_abilities/changed_ability/lore_explanation/trait_requirements）');
  assert.ok(!cols.some((c) => /damage|cooldown|level|rarity|unlock|value/i.test(c)));
  ok('3. 无数值/等级/解锁字段（不是技能树）');
  assert.ok(db.prepare('PRAGMA table_info(civilian_instance)').all().map((c) => c.name).includes('synergies'));
  ok('4. civilian_instance.synergies（每玩家 Lore 状态）');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM ability_synergies').get().c, 2);
  ok('5. 官方目录恰有 2 条（CarePad/Loveshot）');
  const carePad = dodSynergy.getSynergy('carepad');
  const loveshot = dodSynergy.getSynergy('Loveshot');
  assert.ok(carePad && loveshot);
  ok('6. 按 id 或 name 读取');
  assert.deepStrictEqual(carePad.sourceAbilities, ['BonusPad', 'Caretaker']);
  assert.strictEqual(carePad.changedAbility, 'BonusPad');
  ok('7. CarePad：BonusPad + Caretaker → 改变 BonusPad');
  assert.deepStrictEqual(loveshot.sourceAbilities, ['Revolver', 'Caretaker']);
  assert.strictEqual(loveshot.changedAbility, 'Revolver');
  ok('8. Loveshot：Revolver + Caretaker → 改变 Revolver');
  assert.ok(/工程经验/.test(carePad.loreExplanation) && /医疗经验/.test(carePad.loreExplanation) && /帮助幸存者恢复/.test(carePad.loreExplanation));
  ok('9. CarePad Lore 解释（工程+医疗→设施改造成恢复工具）');
  assert.ok(/枪械经验/.test(loveshot.loreExplanation) && /医疗经验/.test(loveshot.loreExplanation) && /保护和救援/.test(loveshot.loreExplanation));
  ok('10. Loveshot Lore 解释（枪械+医疗→攻击结合保护救援）');
  assert.deepStrictEqual(carePad.traitRequirements, ['Medical Knowledge', 'Engineering Experience']);
  assert.deepStrictEqual(loveshot.traitRequirements, ['Medical Knowledge', 'Firearms Training']);
  ok('11. trait_requirements 与官方 Trait 池一致');
  assert.strictEqual(carePad.loreSource, 'CANON');
  ok('12. lore_source = CANON（全部官方输入）');

  // ══ B. 组合检测 ══
  const d1 = dodSynergy.detectSynergies(['Caretaker', 'BonusPad']);
  assert.deepStrictEqual(d1.map((s) => s.name), ['CarePad']);
  ok('13. 检测：Caretaker+BonusPad → CarePad');
  const d2 = dodSynergy.detectSynergies(['Revolver', 'Caretaker']);
  assert.deepStrictEqual(d2.map((s) => s.name), ['Loveshot']);
  ok('14. 检测：Revolver+Caretaker → Loveshot');
  const d3 = dodSynergy.detectSynergies(['Caretaker', 'BonusPad', 'Revolver', 'Punch']);
  assert.deepStrictEqual(d3.map((s) => s.name), ['CarePad', 'Loveshot']);
  ok('15. 多余 Ability 不影响检测（可同时命中两条）');
  assert.deepStrictEqual(dodSynergy.detectSynergies(['Caretaker']), []);
  ok('16. 部分组合（只有 Caretaker）→ 无 Synergy');
  assert.deepStrictEqual(dodSynergy.detectSynergies([]), []);
  ok('17. 空 Ability 集 → 无 Synergy');

  // ══ C. 不会生成不存在组合 ══
  assert.deepStrictEqual(dodSynergy.detectSynergies(['Revolver', 'BonusPad']), []);
  ok('18. Revolver+BonusPad（无医疗）→ 不生成');
  assert.deepStrictEqual(dodSynergy.detectSynergies(['Punch', 'Hotdog']), []);
  ok('19. Punch+Hotdog → 不生成');
  assert.deepStrictEqual(
    dodSynergy.detectSynergies(['Medkit', 'Revolver', 'Caretaker']).map((s) => s.name),
    ['Loveshot']
  );
  ok('20. 未知 Ability 名不参与组合（只按已知能力匹配）');
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM ability_synergies WHERE name NOT IN ('CarePad','Loveshot')").get().c, 0);
  ok('21. 目录外不存在其他 Synergy（不发明新组合）');
  // 剥除注释（docstring 里的"不发技能"声明不是实现），只扫描代码语义
  const rawSrc = fs.readFileSync(path.join(__dirname, '../src/services/presets/dodSynergy.js'), 'utf8');
  const src = rawSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/grantSkill|player_skills|INSERT INTO skills/i.test(src));
  ok('22. Synergy 模块不发放技能（不写 skills/player_skills）');
  assert.ok(!/cooldown|damage|解锁|upgrade_level/i.test(src));
  ok('23. 模块无升级/冷却/伤害语义');

  // ══ D. 生成流（Background → Traits → Abilities → 检查 Synergy）══
  mkRoomDb('S23');
  const pA = mkPlayerDb('工程医疗居民', 'S23');
  const gen = dodLore.generateCivilianLore(fakeIo, pA.id, { rng: 0.25, background: 'Engineer' });
  assert.ok(gen.created);
  // 服务器侧强制一条官方示例组合（Emergency Engineer 场景：Medical Knowledge + Engineering）
  db.prepare("UPDATE civilian_instance SET traits = ?, abilities = ? WHERE player_id = ?").run(
    JSON.stringify(['Medical Knowledge', 'Engineering Experience']),
    JSON.stringify(['Caretaker', 'BonusPad']),
    pA.id
  );
  const detected = dodSynergy.checkAndSaveSynergies(pA.id);
  assert.deepStrictEqual(detected.map((s) => s.name), ['CarePad']);
  ok('24. 生成流第4步：Abilities 之后检查 Synergy → CarePad');
  assert.deepStrictEqual(JSON.parse(db.prepare('SELECT synergies FROM civilian_instance WHERE player_id = ?').get(pA.id).synergies), ['carepad']);
  ok('25. Synergy 状态保存到 civilian_instance.synergies');
  const skillsBefore = db.prepare('SELECT COUNT(*) c FROM player_skills WHERE player_id = ?').get(pA.id).c;
  dodSynergy.checkAndSaveSynergies(pA.id);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM player_skills WHERE player_id = ?').get(pA.id).c, skillsBefore);
  ok('26. 检测不发放新技能（player_skills 不变——不是升级系统）');
  dodSynergy.checkAndSaveSynergies(pA.id);
  assert.strictEqual(JSON.parse(db.prepare('SELECT synergies FROM civilian_instance WHERE player_id = ?').get(pA.id).synergies).length, 1);
  ok('27. 幂等（重复检查不叠加）');
  const view = dodLore.loreView(pA.id);
  assert.ok(view.synergies.length === 1 && view.synergies[0].name === 'CarePad');
  ok('28. loreView 输出 synergies（含 Lore 解释）');
  assert.ok(view.synergies[0].changedAbility === 'BonusPad' && /帮助幸存者恢复/.test(view.synergies[0].loreExplanation));
  ok('29. 视图含 changedAbility 与 Lore 解释');
  const pB = mkPlayerDb('枪械医疗居民', 'S23');
  dodLore.generateCivilianLore(fakeIo, pB.id, { rng: 0.25, background: 'Security' });
  db.prepare("UPDATE civilian_instance SET abilities = ? WHERE player_id = ?").run(JSON.stringify(['Revolver', 'Caretaker']), pB.id);
  const detB = dodSynergy.checkAndSaveSynergies(pB.id);
  assert.deepStrictEqual(detB.map((s) => s.name), ['Loveshot']);
  ok('30. 第二组合：Revolver+Caretaker → Loveshot（改变 Revolver）');
  const pC = mkPlayerDb('无组合居民', 'S23');
  const genC = dodLore.generateCivilianLore(fakeIo, pC.id, { rng: 0.5 });
  // 无论抽到什么：生成流内部已跑过检查——synergies 必须与 detectSynergies(abilities) 一致
  const civC = db.prepare('SELECT * FROM civilian_instance WHERE player_id = ?').get(pC.id);
  assert.deepStrictEqual(
    JSON.parse(civC.synergies || '[]'),
    dodSynergy.detectSynergies(JSON.parse(civC.abilities)).map((s) => s.id)
  );
  ok('31. generateCivilianLore 内部执行检查（状态与检测一致）');
  assert.ok(Array.isArray(genC.synergies));
  ok('32. 生成返回值包含 synergies 字段');

  // ══ E. AI 描述规则 ══
  assert.strictEqual(dodSynergy.AI_DESCRIPTIONS.carepad, '你的医疗知识和工程经验结合，让你的设备拥有了新的用途。');
  ok('33. CarePad 描述示例（官方句式）');
  assert.ok(dodSynergy.AI_DESCRIPTIONS.loveshot && !/升级|获得/.test(dodSynergy.AI_DESCRIPTIONS.loveshot));
  ok('34. Loveshot 描述示例（无升级/获得措辞）');
  const allSynText = JSON.stringify(dodSynergy.listSynergies());
  assert.ok(!/你升级成|等级提升为|解锁了/.test(allSynText));
  ok('35. 全部 Synergy 数据无"升级/解锁"措辞');
  assert.ok(/禁止"你升级成X\/你获得了X Synergy"句式/.test(SYSTEM_RULES));
  ok('36. SYSTEM_RULES 携带描述禁令');
  assert.ok(/只能使用数据库已有 Synergy/.test(SYSTEM_RULES) && /不得创造新 Synergy/.test(SYSTEM_RULES));
  ok('37. SYSTEM_RULES：不得创造新 Synergy');

  // ══ F. AI Context 读取 ══
  const room = {
    id: 'S23',
    players: [
      { name: '工程医疗居民', socketId: pA.socket_id },
      { name: '无组合居民', socketId: pC.socket_id },
    ],
    currentExperience: null,
    currentDungeon: { name: 'Die of Death' },
  };
  const ctx = contextBuilder.buildContext(room);
  const synSec = ctx.sections.find((s) => s.key === 'synergy_lore');
  assert.ok(synSec && synSec.label === 'SYNERGY_LORE_CONTEXT');
  ok('38. 新增 SYNERGY_LORE_CONTEXT 分区');
  assert.ok(synSec.content.includes('CarePad') && synSec.content.includes('BonusPad+Caretaker'));
  ok('39. Context 含组合来源（BonusPad+Caretaker → 改变 BonusPad）');
  assert.ok(/将设施改造成帮助幸存者恢复的工具/.test(synSec.content));
  ok('40. Context 含 Lore 解释');
  assert.ok(synSec.content.includes('你的医疗知识和工程经验结合，让你的设备拥有了新的用途。'));
  ok('41. Context 含 GM 描述示例（官方句式）');
  assert.ok(/不是新职业、不是超能力、不是等级提升、不是技能树/.test(synSec.content));
  ok('42. Context 声明：不是职业/超能力/升级/技能树');
  assert.ok(/不得创造新 Synergy/.test(synSec.content));
  ok('43. Context 声明：只使用数据库已有组合');
  const lineOfC = synSec.content.split('\n').find((l) => l.includes('无组合居民'));
  assert.ok(!lineOfC);
  ok('44. 未形成 Synergy 的居民不出现在分区中');
  const roomB = { ...room, players: [{ name: '无组合居民', socketId: pC.socket_id }] };
  const ctxB = contextBuilder.buildContext(roomB);
  const synSecB = ctxB.sections.find((s) => s.key === 'synergy_lore');
  assert.ok(synSecB.content.includes('没有已形成的 Synergy') && synSecB.content.includes('不是技能树'));
  ok('45. 无 Synergy 房间：分区保留规则 + 空状态说明');
  assert.ok(/Synergy 是 Civilian 对自身经验的极致结合/.test(synSec.content));
  ok('46. Context 开头给出 Synergy 定义（经验的极致结合）');

  // ══ G. 限制边界 ══
  // 不创造新 Synergy：向目录插入非官方行被目录读取排除（服务层数据只来自官方输入）
  const insertFake = db.prepare(
    "INSERT OR REPLACE INTO ability_synergies (id, name, source_abilities_json, changed_ability, lore_explanation, trait_requirements_json, lore_source, source) VALUES ('fake', 'FakeSyn', '[]', 'Punch', 'x', '[]', 'FANON', 'FANON')"
  );
  insertFake.run();
  assert.deepStrictEqual(dodSynergy.detectSynergies(['Punch']), []);
  ok('47. 脏数据（空 source_abilities / 非 CANON）不命中任何玩家（组合≥2 项来源能力）');
  db.prepare("DELETE FROM ability_synergies WHERE id = 'fake'").run();
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM ability_synergies').get().c, 2);
  ok('48. 目录清理后仍只有官方 2 条');
  const presetCfg = JSON.parse(db.prepare("SELECT c.config_json FROM preset_dungeon_configs c JOIN preset_experiences p ON p.id = c.preset_id WHERE p.key = 'dod'").get().config_json);
  assert.ok(presetCfg.synergy_lore && presetCfg.synergy_lore.entries.length === 2);
  assert.ok(presetCfg.synergy_lore.entries.every((e) => e.lore_source === 'CANON'));
  ok('49. 预设 JSON 携带 synergy_lore（2 条官方组合）');
  assert.ok(!/技能树|skill tree/i.test(presetCfg.synergy_lore.rule) || /不是技能树/.test(presetCfg.synergy_lore.rule));
  ok('50. 预设规则明示不是技能树');

  // ══ H. REST ══
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const url = (p) => `http://127.0.0.1:${port}${p}`;
  const sess = createSession(pA.id);
  const resSyn = await fetch(url('/api/dod/synergies'), {
    headers: { 'Content-Type': 'application/json', cookie: `rtp_session=${sess.token}` },
  }).then((r) => r.json());
  assert.ok(resSyn.synergies.length === 2 && resSyn.synergies.some((s) => s.name === 'CarePad'));
  ok('51. REST：GET /api/dod/synergies（官方目录）');
  assert.ok(resSyn.mine.length === 1 && resSyn.mine[0].name === 'CarePad' && resSyn.mine[0].changedAbility === 'BonusPad');
  ok('52. REST：mine 返回我的 Synergy（含改变的能力）');
  assert.ok(/不是新职业\/超能力\/等级提升\/技能树/.test(resSyn.rule));
  ok('53. REST 规则声明（非技能组合/装备/升级系统）');
  const resNo = await fetch(url('/api/dod/synergies')).then((r) => r.status);
  assert.strictEqual(resNo, 401);
  ok('54. REST：未登录 401');
  const resCiv = await fetch(url('/api/dod/civilian'), {
    headers: { 'Content-Type': 'application/json', cookie: `rtp_session=${sess.token}` },
  }).then((r) => r.json());
  assert.ok(resCiv.civilian && resCiv.civilian.synergies && resCiv.civilian.synergies[0].name === 'CarePad');
  ok('55. REST：civilian 视图携带 synergies');

  // ══ I. 结构性红线 ══
  assert.ok(!fs.existsSync(path.join(__dirname, '../src/services/presets/dodSynergyTree.js')));
  ok('56. 无技能树/解锁链模块');
  const ctxSrc = fs.readFileSync(path.join(__dirname, '../src/services/ai/contextBuilder.js'), 'utf8');
  assert.ok(/SYNERGY_LORE_CONTEXT/.test(ctxSrc));
  ok('57. Context 构建器注册 SYNERGY_LORE_CONTEXT');
  const loreSrc = fs.readFileSync(path.join(__dirname, '../src/services/presets/dodLore.js'), 'utf8');
  assert.ok(/checkAndSaveSynergies/.test(loreSrc));
  ok('58. 生成流接入 Synergy 检查（Abilities 之后）');
  assert.ok(/对自身经验的极致结合/.test(SYSTEM_RULES));
  ok('59. SYSTEM_RULES 给出 Synergy 定义');
  assert.ok(dodSynergy.listSynergies().every((s) => ['carepad', 'loveshot'].includes(s.id)));
  ok('60. 目录 id 白名单（carepad/loveshot）');
  assert.ok(dodSynergy.synergyView(pA.id)[0].aiDescription === '你的医疗知识和工程经验结合，让你的设备拥有了新的用途。');
  ok('61. synergyView 提供 GM 描述示例');
  assert.ok(dodSynergy.synergyView(mkPlayerDb('路人民居', 'S23').id).length === 0);
  ok('62. 无身份玩家 → 空 Synergy 视图');

  server.close();
  console.log(`\n[阶段23] 通过 ${passed} 项测试`);
  if (passed < 58) {
    console.error('测试数量不足！');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('\n[阶段23] 测试失败：', err);
  process.exit(1);
});
