/**
 * 阶段24 测试：Civilian Fate Selection System（Deck of Death Lore）（60 项）。
 * 覆盖：dod_fate_system Lore / Fate 能力池 / Background-Traits-Personality 权重 /
 *       Fate Options 生成（3×2+lore_reason）/ 选择保存（character_skills、source）/
 *       Lore 解释 / 永久保存与 Balance / AI 描述规则 / 不会生成英雄身份 / REST。
 * 红线：Lore 层模拟——不是复刻游戏 UI、不是卡牌玩法、无抽卡稀有度机制。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

for (const suffix of ['', '-wal', '-shm', '-journal']) {
  fs.rmSync(path.join(__dirname, '../../database/data/roblox_trpg.db' + suffix), { force: true });
}

process.env.AI_API_KEY = 'ai-key-s24';
process.env.AI_BASE_URL = 'http://127.0.0.1:4124/v1';
process.env.AI_MODEL = 'mock-s24';
process.env.AI_STREAM = 'off';

const { server } = require('../src/index.js');
const dbMod = require('@roblox-trpg/database');
const db = dbMod.getDb();
const presetSeeder = require('../src/services/presets/presetSeeder');
const dodCivilian = require('../src/services/presets/dodCivilian');
const dodFate = require('../src/services/presets/dodFate');
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
  const uid = `player_s24_${pSeq}`;
  db.prepare('INSERT INTO players (uid, socket_id, name, room_id) VALUES (?, ?, ?, ?)').run(uid, `sock_${uid}`, name, roomId);
  return db.prepare('SELECT * FROM players WHERE uid = ?').get(uid);
}

async function main() {
  console.log('[test] 阶段24 就绪（60 项）\n');

  presetSeeder.runPresetSeeder(fakeIo);
  dodFate.ensureFateSeeded();

  // ══ A. dod_fate_system Lore ══
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dod_fate_system'").get());
  ok('1. dod_fate_system 表存在');
  const cols = db.prepare('PRAGMA table_info(dod_fate_system)').all().map((c) => c.name);
  ['id', 'name', 'description', 'concepts_json', 'flow_json', 'weight_tiers_json', 'ai_rule']
    .every((f) => cols.includes(f) || assert.fail(`缺字段 ${f}`));
  ok('2. 规格字段齐全');
  assert.ok(db.prepare('PRAGMA table_info(civilian_instance)').all().map((c) => c.name).includes('fate_choice'));
  ok('3. civilian_instance.fate_choice 列存在');
  const fateSys = dodFate.getFateSystem();
  assert.strictEqual(fateSys.name, 'Deck of Death');
  ok('4. 名称 = Deck of Death');
  assert.ok(/不是普通卡牌/.test(fateSys.description) && /未知力量/.test(fateSys.description) && /生存机会/.test(fateSys.description));
  ok('5. Lore：不是普通卡牌——未知力量给予的生存机会');
  assert.ok(fateSys.concepts.some((c) => /无法完全控制/.test(c) && /影响可能出现的能力/.test(c)));
  ok('6. 概念：无法完全控制 + 经历影响可能出现的能力');
  assert.ok(fateSys.concepts.some((c) => /不是魔法/.test(c) && /潜能被激发/.test(c)));
  ok('7. 概念：能力不是魔法——潜能激发/经历成为优势');
  assert.deepStrictEqual(fateSys.flow, ['Civilian Identity', 'Background', 'Traits', 'Possible Abilities', 'Fate Selection', 'Final Abilities']);
  ok('8. 六步生成流');
  assert.ok(/禁止"系统给你技能"/.test(fateSys.aiRule) && /你的过去经历让你发现/.test(fateSys.aiRule));
  ok('9. AI 描述规则（禁止"系统给你技能"）');
  assert.strictEqual(fateSys.loreSource, 'CANON');
  ok('10. lore_source = CANON');

  // ══ B. Fate 能力池 ══
  const pool = dodFate.fatePool();
  assert.strictEqual(pool.length, 14);
  assert.ok(['Flashlight', 'Adrenaline', 'Banana Peel', 'Cloak', 'Taunt', 'Bugle'].every((n) => pool.some((a) => a.name === n)));
  ok('11. Fate 池 = 官方全部 14 项基础 Ability（阶段25：所有都算技能；仅 Synergy 登记条目不入池）');
  assert.ok(pool.every((a) => a.category !== 'synergy'));
  ok('12. 池内无 Synergy 条目');
  const fateSkills = db.prepare("SELECT COUNT(*) c FROM skills WHERE json_extract(effect_data, '$.dod_fate_ability') = 1").get().c;
  assert.strictEqual(fateSkills, 14);
  assert.ok(db.prepare("SELECT COUNT(*) c FROM skills WHERE name IN ('Flashlight','Adrenaline','Banana Peel','Cloak','Taunt','Bugle') AND json_extract(effect_data, '$.dod_fate_ability') = 1").get().c === 6);
  ok('13. 池技能全部登记（dod_fate_ability 标记；Flashlight/Adrenaline/Banana Peel/Cloak/Taunt/Bugle 均为技能）');
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM skills WHERE json_extract(effect_data, '$.dod_ability') = 1").get().c, 6);
  ok('14. 阶段17 技能标记不受影响（dod_ability 仍为 6）');

  // ══ C. Ability 权重（Background/Traits/Personality）══
  const w = (k, bg) => dodFate.fateWeight(k, { background: bg, traits: [], personality: [] });
  assert.ok(w('Caretaker', 'Medic') > w('BonusPad', 'Medic') && w('BonusPad', 'Medic') > w('Revolver', 'Medic'));
  ok('15. Medic：Caretaker 高概率 > BonusPad 中概率 > Revolver 低概率（官方示例）');
  assert.ok(w('BonusPad', 'Engineer') > w('Caretaker', 'Engineer') && w('Block', 'Engineer') > w('Caretaker', 'Engineer'));
  ok('16. Engineer：BonusPad/Block 高概率');
  assert.ok(['Dash', 'Punch', 'Adrenaline'].every((k) => w(k, 'Athlete') > w('Caretaker', 'Athlete')));
  ok('17. Athlete：Dash/Punch/Adrenaline 高概率');
  assert.ok(w('Revolver', 'Security') > w('Caretaker', 'Security') && w('Block', 'Security') > w('Caretaker', 'Security'));
  ok('18. Security：Revolver/Block 高概率');
  const base = dodFate.fateWeight('Caretaker', { background: 'Athlete', traits: [], personality: [] });
  const traitBoosted = dodFate.fateWeight('Caretaker', { background: 'Athlete', traits: ['Medical Knowledge'], personality: [] });
  assert.ok(traitBoosted > base);
  ok('19. Trait 重合提高权重（经历解释加成）');
  const profileSvc = require('../src/services/presets/dodBackgroundProfile');
  const medProfile = profileSvc.getProfile('medic');
  const persBoost = dodFate.fateWeight('Caretaker', { background: 'Medic', traits: [], personality: medProfile.personality_patterns });
  assert.ok(persBoost > w('Caretaker', 'Medic'));
  ok('20. Personality 一致性加成（人格与背景模式吻合）');
  assert.ok(w('Revolver', 'Medic') >= dodFate.TIER_WEIGHTS.low);
  ok('21. 低概率 ≠ 零概率（不锁定：Medic 仍可能获得 Revolver）');

  // 统计验证（确定性种子扫描 200 次）
  let caretakerCount = 0;
  let bonusPadCount = 0;
  let revolverCount = 0;
  for (let i = 0; i < 200; i += 1) {
    const opts = dodFate.buildFateOptions({ background: 'Medic', traits: [], personality: [], rng: i / 200 });
    for (const o of opts) {
      if (o.ability_1 === 'Caretaker' || o.ability_2 === 'Caretaker') caretakerCount += 1;
      if (o.ability_1 === 'BonusPad' || o.ability_2 === 'BonusPad') bonusPadCount += 1;
      if (o.ability_1 === 'Revolver' || o.ability_2 === 'Revolver') revolverCount += 1;
    }
  }
  assert.ok(caretakerCount > revolverCount);
  ok('22. 统计：Medic 的 Caretaker 出现次数 > Revolver（200 次抽取）');
  assert.ok(bonusPadCount > revolverCount);
  ok('23. 统计：BonusPad（中概率）> Revolver（低概率）');

  // ══ D. Fate Options 生成 ══
  mkRoomDb('F24');
  const p1 = mkPlayerDb('命运居民甲', 'F24');
  const offer = dodFate.offerFate(p1.id, { rng: 0.42, background: 'Medic' });
  assert.strictEqual(offer.options.length, 3);
  ok('24. 生成 3 个 Fate Options');
  assert.ok(offer.options.every((o) => o.ability_1 && o.ability_2 && o.ability_1 !== o.ability_2));
  ok('25. 每个 Option 含 ability_1/ability_2（两项不同）');
  assert.ok(offer.options.every((o) => o.lore_reason && o.lore_reason.length > 8));
  ok('26. 每个 Option 含 lore_reason');
  assert.ok(offer.options.every((o) => o.name && o.name.length > 0));
  ok('27. 每个 Option 有名称');
  const poolNames = pool.map((a) => a.name);
  assert.ok(offer.options.every((o) => poolNames.includes(o.ability_1) && poolNames.includes(o.ability_2)));
  ok('28. Option 内容 ⊆ 官方 14 项池');
  const offerAgain = dodFate.offerFate(p1.id, { rng: 0.42, background: 'Medic' });
  assert.deepStrictEqual(offer.options, offerAgain.options);
  ok('29. 同种子确定性（可重放）');
  const offerDiff = dodFate.buildFateOptions({ background: 'Medic', traits: [], personality: [], rng: 0.91 });
  assert.ok(JSON.stringify(offer.options) !== JSON.stringify(offerDiff));
  ok('30. 不同种子可产生不同 Options（服务器随机）');
  assert.ok(dodCivilian.getOffer(p1.id).length === 3 && dodCivilian.getOffer(p1.id)[0].fate === true);
  ok('31. 候选持久化（deck 兼容格式 + fate 标记）');
  assert.ok(offer.traits.length > 0 && offer.personality.length > 0);
  ok('32. 生成流前件：Background → Traits → Personality 已掷取');

  // ══ E. Lore 解释 ══
  assert.strictEqual(dodFate.fateLoreReason('Caretaker', 'Dash', 'Medic'), '过去接受过救援训练，同时拥有快速行动能力。');
  ok('33. 官方示例：Caretaker+Dash → Emergency Response 理由原文');
  assert.strictEqual(dodFate.fateOptionName('Dash', 'Caretaker'), 'Emergency Response');
  ok('34. 组合命名（顺序无关）');
  const generic = dodFate.fateLoreReason('BonusPad', 'Revolver', 'Engineer');
  assert.ok(/过去/.test(generic) && /生存优势/.test(generic));
  ok('35. 通用解释：由两项 Ability 的人生经历合成');
  // 扫描叙事面文本（描述/概念/选项理由/名称）；ai_rule 本身是禁令（含禁词属正常，剥除后再扫）
  const narrativeText = [
    fateSys.description,
    ...fateSys.concepts,
    ...offer.options.map((o) => `${o.name}${o.lore_reason}`),
    generic,
  ].join('\n');
  const stripped = narrativeText.replace(/不是魔法/g, '').replace(/禁止[^"]*/g, '');
  assert.ok(!/魔法|法术|系统给你|抽到|抽卡/.test(stripped));
  ok('36. 叙事面 Fate 文本无魔法/系统发放/抽卡措辞');

  // ══ F. 选择保存 ══
  // 找一个确定产生 Caretaker+BonusPad 的种子（覆盖 Synergy 检查）
  // 与 offerFate 完全一致的偏移复算（traits +0.31 / personality +0.57 / options +0.73）
  let synergySeed = null;
  let synergyIdx = 0;
  for (let i = 0; i < 800 && synergySeed === null; i += 1) {
    const s = (i / 800) % 1;
    const traits = profileSvc.rollProfileTraits('Medic', (s + 0.31) % 1);
    const personality = profileSvc.rollPersonality('Medic', (s + 0.57) % 1);
    const o = dodFate.buildFateOptions({ background: 'Medic', traits, personality, rng: (s + 0.73) % 1 });
    const idx = o.findIndex((x) => [x.ability_1, x.ability_2].sort().join('+') === 'BonusPad+Caretaker');
    if (idx >= 0) {
      synergySeed = s;
      synergyIdx = idx + 1;
    }
  }
  assert.ok(synergySeed !== null, '未找到 Caretaker+BonusPad 种子');
  const p2 = mkPlayerDb('命运居民乙', 'F24');
  const offerSyn = dodFate.offerFate(p2.id, { rng: synergySeed, background: 'Medic' });
  const sel = dodFate.selectFate(fakeIo, p2.id, synergyIdx, { rng: synergySeed });
  assert.ok(sel.created && sel.fate.optionName);
  ok('37. 选择 Fate Option → 创建 Civilian 身份');
  const civ2 = dodCivilian.getCivilian(p2.id);
  assert.deepStrictEqual(
    JSON.parse(civ2.abilities).sort(),
    offerSyn.options[synergyIdx - 1] && [offerSyn.options[synergyIdx - 1].ability_1, offerSyn.options[synergyIdx - 1].ability_2].sort()
  );
  ok('38. selected_abilities 保存 = 所选 Option 的两项 Ability');
  const granted = db.prepare(
    "SELECT s.name FROM player_skills ps JOIN skills s ON s.id = ps.skill_id WHERE ps.player_id = ? AND ps.source_type = 'DIE_OF_DEATH'"
  ).all(p2.id).map((r) => r.name);
  assert.ok(granted.length >= 2);
  ok('39. Ability 进入 character_skills（source: DIE_OF_DEATH）');
  const fateChoice = dodFate.fateView(p2.id);
  assert.ok(fateChoice && fateChoice.optionName && fateChoice.loreReason && fateChoice.selectedAt);
  ok('40. fate_choice 持久化（选项名/解释/时间）');
  assert.ok(dodSynergy.synergyView(p2.id).some((s) => s.name === 'CarePad'));
  ok('41. Fate 选择后自动检查 Synergy（Caretaker+BonusPad → CarePad）');
  assert.ok(db.prepare("SELECT 1 FROM civilian_identity_profile WHERE player_id = ?").get(p2.id));
  ok('42. Identity Presentation 自动补建（外观/举止表现）');
  assert.ok(db.prepare("SELECT 1 FROM game_events WHERE type = 'CIVILIAN_FATE_SELECTED'").get());
  ok('43. 选择记入 Event Bus（CIVILIAN_FATE_SELECTED）');
  const selAgain = dodFate.selectFate(fakeIo, p2.id, 1, { rng: synergySeed });
  assert.ok(!selAgain.created);
  ok('44. 幂等：重复选择不重建身份');
  const cntAfter = db.prepare('SELECT COUNT(*) c FROM player_skills WHERE player_id = ?').get(p2.id).c;
  dodFate.selectFate(fakeIo, p2.id, 2, { rng: synergySeed });
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM player_skills WHERE player_id = ?').get(p2.id).c, cntAfter);
  ok('45. 幂等：不重复发放技能');
  // 非法选择
  let badIdx = false;
  try {
    dodFate.selectFate(fakeIo, p2.id, 9, { rng: 0.5 });
  } catch { badIdx = true; }
  assert.ok(badIdx);
  ok('46. 非法 Option 序号 → 拒绝');
  let noOffer = false;
  try {
    dodFate.selectFate(fakeIo, mkPlayerDb('无候选者', 'F24').id, 1, { rng: 0.5 });
  } catch { noOffer = true; }
  assert.ok(noOffer);
  ok('47. 无 Fate 候选 → 拒绝（须先 offer）');

  // ══ G. 永久保存与 Balance ══
  assert.strictEqual(dodCivilian.dodAbilityMultiplier('Die of Death'), 1.0);
  assert.strictEqual(dodCivilian.dodAbilityMultiplier('Doors'), 0.5);
  ok('48. 跨副本永久保存：DOD 内 1.0 / 离开 DOD 被 Balance 削弱至 0.5');
  const view2 = dodCivilian.civilianView(p2.id, 'Die of Death');
  assert.ok(view2.abilities.every((a) => a.effectiveMultiplier === 1.0));
  ok('49. civilianView：DOD 内能力全效');
  const viewAway = dodCivilian.civilianView(p2.id, 'Doors');
  assert.ok(viewAway.abilities.every((a) => a.effectiveMultiplier === 0.5));
  ok('50. 离开 DOD 后能力削弱（来源特殊环境——Balance 语义）');

  // ══ H. AI Context 与描述规则 ══
  const room = {
    id: 'F24',
    players: [{ name: '命运居民乙', socketId: p2.socket_id }],
    currentExperience: null,
    currentDungeon: { name: 'Die of Death' },
  };
  const ctx = contextBuilder.buildContext(room);
  const fateSec = ctx.sections.find((s) => s.key === 'fate_lore');
  assert.ok(fateSec && fateSec.label === 'FATE_LORE_CONTEXT');
  ok('51. 新增 FATE_LORE_CONTEXT 分区');
  assert.ok(fateSec.content.includes('Deck of Death') && fateSec.content.includes('不是普通卡牌'));
  ok('52. Context 含 Deck of Death Lore');
  assert.ok(fateSec.content.includes('你的过去经历让你发现，自己拥有处理这种情况的方法。'));
  ok('53. Context 含正确描述句式（官方原文）');
  assert.ok(fateSec.content.includes(`命运居民乙｜Fate：${fateChoice.optionName}`));
  ok('54. Context 列出玩家 Fate 选择（选项名+理由）');
  assert.ok(/禁止"系统给你技能\/你抽到了X卡"句式/.test(SYSTEM_RULES));
  ok('55. SYSTEM_RULES：Fate 描述禁令');

  // ══ I. 不会生成英雄身份 ══
  const allFateText = JSON.stringify(dodFate.getFateSystem()) + JSON.stringify(offer.options) + JSON.stringify(fateChoice);
  assert.ok(!/超级英雄|救世主|英雄登场|天选之子|主角光环/.test(allFateText));
  ok('56. 全部 Fate 数据无英雄/救世主措辞');
  assert.ok(/普通居民\/幸存者/.test(SYSTEM_RULES) || /禁止超级英雄/.test(SYSTEM_RULES));
  ok('57. SYSTEM_RULES 保持普通人视角（无英雄化）');

  // ══ J. REST ══
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const url = (p) => `http://127.0.0.1:${port}${p}`;
  const sess = createSession(p1.id);
  const resFate = await fetch(url('/api/dod/fate'), {
    headers: { 'Content-Type': 'application/json', cookie: `rtp_session=${sess.token}` },
  }).then((r) => r.json());
  assert.ok(resFate.fateSystem && resFate.fateSystem.name === 'Deck of Death');
  ok('58. REST：GET /api/dod/fate（Lore + mine）');
  const resOffer = await fetch(url('/api/dod/fate/offer?background=Security'), {
    headers: { 'Content-Type': 'application/json', cookie: `rtp_session=${sess.token}` },
  }).then((r) => r.json());
  assert.ok(resOffer.options.length === 3 && resOffer.background === 'Security');
  ok('59. REST：GET /api/dod/fate/offer（3 个加权 Options）');
  const resSelect = await fetch(url('/api/dod/fate/select'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: `rtp_session=${sess.token}` },
    body: JSON.stringify({ optionIndex: 1 }),
  }).then((r) => r.json());
  assert.ok(resSelect.created && resSelect.fate && resSelect.fate.optionName);
  ok('60. REST：POST /api/dod/fate/select（选择保存成功）');

  server.close();
  console.log(`\n[阶段24] 通过 ${passed} 项测试`);
  if (passed < 56) {
    console.error('测试数量不足！');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('\n[阶段24] 测试失败：', err);
  process.exit(1);
});
