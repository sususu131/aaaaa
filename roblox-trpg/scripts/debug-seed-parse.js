#!/usr/bin/env node
/* 临时调试：seed.sql skills 解析（打印块头部） */
const fs = require('fs');
const path = require('path');
const seedSql = fs.readFileSync(path.join(__dirname, '..', 'database', 'seed.sql'), 'utf8');
// 修复：捕获组从 VALUES 后的第一个 ( 开始（不再让 VALUES\s*\( 吞掉首元组括号）
const insertRe = /INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+skills\b[\s\S]*?VALUES\s*(\s*\([\s\S]*?)\)\s*;/gi;
let m;
let count = 0;
const library = new Set();
while ((m = insertRe.exec(seedSql)) !== null) {
  count += 1;
  const body = m[1];
  const tupleRe = /\(\s*'((?:[^'\\]|\\.)*)'/g;
  let t;
  const names = [];
  while ((t = tupleRe.exec(body)) !== null) {
    names.push(t[1]);
    library.add(t[1].trim());
  }
  console.log(`===== INSERT块#${count} 捕获长度 ${body.length} =====`);
  console.log(`匹配技能数: ${names.length} | 前3: ${names.slice(0, 3).join(', ')}`);
}
console.log('');
console.log('总技能数:', library.size);
console.log('含 feline_instinct:', library.has('feline_instinct'));
console.log('含 fire_affinity:', library.has('fire_affinity'));
console.log('含 危险感知:', library.has('危险感知'));
console.log('含 beast_sense:', library.has('beast_sense'));
console.log('含 marksman:', library.has('marksman'));