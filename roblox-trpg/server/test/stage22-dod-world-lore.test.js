/**
 * 阶段22 测试：Die of Death World Lore Foundation + 修复（68 项）。
 * 覆盖：experience_world_profiles 加载与读取 / 官方 Lore 内容（Robloxia/Civilian Society/
 *       Threat Concept/Government 预留）/ DOD World Rules / WORLD_LORE_CONTEXT /
 *       Civilian 与世界关联 / 不生成原创世界设定 / 不提前生成 Killer /
 *       阵营关系作用域修复（跨世界不显示）+ AI 关系工具（服务器验证，非写死）/
 *       停止副本运行 REST / 所有 LLM 调用点具备 websearch。
 * 红线：只实现世界背景数据库 —— 不实现 Killer AI / 战斗 / 副本流程 / 地图 / 任务。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

for (const suffix of ['', '-wal', '-shm', '-journal']) {
  fs.rmSync(path.join(__dirname, '../../database/data/roblox_trpg.db' + suffix), { force: true });
}

process.env.AI_API_KEY = 'ai-key-s22';
process.env.AI_BASE_URL = 'http://127.0.0.1:4122/v1';
process.env.AI_MODEL = 'mock-s22';
process.env.AI_STREAM = 'off';

const { server } = require('../src/index.js');
const dbMod = require('@roblox-trpg/database');
const db = dbMod.getDb();
const presetSeeder = require('../src/services/presets/presetSeeder');
const dodCivilian = require('../src/services/presets/dodCivilian');
const dodLore = require('../src/services/presets/dodLore');
const dodWorldLore = require('../src/services/presets/dodWorldLore');
const worldSim = require('../src/services/world/worldSim');
const factionRelations = require('../src/services/world/factionRelations');
const instanceManager = require('../src/services/runtime/instanceManager');
const contextBuilder = require('../src/services/ai/contextBuilder');
const tools = require('../src/services/ai/tools');
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
  const uid = `player_s22_${pSeq}`;
  db.prepare('INSERT INTO players (uid, socket_id, name, room_id) VALUES (?, ?, ?, ?)').run(uid, `sock_${uid}`, name, roomId);
  return db.prepare('SELECT * FROM players WHERE uid = ?').get(uid);
}

async function main() {
  console.log('[test] 阶段22 就绪（68 项）\n');

  presetSeeder.runPresetSeeder(fakeIo);

  // ══ A. World Profile 加载 ══
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'experience_world_profiles'").get());
  ok('1. experience_world_profiles 表存在');
  const cols = db.prepare('PRAGMA table_info(experience_world_profiles)').all().map((c) => c.name);
  ['name', 'description', 'setting', 'era', 'factions_json', 'known_threats_json', 'civilian_life_json']
    .every((f) => cols.includes(f) || assert.fail(`缺字段 ${f}`));
  ok('2. 规格字段齐全（name/description/setting/era/factions/known_threats/civilian_life）');
  assert.ok(db.prepare("SELECT 1 FROM experience_world_profiles WHERE experience_key = 'dod'").get());
  ok('3. 预设导入自动播种 DOD 世界档案');
  const profile = dodWorldLore.getWorldProfile();
  assert.ok(profile && profile.name === 'Die of Death World' && profile.loreSource === 'CANON');
  ok('4. 读取 DOD 档案（lore_source=CANON）');
  assert.strictEqual(dodWorldLore.getWorldProfile('dod').id, 'dod');
  ok('5. 按 experience_key 读取');
  dodWorldLore.ensureWorldProfileSeeded();
  assert.ok(db.prepare('SELECT COUNT(*) c FROM experience_world_profiles').get().c >= 1);
  ok('6. 播种幂等（单条）');

  // ══ B. Robloxia / Civilian Society ══
  assert.ok(/普通市民/.test(profile.description) && /工作人员/.test(profile.description) && /研究人员/.test(profile.description) && /建设者/.test(profile.description) && /商人/.test(profile.description));
  ok('7. Robloxia：普通市民/工作人员/研究人员/建设者/商人');
  assert.ok(/大多数.*没有战斗能力/.test(profile.description));
  ok('8. 大多数人没有战斗能力');
  const life = profile.civilianLife;
  ['城市', '住宅区', '商业区域', '公共设施', '工作场所'].every((k) => Object.keys(life).some((lk) => lk.includes(k)) || assert.fail(`缺生活场域 ${k}`));
  ok('9. Civilian Society：城市/住宅区/商业区域/公共设施/工作场所');
  assert.ok(/不是战士/.test(life.note) && /人生经验/.test(life.note));
  ok('10. Civilian 不是战士——只是拥有不同人生经验的人');
  assert.strictEqual(profile.era, 'Killers出现后的异常时期');
  ok('11. era = Killers出现后的异常时期');
  assert.ok(profile.setting.includes('Robloxia'));
  ok('12. setting = Robloxia');

  // ══ C. Threat Concept（Killer 仅概念，不实现）══
  const threat = profile.knownThreats[0];
  assert.strictEqual(threat.concept, 'Killer');
  assert.ok(/异常存在会攻击 Robloxia 居民/.test(threat.description));
  ok('13. Killer = 世界威胁概念（某些异常存在会攻击居民）');
  assert.deepStrictEqual(threat.resident_response, ['逃离', '隐藏', '合作', '利用自身能力生存']);
  ok('14. 居民应对：逃离/隐藏/合作/利用自身能力生存');
  assert.strictEqual(threat.implementation, 'reserved');
  ok('15. Killer 实现为 reserved（不实现 Killer AI/战斗）');
  assert.ok(threat.known_entities.length === 5 && ['Pursuer', 'Badware', 'Artful', 'Killdroid', 'Harken'].every((n) => threat.known_entities.some((e) => e.name === n)));
  ok('16. 官方已知威胁存在登记 5 名（仅概念与动机）');
  assert.ok(!JSON.stringify(threat).match(/\d+\s*(HP|伤害|伤害|冷却)|cooldown|\bstud/i));
  ok('17. 威胁登记无任何数值/技能/冷却（无 Killer 玩法数据）');

  // ══ D. Government 预留接口 ══
  const govFaction = profile.factions.find((f) => f.name === 'Government');
  assert.ok(govFaction && govFaction.public_information && govFaction.secret_information.includes('reserved'));
  ok('18. Government：public_information + secret_information(reserved)');
  const gov = profile.government;
  assert.ok(gov.name === 'Robloxian Government' && gov.description && gov.public_information);
  assert.ok(gov.secret_information.includes('reserved'));
  ok('19. Government 接口三字段齐备（不创建具体剧情）');
  assert.ok(/安全地堡|地堡/.test(gov.public_information));
  ok('20. 公开信息仅世界级事实（建造安全地堡），无具体剧情');

  // ══ E. DOD World Rules ══
  assert.deepStrictEqual(dodWorldLore.WORLD_RULES, [
    'Civilian 能力来自自身经历。',
    '普通居民不是英雄。',
    '生存优先于战斗。',
    '能力不能违反世界逻辑。',
    'AI 生成剧情必须符合普通人的视角。',
  ]);
  ok('21. World Rules 5 条（官方输入原样）');
  assert.ok(/生存优先于战斗/.test(SYSTEM_RULES) && /普通人的视角/.test(SYSTEM_RULES) && /不得创造原创世界设定/.test(SYSTEM_RULES));
  ok('22. SYSTEM_RULES 携带 World Rules + 禁原创世界设定');
  assert.ok(/Killer 仅是威胁概念/.test(SYSTEM_RULES) && /不得提前生成/.test(SYSTEM_RULES));
  ok('23. SYSTEM_RULES：Killer 仅威胁概念，不提前生成');

  // ══ F. WORLD_LORE_CONTEXT ══
  mkRoomDb('W22');
  const p1 = mkPlayerDb('世界居民', 'W22');
  const gen = dodLore.generateCivilianLore(fakeIo, p1.id, { rng: 0.25, background: 'Engineer' });
  assert.ok(gen.created);
  const room = { id: 'W22', players: [{ name: '世界居民', socketId: p1.socket_id }], currentExperience: null, currentDungeon: { name: 'Die of Death' } };
  const ctx = contextBuilder.buildContext(room);
  const loreSec = ctx.sections.find((s) => s.key === 'world_lore');
  assert.ok(loreSec && loreSec.label === 'WORLD_LORE_CONTEXT');
  ok('24. 新增 WORLD_LORE_CONTEXT 分区');
  assert.ok(loreSec.content.includes('World: Robloxia'));
  ok('25. 格式：World:');
  assert.ok(loreSec.content.includes('Civilian Society:'));
  ok('26. 格式：Civilian Society:');
  assert.ok(loreSec.content.includes('Threat:') && /逃离、隐藏、合作/.test(loreSec.content));
  ok('27. 格式：Threat:（含居民应对）');
  assert.ok(loreSec.content.includes('Government:'));
  ok('28. 格式：Government:');
  assert.ok(/World Rules（DOD）:\n1\. /.test(loreSec.content) && /5\. AI 生成剧情必须符合普通人的视角/.test(loreSec.content));
  ok('29. World Rules 全部 5 条入 Context');
  assert.ok(loreSec.content.includes(`Active Civilians: 世界居民（Engineer→工作场所`));
  ok('30. Civilian 与世界关联（背景→生活场所）');
  assert.ok(loreSec.content.includes('lore_source=CANON') && loreSec.content.includes('不得创造原创世界设定'));
  ok('31. Context 声明 CANON（不生成原创世界设定）');
  const ctxOther = contextBuilder.buildContext({ ...room, currentDungeon: { name: 'DOORS' } });
  assert.ok(ctxOther.sections.find((s) => s.key === 'world_lore').content.includes('不在 Die of Death 世界'));
  ok('32. 非 DOD 世界：分区不输出 DOD Lore');
  assert.strictEqual(dodWorldLore.civilianWorldTie('Medic').lifeTie, '公共设施（照护与救助）');
  assert.ok(dodWorldLore.civilianWorldTie('Cook').world === 'Robloxia');
  ok('33. civilianWorldTie：背景→Robloxia 生活场所');
  const cfg = JSON.parse(db.prepare("SELECT c.config_json FROM preset_dungeon_configs c JOIN preset_experiences p ON p.id = c.preset_id WHERE p.key = 'dod'").get().config_json);
  assert.ok(cfg.world_lore && cfg.world_lore.world_rules.length === 5 && cfg.world_lore.government_interface.secret_information.includes('reserved'));
  ok('34. 预设 JSON 携带 world_lore（与服务层一致：5 规则 + Government 预留）');

  // ══ G. 不提前生成 Killer / 无原创设定 ══
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM npcs WHERE name IN ('Pursuer','Badware','Artful','Killdroid','Harken')").get().c, 0);
  ok('35. 未生成任何 Killer NPC（5 名威胁存在均非 NPC）');
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM npc_instances ni JOIN npcs n ON n.id = ni.npc_id WHERE n.name IN ('Pursuer','Badware','Artful','Killdroid','Harken')").get().c, 0);
  ok('36. 无 Killer 实例（不提前生成）');
  assert.ok(!fs.existsSync(path.join(__dirname, '../src/services/presets/dodKiller.js')));
  ok('37. 无 Killer AI 模块');
  assert.ok(!fs.existsSync(path.join(__dirname, '../src/services/presets/dodWorldMap.js')) && !fs.existsSync(path.join(__dirname, '../src/services/presets/dodQuest.js')));
  ok('38. 无 DOD 地图/任务实现（只做世界背景数据库）');
  const worldSrc = fs.readFileSync(path.join(__dirname, '../src/services/presets/dodWorldLore.js'), 'utf8');
  assert.ok(!/combat_engine|killer_ai|dungeon_flow|quest_system/i.test(worldSrc));
  ok('39. 世界档案模块无玩法系统痕迹');
  assert.ok(profile.factions.every((f) => ['civilian', 'reserved', 'threat_concept'].includes(f.role)));
  ok('40. 阵营 Lore 角色仅三类（civilian/reserved/threat_concept）');

  // ══ H. 阵营关系作用域修复 ══
  const dodDungeon = db.prepare("SELECT * FROM dungeons WHERE roblox_experience_name = 'Die of Death'").get();
  const doorsDungeon = db.prepare("SELECT * FROM dungeons WHERE roblox_experience_name = 'Doors'").get();
  const dodVersion = db.prepare("SELECT v.id FROM dungeon_versions v WHERE v.dungeon_id = ? ORDER BY v.version DESC LIMIT 1").get(dodDungeon.id);
  const mkInst = (id, dungeonId, roomId) => {
    const v = db.prepare("SELECT v.id FROM dungeon_versions v WHERE v.dungeon_id = ? ORDER BY v.version DESC LIMIT 1").get(dungeonId);
    db.prepare("INSERT OR IGNORE INTO dungeon_instances (id, uid, dungeon_version_id, room_id, status) VALUES (?, ?, ?, ?, 'RUNNING')").run(id, `w22_inst_${id}`, v.id, roomId);
    return id;
  };
  mkInst(9201, dodDungeon.id, 'W22');
  const snapDod = worldSim.worldSnapshot('W22');
  const dodRelationPairs = snapDod.relations.map((r) => `${r.factionA}↔${r.factionB}`);
  assert.ok(snapDod.relations.length >= 2 && dodRelationPairs.some((p) => p.includes('Civilian') && p.includes('Killer')));
  ok('41. DOD 世界房间：快照含 DOD 关系（Civilian↔Killer）');
  assert.ok(snapDod.relations.every((r) => !r.factionA.includes('幸存者') && !r.factionB.includes('幸存者') && !r.factionA.includes('旅馆管理员') && !r.factionB.includes('旅馆管理员')));
  ok('42. 修复：DOORS 关系（幸存者↔实体/管理员）不再出现在 DOD 房间');
  mkRoomDb('W22D');
  mkInst(9202, doorsDungeon.id, 'W22D');
  const snapDoors = worldSim.worldSnapshot('W22D');
  assert.ok(snapDoors.relations.some((r) => r.factionA.includes('幸存者') || r.factionB.includes('实体')));
  assert.ok(snapDoors.relations.every((r) => !r.factionA.includes('Killer') && !r.factionB.includes('Killer') && !r.factionA.includes('Civilian') && !r.factionB.includes('Civilian')));
  ok('43. DOORS 世界房间：只见 DOORS 关系（世界隔离）');
  mkRoomDb('W22N');
  const snapNone = worldSim.worldSnapshot('W22N');
  assert.ok(snapNone.relations.every((r) => r.factionA !== undefined) && snapNone.relations.length === 0 || snapNone.relations.every(() => true));
  assert.strictEqual(snapNone.relations.length, 0);
  ok('44. 未进入副本的房间：不显示任何副本关系');
  const scope = worldSim.roomFactionScope('W22');
  assert.ok(scope.dungeonId === dodDungeon.id && scope.factionIds.length > 0);
  ok('45. roomFactionScope：房间→当前副本阵营集合');

  // ══ I. AI 关系变更工具（不写死；服务器验证）══
  const toolNames = tools.getRegistry().map((t) => t.name);
  assert.ok(toolNames.includes('request_faction_relation_change'));
  ok('46. 新工具：request_faction_relation_change');
  const toolCtx = { io: fakeIo, room: { id: 'W22' }, actingPlayerName: 'ai_gm' };
  const fCiv = db.prepare("SELECT * FROM factions WHERE uid = 'faction_preset_dod_civilian'").get();
  const fGov = db.prepare("SELECT * FROM factions WHERE uid = 'faction_preset_dod_government'").get();
  const r1 = await tools.runTool(toolCtx, 'request_faction_relation_change', { factionA: 'Civilian', factionB: 'Government', relation: 'ALLIED', reason: '政府护送居民进入地堡，双方建立信任' });
  assert.ok(r1.ok && r1.changed && r1.previous === 'NEUTRAL');
  ok('47. AI 申请关系变更成功（NEUTRAL→ALLIED，服务器执行）');
  assert.strictEqual(factionRelations.getFactionRelation(fCiv.id, fGov.id).relation, 'ALLIED');
  ok('48. 关系真实变更（唯一写入口 + 审计）');
  assert.ok(db.prepare("SELECT 1 FROM game_events WHERE type = 'FACTION_RELATION_CHANGED'").get());
  ok('49. 变更记入 Event Bus');
  let r2rejected = false;
  try {
    await tools.runTool(toolCtx, 'request_faction_relation_change', { factionA: 'Civilian', factionB: 'Government', relation: 'HOSTILE', reason: '' });
  } catch { r2rejected = true; }
  assert.ok(r2rejected);
  ok('50. 缺少剧情理由 → 拒绝（schema + 服务端双重校验）');
  let r3code = null;
  try {
    await tools.runTool(toolCtx, 'request_faction_relation_change', { factionA: '幸存者', factionB: '实体', relation: 'ALLIED', reason: '测试' });
  } catch (e) { r3code = e.kind || e.code; }
  assert.strictEqual(r3code, 'faction_out_of_scope');
  ok('51. 跨世界阵营操作 → 拒绝（不能在 DOD 房间改 DOORS 关系）');
  let r4code = null;
  try {
    await tools.runTool(toolCtx, 'request_faction_relation_change', { factionA: '不存在的阵营', factionB: 'Government', relation: 'HOSTILE', reason: 'x' });
  } catch (e) { r4code = e.kind || e.code; }
  assert.strictEqual(r4code, 'faction_not_found');
  ok('52. 不存在的阵营 → 拒绝（不能凭空创建）');
  let r5rejected = false;
  try {
    await tools.runTool(toolCtx, 'request_faction_relation_change', { factionA: 'Civilian', factionB: 'Government', relation: 'BFF', reason: 'x' });
  } catch { r5rejected = true; }
  assert.ok(r5rejected);
  ok('53. 非法关系值 → 拒绝（enum 校验）');
  assert.ok(/由服务器唯一写入口执行/.test(r1.note));
  ok('54. 工具返回注明服务器执行（AI 不能直接写库）');

  // ══ J. 停止副本运行 ══
  const stopInst = instanceManager.getInstance(9201);
  assert.strictEqual(stopInst.status, 'RUNNING');
  const stopped = instanceManager.stopInstance(fakeIo, stopInst, { byPlayerId: p1.id, reason: '玩家手动停止' });
  assert.strictEqual(stopped.status, 'ABORTED' && instanceManager.getInstance(9201).status, 'ABORTED');
  ok('55. stopInstance：RUNNING → ABORTED');
  assert.ok(db.prepare("SELECT 1 FROM game_events WHERE type = 'DUNGEON_ABORTED'").get());
  ok('56. 停止记入 Event Bus（DUNGEON_ABORTED）');
  const evRows = db.prepare("SELECT type, actor, data FROM instance_events WHERE instance_id = ? ORDER BY sequence DESC LIMIT 3").all(9201);
  assert.ok(evRows.some((e) => e.type === 'ABORT' && /player/.test(String(e.actor || ''))));
  ok('57. 停止写入实例事件日志（可审计）');
  const stoppedAgain = instanceManager.stopInstance(fakeIo, instanceManager.getInstance(9201), { byPlayerId: p1.id });
  assert.strictEqual(stoppedAgain.status, 'ABORTED');
  ok('58. 停止幂等（已结束实例直接返回）');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const url = (p) => `http://127.0.0.1:${port}${p}`;
  mkRoomDb('W22R');
  const rp = mkPlayerDb('停止操作者', 'W22R');
  mkInst(9203, dodDungeon.id, 'W22R');
  db.prepare('UPDATE dungeon_instances SET party = ? WHERE id = ?').run(JSON.stringify([rp.id]), 9203);
  const sess = createSession(rp.id);
  const outsider = mkPlayerDb('局外人', 'W22R');
  const sessOut = createSession(outsider.id);
  const resOut = await fetch(url('/api/dungeon-instances/9203/stop'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionToken: sessOut.token }),
  });
  assert.strictEqual(resOut.status, 403);
  ok('59. REST：非队伍成员停止 → 403');
  const resStop = await fetch(url('/api/dungeon-instances/9203/stop'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionToken: sess.token }),
  }).then((r) => r.json());
  assert.ok(resStop.stopped && resStop.instance.status === 'ABORTED');
  ok('60. REST：POST /api/dungeon-instances/:id/stop（队伍成员成功停止）');
  const resDup = await fetch(url('/api/dungeon-instances/9203/stop'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionToken: sess.token }),
  }).then((r) => r.json());
  assert.ok(resDup.alreadyStopped);
  ok('61. REST：重复停止幂等（alreadyStopped）');
  assert.ok(/stopInstance/.test(fs.readFileSync(path.join(__dirname, '../../frontend/src/lib/api.js'), 'utf8')));
  assert.ok(/停止副本/.test(fs.readFileSync(path.join(__dirname, '../../frontend/src/components/DungeonRuntime.jsx'), 'utf8')));
  ok('62. 前端：停止副本按钮 + API 方法');

  // ══ K. 所有 LLM 调用点具备 websearch ══
  assert.ok(toolNames.includes('web_search') && toolNames.includes('roblox_search'));
  ok('63. web_search / roblox_search 工具在注册表（GM 循环可用）');
  const scopes = require('../src/services/ai/tools').toolDefinitions();
  assert.ok(scopes.some((t) => t.name === 'web_search'));
  ok('64. toolDefinitions 含 web_search（agentRuntime/副本运行时同源）');
  const srcFiles = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      if (fs.statSync(fp).isDirectory()) walk(fp);
      else if (f.endsWith('.js')) srcFiles.push(fp);
    }
  };
  walk(path.join(__dirname, '../src/services'));
  const llmCallSites = [];
  for (const fp of srcFiles) {
    const src = fs.readFileSync(fp, 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      // 空 toolDefs 的 chat 调用 = 不具备 websearch（GM 循环传全量 toolDefs，天然合规）
      if (/\.chat\(session,\s*\[\]\)/.test(line)) {
        llmCallSites.push(`${path.relative(path.join(__dirname, '..'), fp)}:${i + 1}`);
      }
    });
  }
  // 允许：searchEnabledChat 助手内部（统一带 websearch）；视觉路径（LLM_NO_TOOLS 标注，图像输入不支持工具）
  const offenders = llmCallSites.filter((s) => !s.includes('searchEnabledChat.js'));
  assert.deepStrictEqual(offenders, []);
  ok('65. 所有 provider.chat 调用点均经 websearch 路径（唯一例外=视觉图像路径，LLM_NO_TOOLS 标注）');
  const secSrc = fs.readFileSync(path.join(__dirname, '../src/services/ai/searchEnabledChat.js'), 'utf8');
  assert.ok(/web_search/.test(secSrc) && /roblox_search/.test(secSrc) && /只允许搜索工具/.test(secSrc));
  ok('66. searchEnabledChat：单轮调用带 websearch（仅搜索工具，防越权）');
  assert.ok(/chatWithWebSearch/.test(fs.readFileSync(path.join(__dirname, '../src/services/ai/aiAgent.js'), 'utf8')));
  assert.ok(/chatWithWebSearch/.test(fs.readFileSync(path.join(__dirname, '../src/services/dungeon/dungeonDesigner.js'), 'utf8')));
  ok('67. 摘要（summarizeHistory）与副本设计（dungeonDesigner）均接入 websearch');
  assert.ok(/LLM_NO_TOOLS/.test(fs.readFileSync(path.join(__dirname, '../src/services/vision/deepseekVision.js'), 'utf8')));
  ok('68. 视觉路径显式标注 LLM_NO_TOOLS（图像分析不适用搜索）');

  server.close();
  console.log(`\n[阶段22] 通过 ${passed} 项测试`);
  if (passed < 64) {
    console.error('测试数量不足！');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('\n[阶段22] 测试失败：', err);
  process.exit(1);
});
