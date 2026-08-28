#!/usr/bin/env node
/**
 * 生成 scripts/vision-skill-deferred.json（一次性维护脚本）：
 * 收集 visualSkillMappings.json 引用但不在 seed.sql 技能库中的 skill ID，
 * 标记为"故意保留待实现"（PENDING_DESIGN），供 validate-vision-skills.js 区分真缺失。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MAPPINGS = path.join(ROOT, 'server', 'data', 'visualSkillMappings.json');
const SEED = path.join(ROOT, 'database', 'seed.sql');
const OUT = path.join(ROOT, 'scripts', 'vision-skill-deferred.json');

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
  for (const arr of Object.values(mappings[key] || {})) {
    for (const s of arr) referenced.add(String(s).trim());
  }
}

const seedSql = fs.readFileSync(SEED, 'utf8');
const library = new Set();
const insertRe = /INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+skills\b[\s\S]*?VALUES\s*(\s*\([\s\S]*?)\)\s*;/gi;
let m;
while ((m = insertRe.exec(seedSql)) !== null) {
  const tupleRe = /\(\s*'((?:[^'\\]|\\.)*)'/g;
  let t;
  while ((t = tupleRe.exec(m[1])) !== null) {
    library.add(t[1].replace(/\\'/g, "'").trim());
  }
}

const deferred = Array.from(referenced).filter((id) => !library.has(id)).sort();
const payload = {
  version: 1,
  note: '被 visualSkillMappings.json 引用但尚未加入 Ability Library 的技能；明确标记为故意保留待实现（PENDING_DESIGN），一致性检查脚本将其视为已声明、不视为错误。',
  skills: deferred,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
console.log(`已生成待实现清单 ${OUT}，技能数: ${deferred.length}`);
