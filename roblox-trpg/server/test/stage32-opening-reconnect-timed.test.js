/**
 * 阶段32 测试：副本开场白（AI GM 先发一段话）/ 断线座位保留与重连复活 /
 * 限时抉择超时后 GM 主动发话 / 限时选择立即执行（16 项）。
 */
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

for (const suffix of ['', '-wal', '-shm', '-journal']) {
  fs.rmSync(path.join(__dirname, '../../database/data/roblox_trpg.db' + suffix), { force: true });
}

process.env.AI_API_KEY = 'ai-key-s32';
process.env.AI_BASE_URL = 'http://127.0.0.1:3542/v1';
process.env.AI_MODEL = 'mock-s32';
process.env.AI_STREAM = 'off';
process.env.AI_RATE_PER_PLAYER = '1000';
process.env.AI_RATE_PER_ROOM = '1000';
process.env.PLAYER_DISCONNECT_GRACE_MS = '500'; // 测试用短保留期

const { io: ioc } = require('socket.io-client');
const { server } = require('../src/index.js');
const { getDb } = require('@roblox-trpg/database');
const roomManager = require('../src/rooms/roomManager');
const runtimeEngine = require('../src/services/runtime/runtimeEngine');

const PORT = 3541;
const BASE = `http://localhost:${PORT}`;
let passed = 0;
const ok = (label) => {
  passed += 1;
  console.log(`  ✓ ${label}`);
};

// ── mock AI：所有文本请求返回带「【开场】」的 GM JSON ──
const AI_TEXT = JSON.stringify({
  narration: '【开场】黑暗中你们听见远处门轴转动的声音……',
  action_result: 'NEUTRAL',
  options: [{ label: '观察四周', action: '仔细观察大厅四周' }],
});
const aiServer = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: AI_TEXT }, finish_reason: 'stop' }], usage: { total_tokens: 100 } }));
  });
});

function definitionFixture() {
  return {
    id: 'dungeon_s32',
    source_type: 'ROBLOX_EXPERIENCE',
    roblox_universe_id: '55550041',
    roblox_place_id: '55550042',
    version: 1,
    status: 'PUBLISHED',
    canonical_facts: [{ key: 'name', value: 'S32 Dungeon', source: 'roblox_api' }],
    trpg_original: true,
    dungeon: { name: 's32', display_name: 'S32副本', description: '测试', difficulty: 3, recommended_party_size: 2, estimated_duration: 30 },
    scenes: [
      { id: 'scene_a', name: '大厅', description: '旅馆大厅', source_type: 'TRPG_ORIGINAL', order: 1, possible_actions: [], exits: ['scene_b'], encounters: [], events: [] },
      { id: 'scene_b', name: '出口', description: '逃生出口', source_type: 'TRPG_ORIGINAL', order: 2, possible_actions: [], exits: [], encounters: [], events: [] },
    ],
    encounters: [],
    npcs: [],
    enemies: [],
    events: [],
    boss: null,
    reward_candidates: [],
    created_at: new Date().toISOString(),
  };
}

function seedPublishedDungeon() {
  const db = getDb();
  const dInfo = db
    .prepare("INSERT INTO dungeons (uid, roblox_experience_name, roblox_universe_id, roblox_place_id, dungeon_name, difficulty, description) VALUES ('dungeon_s32', 'S32 Exp', '55550041', '55550042', 'S32副本', 3, '测试')")
    .run();
  const vInfo = db
    .prepare("INSERT INTO dungeon_versions (dungeon_id, version, definition_json, canonical_snapshot_hash, status) VALUES (?, 1, ?, 'hash_s32', 'PUBLISHED')")
    .run(dInfo.lastInsertRowid, JSON.stringify(definitionFixture()));
  return vInfo.lastInsertRowid;
}

async function mkSocket(auth) {
  return new Promise((res) => {
    const s = ioc(BASE, { transports: ['websocket'], auth });
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
/** 轮询等待计数增长（避免事件在注册监听前已触发的竞态）。 */
function waitCount(getCount, baseline, ms = 8000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (getCount() > baseline) {
        clearInterval(iv);
        resolve(true);
      } else if (Date.now() - t0 > ms) {
        clearInterval(iv);
        resolve(null);
      }
    }, 50);
  });
}
/** 等待某 socket 收到匹配事件（超时返回 null）。 */
function waitFor(s, event, predicate = () => true, ms = 4000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      s.off(event, fn);
      resolve(null);
    }, ms);
    const fn = (data) => {
      if (!predicate(data)) return;
      clearTimeout(timer);
      s.off(event, fn);
      resolve(data);
    };
    s.on(event, fn);
  });
}

async function main() {
  const db = getDb();
  console.log('[test] 阶段32 就绪（16 项）\n');
  await Promise.all([new Promise((r) => aiServer.listen(3542, '127.0.0.1', r)), new Promise((r) => server.listen(PORT, r))]);
  const versionId = seedPublishedDungeon();

  // ── 房间：甲（房主）+ 乙 ──
  const A = await mkSocket();
  const created = await ack(A, 'room:create', { playerName: '甲' });
  const tokenA = created.sessionToken;
  const B = await mkSocket();
  const joinB = await ack(B, 'room:join', { playerName: '乙', roomId: created.room.id });
  const roomId = created.room.id;
  await sleep(200);
  const rowA = roomManager.getPlayerRow(A.id);

  // ══ A. 断线座位保留 + 重连复活 ══
  const gmMsgsB = [];
  B.on('gm:response', (g) => gmMsgsB.push(g));
  const sysMsgsB = [];
  B.on('chat:message', (m) => { if (m.type === 'system' || m.type === 'dungeon') sysMsgsB.push(m); });
  const puList = []; // 持续记录 players:update（事件可能先于断言注册到达）
  B.on('players:update', (p) => puList.push(p.players));

  A.disconnect(); // 模拟浏览器休眠/掉线
  const discNotice = await waitFor(B, 'chat:message', (m) => m.type === 'system' && /连接中断/.test(m.text || ''));
  assert.ok(discNotice, '应收到连接中断提示');
  ok('1. 掉线 → 广播「连接中断（座位保留）」提示');

  const playersWhileDisc = await waitCount(
    () => puList.filter((list) => list.some((x) => x.name === '甲' && x.disconnected)).length,
    0,
    4000
  );
  assert.ok(playersWhileDisc, '玩家列表应有甲的断线标记');
  ok('2. 玩家列表带 ⚠ 断线标记（disconnected）');

  const roomObj = roomManager.getRoom(roomId);
  assert.ok(roomObj.players.some((p) => p.name === '甲' && p.disconnectedAt));
  ok('3. 宽限期内座位保留（未真正移除）');

  const dbRow = db.prepare('SELECT * FROM players WHERE id = ?').get(rowA.id);
  assert.ok(dbRow.room_id === roomId && !dbRow.left_at);
  ok('4. 宽限期内 DB 玩家行仍在房间（left_at 为空）');

  // 同会话重连 → 客户端（App onConnect）自动 room:join → 复活原座位
  const A2 = await mkSocket({ sessionToken: tokenA });
  A2.emit('room:join', { playerName: '甲', roomId });
  const rejoined = await waitFor(A2, 'room:joined', (r) => r.room && r.room.id === roomId, 6000);
  assert.ok(rejoined, '客户端重连自动回房（App onConnect 自动 room:join 的服务端语义）');
  ok('5. 同会话重连 → room:joined（回到原房间）');

  const roomObj2 = roomManager.getRoom(roomId);
  assert.strictEqual(roomObj2.players.filter((p) => p.name === '甲').length, 1);
  assert.ok(roomObj2.players.some((p) => p.name === '甲' && !p.disconnectedAt));
  ok('6. 重连复活原座位（无重复、断线标记清除）');

  const hist = await ack(A2, 'chat:history', { limit: 50 });
  assert.ok(hist.ok && hist.messages.length >= 2);
  ok('7. 重连后聊天历史可拉取（错过的消息不丢）');

  // ══ B. 副本开场白（AI GM 先发一段话）══
  let r = await post('/api/dungeon-instances', { dungeonVersionId: versionId, sessionToken: tokenA });
  const inst = r.data.instance;
  await post(`/api/dungeon-instances/${inst.uid}/join`, { sessionToken: joinB.sessionToken });
  r = await post(`/api/dungeon-instances/${inst.uid}/start`, { sessionToken: tokenA });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  ok('8. 副本开始（RUNNING）');

  const opening = await waitFor(B, 'gm:response', (g) => /【开场】/.test(g.narrative || ''), 8000);
  assert.ok(opening, '开始后应收到 GM 开场白');
  assert.ok(Array.isArray(opening.options) && opening.options.length >= 1);
  ok('9. 进入副本 → AI GM 主动发开场白（含行动选项）');

  const gmRow = db.prepare("SELECT * FROM messages WHERE room_id = ? AND type = 'gm' AND content LIKE '%【开场】%'").get(roomId);
  assert.ok(gmRow);
  ok('10. 开场白持久化（type=gm，可分页回看）');

  const openingEvt = db.prepare("SELECT * FROM instance_events WHERE instance_id = ? AND type = 'OPENING'").get(inst.id);
  assert.ok(openingEvt);
  ok('11. 开场白记入实例事件日志（OPENING）');

  // ══ C. 限时抉择：点击立即执行 + 超时后 GM 主动发话 ══
  const instanceRow = db.prepare('SELECT * FROM dungeon_instances WHERE uid = ?', ).get(inst.uid);
  const rowB = db.prepare("SELECT * FROM players WHERE name = '乙'").get();
  const hpBefore = db.prepare('SELECT hp FROM player_states WHERE player_id = ?').get(rowB.id).hp;

  // C1: 点击 → 立即执行（服务器 resolve + GM 排队叙述）
  runtimeEngine.startTimedEvent(require('../src/index.js').io, instanceRow, rowB, {
    prompt: 'Rush 冲过来了，躲进哪里？',
    options: [{ label: '躲进衣柜', action: '躲进衣柜' }, { label: '钻到床下', action: '钻到床下' }],
    deadline_ms: 15000,
    fail_damage: 3,
  });
  const choice = runtimeEngine.resolveTimedChoice(require('../src/index.js').io, instanceRow, rowB, 0);
  assert.strictEqual(choice.ok, true);
  assert.strictEqual(choice.choice, '躲进衣柜');
  ok('12. 限时按钮点击 → 立即执行（resolve 同步返回）');

  const choseMsg = await waitFor(B, 'chat:message', (m) => m.type === 'dungeon' && /选择了/.test(m.text || ''), 4000);
  assert.ok(choseMsg, '应广播「选择了…」');
  ok('13. 选择结果立即进大聊天框（GM 正在叙述后果…）');

  const gmBaseline1 = gmMsgsB.length;
  const gmAfterChoice = await waitCount(() => gmMsgsB.length, gmBaseline1);
  assert.ok(gmAfterChoice, '选择作为行动入队 → GM 发话');
  ok('14. 选择后 GM 主动叙述（走 Runtime GM 流水线）');

  // C2: 超时 → 伤害结算 + GM 主动发话
  const instanceRow2 = db.prepare('SELECT * FROM dungeon_instances WHERE uid = ?').get(inst.uid);
  runtimeEngine.startTimedEvent(require('../src/index.js').io, instanceRow2, rowB, {
    prompt: '又是 Rush！这次来不及了……',
    options: [{ label: '躲进衣柜', action: '躲进衣柜' }],
    deadline_ms: 200,
    fail_damage: 2,
  });
  const gmBaseline2 = gmMsgsB.length; // 在超时结算前记基线（超时的 GM 叙述在其后到达）
  const expired = await waitFor(B, 'instance:timedExpired', (e) => e.outcome === 'EXPIRED', 6000);
  assert.ok(expired, '超时应广播 EXPIRED');
  const hpAfter = db.prepare('SELECT hp FROM player_states WHERE player_id = ?').get(rowB.id).hp;
  assert.strictEqual(hpAfter, hpBefore - 2);
  ok('15. 超时 → 服务器立即结算伤害（-2HP）');

  const gmAfterExpire = await waitCount(() => gmMsgsB.length, gmBaseline2);
  assert.ok(gmAfterExpire, '超时后 GM 应主动发话');
  ok('16. 计时结束 → GM 主动发话叙述后果（无需玩家再输入）');

  console.log(`\n[阶段32] 通过 ${passed} 项测试`);
  A2.disconnect(); B.disconnect();
  server.close();
  aiServer.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('\n[阶段32] 失败：', err && err.stack ? err.stack : err);
  process.exit(1);
});
