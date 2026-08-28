/**
 * 阶段31 测试：Context 上限随后台设置 / AI 按钮 @AI / 解绑彻底重置与换绑重识别 /
 * chat:history 分页（聊天框滚动加载）/ 副本进程进大聊天框（26 项）。
 */
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

for (const suffix of ['', '-wal', '-shm', '-journal']) {
  fs.rmSync(path.join(__dirname, '../../database/data/roblox_trpg.db' + suffix), { force: true });
}

process.env.AI_API_KEY = 'ai-key-s31';
process.env.AI_BASE_URL = 'http://127.0.0.1:3532/v1';
process.env.AI_MODEL = 'mock-s31';
process.env.AI_STREAM = 'off';
process.env.AI_RATE_PER_PLAYER = '1000';
process.env.AI_RATE_PER_ROOM = '1000';

const { io: ioc } = require('socket.io-client');
const { server } = require('../src/index.js');
const { getDb } = require('@roblox-trpg/database');
const roomManager = require('../src/rooms/roomManager');
const settingsService = require('../src/services/settingsService');
const { initializeAvatar, resetToBacon } = require('../src/services/vision/initializeAvatar');
const { maybeCompress } = require('../src/services/ai/contextCompressor');
const { buildContext } = require('../src/services/ai/contextBuilder');

const PORT = 3531;
const BASE = `http://localhost:${PORT}`;
let passed = 0;
const ok = (label) => {
  passed += 1;
  console.log(`  ✓ ${label}`);
};

// ── mock AI 网关（文本 GM + Vision 共用 /v1/chat/completions；Vision 调用计数）──
let visionCalls = 0;
const aiServer = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    const isVision = /image_url/.test(b);
    if (isVision) visionCalls += 1;
    const reply = isVision
      ? JSON.stringify({
          candidate_tags: ['military', 'armor'],
          confidence: { military: 0.9, armor: 0.8 },
          candidate_skill_ids: [],
          reasoning: '战术装备外观',
        })
      : JSON.stringify({ narration: '叙述。', action_result: 'SUCCESS', options: [] });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: reply }, finish_reason: 'stop' }], usage: { total_tokens: 100 } }));
  });
});

// ── 固定副本（同阶段5 精简版）──
function definitionFixture() {
  return {
    id: 'dungeon_s31',
    source_type: 'ROBLOX_EXPERIENCE',
    roblox_universe_id: '55550031',
    roblox_place_id: '55550032',
    version: 1,
    status: 'PUBLISHED',
    canonical_facts: [{ key: 'name', value: 'S31 Dungeon', source: 'roblox_api' }],
    trpg_original: true,
    dungeon: { name: 's31', display_name: 'S31副本', description: '测试', difficulty: 3, recommended_party_size: 2, estimated_duration: 30 },
    scenes: [
      { id: 'scene_a', name: '大厅', description: '旅馆大厅', source_type: 'TRPG_ORIGINAL', order: 1, possible_actions: [], exits: ['scene_b'], encounters: ['enc_1'], events: [] },
      { id: 'scene_b', name: '走廊', description: '黑暗走廊', source_type: 'TRPG_ORIGINAL', order: 2, possible_actions: [], exits: [], encounters: [], events: [] },
    ],
    encounters: [
      { id: 'enc_1', name: '暗影遭遇', type: 'COMBAT', description: '', participants: ['enemy_1'], trigger: '', resolution: '', difficulty: 3, possible_checks: [], source_type: 'TRPG_ORIGINAL' },
    ],
    npcs: [],
    enemies: [{ id: 'enemy_1', name: '暗影', description: '', source_type: 'TRPG_ORIGINAL', stats: { hp: 30, damage: 3 }, skills: [], behaviour: '', weaknesses: [], resistances: [], loot: [] }],
    events: [],
    boss: null,
    reward_candidates: [],
    created_at: new Date().toISOString(),
  };
}

function seedPublishedDungeon() {
  const db = getDb();
  const dInfo = db
    .prepare("INSERT INTO dungeons (uid, roblox_experience_name, roblox_universe_id, roblox_place_id, dungeon_name, difficulty, description) VALUES ('dungeon_s31', 'S31 Exp', '55550031', '55550032', 'S31副本', 3, '测试')")
    .run();
  const vInfo = db
    .prepare("INSERT INTO dungeon_versions (dungeon_id, version, definition_json, canonical_snapshot_hash, status) VALUES (?, 1, ?, 'hash_s31', 'PUBLISHED')")
    .run(dInfo.lastInsertRowid, JSON.stringify(definitionFixture()));
  return { dungeonId: dInfo.lastInsertRowid, versionId: vInfo.lastInsertRowid };
}

async function mkSocket() {
  return new Promise((res) => {
    const s = ioc(BASE, { transports: ['websocket'] });
    s.on('connect', () => res(s));
  });
}
function ack(s, event, payload) {
  return new Promise((res) => s.emit(event, payload, res));
}
async function post(p, body) {
  const r = await fetch(`${BASE}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
const fakeIo = { to: () => ({ emit: () => {} }), emit: () => {} };

async function main() {
  const db = getDb();
  console.log('[test] 阶段31 就绪（26 项）\n');
  await Promise.all([new Promise((r) => aiServer.listen(3532, '127.0.0.1', r)), new Promise((r) => server.listen(PORT, r))]);
  settingsService.setSettings({ 'vision.base_url': 'http://127.0.0.1:3532/v1', 'vision.api_key': 'vk-s31', 'vision.model': 'vision-mock-31' });

  // ── 房间与玩家：甲（房主）+ 乙 ──
  const A = await mkSocket();
  const created = await ack(A, 'room:create', { playerName: '甲' });
  const tokenA = created.sessionToken;
  const B = await mkSocket();
  const joinB = await ack(B, 'room:join', { playerName: '乙', roomId: created.room.id });
  const tokenB = joinB.sessionToken;
  const roomId = created.room.id;
  await sleep(300); // 等入房 bacon 异步初始化

  // ══ A. Context 上限随后台设置实时变化 ══
  settingsService.setSettings({ 'ai.context_budget': '55555' });
  let cv = await ack(A, 'context:view', {});
  assert.strictEqual(cv.budget, 55555);
  ok('1. context:view 上限取自后台设置（55555）而非 env 默认');

  settingsService.setSetting('ai.context_budget', ''); // 清除 → 回落 env/默认
  cv = await ack(A, 'context:view', {});
  assert.strictEqual(cv.budget, 100000);
  ok('2. 清除设置 → 回落默认 100000');

  const roomObj = roomManager.getRoom(roomId);
  roomObj.contextFlags = { warned70: true, prepared80: true };
  const note = await maybeCompress(roomObj, fakeIo, async () => '摘要');
  assert.strictEqual(roomObj.contextFlags.warned70, false);
  assert.strictEqual(roomObj.contextFlags.prepared80, false);
  assert.strictEqual(note, null);
  ok('3. 预算上调后比例回落 → 粘滞的压缩阈值标记被清除');

  // ══ B. chat:history 分页 ══
  const outsider = await mkSocket();
  let h = await ack(outsider, 'chat:history', {});
  assert.strictEqual(h.ok, false);
  ok('4. 未入房 → chat:history 拒绝');

  const ids = [];
  for (let i = 1; i <= 12; i += 1) ids.push(roomManager.saveMessage(roomId, null, 'system', `S${i}`));
  h = await ack(A, 'chat:history', {});
  assert.strictEqual(h.ok, true);
  assert.ok(h.messages.length >= 12); // 12 条种子 + 入房等系统消息
  assert.strictEqual(h.messages[h.messages.length - 1].text, 'S12');
  assert.strictEqual(h.hasMore, false);
  ok('5. 默认拉取全部近期消息（升序，最新在尾）');

  h = await ack(A, 'chat:history', { limit: 5 });
  assert.strictEqual(h.messages.length, 5);
  assert.strictEqual(h.messages[4].text, 'S12');
  assert.strictEqual(h.messages[0].text, 'S8');
  assert.strictEqual(h.hasMore, true);
  ok('6. limit=5 → 最新 5 条升序 + hasMore=true');

  h = await ack(A, 'chat:history', { beforeId: h.messages[0].id, limit: 5 });
  assert.strictEqual(h.messages.length, 5);
  assert.strictEqual(h.messages[0].text, 'S3');
  assert.strictEqual(h.messages[4].text, 'S7');
  ok('7. beforeId 分页 → 上一页 5 条（S3..S7）');

  const oldest = h.messages[0].id;
  h = await ack(A, 'chat:history', { beforeId: oldest, limit: 5 });
  assert.ok(h.messages.length >= 1 && h.messages.every((m) => m.id < oldest)); // 更早的入房系统消息
  assert.strictEqual(h.hasMore, false);
  ok('8. 翻到最早 → 只剩更早的系统消息且 hasMore=false');

  const rowA = roomManager.getPlayerRow(A.id);
  roomManager.saveMessage(roomId, rowA.id, 'chat', '大家好');
  roomManager.saveMessage(roomId, null, 'gm', 'GM 叙事正文');
  roomManager.saveMessage(roomId, null, 'dungeon', '⚔ 副本「S31副本」开始');
  h = await ack(A, 'chat:history', { limit: 3 });
  const [chatMsg, gmMsg, dMsg] = h.messages; // 升序：chat → gm → dungeon（最新在尾）
  assert.strictEqual(dMsg.type, 'dungeon') && assert.strictEqual(dMsg.text, '⚔ 副本「S31副本」开始');
  assert.strictEqual(gmMsg.type, 'gm') && assert.strictEqual(gmMsg.narrative, 'GM 叙事正文');
  assert.strictEqual(chatMsg.type, 'chat') && assert.strictEqual(chatMsg.playerName, '甲') && assert.strictEqual(chatMsg.text, '大家好');
  ok('9. 类型映射：dungeon 纯文本 / gm→narrative / chat→playerName');

  // ══ C. 解绑彻底重置（AI 不再引用旧角色）══
  let r31 = await initializeAvatar({ playerRowId: rowA.id, robloxUserId: '424242', avatarUrl: 'https://t0.rbxcdn.com/s31.png' });
  assert.strictEqual(r31.status, 'INITIALIZED');
  assert.ok(!r31.duplicate);
  const initRow1 = db.prepare('SELECT * FROM avatar_initialization WHERE player_id = ?').get(rowA.id);
  assert.ok(JSON.parse(initRow1.accepted_tags || '[]').length >= 1);
  ok('10. 绑定识别：accepted_tags 非空（非默认数值路径）');

  let ctxAll = buildContext(roomObj).sections.map((s) => s.content).join('\n');
  assert.ok(ctxAll.includes('military'));
  ok('11. AI Context 引用识别结果（含 military）');

  db.prepare(
    "INSERT INTO roblox_profiles (roblox_user_id, username, display_name, description) VALUES ('424242', 's31user', 'S31用户', '')"
  ).run();
  const profId = db.prepare("SELECT id FROM roblox_profiles WHERE roblox_user_id = '424242'").get().id;
  db.prepare('UPDATE players SET roblox_profile_id = ? WHERE id = ?').run(profId, rowA.id); // 模拟已绑定
  const avatarEvents = [];
  A.on('avatar:initialized', (e) => avatarEvents.push(e));
  const un = await ack(A, 'player:unbindRoblox', {});
  assert.strictEqual(un.ok, true);
  assert.strictEqual(un.reset, true);
  const initRow2 = db.prepare('SELECT * FROM avatar_initialization WHERE player_id = ?').get(rowA.id);
  assert.strictEqual(initRow2.roblox_user_id, 'bacon');
  const attrs = JSON.parse(initRow2.final_attributes);
  assert.ok(Object.values(attrs).every((v) => v === 5));
  const pRow = db.prepare('SELECT * FROM players WHERE id = ?').get(rowA.id);
  assert.strictEqual(pRow.roblox_profile_id, null);
  assert.strictEqual(pRow.avatar_type, 'bacon');
  ok('12. 解绑 → 培根重置（init=bacon / 全属性5 / profile 清空）');

  ctxAll = buildContext(roomObj).sections.map((s) => s.content).join('\n');
  assert.ok(!ctxAll.includes('military'));
  ok('13. 解绑后 AI Context 不再引用旧识别标签');

  assert.ok(avatarEvents.some((e) => e.bacon === true));
  ok('14. 解绑广播 avatar:initialized（bacon）');

  // ══ D. 换绑新用户重新识别（幂等防线不再挡）══
  const calls0 = visionCalls;
  r31 = await initializeAvatar({ playerRowId: rowA.id, robloxUserId: '424242', avatarUrl: 'https://t0.rbxcdn.com/s31.png' });
  assert.strictEqual(r31.status, 'INITIALIZED');
  assert.ok(!r31.duplicate);
  assert.strictEqual(visionCalls, calls0 + 1);
  ok('15. 解绑后重新绑定同一用户 → 重新识别（Vision +1）');

  r31 = await initializeAvatar({ playerRowId: rowA.id, robloxUserId: '424242', avatarUrl: 'https://t0.rbxcdn.com/s31.png' });
  assert.strictEqual(r31.duplicate, true);
  assert.strictEqual(visionCalls, calls0 + 1);
  ok('16. 同一用户重复识别 → 幂等缓存（Vision 不再调用）');

  r31 = await initializeAvatar({ playerRowId: rowA.id, robloxUserId: '888888', avatarUrl: 'https://t0.rbxcdn.com/s31b.png' });
  assert.strictEqual(r31.status, 'INITIALIZED');
  assert.ok(!r31.duplicate);
  assert.strictEqual(visionCalls, calls0 + 2);
  const initRow3 = db.prepare('SELECT * FROM avatar_initialization WHERE player_id = ?').get(rowA.id);
  assert.strictEqual(String(initRow3.roblox_user_id), '888888');
  ok('17. 换绑不同用户（424242→888888）→ 重新识别并更新 init 行');

  assert.strictEqual(visionCalls, calls0 + 2);
  ok('18. Vision 调用总数精确（不重复、不遗漏）');

  // ══ E. 副本进程进大聊天框 ══
  const chatLog = [];
  A.on('chat:message', (m) => chatLog.push(m));
  B.on('chat:message', (m) => chatLog.push(m));
  const { versionId } = seedPublishedDungeon();

  let r = await post('/api/dungeon-instances', { dungeonVersionId: versionId, sessionToken: tokenA });
  const inst = r.data.instance;
  await post(`/api/dungeon-instances/${inst.uid}/join`, { sessionToken: tokenB });
  r = await post(`/api/dungeon-instances/${inst.uid}/start`, { sessionToken: tokenA });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  await sleep(200);
  const startMsgs = chatLog.filter((m) => m.type === 'dungeon' && m.text.includes('开始'));
  assert.ok(startMsgs.length >= 1 && startMsgs[0].text.includes('大厅'));
  ok('19. 副本开始 → 大聊天框收到 dungeon 进程消息（含首场景）');

  const dbDungeon = db.prepare("SELECT * FROM messages WHERE room_id = ? AND type = 'dungeon' AND content LIKE '%开始%'").get(roomId);
  assert.ok(dbDungeon);
  ok('20. 进程消息持久化（messages 表 type=dungeon，可分页回看）');

  r = await post(`/api/dungeon-instances/${inst.uid}/move`, { sceneId: 'scene_b', sessionToken: tokenA });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  await sleep(150);
  assert.ok(chatLog.some((m) => m.type === 'dungeon' && m.text.includes('前往') && m.text.includes('走廊')));
  ok('21. 场景移动 → 聊天框可见（前往走廊）');

  // 第二个房间验证开战通知（scene_b 无遭遇，另开实例验证 enc_1）
  const E = await mkSocket();
  const createdE = await ack(E, 'room:create', { playerName: '丙' });
  const F = await mkSocket();
  const joinF = await ack(F, 'room:join', { playerName: '丁', roomId: createdE.room.id });
  const chatEF = [];
  E.on('chat:message', (m) => chatEF.push(m));
  r = await post('/api/dungeon-instances', { dungeonVersionId: versionId, sessionToken: createdE.sessionToken });
  const inst2 = r.data.instance;
  await post(`/api/dungeon-instances/${inst2.uid}/join`, { sessionToken: joinF.sessionToken });
  await post(`/api/dungeon-instances/${inst2.uid}/start`, { sessionToken: createdE.sessionToken });
  r = await post(`/api/dungeon-instances/${inst2.uid}/combat/start`, { encounterId: 'enc_1', sessionToken: createdE.sessionToken });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  await sleep(150);
  assert.ok(chatEF.some((m) => m.type === 'dungeon' && m.text.includes('迎战')));
  ok('22. 迎战遭遇 → 聊天框可见（战斗开始）');

  // ══ F. 源码接线断言（前端不可单测的部分）══
  const appSrc = fs.readFileSync(path.join(__dirname, '../../frontend/src/App.jsx'), 'utf8');
  assert.ok(/@AI \$\{text\}/.test(appSrc) || /`@AI /.test(appSrc));
  ok('23. AI 选项按钮：pickOption 自动补 @AI 前缀');

  const chatSrc = fs.readFileSync(path.join(__dirname, '../../frontend/src/components/ChatPanel.jsx'), 'utf8');
  assert.ok(/onScroll/.test(chatSrc) && /loadOlder/.test(chatSrc) && /jump-latest/.test(chatSrc));
  ok('24. 聊天框：上滑加载更早 + 「↓ 最新消息」跳转钮');

  const cssSrc = fs.readFileSync(path.join(__dirname, '../../frontend/src/styles.css'), 'utf8');
  assert.ok(/100dvh/.test(cssSrc) && /chat-loadline/.test(cssSrc) && /\.chat-messages/.test(cssSrc));
  ok('25. 样式：固定视高（100dvh）+ 聊天区内部滚动');

  const roomSrc = fs.readFileSync(path.join(__dirname, '../../frontend/src/components/RoomScreen.jsx'), 'utf8');
  const barSrc = fs.readFileSync(path.join(__dirname, '../../frontend/src/components/InstanceBar.jsx'), 'utf8');
  assert.ok(/InstanceBar/.test(roomSrc) && /moveScene/.test(barSrc) && /startEncounter/.test(barSrc) && /timedChoice/.test(barSrc));
  ok('26. 副本状态条常驻聊天区（移动/迎战/限时抉择可不开面板操作）');

  console.log(`\n[阶段31] 通过 ${passed} 项测试`);
  A.disconnect(); B.disconnect(); outsider.disconnect(); E.disconnect(); F.disconnect();
  server.close();
  aiServer.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('\n[阶段31] 失败：', err && err.stack ? err.stack : err);
  process.exit(1);
});
