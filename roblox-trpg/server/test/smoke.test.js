/**
 * 步骤9：端到端冒烟测试（无需浏览器）。
 * 覆盖：建房 → 拿房间ID → 2人加入 → 实时聊天 → 进出同步 → 容量上限 → 错误房间码。
 * 运行：npm test --prefix server（服务器由测试自行拉起）
 */
const assert = require('assert');
const { io: ioc } = require('socket.io-client');
const { server } = require('../src/index.js');

const PORT = 3199;
const URL = `http://localhost:${PORT}`;
let passed = 0;

function connect() {
  return new Promise((resolve) => {
    const s = ioc(URL, { transports: ['websocket'] });
    s.on('connect', () => resolve(s));
  });
}

/** 等待某事件一次，带超时。 */
function once(socket, event, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待事件超时: ${event}`)), timeout);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

function ok(label) {
  passed += 1;
  console.log(`  ✓ ${label}`);
}

async function main() {
  await new Promise((resolve) => {
    server.close(() => resolve()); // 关闭默认监听，换用测试端口
  });
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`[test] 测试服务器运行于 ${URL}\n`);

  // 1. 玩家A 创建房间（F2/F3/F4）
  const a = await connect();
  const created = await new Promise((resolve) => {
    a.emit('room:create', { playerName: '爱丽丝' }, resolve);
  });
  assert.strictEqual(created.ok, true, '创建房间应成功');
  assert.match(created.room.id, /^[A-HJ-NP-Z2-9]{6}$/, '房间ID应为6位可读字符');
  ok(`玩家A创建房间，房间ID = ${created.room.id}`);

  // 2. 玩家B 加入房间（F5）
  const b = await connect();
  const bJoined = once(b, 'room:joined');
  const joined = await new Promise((resolve) => {
    b.emit('room:join', { playerName: '鲍勃', roomId: created.room.id }, resolve);
  });
  assert.strictEqual(joined.ok, true, 'B加入应成功');
  await bJoined;
  ok('玩家B凭房间ID加入成功');

  // 3. 玩家C 加入 → 满3人（F6）
  const c = await connect();
  const cJoined = once(c, 'room:joined');
  const cAck = await new Promise((resolve) => {
    c.emit('room:join', { playerName: '卡罗尔', roomId: created.room.id }, resolve);
  });
  assert.strictEqual(cAck.ok, true, 'C加入应成功');
  const cPayload = await cJoined;
  assert.strictEqual(cPayload.players.length, 3, '房间应有3名玩家');
  ok('玩家C加入，房间3/3人，玩家列表同步正确');

  // 4. 第4人加入应被拒绝（容量上限）
  const d = await connect();
  const dErrors = once(d, 'error');
  d.emit('room:join', { playerName: '大卫', roomId: created.room.id });
  const dErr = await dErrors;
  assert.match(dErr.message, /已满/, '满员应报错');
  ok('第4名玩家被拒绝：房间已满');

  // 5. 错误房间码应被拒绝
  const e = await connect();
  const eErrors = once(e, 'error');
  e.emit('room:join', { playerName: '伊芙', roomId: 'ZZZZZZ' });
  const eErr = await eErrors;
  assert.match(eErr.message, /不存在/, '错误房间码应报错');
  ok('错误房间码被拒绝：房间不存在');

  // 6. 聊天实时广播（F7/F8）：A发言，B、C都要收到
  const waitB = once(b, 'chat:message');
  const waitC = once(c, 'chat:message');
  const waitA = once(a, 'chat:message');
  a.emit('chat:send', { text: '灾变开始了，大家小心！' });
  const [msgA, msgB, msgC] = await Promise.all([waitA, waitB, waitC]);
  for (const m of [msgA, msgB, msgC]) {
    assert.strictEqual(m.playerName, '爱丽丝');
    assert.strictEqual(m.text, '灾变开始了，大家小心！');
    assert.strictEqual(m.type, 'chat');
  }
  ok('玩家A发言，A/B/C 三人均实时收到（含发送者自己）');

  // 7. 离开同步（F9）：C离开，B应收到 player:left + 系统消息
  const waitLeft = once(b, 'player:left');
  const waitSys = once(b, 'chat:message');
  c.emit('room:leave');
  const [left, sys] = await Promise.all([waitLeft, waitSys]);
  assert.strictEqual(left.playerName, '卡罗尔');
  assert.strictEqual(left.players.length, 2);
  assert.strictEqual(sys.type, 'system');
  assert.match(sys.text, /卡罗尔 离开了房间/);
  ok('玩家C离开：玩家列表更新 + 系统消息广播');

  // 8. 断线同步（F9）：B直接断开
  const waitLeft2 = once(a, 'player:left');
  b.disconnect();
  const left2 = await waitLeft2;
  assert.strictEqual(left2.playerName, '鲍勃');
  assert.strictEqual(left2.players.length, 1);
  ok('玩家B断线：其余玩家实时收到离开通知');

  console.log(`\n[test] 全部通过：${passed}/8 项断言组 ✅`);

  a.disconnect();
  d.disconnect();
  e.disconnect();
  server.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('\n[test] 测试失败 ❌\n', err);
  process.exit(1);
});
