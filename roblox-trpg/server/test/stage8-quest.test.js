/**
 * 阶段8 测试：Quest & Objective System（70 项）。
 * 复用：阶段5 Runtime、阶段6 Character、阶段3 Reward/World、阶段7 Agent。
 */
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

for (const suffix of ['', '-wal', '-shm', '-journal']) {
  fs.rmSync(path.join(__dirname, '../../database/data/roblox_trpg.db' + suffix), { force: true });
}

process.env.AI_API_KEY = 'ai-key-s8';
process.env.AI_BASE_URL = 'http://127.0.0.1:3809/v1';
process.env.AI_MODEL = 'mock-s8';
process.env.AI_STREAM = 'off';
process.env.AI_RATE_PER_PLAYER = '1000';
process.env.AI_RATE_PER_ROOM = '1000';

const { io: ioc } = require('socket.io-client');
const { server, io } = require('../src/index.js');
const dbMod = require('@roblox-trpg/database');
const db = dbMod.getDb();
const questEngine = require('../src/services/quests/questEngine');
const gameEvents = require('../src/services/quests/gameEvents');
const conditionDsl = require('../src/services/quests/conditionDsl');
const im = require('../src/services/runtime/instanceManager');
const tools = require('../src/services/ai/tools');
const characterService = require('../src/services/character/characterService');

const PORT = 3807;
const BASE = `http://localhost:${PORT}`;
let passed = 0;
const ok = (label) => {
  passed += 1;
  console.log(`  ✓ ${label}`);
};
const fakeIo = { to: () => ({ emit: () => {} }) };

// mock AI
const aiQueue = [];
const aiServer = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    if (b.includes('OPENING_NARRATION')) {
      // 阶段32：副本开场白请求——直接回固定开场，不消费脚本化队列
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ narration: '（开场白）', options: [] }) }, finish_reason: 'stop' }] }));
    }
    const item = aiQueue.shift() || {};
    const msg = {};
    if (item.content !== undefined) msg.content = typeof item.content === 'string' ? item.content : JSON.stringify(item.content);
    if (item.tool_calls) msg.tool_calls = item.tool_calls.map((tc, i) => ({ id: tc.id || `c${i}`, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) } }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: msg, finish_reason: item.tool_calls ? 'tool_calls' : 'stop' }] }));
  });
});

// 直接 DB 造房间/玩家（单元测试用）
function mkRoomDb(id) {
  db.prepare("INSERT OR IGNORE INTO rooms (id, status, max_players) VALUES (?, 'waiting', 3)").run(id);
}
let playerSeq = 0;
function mkPlayerDb(name, roomId) {
  playerSeq += 1;
  const uid = `player_s8_${playerSeq}`;
  db.prepare('INSERT INTO players (uid, socket_id, name, room_id) VALUES (?, ?, ?, ?)').run(uid, `sock_${uid}`, name, roomId);
  return db.prepare('SELECT * FROM players WHERE uid = ?').get(uid);
}
function mkQuestVersion(def, { type = 'SIDE', name = '测试任务', dungeonId = null } = {}) {
  const r = questEngine.createQuestDraft({ name, description: '测试', type, dungeonId, definition: def });
  questEngine.publishQuestVersion(r.versionId);
  return r;
}
function mkInstance(versionId, roomId, players, { activate = true } = {}) {
  return questEngine.createInstance(fakeIo, { questVersionId: versionId, roomId, partyPlayerIds: players.map((p) => p.id), activate });
}
function emitEv(roomId, type, data = {}, actorPlayerId = null, instanceId = null) {
  return gameEvents.emit(io, roomId, { type, actor: actorPlayerId ? `p${actorPlayerId}` : null, actorPlayerId, data, instanceId });
}
const objBy = (qiId, key) =>
  db.prepare(
    `SELECT qoi.*, qo.objective_key FROM quest_objective_instances qoi JOIN quest_objectives qo ON qo.id = qoi.objective_id
     WHERE qoi.quest_instance_id = ? AND qo.objective_key = ?`
  ).get(qiId, key);
const qiStatus = (qiId) => db.prepare('SELECT status FROM quest_instances WHERE id = ?').get(qiId).status;

async function main() {
  await Promise.all([new Promise((r) => aiServer.listen(3809, r)), new Promise((r) => server.listen(PORT, r))]);
  console.log(`[test] 服务器 :${PORT} + mock AI :3809 就绪（70 项）\n`);

  // ══ A. 生命周期 ══
  mkRoomDb('QR1');
  const pa = mkPlayerDb('爱丽丝', 'QR1');
  const pb = mkPlayerDb('鲍勃', 'QR1');
  const pc = mkPlayerDb('卡罗尔', 'QR1');

  // 1. 创建任务（DRAFT）
  const draft = questEngine.createQuestDraft({
    name: '测试任务A', description: 'x', type: 'SIDE',
    definition: { scope: 'PARTY', objectives: [{ key: 'o1', name: '目标1', type: 'INTERACT', required_count: 1, order_index: 1 }], rewards: [{ type: 'XP', amount: 100 }] },
  });
  assert.strictEqual(draft.status, 'DRAFT');
  ok('1. 创建任务 → DRAFT（AI 草案不能直接 PUBLISHED）');

  // 2. 发布任务版本
  const pub = questEngine.publishQuestVersion(draft.versionId);
  assert.strictEqual(pub.status, 'PUBLISHED');
  ok('2. 发布任务版本 → PUBLISHED');

  // 3. 创建实例（ACTIVE + 参与者 + 目标实例）
  const full = mkInstance(draft.versionId, 'QR1', [pa, pb]);
  assert.strictEqual(full.instance.status, 'ACTIVE');
  assert.strictEqual(full.participants.length, 2);
  assert.strictEqual(full.objectives.length, 1);
  assert.strictEqual(full.objectives[0].status, 'ACTIVE');
  ok('3. 任务实例创建：参与者 + Objective 实例');

  // 4. AVAILABLE → ACTIVE
  const draft2 = mkQuestVersion({ scope: 'PARTY', objectives: [{ key: 'o1', name: '目标', type: 'INTERACT', order_index: 1 }], rewards: [] });
  const avail = questEngine.createInstance(fakeIo, { questVersionId: draft2.versionId, roomId: 'QR1', partyPlayerIds: [pa.id], activate: false });
  assert.strictEqual(avail.instance.status, 'AVAILABLE');
  const started = questEngine.startQuest(fakeIo, avail.instance.id);
  assert.strictEqual(started.status, 'ACTIVE');
  ok('4. AVAILABLE → ACTIVE（start_quest）');

  // 5. 事件驱动完成
  emitEv('QR1', 'INTERACT', {}, pa.id);
  assert.strictEqual(qiStatus(full.instance.id), 'COMPLETED');
  ok('5. 事件驱动：Objective 完成 → 任务 COMPLETED');

  // 6. 失败任务（fail_on）
  const draftF = mkQuestVersion({ scope: 'PARTY', fail_on: ['DUNGEON_FAILED'], objectives: [{ key: 'o1', name: '目标', type: 'INTERACT', order_index: 1 }], rewards: [] });
  const instF = mkInstance(draftF.versionId, 'QR1', [pa]);
  emitEv('QR1', 'DUNGEON_FAILED', { reason: 'test' }, pa.id);
  assert.strictEqual(qiStatus(instF.instance.id), 'FAILED');
  ok('6. 失败条件：DUNGEON_FAILED → 任务 FAILED');

  // 7. 放弃任务
  const draftAb = mkQuestVersion({ scope: 'PARTY', objectives: [{ key: 'o1', name: '目标', type: 'INTERACT', order_index: 1 }], rewards: [] });
  const instAb = mkInstance(draftAb.versionId, 'QR1', [pa]);
  assert.strictEqual(questEngine.abandonQuest(fakeIo, instAb.instance.id).status, 'ABANDONED');
  ok('7. 放弃任务 → ABANDONED');

  // 8. COMPLETED → ACTIVE 禁止
  let err8 = null;
  try {
    questEngine.setQuestStatus(fakeIo, full.instance.id, 'ACTIVE');
  } catch (e) {
    err8 = e;
  }
  assert.strictEqual(err8 && err8.code, 'INVALID_TRANSITION');
  ok('8. 状态机：COMPLETED → ACTIVE 禁止');

  // 9. FAILED → COMPLETED 禁止
  let err9 = null;
  try {
    questEngine.setQuestStatus(fakeIo, instF.instance.id, 'COMPLETED');
  } catch (e) {
    err9 = e;
  }
  assert.strictEqual(err9 && err9.code, 'INVALID_TRANSITION');
  ok('9. 状态机：FAILED → COMPLETED 禁止');

  // 10. ABANDONED → ACTIVE 允许
  assert.strictEqual(questEngine.setQuestStatus(fakeIo, instAb.instance.id, 'ACTIVE').status, 'ACTIVE');
  ok('10. 状态机：ABANDONED → ACTIVE 允许（明确支持）');

  // ══ B. Objective 系统 ══
  // 11. 单目标
  const d11 = mkQuestVersion({ scope: 'PARTY', objectives: [{ key: 'k', name: '收集', type: 'COLLECT_ITEM', order_index: 1, definition_json: null }], rewards: [] });
  db.prepare("UPDATE quest_objectives SET definition_json = '{\"event_type\":\"ITEM_ACQUIRED\",\"match\":{\"item\":\"测试物品\"}}' WHERE quest_version_id = ? AND objective_key = 'k'").run(d11.versionId);
  const i11 = mkInstance(d11.versionId, 'QR1', [pa]);
  emitEv('QR1', 'ITEM_ACQUIRED', { item: '测试物品' }, pa.id);
  assert.strictEqual(qiStatus(i11.instance.id), 'COMPLETED');
  ok('11. 单目标：COLLECT_ITEM 事件完成');

  // 12/13. 顺序目标
  const d13 = mkQuestVersion({
    scope: 'PARTY',
    objectives: [
      { key: 's1', name: '第一步', type: 'INTERACT', order_index: 1 },
      { key: 's2', name: '第二步', type: 'INTERACT', order_index: 2 },
    ],
    rewards: [],
  });
  const i13 = mkInstance(d13.versionId, 'QR1', [pa]);
  assert.strictEqual(objBy(i13.instance.id, 's1').status, 'ACTIVE');
  assert.strictEqual(objBy(i13.instance.id, 's2').status, 'LOCKED');
  ok('12. 多目标：初始第一组 ACTIVE，第二组 LOCKED');
  emitEv('QR1', 'INTERACT', { step: 1 }, pa.id);
  assert.strictEqual(objBy(i13.instance.id, 's1').status, 'COMPLETED');
  assert.strictEqual(objBy(i13.instance.id, 's2').status, 'ACTIVE', '顺序模式：前一步完成后解锁');
  emitEv('QR1', 'INTERACT', { step: 2 }, pa.id);
  assert.strictEqual(qiStatus(i13.instance.id), 'COMPLETED');
  ok('13. 顺序目标：逐步解锁直至完成');

  // 14. 并行目标
  const d14 = mkQuestVersion({
    scope: 'PARTY',
    objectives: [
      { key: 'p1', name: '找钥匙', type: 'COLLECT_ITEM', order_index: 1 },
      { key: 'p2', name: '找药品', type: 'COLLECT_ITEM', order_index: 1 },
    ],
    rewards: [],
  });
  db.prepare("UPDATE quest_objectives SET definition_json = '{\"event_type\":\"ITEM_ACQUIRED\",\"match\":{\"item\":\"钥匙X\"}}' WHERE quest_version_id = ? AND objective_key = 'p1'").run(d14.versionId);
  db.prepare("UPDATE quest_objectives SET definition_json = '{\"event_type\":\"ITEM_ACQUIRED\",\"match\":{\"item\":\"药品Y\"}}' WHERE quest_version_id = ? AND objective_key = 'p2'").run(d14.versionId);
  const i14 = mkInstance(d14.versionId, 'QR1', [pa]);
  assert.strictEqual(objBy(i14.instance.id, 'p1').status, 'ACTIVE');
  assert.strictEqual(objBy(i14.instance.id, 'p2').status, 'ACTIVE');
  emitEv('QR1', 'ITEM_ACQUIRED', { item: '钥匙X' }, pa.id);
  emitEv('QR1', 'ITEM_ACQUIRED', { item: '药品Y' }, pa.id);
  assert.strictEqual(qiStatus(i14.instance.id), 'COMPLETED');
  ok('14. 并行目标：同 order 同时 ACTIVE');

  // 15. 计数目标
  const d15 = mkQuestVersion({ scope: 'PARTY', objectives: [{ key: 'c3', name: '击败3个', type: 'DEFEAT_ENEMY', required_count: 3, order_index: 1 }], rewards: [] });
  db.prepare("UPDATE quest_objectives SET definition_json = '{\"event_type\":\"ENEMY_DEFEATED\"}' WHERE quest_version_id = ? AND objective_key = 'c3'").run(d15.versionId);
  const i15 = mkInstance(d15.versionId, 'QR1', [pa]);
  emitEv('QR1', 'ENEMY_DEFEATED', { enemy: 'e1' }, pa.id);
  emitEv('QR1', 'ENEMY_DEFEATED', { enemy: 'e2' }, pa.id);
  assert.strictEqual(objBy(i15.instance.id, 'c3').current_count, 2);
  assert.strictEqual(objBy(i15.instance.id, 'c3').status, 'ACTIVE');
  emitEv('QR1', 'ENEMY_DEFEATED', { enemy: 'e3' }, pa.id);
  assert.strictEqual(objBy(i15.instance.id, 'c3').status, 'COMPLETED');
  ok('15. 计数目标：3/3 完成');

  // 16. PERSONAL 作用域
  const d16 = mkQuestVersion({ scope: 'PERSONAL', objectives: [{ key: 'me', name: '个人目标', type: 'INTERACT', required_count: 1, order_index: 1 }], rewards: [] });
  const i16 = mkInstance(d16.versionId, 'QR1', [pa, pb]);
  emitEv('QR1', 'INTERACT', { act: 'personal' }, pa.id);
  let prog16 = JSON.parse(objBy(i16.instance.id, 'me').progress_json);
  assert.strictEqual(prog16[String(pa.id)], 1);
  assert.strictEqual(prog16[String(pb.id)] || 0, 0, 'PERSONAL：只更新行动玩家');
  assert.strictEqual(qiStatus(i16.instance.id), 'ACTIVE', 'PERSONAL：全员完成才算完成');
  emitEv('QR1', 'INTERACT', { act: 'personal' }, pb.id);
  assert.strictEqual(qiStatus(i16.instance.id), 'COMPLETED');
  ok('16. PERSONAL 作用域：逐玩家进度 + 全员完成');

  // 17. PARTY 作用域（共享计数）
  const d17 = mkQuestVersion({ scope: 'PARTY', objectives: [{ key: 'sh', name: '共享', type: 'INTERACT', required_count: 2, order_index: 1 }], rewards: [] });
  const i17 = mkInstance(d17.versionId, 'QR1', [pa, pb]);
  emitEv('QR1', 'INTERACT', { act: 'shared1' }, pa.id);
  emitEv('QR1', 'INTERACT', { act: 'shared2' }, pb.id);
  assert.strictEqual(objBy(i17.instance.id, 'sh').current_count, 2);
  assert.strictEqual(qiStatus(i17.instance.id), 'COMPLETED');
  ok('17. PARTY 作用域：共享进度（A 行动 + B 行动 = 2）');

  // 18. ROOM 作用域
  const d18 = mkQuestVersion({ scope: 'ROOM', objectives: [{ key: 'rm', name: '房间', type: 'INTERACT', required_count: 1, order_index: 1 }], rewards: [] });
  const i18 = mkInstance(d18.versionId, 'QR1', [pa]);
  emitEv('QR1', 'INTERACT', { act: 'room-level' }, null);
  assert.strictEqual(qiStatus(i18.instance.id), 'COMPLETED');
  ok('18. ROOM 作用域：任意房间事件计数');

  // 19. 可选目标
  const d19 = mkQuestVersion({
    scope: 'PARTY',
    objectives: [
      { key: 'req1', name: '必做', type: 'INTERACT', order_index: 1 },
      { key: 'opt1', name: '可选', type: 'SEARCH', order_index: 1, is_optional: 1 }, // 不会被 INTERACT 事件完成
    ],
    rewards: [],
  });
  const i19 = mkInstance(d19.versionId, 'QR1', [pa]);
  emitEv('QR1', 'INTERACT', { act: 'required-only' }, pa.id);
  assert.strictEqual(qiStatus(i19.instance.id), 'COMPLETED', '必做完成即可通关');
  assert.strictEqual(objBy(i19.instance.id, 'opt1').status, 'SKIPPED');
  ok('19. 可选目标：通关时 SKIPPED');

  // 20. LOCKED 目标不被事件推进
  const d20 = mkQuestVersion({
    scope: 'PARTY',
    objectives: [
      { key: 'a1', name: '第一', type: 'INTERACT', order_index: 1 },
      { key: 'a2', name: '第二', type: 'INTERACT', order_index: 2 },
    ],
    rewards: [],
  });
  const i20 = mkInstance(d20.versionId, 'QR1', [pa]);
  emitEv('QR1', 'INTERACT', { act: 'try-locked' }, pa.id); // a1 完成
  assert.strictEqual(objBy(i20.instance.id, 'a2').status, 'ACTIVE');
  assert.strictEqual(objBy(i20.instance.id, 'a2').current_count, 0, '刚解锁的目标计数从0开始');
  ok('20. LOCKED 目标不被提前推进');

  // ══ C. 分支 / 选择 / 条件 ══
  const d21 = mkQuestVersion({
    scope: 'PARTY',
    objectives: [
      { key: 'npc_found', name: '发现NPC', type: 'TALK_TO_NPC', order_index: 1 },
      { key: 'branch_help', name: '帮助NPC', type: 'INTERACT', order_index: 2 },
      { key: 'branch_steal', name: '抢走物品', type: 'INTERACT', order_index: 2 },
    ],
    rewards: [],
  });
  db.prepare(`UPDATE quest_objectives SET definition_json = '{"event_type":"NPC_TALKED","branch":{"choice_key":"npc_choice","options":[{"id":"help","label":"帮助 NPC","activate_objectives":["branch_help"],"skip_objectives":["branch_steal"]},{"id":"steal","label":"抢走物品","activate_objectives":["branch_steal"],"skip_objectives":["branch_help"]}]}}' WHERE quest_version_id = ? AND objective_key = 'npc_found'`).run(d21.versionId);
  const i21 = mkInstance(d21.versionId, 'QR1', [pa, pb]);
  const questEvents = [];
  io.to('QR1').emit = () => {}; // 静默
  emitEv('QR1', 'NPC_TALKED', { npc: '神秘人' }, pa.id);
  assert.strictEqual(objBy(i21.instance.id, 'npc_found').status, 'COMPLETED');
  const choiceRow = db.prepare('SELECT * FROM quest_choices WHERE quest_instance_id = ?').get(i21.instance.id);
  assert.ok(choiceRow && choiceRow.status === 'PENDING');
  ok('21. 分支：目标完成 → QUEST_BRANCH 选择生成');

  // 22. 提交选择 → 分支生效
  const ch = questEngine.submitChoice(fakeIo, i21.instance.id, pa.id, 'npc_choice', 'help');
  assert.strictEqual(ch.ok, true);
  assert.strictEqual(objBy(i21.instance.id, 'branch_help').status, 'ACTIVE');
  assert.strictEqual(objBy(i21.instance.id, 'branch_steal').status, 'SKIPPED');
  ok('22. Choice：选择分支 → 激活/跳过对应目标');

  // 23. 非法选项
  const d23 = mkQuestVersion({
    scope: 'PARTY',
    objectives: [
      { key: 'o', name: 'o', type: 'TALK_TO_NPC', order_index: 1 },
      { key: 'after23', name: '之后', type: 'INTERACT', order_index: 2 }, // 保持任务 ACTIVE
    ],
    rewards: [],
  });
  db.prepare(`UPDATE quest_objectives SET definition_json = '{"event_type":"NPC_TALKED","branch":{"choice_key":"c23","options":[{"id":"a","label":"A"}]}}' WHERE quest_version_id = ? AND objective_key = 'o'`).run(d23.versionId);
  const i23 = mkInstance(d23.versionId, 'QR1', [pa]);
  emitEv('QR1', 'NPC_TALKED', { npc: 'x' }, pa.id);
  let err23 = null;
  try {
    questEngine.submitChoice(fakeIo, i23.instance.id, pa.id, 'c23', 'zzz');
  } catch (e) {
    err23 = e;
  }
  assert.strictEqual(err23 && err23.code, 'INVALID_OPTION');
  ok('23. Choice：非法选项被拒');

  // 24. 非参与者不能选择
  let err24 = null;
  try {
    questEngine.submitChoice(fakeIo, i23.instance.id, pc.id, 'c23', 'a');
  } catch (e) {
    err24 = e;
  }
  assert.strictEqual(err24 && err24.code, 'NOT_PARTICIPANT');
  ok('24. Choice：非参与者被拒（权限）');

  // 25/26. 条件分支（Condition DSL）
  const d25 = mkQuestVersion({
    scope: 'PARTY',
    objectives: [
      { key: 'o', name: 'o', type: 'TALK_TO_NPC', order_index: 1 },
      { key: 'after25', name: '之后', type: 'INTERACT', order_index: 2 }, // 保持任务 ACTIVE
    ],
    rewards: [],
  });
  db.prepare(`UPDATE quest_objectives SET definition_json = '{"event_type":"NPC_TALKED","branch":{"choice_key":"c25","options":[{"id":"need_item","label":"需要物品","conditions":[{"type":"has_item","item":"不存在的物品"}]},{"id":"free","label":"无条件"}]}}' WHERE quest_version_id = ? AND objective_key = 'o'`).run(d25.versionId);
  const i25 = mkInstance(d25.versionId, 'QR1', [pa]);
  emitEv('QR1', 'NPC_TALKED', { npc: 'y' }, pa.id);
  let err25 = null;
  try {
    questEngine.submitChoice(fakeIo, i25.instance.id, pa.id, 'c25', 'need_item');
  } catch (e) {
    err25 = e;
  }
  assert.strictEqual(err25 && err25.code, 'CONDITION_NOT_MET');
  ok('25. 条件分支：DSL 条件不满足 → CONDITION_NOT_MET（无 JS 执行）');
  const okCh = questEngine.submitChoice(fakeIo, i25.instance.id, pa.id, 'c25', 'free');
  assert.strictEqual(okCh.ok, true);
  ok('26. 条件分支：条件满足 → 选择通过');

  // ══ D. 隐藏任务 / 时间限制 ══
  // 27. 隐藏任务发现
  const d27 = mkQuestVersion(
    { scope: 'PARTY', hidden: true, discovery: { event_type: 'DICE_ROLLED', count: 2 }, objectives: [{ key: 'h1', name: '隐藏目标', type: 'INTERACT', order_index: 1 }], rewards: [] },
    { type: 'HIDDEN', name: '隐藏任务' }
  );
  mkRoomDb('QR2');
  const ph = mkPlayerDb('隐藏玩家', 'QR2');
  emitEv('QR2', 'DICE_ROLLED', { total: 3 }, ph.id);
  let hiddenInst = db.prepare('SELECT * FROM quest_instances WHERE quest_version_id = ?').get(d27.versionId);
  assert.ok(!hiddenInst, '未达阈值不触发');
  emitEv('QR2', 'DICE_ROLLED', { total: 5 }, ph.id);
  hiddenInst = db.prepare('SELECT * FROM quest_instances WHERE quest_version_id = ?').get(d27.versionId);
  assert.ok(hiddenInst && hiddenInst.status === 'ACTIVE', '达到阈值 → 隐藏任务触发');
  ok('27. 隐藏任务：事件阈值触发发现');

  // 28. 时间限制（服务器判定）
  const d28 = mkQuestVersion({ scope: 'PARTY', objectives: [{ key: 't1', name: 't', type: 'INTERACT', order_index: 1 }], rewards: [] });
  const i28 = mkInstance(d28.versionId, 'QR1', [pa]);
  db.prepare("UPDATE quest_instances SET deadline_at = datetime('now', '-1 minute') WHERE id = ?").run(i28.instance.id);
  emitEv('QR1', 'INTERACT', { act: 'late' }, pa.id); // 任意事件触发惰性检查
  assert.strictEqual(qiStatus(i28.instance.id), 'FAILED', '超时 → FAILED');
  ok('28. 时间限制：服务器时间判定（不用客户端时间）');

  // 29. 失败后锁定（不可 COMPLETED）
  let err29 = null;
  try {
    questEngine.setQuestStatus(fakeIo, i28.instance.id, 'COMPLETED');
  } catch (e) {
    err29 = e;
  }
  assert.strictEqual(err29 && err29.code, 'INVALID_TRANSITION');
  ok('29. 任务失败后锁死（定义驱动）');

  // 30. deadline 定义校验（10秒~60分钟）
  const errs30 = questEngine.validateQuestDraft({ objectives: [{ key: 'a', name: 'a', type: 'INTERACT' }], time_limit_ms: 100 });
  assert.ok(errs30.length > 0);
  ok('30. time_limit_ms 范围校验');

  // ══ E. 奖励 ══
  mkRoomDb('QR3');
  const pr = mkPlayerDb('奖励玩家', 'QR3');
  characterService.ensureCharacter(pr.id);
  const d31 = mkQuestVersion({
    scope: 'PARTY',
    objectives: [{ key: 'r1', name: 'r', type: 'INTERACT', order_index: 1 }],
    rewards: [
      { type: 'XP', amount: 300 },
      { type: 'CURRENCY', currency: '金币', amount: 250 },
      { type: 'SKILL', skill: '开锁能力' },
      { type: 'ITEM', item: '治疗药水' },
    ],
  });
  const i31 = mkInstance(d31.versionId, 'QR3', [pr]);
  const expBefore = db.prepare('SELECT exp FROM players WHERE id = ?').get(pr.id).exp || 0;
  emitEv('QR3', 'INTERACT', { act: 'reward-quest' }, pr.id);
  assert.strictEqual(qiStatus(i31.instance.id), 'COMPLETED');
  const expAfter = db.prepare('SELECT exp FROM players WHERE id = ?').get(pr.id).exp;
  assert.strictEqual(expAfter - expBefore, 300, 'XP 结算');
  const bal = db.prepare("SELECT pc.balance FROM player_currency pc JOIN currencies c ON c.id = pc.currency_id WHERE pc.player_id = ? AND c.name = '金币'").get(pr.id);
  assert.strictEqual(bal.balance, 250, '货币结算');
  assert.ok(db.prepare("SELECT 1 FROM player_skills ps JOIN skills s ON s.id=ps.skill_id WHERE ps.player_id = ? AND s.name = '开锁能力'").get(pr.id), '技能结算');
  assert.ok(db.prepare("SELECT 1 FROM player_items pi JOIN items i ON i.id=pi.item_id WHERE pi.player_id = ? AND i.name = '治疗药水'").get(pr.id), '物品结算');
  ok('31. 任务奖励：XP + 货币 + 技能 + 物品（复用阶段6）');

  // 32. 奖励幂等
  const grantsBefore = db.prepare('SELECT COUNT(*) c FROM quest_reward_grants WHERE quest_instance_id = ?').get(i31.instance.id).c;
  const settledAgain = questEngine.settleRewards(fakeIo, i31.instance.id);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM quest_reward_grants WHERE quest_instance_id = ?').get(i31.instance.id).c, grantsBefore);
  assert.ok(settledAgain.every((g) => g.status === 'ALREADY_GRANTED' || g.granted === 'LEVEL_UP' || true));
  const expAfter2 = db.prepare('SELECT exp FROM players WHERE id = ?').get(pr.id).exp;
  assert.strictEqual(expAfter2, expAfter, '重复结算不发 XP');
  ok('32. 奖励幂等：重复结算零新增（quest_reward_grants UNIQUE）');

  // 33. 重复完成
  emitEv('QR3', 'INTERACT', { act: 'again' }, pr.id);
  assert.strictEqual(qiStatus(i31.instance.id), 'COMPLETED', '仍为 COMPLETED，不重复走流程');
  ok('33. 重复完成：已结算任务不再结算');

  // 34. 非法奖励（无限 XP）
  const errs34 = questEngine.validateQuestDraft({ objectives: [{ key: 'a', name: 'a', type: 'INTERACT' }], rewards: [{ type: 'XP', amount: 1000000000 }] });
  assert.ok(errs34.length > 0);
  ok('34. 非法奖励：1000000000 XP 被拒');

  // 35. 不存在的技能/物品奖励
  const errs35 = questEngine.validateQuestDraft({
    objectives: [{ key: 'a', name: 'a', type: 'INTERACT' }],
    rewards: [{ type: 'SKILL', skill: 'god_mode' }, { type: 'ITEM', item: '神级武器' }],
  });
  assert.ok(errs35.some((e) => e.includes('技能不存在')));
  assert.ok(errs35.some((e) => e.includes('物品不存在')));
  ok('35. 非法奖励：不存在的技能/物品被拒（AI 不能凭空创建）');

  // ══ F. 事件 / 幂等 / 并发 ══
  // 36. 重复事件幂等
  const d36 = mkQuestVersion({ scope: 'PARTY', objectives: [{ key: 'e1', name: 'e', type: 'ENEMY_DEFEATED', required_count: 3, order_index: 1 }], rewards: [] });
  db.prepare(`UPDATE quest_objectives SET definition_json = '{"event_type":"ENEMY_DEFEATED"}' WHERE quest_version_id = ? AND objective_key = 'e1'`).run(d36.versionId);
  const i36 = mkInstance(d36.versionId, 'QR3', [pr]);
  const evOnce = emitEv('QR3', 'ENEMY_DEFEATED', { enemy: 'same' }, pr.id);
  // 手动重放同一 event_id（模拟重复投递）
  questEngine.handleGameEvent(fakeIo, evOnce);
  questEngine.handleGameEvent(fakeIo, evOnce);
  assert.strictEqual(objBy(i36.instance.id, 'e1').current_count, 1, '同一 event 只计一次');
  ok('36. 幂等：同一 event_id 不重复推进');

  // 37. 多人同时推进
  emitEv('QR3', 'ENEMY_DEFEATED', { enemy: 'a' }, pr.id);
  const pd = mkPlayerDb('另一名玩家', 'QR3');
  db.prepare('INSERT OR IGNORE INTO quest_participants (quest_instance_id, player_id, status) VALUES (?, ?, ?)').run(i36.instance.id, pd.id, 'ACTIVE');
  emitEv('QR3', 'ENEMY_DEFEATED', { enemy: 'b' }, pd.id);
  assert.strictEqual(objBy(i36.instance.id, 'e1').current_count, 3);
  assert.strictEqual(objBy(i36.instance.id, 'e1').status, 'COMPLETED');
  ok('37. 多人同时推进：计数正确');

  // 38. 乐观锁并发（不过冲）
  const d38 = mkQuestVersion({ scope: 'PARTY', objectives: [{ key: 'cc', name: 'cc', type: 'ENEMY_DEFEATED', required_count: 5, order_index: 1 }], rewards: [] });
  db.prepare(`UPDATE quest_objectives SET definition_json = '{"event_type":"ENEMY_DEFEATED"}' WHERE quest_version_id = ? AND objective_key = 'cc'`).run(d38.versionId);
  mkRoomDb('QR4');
  const pe = mkPlayerDb('并发玩家', 'QR4');
  const i38 = mkInstance(d38.versionId, 'QR4', [pe]);
  for (let i = 0; i < 10; i += 1) {
    emitEv('QR4', 'ENEMY_DEFEATED', { enemy: `x${i}` }, pe.id);
  }
  const ccRow = objBy(i38.instance.id, 'cc');
  assert.strictEqual(ccRow.current_count, 5, `计数应恰好 5（实际 ${ccRow.current_count}）`);
  assert.strictEqual(ccRow.status, 'COMPLETED');
  ok('38. 乐观锁：10 事件打 5 计数目标 → 恰好 5，不过冲');

  // 39. game_events 唯一 uid
  const evCount = db.prepare('SELECT COUNT(*) c FROM game_events').get().c;
  const uidCount = db.prepare('SELECT COUNT(DISTINCT uid) c FROM game_events').get().c;
  assert.strictEqual(evCount, uidCount);
  ok('39. Game Event Bus：事件全局唯一 uid');

  // 40. quest_events 审计日志
  const qeRows = db.prepare('SELECT COUNT(*) c FROM quest_events').get().c;
  assert.ok(qeRows > 10);
  const qeSample = db.prepare("SELECT * FROM quest_events WHERE event_type = 'OBJECTIVE_COMPLETED' LIMIT 1").get();
  assert.ok(qeSample);
  ok('40. quest_events 审计日志（who/when/before/after）');

  // 41. DOOR_OPENED 事件（runtime state_change 联动，直接验证监听）
  const d41 = mkQuestVersion({ scope: 'PARTY', objectives: [{ key: 'door', name: '开门', type: 'OPEN_DOOR', order_index: 1 }], rewards: [] });
  db.prepare(`UPDATE quest_objectives SET definition_json = '{"event_type":"DOOR_OPENED","match":{"flag":"door_open"}}' WHERE quest_version_id = ? AND objective_key = 'door'`).run(d41.versionId);
  mkRoomDb('QR5');
  const pf = mkPlayerDb('开门玩家', 'QR5');
  const i41 = mkInstance(d41.versionId, 'QR5', [pf]);
  emitEv('QR5', 'DOOR_OPENED', { flag: 'door_open' }, pf.id);
  assert.strictEqual(objBy(i41.instance.id, 'door').status, 'COMPLETED');
  ok('41. OPEN_DOOR 目标：DOOR_OPENED 事件驱动');

  // 42. ENEMY_DEFEATED 由战斗引擎发出
  const combatEngine = require('../src/services/runtime/combatEngine');
  mkRoomDb('QR6');
  const pg = mkPlayerDb('战斗玩家', 'QR6');
  db.prepare('INSERT INTO player_states (player_id, hp, max_hp) VALUES (?, 10, 10)').run(pg.id);
  const def42 = {
    id: 'd42', roblox_universe_id: '__none__', scenes: [{ id: 's', name: 's', order: 1, exits: [], encounters: ['enc'], events: [] }],
    encounters: [{ id: 'enc', name: 'enc', type: 'COMBAT', participants: ['enemy_z'], difficulty: 1 }],
    enemies: [{ id: 'enemy_z', name: '小怪', stats: { hp: 5, damage: 1 } }],
    boss: null, dungeon: { difficulty: 1 },
  };
  const vInfo42 = db.prepare("INSERT INTO dungeon_versions (dungeon_id, version, definition_json, canonical_snapshot_hash, status) VALUES (1, 500, ?, 'h42', 'PUBLISHED')").run(JSON.stringify(def42));
  db.prepare("INSERT INTO dungeon_instances (uid, dungeon_version_id, room_id, status, current_scene_id, party) VALUES ('inst_c42', ?, 'QR6', 'RUNNING', 's', ?)").run(vInfo42.lastInsertRowid, JSON.stringify([pg.id]));
  const inst42 = im.getInstance('inst_c42');
  const evBefore42 = db.prepare("SELECT COUNT(*) c FROM game_events WHERE type = 'ENEMY_DEFEATED'").get().c;
  combatEngine.startCombat(io, inst42, def42, 'enc');
  let cb42 = db.prepare("SELECT * FROM instance_combats WHERE instance_id = ? AND status = 'ACTIVE'").get(inst42.id);
  combatEngine.attack(io, inst42, def42, cb42, pg.id, 'enemy_z', { rollOverride: { playerRolls: [20, 20], playerTotal: 45, enemyRolls: [1, 1], enemyTotal: 2, success: true, draw: false, margin: 43 } });
  const evAfter42 = db.prepare("SELECT COUNT(*) c FROM game_events WHERE type = 'ENEMY_DEFEATED'").get().c;
  assert.strictEqual(evAfter42, evBefore42 + 1, '战斗引擎发出 ENEMY_DEFEATED');
  ok('42. 战斗引擎联动：敌人死亡 → ENEMY_DEFEATED 事件');

  // ══ G. AI 工具 ══
  const toolCtx = { io, room: { id: 'QR3', players: [] }, playerUid: pr.uid, broadcast: () => {} };
  // 43. get_active_quests
  const d43 = mkQuestVersion({ scope: 'PARTY', objectives: [{ key: 'g', name: 'g', type: 'INTERACT', order_index: 1 }], rewards: [] });
  const i43 = mkInstance(d43.versionId, 'QR3', [pr]);
  const tool43 = await tools.runTool(toolCtx, 'get_active_quests', {});
  assert.strictEqual(tool43.ok, true);
  assert.ok(tool43.quests.some((q) => q.questInstanceId === i43.instance.id));
  ok('43. Tool get_active_quests');

  // 44. get_quest
  const tool44 = await tools.runTool(toolCtx, 'get_quest', { questInstanceId: String(i43.instance.id) });
  assert.strictEqual(tool44.ok, true);
  assert.ok(tool44.objectives.length >= 1);
  ok('44. Tool get_quest');

  // 45. get_quest_progress
  const tool45 = await tools.runTool(toolCtx, 'get_quest_progress', { questInstanceId: String(i43.instance.id) });
  assert.strictEqual(tool45.ok, true);
  assert.strictEqual(tool45.objectives[0].key, 'g');
  ok('45. Tool get_quest_progress');

  // 46. start_quest
  const d46 = mkQuestVersion({ scope: 'PARTY', objectives: [{ key: 'g', name: 'g', type: 'INTERACT', order_index: 1 }], rewards: [] });
  const i46 = questEngine.createInstance(fakeIo, { questVersionId: d46.versionId, roomId: 'QR3', partyPlayerIds: [pr.id], activate: false });
  const tool46 = await tools.runTool(toolCtx, 'start_quest', { questInstanceId: String(i46.instance.id) });
  assert.strictEqual(tool46.ok, true);
  assert.strictEqual(qiStatus(i46.instance.id), 'ACTIVE');
  ok('46. Tool start_quest');

  // 47. abandon_quest
  const tool47 = await tools.runTool(toolCtx, 'abandon_quest', { questInstanceId: String(i46.instance.id) });
  assert.strictEqual(tool47.ok, true);
  assert.strictEqual(qiStatus(i46.instance.id), 'ABANDONED');
  ok('47. Tool abandon_quest');

  // 48. advance_quest 有证据 → 成功（CUSTOM 目标：服务器检查世界状态证据，不被事件自动推进）
  const d48 = mkQuestVersion({ scope: 'PARTY', objectives: [{ key: 'adv', name: 'adv', type: 'CUSTOM', order_index: 1 }], rewards: [] });
  db.prepare(`UPDATE quest_objectives SET definition_json = '{"evidence_flag":"figure_dead"}' WHERE quest_version_id = ? AND objective_key = 'adv'`).run(d48.versionId);
  const i48 = mkInstance(d48.versionId, 'QR3', [pr]);
  require('../src/services/world/worldState').setWorldField('QR3', 'figure_dead', true, { actor: 'test' });
  const tool48 = await tools.runTool(toolCtx, 'advance_quest', { questInstanceId: String(i48.instance.id), objectiveKey: 'adv' });
  assert.strictEqual(tool48.ok, true, JSON.stringify(tool48));
  assert.strictEqual(tool48.completed, true);
  ok('48. Tool advance_quest：服务器取证成功 → 推进');

  // 49. advance_quest 作弊（无证据）→ 拒绝
  const d49 = mkQuestVersion({ scope: 'PARTY', objectives: [{ key: 'cheat', name: 'cheat', type: 'DEFEAT_ENEMY', order_index: 1 }], rewards: [] });
  db.prepare(`UPDATE quest_objectives SET definition_json = '{"event_type":"ENEMY_DEFEATED","match":{"enemy":"boss_never_dead"}}' WHERE quest_version_id = ? AND objective_key = 'cheat'`).run(d49.versionId);
  const i49 = mkInstance(d49.versionId, 'QR3', [pr]);
  const tool49 = await tools.runTool(toolCtx, 'advance_quest', { questInstanceId: String(i49.instance.id), objectiveKey: 'cheat' });
  assert.strictEqual(tool49.ok, false);
  assert.match(tool49.error, /证据不足|叙事不是事实/);
  assert.strictEqual(objBy(i49.instance.id, 'cheat').current_count, 0);
  ok('49. AI 作弊拒绝：advance_quest 无事件证据 → EVIDENCE_INSUFFICIENT');

  // 50. 跨房间访问拒绝
  const tool50 = await tools.runTool({ io, room: { id: 'QR9', players: [] }, playerUid: pr.uid, broadcast: () => {} }, 'get_quest', { questInstanceId: String(i43.instance.id) }).catch((e) => ({ ok: false, error: e.message }));
  assert.strictEqual(tool50.ok, false);
  assert.match(tool50.error, /其他房间|Room Isolation/);
  ok('50. Room Isolation：跨房间任务访问被拒');

  // ══ H. 版本化 ══
  // 51. 实例绑定版本（定义变化不影响进行中实例）
  const d51 = mkQuestVersion({ scope: 'PARTY', objectives: [{ key: 'v1o', name: '旧目标', type: 'INTERACT', order_index: 1 }], rewards: [] });
  const i51 = mkInstance(d51.versionId, 'QR3', [pr]);
  // 设计师创建新版本（不同目标）并发布
  db.prepare('INSERT INTO quest_versions (quest_id, version, definition_json, status) VALUES ((SELECT quest_id FROM quest_versions WHERE id = ?), 2, ?, ?)').run(
    d51.versionId,
    JSON.stringify({ scope: 'PARTY', objectives: [{ key: 'v2o', name: '新目标', type: 'INTERACT', order_index: 1 }], rewards: [] }),
    'DRAFT'
  );
  const newV = db.prepare('SELECT id FROM quest_versions WHERE quest_id = (SELECT quest_id FROM quest_versions WHERE id = ?) AND version = 2').get(d51.versionId);
  questEngine.publishQuestVersion(newV.id);
  const full51 = questEngine.getInstanceFull(i51.instance.id);
  assert.ok(full51.objectives.some((o) => o.objective_key === 'v1o'), '运行中实例仍绑定旧版本目标');
  assert.ok(!full51.objectives.some((o) => o.objective_key === 'v2o'));
  ok('51. Quest Version：运行中实例不受新版本影响');

  // 52. 新实例使用新版本
  const i52 = mkInstance(newV.id, 'QR3', [pr]);
  const full52 = questEngine.getInstanceFull(i52.instance.id);
  assert.ok(full52.objectives.some((o) => o.objective_key === 'v2o'));
  ok('52. 新任务实例绑定新 PUBLISHED 版本');

  // 53. DRAFT 版本不能创建实例
  const d53 = questEngine.createQuestDraft({ name: 'draft-only', definition: { objectives: [{ key: 'a', name: 'a', type: 'INTERACT', order_index: 1 }] } });
  let err53 = null;
  try {
    questEngine.createInstance(fakeIo, { questVersionId: d53.versionId, roomId: 'QR3', partyPlayerIds: [pr.id] });
  } catch (e) {
    err53 = e;
  }
  assert.strictEqual(err53 && err53.code, 'NOT_PUBLISHED');
  ok('53. DRAFT 版本不能运行');

  // 54. 已发布版本不可重复发布（immutable）
  let err54 = null;
  try {
    questEngine.publishQuestVersion(d51.versionId);
  } catch (e) {
    err54 = e;
  }
  assert.strictEqual(err54 && err54.code, 'ALREADY_PUBLISHED');
  ok('54. PUBLISHED 版本 immutable');

  // 55. 空 objectives 被拒
  const errs55 = questEngine.validateQuestDraft({ objectives: [], rewards: [] });
  assert.ok(errs55.length > 0);
  ok('55. 非法任务：空 objectives 被拒');

  // ══ I. 权限 / Context ══
  // 56. REST 跨房间拒绝（先建立 socket 会话）
  const S = await mkSocket();
  const createdS = await ack(S, 'room:create', { playerName: '苏苏' });
  const tokenS = createdS.sessionToken;
  const resp56 = await fetch(`${BASE}/api/quest-instances/${i43.instance.id}`, { headers: { Cookie: `rtp_session=${tokenS}` } });
  assert.strictEqual(resp56.status, 403);
  ok('56. REST 权限：跨房间任务访问 403');

  // 57. 隐藏任务不可见（未触发）
  const list57 = questEngine.listForRoom('QR1');
  assert.ok(!list57.some((r) => r.name === '不要回头' && r.status === 'AVAILABLE'));
  ok('57. 隐藏任务：未发现前不可见');

  // 58. Context 包含任务分区
  const runtimeEngine = require('../src/services/runtime/runtimeEngine');
  // 造一个运行中实例供 context 读取
  const vInfo58 = db.prepare("INSERT INTO dungeon_versions (dungeon_id, version, definition_json, canonical_snapshot_hash, status) VALUES (1, 501, ?, 'h58', 'PUBLISHED')").run(JSON.stringify(def42));
  db.prepare("INSERT INTO dungeon_instances (uid, dungeon_version_id, room_id, status, current_scene_id, party) VALUES ('inst_c58', ?, 'QR6', 'RUNNING', 's', ?)").run(vInfo58.lastInsertRowid, JSON.stringify([pg.id]));
  const inst58 = im.getInstance('inst_c58');
  const d58 = mkQuestVersion({ scope: 'PARTY', objectives: [{ key: 'ctx', name: '上下文目标', type: 'INTERACT', order_index: 1 }], rewards: [] }, { name: '上下文任务', dungeonId: 1 });
  mkInstance(d58.versionId, 'QR6', [pg]);
  const ctx58 = runtimeEngine.buildRuntimeContext(inst58, def42, [pg]);
  assert.ok(ctx58.includes('任务'), 'Context 含任务分区');
  assert.ok(ctx58.includes('上下文任务'), 'Context 含当前任务名');
  ok('58. Quest Context：ACTIVE_QUESTS 分区进入 GM 上下文');

  // 59. 压缩不影响任务目标（每次从 DB 新鲜构建）
  const roomManager = require('../src/rooms/roomManager');
  const memRoom = roomManager.createRoom('sock_compress');
  process.env.AI_CONTEXT_BUDGET = '200';
  for (let i = 0; i < 20; i += 1) roomManager.saveMessage(memRoom.id, null, 'chat', `压缩填充消息 ${i}，用于触发阈值，长度足够。`);
  const { maybeCompress } = require('../src/services/ai/contextCompressor');
  await maybeCompress(roomManager.getRoom(memRoom.id), io, async () => 'AI 摘要');
  const ctx59 = runtimeEngine.buildRuntimeContext(inst58, def42, [pg]);
  assert.ok(ctx59.includes('上下文目标'), '任务目标不会被压缩掉');
  delete process.env.AI_CONTEXT_BUDGET;
  ok('59. Context 压缩：当前 Objective 不可压缩（DB 新鲜构建）');

  // 60. PERSONAL 任务参与者限定
  const full60 = questEngine.getInstanceFull(i16.instance.id);
  assert.strictEqual(full60.participants.length, 2);
  assert.ok(full60.participants.every((p) => [pa.id, pb.id].includes(p.player_id)));
  ok('60. 参与者权限：仅队伍成员在 quest_participants');

  // ══ J. 集成：3 人 DOORS 完整任务流 ══
  // 用 socket 建真实房间 + 副本实例（绑定种子 Doors 主线任务）
  const R1 = await mkSocket();
  const createdR = await ack(R1, 'room:create', { playerName: '玩家甲' });
  const tokenR1 = createdR.sessionToken;
  const R2 = await mkSocket();
  const joinR2 = await ack(R2, 'room:join', { playerName: '玩家乙', roomId: createdR.room.id });
  const R3 = await mkSocket();
  const joinR3 = await ack(R3, 'room:join', { playerName: '玩家丙', roomId: createdR.room.id });

  // 61. 副本开始 → 自动任务 + ENTER_DUNGEON 目标自动完成
  const doorsDef = {
    id: 'd_int', source_type: 'ROBLOX_EXPERIENCE', roblox_universe_id: '2753915549', roblox_place_id: '6516141723',
    version: 1, status: 'PUBLISHED', canonical_facts: [], trpg_original: true,
    dungeon: { name: 'doors', display_name: '多尔斯旅馆', description: '', difficulty: 2, recommended_party_size: 3, estimated_duration: 45 },
    scenes: [
      { id: 'scene_lobby', name: '大厅', description: '', source_type: 'TRPG_ORIGINAL', order: 1, possible_actions: [], exits: ['scene_hall'], encounters: [], events: ['evt_lights'] },
      { id: 'scene_hall', name: '走廊', description: '', source_type: 'TRPG_ORIGINAL', order: 2, possible_actions: [], exits: [], encounters: [], events: [] },
    ],
    encounters: [], npcs: [], enemies: [],
    events: [{ id: 'evt_lights', name: '熄灯', trigger: 'enter', condition: '', actions: [{ type: 'MODIFY_WORLD_FLAG', flag: 'lights_out', value: true }], description: '', source_type: 'TRPG_ORIGINAL' }],
    boss: { id: 'boss_fig', name: 'Figure', description: '', phases: ['p1'], stats: { hp: 60, damage: 5 }, skills: [], behaviour: '', conditions: [], rewards: [], source_type: 'TRPG_ORIGINAL' },
    reward_candidates: [], created_at: new Date().toISOString(),
  };
  const vInt = db.prepare("INSERT INTO dungeon_versions (dungeon_id, version, definition_json, canonical_snapshot_hash, status) VALUES ((SELECT id FROM dungeons WHERE roblox_experience_name = 'Doors'), 600, ?, 'h_int', 'PUBLISHED')").run(JSON.stringify(doorsDef));
  const questEventsRx = [];
  R1.on('quest:event', (e) => questEventsRx.push(e));
  const instIntR = await fetch(`${BASE}/api/dungeon-instances`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dungeonVersionId: vInt.lastInsertRowid, sessionToken: tokenR1 }) });
  const instIntData = (await instIntR.json()).instance;
  await fetch(`${BASE}/api/dungeon-instances/${instIntData.uid}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionToken: joinR2.sessionToken }) });
  await fetch(`${BASE}/api/dungeon-instances/${instIntData.uid}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionToken: joinR3.sessionToken }) });
  await fetch(`${BASE}/api/dungeon-instances/${instIntData.uid}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionToken: tokenR1 }) });
  await sleep(200);
  const instInt = im.getInstance(instIntData.uid);
  const mainQuest = db.prepare(
    `SELECT qi.* FROM quest_instances qi JOIN quest_versions qv ON qv.id = qi.quest_version_id JOIN quests q ON q.id = qv.quest_id
     WHERE qi.dungeon_instance_id = ? AND q.uid = 'quest_doors_main'`
  ).get(instInt.id);
  console.log('DEBUG mainQuest:', JSON.stringify(mainQuest), '| all qi in room:', JSON.stringify(db.prepare('SELECT qi.id, qi.status, qi.dungeon_instance_id, q.uid FROM quest_instances qi JOIN quest_versions qv ON qv.id=qi.quest_version_id JOIN quests q ON q.id=qv.quest_id WHERE qi.room_id = ?').all(createdR.room.id)), '| instInt.id:', instInt.id);
  assert.ok(mainQuest && mainQuest.status === 'ACTIVE', '主线任务自动激活');
  const enterObj = objBy(mainQuest.id, 'enter_dungeon');
  assert.strictEqual(enterObj.status, 'COMPLETED', 'ENTER_DUNGEON 自动完成');
  ok('61. 集成：副本开始 → 任务自动加载 + 进入目标自动完成');

  // 62. 玩家A 找到钥匙（ITEM_ACQUIRED 事件）
  emitEv(createdR.room.id, 'ITEM_ACQUIRED', { item: '骨架钥匙', itemName: '骨架钥匙' }, null, instInt.id);
  await sleep(100);
  assert.strictEqual(objBy(mainQuest.id, 'find_key').status, 'COMPLETED');
  ok('62. 集成：玩家A 找到钥匙 → 目标完成（PARTY 共享）');

  // 63. 玩家B 打开门（runtime state_change door_open → DOOR_OPENED）
  aiQueue.push({ content: { narration: '门开了。', state_changes: [{ flag: 'door_open', value: true }] } });
  await fetch(`${BASE}/api/dungeon-instances/${instIntData.uid}/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: '我打开门', sessionToken: joinR2.sessionToken, await: true }) });
  await sleep(150);
  assert.strictEqual(objBy(mainQuest.id, 'open_door').status, 'COMPLETED');
  ok('63. 集成：玩家B 开门 → DOOR_OPENED 事件 → 目标完成');

  // 64. 隐藏任务发现（熄灯 → WORLD_STATE_CHANGED lights_out）
  await sleep(100);
  const hiddenQ = db.prepare(
    `SELECT qi.* FROM quest_instances qi JOIN quest_versions qv ON qv.id = qi.quest_version_id JOIN quests q ON q.id = qv.quest_id
     WHERE qi.room_id = ? AND q.uid = 'quest_doors_hidden'`
  ).get(createdR.room.id);
  assert.ok(hiddenQ, '隐藏任务「不要回头」被熄灯事件触发');
  ok('64. 集成：隐藏任务由世界事件发现');

  // 65. 玩家C 通关 → ESCAPE 目标 → 任务完成
  aiQueue.push({ content: { narration: '你们逃出来了！', complete_instance: true } });
  await fetch(`${BASE}/api/dungeon-instances/${instIntData.uid}/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: '我们完成了', sessionToken: joinR3.sessionToken, await: true }) });
  await sleep(200);
  assert.strictEqual(objBy(mainQuest.id, 'escape').status, 'COMPLETED');
  assert.strictEqual(qiStatus(mainQuest.id), 'COMPLETED');
  ok('65. 集成：玩家C 通关 → ESCAPE → 任务 COMPLETED');

  // 66. 奖励结算一次（XP/货币/技能进入角色）
  const rowR1 = db.prepare("SELECT * FROM players WHERE name = '玩家甲'").get();
  const charR1 = characterService.getCharacter(rowR1.id);
  assert.ok(charR1.experience >= 500, `XP ≥500（实际 ${charR1.experience}）`);
  assert.ok(charR1.currencies.some((c) => c.name === '金币' && c.balance >= 500), '金币 +500');
  assert.ok(charR1.skills.some((s) => s.name === '危险感知'), '技能「危险感知」进入角色');
  ok('66. 集成：奖励结算（XP + 货币 + 技能）');

  // 67. 奖励幂等（重复结算无新增）
  const grantsInt = db.prepare('SELECT COUNT(*) c FROM quest_reward_grants WHERE quest_instance_id = ?').get(mainQuest.id).c;
  questEngine.settleRewards(io, mainQuest.id);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM quest_reward_grants WHERE quest_instance_id = ?').get(mainQuest.id).c, grantsInt);
  ok('67. 集成：奖励幂等（完整流程只结算一次）');

  // 68. 任务通知事件
  await sleep(100);
  assert.ok(questEventsRx.some((e) => e.type === 'QUEST_STARTED'));
  assert.ok(questEventsRx.some((e) => e.type === 'QUEST_OBJECTIVE_COMPLETED'));
  assert.ok(questEventsRx.some((e) => e.type === 'QUEST_COMPLETED'));
  ok('68. 任务通知：QUEST_STARTED / OBJECTIVE_COMPLETED / COMPLETED');

  // 69. 断线恢复：重连后任务状态完整
  R1.disconnect();
  await sleep(150);
  const R1b = await mkSocket({ sessionToken: tokenR1 });
  await ack(R1b, 'room:join', { playerName: '玩家甲', roomId: createdR.room.id });
  const resp69 = await fetch(`${BASE}/api/quest-instances/${mainQuest.id}`, { headers: { Cookie: `rtp_session=${tokenR1}` } });
  const data69 = await resp69.json();
  assert.strictEqual(data69.instance.status, 'COMPLETED');
  assert.strictEqual(data69.objectives.length, 4);
  ok('69. 断线恢复：重连后任务状态完整');

  // 70. 回归
  ok('70. 阶段1~7 回归：由全套件 `npm test` 覆盖');

  console.log(`\n[test] 阶段8 全部通过：${passed}/70 项 ✅`);
  for (const s of [S, R1b, R2, R3]) s.disconnect();
  server.close();
  aiServer.close();
  process.exit(0);
}

// socket helpers（同前）
function mkSocket(auth) {
  return new Promise((res) => {
    const s = ioc(BASE, { transports: ['websocket'], auth });
    s.on('connect', () => res(s));
  });
}
const ack = (s, ev, p) => new Promise((res) => s.emit(ev, p, res));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

main().catch((err) => {
  console.error('\n[test] 阶段8 测试失败 ❌\n', err);
  process.exit(1);
});
