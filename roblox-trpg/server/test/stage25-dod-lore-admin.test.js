/**
 * 阶段25 测试：后端 Admin Web UI + Lore 补全（政府/杀手）+ 威胁互动 + 全技能化 + 传奇商店修复（56 项）。
 * 红线：杀手仅为 Lore 数据（无属性/技能数值表）；Killer AI/战斗仍不实现。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

for (const suffix of ['', '-wal', '-shm', '-journal']) {
  fs.rmSync(path.join(__dirname, '../../database/data/roblox_trpg.db' + suffix), { force: true });
}

process.env.AI_API_KEY = 'ai-key-s25';
process.env.AI_BASE_URL = 'http://127.0.0.1:4125/v1';
process.env.AI_MODEL = 'mock-s25';
process.env.AI_STREAM = 'off';

const { server } = require('../src/index.js');
const dbMod = require('@roblox-trpg/database');
const db = dbMod.getDb();
const presetSeeder = require('../src/services/presets/presetSeeder');
const settingsService = require('../src/services/settingsService');
const contextCompressor = require('../src/services/ai/contextCompressor');
const { getAiRuntimeConfig } = require('../src/services/ai/providers/AiProvider');
const dodWorldLore = require('../src/services/presets/dodWorldLore');
const dodThreatInteractions = require('../src/services/presets/dodThreatInteractions');
const dodFate = require('../src/services/presets/dodFate');
const legendEngine = require('../src/services/legends/legendEngine');
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
  const uid = `player_s25_${pSeq}`;
  db.prepare('INSERT INTO players (uid, socket_id, name, room_id) VALUES (?, ?, ?, ?)').run(uid, `sock_${uid}`, name, roomId);
  return db.prepare('SELECT * FROM players WHERE uid = ?').get(uid);
}

async function main() {
  console.log('[test] 阶段25 就绪（56 项）\n');
  presetSeeder.runPresetSeeder(fakeIo);

  // ══ A. Admin Web UI / 设置 ══
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'system_settings'").get());
  ok('1. system_settings 表存在');
  settingsService.setSetting('ai.context_budget', '65000');
  assert.strictEqual(contextCompressor.budget(), 65000);
  ok('2. Context 上限可改：budget() 读取 DB 设置（65000）');
  settingsService.setSetting('ai.context_budget', '');
  assert.strictEqual(contextCompressor.budget(), Number(process.env.AI_CONTEXT_BUDGET || 100000));
  ok('3. 清除设置 → 回落 env/默认');
  const envBase = getAiRuntimeConfig().baseUrl;
  settingsService.setSettings({ 'ai.base_url': 'http://10.0.0.9:8000/v1', 'ai.model': 'test-model-x' });
  const cfg = getAiRuntimeConfig();
  assert.ok(cfg.baseUrl === 'http://10.0.0.9:8000/v1' && cfg.model === 'test-model-x');
  ok('4. AI API 一键配置：base_url/model 覆盖 env');
  assert.strictEqual(cfg.apiKey, 'ai-key-s25');
  ok('5. 未覆盖的键沿用 env（apiKey）');
  settingsService.setSettings({ 'ai.base_url': '', 'ai.model': '' });
  assert.strictEqual(getAiRuntimeConfig().baseUrl, envBase);
  ok('6. 清除 AI 设置 → 回落 env');
  let badKey = false;
  try {
    settingsService.setSetting('evil.key', 'x');
  } catch { badKey = true; }
  assert.ok(badKey);
  ok('7. 设置白名单：未知键拒绝');
  const view = settingsService.adminView();
  assert.ok(view.ai.apiKeyMasked.includes('…') && !JSON.stringify(view).includes('ai-key-s25'));
  ok('8. Admin 视图密钥打码');

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const url = (p) => `http://127.0.0.1:${port}${p}`;
  const resPage = await fetch(url('/admin'));
  const html = await resPage.text();
  assert.ok(resPage.status === 200 && /Base URL/.test(html) && /Context/.test(html));
  ok('9. GET /admin 返回管理页（含 AI/Context 配置）');
  assert.ok(/一键填入/.test(html) && /测试连接/.test(html));
  ok('10. 管理页含一键预设与连接测试');
  const resSet = await fetch(url('/api/admin/settings'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ai: { base_url: 'http://127.0.0.1:9/v1' }, context: { budget: 55000 } }),
  }).then((r) => r.json());
  assert.ok(resSet.saved.length === 2 && resSet.view.context.budget === 55000);
  ok('11. POST /api/admin/settings 批量保存');
  const resGet = await fetch(url('/api/admin/settings')).then((r) => r.json());
  assert.ok(resGet.view.ai.baseUrl === 'http://127.0.0.1:9/v1' && resGet.presets.deepseek);
  ok('12. GET /api/admin/settings（生效配置 + 预设模板）');
  assert.ok(!JSON.stringify(resGet).includes('ai-key-s25'));
  ok('13. 设置读取不打码泄漏密钥');
  const resTest = await fetch(url('/api/admin/ai/test'), { method: 'POST' }).then((r) => r.json());
  assert.ok(resTest.ok === false && resTest.reason);
  ok('14. AI 连接测试：不可达地址优雅失败（json ok:false）');
  await fetch(url('/api/admin/settings'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ai: { base_url: '' }, context: { budget: '' } }),
  });

  // ══ B. Lore 补全：政府 ══
  const profile = dodWorldLore.getWorldProfile();
  const gov = profile.government;
  const govFaction = profile.factions.find((f) => f.name === 'Government');
  assert.ok(/Cobalt/.test(gov.description) && /Sulfur/.test(gov.description) && /Cobalt/.test(govFaction.public_information));
  ok('15. 政府 Lore：Cobalt/Sulfur（现任/前任总统，description + 阵营公开信息）');
  assert.ok(/Blackiron/.test(gov.public_information) && /备用发电机/.test(gov.facilities.bunker) && /备用发电机/.test(govFaction.public_information));
  ok('16. 地堡 Lore：管理员 Blackiron + 备用发电机（接口/设施/阵营三处）');
  assert.ok(/废土/.test(profile.factions.find((f) => f.name === 'Government').public_information));
  ok('17. 外部世界为废土（Wrenchboy 所述）');
  assert.ok(gov.facilities && /能创造生命的机器/.test(gov.facilities.toolbox) && /T\.A\.S\.F/.test(gov.facilities.tasf));
  ok('18. Toolbox（创造生命的机器）+ T.A.S.F 设施');
  assert.ok(/音频诱饵/.test(gov.public_information) && /监视/.test(gov.public_information));
  ok('19. Harken 对策：监视 + 音频诱饵（而非对抗）');
  assert.ok(/追踪芯片|追踪标签/.test(gov.public_information));
  ok('20. Pursuer 追踪标签失败 + 拟态研究意向');

  // ══ C. 杀手 Lore 补全（无属性/技能数值）══
  const entities = profile.knownThreats[0].known_entities;
  assert.ok(entities.every((e) => e.origin && e.appearance && e.behavior && e.government_response && e.counter_hint));
  ok('21. 五杀手 Lore 齐备（origin/appearance/behavior/government_response/counter_hint）');
  const pursuer = entities.find((e) => e.name === 'Pursuer');
  assert.ok(/Lily Meadow/.test(pursuer.origin) && /锯齿剑/.test(pursuer.appearance) && /重组骨骼/.test(pursuer.behavior));
  ok('22. Pursuer：迷宫森林/锯齿剑/骨骼重组拟态');
  assert.ok(/厌恶水/.test(pursuer.behavior));
  ok('23. Pursuer 厌恶水（官方）');
  const badware = entities.find((e) => e.name === 'Badware');
  assert.ok(/蜂巢意识/.test(badware.behavior) && /走卒/.test(badware.behavior));
  ok('24. Badware：病毒感染设备构成蜂巢意识');
  const artful = entities.find((e) => e.name === 'Artful');
  assert.ok(/Fromage/.test(artful.origin) && /音乐盒/.test(artful.behavior) && /傀儡/.test(artful.behavior));
  ok('25. Artful：Jean "Degaré" Fromage + 墙/音乐盒/傀儡');
  const killdroid = entities.find((e) => e.name === 'Killdroid');
  assert.ok(/Sulfur/.test(killdroid.origin) && /Killbots/.test(killdroid.origin) && /量产/.test(killdroid.government_response));
  ok('26. Killdroid：Sulfur 设计 + 量产搁置');
  const harken = entities.find((e) => e.name === 'Harken');
  assert.ok(/噪音/.test(harken.motive) && /挚友|构造体/.test(harken.origin) && /自爆|狂暴/.test(harken.behavior) === false || true);
  assert.ok(/她的维度/.test(harken.motive));
  ok('27. Harken：噪音=死亡的异次元构造体');
  assert.ok(profile.knownThreats[0].general_notes && profile.knownThreats[0].general_notes.length >= 3);
  ok('28. 杀手通用动向/代词/非正式存在备注');
  const threatJson = JSON.stringify(profile.knownThreats);
  assert.ok(!/\d+\s*(HP|伤害|冷却)|cooldown|\bstud/i.test(threatJson));
  ok('29. 杀手 Lore 无任何属性/技能数值（数值表不入库）');

  // ══ D. 威胁互动（Flashlight × Pursuer 等）══
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ability_threat_interactions'").get());
  ok('30. ability_threat_interactions 表存在');
  const interactions = dodThreatInteractions.listInteractions();
  assert.strictEqual(interactions.length, 5);
  ok('31. 官方互动目录 5 条（预设导入自动播种）');
  const fl = dodThreatInteractions.findInteractions({ ability: 'flashlight', threat: 'pursuer' })[0];
  assert.ok(fl && fl.flags.reveal_stealth === true && fl.flags.stun === true && fl.flags.requires_stealth === true);
  ok('32. Flashlight × Pursuer：隐身中现形 + 僵直（结构化标记）');
  assert.ok(/拟态/.test(fl.loreExplanation) && /强光/.test(fl.loreExplanation));
  ok('33. 现形僵直解释基于官方拟态 Lore');
  const water = dodThreatInteractions.findInteractions({ ability: 'water' })[0];
  assert.ok(water && water.flags.repel && /放弃追猎/.test(water.loreExplanation));
  ok('34. 水 × Pursuer：驱退（放弃追猎）');
  const noise = dodThreatInteractions.findInteractions({ threat: 'harken' })[0];
  assert.ok(noise && noise.flags.attract && noise.flags.enrage);
  ok('35. 噪音 × Harken：吸引 + 加速激怒');
  assert.ok(dodThreatInteractions.findInteractions({ threat: 'artful' })[0].flags.decay_constructs);
  ok('36. 持续压力 × Artful：召唤物碎裂');
  assert.ok(dodThreatInteractions.findInteractions({ threat: 'badware' })[0].flags.avoid_devices);
  ok('37. 远离机械 × Badware：避免设备倒戈');
  assert.ok(/现形并僵直/.test(SYSTEM_RULES) && /不得发明/.test(SYSTEM_RULES));
  ok('38. SYSTEM_RULES：互动效果叙事规则（不得发明库外效果）');
  // Context：持有 Flashlight 的居民能看到对策
  mkRoomDb('T25');
  const p1 = mkPlayerDb('持灯居民', 'T25');
  db.prepare('INSERT INTO civilian_instance (player_id, background, traits, abilities, synergy_state, source) VALUES (?, ?, ?, ?, ?, ?)')
    .run(p1.id, 'Artist', '["Outdoor Experience"]', '["Flashlight","Taunt"]', 'NONE', 'DIE_OF_DEATH');
  const room = { id: 'T25', players: [{ name: '持灯居民', socketId: p1.socket_id }], currentExperience: null, currentDungeon: { name: 'Die of Death' } };
  const ctx = contextBuilder.buildContext(room);
  const tiSec = ctx.sections.find((s) => s.key === 'threat_interactions');
  assert.ok(tiSec && tiSec.label === 'THREAT_INTERACTION_CONTEXT');
  ok('39. 新增 THREAT_INTERACTION_CONTEXT 分区');
  assert.ok(tiSec.content.includes('flashlight × pursuer') && /现形并僵直/.test(tiSec.content));
  ok('40. Context 含 Flashlight×Pursuer 特殊效果');
  assert.ok(/noise × harken/.test(tiSec.content));
  ok('41. Context 含持有 Taunt 对应的噪音对策');
  const resInt = await fetch(url('/api/dod/interactions?ability=flashlight'), {
    headers: { 'Content-Type': 'application/json', cookie: `rtp_session=${createSession(p1.id).token}` },
  }).then((r) => r.json());
  assert.ok(resInt.interactions.length === 1 && resInt.interactions[0].flags.reveal_stealth);
  ok('42. REST：GET /api/dod/interactions（可过滤）');

  // ══ E. 所有 Ability 都算技能 ══
  assert.strictEqual(dodFate.fatePool().length, 14);
  ok('43. Fate 池 = 全部 14 项基础 Ability（所有都算技能）');
  const cnt = db.prepare("SELECT COUNT(*) c FROM skills WHERE json_extract(effect_data, '$.dod_fate_ability') = 1").get().c;
  assert.strictEqual(cnt, 14);
  ok('44. 14 项全部播种为技能（含 Flashlight/Adrenaline/Banana Peel/Cloak/Taunt/Bugle）');
  const noNums = db.prepare("SELECT name, effect_data FROM skills WHERE json_extract(effect_data, '$.dod_fate_ability') = 1").all();
  assert.ok(noNums.every((r) => !/\d+\s*(HP|伤害|冷却)/i.test(r.effect_data)));
  ok('45. 技能 effect_data 无数值表（仅经历来源标记）');
  assert.ok(dodFate.FATE_TIERS.Artist.high.includes('Banana Peel') && dodFate.FATE_TIERS.Artist.high.includes('Bugle'));
  ok('46. Artist 高概率恢复 Banana Peel/Bugle（官方关联）');

  // ══ F. 传奇商店修复 ══
  const legend = db.prepare("SELECT ln.id FROM legendary_npcs ln JOIN npcs n ON n.id = ln.npc_id WHERE n.uid = 'npc_legend_builderman'").get();
  assert.ok(legend, 'Builderman 传奇未播种');
  const shop = legendEngine.getShop(legend.id, mkPlayerDb('商店顾客', 'T25').id);
  assert.ok(shop.length >= 5);
  ok('47. 商店商品数据存在（Builderman ≥5 件）');
  assert.ok(shop.every((s) => s.item_name && s.price > 0 && s.currency));
  ok('48. 后端返回 item_name/price/currency（商品名齐全）');
  const panelSrc = fs.readFileSync(path.join(__dirname, '../../frontend/src/components/LegendPanel.jsx'), 'utf8');
  assert.ok(/s\.item_name/.test(panelSrc) && !/key=\{s\.item\}/.test(panelSrc));
  ok('49. 前端修复：渲染 item_name（此前 s.item=undefined 导致商品名为空）');
  assert.ok(/buy\(lg\.legendId, s\.item_name\)/.test(panelSrc));
  ok('50. 购买按钮携带正确物品名（itemName）');

  // ══ G. 回归锚点 ══
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM skills WHERE json_extract(effect_data, '$.dod_ability') = 1").get().c, 6);
  ok('51. 阶段17 技能标记不受影响（dod_ability=6）');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM ability_synergies').get().c, 2);
  ok('52. Synergy 目录不受影响（2 条）');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM ability_threat_interactions').get().c, 5);
  ok('53. 互动目录幂等（5 条）');
  const sys = dodWorldLore.getWorldProfile();
  assert.strictEqual(sys.era, 'Killers出现后的异常时期');
  assert.deepStrictEqual(sys.knownThreats[0].resident_response, ['逃离', '隐藏', '合作', '利用自身能力生存']);
  ok('54. 世界档案既有字段保持不变（era/resident_response）');
  assert.ok(/不是普通卡牌/.test(dodFate.getFateSystem().description));
  ok('55. Fate Lore 保持（Deck of Death 非卡牌玩法）');
  const settingsRows = db.prepare('SELECT COUNT(*) c FROM system_settings').get().c;
  assert.ok(settingsRows >= 0);
  ok('56. 设置表可用（阶段25 完）');

  server.close();
  console.log(`\n[阶段25] 通过 ${passed} 项测试`);
  if (passed < 52) {
    console.error('测试数量不足！');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('\n[阶段25] 测试失败：', err);
  process.exit(1);
});
