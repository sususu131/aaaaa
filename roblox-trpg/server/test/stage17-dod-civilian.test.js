/**
 * 阶段17 测试：Die of Death 预设 Phase 1 —— Civilian System（62 项）。
 * 覆盖：Civilian 模板生成 / Trait 生成 / Ability 绑定 / 重复 Ability 允许 /
 *       Synergy 检测 / 跨副本保存与 Balance 削弱 / AI 纪律 / REST。
 * 红线：不实现 Killer、不实现 Dungeon、不创造原创 Lore。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

for (const suffix of ['', '-wal', '-shm', '-journal']) {
  fs.rmSync(path.join(__dirname, '../../database/data/roblox_trpg.db' + suffix), { force: true });
}

process.env.AI_API_KEY = 'ai-key-s17';
process.env.AI_BASE_URL = 'http://127.0.0.1:4117/v1';
process.env.AI_MODEL = 'mock-s17';
process.env.AI_STREAM = 'off';

const { server } = require('../src/index.js');
const dbMod = require('@roblox-trpg/database');
const db = dbMod.getDb();
const presetSeeder = require('../src/services/presets/presetSeeder');
const dodCivilian = require('../src/services/presets/dodCivilian');
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
  const uid = `player_s17_${pSeq}`;
  db.prepare('INSERT INTO players (uid, socket_id, name, room_id) VALUES (?, ?, ?, ?)').run(uid, `sock_${uid}`, name, roomId);
  return db.prepare('SELECT * FROM players WHERE uid = ?').get(uid);
}

async function main() {
  console.log('[test] 阶段17 就绪（62 项）\n');

  // DOD 预设来自阶段16 导入器
  presetSeeder.runPresetSeeder(fakeIo);

  // ══ A. 数据与目录（官方设定，禁止原创）══
  const cols = db.prepare('PRAGMA table_info(civilian_instance)').all().map((c) => c.name);
  assert.ok(['id', 'player_id', 'background', 'traits', 'abilities', 'synergy_state'].every((c) => cols.includes(c)));
  ok('1. civilian_instance 表（id/player_id/background/traits/abilities/synergy_state）');
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dod_civilian_offers'").get());
  ok('2. dod_civilian_offers 表（Deck 候选）');
  dodCivilian.ensureSeeded();
  const abilityCount = db.prepare("SELECT COUNT(*) c FROM skills WHERE json_extract(effect_data, '$.dod_ability') = 1").get().c;
  assert.ok(abilityCount === 6); // 5 Ability + 1 Synergy（CarePad）
  ok('3. Ability 定义播种（5 Ability + CarePad，approved）');
  const dodDungeon = db.prepare("SELECT d.* FROM dungeons d WHERE d.roblox_experience_name = 'Die of Death'").get();
  const punchSkill = db.prepare("SELECT * FROM skills WHERE name = 'Punch'").get();
  assert.ok(punchSkill.source_dungeon_id === dodDungeon.id && punchSkill.status === 'approved');
  ok('4. Ability 绑定 DOD 副本（source_dungeon_id）');
  const punchMeta = JSON.parse(punchSkill.effect_data);
  assert.ok(punchMeta.trait === 'Physical Training' && punchMeta.source === 'DIE_OF_DEATH');
  ok('5. Ability 元数据：Trait 来源 + DIE_OF_DEATH 标记');
  assert.deepStrictEqual(dodCivilian.BACKGROUNDS, ['Engineer', 'Medic', 'Athlete', 'Cook', 'Security', 'Artist']);
  ok('6. Background 池（官方 6 项，非职业系统）');
  assert.deepStrictEqual(dodCivilian.ABILITY_CATALOG.map((a) => a.key), ['Punch', 'Caretaker', 'Revolver', 'Hotdog', 'BonusPad']);
  ok('7. Ability 目录（官方 5 项，无虚构）');
  const faction = db.prepare("SELECT * FROM factions WHERE uid = 'faction_dod_robloxia_citizens'").get();
  assert.ok(faction && faction.name === 'Robloxia Citizens' && /average Citizens inhabiting Robloxia/.test(faction.description));
  ok('8. 阵营：Robloxia Citizens（Civilian - The Victims 官方描述）');
  dodCivilian.ensureSeeded();
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM skills WHERE json_extract(effect_data, '$.dod_ability') = 1").get().c, 6);
  ok('9. 播种幂等（重复运行不重复）');
  const allText = JSON.stringify(dodCivilian.ABILITY_CATALOG) + JSON.stringify(dodCivilian.BACKGROUNDS);
  assert.ok(!/John|Mike|Alice/.test(allText));
  ok('10. 无固定英雄角色（Civilian 是模板）');

  // ══ B. Ability Deck 抽取 ══
  mkRoomDb('DOD1');
  const p1 = mkPlayerDb('平民甲', 'DOD1');
  const decks = dodCivilian.rollAbilityDecks(0);
  assert.strictEqual(decks.length, 3);
  ok('11. 抽取 3 个 Deck');
  assert.ok(decks.every((d) => d.abilities.length === 2));
  ok('12. 每个 Deck 2 个 Ability');
  const catalogKeys = dodCivilian.ABILITY_CATALOG.map((a) => a.key);
  assert.ok(decks.every((d) => d.abilities.every((a) => catalogKeys.includes(a.key))));
  ok('13. Deck 内容 ⊆ 官方目录');
  assert.ok(decks.every((d) => new Set(d.abilities.map((a) => a.key)).size === 2));
  ok('14. Deck 内不重复');
  const decksB = dodCivilian.rollAbilityDecks(0.93);
  assert.ok(JSON.stringify(decks) !== JSON.stringify(decksB));
  ok('15. 服务器随机：不同抽取可产生不同 Deck');
  const offer1 = dodCivilian.offerDecks(p1.id, { rng: 0.4 });
  assert.ok(Array.isArray(offer1) && db.prepare('SELECT 1 FROM dod_civilian_offers WHERE player_id = ?').get(p1.id));
  ok('16. Deck 候选落库（每玩家一行）');
  dodCivilian.offerDecks(p1.id, { rng: 0.7 });
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM dod_civilian_offers WHERE player_id = ?').get(p1.id).c, 1);
  ok('17. 重复抽取替换候选（仍单行，幂等）');
  assert.ok(offer1.every((d) => d.abilities.every((a) => a.trait === dodCivilian.ABILITY_CATALOG.find((c) => c.key === a.key).trait)));
  ok('18. Deck 携带 Trait（技能来源）');

  // ══ C. Civilian 身份生成 ══
  const id1 = dodCivilian.createCivilianIdentity(fakeIo, p1.id, { deckIndex: 2, rng: 0.4 });
  assert.ok(id1.created && id1.civilian);
  ok('19. 生成 Civilian 身份');
  assert.ok(dodCivilian.BACKGROUNDS.includes(id1.civilian.background));
  ok('20. Background ∈ 官方池（服务器随机）');
  const chosenDeck = dodCivilian.getOffer(p1.id)[1]; // 当前生效候选（测试17 已替换）
  assert.deepStrictEqual(JSON.parse(id1.civilian.traits), chosenDeck.abilities.map((a) => a.trait));
  ok('21. Traits = 所选 Deck 的技能来源');
  assert.deepStrictEqual(JSON.parse(id1.civilian.abilities), chosenDeck.abilities.map((a) => a.key));
  ok('22. Abilities = 所选 Deck');
  assert.strictEqual(id1.civilian.synergy_state, 'NONE');
  ok('23. 初始 synergy_state = NONE');
  assert.strictEqual(id1.civilian.source, 'DIE_OF_DEATH');
  ok('24. 身份来源 = DIE_OF_DEATH');
  const dup = dodCivilian.createCivilianIdentity(fakeIo, p1.id, { deckIndex: 1 });
  assert.ok(dup.created === false && dup.reason === 'ALREADY_HAS_IDENTITY');
  ok('25. 重复生成幂等（不重复创建）');
  assert.throws(() => dodCivilian.createCivilianIdentity(fakeIo, mkPlayerDb('临时', 'DOD1').id, { deckIndex: 9 }), /1~3/);
  ok('26. 非法 Deck 序号拒绝');
  const noOfferGuy = mkPlayerDb('无候选', 'DOD1');
  db.prepare('DELETE FROM dod_civilian_offers WHERE player_id = ?').run(noOfferGuy.id);
  // 无候选时自动抽取（进入流程保底），但非法序号仍拒绝
  assert.throws(() => dodCivilian.createCivilianIdentity(fakeIo, noOfferGuy.id, { deckIndex: 0 }), /1~3/);
  ok('27. deckIndex 0 拒绝');
  assert.ok(db.prepare("SELECT 1 FROM game_events WHERE room_id = 'DOD1' AND type = 'CIVILIAN_CREATED'").get());
  ok('28. CIVILIAN_CREATED 事件（Event Bus）');
  const p1Skills = db.prepare("SELECT s.name, ps.source_type FROM player_skills ps JOIN skills s ON s.id = ps.skill_id WHERE ps.player_id = ?").all(p1.id);
  assert.ok(chosenDeck.abilities.every((a) => p1Skills.some((r) => r.name === a.key && r.source_type === 'DIE_OF_DEATH')));
  ok('29. Ability 绑定 character_skills（source: DIE_OF_DEATH）');
  const p1SkillRow = db.prepare("SELECT ps.obtained_from_dungeon_id FROM player_skills ps JOIN skills s ON s.id = ps.skill_id WHERE ps.player_id = ? LIMIT 1").get(p1.id);
  assert.strictEqual(p1SkillRow.obtained_from_dungeon_id, dodDungeon.id);
  ok('30. Ability 获得来源 = DOD 副本');

  // ══ D. 重复 Ability 规则 ══
  const p2 = mkPlayerDb('平民乙', 'DOD1');
  dodCivilian.offerDecks(p2.id, { rng: 0.7 }); // 与 p1 当前候选相同抽取
  const id2 = dodCivilian.createCivilianIdentity(fakeIo, p2.id, { deckIndex: 2, rng: 0.4 });
  assert.deepStrictEqual(JSON.parse(id2.civilian.abilities), JSON.parse(id1.civilian.abilities));
  ok('31. 两名玩家选择相同 Deck → 相同 Ability');
  assert.ok(dodCivilian.ownsAbility(p1.id, chosenDeck.abilities[0].key) && dodCivilian.ownsAbility(p2.id, chosenDeck.abilities[0].key));
  ok('32. 多个 Civilian 可拥有相同 Ability（允许重复）');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM player_skills ps JOIN skills s ON s.id = ps.skill_id WHERE s.name = ?').get(chosenDeck.abilities[0].key).c, 2);
  ok('33. 无唯一职业限制（两条独立持有记录）');
  const p3 = mkPlayerDb('平民丙', 'DOD1');
  dodCivilian.offerDecks(p3.id, { rng: 0.7 });
  const id3 = dodCivilian.createCivilianIdentity(fakeIo, p3.id, { deckIndex: 2, rng: 0.4 });
  assert.ok(id3.created);
  ok('34. 第三名玩家同样可获得相同 Ability');
  assert.notStrictEqual(
    db.prepare('SELECT id FROM player_skills WHERE player_id = ?').get(p1.id).id,
    db.prepare('SELECT id FROM player_skills WHERE player_id = ?').get(p2.id).id
  );
  ok('35. Ability 持有按玩家独立');

  // ══ E. Synergy 检测 ══
  mkRoomDb('DOD2');
  const syn = mkPlayerDb('协同者', 'DOD2');
  // 构造含 Caretaker + BonusPad 的 Deck（官方组合）
  db.prepare('INSERT OR REPLACE INTO dod_civilian_offers (player_id, decks_json) VALUES (?, ?)').run(
    syn.id,
    JSON.stringify([
      { deckIndex: 1, abilities: [{ key: 'Punch', trait: 'Physical Training' }, { key: 'Hotdog', trait: 'Special Habit' }] },
      { deckIndex: 2, abilities: [{ key: 'Caretaker', trait: 'Medical Knowledge' }, { key: 'BonusPad', trait: 'Support Facility' }] },
      { deckIndex: 3, abilities: [{ key: 'Revolver', trait: 'Firearms Training' }, { key: 'Punch', trait: 'Physical Training' }] },
    ])
  );
  const synRes = dodCivilian.createCivilianIdentity(fakeIo, syn.id, { deckIndex: 2, rng: 0.5 });
  assert.ok(synRes.synergy && synRes.synergy.synergy === 'CarePad');
  ok('36. Caretaker + BonusPad → Synergy 检测成功');
  assert.ok(dodCivilian.ownsAbility(syn.id, 'CarePad'));
  ok('37. CarePad 授予（character_skills）');
  assert.strictEqual(dodCivilian.getCivilian(syn.id).synergy_state, 'CarePad');
  ok('38. synergy_state = CarePad');
  assert.ok(db.prepare("SELECT 1 FROM game_events WHERE room_id = 'DOD2' AND type = 'CIVILIAN_SYNERGY'").get());
  ok('39. CIVILIAN_SYNERGY 事件');
  const carePadLevel = () => db.prepare("SELECT ps.level FROM player_skills ps JOIN skills s ON s.id = ps.skill_id WHERE ps.player_id = ? AND s.name = 'CarePad'").get(syn.id).level;
  const lvlBefore = carePadLevel();
  dodCivilian.checkSynergy(fakeIo, syn.id);
  assert.strictEqual(carePadLevel(), lvlBefore);
  ok('40. Synergy 幂等（重复检测不重复升级）');
  const part = mkPlayerDb('半协同', 'DOD2');
  db.prepare('INSERT OR REPLACE INTO dod_civilian_offers (player_id, decks_json) VALUES (?, ?)').run(
    part.id,
    JSON.stringify([
      { deckIndex: 1, abilities: [{ key: 'Caretaker', trait: 'Medical Knowledge' }, { key: 'Hotdog', trait: 'Special Habit' }] },
      { deckIndex: 2, abilities: [{ key: 'Punch', trait: 'Physical Training' }, { key: 'Revolver', trait: 'Firearms Training' }] },
      { deckIndex: 3, abilities: [{ key: 'Hotdog', trait: 'Special Habit' }, { key: 'Punch', trait: 'Physical Training' }] },
    ])
  );
  const partRes = dodCivilian.createCivilianIdentity(fakeIo, part.id, { deckIndex: 1, rng: 0.5 });
  assert.ok(partRes.synergy === null && dodCivilian.getCivilian(part.id).synergy_state === 'NONE');
  ok('41. 仅有 Caretaker（缺 BonusPad）→ 不触发 Synergy');
  const carePadSkill = db.prepare("SELECT * FROM skills WHERE name = 'CarePad'").get();
  assert.ok(carePadSkill && carePadSkill.status === 'approved' && JSON.parse(carePadSkill.effect_data).synergy === true);
  ok('42. CarePad 定义（官方组合：医疗 + 支援设施）');
  const padOnly = mkPlayerDb('只有垫', 'DOD2');
  db.prepare('INSERT OR REPLACE INTO dod_civilian_offers (player_id, decks_json) VALUES (?, ?)').run(
    padOnly.id,
    JSON.stringify([
      { deckIndex: 1, abilities: [{ key: 'BonusPad', trait: 'Support Facility' }, { key: 'Hotdog', trait: 'Special Habit' }] },
      { deckIndex: 2, abilities: [{ key: 'Punch', trait: 'Physical Training' }, { key: 'Revolver', trait: 'Firearms Training' }] },
      { deckIndex: 3, abilities: [{ key: 'Hotdog', trait: 'Special Habit' }, { key: 'Punch', trait: 'Physical Training' }] },
    ])
  );
  const padRes = dodCivilian.createCivilianIdentity(fakeIo, padOnly.id, { deckIndex: 1, rng: 0.5 });
  assert.ok(padRes.synergy === null);
  ok('43. 仅有 BonusPad（缺 Caretaker）→ 不触发 Synergy');
  const carePadSource = db.prepare("SELECT ps.source_type FROM player_skills ps JOIN skills s ON s.id = ps.skill_id WHERE ps.player_id = ? AND s.name = 'CarePad'").get(syn.id);
  assert.strictEqual(carePadSource.source_type, 'DIE_OF_DEATH');
  ok('44. Synergy 同样 source: DIE_OF_DEATH');
  assert.ok(db.prepare("SELECT data FROM game_events WHERE room_id = 'DOD2' AND type = 'CIVILIAN_SYNERGY'").get().data.includes('CarePad'));
  ok('45. Synergy 状态与事件一致');

  // ══ F. 跨副本保存与 Balance ══
  assert.ok(db.prepare('SELECT 1 FROM player_skills WHERE player_id = ?').get(syn.id));
  ok('46. Ability 永久保存（character_skills 持久）');
  assert.strictEqual(dodCivilian.dodAbilityMultiplier('Die of Death'), 1.0);
  ok('47. DOD 内：倍率 1.0');
  assert.strictEqual(dodCivilian.dodAbilityMultiplier('DOORS'), 0.5);
  ok('48. 离开 DOD：Balance 削弱 0.5');
  const viewDoors = dodCivilian.civilianView(syn.id, 'DOORS');
  assert.ok(viewDoors.abilities.every((a) => a.effectiveMultiplier === 0.5) && viewDoors.balanceMultiplier === 0.5);
  ok('49. 跨副本视图：能力列表含削弱倍率');
  assert.ok(dodCivilian.ownsAbility(syn.id, 'Caretaker') && dodCivilian.ownsAbility(syn.id, 'BonusPad'));
  ok('50. 削弱不删除 Ability（永久保存）');
  const viewHome = dodCivilian.civilianView(syn.id, 'Die of Death');
  assert.ok(viewHome.abilities.every((a) => a.effectiveMultiplier === 1.0));
  ok('51. DOD 世界内：能力全效');
  const viewNone = dodCivilian.civilianView(syn.id, null);
  assert.strictEqual(viewNone.balanceMultiplier, 0.5);
  ok('52. 未知世界：默认削弱（DOD Ability 属于该世界的生存能力）');

  // ══ G. AI 纪律与安全 ══
  assert.ok(/普通人|幸存者/.test(SYSTEM_RULES) && /超级英雄/.test(SYSTEM_RULES) && /救世主/.test(SYSTEM_RULES));
  ok('53. SYSTEM_RULES：Civilian 描述纪律（普通人/幸存者；禁超级英雄/职业战士/救世主）');
  const names = tools.getRegistry().map((t) => t.name);
  assert.ok(!names.includes('create_civilian_hero') && !names.includes('set_civilian_ability'));
  ok('54. 无 Civilian 作弊工具');
  assert.ok(!names.some((n) => /civilian/i.test(n)));
  ok('55. AI 无 civilian 写工具（身份生成走服务器流程）');
  const punchDesc = db.prepare("SELECT description FROM skills WHERE name = 'Punch'").get().description;
  assert.ok(/身体能力/.test(punchDesc));
  ok('56. Ability 描述忠实官方设定（Punch = 强大的身体能力）');
  assert.ok(dodCivilian.BACKGROUNDS.every((b) => /^[A-Z][a-z]+$/.test(b)));
  ok('57. Background 为职业/兴趣模板（非角色名）');

  // ══ H. REST ══
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  mkRoomDb('DOD3');
  const restP = mkPlayerDb(' REST 平民', 'DOD3');
  const sess = createSession(restP.id);
  const url = (p) => `http://127.0.0.1:${port}${p}`;
  const res401 = await fetch(url('/api/dod/civilian/offer'));
  assert.strictEqual(res401.status, 401);
  ok('58. 无会话拒绝（401）');
  const offerRes = await fetch(url(`/api/dod/civilian/offer?sessionToken=${encodeURIComponent(sess.token)}`)).then((r) => r.json());
  assert.ok(offerRes.ok && offerRes.decks.length === 3 && offerRes.backgrounds.length === 6);
  ok('59. GET /api/dod/civilian/offer（3 Deck + 官方背景池）');
  const selRes = await fetch(url('/api/dod/civilian/select'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deckIndex: 1, sessionToken: sess.token }),
  }).then((r) => r.json());
  assert.ok(selRes.ok && selRes.created && selRes.grants.length === 2 && selRes.view.background);
  ok('60. POST /api/dod/civilian/select（身份生成 + Ability 绑定）');
  const viewRes = await fetch(url(`/api/dod/civilian?sessionToken=${encodeURIComponent(sess.token)}&experience=DOORS`)).then((r) => r.json());
  assert.ok(viewRes.civilian && viewRes.civilian.balanceMultiplier === 0.5 && viewRes.civilian.faction === 'Robloxia Citizens');
  ok('61. GET /api/dod/civilian（身份视图 + 跨副本倍率）');
  const restP2 = mkPlayerDb('REST 平民乙', 'DOD3');
  const sess2 = createSession(restP2.id);
  const badSel = await fetch(url('/api/dod/civilian/select'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deckIndex: 5, sessionToken: sess2.token }),
  });
  assert.ok(badSel.status >= 400);
  ok('62. 非法 Deck 序号 REST 拒绝');

  server.close();
  console.log(`\n[阶段17] 通过 ${passed} 项测试`);
  if (passed < 55) {
    console.error('测试数量不足！');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('\n[阶段17] 测试失败：', err);
  process.exit(1);
});
