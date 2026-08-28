#!/usr/bin/env node
/**
 * 视觉技能一致性检查（阶段34 / 第27节）：
 *   读取 data/visualSkillMappings.json 引用的全部 skill ID
 *   读取 database/seed.sql 中 Ability Library（skills INSERT）的真实技能
 *   比对：
 *     ✓ valid skills   —— 引用且已在技能库
 *     ⚠ deferred skills —— 引用但明确列为"故意保留待实现"（scripts/vision-skill-deferred.json）
 *     ✗ missing skills —— 引用、不在技能库、也不在待实现清单 → 错误
 *   存在 missing → process.exit(1)，让 CI 能直接发现。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MAPPINGS = path.join(ROOT, 'server', 'data', 'visualSkillMappings.json');
const SEED = path.join(ROOT, 'database', 'seed.sql');
const DEFERRED = path.join(ROOT, 'scripts', 'vision-skill-deferred.json');

function fail(msg) {
  console.error(`[validate-vision-skills] 错误: ${msg}`);
  process.exit(2);
}

if (!fs.existsSync(MAPPINGS)) fail(`找不到 visualSkillMappings.json: ${MAPPINGS}`);
if (!fs.existsSync(SEED)) fail(`找不到 seed.sql: ${SEED}`);

// ── 1. 收集 visualSkillMappings.json 引用的 skill ID ──
const mappings = JSON.parse(fs.readFileSync(MAPPINGS, 'utf8'));
const referenced = new Set();
for (const key of [
  'tag_to_skills',
  'weapon_to_skills',
  'archetype_to_skills',
  'style_to_skills',
  'combat_style_to_skills',
  'special_trait_to_skills',
]) {
  for (const skills of Object.values(mappings[key] || {})) {
    for (const s of skills) referenced.add(String(s).trim());
  }
}

// ── 2. 解析 seed.sql 中所有 skills INSERT 的技能名（Ability Library）──
const seedSql = fs.readFileSync(SEED, 'utf8');
const library = new Set();
// 匹配所有 INSERT ... INTO skills ... VALUES ( ... ); 块
const insertRe = /INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+skills\b[\s\S]*?VALUES\s*(\s*\([\s\S]*?)\)\s*;/gi;
let m;
while ((m = insertRe.exec(seedSql)) !== null) {
  const body = m[1];
  // 每个元组以 ( 开头；取每行第一个单引号字段（name）
  const tupleRe = /\(\s*'((?:[^'\\]|\\.)*)'/g;
  let t;
  while ((t = tupleRe.exec(body)) !== null) {
    const name = t[1].replace(/\\'/g, "'");
    library.add(name.trim());
  }
}
if (library.size === 0) fail('seed.sql 中未解析到任何技能（解析正则可能需要更新）');

// ── 3. 待实现清单（故意保留）──
let deferred = new Set();
if (fs.existsSync(DEFERRED)) {
  const raw = JSON.parse(fs.readFileSync(DEFERRED, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.skills || [];
  deferred = new Set(list.map((s) => (typeof s === 'string' ? s : s.id)).filter(Boolean));
}

// ── 4. 比对 ──
const valid = [];
const deferredFound = [];
const missing = [];
for (const id of Array.from(referenced).sort()) {
  if (library.has(id)) valid.push(id);
  else if (deferred.has(id)) deferredFound.push(id);
  else missing.push(id);
}

console.log('===== Vision 技能一致性检查 =====');
console.log(`引用技能总数: ${referenced.size}`);
console.log(`✓ valid skills  : ${valid.length}  ${valid.join(', ')}`);
console.log(`⚠ deferred skills: ${deferredFound.length}  ${deferredFound.join(', ')}`);
console.log(`✗ missing skills : ${missing.length}  ${missing.join(', ')}`);

if (missing.length > 0) {
  console.error('\n存在映射引用但 Ability Library 缺失且未列入待实现清单的技能。');
  console.error('处理方式：将其加入 database/seed.sql（INITIAL_AVATAR），或加入 scripts/vision-skill-deferred.json（明确为待实现）。');
  process.exit(1);
}
console.log('\n✓ 通过：所有引用的技能要么已在技能库，要么已明确列为待实现。');
process.exit(0);
