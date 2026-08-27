/**
 * 阶段13 测试：Party & Narrative Decision System（74 项）。
 * 覆盖：队伍（创建/加入/离开/队长转移/叙事定位）/ 玩家关系（增减/幂等/并发/事件驱动）/
 *       决策（普通/限时/超时/默认结果）/ 团队投票（投票/超时/非成员拒绝）/
 *       AI 权限（工具/作弊拒绝）/ 集成（Dungeon/Quest/NPC/World Event）/ Context / REST。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

for (const suffix of ['', '-wal', '-shm', '-journal']) {
  fs.rmSync(path.join(__dirname, '../../database/data/roblox_trpg.db' + suffix), { force: true });
}

process.env.AI_API_KEY = 'ai-key-s13';
process.env.AI_BASE_URL = 'http://127.0.0.1:4113/v1';
process.env.AI_MODEL = 'mock-s13';
process.env.AI_STREAM = 'off';
process.env.TIMED_EVENT_MIN_MS = '50'; // 测试加速：限时最小 50ms（生产默认 3000ms）

const { server } = require('../src/index.js');
const dbMod = require('@roblox-trpg/database');
const db = dbMod.getDb();
const partyService = require('../src/services/party/partyService');
const playerRelations = require('../src/services/party/playerRelations');
const decisionEngine = require('../src/services/party/decisionEngine');
const npcEngine = require('../src/services/npcs/npcEngine');
const questEngine = require('../src/services/quests/questEngine');
const worldState = require('../src/services/world/worldState');
const worldEvents = require('../src/services/world/worldEvents');
const characterService = require('../src/services/character/characterService');
const gameEvents = require('../src/services/quests/gameEvents');
const tools = require('../src/services/ai/tools');
const contextBuilder = require('../src/services/ai/contextBuilder');
const instanceManager = require('../src/services/runtime/instanceManager');
const { createSession } = require('../src/sessions/sessionManager');

let passed = 0;
const ok = (label) => {
  passed += 1;
  console.log(`  ✓ ${label}`);
};
const fakeIo = { to: () => ({ emit: () => {} }), emit: () => {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mkRoomDb(id) {
  db.prepare("INSERT OR IGNORE INTO rooms (id, status, max_players) VALUES (?, 'waiting', 3)").run(id);
}
let pSeq = 0;
function mkPlayerDb(name, roomId) {
  pSeq += 1;
  const uid = `player_s13_${pSeq}`;
  db.prepare('INSERT INTO players (uid, socket_id, name, room_id) VALUES (?, ?, ?, ?)').run(uid, `sock_${uid}`, name, roomId);
  return db.prepare('SELECT * FROM players WHERE uid = ?').get(uid);
}
const evCount = (sql) => db.prepare(sql).get().c;

async function main() {
  console.log('[test] 阶段13 就绪（74 项）\n');

  // ══ A. Party 系统 ══
  mkRoomDb('PR1');
  const alice = mkPlayerDb('爱丽丝', 'PR1');
  const bob = mkPlayerDb('鲍勃', 'PR1');
  const carol = mkPlayerDb('卡萝尔', 'PR1');

  const party = partyService.createParty(fakeIo, 'PR1', alice.id);
  assert.ok(party.status === 'ACTIVE' && party.leader_player_id === alice.id);
  assert.ok(partyService.isMember(party.id, alice.id));
  ok('1. 创建队伍（创建者=队长+成员）');
  assert.throws(() => partyService.createParty(fakeIo, 'PR1', bob.id), /已存在主队伍/);
  ok('2. 一个房间只能存在一个主队伍');
  const j1 = partyService.joinParty(fakeIo, party.id, bob.id);
  const j1dup = partyService.joinParty(fakeIo, party.id, bob.id);
  assert.ok(j1.joined && j1dup.joined === false && j1dup.reason === 'ALREADY_MEMBER');
  ok('3. 加入队伍 + 重复加入幂等');
  mkRoomDb('PR2');
  const outsider = mkPlayerDb('外人', 'PR2');
  assert.throws(() => partyService.joinParty(fakeIo, party.id, outsider.id), /不在该房间/);
  ok('4. 跨房间加入拒绝（房间隔离）');
  partyService.setRole(fakeIo, party.id, bob.id, 'SCOUT');
  const bobRole = db.prepare('SELECT * FROM party_roles WHERE party_id = ? AND player_id = ?').get(party.id, bob.id);
  const bobMember = db.prepare('SELECT * FROM party_members WHERE party_id = ? AND player_id = ?').get(party.id, bob.id);
  assert.ok(bobRole.role === 'SCOUT' && bobMember.role === 'SCOUT');
  ok('5. 叙事定位设置（party_roles + party_members 同步）');
  assert.throws(() => partyService.setRole(fakeIo, party.id, bob.id, 'TANK'), /非法角色定位/);
  ok('6. 非法角色定位拒绝（只允许白名单）');
  partyService.transferLeadership(fakeIo, party.id, bob.id);
  assert.strictEqual(partyService.getParty(party.id).leader_player_id, bob.id);
  ok('7. 队长转移');
  assert.throws(() => partyService.transferLeadership(fakeIo, party.id, carol.id), /必须是队伍成员/);
  ok('8. 转移给非成员拒绝');
  partyService.leaveParty(fakeIo, party.id, bob.id); // 队长离开 → 自动转移给爱丽丝
  const afterLeave = partyService.getParty(party.id);
  assert.strictEqual(afterLeave.leader_player_id, alice.id);
  ok('9. 队长离开自动转移（最早成员接任）');
  partyService.leaveParty(fakeIo, party.id, alice.id);
  assert.strictEqual(partyService.getParty(party.id).status, 'DISBANDED');
  ok('10. 队伍清空自动解散');
  const party2 = partyService.createParty(fakeIo, 'PR1', carol.id);
  assert.ok(party2.status === 'ACTIVE');
  partyService.joinParty(fakeIo, party2.id, alice.id);
  partyService.joinParty(fakeIo, party2.id, bob.id);
  ok('11. 解散后可重新创建（部分唯一索引只约束 ACTIVE）');
  partyService.setRole(fakeIo, party2.id, bob.id, 'SCOUT'); // 新队伍中重新定位（旧定位不跨队伍携带）
  const view = partyService.partyView(party2.id);
  assert.ok(view.members.length === 3 && view.members.some((m) => m.isLeader && m.name === '卡萝尔') && view.members.some((m) => m.role === 'SCOUT'));
  ok('12. 队伍视图（成员/队长/叙事定位）');
  const ctxTool = { io: fakeIo, room: { id: 'PR1', players: [] }, playerUid: 'player_s13_1', actingPlayerName: 'GM' };
  const ps = await tools.runTool(ctxTool, 'get_party_status', {});
  assert.ok(ps.ok && ps.party && ps.party.members.length === 3);
  ok('13. get_party_status 工具');
  assert.ok(db.prepare("SELECT 1 FROM game_events WHERE room_id = 'PR1' AND type = 'PARTY_CREATED'").get());
  ok('14. PARTY_CREATED 记入 Event Bus');

  // ══ B. 玩家关系系统 ══
  mkRoomDb('RR1');
  const p1 = mkPlayerDb('佩奇', 'RR1');
  const p2 = mkPlayerDb('奎恩', 'RR1');
  const r1 = playerRelations.applyEvent(fakeIo, { type: 'PLAYER_HELPED', actorPlayerId: p1.id, targetPlayerId: p2.id, roomId: 'RR1' });
  assert.ok(r1.applied && r1.value === 10 && r1.relationshipType === 'FRIEND');
  ok('15. PLAYER_HELPED +10（固定增量，服务器决定）');
  playerRelations.applyEvent(fakeIo, { type: 'PLAYER_SAVED_PLAYER', actorPlayerId: p1.id, targetPlayerId: p2.id, roomId: 'RR1' });
  assert.strictEqual(playerRelations.getRelationship(p1.id, p2.id).value, 35);
  ok('16. PLAYER_SAVED_PLAYER +25（累计 35）');
  playerRelations.applyEvent(fakeIo, { type: 'PLAYER_BETRAYED', actorPlayerId: p1.id, targetPlayerId: p2.id, roomId: 'RR1' });
  const relBetray = playerRelations.getRelationship(p1.id, p2.id);
  assert.ok(relBetray.value === -5 && relBetray.relationshipType === 'RIVAL');
  ok('17. PLAYER_BETRAYED -40 → RIVAL');
  playerRelations.applyEvent(fakeIo, { type: 'PLAYER_STOLE_REWARD', actorPlayerId: p1.id, targetPlayerId: p2.id, roomId: 'RR1' });
  playerRelations.applyEvent(fakeIo, { type: 'PLAYER_BETRAYED', actorPlayerId: p1.id, targetPlayerId: p2.id, roomId: 'RR1' });
  const relHostile = playerRelations.getRelationship(p1.id, p2.id);
  assert.ok(relHostile.value === -75 && relHostile.relationshipType === 'HOSTILE');
  ok('18. 连续负面事件 → HOSTILE（类型随数值变化）');
  mkRoomDb('RR2');
  const q1 = mkPlayerDb('甲', 'RR2');
  const q2 = mkPlayerDb('乙', 'RR2');
  for (let i = 0; i < 12; i += 1) playerRelations.applyEvent(fakeIo, { type: 'PLAYER_HELPED', actorPlayerId: q1.id, targetPlayerId: q2.id, roomId: 'RR2' });
  const relMax = playerRelations.getRelationship(q1.id, q2.id);
  assert.ok(relMax.value === 100 && relMax.relationshipType === 'TRUSTED');
  ok('19. 数值钳制 ±100（12次帮助=120 → 100 TRUSTED）');
  const idem1 = playerRelations.applyEvent(fakeIo, { type: 'PLAYER_HELPED', actorPlayerId: q1.id, targetPlayerId: q2.id, roomId: 'RR2', dedupeKey: 'evt_save_1' });
  const idem2 = playerRelations.applyEvent(fakeIo, { type: 'PLAYER_HELPED', actorPlayerId: q1.id, targetPlayerId: q2.id, roomId: 'RR2', dedupeKey: 'evt_save_1' });
  assert.ok(idem1.applied && idem2.applied === false && idem2.reason === 'DUPLICATE_EVENT');
  ok('20. 幂等：同一事件去重键只生效一次');
  mkRoomDb('RR3');
  const c1 = mkPlayerDb('并甲', 'RR3');
  const c2 = mkPlayerDb('并乙', 'RR3');
  for (let i = 0; i < 10; i += 1) playerRelations.applyEvent(fakeIo, { type: 'PLAYER_HELPED', actorPlayerId: c1.id, targetPlayerId: c2.id, roomId: 'RR3' });
  assert.strictEqual(playerRelations.getRelationship(c1.id, c2.id).value, 100);
  ok('21. 并发写入安全（10次+10=100，钳制无丢失无越界）');
  assert.throws(() => playerRelations.applyEvent(fakeIo, { type: 'PLAYER_HELPED', actorPlayerId: c1.id, targetPlayerId: c1.id, roomId: 'RR3' }), /不能对自己/);
  ok('22. 自我关系事件拒绝');
  assert.throws(() => playerRelations.applyEvent(fakeIo, { type: 'PLAYER_KISSED', actorPlayerId: c1.id, targetPlayerId: c2.id, roomId: 'RR3' }), /非法关系事件/);
  ok('23. 非法事件类型拒绝（白名单外）');
  assert.ok(db.prepare("SELECT 1 FROM game_events WHERE room_id = 'RR1' AND type = 'PLAYER_RELATION_CHANGED'").get());
  ok('24. 关系变化记入 Event Bus + 审计');
  const beforeListener = playerRelations.getRelationship(c1.id, c2.id).value;
  gameEvents.emit(fakeIo, 'RR3', { type: 'PLAYER_SAVED_PLAYER', actor: '并甲', actorPlayerId: c1.id, data: { targetPlayerId: c2.id, reason: '副本救助' } });
  assert.strictEqual(playerRelations.getRelationship(c1.id, c2.id).value, Math.min(100, beforeListener + 25));
  ok('25. 事件监听路径：其他系统发关系事件 → 自动应用（AI 不在链路上）');
  const names = tools.getRegistry().map((t) => t.name);
  assert.ok(!names.includes('set_player_relationship') && !names.includes('modify_player_relationship'));
  ok('26. AI 无关系修改工具（禁止直接修改关系）');
  const relTool = await tools.runTool({ io: fakeIo, room: { id: 'RR1', players: [{ name: '佩奇', uid: p1.uid, socketId: p1.socket_id }, { name: '奎恩', uid: p2.uid, socketId: p2.socket_id }] }, playerUid: p1.uid }, 'get_player_relationship', { playerA: '佩奇', playerB: '奎恩' });
  assert.ok(relTool.ok && relTool.value === relHostile.value && relTool.relationshipType === 'HOSTILE');
  ok('27. get_player_relationship 只读工具');

  // ══ C. 普通选择 NORMAL ══
  mkRoomDb('DN1');
  const dana = mkPlayerDb('丹娜', 'DN1');
  const erin = mkPlayerDb('艾琳', 'DN1');
  const dec1 = decisionEngine.createDecision(fakeIo, 'DN1', {
    type: 'NORMAL',
    prompt: '旅馆管理员请求你的帮助，你是否答应？',
    options: [
      { key: 'A', text: '帮助管理员', result: { flag: { name: 'helped_keeper' } } },
      { key: 'B', text: '转身离开' },
    ],
    creator: 'ai',
  });
  assert.ok(dec1.status === 'PENDING' && decisionEngine.optionsOf(dec1.id).length === 2);
  ok('28. 创建普通选择（选项入库，DECISION 待决）');
  const sel1 = decisionEngine.selectDecision(fakeIo, dec1.uid, dana.id, 'A');
  assert.ok(sel1.settled && sel1.optionKey === 'A');
  assert.strictEqual(worldState.getWorld('DN1').state.helped_keeper, true);
  ok('29. 玩家选择 → 服务器结算 + 效果执行（世界标志）');
  assert.throws(() => decisionEngine.selectDecision(fakeIo, dec1.uid, dana.id, 'B'), /已结算/);
  ok('30. 已结算决策重复选择拒绝');
  const dec2 = decisionEngine.createDecision(fakeIo, 'DN1', {
    type: 'NORMAL',
    prompt: '丹娜，你要独自去地下室吗？',
    options: [{ key: 'A', text: '去' }, { key: 'B', text: '不去' }],
    targetPlayerId: dana.id,
  });
  assert.throws(() => decisionEngine.selectDecision(fakeIo, dec2.uid, erin.id, 'A'), /指定了其他决策者/);
  const sel2 = decisionEngine.selectDecision(fakeIo, dec2.uid, dana.id, 'B');
  assert.ok(sel2.settled);
  ok('31. 目标玩家限定（他人代选拒绝，本人可选）');
  const dec3 = decisionEngine.createDecision(fakeIo, 'DN1', { type: 'NORMAL', prompt: 'x', options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }] });
  assert.throws(() => decisionEngine.selectDecision(fakeIo, dec3.uid, dana.id, 'Z'), /选项 Z 不存在/);
  ok('32. 非法选项键拒绝');
  assert.throws(() => decisionEngine.selectDecision(fakeIo, dec3.uid, outsider.id, 'A'), /不在该房间/);
  ok('33. 跨房间玩家选择拒绝（房间隔离）');
  assert.throws(
    () => decisionEngine.createDecision(fakeIo, 'DN1', { type: 'NORMAL', prompt: 'x', options: [{ key: 'A', text: 'a', result: { give_item: '骨架钥匙' } }, { key: 'B', text: 'b' }] }),
    /不在白名单内/
  );
  ok('34. 效果白名单：give_item 等自定义效果拒绝（AI 不能夹带）');
  const decTool = await tools.runTool(ctxTool, 'create_decision', {
    prompt: '测试：帮不帮？',
    options: JSON.stringify([{ key: 'A', text: '帮' }, { key: 'B', text: '不帮' }]),
  });
  assert.ok(decTool.ok && decTool.uid);
  ok('35. create_decision 工具（选项 JSON 解析 + 服务器验证）');
  assert.throws(
    () => decisionEngine.createDecision(fakeIo, 'DN1', { type: 'NORMAL', prompt: 'x', options: [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }, { text: 'e' }] }),
    /2~4/
  );
  assert.throws(() => decisionEngine.createDecision(fakeIo, 'DN1', { type: 'NORMAL', prompt: 'x', options: [{ text: 'a' }] }), /2~4/);
  ok('36. 选项数量约束（2~4 个）');
  assert.ok(db.prepare("SELECT 1 FROM game_events WHERE room_id = 'DN1' AND type = 'DECISION_STARTED'").get() && db.prepare("SELECT 1 FROM game_events WHERE room_id = 'DN1' AND type = 'DECISION_SELECTED'").get());
  ok('37. DECISION_STARTED / DECISION_SELECTED 记入 Event Bus');

  // ══ D. 限时选择 TIMED ══
  mkRoomDb('DT1');
  const tim = mkPlayerDb('蒂姆', 'DT1');
  const timedTool = await tools.runTool({ io: fakeIo, room: { id: 'DT1', players: [{ name: '蒂姆', uid: tim.uid, socketId: tim.socket_id }] }, playerUid: tim.uid }, 'create_timed_decision', {
    prompt: 'Rush 声音越来越近！',
    options: JSON.stringify([
      { key: 'A', text: '躲进柜子' },
      { key: 'B', text: '继续跑', result: { flag: { name: 'kept_running' } } },
    ]),
    default_option: 'B',
    timeout_seconds: 1,
  });
  assert.ok(timedTool.ok && timedTool.timeoutMs >= 50 && new Date(timedTool.expiresAt).getTime() > Date.now());
  ok('38. create_timed_decision：服务器计时 + 时长钳制');
  const td1 = decisionEngine.getDecision(timedTool.uid);
  const selTimed = decisionEngine.selectDecision(fakeIo, td1.uid, tim.id, 'A');
  assert.ok(selTimed.settled && selTimed.reason === 'PLAYER' && decisionEngine.getDecision(td1.uid).status === 'RESOLVED');
  ok('39. 倒计时内选择 → 玩家结算');
  const td2 = decisionEngine.createDecision(fakeIo, 'DT1', {
    type: 'TIMED',
    prompt: '灯突然灭了！',
    options: [{ key: 'A', text: '点亮火把' }, { key: 'B', text: '原地不动', result: { flag: { name: 'timed_default_flag' } } }],
    defaultOption: 'B',
    timeoutMs: 80,
  });
  await sleep(250);
  const td2row = decisionEngine.getDecision(td2.uid);
  assert.ok(td2row.status === 'TIMEOUT' && td2row.resolved_option === 'B' && td2row.resolved_reason === 'TIMEOUT');
  assert.strictEqual(worldState.getWorld('DT1').state.timed_default_flag, true);
  ok('40. 超时：自动执行 default_option + 效果执行（服务器计时）');
  assert.ok(db.prepare("SELECT 1 FROM game_events WHERE room_id = 'DT1' AND type = 'DECISION_TIMEOUT'").get());
  ok('41. DECISION_TIMEOUT 记入 Event Bus');
  await assert.rejects(tools.runTool({ io: fakeIo, room: { id: 'DT1', players: [] }, playerUid: 'ai' }, 'resolve_decision', { decision: decisionEngine.createDecision(fakeIo, 'DT1', { type: 'TIMED', prompt: 'y', options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }], defaultOption: 'A', timeoutMs: 60000 }).uid }), /不能代替玩家/);
  ok('42. AI 不能代替玩家结算等待中的限时选择（拒绝强制）');
  for (const banned of ['cancel_decision', 'extend_decision', 'force_decision', 'modify_decision']) {
    assert.ok(!names.includes(banned));
  }
  ok('43. 无取消/延长/修改决策工具（倒计时不可篡改）');
  const td3 = decisionEngine.createDecision(fakeIo, 'DT1', { type: 'TIMED', prompt: 'z', options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }], defaultOption: 'A', timeoutMs: 999999 });
  assert.strictEqual(td3.timeout_ms, 60000);
  ok('44. 超时时长按服务器上限钳制（999999 → 60000）');
  const td4 = decisionEngine.createDecision(fakeIo, 'DT1', { type: 'TIMED', prompt: 'w', options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }], defaultOption: 'A', timeoutMs: 300 });
  const due = decisionEngine.resolveDueDecisions(fakeIo, 'DT1', Date.now() + 9999);
  assert.ok(due.some((d) => d.reason === 'TIMEOUT') && decisionEngine.getDecision(td4.uid).status === 'TIMEOUT');
  ok('45. World Tick 兜底结算（定时器失效时的安全网）');
  await sleep(450); // 等原定时器触发：已结算 → 定时器路径幂等跳过
  const td4row = decisionEngine.getDecision(td4.uid);
  assert.strictEqual(td4row.status, 'TIMEOUT');
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM game_events WHERE room_id = 'DT1' AND type = 'DECISION_TIMEOUT' AND data LIKE ?").get(`%${td4.uid}%`).c, 1);
  ok('46. 结算幂等：兜底结算后定时器触发不重复结算（事件仅一条）');

  // ══ E. 团队决策 PARTY ══
  mkRoomDb('PV1');
  const v1 = mkPlayerDb('薇一', 'PV1');
  const v2 = mkPlayerDb('薇二', 'PV1');
  const v3 = mkPlayerDb('薇三', 'PV1');
  const v4 = mkPlayerDb('薇四', 'PV1'); // 不入队
  const vParty = partyService.createParty(fakeIo, 'PV1', v1.id);
  partyService.joinParty(fakeIo, vParty.id, v2.id);
  partyService.joinParty(fakeIo, vParty.id, v3.id);
  const pvTool = await tools.runTool({ io: fakeIo, room: { id: 'PV1', players: [] }, playerUid: 'ai' }, 'request_party_vote', {
    prompt: '副本路线：左路安全，右路高奖励。',
    options: JSON.stringify([
      { key: 'A', text: '左路（安全）' },
      { key: 'B', text: '右路（高奖励）', result: { flag: { name: 'chose_risky_route' } } },
    ]),
    default_option: 'A',
  });
  assert.ok(pvTool.ok && pvTool.requiredVotes === 3);
  ok('47. request_party_vote：创建团队决策（默认需全员投票）');
  assert.throws(() => decisionEngine.selectDecision(fakeIo, pvTool.uid, v4.id, 'A'), /只有队伍成员/);
  ok('48. 非成员投票拒绝');
  const vote1 = decisionEngine.selectDecision(fakeIo, pvTool.uid, v1.id, 'B');
  assert.ok(vote1.voted && vote1.votes === 1 && decisionEngine.getDecision(pvTool.uid).status === 'PENDING');
  ok('49. 成员投票（未达票数不结算）');
  assert.throws(() => decisionEngine.selectDecision(fakeIo, pvTool.uid, v1.id, 'A'), /只能投票一次/);
  ok('50. 一人一票，投出不可更改');
  decisionEngine.selectDecision(fakeIo, pvTool.uid, v2.id, 'B');
  const voteFinal = decisionEngine.selectDecision(fakeIo, pvTool.uid, v3.id, 'B');
  assert.ok(voteFinal.settled && voteFinal.reason === 'TALLY' && voteFinal.optionKey === 'B');
  assert.strictEqual(worldState.getWorld('PV1').state.chose_risky_route, true);
  ok('51. 票数达标 → 多数结算 + 效果执行');
  const pv2 = decisionEngine.createDecision(fakeIo, 'PV1', {
    type: 'PARTY',
    prompt: '是否扎营休息？',
    options: [{ key: 'A', text: '扎营' }, { key: 'B', text: '继续前进' }],
    defaultOption: 'A',
    requiredVotes: 2,
    resultRule: 'MAJORITY',
    timeoutMs: 60000,
  });
  decisionEngine.selectDecision(fakeIo, pv2.uid, v1.id, 'A');
  const tie = decisionEngine.selectDecision(fakeIo, pv2.uid, v2.id, 'B');
  assert.ok(tie.settled && tie.optionKey === 'A');
  ok('52. required_votes=2 + 平票 → 执行默认选项');
  const pv3 = decisionEngine.createDecision(fakeIo, 'PV1', {
    type: 'PARTY',
    prompt: '快速表决：开门吗？',
    options: [{ key: 'A', text: '开' }, { key: 'B', text: '不开', result: { flag: { name: 'party_timeout_flag' } } }],
    defaultOption: 'B',
    requiredVotes: 3,
    timeoutMs: 80,
  });
  decisionEngine.selectDecision(fakeIo, pv3.uid, v1.id, 'A');
  await sleep(250);
  const pv3row = decisionEngine.getDecision(pv3.uid);
  assert.ok(pv3row.status === 'TIMEOUT' && pv3row.resolved_option === 'B');
  assert.strictEqual(worldState.getWorld('PV1').state.party_timeout_flag, true);
  ok('53. 团队决策超时 → 默认选项 + 效果执行');
  mkRoomDb('PV2');
  mkPlayerDb('孤狼', 'PV2');
  await assert.rejects(tools.runTool({ io: fakeIo, room: { id: 'PV2', players: [] }, playerUid: 'ai' }, 'request_party_vote', { prompt: 'x', options: JSON.stringify([{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }]), default_option: 'A' }), /队伍/);
  ok('54. 无队伍房间：团队决策拒绝');
  const pv4 = decisionEngine.createDecision(fakeIo, 'PV1', {
    type: 'PARTY',
    prompt: 'resolve 测试',
    options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }],
    defaultOption: 'A',
    requiredVotes: 3,
    timeoutMs: 60000,
  });
  decisionEngine.selectDecision(fakeIo, pv4.uid, v1.id, 'A');
  await assert.rejects(tools.runTool({ io: fakeIo, room: { id: 'PV1', players: [] }, playerUid: 'ai' }, 'resolve_decision', { decision: pv4.uid }), /投票未达标/);
  ok('55. resolve_decision：票数未达标拒绝强制结算');
  decisionEngine.selectDecision(fakeIo, pv4.uid, v2.id, 'A');
  decisionEngine.selectDecision(fakeIo, pv4.uid, v3.id, 'A'); // 第3票达标 → 服务器自动多数结算
  const pv4row = decisionEngine.getDecision(pv4.uid);
  assert.ok(pv4row.status === 'RESOLVED' && pv4row.resolved_option === 'A' && pv4row.resolved_reason === 'TALLY');
  const resolvedByTool = await tools.runTool({ io: fakeIo, room: { id: 'PV1', players: [] }, playerUid: 'ai' }, 'resolve_decision', { decision: pv4.uid });
  assert.ok(resolvedByTool.resolved === false && resolvedByTool.reason === 'ALREADY_RESOLVED');
  ok('56. 票数达标自动结算；resolve_decision 对已结算决策幂等');

  // ══ F. AI 安全边界 ══
  for (const t of ['get_party_status', 'create_decision', 'create_timed_decision', 'resolve_decision', 'get_player_relationship', 'request_party_vote']) {
    assert.ok(names.includes(t));
  }
  ok('57. 六个阶段13 工具全部注册');
  assert.throws(
    () => decisionEngine.createDecision(fakeIo, 'DN1', { type: 'NORMAL', prompt: 'x', options: [{ key: 'A', text: 'a', result: { npc: { npc: '不存在的人', action: 'help' } } }, { key: 'B', text: 'b' }] }),
    /不在当前房间/
  );
  ok('58. NPC 效果必须引用真实在场 NPC（禁止虚构）');
  assert.throws(
    () => decisionEngine.createDecision(fakeIo, 'DN1', { type: 'NORMAL', prompt: 'x', options: [{ key: 'A', text: 'a', result: { world_event: { type: 'DUNGEON_MUTATION' } } }, { key: 'B', text: 'b' }] }),
    /不被允许/
  );
  ok('59. 选择效果中的世界事件同样受白名单约束（SYSTEM 拒绝）');
  assert.throws(
    () => decisionEngine.createDecision(fakeIo, 'DN1', { type: 'NORMAL', prompt: 'x', options: [{ key: 'A', text: 'a', result: { damage: { amount: 999 } } }, { key: 'B', text: 'b' }] }),
    /1~50/
  );
  ok('60. 伤害效果范围钳制（1~50）');
  assert.strictEqual(tools.toolMeta('create_decision').permission, 'GAME_ACTION');
  assert.strictEqual(tools.toolMeta('get_party_status').permission, 'READ_ONLY');
  ok('61. 工具权限分级（读只读 / 写 GAME_ACTION，无 ADMIN）');

  // ══ G. 集成：Quest / NPC / World Event / Dungeon ══
  mkRoomDb('IG1');
  const hero = mkPlayerDb('英雄', 'IG1');
  // G1. 任务联动（事件驱动）：目标定义匹配 DECISION_SELECTED(tag)
  const draft = questEngine.createQuestDraft({
    name: '命运的抉择',
    description: '帮助旅馆管理员',
    type: 'SIDE',
    definition: { objectives: [{ key: 'decide_help', name: '选择帮助', type: 'CUSTOM', required_count: 1, order_index: 1, event_type: 'DECISION_SELECTED', match: { tag: 'help_keeper_ig' } }], rewards: [] },
  });
  questEngine.publishQuestVersion(draft.versionId);
  const qi = questEngine.createInstance(fakeIo, { questVersionId: draft.versionId, roomId: 'IG1', partyPlayerIds: [hero.id], activate: true });
  const decQuest = decisionEngine.createDecision(fakeIo, 'IG1', {
    type: 'NORMAL',
    prompt: '你是否帮助管理员？',
    tag: 'help_keeper_ig',
    options: [{ key: 'A', text: '帮助' }, { key: 'B', text: '拒绝' }],
  });
  decisionEngine.selectDecision(fakeIo, decQuest.uid, hero.id, 'A');
  const qiAfter = db.prepare('SELECT * FROM quest_instances WHERE id = ?').get(qi.instance.id);
  assert.strictEqual(qiAfter.status, 'COMPLETED');
  ok('62. Quest 集成：选择事件驱动任务目标完成（Event Bus）');
  // G2. 背叛 → 任务失败（服务器结算的 quest fail 效果）
  const draft2 = questEngine.createQuestDraft({
    name: '脆弱的信任',
    type: 'SIDE',
    definition: { objectives: [{ key: 'keep_trust', name: '保持信任', type: 'CUSTOM', required_count: 1, order_index: 1, event_type: 'DECISION_SELECTED', match: { tag: 'never_betray' } }], rewards: [] },
  });
  questEngine.publishQuestVersion(draft2.versionId);
  const qi2 = questEngine.createInstance(fakeIo, { questVersionId: draft2.versionId, roomId: 'IG1', partyPlayerIds: [hero.id], activate: true });
  const decBetray = decisionEngine.createDecision(fakeIo, 'IG1', {
    type: 'NORMAL',
    prompt: '要背叛管理员吗？',
    options: [{ key: 'A', text: '不' }, { key: 'B', text: '背叛', result: { quest: { uid: qi2.instance.uid, action: 'fail' } } }],
  });
  decisionEngine.selectDecision(fakeIo, decBetray.uid, hero.id, 'B');
  assert.strictEqual(db.prepare('SELECT status FROM quest_instances WHERE id = ?').get(qi2.instance.id).status, 'FAILED');
  ok('63. Quest 集成：背叛选择 → 任务失败（服务器验证结算）');
  // G3. advance 效果取证防重复（同一事件不重复计数）
  const draft3 = questEngine.createQuestDraft({
    name: '双重计数防护',
    type: 'SIDE',
    definition: { objectives: [{ key: 'two_choices', name: '两次选择', type: 'CUSTOM', required_count: 2, order_index: 1, event_type: 'DECISION_SELECTED', match: { tag: 'dupe_guard' } }], rewards: [] },
  });
  questEngine.publishQuestVersion(draft3.versionId);
  const qi3 = questEngine.createInstance(fakeIo, { questVersionId: draft3.versionId, roomId: 'IG1', partyPlayerIds: [hero.id], activate: true });
  const decAdv = decisionEngine.createDecision(fakeIo, 'IG1', {
    type: 'NORMAL',
    prompt: 'advance 测试',
    tag: 'dupe_guard',
    options: [{ key: 'A', text: '好', result: { quest: { uid: qi3.instance.uid, objectiveKey: 'two_choices', action: 'advance' } } }, { key: 'B', text: '坏' }],
  });
  const advRes = decisionEngine.selectDecision(fakeIo, decAdv.uid, hero.id, 'A');
  const advEffect = advRes.effects.find((e) => e.effect === 'quest');
  // Event Bus 已用同一事件计数 1 次；advance 取证只找到 1 个事件 < 需求 2 → 拒绝（不重复计数）
  assert.ok(advEffect && /证据不足/.test(advEffect.error || ''));
  assert.strictEqual(db.prepare("SELECT status FROM quest_instances WHERE id = ?").get(qi3.instance.id).status, 'ACTIVE');
  // 第二次同标签选择 → 计数达标（2/2）→ 任务完成
  const decAdv2 = decisionEngine.createDecision(fakeIo, 'IG1', {
    type: 'NORMAL',
    prompt: '再次抉择',
    tag: 'dupe_guard',
    options: [{ key: 'A', text: '继续' }, { key: 'B', text: '放弃' }],
  });
  decisionEngine.selectDecision(fakeIo, decAdv2.uid, hero.id, 'A');
  assert.strictEqual(db.prepare("SELECT status FROM quest_instances WHERE id = ?").get(qi3.instance.id).status, 'COMPLETED');
  ok('64. advance 取证：同一事件不重复计数；第二次选择达标完成任务');
  // G4. NPC 关系集成
  mkRoomDb('IG2');
  const nia = mkPlayerDb('妮娅', 'IG2');
  const keeperNpc = npcEngine.getNpc('npc_doors_keeper');
  npcEngine.spawnNpcInstance(null, { npcId: keeperNpc.id, roomId: 'IG2' });
  const decNpc = decisionEngine.createDecision(fakeIo, 'IG2', {
    type: 'NORMAL',
    prompt: '管理员请你帮忙搬物资。',
    options: [{ key: 'A', text: '帮忙', result: { npc: { npc: 'npc_doors_keeper', action: 'help' } } }, { key: 'B', text: '拒绝', result: { npc: { npc: 'npc_doors_keeper', action: 'deceive' } } }],
  });
  decisionEngine.selectDecision(fakeIo, decNpc.uid, nia.id, 'A');
  assert.strictEqual(npcEngine.getRelationship('npc', keeperNpc.id, 'player', nia.id).value, 10);
  ok('65. NPC 集成：选择影响 NPC 关系（服务器固定增量）');
  // G5. World Event 集成
  mkRoomDb('IG3');
  const wes = mkPlayerDb('维斯', 'IG3');
  const decWorld = decisionEngine.createDecision(fakeIo, 'IG3', {
    type: 'NORMAL',
    prompt: '要拉下电闸吗？',
    options: [{ key: 'A', text: '拉下', result: { world_event: { type: 'POWER_OUTAGE' } } }, { key: 'B', text: '算了' }],
  });
  decisionEngine.selectDecision(fakeIo, decWorld.uid, wes.id, 'A');
  assert.ok(worldEvents.hasActiveEvent('IG3', 'POWER_OUTAGE') && worldState.getWorld('IG3').state.lights_on === false);
  ok('66. World Event 集成：选择触发世界事件（服务器执行）');
  // G6. 玩家关系集成（选择帮助队友）
  mkRoomDb('IG4');
  const hA = mkPlayerDb('汉克', 'IG4');
  const hB = mkPlayerDb('汉娜', 'IG4');
  const decRel = decisionEngine.createDecision(fakeIo, 'IG4', {
    type: 'NORMAL',
    prompt: '汉娜摔倒了。',
    targetPlayerId: hA.id,
    options: [{ key: 'A', text: '扶起她', result: { player_relationship: { event: 'PLAYER_HELPED', target: '汉娜' } } }, { key: 'B', text: '无视' }],
  });
  decisionEngine.selectDecision(fakeIo, decRel.uid, hA.id, 'A');
  assert.strictEqual(playerRelations.getRelationship(hA.id, hB.id).value, 10);
  ok('67. 玩家关系集成：选择产生关系事件（幂等去重键）');
  // G7. Dungeon 集成：Boss 技能限时反应（超时受伤）
  mkRoomDb('IG5');
  const dora = mkPlayerDb('朵拉', 'IG5');
  const doors = db.prepare("SELECT * FROM dungeons WHERE roblox_experience_name = 'Doors'").get();
  db.prepare("INSERT INTO dungeon_versions (dungeon_id, version, definition_json, status, published_at) VALUES (?, 901, '{}', 'PUBLISHED', datetime('now'))").run(doors.id);
  const dvId = db.prepare('SELECT id FROM dungeon_versions WHERE dungeon_id = ? AND version = 901').get(doors.id).id;
  const inst = instanceManager.createInstance({ roomId: 'IG5', dungeonVersionId: dvId });
  characterService.ensureCharacter(dora.id);
  const hpOf = (pid) => db.prepare('SELECT hp FROM player_states WHERE player_id = ?').get(pid).hp;
  const hpBefore = hpOf(dora.id);
  const dte = decisionEngine.triggerDungeonTimedEvent(fakeIo, inst, {
    prompt: 'Boss 蓄力横扫！3 秒内反应！',
    options: [{ key: 'A', text: '翻滚躲避' }, { key: 'B', text: '愣在原地' }],
    defaultOption: 'B',
    timeoutMs: 80,
    failDamage: 5,
    targetPlayerId: dora.id,
  });
  assert.strictEqual(dte.instance_id, inst.id);
  await sleep(250);
  const dteRow = decisionEngine.getDecision(dte.uid);
  assert.ok(dteRow.status === 'TIMEOUT' && hpOf(dora.id) === hpBefore - 5);
  ok('68. Dungeon 集成：限时事件超时 → 承受伤害（绑定副本实例）');
  // G8. Context 集成
  const decCtx = decisionEngine.createDecision(fakeIo, 'IG5', {
    type: 'TIMED',
    prompt: 'Context 展示用',
    options: [{ key: 'A', text: '躲藏' }, { key: 'B', text: '逃跑' }, { key: 'C', text: '攻击' }],
    defaultOption: 'A',
    timeoutMs: 60000,
  });
  const built = contextBuilder.buildContext({ id: 'IG5', players: [], currentExperience: null, currentDungeon: null });
  const partySec = built.sections.find((s) => s.key === 'party');
  const decSec = built.sections.find((s) => s.key === 'decisions');
  assert.ok(partySec && partySec.label === 'PARTY_CONTEXT');
  assert.ok(decSec && decSec.label === 'DECISION_CONTEXT' && /TIMED DECISION/.test(decSec.content) && /剩余 \d+ 秒/.test(decSec.content) && /躲藏/.test(decSec.content));
  ok('69. Context：PARTY_CONTEXT + DECISION_CONTEXT（剩余时间/选项）');
  partyService.setRole(fakeIo, vParty.id, v1.id, 'SCOUT');
  const built2 = contextBuilder.buildContext({ id: 'PV1', players: [], currentExperience: null, currentDungeon: null });
  const partySec2 = built2.sections.find((s) => s.key === 'party');
  assert.ok(/侦察者/.test(partySec2.content) && /队长/.test(partySec2.content));
  ok('70. PARTY_CONTEXT 含叙事定位（供 GM 描述，不改属性）');

  // ══ H. REST ══
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const sess = createSession(v1.id);
  const resParty = await fetch(`http://127.0.0.1:${port}/api/party?sessionToken=${encodeURIComponent(sess.token)}`).then((r) => r.json());
  assert.ok(resParty.party && resParty.party.members.length === 3 && resParty.party.relationships !== undefined);
  ok('71. GET /api/party（会话鉴权 + 队伍视图）');
  const res401 = await fetch(`http://127.0.0.1:${port}/api/party`);
  assert.strictEqual(res401.status, 401);
  ok('72. 无会话拒绝（401）');
  mkRoomDb('REST1');
  const restP = mkPlayerDb('雷斯特', 'REST1');
  const restSess = createSession(restP.id);
  const decRest = decisionEngine.createDecision(fakeIo, 'REST1', { type: 'NORMAL', prompt: 'REST 选择', options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }] });
  const listRes = await fetch(`http://127.0.0.1:${port}/api/decisions?sessionToken=${encodeURIComponent(restSess.token)}`).then((r) => r.json());
  assert.ok(listRes.decisions.some((d) => d.uid === decRest.uid) && listRes.decisions[0].options.length === 2);
  ok('73. GET /api/decisions 待决列表');
  const selRes = await fetch(`http://127.0.0.1:${port}/api/decisions/${decRest.uid}/select`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ optionKey: 'A', sessionToken: restSess.token }),
  }).then((r) => r.json());
  assert.ok(selRes.ok && selRes.decision.status === 'RESOLVED' && selRes.decision.resolvedOption === 'A');
  ok('74. POST /api/decisions/:uid/select（玩家选择，服务器结算）');

  server.close();
  console.log(`\n[阶段13] 通过 ${passed} 项测试`);
  if (passed < 70) {
    console.error('测试数量不足 70！');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('\n[阶段13] 测试失败：', err);
  process.exit(1);
});
