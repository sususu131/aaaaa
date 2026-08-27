/**
 * 端到端冒烟测试（无需浏览器）。
 * 阶段1：建房 → 加入 → 聊天 → 进出同步 → 容量上限 → 错误房间码。
 * 阶段2：临时会话身份 → 2000字符限制 → @AI 触发与无Key错误提示 →
 *        AI 频率限制 → Roblox URL解析 → Structured Output 解析 → 缓存兜底。
 * 运行：npm test --prefix server
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// ── 每次运行前重置数据库（保证幂等、可重复执行）──
for (const suffix of ['', '-wal', '-shm', '-journal']) {
  fs.rmSync(path.join(__dirname, '../../database/data/roblox_trpg.db' + suffix), { force: true });
}

const { io: ioc } = require('socket.io-client');
const { server } = require('../src/index.js');
const { parseExperienceUrl } = require('../src/services/roblox/robloxExperiences.js');
const { parseGmResponse } = require('../src/services/ai/structuredOutput.js');
const cache = require('../src/services/roblox/robloxCache.js');
const rateLimiter = require('../src/services/ai/rateLimiter.js');

const PORT = 3199;
const URL = `http://localhost:${PORT}`;
let passed = 0;

function connect(auth) {
  return new Promise((resolve) => {
    const s = ioc(URL, { transports: ['websocket'], auth });
    s.on('connect', () => resolve(s));
  });
}

function once(socket, event, timeout = 4000) {
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
  await new Promise((resolve) => server.close(() => resolve()));
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`[test] 测试服务器运行于 ${URL}\n`);

  // ── 阶段1 回归 ─────────────────────────────────────────
  const a = await connect();
  const created = await new Promise((resolve) => a.emit('room:create', { playerName: '爱丽丝' }, resolve));
  assert.strictEqual(created.ok, true);
  assert.match(created.room.id, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.match(created.playerId, /^player_[0-9a-f]{8}$/, '应返回服务器生成的 playerId');
  assert.ok(created.sessionToken && created.sessionToken.length >= 64, '应返回高熵 sessionToken');
  ok(`阶段1：创建房间 ${created.room.id}；阶段2：获得临时身份 ${created.playerId}`);

  const b = await connect();
  const bJoined = once(b, 'room:joined');
  const joined = await new Promise((resolve) =>
    b.emit('room:join', { playerName: '鲍勃', roomId: created.room.id }, resolve)
  );
  assert.strictEqual(joined.ok, true);
  await bJoined;
  ok('玩家B加入成功');

  const c = await connect();
  const cAck = await new Promise((resolve) =>
    c.emit('room:join', { playerName: '卡罗尔', roomId: created.room.id }, resolve)
  );
  assert.strictEqual(cAck.ok, true);
  ok('玩家C加入，房间 3/3');

  const d = await connect();
  const dErr = await new Promise((resolve) => {
    d.once('error', resolve);
    d.emit('room:join', { playerName: '大卫', roomId: created.room.id });
  });
  assert.match(dErr.message, /已满/);
  ok('第4名玩家被拒绝：房间已满');

  const e = await connect();
  const eErr = await new Promise((resolve) => {
    e.once('error', resolve);
    e.emit('room:join', { playerName: '伊芙', roomId: 'ZZZZZZ' });
  });
  assert.match(eErr.message, /不存在/);
  ok('错误房间码被拒绝');

  const waitB = once(b, 'chat:message');
  const waitC = once(c, 'chat:message');
  const waitA = once(a, 'chat:message');
  a.emit('chat:send', { text: '灾变开始了，大家小心！' });
  const [msgA, msgB, msgC] = await Promise.all([waitA, waitB, waitC]);
  for (const m of [msgA, msgB, msgC]) {
    assert.strictEqual(m.playerName, '爱丽丝');
    assert.strictEqual(m.text, '灾变开始了，大家小心！');
  }
  ok('聊天实时广播：A发言，A/B/C均收到');

  const waitLeft = once(b, 'player:left');
  const waitSys = once(b, 'chat:message');
  c.emit('room:leave');
  const [left, sys] = await Promise.all([waitLeft, waitSys]);
  assert.strictEqual(left.playerName, '卡罗尔');
  assert.strictEqual(sys.type, 'system');
  ok('玩家C离开：列表更新 + 系统消息');

  // ── 阶段2：会话身份（刷新/重连保持 playerId）────────────
  const tokenA = created.sessionToken;
  const uidA = created.playerId;
  a.disconnect();
  const a2 = await connect({ sessionToken: tokenA });
  const rejoinAck = await new Promise((resolve) => {
    a2.once('error', (err) => resolve({ error: err.message }));
    a2.emit('room:join', { playerName: '爱丽丝', roomId: created.room.id }, resolve);
  });
  assert.strictEqual(rejoinAck.ok, true, `携带token重连应成功: ${rejoinAck.error || ''}`);
  assert.strictEqual(rejoinAck.playerId, uidA, '重连后 playerId 必须保持不变');
  assert.ok(!rejoinAck.sessionToken, '复用会话不应重复发放新 token');
  ok(`会话身份：断开重连后 playerId 保持 ${uidA}`);

  // ── 阶段2：消息长度限制（2000字符）────────────────────
  const lenErr = await new Promise((resolve) => {
    a2.once('error', resolve);
    a2.emit('chat:send', { text: '长'.repeat(2001) });
  });
  assert.match(lenErr.message, /2000/);
  ok('超过2000字符的消息被拒绝（防刷）');

  // ── 阶段2：@AI 触发；未配置 Key 时按真实原因提示 ───────
  // 注意：服务端可能在同一 tick 内连发多条消息，必须用收集器而非 once 链
  const bSystemMsgs = [];
  b.on('chat:message', (m) => m.type === 'system' && bSystemMsgs.push(m.text));
  b.emit('chat:send', { text: '@AI 我调查这栋建筑。' });
  await new Promise((r) => setTimeout(r, 800));
  assert.ok(
    bSystemMsgs.some((t) => t.includes('GM 无法回应') && t.includes('AI服务未配置')),
    `未配置Key时应明确提示原因，实际收到: ${JSON.stringify(bSystemMsgs)}`
  );
  ok('@AI 触发 GM；未配置 API Key 时提示真实原因（非静默失败）');

  // ── 阶段2：普通 @玩家 消息不触发 AI ───────────────────
  let unexpectedGm = false;
  b.on('gm:response', () => (unexpectedGm = true));
  b.emit('chat:send', { text: '@爱丽丝 你去看看那扇门。' });
  await new Promise((r) => setTimeout(r, 400));
  assert.strictEqual(unexpectedGm, false);
  ok('@玩家 消息不触发 AI GM');

  // ── 阶段2：单玩家 AI 频率限制（6次/分钟）─────────────
  const rateLimitMsgs = [];
  b.on('chat:message', (m) => m.type === 'system' && rateLimitMsgs.push(m.text));
  for (let i = 0; i < 8; i += 1) {
    b.emit('chat:send', { text: `@AI 测试限流 ${i}` });
    await new Promise((r) => setTimeout(r, 60));
  }
  await new Promise((r) => setTimeout(r, 800));
  assert.ok(
    rateLimitMsgs.some((t) => t.includes('过于频繁')),
    '连续@AI应触发玩家级限流提示'
  );
  ok('AI 频率限制：连续 @AI 后提示"请求过于频繁"');

  // ── 单元测试：Roblox URL 解析（Step 3）────────────────
  assert.deepStrictEqual(parseExperienceUrl('https://www.roblox.com/games/6516141723/DOORS'), {
    placeId: '6516141723',
  });
  assert.deepStrictEqual(parseExperienceUrl('https://www.roblox.com/game/2753915549'), {
    placeId: '2753915549',
  });
  assert.deepStrictEqual(parseExperienceUrl('https://www.roblox.com/games/?placeId=123456'), {
    placeId: '123456',
  });
  assert.strictEqual(parseExperienceUrl('随便一段文字'), null);
  ok('Roblox Experience URL 解析（3种格式 + 非法输入）');

  // ── 单元测试：Structured Output 解析（Step 10）────────
  const parsed = parseGmResponse(
    '```json\n' +
      JSON.stringify({
        type: 'gm_response',
        narrative: '你来到一扇黑色的门前。门后传来奇怪的声音。',
        options: [
          { label: '打开门', action: '打开门' },
          { label: '仔细倾听', action: '贴近门仔细听' },
          { label: '离开', action: '离开这里' },
        ],
        memory_update: [{ kind: 'npc', content: '旅馆里有一个叫 Figure 的盲眼怪物' }],
        rule_requests: [{ type: 'reward_request', payload: { reward_id: 'x' } }],
        source_references: ['roblox_api: DOORS 官方描述'],
      }) +
      '\n```'
  );
  assert.strictEqual(parsed.narrative.includes('黑色的门'), true);
  assert.strictEqual(parsed.options.length, 3);
  assert.strictEqual(parsed.memory_update[0].kind, 'npc');
  assert.strictEqual(parsed.rule_requests[0].type, 'reward_request');
  assert.strictEqual(parseGmResponse('这不是JSON'), null, '非JSON应解析失败而非崩溃');
  ok('Structured Output：标准回复解析 + 非JSON容错');

  // ── 单元测试：缓存过期兜底（Step 5）──────────────────
  cache.clear();
  cache.put('test:key', { v: 1 }, 1); // 1ms TTL → 立即过期
  await new Promise((r) => setTimeout(r, 10));
  const staleResult = await cache.getOrFetch('test:key', 60000, () => {
    throw new Error('模拟 Roblox API 故障');
  });
  assert.strictEqual(staleResult.stale, true);
  assert.deepStrictEqual(staleResult.value, { v: 1 });
  await assert.rejects(
    cache.getOrFetch('test:none', 60000, () => {
      throw new Error('模拟故障且无缓存');
    }),
    '无缓存且失败时必须抛错（上层转 ROBLOX_DATA_UNAVAILABLE）'
  );
  ok('缓存：过期兜底旧值 + 无缓存时抛错');

  // ── 单元测试：限流器 ─────────────────────────────────
  rateLimiter.reset();
  for (let i = 0; i < 6; i += 1) assert.ok(rateLimiter.tryConsumeAiRequest('p1', 'r1').ok);
  assert.strictEqual(rateLimiter.tryConsumeAiRequest('p1', 'r1').ok, false);
  rateLimiter.reset();
  ok('限流器：单玩家窗口额度生效');

  console.log(`\n[test] 全部通过：${passed}/16 项断言组 ✅`);

  for (const s of [a2, b, d, e]) s.disconnect();
  server.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('\n[test] 测试失败 ❌\n', err);
  process.exit(1);
});
