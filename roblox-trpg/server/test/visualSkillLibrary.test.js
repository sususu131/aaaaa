/**
 * 阶段34 测试：Vision 技能库一致性（第28节）。
 *  - 技能存在性：beast_sense / marksman / feline_instinct / swordsmanship / archery /
 *    firearms / quick_draw / stealth / tracking / investigation 等必须存在于 Ability Library（seed.sql）
 *  - 映射正确性：cat_ears+cat_tail→feline_instinct；sword→swordsmanship；bow→archery+marksman；
 *    gun→firearms；cowboy+gun_holster→quick_draw
 *  - 关键：bow 绝不产生 swordsmanship（视觉证据分离）
 * 说明：不启动服务器/不依赖数据库文件，直接 require visualRules + 解析 seed.sql，避免环境文件锁问题。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const visualRules = require('../src/services/vision/visualRules');

let passed = 0;
const ok = (label) => {
  passed += 1;
  console.log(`  ✓ ${label}`);
};

// ── 从 seed.sql 解析 Ability Library（全部 skills INSERT 的技能名）──
const seedSql = fs.readFileSync(path.join(__dirname, '../../database/seed.sql'), 'utf8');
const library = new Set();
const insertRe = /INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+skills\b[\s\S]*?VALUES\s*(\s*\([\s\S]*?)\)\s*;/gi;
let m;
while ((m = insertRe.exec(seedSql)) !== null) {
  const tupleRe = /\(\s*'((?:[^'\\]|\\.)*)'/g;
  let t;
  while ((t = tupleRe.exec(m[1])) !== null) library.add(t[1].replace(/\\'/g, "'").trim());
}

function inLibrary(skill) {
  return library.has(skill);
}

function main() {
  console.log('[test] 阶段34 Vision 技能库一致性\n');

  // ══ A. 技能存在性（第28节 清单）══
  const mustExist = [
    'beast_sense',
    'marksman',
    'feline_instinct',
    'swordsmanship',
    'archery',
    'firearms',
    'quick_draw',
    'stealth',
    'tracking',
    'investigation',
  ];
  for (const s of mustExist) {
    assert.ok(inLibrary(s), `技能 ${s} 应存在于 Ability Library（seed.sql）`);
    ok(`${s} 存在`);
  }

  // ══ B. 映射正确性 ══
  const skills1 = visualRules.candidateSkillKeys(['cat_ears', 'cat_tail']);
  assert.ok(skills1.includes('feline_instinct'), 'cat_ears+cat_tail 应产生 feline_instinct');
  assert.ok(skills1.includes('beast_sense'), 'cat_ears+cat_tail 应产生 beast_sense');
  ok('cat_ears + cat_tail → feline_instinct + beast_sense');

  const skills2 = visualRules.candidateSkillKeys(['sword']);
  assert.ok(skills2.includes('swordsmanship'), 'sword 应产生 swordsmanship');
  ok('sword → swordsmanship');

  const skills3 = visualRules.candidateSkillKeys(['bow']);
  assert.ok(skills3.includes('archery'), 'bow 应产生 archery');
  assert.ok(skills3.includes('marksman'), 'bow 应产生 marksman（兼容旧规则）');
  ok('bow → archery + marksman');

  const skills4 = visualRules.candidateSkillKeys(['gun']);
  assert.ok(skills4.includes('firearms'), 'gun 应产生 firearms');
  ok('gun → firearms');

  const skills5 = visualRules.candidateSkillKeys(['cowboy']);
  assert.ok(skills5.includes('quick_draw'), 'cowboy 应产生 quick_draw（西部风格）');
  assert.ok(skills5.includes('gunslinger'), 'cowboy 应产生 gunslinger');
  ok('cowboy → gunslinger + quick_draw');

  // 用户规格第 28 节：cowboy + gun_holster → gunslinger / quick_draw（组合推断路径）
  const cowboyCombo = visualRules.inferArchetypes(['cowboy_hat', 'western', 'gun_holster']);
  assert.ok(cowboyCombo.includes('cowboy') && cowboyCombo.includes('gunslinger'), 'cowboy_hat+western+gun_holster 应推断 cowboy/gunslinger');
  ok('组合：cowboy_hat + western + gun_holster → cowboy / gunslinger（→ gunslinger 提供 firearms/quick_draw）');

  // 验证组合推断后的技能面（gunslinger → firearms + quick_draw）
  const cowboyAll = visualRules.candidateSkillKeys(['cowboy_hat', 'western', 'gun_holster', ...cowboyCombo]);
  assert.ok(cowboyAll.includes('quick_draw'), '西部组合最终应包含 quick_draw');
  assert.ok(cowboyAll.includes('firearms'), '西部组合最终应包含 firearms（经 gunslinger）');
  ok('西部组合最终 → quick_draw + firearms');

  // ══ C. 关键：视觉证据分离（bow 绝不产生 swordsmanship）══
  assert.ok(!skills3.includes('swordsmanship'), 'bow 不应产生 swordsmanship');
  ok('bow ≠ swordsmanship（视觉证据分离）');

  // ══ D. 组合规则（cat_ears+cat_tail+gothic_lolita → feline 原型）══
  const archetypes = visualRules.inferArchetypes(['cat_ears', 'cat_tail', 'gothic_lolita']);
  assert.ok(archetypes.includes('feline'), 'cat_ears+cat_tail+gothic_lolita 应推断出 feline');
  assert.ok(archetypes.includes('gothic') && archetypes.includes('lolita'), '组合应推断 gothic+lolita');
  ok('组合规则：cat_ears+cat_tail+gothic_lolita → feline/gothic/lolita');

  // ══ E. 属性 clamp（上限 10，下限 1）══
  const many = ['cat_ears', 'cat_tail', 'bow', 'feline', 'gothic_lolita', 'wings', 'glowing_eyes', 'third_eye', 'assassin', 'rogue', 'ranger', 'sniper_rifle'];
  const attrs = visualRules.computeAttributesFrom(many);
  for (const a of ['STR', 'DEX', 'CON', 'PER', 'INT', 'LUK']) {
    assert.ok(attrs[a] >= 1 && attrs[a] <= 10, `${a}=${attrs[a]} 应在 1..10`);
  }
  ok('属性 clamp(1..10) 生效');

  console.log(`\n[阶段34] 通过 ${passed} 项测试`);
}

main();
