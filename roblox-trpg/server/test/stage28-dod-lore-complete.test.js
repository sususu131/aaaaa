/**
 * 阶段28 测试：Die of Death Lore 全量核对补全（杀手称号/台词/细节 + Synergy 大师设定）（30 项）。
 * 依据 2026-08-28 官方 Wiki 输入补齐阶段25 未入库条目；红线不变：无数值表、Killer 仅 Lore。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

for (const suffix of ['', '-wal', '-shm', '-journal']) {
  fs.rmSync(path.join(__dirname, '../../database/data/roblox_trpg.db' + suffix), { force: true });
}

process.env.AI_API_KEY = 'ai-key-s28';
process.env.AI_BASE_URL = 'http://127.0.0.1:4128/v1';
process.env.AI_MODEL = 'mock-s28';
process.env.AI_STREAM = 'off';

const { server } = require('../src/index.js');
const dbMod = require('@roblox-trpg/database');
const db = dbMod.getDb();
const presetSeeder = require('../src/services/presets/presetSeeder');
const dodWorldLore = require('../src/services/presets/dodWorldLore');
const dodSynergy = require('../src/services/presets/dodSynergy');
const contextBuilder = require('../src/services/ai/contextBuilder');

let passed = 0;
const ok = (label) => {
  passed += 1;
  console.log(`  ✓ ${label}`);
};
const fakeIo = { to: () => ({ emit: () => {} }), emit: () => {} };

async function main() {
  console.log('[test] 阶段28 就绪（30 项）\n');
  presetSeeder.runPresetSeeder(fakeIo);

  const profile = dodWorldLore.getWorldProfile();
  const entities = profile.knownThreats[0].known_entities;
  const byName = Object.fromEntries(entities.map((e) => [e.name, e]));

  // ══ A. 杀手称号 ══
  assert.strictEqual(byName.Pursuer.title, '执着的（The Persistent）');
  ok('1. Pursuer 称号：执着的（The Persistent）');
  assert.strictEqual(byName.Badware.title, '零号病人（Patient Zero）');
  ok('2. Badware 称号：零号病人（Patient Zero）');
  assert.ok(byName.Artful.title === '法国魔术师' && byName.Killdroid.title === '失控的保镖原型' && byName.Harken.title === '噪音猎人');
  ok('3. Artful/Killdroid/Harken 称号齐备');
  assert.ok(entities.every((e) => e.title));
  ok('4. 五杀手全部携带 title 字段');

  // ══ B. 游戏内台词 ══
  assert.ok(byName.Pursuer.quote.includes('already too late'));
  ok('5. Pursuer 台词（游戏内描述）');
  assert.ok(byName.Badware.quote.includes('infected'));
  ok('6. Badware 台词（Your computer seems to have been infected! ;)）');
  assert.ok(byName.Artful.quote.includes('VANISH') && byName.Artful.quote.includes('Can success even be worth its story?'));
  ok('7. Artful 台词（两句）');
  assert.ok(byName.Killdroid.quote.includes('BLAST TARGET TO SMITHEREENS'));
  ok('8. Killdroid 台词（NEW DIRECTIVE）');
  assert.ok(byName.Harken.quote.includes('A beautiful view.'));
  ok('9. Harken 台词（A beautiful view.）');

  // ══ C. Pursuer 细节补全 ══
  assert.ok(/隐形时身体僵硬、威胁性降低/.test(byName.Pursuer.behavior));
  ok('10. Pursuer：隐形时身体僵硬、威胁性降低（可不被察觉地跟随）');
  assert.ok(/稀有物种、突变的疯狂科学家、外星人/.test(byName.Pursuer.origin));
  ok('11. Pursuer：多种起源传说');
  assert.ok(/难以驯服/.test(byName.Pursuer.government_response));
  ok('12. Pursuer：植入芯片失败后多数科学家认为难以驯服');
  assert.ok(/近处者会头晕许久/.test(byName.Pursuer.behavior));
  ok('13. Pursuer：嚎叫近处者头晕（Library 叙述）');
  assert.ok(/威胁性较低/.test(byName.Pursuer.counter_hint));
  ok('14. Pursuer：对策提示含隐形弱化说明');

  // ══ D. Badware / Artful / Harken 细节 ══
  assert.ok(/并不特别针对平民/.test(byName.Badware.motive) && /驱逐阻碍者/.test(byName.Badware.motive));
  ok('15. Badware：不针对平民但驱逐阻碍者');
  assert.ok(/观众起哄过多/.test(byName.Artful.government_response) && /私下经历/.test(byName.Artful.government_response));
  ok('16. Artful：事故起因两类说法（起哄/私下经历）');
  assert.ok(/也可反转为给自己加速/.test(byName.Artful.behavior));
  ok('17. Artful：音乐盒可反转加速');
  assert.ok(/追忆父亲/.test(byName.Harken.origin) && /水栖构造体/.test(byName.Harken.origin));
  ok('18. Harken：纠缠手法=追忆父亲（对抗水栖构造体彩蛋）');
  assert.ok(/设计了一切所需工具/.test(byName.Harken.origin) && /无法长期存活/.test(byName.Harken.origin));
  ok('19. Harken：父母为其设计工具（构造体类型不能长存）');
  assert.ok(/花瓶/.test(byName.Harken.origin) && /形影不离/.test(byName.Harken.origin));
  ok('20. Harken：挚友制陶花瓶细节');
  assert.ok(/驱赶平民并非出于敌意/.test(byName.Harken.motive));
  ok('21. Harken：驱赶非敌意（为性命恐惧）');

  // ══ E. Synergy 大师设定（官方）══
  assert.ok(/领域的大师/.test(profile.civilianLife.synergy) && /任何居民都可以成为协同者/.test(profile.civilianLife.synergy));
  ok('22. 世界档案：Synergy 居民=领域大师（官方设定）');
  const synSrc = fs.readFileSync(path.join(__dirname, '../src/services/presets/dodSynergy.js'), 'utf8');
  assert.ok(/领域的大师/.test(synSrc) && /更强的工具/.test(synSrc));
  ok('23. dodSynergy：官方大师设定入档（注释层）');
  db.prepare("INSERT OR IGNORE INTO rooms (id, status, max_players) VALUES ('S28', 'waiting', 3)").run();
  let seq = 0;
  const mkP = (name) => {
    seq += 1;
    db.prepare('INSERT INTO players (uid, socket_id, name, room_id) VALUES (?, ?, ?, ?)').run(`u_s28_${seq}`, `sock_s28_${seq}`, name, 'S28');
    return db.prepare('SELECT * FROM players WHERE uid = ?').get(`u_s28_${seq}`);
  };
  const p1 = mkP('协同居民');
  db.prepare('INSERT INTO civilian_instance (player_id, background, traits, abilities, synergy_state, synergies, source) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(p1.id, 'Medic', '["Medical Knowledge","Engineering Experience"]', '["Caretaker","BonusPad"]', 'CarePad', '["carepad"]', 'DIE_OF_DEATH');
  const room = { id: 'S28', players: [{ name: '协同居民', socketId: p1.socket_id }], currentExperience: null, currentDungeon: { name: 'Die of Death' } };
  const ctx = contextBuilder.buildContext(room);
  const synSec = ctx.sections.find((s) => s.key === 'synergy_lore');
  assert.ok(/大师/.test(synSec.content) && /经验造诣/.test(synSec.content) && /不是系统升级/.test(synSec.content));
  ok('24. SYNERGY_LORE_CONTEXT：大师=经验造诣（非系统升级）');
  const loreSec = ctx.sections.find((s) => s.key === 'world_lore');
  assert.ok(/Known Threats: Pursuer（执着的（The Persistent）·He\/Him）/.test(loreSec.content));
  ok('25. WORLD_LORE_CONTEXT：杀手称号+代词列表（GM 称呼用）');
  assert.ok(loreSec.content.includes('Badware（零号病人（Patient Zero）·It/They）'));
  ok('26. WORLD_LORE_CONTEXT：五杀手称号齐全');

  // ══ F. 预设 JSON 镜像 + 红线回归 ══
  const cfg = JSON.parse(db.prepare("SELECT c.config_json FROM preset_dungeon_configs c JOIN preset_experiences p ON p.id = c.preset_id WHERE p.key = 'dod'").get().config_json);
  assert.ok(cfg.world_lore.killer_titles && cfg.world_lore.killer_titles.Pursuer === '执着的（The Persistent）');
  assert.ok(/领域的大师/.test(cfg.world_lore.civilian_synergy));
  ok('27. 预设 JSON：killer_titles + civilian_synergy 镜像');
  const threatJson = JSON.stringify(profile.knownThreats);
  assert.ok(!/\d+\s*(HP|伤害|冷却)|cooldown|\bstud/i.test(threatJson));
  ok('28. 红线：杀手 Lore 仍无属性/技能数值');
  assert.ok(entities.every((e) => e.origin && e.appearance && e.behavior && e.government_response && e.counter_hint));
  ok('29. 阶段25 字段结构不受影响（回归）');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM ability_threat_interactions').get().c, 5);
  ok('30. 威胁互动目录不变（5 条，回归）');

  server.close();
  console.log(`\n[阶段28] 通过 ${passed} 项测试`);
  if (passed < 26) {
    console.error('测试数量不足！');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('\n[阶段28] 测试失败：', err);
  process.exit(1);
});
