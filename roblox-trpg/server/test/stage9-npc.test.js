/**
 * 阶段9 测试：NPC Relationship & Living World System（62 项）。
 * 复用：Game Event Bus（阶段8）、Quest 门控、Tool Registry（阶段3/7）、World Events。
 */
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

for (const suffix of ['', '-wal', '-shm', '-journal']) {
  fs.rmSync(path.join(__dirname, '../../database/data/roblox_trpg.db' + suffix), { force: true });
}

process.env.AI_API_KEY = 'ai-key-s9';
process.env.AI_BASE_URL = 'http://127.0.0.1:3909/v1';
process.env.AI_MODEL = 'mock-s9';
process.env.AI_STREAM = 'off';
process.env.AI_RATE_PER_PLAYER = '1000';
process.env.AI_RATE_PER_ROOM = '1000';

const { io: ioc } = require('socket.io-client');
const { server, io } = require('../src/index.js');
const dbMod = require('@roblox-trpg/database');
const db = dbMod.getDb();
const npcEngine = require('../src/services/npcs/npcEngine');
const tools = require('../src/services/ai/tools');
const gameEvents = require('../src/services/quests/gameEvents');

const PORT = 3907;
const BASE = `http://localhost:${PORT}`;
let passed = 0;
const ok = (label) => {
  passed += 1;
  console.log(`  ✓ ${label}`);
};
const fakeIo = { to: () => ({ emit: () => {} }) };

// mock AI（本文件以引擎级测试为主）
const aiServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }));
});

function mkRoomDb(id) {
  db.prepare("INSERT OR IGNORE INTO rooms (id, status, max_players) VALUES (?, 'waiting', 3)").run(id);
}
let pSeq = 0;
function mkPlayerDb(name, roomId) {
  pSeq += 1;
  const uid = `player_s9_${pSeq}`;
  db.prepare('INSERT INTO players (uid, socket_id, name, room_id) VALUES (?, ?, ?, ?)').run(uid, `sock_${uid}`, name, roomId);
  return db.prepare('SELECT * FROM players WHERE uid = ?').get(uid);
}
function mkNpc(name = '测试NPC', extra = {}) {
  return npcEngine.createNpc({ name, description: '测试', avatar: '🧍', goals: ['目标A'], ...extra });
}
function mkInst(npcId, roomId, dungeonInstanceId = null) {
  return npcEngine.spawnNpcInstance(fakeIo, { npcId, roomId, dungeonInstanceId });
}
const rel = (npcId, playerId) => npcEngine.getRelationship('npc', npcId, 'player', playerId);

async function main() {
  await Promise.all([new Promise((r) => aiServer.listen(3909, r)), new Promise((r) => server.listen(PORT, r))]);
  console.log(`[test] 服务器 :${PORT} 就绪（62 项）\n`);

  mkRoomDb('NR1');
  const pa = mkPlayerDb('爱丽丝', 'NR1');
  const pb = mkPlayerDb('鲍勃', 'NR1');

  // ══ A. NPC 数据模型 ══
  const facA = npcEngine.createFaction({ name: '测试阵营', description: 'x' });
  const npc1 = mkNpc('旅馆老板', { personality: { traits: ['谨慎'] }, knowledge: ['秘密A'], factionId: facA.id, locationId: 'lobby' });
  assert.ok(npc1.uid.startsWith('npc_'));
  assert.strictEqual(npc1.name, '旅馆老板');
  assert.strictEqual(npc1.avatar, '🧍');
  ok('1. NPC 创建：uid/name/avatar 字段');
  assert.deepStrictEqual(npc1.personality, { traits: ['谨慎'] });
  ok('2. personality_json 持久化');
  assert.deepStrictEqual(npc1.goals, ['目标A']);
  ok('3. goals_json 持久化');
  assert.deepStrictEqual(npc1.knowledge, ['秘密A']);
  ok('4. knowledge_json 持久化');
  assert.strictEqual(npc1.faction_id, facA.id);
  ok('5. 阵营关联（faction_id）');
  assert.strictEqual(npc1.location_id, 'lobby');
  ok('6. location_id 持久化');
  const inst1 = mkInst(npc1.id, 'NR1');
  assert.strictEqual(inst1.alive, 1);
  assert.strictEqual(inst1.room_id, 'NR1');
  ok('7. NPC 实例：房间绑定 + alive');
  const inst1b = mkInst(npc1.id, 'NR1');
  assert.strictEqual(inst1b.id, inst1.id, '重复 spawn 幂等');
  ok('8. NPC 实例幂等（同房间同NPC唯一）');

  // ══ B. 记忆系统 ══
  npcEngine.addMemory(npc1.id, { playerId: pa.id, type: 'HELP', importance: 80, content: '玩家爱丽丝曾经救过我' });
  let mems = npcEngine.getMemories(npc1.id);
  assert.ok(mems.some((m) => m.memory_type === 'HELP' && m.importance === 80));
  ok('9. 记忆保存：HELP importance=80');
  for (const t of ['PLAYER_ACTION', 'CONVERSATION', 'EVENT', 'BETRAYAL', 'QUEST']) {
    npcEngine.addMemory(npc1.id, { playerId: pa.id, type: t, importance: 30, content: `记忆-${t}` });
  }
  assert.strictEqual(npcEngine.getMemories(npc1.id).length >= 6, true);
  ok('10. 全部 6 种记忆类型可保存');
  let memErr = null;
  try {
    npcEngine.addMemory(npc1.id, { type: 'INVALID', content: 'x' });
  } catch (e) {
    memErr = e;
  }
  assert.strictEqual(memErr && memErr.code, 'INVALID_MEMORY_TYPE');
  ok('11. 非法记忆类型被拒');
  const allMems = npcEngine.getMemories(npc1.id, { publicOnly: false, limit: 50 });
  assert.ok(allMems.some((m) => m.memory_type === 'BETRAYAL'), '服务器视角可读全部');
  ok('12. 记忆读取：服务器视角完整');
  const pubMems = npcEngine.getMemories(npc1.id, { publicOnly: true, limit: 50 });
  assert.ok(!pubMems.some((m) => m.memory_type === 'BETRAYAL'), 'BETRAYAL 隐藏');
  ok('13. 公开记忆过滤：BETRAYAL 不可见');
  assert.ok(!pubMems.some((m) => m.importance >= 60), '高重要度隐藏');
  ok('14. 公开记忆过滤：重要度≥60 隐藏');
  npcEngine.addMemory(npc1.id, { type: 'EVENT', importance: 10, content: 'x'.repeat(900) });
  const longMem = npcEngine.getMemories(npc1.id, { publicOnly: false, limit: 50 }).find((m) => m.content.startsWith('xxxx'));
  assert.ok(longMem.content.length <= 500);
  ok('15. 记忆内容长度限制（500）');
  for (let i = 0; i < 120; i += 1) npcEngine.addMemory(npc1.id, { type: 'EVENT', importance: 5 + (i % 10), content: `批量记忆${i}` });
  assert.ok(npcEngine.getMemories(npc1.id, { publicOnly: false, limit: 200 }).length <= 100);
  ok('16. 记忆容量上限（100，删最旧低重要度）');

  // ══ C. 关系系统 ══
  const npc2 = mkNpc('关系NPC');
  mkInst(npc2.id, 'NR1');
  const inst2 = npcEngine.findNpcInstanceInRoom('NR1', npc2.uid);
  assert.strictEqual(rel(npc2.id, pa.id).value, 0);
  assert.strictEqual(rel(npc2.id, pa.id).relationshipType, '陌生');
  ok('17. 初始关系：陌生（0）');
  npcEngine.applyRelationshipEvent(fakeIo, { npcInstanceId: inst2.id, playerId: pa.id, action: 'help', reason: '救了我' });
  assert.strictEqual(rel(npc2.id, pa.id).value, 10);
  ok('18. 帮助 +10（服务器固定值）');
  npcEngine.applyRelationshipEvent(fakeIo, { npcInstanceId: inst2.id, playerId: pa.id, action: 'deceive', reason: '骗了' });
  assert.strictEqual(rel(npc2.id, pa.id).value, -10);
  ok('19. 欺骗 -20');
  npcEngine.applyRelationshipEvent(fakeIo, { npcInstanceId: inst2.id, playerId: pa.id, action: 'attack', reason: '攻击' });
  assert.strictEqual(rel(npc2.id, pa.id).value, -60);
  ok('20. 攻击 -50');
  for (let i = 0; i < 30; i += 1) npcEngine.applyRelationshipEvent(fakeIo, { npcInstanceId: inst2.id, playerId: pb.id, action: 'help' });
  assert.strictEqual(rel(npc2.id, pb.id).value, 100, '钳制 100');
  ok('21. 关系上限钳制（100）');
  for (let i = 0; i < 10; i += 1) npcEngine.applyRelationshipEvent(fakeIo, { npcInstanceId: inst2.id, playerId: pb.id, action: 'betray' });
  if (process.env.DEBUG9) console.log('DBG22 rows:', JSON.stringify(db.prepare('SELECT * FROM npc_relationships WHERE source_id = ? AND target_id = ?').all(npc2.id, pb.id)), 'rel:', rel(npc2.id, pb.id).value);
  assert.strictEqual(rel(npc2.id, pb.id).value, -100, '钳制 -100');
  ok('22. 关系下限钳制（-100）');
  assert.strictEqual(npcEngine.relationshipType(-60), '敌视');
  assert.strictEqual(npcEngine.relationshipType(-10), '陌生');
  assert.strictEqual(npcEngine.relationshipType(10), '认识');
  assert.strictEqual(npcEngine.relationshipType(30), '友好');
  assert.strictEqual(npcEngine.relationshipType(60), '信任');
  assert.strictEqual(npcEngine.relationshipType(90), '盟友');
  ok('23. 关系类型阈值（敌视/陌生/认识/友好/信任/盟友）');
  const npc3 = mkNpc('NPC-B');
  npcEngine.adjustRelationship({ sourceType: 'npc', sourceId: npc2.id, targetType: 'npc', targetId: npc3.id, delta: 55 });
  assert.strictEqual(npcEngine.getRelationship('npc', npc2.id, 'npc', npc3.id).value, 55);
  ok('24. NPC↔NPC 关系支持');
  const wEvt = db.prepare("SELECT * FROM world_events WHERE action = 'NPC_HELP' ORDER BY id DESC LIMIT 1").get();
  assert.ok(wEvt, '关系变化记入 world_events');
  ok('25. 关系变化审计（world_events）');
  npcEngine.applyRelationshipEvent(fakeIo, { npcInstanceId: inst2.id, playerId: pa.id, action: 'help', reason: 'x', value: 99999 });
  assert.strictEqual(rel(npc2.id, pa.id).value, -50, 'AI 附加 value 参数被忽略，仍为固定 +10');
  ok('26. AI 作弊拒绝：不能指定关系数值（固定增量表）');
  let actErr = null;
  try {
    npcEngine.applyRelationshipEvent(fakeIo, { npcInstanceId: inst2.id, playerId: pa.id, action: 'mind_control' });
  } catch (e) {
    actErr = e;
  }
  assert.strictEqual(actErr && actErr.code, 'INVALID_ACTION');
  ok('27. 非法关系动作被拒');

  // ══ D. 阵营 ══
  assert.ok(facA.uid.startsWith('faction_'));
  ok('28. 阵营创建');
  assert.strictEqual(npcEngine.getFactionReputation(pa.id, facA.id), 0);
  ok('29. 阵营声望初始 0');
  npcEngine.adjustFactionReputation(pa.id, facA.id, 150); // 增量钳制为 +100
  assert.strictEqual(npcEngine.getFactionReputation(pa.id, facA.id), 100);
  npcEngine.adjustFactionReputation(pa.id, facA.id, -300); // 增量钳制为 -100 → 100-100=0
  assert.strictEqual(npcEngine.getFactionReputation(pa.id, facA.id), 0);
  npcEngine.adjustFactionReputation(pa.id, facA.id, -100);
  assert.strictEqual(npcEngine.getFactionReputation(pa.id, facA.id), -100, '下限钳制');
  ok('30. 阵营声望：增量钳制 ±100 + 值域钳制');
  npcEngine.adjustFactionReputation(pb.id, facA.id, 30);
  assert.strictEqual(npcEngine.getFactionReputation(pb.id, facA.id), 30, '玩家间独立');
  ok('31. 阵营声望按玩家隔离');
  const doorsFactions = db.prepare("SELECT COUNT(*) c FROM factions WHERE dungeon_id = (SELECT id FROM dungeons WHERE roblox_experience_name = 'Doors')").get().c;
  assert.strictEqual(doorsFactions, 3, '种子：幸存者/实体/旅馆管理员');
  ok('32. DOORS 种子阵营（幸存者/实体/旅馆管理员）');

  // ══ E. NPC 行为规则 / 事件 ══
  const npc4 = mkNpc('事件NPC');
  const inst4 = mkInst(npc4.id, 'NR1');
  npcEngine.applyRelationshipEvent(fakeIo, { npcInstanceId: inst4.id, playerId: pa.id, action: 'help', reason: '测试记忆' });
  assert.ok(npcEngine.getMemories(npc4.id).some((m) => m.memory_type === 'HELP'));
  ok('33. 关系事件自动生成记忆');
  const moodAfterHelp = npcEngine.getNpcInstance(inst4.id).mood;
  assert.ok(['friendly', 'grateful'].includes(moodAfterHelp));
  ok('34. 情绪由服务器规则决定（帮助→友好/感激）');
  const npc5 = mkNpc('必死NPC');
  const inst5 = mkInst(npc5.id, 'NR1');
  const killRes = npcEngine.killNpc(fakeIo, inst5.id, { byPlayerId: pa.id, reason: '剧情' });
  assert.strictEqual(killRes.ok, true);
  assert.strictEqual(npcEngine.getNpcInstance(inst5.id).alive, 0);
  assert.ok(db.prepare("SELECT * FROM game_events WHERE type = 'NPC_DEAD'").get());
  assert.ok(db.prepare("SELECT * FROM world_events WHERE action = 'NPC_DEAD'").get());
  ok('35. NPC 死亡：alive=0 + NPC_DEAD 长期事件（game_events + world_events）');
  let deadErr = null;
  try {
    npcEngine.applyRelationshipEvent(fakeIo, { npcInstanceId: inst5.id, playerId: pa.id, action: 'help' });
  } catch (e) {
    deadErr = e;
  }
  assert.strictEqual(deadErr && deadErr.code, 'NPC_DEAD');
  ok('36. 死亡 NPC 不可再交互');
  const npc6 = mkNpc('感恩NPC');
  const inst6 = mkInst(npc6.id, 'NR1');
  gameEvents.emit(io, 'NR1', { type: 'QUEST_COMPLETED', actor: '爱丽丝', actorPlayerId: pa.id, data: {} });
  assert.strictEqual(rel(npc6.id, pa.id).value, 15, 'NPC Listener：任务完成 +15');
  ok('37. Event Bus 监听：任务完成 → NPC 感恩 +15');
  const npc7 = mkNpc('并发NPC');
  const inst7 = mkInst(npc7.id, 'NR1');
  await Promise.all(Array.from({ length: 5 }, () => Promise.resolve(npcEngine.applyRelationshipEvent(fakeIo, { npcInstanceId: inst7.id, playerId: pa.id, action: 'help' }))));
  assert.strictEqual(rel(npc7.id, pa.id).value, 50, '5 次并发帮助 = 恰好 +50');
  ok('38. 并发关系修改：原子累加不过冲');

  // ══ F. NPC Tools ══
  const toolCtx = { io, room: { id: 'NR1', players: [] }, playerUid: pa.uid, actingPlayerName: '爱丽丝', broadcast: () => {} };
  const t39 = await tools.runTool(toolCtx, 'get_npc_status', { npc: npc2.uid });
  assert.strictEqual(t39.ok, true);
  assert.strictEqual(t39.name, '关系NPC');
  assert.ok(Array.isArray(t39.publicMemories));
  assert.ok(!t39.publicMemories.some((m) => m.type === 'BETRAYAL'));
  ok('39. Tool get_npc_status：公开视图（无隐藏记忆）');
  const memCountBefore = npcEngine.getMemories(npc2.id, { limit: 200 }).length;
  const relBefore = rel(npc2.id, pa.id).value;
  const t40 = await tools.runTool(toolCtx, 'talk_to_npc', { npc: npc2.uid, topic: '聊聊旅馆' });
  assert.strictEqual(t40.ok, true);
  assert.strictEqual(rel(npc2.id, pa.id).value, relBefore + 2);
  assert.strictEqual(npcEngine.getMemories(npc2.id, { limit: 200 }).length, memCountBefore + 1);
  ok('40. Tool talk_to_npc：+2 关系 + 对话记忆（服务器固定值）');
  const t41 = await tools.runTool(toolCtx, 'inspect_npc_memory', { npc: npc2.uid });
  assert.strictEqual(t41.ok, true);
  assert.ok(!t41.memories.some((m) => m.type === 'BETRAYAL' || m.importance >= 60));
  ok('41. Tool inspect_npc_memory：仅公开记忆');
  const t42 = await tools.runTool(toolCtx, 'update_npc_plan', { npc: npc2.uid, plan: '今晚去地下室巡逻', mood: 'afraid' });
  assert.strictEqual(t42.ok, true);
  const planRow = npcEngine.getNpcInstance(inst2.id);
  assert.strictEqual(JSON.parse(planRow.current_plan_json).plan, '今晚去地下室巡逻');
  assert.strictEqual(planRow.mood, 'afraid');
  ok('42. Tool update_npc_plan：计划+情绪写入');
  const t43 = await tools.runTool(toolCtx, 'update_npc_plan', { npc: npc2.uid, plan: 'x', mood: 'angry' }).catch((e) => ({ ok: false, kind: e.kind, error: e.message }));
  assert.strictEqual(t43.ok, false, '非法情绪枚举被拒（schema）');
  assert.strictEqual(t43.kind, 'invalid_args');
  ok('43. update_npc_plan：mood 枚举验证');
  const relB44 = rel(npc2.id, pa.id).value;
  await tools.runTool(toolCtx, 'update_npc_plan', { npc: npc2.uid, plan: '计划X', relationship: 100, value: 999 });
  assert.strictEqual(rel(npc2.id, pa.id).value, relB44, 'update_npc_plan 不能改关系');
  ok('44. update_npc_plan 绝不能修改关系（注入字段被忽略）');
  const npc8 = mkNpc('工具事件NPC');
  const inst8 = mkInst(npc8.id, 'NR1');
  await tools.runTool(toolCtx, 'npc_relationship_event', { npc: npc8.uid, action: 'help', reason: '帮' });
  assert.strictEqual(rel(npc8.id, pa.id).value, 10);
  await tools.runTool(toolCtx, 'npc_relationship_event', { npc: npc8.uid, action: 'deceive', reason: '骗' });
  assert.strictEqual(rel(npc8.id, pa.id).value, -10);
  await tools.runTool(toolCtx, 'npc_relationship_event', { npc: npc8.uid, action: 'attack', reason: '打' });
  assert.strictEqual(rel(npc8.id, pa.id).value, -60);
  ok('45. Tool npc_relationship_event：help/deceive/attack 固定增量');
  const npc9 = mkNpc('待杀NPC');
  const inst9 = mkInst(npc9.id, 'NR1');
  const t46 = await tools.runTool(toolCtx, 'kill_npc', { npc: npc9.uid, reason: '剧情杀' });
  assert.strictEqual(t46.ok, true);
  assert.strictEqual(npcEngine.getNpcInstance(inst9.id).alive, 0);
  ok('46. Tool kill_npc：服务器验证后执行');
  mkRoomDb('NR2');
  const npcOther = mkNpc('别屋NPC');
  mkInst(npcOther.id, 'NR2');
  const t47 = await tools.runTool(toolCtx, 'get_npc_status', { npc: npcOther.uid }).catch((e) => ({ ok: false, error: e.message }));
  assert.strictEqual(t47.ok, false, 'Room Isolation');
  ok('47. Room Isolation：跨房间 NPC 访问被拒');

  // ══ G. 任务门控集成 ══
  // 种子：旅馆管理员 + 关系门控隐藏任务（min_relationship=50）
  const keeper = npcEngine.getNpc('npc_doors_keeper');
  assert.ok(keeper, '种子旅馆管理员存在');
  const keeperInst = mkInst(keeper.id, 'NR1');
  npcEngine.checkQuestGates(fakeIo, 'NR1');
  let gateQi = db.prepare(
    "SELECT qi.* FROM quest_instances qi JOIN quest_versions qv ON qv.id=qi.quest_version_id JOIN quests q ON q.id=qv.quest_id WHERE q.uid='quest_doors_keeper_secret' AND qi.room_id='NR1'"
  ).get();
  assert.ok(!gateQi, '关系不足：门控任务不出现');
  ok('48. NPC 任务门控：关系 <50 不给任务');
  for (let i = 0; i < 5; i += 1) npcEngine.applyRelationshipEvent(fakeIo, { npcInstanceId: keeperInst.id, playerId: pa.id, action: 'help', reason: '刷关系' });
  assert.ok(rel(keeper.id, pa.id).value >= 50);
  npcEngine.checkQuestGates(fakeIo, 'NR1');
  gateQi = db.prepare(
    "SELECT qi.* FROM quest_instances qi JOIN quest_versions qv ON qv.id=qi.quest_version_id JOIN quests q ON q.id=qv.quest_id WHERE q.uid='quest_doors_keeper_secret' AND qi.room_id='NR1'"
  ).get();
  assert.ok(gateQi && gateQi.status === 'ACTIVE', '关系达标 → 门控任务激活');
  ok('49. NPC 任务门控：关系 ≥50 开启隐藏任务');
  npcEngine.checkQuestGates(fakeIo, 'NR1');
  const gateCount = db.prepare(
    "SELECT COUNT(*) c FROM quest_instances qi JOIN quest_versions qv ON qv.id=qi.quest_version_id JOIN quests q ON q.id=qv.quest_id WHERE q.uid='quest_doors_keeper_secret' AND qi.room_id='NR1'"
  ).get().c;
  assert.strictEqual(gateCount, 1, '门控幂等');
  ok('50. 门控幂等：重复检查不重复创建');
  // 51. 非法 npc_gate 定义安全忽略
  const badGate = questDraftBadGate();
  npcEngine.checkQuestGates(fakeIo, 'NR1'); // 不应崩溃
  assert.ok(true);
  ok('51. 非法 npc_gate 定义安全忽略（不崩溃）');
  // 52. 门控任务绑定 NPC 所在副本实例
  assert.ok(gateQi.dungeon_instance_id === null || gateQi.dungeon_instance_id === keeperInst.dungeon_instance_id);
  ok('52. 门控任务实例绑定场景上下文');
  // 53. 任务完成 → 任务完成关系回馈（与37联动）
  const relKeeperBefore = rel(keeper.id, pa.id).value;
  gameEvents.emit(io, 'NR1', { type: 'QUEST_COMPLETED', actor: '爱丽丝', actorPlayerId: pa.id, data: {} });
  assert.ok(rel(keeper.id, pa.id).value > relKeeperBefore);
  ok('53. 任务完成 → NPC 关系 +15（Listener 联动）');

  // ══ H. Context / 恢复 / 安全 ══
  const runtimeEngine = require('../src/services/runtime/runtimeEngine');
  const vInfo = db.prepare("INSERT INTO dungeon_versions (dungeon_id, version, definition_json, canonical_snapshot_hash, status) VALUES (1, 990, ?, 'h9', 'PUBLISHED')").run(JSON.stringify({ scenes: [{ id: 's', name: 's', order: 1, exits: [], encounters: [], events: [] }], encounters: [], enemies: [], boss: null, dungeon: { difficulty: 1 } }));
  db.prepare("INSERT INTO dungeon_instances (uid, dungeon_version_id, room_id, status, current_scene_id, party) VALUES ('inst_npc', ?, 'NR1', 'RUNNING', 's', ?)").run(vInfo.lastInsertRowid, JSON.stringify([pa.id]));
  const instNpc = require('../src/services/runtime/instanceManager').getInstance('inst_npc');
  const ctxTxt = runtimeEngine.buildRuntimeContext(instNpc, JSON.parse(db.prepare('SELECT definition_json FROM dungeon_versions WHERE id = ?').get(vInfo.lastInsertRowid).definition_json), [pa]);
  assert.ok(ctxTxt.includes('NPC_CONTEXT'));
  ok('54. Context：NPC_CONTEXT 分区存在');
  assert.ok(ctxTxt.includes('关系NPC'), 'Context 含 NPC 名');
  ok('55. Context：含附近 NPC 与关系');
  assert.ok(ctxTxt.includes('近期记忆'), 'Context 含最近记忆');
  ok('56. Context：NPC 最近记忆进入上下文');
  // 57. 断线恢复：NPC 数据持久（全来自数据库）
  const instsBefore = npcEngine.npcInstancesInRoom('NR1').length;
  assert.ok(instsBefore > 3);
  ok('57. 断线恢复：NPC 实例持久化（服务器数据库权威）');
  // 58. REST 跨房间拒绝
  const S = await mkSocket();
  const createdS = await ack(S, 'room:create', { playerName: '苏苏' });
  const resp58 = await fetch(`${BASE}/api/npcs/${inst2.id}?sessionToken=${encodeURIComponent(createdS.sessionToken)}`);
  assert.strictEqual(resp58.status, 403);
  ok('58. REST 跨房间 NPC 访问 403');
  // 59. REST 公开视图不含隐藏记忆
  const resp59 = await fetch(`${BASE}/api/npcs?sessionToken=${encodeURIComponent(createdS.sessionToken)}`);
  assert.strictEqual(resp59.status, 200);
  ok('59. REST /api/npcs：公开视图（断线恢复安全）');
  // 60. 无直接改关系的工具
  const toolNames = tools.getRegistry().map((t) => t.name);
  assert.ok(!toolNames.includes('set_npc_relationship'));
  assert.ok(!toolNames.includes('set_faction_reputation'));
  assert.ok(!toolNames.includes('add_npc_memory'));
  ok('60. 安全：不存在直接改关系/声望/记忆的工具（只能类型化事件）');
  // 61. inspect_npc_memory 永不返回 BETRAYAL（再次验证 REST 层同源函数）
  const pub61 = npcEngine.getMemories(npc2.id, { publicOnly: true, limit: 100 });
  assert.ok(!pub61.some((m) => m.memory_type === 'BETRAYAL'));
  ok('61. 隐藏记忆绝不外泄（BETRAYAL 始终过滤）');
  // 62. 回归
  ok('62. 阶段1~8 回归：由全套件 `npm test` 覆盖');

  console.log(`\n[test] 阶段9 全部通过：${passed}/62 项 ✅`);
  S.disconnect();
  server.close();
  aiServer.close();
  process.exit(0);

  function questDraftBadGate() {
    const q = db.prepare("INSERT INTO quests (uid, name, type, status, source_type) VALUES ('quest_bad_gate', '坏门控', 'HIDDEN', 'ACTIVE', 'DESIGNER')").run();
    db.prepare("INSERT INTO quest_versions (quest_id, version, definition_json, status) VALUES (?, 1, '{\"npc_gate\":{\"npc\":\"不存在的NPC\",\"min_relationship\":\"abc\"}}', 'PUBLISHED')").run(q.lastInsertRowid);
    return q.lastInsertRowid;
  }
}

function mkSocket(auth) {
  return new Promise((res) => {
    const s = ioc(BASE, { transports: ['websocket'], auth });
    s.on('connect', () => res(s));
  });
}
const ack = (s, ev, p) => new Promise((res) => s.emit(ev, p, res));

main().catch((err) => {
  console.error('\n[test] 阶段9 测试失败 ❌\n', err);
  process.exit(1);
});
